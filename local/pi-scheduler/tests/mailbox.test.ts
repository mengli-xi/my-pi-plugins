import assert from "node:assert/strict";
import { existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MailboxCallbackFence, ProducerEndpoint } from "pi-session-inject/mailbox-v1";
import { fulfilledFinalAckLostFixture } from "./fixtures/fulfilled-final-ack-lost.ts";
import { SchedulerDaemon } from "../src/daemon.ts";
import { injectionMail, nativeInjectionProof, schedulerProducer } from "../src/mailbox-adapter.ts";
import { importSchedulerBranch } from "../src/mailbox-import.ts";
import { forgetSchedulerIntent, putSchedulerIntent, type SchedulerDeliveryIntent } from "../src/mailbox-delivery.ts";
import { normalizeSchedulerRollback, schedulerRollbackInventory } from "../src/mailbox-rollback.ts";
import { OccupancyRegistry } from "../src/occupancy.ts";
import type { MailboxInjectionOffer, SchedulerRequest } from "../src/protocol.ts";
import { SchedulerStore, type InjectionMarker } from "../src/store.ts";

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-mailbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fulfilledFinalAckLostFixture(join(dir, "session.jsonl"), dir);
  const store = new SchedulerStore(join(dir, "scheduler"));
  let now = f.scheduledTime;
  let executions = 0;
  const occupancy = new OccupancyRegistry(() => true);
  occupancy.register(f.snapshot.session.id, 1234, "holder", 1);
  const makeDaemon = () => new SchedulerDaemon({ store, occupancy, now: () => now,
    piBinary: "/unused", concurrency: 1, runner: async () => { executions++; return { outcome: "success" }; } });
  let daemon = makeDaemon();
  const marker: InjectionMarker = { injectionId: f.injectionId, taskId: f.taskId, title: "Shared ACK recovery fixture",
    prompt: f.prompt, scheduledTime: f.scheduledTime, sessionId: f.snapshot.session.id, staleAt: now + 100,
    createdAt: now, phase: f.sourceMarkerPhase, mailbox: { anchorEntryId: f.mail.anchorEntryId,
      recordedToken: "recorded-injection-fixture", entryId: "native-injection-fixture" } };
  const fence: MailboxCallbackFence = { slotKey: JSON.stringify([dir, marker.sessionId]), session: f.snapshot.session,
    bindingGeneration: 1, ownerEpoch: 1, producerToken: Symbol(), attemptId: null };
  const source = schedulerProducer(async (request) => {
    if (request.type.startsWith("injection.") && !["injection.poll", "injection.ack", "injection.nack"].includes(request.type)) {
      return daemon.mailbox.apply(request as Parameters<typeof daemon.mailbox.apply>[0]);
    }
    throw new Error("unexpected source request");
  });
  const offers = () => daemon.mailbox.apply({ type: "injection.offers", sessionId: marker.sessionId, pid: 1234,
    holderToken: "holder", bindingGen: 1, anchorEntryId: "later-leaf", nativeProofs: [] });
  return { dir, f, store, marker, fence, source, offers, occupancy, get daemon() { return daemon; },
    restart: () => { daemon = makeDaemon(); daemon.reconcileCrashed(); return daemon; },
    setNow: (n: number) => { now = n; }, executions: () => executions };
}

function putLegacySourceTask(s: ReturnType<typeof setup>) {
  s.store.putTask({ id: s.f.taskId, title: s.marker.title, prompt: s.f.prompt,
    schedule: { kind: "once", at: s.f.scheduledTime }, timeZone: "UTC", toleranceMs: 60000,
    status: "paused", createdAt: s.f.scheduledTime - 1, origin: "user",
    target: { kind: "session", sessionId: s.marker.sessionId, cwd: s.dir } });
}

test("shared A/E fixture: pending deleted, source ACK lost, same terminal replays without another run", async (t) => {
  const s = setup(t);
  s.store.putInjection(s.marker);
  assert.deepEqual(s.f.snapshot.pending, []);
  assert.equal(s.f.snapshot.terminal[0]!.terminalAck, "pending");
  // Actual E callback + actual daemon/store. A will bind this same fixture to
  // its production recovery runner after A1; this test covers the E half only.
  await s.source.onTerminal!(s.f.evidence, s.fence);
  s.restart().tick();
  await s.source.onTerminal!(s.f.evidence, { ...s.fence, ownerEpoch: 2 });
  assert.equal(s.executions(), s.f.expected.newProviderRequests);
  assert.equal(s.store.listRuns(s.f.taskId).length, s.f.expected.terminalTransitions);
  assert.equal(s.store.getInjectionReceipt(s.f.injectionId)?.evidence.terminalId, s.f.evidence.terminalId);
  assert.equal(s.store.getInjection(s.f.injectionId), undefined);
  await s.source.onRecorded!(s.f.snapshot.terminal[0]!.recorded!.notice, s.fence);
  await assert.rejects(async () => s.source.onTerminal!({ ...s.f.evidence, terminalId: "different" }, s.fence), /terminal-conflict/);
});

test("terminal ACK waits for the durable daemon transaction and lost replies remain idempotent", async (t) => {
  const s = setup(t);
  s.store.putInjection(s.marker);
  let lost = true;
  const source = schedulerProducer(async (request) => {
    const reply = s.daemon.mailbox.apply(request as Parameters<typeof s.daemon.mailbox.apply>[0]);
    if (lost) { lost = false; throw new Error("IPC reply lost after source commit"); }
    return reply;
  });
  await assert.rejects(async () => source.onTerminal!(s.f.evidence, s.fence), /reply lost/);
  s.restart();
  await source.onTerminal!(s.f.evidence, s.fence);
  assert.equal(s.store.listRuns(s.f.taskId).length, 1);
  // Retention of the human-facing history cannot destroy protocol dedup.
  const runs = join(s.store.root, "runs", `${s.f.taskId}.jsonl`);
  writeFileSync(runs, "");
  await source.onTerminal!(s.f.evidence, s.fence);
  assert.equal(s.store.listRuns(s.f.taskId).length, 0);
});

for (const fault of ["before-run-write", "after-run-write"] as const) {
  test(`daemon crash ${fault} repairs exactly one final record`, async (t) => {
    const s = setup(t);
    s.store.putInjection(s.marker);
    const append = s.store.appendRun.bind(s.store);
    s.store.appendRun = (record, now) => {
      if (fault === "after-run-write") append(record, now);
      throw new Error("daemon crashed");
    };
    await assert.rejects(async () => s.source.onTerminal!(s.f.evidence, s.fence), /crashed/);
    s.store.appendRun = append;
    s.restart();
    await s.source.onTerminal!(s.f.evidence, s.fence);
    assert.equal(s.store.listRuns(s.f.taskId).length, 1);
    assert.equal(s.executions(), 0);
  });
}

test("prepared/owned injections survive daemon restart and never re-enter offline/legacy append", async (t) => {
  const s = setup(t);
  const { mailbox: _, ...legacy } = s.marker;
  s.store.putInjection({ ...legacy, phase: "pending" });
  const response = s.offers();
  assert.ok(response.ok && response.type === "injection-offers");
  assert.equal(response.offers[0]!.recovered, true, "old source without a creation holder is recovery");
  const mail = injectionMail(response.offers[0]!);
  assert.equal(mail.anchorEntryId, "later-leaf");
  s.restart().tick();
  assert.equal(s.executions(), 0);
  const next = s.offers();
  assert.ok(next.ok && next.type === "injection-offers");
  assert.deepEqual(injectionMail(next.offers[0]!), mail);
  assert.equal(s.daemon.ackInjection({ injectionId: s.f.injectionId, entryId: "native" }).ok, false);
  const notice = { ...s.f.snapshot.terminal[0]!.recorded!.notice, scope: { ...s.f.evidence.scope, anchorEntryId: "later-leaf" } };
  await s.source.onRecorded!(notice, s.fence);
  assert.equal(s.store.getInjection(s.f.injectionId)?.phase, "mailbox-owned");
  assert.equal(s.store.listRuns(s.f.taskId).length, 0, "handoff is not delivered");
});

test("only a new occurrence's exact creation holder receives a live offer across daemon restart", (t) => {
  const s = setup(t);
  s.store.putTask({ id: s.f.taskId, title: s.marker.title, prompt: s.f.prompt,
    schedule: { kind: "once", at: s.f.scheduledTime }, timeZone: "UTC", toleranceMs: 60000,
    status: "active", createdAt: s.f.scheduledTime - 1, origin: "user",
    target: { kind: "session", sessionId: s.marker.sessionId, cwd: s.dir } });
  s.daemon.tick();
  const original = s.store.getInjection(s.f.injectionId)!;
  assert.deepEqual(original.createdForHolder, { pid: 1234, holderToken: "holder", bindingGen: 1 });
  const first = s.offers(); assert.ok(first.ok && first.type === "injection-offers");
  assert.equal(first.offers[0]!.recovered, false);
  s.restart();
  const afterRestart = s.offers(); assert.ok(afterRestart.ok && afterRestart.type === "injection-offers");
  assert.equal(afterRestart.offers[0]!.recovered, false, "daemon restart does not fabricate another Pi holder");
  s.occupancy.register(s.marker.sessionId, 1234, "replacement-holder", 2);
  const recovered = s.daemon.mailbox.apply({ type: "injection.offers", sessionId: s.marker.sessionId, pid: 1234,
    holderToken: "replacement-holder", bindingGen: 2, anchorEntryId: "later-leaf", nativeProofs: [] });
  assert.ok(recovered.ok && recovered.type === "injection-offers");
  assert.equal(recovered.offers[0]!.recovered, true);
  assert.deepEqual(s.store.getInjection(s.f.injectionId)!.createdForHolder, original.createdForHolder);
});

test("source recovery classification survives retries and a confirmed tree generation change", async (t) => {
  const s = setup(t);
  const calls: unknown[][] = [];
  const endpoint = { put: async (...args: unknown[]) => { calls.push(args); return { kind: "accepted", key: s.f.mail.key, revision: 1 }; } } as unknown as ProducerEndpoint;
  const intents = new Map();
  const send = (recovered: boolean, generation: number) => putSchedulerIntent({ endpoint, mail: s.f.mail, recovered, intents,
    target: { ...s.fence, bindingGeneration: generation }, branch: [], leafId: s.f.mail.anchorEntryId });
  await send(true, 1);
  await send(false, 1);
  await send(false, 2);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => JSON.stringify(call[2]) === JSON.stringify({ recovered: true })));
  intents.clear(); calls.length = 0;
  await send(false, 2);
  assert.equal(calls[0]!.length, 2, "new live work uses the ordinary two-argument put");
});

test("completed occurrences release cached prompts after durable ACK while unaccepted stale intent survives", async (t) => {
  const s = setup(t), intents = new Map<string, SchedulerDeliveryIntent>();
  const staleEndpoint = { put: async () => { throw new Error("stale-binding"); } } as unknown as ProducerEndpoint;
  await assert.rejects(putSchedulerIntent({ endpoint: staleEndpoint, target: s.fence, mail: s.f.mail,
    recovered: true, intents, branch: [], leafId: s.f.mail.anchorEntryId }), /stale-binding/);
  assert.equal((await putSchedulerIntent({ endpoint: staleEndpoint, target: { ...s.fence, bindingGeneration: 2 },
    mail: s.f.mail, recovered: true, intents, branch: [], leafId: "sibling" })).kind, "held");
  let loseReply = true;
  const source = schedulerProducer(async (request) => {
    const response = s.daemon.mailbox.apply(request as Parameters<typeof s.daemon.mailbox.apply>[0]);
    if (loseReply) { loseReply = false; throw new Error("lost terminal reply after source commit"); }
    return response;
  }, undefined, undefined, evidence => forgetSchedulerIntent(intents, evidence));
  const completed: typeof s.f.evidence[] = [];
  const endpoint = { put: async () => ({ kind: "accepted", revision: 1 }) } as unknown as ProducerEndpoint;
  for (let i = 1; i <= 128; i++) {
    const scheduledTime = s.f.scheduledTime + i;
    s.setNow(scheduledTime);
    const marker = { ...s.marker, scheduledTime, injectionId: `${s.f.taskId}:${scheduledTime}`,
      mailbox: { ...s.marker.mailbox!, entryId: `native-${i}`, recordedToken: `recorded-${i}` } };
    s.store.putInjection(marker);
    const mail = injectionMail({ ...marker, anchorEntryId: marker.mailbox.anchorEntryId, contentDigest: s.f.contentDigest });
    await putSchedulerIntent({ endpoint, target: s.fence, mail, recovered: false, intents, branch: [], leafId: mail.anchorEntryId });
    const evidence = { ...s.f.evidence, key: mail.key, terminalId: `terminal-${i}`, nativeEntryIds: [marker.mailbox.entryId],
      receiptEntryId: `delivery-${i}`, assistantEntryId: `assistant-${i}` };
    assert.equal(intents.size, 2);
    if (i === 1) {
      await assert.rejects(async () => source.onTerminal!(evidence, s.fence), /lost terminal reply/);
      assert.ok(intents.has(mail.key), "source commit alone cannot discard a lost ACK's intent");
    }
    await source.onTerminal!(evidence, s.fence);
    assert.equal(intents.size, 1);
    completed.push(evidence);
  }
  assert.equal(s.store.listRuns(s.f.taskId).length, 50);
  await source.onTerminal!(completed[0]!, s.fence);
  assert.equal(s.store.listRuns(s.f.taskId).length, 50, "same terminal replay does not recreate pruned history");
  assert.equal(intents.size, 1);
  assert.equal(intents.get(s.f.mail.key)!.target.bindingGeneration, 1, "stale intent keeps its original target");
});

test("stale-before-start cancels; an already started request may finish after staleAt", async (t) => {
  const s = setup(t);
  s.store.putInjection(s.marker);
  s.setNow(s.marker.staleAt + 1);
  assert.deepEqual(await s.source.checkCurrent(s.f.mail, "before-seal", s.fence), { kind: "cancel", reason: "injection-stale" });
  s.setNow(s.marker.staleAt);
  const started = s.daemon.mailbox.apply({ type: "injection.start", injectionId: s.f.injectionId, sessionId: s.marker.sessionId });
  assert.equal(started.ok, true);
  s.setNow(s.marker.staleAt + 100);
  s.restart().tick();
  assert.deepEqual(await s.source.checkCurrent(s.f.mail, "before-native-send", s.fence), { kind: "allow", project: true, wake: true });
  await s.source.onTerminal!(s.f.evidence, s.fence);
  assert.equal(s.store.listRuns(s.f.taskId)[0]!.outcome, "delivered");
});

test("cancellation commits a failure with the original injection identity, never false delivered", async (t) => {
  const s = setup(t);
  s.store.putInjection(s.marker);
  const cancelled = { producer: "pi-scheduler" as const, key: s.f.mail.key, terminalId: "cancel-fixture",
    scope: s.f.evidence.scope, outcome: "cancelled" as const, reason: "injection-stale" };
  await s.source.onTerminal!(cancelled, s.fence);
  s.restart();
  await s.source.onTerminal!(cancelled, s.fence);
  assert.equal(s.store.listRuns(s.f.taskId).length, 1);
  assert.equal(s.store.listRuns(s.f.taskId)[0]!.detail, "mailbox-cancelled:injection-stale");
});

test("native carrier proof preserves old identity/details and rejects content/duplicates", (t) => {
  const s = setup(t);
  const branch = s.f.sessionEntries.filter((e) => e.type !== "session");
  assert.deepEqual(nativeInjectionProof(s.f.mail, branch), { kind: "observed", entries: [{ messageIndex: 0, entryId: "native-injection-fixture" }] });
  const native = branch.find((e) => e.type === "custom_message")!;
  assert.equal(nativeInjectionProof(s.f.mail, [...branch, native]).kind, "conflict");
  assert.equal(nativeInjectionProof({ ...s.f.mail, messages: [{ ...s.f.mail.messages[0]!, content: "changed" }] }, branch).kind, "conflict");
});

test("legacy completed carrier uses importFulfilled; missing frozen intent stays visible-unknown", async (t) => {
  const s = setup(t);
  let imports = 0;
  const endpoint = { importFulfilled: async (mail, proof, target) => {
    imports++;
    assert.deepEqual(mail, s.f.mail);
    assert.deepEqual(proof, { sourceReceiptEntryId: "native-injection-fixture", assistantEntryId: "assistant-fixture" });
    assert.equal(target, s.fence);
    return s.f.evidence;
  } } as ProducerEndpoint;
  const diagnostics: string[] = [];
  const run = { taskId: s.f.taskId, scheduledTime: s.f.scheduledTime, finishedAt: s.f.scheduledTime,
    outcome: "delivered" as const, target: "session" as const, injectionId: s.f.injectionId };
  putLegacySourceTask(s);
  s.store.appendRun(run, s.f.scheduledTime);
  const send = async (r: SchedulerRequest) => r.type === "task.runs"
    ? { ok: true as const, type: "runs" as const, runs: s.store.listRuns(r.id) }
    : s.daemon.mailbox.apply(r as Parameters<typeof s.daemon.mailbox.apply>[0]);
  const branch = s.f.sessionEntries.filter((e) => e.type !== "session");
  await importSchedulerBranch({ branch, offers: [], endpoint, target: s.fence, send, diagnostic: (m) => diagnostics.push(m) });
  assert.equal(imports, 1);
  await importSchedulerBranch({ branch: branch.slice(0, 2), offers: [], endpoint, target: s.fence, send, diagnostic: (m) => diagnostics.push(m) });
  assert.equal(imports, 1);
  assert.match(diagnostics[0]!, /unknown/);
});

test("rollback refuses unmatched unfinished items, archives bytes, produces old-schema terminal failure", (t) => {
  const s = setup(t);
  const holder = { pid: 1234, holderToken: "holder", bindingGen: 1 };
  s.store.putInjection({ ...s.marker, createdForHolder: holder });
  assert.equal(schedulerRollbackInventory(s.store.root)[0]!.phase, "mailbox-owned");
  const archiveDir = join(s.dir, "archive");
  assert.throws(() => normalizeSchedulerRollback({ root: s.store.root, archiveDir, abandonIds: [] }), /rollback refused/);
  const audit = normalizeSchedulerRollback({ root: s.store.root, archiveDir, abandonIds: [s.f.injectionId] });
  assert.equal(audit[0]!.disposition, "user-abandoned delivery");
  assert.equal(new SchedulerStore(archiveDir).getInjection(s.f.injectionId)?.prompt, s.f.prompt);
  assert.deepEqual(new SchedulerStore(archiveDir).getInjection(s.f.injectionId)?.createdForHolder, holder);
  assert.equal(s.store.listInjections().length, 0);
  assert.equal(s.store.listRuns(s.f.taskId)[0]!.outcome, "failure");
  assert.match(readFileSync(join(archiveDir, "mailbox-rollback-audit.json"), "utf8"), /user-abandoned/);
});

test("writer and reader both reject malformed mailbox-owned state", (t) => {
  const s = setup(t);
  assert.throws(() => s.store.putInjection({ ...s.marker, mailbox: undefined }), /invalid/);
  assert.throws(() => s.store.putInjection({ ...s.marker, createdForHolder: { pid: -1, holderToken: "holder", bindingGen: 1 } }), /invalid/);
  s.store.putInjection(s.marker);
  const filename = s.f.injectionId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json";
  writeFileSync(join(s.store.root, "injection", filename), JSON.stringify({ ...s.marker, mailbox: undefined }));
  assert.throws(() => s.store.listInjections(), /invalid/);
});

test("normalized stores open with the original pure-old Scheduler reader", async (t) => {
  const { pathToFileURL } = await import("node:url");
  const s = setup(t);
  s.store.putInjection(s.marker);
  normalizeSchedulerRollback({ root: s.store.root, archiveDir: join(s.dir, "archive"), abandonIds: [s.f.injectionId] });
  // Exact pre-mailbox reader from 2dd4189; keep the test independent of repository history.
  const oldSource = readFileSync(new URL("./fixtures/pure-old-store.ts.txt", import.meta.url), "utf8");
  const oldFile = join(s.dir, "pure-old-store.ts");
  writeFileSync(oldFile, oldSource.replace('"./task.ts"', JSON.stringify(new URL("../src/task.ts", import.meta.url).href)));
  const { SchedulerStore: OldStore } = await import(pathToFileURL(oldFile).href);
  const oldStore = new OldStore(s.store.root);
  assert.deepEqual(oldStore.listInjections(), []);
  assert.equal(oldStore.listRuns(s.f.taskId)[0].detail, "user-abandoned delivery");
});

test("rollback projects a committed fulfilled receipt across the daemon cleanup crash window", async (t) => {
  const s = setup(t);
  s.store.putInjection(s.marker);
  s.store.putInjectionReceipt({ version: 1, marker: s.marker, evidence: s.f.evidence, finishedAt: s.f.scheduledTime });
  assert.equal(schedulerRollbackInventory(s.store.root).length, 0);
  const audit = normalizeSchedulerRollback({ root: s.store.root, archiveDir: join(s.dir, "archive"), abandonIds: [] });
  assert.equal(audit[0]!.disposition, "mailbox-fulfilled");
  assert.equal(s.store.listRuns(s.f.taskId)[0]!.outcome, "delivered");
  assert.equal(s.store.listInjections().length, 0);
});

for (const outcome of ["aborted", "error"] as const) {
  test(`actual ${outcome} run durably cancels the same key, with no automatic retry`, async (t) => {
    const s = setup(t);
    s.store.putInjection({ ...s.marker, mailbox: { ...s.marker.mailbox!, startedAt: s.f.scheduledTime } });
    const cancelled: string[] = [];
    const source = schedulerProducer(async (r) => s.daemon.mailbox.apply(r as Parameters<typeof s.daemon.mailbox.apply>[0]),
      async (key, reason) => { cancelled.push(key); assert.equal(reason, `run-${outcome}`); });
    const end = { outcome, fence: s.fence, members: [{ mail: s.f.mail, entries: [] }] } as unknown as Parameters<NonNullable<typeof source.afterRun>>[0];
    await source.afterRun!(end);
    assert.deepEqual(cancelled, [s.f.mail.key]);
    s.restart();
    assert.deepEqual(await source.checkCurrent(s.f.mail, "before-seal", s.fence), { kind: "cancel", reason: `run-${outcome}` });
    await source.afterRun!({ ...end, members: [] });
    assert.equal(cancelled.length, 1, "unobserved/unknown work must not be failed");
  });
}

test("actual afterRun member proves start even when late ingress missed the producer's beforeRun", async (t) => {
  const s = setup(t);
  s.store.putInjection(s.marker);
  const source = schedulerProducer(async (r) => s.daemon.mailbox.apply(r as Parameters<typeof s.daemon.mailbox.apply>[0]), async () => {});
  const end = { outcome: "error", fence: s.fence, members: [{ mail: s.f.mail, entries: [{ messageIndex: 0, entryId: "native-injection-fixture" }] }] } as unknown as Parameters<NonNullable<typeof source.afterRun>>[0];
  await source.afterRun!(end);
  assert.equal(s.store.getInjection(s.f.injectionId)?.mailbox?.failureReason, "run-error");
});

for (const phase of ["append-uncertain", "leased", "settled"] as const) {
  test(`legacy ${phase} survives expiry until original native success can be imported`, async (t) => {
    const s = setup(t);
    const { mailbox: _, ...original } = s.marker;
    s.store.putInjection({ ...original, phase, ...(phase === "settled" ? { terminalOutcome: "delivered" } : {}) });
    s.setNow(s.marker.staleAt + 1000);
    s.restart().tick();
    assert.equal(s.store.getInjection(s.f.injectionId)?.prompt, s.f.prompt);
    assert.equal(s.store.listRuns(s.f.taskId).length, 0);
    const response = s.daemon.mailbox.apply({ type: "injection.offers", sessionId: s.marker.sessionId,
      pid: 1234, holderToken: "holder", bindingGen: 1, anchorEntryId: "later-leaf",
      nativeProofs: [{ injectionId: s.f.injectionId, anchorEntryId: s.f.mail.anchorEntryId, entryId: "native-injection-fixture", message: s.f.mail.messages[0]! }] });
    assert.ok(response.ok && response.type === "injection-offers");
    assert.equal(response.offers[0]!.legacy, true);
    assert.deepEqual(injectionMail(response.offers[0]!), s.f.mail);
    await s.source.onRecorded!(s.f.snapshot.terminal[0]!.recorded!.notice, s.fence);
    await s.source.onTerminal!(s.f.evidence, s.fence);
    assert.equal(s.store.listRuns(s.f.taskId)[0]!.outcome, "delivered");
    assert.equal(s.executions(), 0);
  });
}

test("rollback validates terminal receipts even when no injection marker remains", (t) => {
  const s = setup(t);
  s.store.putInjectionReceipt({ version: 1, marker: s.marker, evidence: s.f.evidence, finishedAt: s.f.scheduledTime });
  assert.deepEqual(s.store.listInjections(), []);
  normalizeSchedulerRollback({ root: s.store.root, archiveDir: join(s.dir, "archive"), abandonIds: [] });
  assert.equal(s.store.listRuns(s.f.taskId)[0]!.outcome, "delivered");
  s.store.init();
  writeFileSync(join(s.store.root, "mailbox-receipts", "corrupt.json"), "{}");
  assert.throws(() => schedulerRollbackInventory(s.store.root), /invalid scheduler mailbox receipt/);
  assert.throws(() => normalizeSchedulerRollback({ root: s.store.root, archiveDir: join(s.dir, "archive2"), abandonIds: [] }), /invalid scheduler mailbox receipt/);
});


// Review round 1: only the three reported negative paths.
for (const phase of ["settled", "append-uncertain", "leased"] as const) {
  for (const expired of [false, true]) {
    test(`legacy ${phase} without visible carrier stays unknown (${expired ? "after" : "before"} staleAt)`, (t) => {
      const s = setup(t);
      const { mailbox: _, ...frozen } = s.marker;
      const marker = { ...frozen, phase, ...(phase === "settled" ? { terminalOutcome: "delivered" as const } : {}) };
      s.store.putInjection(marker);
      s.setNow(expired ? marker.staleAt + 1 : marker.staleAt - 1);
      const response = s.offers();
      assert.ok(response.ok && response.type === "injection-offers");
      assert.deepEqual(response.offers, [], "no candidate reaches ordinary put/wake");
      assert.equal(response.unknown[0]?.injectionId, marker.injectionId);
      assert.deepEqual(s.store.getInjection(marker.injectionId), marker, "no re-anchor/phase rewrite or guessed failure");
      assert.equal(s.executions(), 0);
      assert.deepEqual(s.store.listRuns(marker.taskId), []);
    });
  }
}

function storeBytes(root: string): unknown {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
    const path = join(e.parentPath, e.name);
    return [path.slice(root.length), readFileSync(path).toString("base64")];
  }).sort(([a], [b]) => a!.localeCompare(b!));
}

for (const mismatch of ["session", "payload", "anchor", "native-proof"] as const) {
  test(`receipt/marker ${mismatch} conflict refuses inventory, normalization and reconcile without writes`, async (t) => {
    const s = setup(t);
    s.store.putInjectionReceipt({ version: 1, marker: s.marker, evidence: s.f.evidence, finishedAt: s.f.scheduledTime });
    const active = { ...s.marker, mailbox: { ...s.marker.mailbox! } };
    if (mismatch === "session") active.sessionId = "different-session";
    if (mismatch === "payload") active.prompt = "different frozen payload";
    if (mismatch === "anchor") active.mailbox.anchorEntryId = "different-anchor";
    if (mismatch === "native-proof") active.mailbox.entryId = "different-native-entry";
    s.store.putInjection(active);
    const before = storeBytes(s.store.root);
    assert.throws(() => schedulerRollbackInventory(s.store.root), /receipt-marker-conflict/);
    const archive = join(s.dir, "must-not-create-archive");
    assert.throws(() => normalizeSchedulerRollback({ root: s.store.root, archiveDir: archive, abandonIds: [] }), /receipt-marker-conflict/);
    assert.equal(existsSync(archive), false);
    assert.throws(() => s.daemon.mailbox.reconcile(active), /receipt-marker-conflict/);
    assert.throws(() => s.daemon.tick(), /receipt-marker-conflict/);
    assert.throws(() => s.daemon.reconcileCrashed(), /receipt-marker-conflict/);
    await assert.rejects(async () => s.source.onTerminal!(s.f.evidence, s.fence), /receipt-marker-conflict/);
    assert.deepEqual(storeBytes(s.store.root), before);
  });
}

test("legacy source commit/reply loss plus history pruning replays the same terminal without a marker", async (t) => {
  const s = setup(t);
  putLegacySourceTask(s);
  s.store.appendRun({ taskId: s.f.taskId, injectionId: s.f.injectionId, scheduledTime: s.f.scheduledTime,
    finishedAt: s.f.scheduledTime, target: "session", outcome: "delivered" }, s.f.scheduledTime);
  let loseReply = true;
  const source = schedulerProducer(async (request) => {
    const response = s.daemon.mailbox.apply(request as Parameters<typeof s.daemon.mailbox.apply>[0]);
    if (loseReply) { loseReply = false; throw new Error("legacy ACK reply lost after durable commit"); }
    return response;
  });
  await assert.rejects(async () => source.onTerminal!(s.f.evidence, s.fence), /reply lost/);
  const receipt = s.store.getLegacyInjectionReceipt(s.f.injectionId)!;
  assert.equal(receipt.evidence!.terminalId, s.f.evidence.terminalId);
  assert.equal("marker" in receipt, false);
  assert.equal("staleAt" in receipt, false);
  writeFileSync(join(s.store.root, "runs", `${s.f.taskId}.jsonl`), "");
  s.store.deleteTask(s.f.taskId);
  s.restart();
  await source.onTerminal!(s.f.evidence, s.fence);
  await source.onRecorded!(s.f.snapshot.terminal[0]!.recorded!.notice, s.fence);
  await source.onTerminal!(s.f.evidence, s.fence);
  assert.equal(s.store.getInjection(s.f.injectionId), undefined);
  assert.equal(s.store.listRuns(s.f.taskId).length, 0, "pruned history must not be recreated");
  assert.equal(s.executions(), 0);
});

for (const expired of [false, true]) {
  test(`adopted legacy with hidden carrier holds rather than cancel/resend (${expired ? "after" : "before"} staleAt)`, async (t) => {
    const s = setup(t);
    s.store.putInjection({ ...s.marker, mailbox: { ...s.marker.mailbox!, legacy: true } });
    s.setNow(expired ? s.marker.staleAt + 1 : s.marker.staleAt - 1);
    const source = schedulerProducer(async (r) => s.daemon.mailbox.apply(r as Parameters<typeof s.daemon.mailbox.apply>[0]), undefined, () => []);
    assert.deepEqual(await source.checkCurrent(s.f.mail, "before-seal", s.fence), {
      kind: "hold", reason: "scheduler legacy carrier/scope unavailable; unknown",
    });
    assert.equal((await source.proveNative(s.f.mail, [], s.fence)).kind, "conflict");
    assert.equal(s.executions(), 0);
    assert.equal(s.store.listRuns(s.f.taskId).length, 0);
  });
}
