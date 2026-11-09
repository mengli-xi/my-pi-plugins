import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, readFile, writeFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bindMailbox, MAILBOX_HOLDER_KEY, parseMailboxCommand, parseMailboxSnapshot } from "../src/mailbox-v1/index.js";
import { snapshotPath } from "../src/mailbox-v1/store.js";
import { fulfilledFinalAckLostFixture } from "./fixtures/fulfilled-final-ack-lost.js";
import { harness, tick, until, clearMailboxes, recoveredPending } from "./mailbox-harness.js";

test("empty startup and ordinary run neither create storage nor enumerate historical mailboxes", async () => {
  const h = await harness({ persist: true });
  try {
    const orphan = snapshotPath(h.agentDir, "unrelated-broken-history");
    await mkdir(dirname(orphan), { recursive: true }); await writeFile(orphan, "invalid JSON must not be scanned during startup");
    h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    await h.startUser(); await h.context(); await h.finish(); await tick();
    const holder = (globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)];
    assert.equal(holder.recovery.size, 0); assert.equal(holder.recoveryFlights.size, 0);
    assert.equal(existsSync(dirname(snapshotPath(h.agentDir, h.manager.getSessionId()))), false);
  } finally { await h.cleanup(); }
});

test("first cancel writer EACCES does not poison retry or session shutdown after permissions recover", { skip: process.getuid?.() === 0 }, async () => {
  const h = await harness({ persist: true });
  const writerDirectory = dirname(snapshotPath(h.agentDir, h.manager.getSessionId()));
  try {
    const p = h.producer("pi-processes", { checkCurrent: () => ({ kind: "hold", reason: "cancellation fixture" }) });
    await h.emit("session_start", { reason: "new" });
    await mkdir(writerDirectory, { recursive: true }); await chmod(writerDirectory, 0o500);
    await assert.rejects(p.endpoint.cancel("batch:cancel-after-retry", "Side destroyed"), { code: "EACCES" });
    await chmod(writerDirectory, 0o700);
    await assert.rejects(p.endpoint.cancel("batch:cancel-after-retry", "Side destroyed"), { code: "unknown-key" });
    const mail = h.mail("pi-processes", "batch:cancel-after-retry", { wake: false });
    assert.equal((await p.endpoint.put(mail)).kind, "accepted");
    const evidence = await p.endpoint.cancel(mail.key, "Side destroyed"); assert.equal(evidence.outcome, "cancelled");
    const snapshot = parseMailboxSnapshot(JSON.parse(await readFile(snapshotPath(h.agentDir, h.manager.getSessionId()), "utf8")));
    assert.equal(snapshot.pending.length, 0); assert.equal(snapshot.terminal[0]!.evidence.terminalId, evidence.terminalId);
    await h.emit("session_shutdown", { reason: "quit" }); assert.equal(h.sends.length, 0);
  } finally { await chmod(writerDirectory, 0o700); await h.cleanup(); }
});

test("legacy pending without an A snapshot is held when explicitly recovered and resumes without another carrier", async () => {
  const h = await harness({ persist: true });
  try {
    const mail = h.mail("pi-processes", "batch:legacy-pending"), carrier = mail.messages[0]!;
    h.manager.appendCustomMessageEntry(carrier.customType, carrier.content, carrier.display, carrier.details);
    h.manager.appendCustomEntry("process-notification-pending-v1", { batchId: mail.key });
    await writeFile(h.manager.getSessionFile()!, [h.manager.getHeader(), ...h.manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    assert.equal(existsSync(snapshotPath(h.agentDir, h.manager.getSessionId())), false);
    const p = h.producer("pi-processes");
    p.pi.on("session_start", async (_event, ctx) => { await p.endpoint.put(mail, p.endpoint.target(ctx), { recovered: true }); });
    await h.emit("session_start", { reason: "startup" }); await tick(); await tick();
    assert.equal(h.sends.length, 0);
    assert.equal((await p.endpoint.put(mail)).kind, "accepted");
    h.setBusy(true); await h.emit("input", { source: "extension" });
    await h.emit("before_agent_start", { messageType: "user", prompt: "extension work", systemPrompt: "", systemPromptOptions: {} });
    assert.ok(!(await h.context()).some((message: any) => message.content === carrier.content));
    await h.finish(); assert.equal(h.sends.length, 0);
    await h.commands.get("mailbox")!.definition.handler("resume", h.ctx as any);
    await until(() => h.sends.some(send => send.options.triggerTurn));
    const control = h.sends.find(send => send.options.triggerTurn)!.message;
    h.setBusy(true); await h.emit("before_agent_start", { messageType: "custom", message: control, systemPrompt: "", systemPromptOptions: {} });
    assert.ok((await h.context()).some((message: any) => message.content === carrier.content)); await h.finish();
    assert.equal((await p.endpoint.put(mail, p.endpoint.target(h.ctx), { recovered: true })).kind, "terminal");
    assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 0);
    assert.equal(h.manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === carrier.customType).length, 1);
  } finally { await h.cleanup(); }
});

test("recovered replays after tree and Host rebind never rehold a normally accepted live key", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "batch:live-rebind", { wake: false }); await p.endpoint.put(mail);
    await until(() => h.sends.length === 1); p.binding.close();
    const q = h.producer("pi-processes"); await h.emit("session_start", { reason: "reload" });
    await q.endpoint.put(mail, q.endpoint.target(h.ctx), { recovered: true });
    await h.emit("session_tree"); await q.endpoint.put(mail, q.endpoint.target(h.ctx), { recovered: true });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    assert.equal(slot.recoveryHeld, false); assert.equal(slot.recoveryReleased, false);
    assert.equal(h.sends.length, 1);
  } finally { await h.cleanup(); }
});

for (const release of ["user", "resume"] as const) test(`late recovered admission after ${release} release stays live`, async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    if (release === "user") { await h.startUser(); await h.context(); await h.finish(); }
    else await h.commands.get("mailbox")!.definition.handler("resume", h.ctx as any);
    await p.endpoint.put(h.mail("pi-processes", `batch:late-${release}`), p.endpoint.target(h.ctx), { recovered: true });
    await until(() => h.sends.some(send => send.options.triggerTurn));
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0]; assert.equal(slot.recoveryHeld, false);
  } finally { await h.cleanup(); }
});

test("lazy open holds pending committed by an exited writer after startup while a new local key wakes alone", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish(); // Establish actual JSONL before binding; no trusted input hook occurred.
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    assert.equal(existsSync(snapshotPath(h.agentDir, h.manager.getSessionId())), false);
    const old = h.mail("pi-processes", "OLD_OTHER_PROCESS"), identity = { id: h.manager.getSessionId(), file: h.manager.getSessionFile(), cwd: h.cwd };
    const pending = { ...old, acceptedRevision: 1, requiredCallbacks: { recorded: false, terminal: false }, branchEntryId: null, nativeEntries: [], recorded: null };
    const module = new URL("../src/mailbox-v1/store.ts", import.meta.url).href;
    const code = `import {MailboxStore} from ${JSON.stringify(module)}; const [directory,identity,pending]=process.argv.slice(1); const store=new MailboxStore(directory,JSON.parse(identity)); await store.acquire(); await store.transact(draft=>{draft.pending.push(JSON.parse(pending));}); await store.close();`;
    execFileSync(process.execPath, ["--import", fileURLToPath(new URL("../../../ts-resolve.mjs", import.meta.url)), "--experimental-strip-types", "--input-type=module", "-e", code, h.agentDir, JSON.stringify(identity), JSON.stringify(pending)], {
      cwd: h.directory, env: { PATH: process.env.PATH, HOME: h.directory, PI_CODING_AGENT_DIR: h.agentDir, PI_OFFLINE: "1" },
    });
    assert.equal(slot.snapshot.pending.length, 0, "the first writer has not been opened by this slot yet");
    const live = h.mail("pi-processes", "NEW_THIS_PROCESS"); await p.endpoint.put(live);
    await until(() => h.sends.some(send => send.options.triggerTurn)); assert.equal(slot.recoveryHeld, true);
    const control = h.sends.find(send => send.options.triggerTurn)!.message;
    h.setBusy(true); await h.emit("before_agent_start", { messageType: "custom", message: control, systemPrompt: "", systemPromptOptions: {} });
    const messages = await h.context();
    assert.ok(messages.some((message: any) => message.content === "mail:NEW_THIS_PROCESS"));
    assert.ok(!messages.some((message: any) => message.content === "mail:OLD_OTHER_PROCESS"));
    await h.finish(); assert.ok(slot.snapshot.pending.some((record: any) => record.key === old.key));
    assert.ok(!slot.snapshot.pending.some((record: any) => record.key === live.key));
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

test("proof conflicts and exceptions stay blocked across guard allow and settled; repaired proof resumes once", async () => {
  const h = await harness({ persist: true });
  try {
    let state: "conflict" | "unknown" | "repaired" = "conflict";
    const p = h.producer("pi-processes", { proveNative: () => {
      if (state === "conflict") return { kind: "conflict", reason: "duplicate native identity" };
      if (state === "unknown") throw new Error("proof unavailable");
      return { kind: "observed", entries: [] };
    } });
    await h.emit("session_start", { reason: "new" }); await p.endpoint.put(h.mail("pi-processes", "broken-proof", { policy: "new-run" }));
    await until(() => [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0].proofErrors.size === 1);
    for (let index = 0; index < 3; index++) await h.emit("agent_settled", { aborted: false });
    await h.commands.get("mailbox")!.definition.handler("status", h.ctx as any);
    assert.equal(h.sends.length, 0); assert.ok(h.notices.some(text => text.includes("duplicate native identity")));
    state = "unknown"; await h.emit("agent_settled", { aborted: false });
    await h.commands.get("mailbox")!.definition.handler("status", h.ctx as any);
    assert.equal(h.sends.length, 0); assert.ok(h.notices.some(text => text.includes("proof unavailable")));
    state = "repaired"; await h.commands.get("mailbox")!.definition.handler("resume", h.ctx as any);
    await until(() => h.sends.filter(send => send.options.triggerTurn).length === 1);
    await h.emit("agent_settled", { aborted: false }); assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

for (const boundary of ["guard", "proof"] as const) test(`durable cancel wins while final ${boundary} is paused before its first native enqueue`, async () => {
  const h = await harness({ persist: true }); let release = () => {};
  try {
    let entered = false, gate = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const p = h.producer("pi-processes", {
      checkCurrent: async (_mail, point) => { if (boundary === "guard" && point === "before-native-send") { entered = true; await waiting; gate = true; } return { kind: "allow", project: true, wake: false }; },
      proveNative: async () => { if (boundary === "proof" && gate) { entered = true; await waiting; } gate = true; return { kind: "observed", entries: [] }; },
      onTerminal: () => { throw new Error("retain cancellation debt"); },
    });
    await h.emit("session_start", { reason: "new" }); const mail = h.mail("pi-processes", `cancel-final-${boundary}`, { wake: false });
    await p.endpoint.put(mail); await until(() => entered);
    const evidence = await p.endpoint.cancel(mail.key, "authority revoked"); assert.equal(evidence.outcome, "cancelled"); assert.equal(h.sends.length, 0);
    release(); await tick(); await tick(); await h.emit("agent_settled", { aborted: false });
    assert.equal(h.sends.length, 0); assert.equal(h.manager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "fixture-body"), false);
  } finally { release(); await h.cleanup(); }
});

test("a natural next request consumes admitted mail before any extra control is committed", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-subagents"); await h.emit("session_start", { reason: "new" }); await h.startUser(); await h.context();
    const mail = h.mail("pi-subagents", "card:natural-next"); await p.endpoint.put(mail);
    await h.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ role: "toolResult" }], outcome: "completed", continue: false });
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 0);
    await h.context(); await h.finish(); await h.emit("agent_before_settle");
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 0);
    assert.equal((await p.endpoint.put(mail)).kind, "terminal");
  } finally { await h.cleanup(); }
});

for (const notice of ["recorded", "terminal"] as const) test(`source ${notice} ACK committed but A ACK write failure replays the same token without another control`, async () => {
  const h = await harness({ persist: true });
  try {
    let fail = false, first = true;
    const tokens: string[] = [];
    const ack = (token: string) => { tokens.push(token); if (first) { first = false; fail = true; } };
    const p = h.producer("pi-processes", {
      checkCurrent: () => ({ kind: "allow", project: true, wake: false }),
      ...(notice === "recorded" ? { onRecorded: (value: { recordedToken: string }) => ack(value.recordedToken) } : { onTerminal: (value: { terminalId: string }) => ack(value.terminalId) }),
    });
    await h.emit("session_start", { reason: "new" });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    await slot.ensureEngine();
    Object.defineProperty(await slot.store.open(), "faults", { value: { at: (point: string) => { if (fail && point === "before-write") throw new Error("A ACK write failed"); } } });
    await p.endpoint.put(h.mail("pi-processes", `ack-write-${notice}`, { wake: false }));
    if (notice === "terminal") { await h.startUser(); await h.context(); await h.finish(); }
    await until(() => h.notices.some(value => value.includes("A ACK write failed"))); fail = false;
    await h.emit("agent_settled", { aborted: false }); await until(() => tokens.length >= 2);
    assert.equal(new Set(tokens).size, 1); assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 0);
  } finally { await h.cleanup(); }
});

test("empty-session cancel is durable before source ACK, idempotent, and cannot GC memory-only receipt", async () => {
  const h = await harness();
  try {
    const p = h.producer("pi-mcp-adapter", { checkCurrent: () => ({ kind: "hold", reason: "cancel fixture" }), onTerminal: () => { throw new Error("source unavailable"); } });
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-mcp-adapter", "ui:1");
    const accepted = await p.endpoint.put(mail); assert.equal(accepted.kind, "accepted");
    const cancelled = await p.endpoint.cancel(mail.key, "closed");
    await tick(); await tick();
    const snapshot = parseMailboxSnapshot(JSON.parse(await readFile(snapshotPath(h.agentDir, h.manager.getSessionId()), "utf8")));
    assert.equal(snapshot.pending.length, 0); assert.equal(snapshot.terminal[0]?.evidence.terminalId, cancelled.terminalId);
    assert.equal(snapshot.terminal[0]?.terminalAck, "pending");
    assert.deepEqual(await p.endpoint.put(mail), { kind: "terminal", evidence: cancelled });
    assert.deepEqual(await p.endpoint.cancel(mail.key, "different retry reason"), cancelled);
    const before = h.manager.getBranch().length, navigation = await h.emit("session_before_tree");
    assert.ok(navigation.results.some(result => result?.cancel)); assert.equal(h.manager.getBranch().length, before);
    assert.equal(h.sends.length, 0);
    await assert.rejects(p.endpoint.cancel("unknown", "closed"), { code: "unknown-key" });
  } finally { await h.cleanup(); }
});

test("beforeRun admission includes awaited put in the same accepted user request", async () => {
  const h = await harness({ persist: true });
  try {
    let endpoint: ReturnType<typeof h.producer>["endpoint"];
    const p = h.producer("pi-processes", { beforeRun: async () => { await endpoint.put(h.mail("pi-processes", "batch:admitted", { policy: "next-user", wake: false })); } });
    endpoint = p.endpoint;
    await h.emit("session_start", { reason: "startup" });
    await h.startUser(); const messages = await h.context();
    assert.ok(messages.some((message: any) => message.content === "mail:batch:admitted"));
    await h.finish();
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 0);
    const repeated = await p.endpoint.put(h.mail("pi-processes", "unused", { wake: false })); assert.equal(repeated.kind, "accepted");
  } finally { await h.cleanup(); }
});

test("idle readiness appends project=true with effective wake=false, ACKs, then rechecks one wake", async () => {
  const h = await harness({ persist: true });
  try {
    let ready = false, recorded = 0;
    const p = h.producer("pi-processes", { checkCurrent: () => ({ kind: "allow", project: true, wake: ready }), onRecorded: async () => { recorded++; ready = true; } });
    await h.emit("session_start", { reason: "new" });
    await p.endpoint.put(h.mail("pi-processes", "batch:ready"));
    await until(() => h.sends.some(send => send.options.triggerTurn), "readiness wake");
    assert.equal(recorded, 1); assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 1);
    await tick(); assert.equal(h.sends.length, 2);
  } finally { await h.cleanup(); }
});

test("stable facade routes to peer after owner.close, keeps one command, and rejects extra grammar", async () => {
  const h = await harness({ persist: true });
  try {
    const a = h.producer("pi-processes"), b = h.producer("pi-scheduler");
    await h.emit("session_start", { reason: "startup" });
    const command = h.commands.get("mailbox")!.definition;
    assert.deepEqual((await command.getArgumentCompletions!(""))?.map(item => item.value), ["status", "resume", "recover"]);
    assert.deepEqual((await command.getArgumentCompletions!("res"))?.map(item => item.value), ["resume"]);
    assert.equal(await command.getArgumentCompletions!("unknown"), null);
    assert.equal(await command.getArgumentCompletions!("recover missing"), null);
    a.endpoint.close();
    await command.handler("status", h.ctx as any); await command.handler("resume", h.ctx as any);
    assert.deepEqual([...h.commands.keys()], ["mailbox"]); assert.equal(h.sends.length, 0);
    const holder = (globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)];
    assert.equal([...holder.slots.values()][0].owner.producerToken, b.endpoint.token);
    b.endpoint.close(); await command.handler("resume", h.ctx as any);
    assert.ok(h.notices.some(text => text.includes("no delivery owner")));
    assert.throws(() => parseMailboxCommand("resume all"));
  } finally { await h.cleanup(); }
});

test("shared A/E fulfilled fixture replays final ACK with pending empty and no native/model requests", async () => {
  const base = await harness();
  try {
    await clearMailboxes();
    const file = base.manager.getSessionFile()!, fixture = fulfilledFinalAckLostFixture(file, base.cwd);
    await writeFile(file, fixture.sessionEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const path = snapshotPath(base.agentDir, fixture.snapshot.session.id);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(fixture.snapshot));
    const manager = SessionManager.open(file), h = await harness({ directory: base.directory, manager });
    let ack = "", lifecycle = 0;
    const p = h.producer("pi-scheduler", {
      onRecorded: () => assert.fail("already ACKed recorded notice must not replay"),
      onTerminal: async evidence => { ack = evidence.terminalId; },
      beforeRun: () => { lifecycle++; }, afterRun: () => { lifecycle++; }, settled: () => { lifecycle++; },
    });
    await h.emit("session_start", { reason: "startup" });
    await until(() => ack !== "", "terminal ACK replay");
    await until(() => { const holder = (globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)]; return [...holder.slots.values()][0].snapshot.terminal.length === 0; }, "ACK then GC");
    assert.equal(ack, fixture.evidence.terminalId); assert.equal(lifecycle, 0); assert.equal(h.sends.length, 0);
    assert.deepEqual(await p.endpoint.put(fixture.mail), { kind: "terminal", evidence: fixture.evidence });
  } finally { await base.cleanup(); }
});

test("execution activation checks producer token, restored snapshot, and first-run boundary", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("independent-execution-owner", { capabilities: { activateNewExecution: true } }), q = h.producer("pi-subagents");
    await h.emit("session_start", { reason: "startup" });
    await assert.rejects(q.endpoint.activateNewExecution(q.endpoint.target(h.ctx)), { code: "conflict" });
    await p.endpoint.activateNewExecution(p.endpoint.target(h.ctx));
    await h.startUser();
    await assert.rejects(p.endpoint.activateNewExecution(p.endpoint.target(h.ctx)), { code: "conflict" });
  } finally { await h.cleanup(); }
});

test("live false-body/control tokens survive absent observations, unrelated settle, peer takeover and reload", async () => {
  const h = await harness({ persist: true });
  try {
    const a = h.producer("pi-processes"), b = h.producer("pi-scheduler");
    await h.emit("session_start", { reason: "new" }); h.setBusy(true);
    await a.endpoint.put(h.mail("pi-processes", "batch:queued"));
    await h.emit("agent_before_settle");
    assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 1);
    await h.emit("agent_before_settle"); h.setBusy(false); await h.emit("agent_settled", { aborted: false });
    const holder = (globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)], slot = [...holder.slots.values()][0];
    assert.equal(slot.submitted.activeControls.size, 1); assert.equal(slot.submitted.falseBodies.size, 1);
    assert.equal([...slot.submitted.activeControls.values()][0].start, null);
    await h.commands.get("mailbox")!.definition.handler("status", h.ctx as any);
    assert.ok(h.notices.some(text => text.includes("fresh process")));
    a.endpoint.close(); assert.equal(slot.owner.producerToken, b.endpoint.token);
    const generation = slot.bindingGeneration, submitted = slot.submitted;
    await h.emit("session_shutdown", { reason: "reload" });
    const next = await harness({ directory: h.directory, manager: h.manager }); next.producer("pi-processes"); next.producer("pi-scheduler");
    await next.emit("session_start", { reason: "reload" }); await tick(); await tick();
    assert.equal(slot.bindingGeneration, generation + 1); assert.equal(slot.submitted, submitted);
    assert.equal(next.sends.length, 0); assert.equal(h.sends.length, 2);
  } finally { await h.cleanup(); }
});

test("recorded rejection followed by fulfilled retains debt and replacement replays recorded before terminal", async () => {
  const h = await harness({ persist: true });
  try {
    const tokens: string[] = [], order: string[] = [];
    const a = h.producer("pi-processes", { onRecorded: notice => { tokens.push(notice.recordedToken); throw new Error("lost handoff reply"); }, onTerminal: () => assert.fail("recorded debt must come first") });
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "batch:ack-debt", { wake: false }); await a.endpoint.put(mail);
    await h.startUser(); await h.context(); await h.finish();
    const holder = (globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)], slot = [...holder.slots.values()][0];
    await until(() => tokens.length > 0);
    assert.equal(slot.snapshot.pending.length, 0); assert.equal(slot.snapshot.terminal[0].recorded.ack, "pending");
    const expectedToken = slot.snapshot.terminal[0].recorded.notice.recordedToken, terminalId = slot.snapshot.terminal[0].evidence.terminalId;
    a.endpoint.close();
    a.binding.registerProducer({ id: "pi-processes", checkCurrent: () => ({ kind: "hold", reason: "ACK repair only" }), proveNative: () => ({ kind: "observed", entries: [] }),
      onRecorded: notice => { assert.equal(notice.recordedToken, expectedToken); order.push("recorded"); },
      onTerminal: evidence => { assert.equal(evidence.terminalId, terminalId); order.push("terminal"); } });
    await until(() => order.length === 2); assert.deepEqual(order, ["recorded", "terminal"]);
    assert.equal(new Set(tokens).size, 1); assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 0);
  } finally { await h.cleanup(); }
});

test("legacy fulfilled imports own native carrier as receipt, preserves identity and sends nothing", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-scheduler"); const mail = h.mail("pi-scheduler", "injection:legacy", { policy: "new-run" });
    const carrier = mail.messages[0]!, nativeId = h.manager.appendCustomMessageEntry(carrier.customType, carrier.content, carrier.display, carrier.details);
    const fixture = fulfilledFinalAckLostFixture(h.manager.getSessionFile()!, h.cwd);
    const assistant = fixture.sessionEntries.find(entry => entry.type === "message" && entry.id === "assistant-fixture")!;
    assert.equal(assistant.type, "message"); if (assistant.type !== "message" || assistant.message.role !== "assistant") return;
    const assistantEntryId = h.manager.appendMessage(assistant.message);
    await h.emit("session_start", { reason: "startup" });
    const evidence = await p.endpoint.importFulfilled(mail, { sourceReceiptEntryId: nativeId, assistantEntryId });
    assert.equal(evidence.outcome, "fulfilled"); assert.equal(h.sends.length, 0);
    assert.deepEqual(await p.endpoint.put(mail), { kind: "terminal", evidence });
    await assert.rejects(p.endpoint.put({ ...mail, wake: false }), { code: "conflict" });
  } finally { await h.cleanup(); }
});

test("second live SDK object for same file and incompatible holder fail closed", async () => {
  const h = await harness({ persist: true });
  try {
    h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const other = await harness({ directory: h.directory, manager: SessionManager.open(h.manager.getSessionFile()!) }); other.producer("pi-scheduler");
    await assert.rejects(other.emit("session_start", { reason: "startup" }), { code: "writer-conflict" });
  } finally { await h.cleanup(); }
  const root = globalThis as any, symbol = Symbol.for(MAILBOX_HOLDER_KEY), bad = { version: 99, slots: new Map() };
  root[symbol] = bad; assert.throws(() => bindMailbox({} as any), { code: "holder-incompatible" }); assert.equal(root[symbol], bad); delete root[symbol];
  const legacy = { version: 1, transportBuildId: "mailbox-v1.0.0", slots: new Map(), bind: () => assert.fail("old runtime cannot interpret recovery admission") };
  root[symbol] = legacy; assert.throws(() => bindMailbox({} as any), { code: "holder-incompatible" }); assert.equal(root[symbol], legacy); delete root[symbol];
});

test("put/cancel resolve while guard, recorded ACK, terminal ACK and beforeRun callbacks are blocked", async () => {
  const h = await harness({ persist: true });
  let releaseGuard = () => {}, releaseRecorded = () => {}, releaseTerminal = () => {}, releaseBefore = () => {};
  try {
    let guardEntered = false, recordedEntered = false, terminalEntered = false, beforeEntered = false;
    let guardBlock = true;
    const guard = new Promise<void>(resolve => { releaseGuard = resolve; });
    const recorded = new Promise<void>(resolve => { releaseRecorded = resolve; });
    const terminal = new Promise<void>(resolve => { releaseTerminal = resolve; });
    const before = new Promise<void>(resolve => { releaseBefore = resolve; });
    const p = h.producer("pi-processes", {
      checkCurrent: async () => { if (guardBlock) { guardEntered = true; await guard; } return { kind: "allow", project: true, wake: false }; },
      onRecorded: async () => { recordedEntered = true; await recorded; },
      onTerminal: async () => { terminalEntered = true; await terminal; },
      beforeRun: async () => { beforeEntered = true; await before; },
    });
    await h.emit("session_start", { reason: "new" });
    const guardMail = h.mail("pi-processes", "batch:guard");
    assert.equal((await p.endpoint.put(guardMail)).kind, "accepted");
    await until(() => guardEntered);
    assert.equal((await p.endpoint.cancel(guardMail.key, "cancel during guard")).outcome, "cancelled");
    guardBlock = false; releaseGuard();
    await until(() => terminalEntered);
    // Even an already-running final source ACK is not in the durable cancel path.
    assert.equal((await p.endpoint.cancel(guardMail.key, "retry during terminal ACK")).outcome, "cancelled");
    const recordedMail = h.mail("pi-processes", "batch:recorded");
    assert.equal((await p.endpoint.put(recordedMail)).kind, "accepted");
    await until(() => recordedEntered);
    assert.equal((await p.endpoint.cancel(recordedMail.key, "cancel during recorded ACK")).outcome, "cancelled");
    const starting = h.startUser(); await until(() => beforeEntered);
    const inRun = h.mail("pi-processes", "batch:beforeRun");
    assert.equal((await p.endpoint.put(inRun)).kind, "accepted");
    assert.equal((await p.endpoint.cancel(inRun.key, "cancel during beforeRun")).outcome, "cancelled");
    releaseBefore(); await starting;
  } finally { releaseGuard(); releaseRecorded(); releaseTerminal(); releaseBefore(); await h.cleanup(); }
});

test("compaction repair projects the frozen pending body without a second native carrier", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "batch:compact", { wake: false }); await p.endpoint.put(mail);
    await h.startUser(); await h.context();
    const filtered = h.messages().filter((message: any) => message.customType !== "fixture-body");
    const projected = await h.emit("context", { messages: filtered });
    assert.equal(projected.event.messages.filter((message: any) => message.content === "mail:batch:compact").length, 1);
    await h.emit("context_with_system", { messages: projected.event.messages }); await h.finish();
    assert.equal(h.manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "fixture-body").length, 1);
    assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

test("canonical lineage fences sibling branches and resumes the original key on return", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes", { checkCurrent: () => ({ kind: "allow", project: true, wake: false }) });
    await h.emit("session_start", { reason: "new" });
    const mail = h.mail("pi-processes", "batch:branch", { wake: false }), origin = mail.anchorEntryId!;
    await p.endpoint.put(mail);
    await until(() => h.manager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "fixture-body"));
    await tick(); const native = h.manager.getBranch().find(entry => entry.type === "custom_message" && entry.customType === "fixture-body")!;
    h.manager.branch(origin); h.manager.appendMessage({ role: "user", content: "sibling", timestamp: Date.now() });
    await h.emit("session_tree");
    await assert.rejects(p.endpoint.put({ ...mail, anchorEntryId: h.manager.getLeafId() }), { code: "conflict" });
    await h.startUser(); const sibling = await h.context();
    assert.ok(!sibling.some((message: any) => message.content === "mail:batch:branch")); await h.finish();
    h.manager.branch(native.id); await h.emit("session_tree");
    await h.startUser(); const original = await h.context(); assert.ok(original.some((message: any) => message.content === "mail:batch:branch")); await h.finish();
    assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

test("cold hold ignores streaming/extension/ambiguous candidates until one accepted external input", async () => {
  const h = await harness({ persist: true });
  try {
    await recoveredPending(h.agentDir, h.manager, [h.mail("pi-processes", "batch:held")]);
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    await h.emit("input", { source: "rpc", streamingBehavior: "steer" });
    await h.emit("input", { source: "extension" }); h.setBusy(true);
    await h.emit("before_agent_start", { messageType: "user", prompt: "extension", systemPrompt: "", systemPromptOptions: {} });
    assert.equal(h.sends.length, 0);
    await h.emit("input", { source: "rpc" }); await h.emit("input", { source: "rpc" });
    await h.emit("before_agent_start", { messageType: "user", prompt: "ambiguous", systemPrompt: "", systemPromptOptions: {} }); assert.equal(h.sends.length, 0);
    await h.startUser(); await h.context(); assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

test("cold hold fences restored keys while new live mail can wake and restored carriers stay out of its request", async () => {
  const h = await harness({ persist: true });
  try {
    const old = h.mail("pi-processes", "batch:restored");
    await recoveredPending(h.agentDir, h.manager, [old]);
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    assert.equal(slot.recoveryHeld, true);
    await p.endpoint.put(old); await tick(); assert.equal(h.sends.length, 0);
    const live = h.mail("pi-processes", "batch:live"); await p.endpoint.put(live);
    await until(() => h.sends.some(send => send.options.triggerTurn));
    assert.equal(slot.recoveryHeld, true);
    const control = h.sends.find(send => send.options.triggerTurn)!.message;
    h.setBusy(true); await h.emit("input", { source: "extension" });
    await h.emit("before_agent_start", { messageType: "custom", message: { role: "custom", ...control }, systemPrompt: "", systemPromptOptions: {} });
    // Even a restored body already present in raw history cannot piggyback on
    // a live extension-driven run and discharge the old recovery obligation.
    const carrier = old.messages[0]!; h.manager.appendCustomMessageEntry(carrier.customType, carrier.content, carrier.display, carrier.details);
    const messages = await h.context();
    assert.ok(messages.some((message: any) => message.content === "mail:batch:live"));
    assert.ok(!messages.some((message: any) => message.content === "mail:batch:restored"));
    await h.finish(); assert.ok(slot.snapshot.pending.some((mail: any) => mail.key === old.key));
    assert.ok(!slot.snapshot.pending.some((mail: any) => mail.key === live.key));
    assert.equal(slot.recoveryHeld, true);
  } finally { await h.cleanup(); }
});

test("retired persisted session reopens with a new SDK manager without carrying closed execution queues", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-subagents"); await h.emit("session_start", { reason: "startup" });
    await h.emit("input", { source: "extension" }); h.setBusy(true);
    await h.emit("before_agent_start", { messageType: "user", prompt: "first Task", systemPrompt: "", systemPromptOptions: {} });
    await h.context(); await h.finish();
    const old = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    const live = h.mail("pi-subagents", "outbox:closed-resume", { wake: false }); await p.endpoint.put(live);
    await h.emit("session_shutdown", { reason: "quit" });
    const next = await harness({ directory: h.directory, manager: SessionManager.open(h.manager.getSessionFile()!) });
    const q = next.producer("pi-subagents"); await next.emit("session_start", { reason: "resume" });
    const reopened = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    assert.notEqual(reopened, old); assert.equal(reopened.sessionManager, next.manager);
    assert.equal(reopened.bindingGeneration, old.bindingGeneration + 1); assert.equal(reopened.recoveryHeld, false);
    assert.equal(reopened.submitted.activeControls.size + reopened.submitted.idleControls.size, 0);
    assert.equal(q.endpoint.target(next.ctx).session.id, old.session.id);
    await q.endpoint.put(live, q.endpoint.target(next.ctx), { recovered: true }); assert.equal(reopened.recoveryHeld, false);
  } finally { await h.cleanup(); }
});

test("late successor is not removed by the earlier request's fulfilled transaction", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const first = h.mail("pi-processes", "batch:first", { wake: false }); await p.endpoint.put(first);
    await h.startUser(); await h.context();
    const successor = h.mail("pi-processes", "batch:successor"); await p.endpoint.put(successor);
    await h.finish();
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    assert.ok(!slot.snapshot.pending.some((record: any) => record.key === first.key));
    assert.ok(slot.snapshot.pending.some((record: any) => record.key === successor.key));
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

test("late source ACK after owner handoff cannot acknowledge the replacement registration", async () => {
  const h = await harness({ persist: true }); let releaseOld = () => {}, releaseNew = () => {};
  try {
    let oldEntered = false, newEntered = false;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; }), newGate = new Promise<void>(resolve => { releaseNew = resolve; });
    const a = h.producer("pi-processes", { checkCurrent: () => ({ kind: "allow", project: true, wake: false }), onRecorded: async () => { oldEntered = true; await oldGate; } });
    h.producer("pi-scheduler"); await h.emit("session_start", { reason: "new" });
    await a.endpoint.put(h.mail("pi-processes", "batch:stale-ack", { wake: false })); await until(() => oldEntered);
    a.endpoint.close();
    a.binding.registerProducer({ id: "pi-processes", checkCurrent: () => ({ kind: "hold", reason: "repair" }), proveNative: () => ({ kind: "observed", entries: [] }), onRecorded: async () => { newEntered = true; await newGate; } });
    await until(() => newEntered); releaseOld(); await tick(); await tick();
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    assert.equal(slot.snapshot.pending[0].recorded.ack, "pending");
    releaseNew(); await until(() => slot.snapshot.pending[0].recorded.ack === "acknowledged");
    assert.equal(h.sends.filter(send => !send.options.triggerTurn).length, 1);
  } finally { releaseOld(); releaseNew(); await h.cleanup(); }
});

test("registrar lifecycle still retires after the last binding closes and collision never aliases mailbox", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0], generation = slot.bindingGeneration;
    p.binding.close(); await h.emit("session_shutdown", { reason: "reload" }); assert.equal(slot.retired, true);
    const next = await harness({ directory: h.directory, manager: h.manager }); next.producer("pi-processes"); await next.emit("session_start", { reason: "reload" });
    assert.equal(slot.bindingGeneration, generation + 1); assert.deepEqual([...next.commands.keys()], ["mailbox"]);
  } finally { await h.cleanup(); }
  const foreign = await harness();
  try {
    foreign.piFor("foreign").registerCommand("mailbox", { handler: async () => {} }); foreign.producer("pi-processes");
    await assert.rejects(foreign.emit("session_start", { reason: "startup" }), { code: "command-collision" });
    assert.deepEqual([...foreign.commands.keys()], ["mailbox"]); assert.equal(foreign.sends.length, 0);
  } finally { await foreign.cleanup(); }
});

test("source durable terminal commit with lost reply replays same token and makes only one source transition", async () => {
  const h = await harness({ persist: true });
  try {
    const sourceJournal = join(h.directory, "source-terminal-journal.jsonl"); await writeFile(sourceJournal, "");
    let transitions = 0, replies = 0;
    const commitSource = async (id: string) => {
      if ((await readFile(sourceJournal, "utf8")).split("\n").includes(id)) return;
      const handle = await open(sourceJournal, "a");
      try { await handle.appendFile(`${id}\n`); await handle.sync(); } finally { await handle.close(); }
      transitions++;
    };
    const a = h.producer("pi-processes", { onTerminal: async evidence => {
      await commitSource(evidence.terminalId);
      replies++; throw new Error("source committed but reply lost");
    } });
    await h.emit("session_start", { reason: "startup" });
    await a.endpoint.put(h.mail("pi-processes", "batch:lost-final-reply", { wake: false }));
    await h.startUser(); await h.context(); await h.finish(); await until(() => replies > 0);
    a.endpoint.close();
    a.binding.registerProducer({ id: "pi-processes", checkCurrent: () => ({ kind: "hold", reason: "repair" }), proveNative: () => ({ kind: "observed", entries: [] }), onTerminal: async evidence => {
      await commitSource(evidence.terminalId); replies++;
    } });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    await until(() => slot.snapshot.terminal.length === 0); assert.equal(transitions, 1); assert.ok(replies >= 2);
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 0);
  } finally { await h.cleanup(); }
});

test("one stalled participant is bounded and cannot admit its late mail into this request", async () => {
  const h = await harness({ persist: true });
  try {
    let endpoint: ReturnType<typeof h.producer>["endpoint"];
    const blocked = h.producer("pi-processes", { beforeRun: async () => {
      await endpoint.put(h.mail("pi-processes", "batch:timed-out", { wake: false })); await new Promise<void>(() => {});
    } }); endpoint = blocked.endpoint;
    const peer = h.producer("pi-scheduler", { beforeRun: async () => { await peer.endpoint.put(h.mail("pi-scheduler", "injection:ready", { wake: false })); } });
    await h.emit("session_start", { reason: "startup" });
    await h.startUser(); const messages = await h.context();
    assert.ok(h.notices.some(text => text.includes("participant exceeded 5s")));
    assert.ok(!messages.some((message: any) => message.content === "mail:batch:timed-out"));
    assert.ok(messages.some((message: any) => message.content === "mail:injection:ready"));
  } finally { await h.cleanup(); }
});

test("tree advances one generation and fences unaccepted async put anchored at a shared ancestor", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); h.producer("pi-scheduler"); await h.emit("session_start", { reason: "startup" });
    const target = p.endpoint.target(h.ctx), mail = h.mail("pi-processes", "batch:old-branch"), root = h.manager.getLeafId()!;
    h.manager.appendMessage({ role: "user", content: "branch A", timestamp: Date.now() });
    h.manager.branch(root); h.manager.appendMessage({ role: "user", content: "branch B", timestamp: Date.now() });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0], epoch = slot.ownerEpoch;
    await h.emit("session_tree");
    assert.equal(slot.bindingGeneration, target.bindingGeneration + 1); assert.equal(slot.ownerEpoch, epoch);
    assert.equal(p.endpoint.target(h.ctx).producerToken, target.producerToken);
    await assert.rejects(p.endpoint.put(mail, target), { code: "stale-binding" }); assert.equal(slot.snapshot.pending.length, 0);
  } finally { await h.cleanup(); }
});

test("a failed ingress transaction is excluded until same-key retry reconciles its durable result", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "new" });
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    let enabled = true;
    await slot.ensureEngine();
    Object.defineProperty(await slot.store.open(), "faults", { configurable: true, value: { at: (point: string) => { if (enabled && point === "after-commit") throw new Error("lost acceptance response"); } } });
    const mail = h.mail("pi-processes", "batch:uncertain-put");
    await assert.rejects(p.endpoint.put(mail), { code: "io-error" }); enabled = false;
    await h.emit("agent_before_settle"); await tick(); assert.equal(h.sends.length, 0); assert.equal(slot.failedIngress.size, 1);
    assert.equal((await p.endpoint.put(mail)).kind, "accepted");
    await until(() => h.sends.some(send => send.options.triggerTurn)); assert.equal(slot.failedIngress.size, 0);
    assert.equal(h.sends.filter(send => send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});

test("put entering after navigation cutoff still binds the origin anchor instead of the sibling", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "new" });
    const root = h.manager.getLeafId()!, mail = h.mail("pi-processes", "batch:navigation-race", { wake: false }), target = p.endpoint.target(h.ctx);
    const original = p.pi.appendEntry.bind(p.pi); let ingress: Promise<unknown> | undefined, anchor: string | null = null;
    p.pi.appendEntry = (type, data) => {
      original(type, data);
      if (!ingress && type === "agent-mailbox-attempt-v1") { anchor = h.manager.getLeafId(); ingress = p.endpoint.put(mail, target); }
    };
    const navigation = await h.emit("session_before_tree"); assert.ok(!navigation.results.some(result => result?.cancel));
    h.manager.branch(root); h.manager.appendMessage({ role: "user", content: "new sibling", timestamp: Date.now() });
    await h.emit("session_tree"); await ingress;
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    assert.equal(slot.snapshot.pending[0].branchEntryId, anchor);
    await h.startUser(); const messages = await h.context();
    assert.ok(!messages.some((message: any) => message.content === "mail:batch:navigation-race"));
  } finally { await h.cleanup(); }
});

test("failed recorded ACK plus duplicate put/proof checks reaches a fixed point and still permits guard recheck", async () => {
  const h = await harness({ persist: true });
  try {
    let callbacks = 0, guardCalls = 0, granted = false;
    const mail = h.mail("pi-subagents", "failed-ack", { wake: false });
    const waiting = h.mail("pi-subagents", "child-grant", { wake: false });
    const p = h.producer("pi-subagents", {
      checkCurrent: value => { guardCalls++; return value.key === waiting.key && !granted ? { kind: "hold", reason: "Task grant pending" } : { kind: "allow", project: true, wake: false }; },
      onRecorded: async notice => { if (notice.key !== mail.key) return; callbacks++; await p.endpoint.put(mail); throw new Error("source write still failing"); },
    });
    await h.emit("session_start", { reason: "new" }); await p.endpoint.put(mail); await p.endpoint.put(waiting);
    await until(() => callbacks === 1 && h.notices.length === 1);
    const slot = [...((globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)]).slots.values()][0];
    const idle = async () => { for (let i = 0; i < 20; i++) { await tick(); await slot.store.barrier(); } };
    await idle(); const revision = slot.snapshot.revision, beforeGuards = guardCalls;
    for (let i = 0; i < 100; i++) { await p.endpoint.put(mail); await slot.reconcileProofs(); }
    await idle(); assert.equal(callbacks, 1); assert.equal(h.notices.length, 1); assert.equal(slot.snapshot.revision, revision);
    assert.ok(guardCalls > beforeGuards, "same admission still reevaluates the guard");
    assert.equal(h.sends.some(send => send.message.content === waiting.messages[0]!.content), false);
    granted = true; await p.endpoint.put(waiting);
    await until(() => slot.snapshot.pending.find((record: any) => record.key === waiting.key)?.recorded?.ack === "acknowledged");
    await idle();
    const atRest = { callbacks, notices: h.notices.length, revision: slot.snapshot.revision };
    for (let i = 0; i < 20; i++) { await p.endpoint.put(waiting); await slot.reconcileProofs(); }
    await idle(); assert.deepEqual({ callbacks, notices: h.notices.length, revision: slot.snapshot.revision }, atRest);
    assert.equal(h.sends.filter(send => send.message.content === waiting.messages[0]!.content).length, 1);
  } finally { await h.cleanup(); }
});

test("cold failed ACK does not block healthy live keys and cannot release another key's recovery hold", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const bad = h.mail("pi-subagents", "bad", { wake: false }), held = h.mail("pi-subagents", "old-held", { wake: false });
    const first = h.producer("pi-subagents", { checkCurrent: mail => mail.key === held.key ? { kind: "hold", reason: "old source" } : { kind: "allow", project: true, wake: false },
      onRecorded: () => { throw new Error("bad source ACK"); } });
    await h.emit("session_start", { reason: "new" }); await first.endpoint.put(bad); await first.endpoint.put(held);
    await until(() => h.notices.some(text => text.includes("bad source ACK")));
    await clearMailboxes();
    const reopened = await harness({ directory: h.directory, manager: SessionManager.open(h.manager.getSessionFile()!) });
    let failures = 0, healthy = 0;
    const second = reopened.producer("pi-subagents", { checkCurrent: () => ({ kind: "allow", project: true, wake: false }), onRecorded: notice => {
      if (notice.key === bad.key) { failures++; throw new Error("bad source ACK"); } healthy++;
    } });
    await reopened.emit("session_start", { reason: "startup" });
    await until(() => failures > 0);
    await second.endpoint.put(reopened.mail("pi-subagents", "healthy-live", { wake: false }));
    await until(() => healthy === 1);
    const slot = [...((globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)]).slots.values()][0];
    assert.ok(slot.held(held)); assert.equal(slot.snapshot.pending.find((record: any) => record.key === held.key).nativeEntries.length, 0);
    assert.equal(reopened.sends.some(send => send.message.content === held.messages[0]!.content), false);
    assert.equal(reopened.sends.filter(send => !send.options.triggerTurn).length, 1);
  } finally { await h.cleanup(); }
});


test("unlisted producer registers, persists and delivers through the ordinary mailbox contract", async () => {
  const h = await harness({ persist: true });
  try {
    const p = h.producer("stand-in-owner");
    await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("stand-in-owner", "open-registration");
    assert.equal((await p.endpoint.put(mail)).kind, "accepted");
    await h.startUser(); await h.context();
    assert.ok(h.messages().some(message => message.content === "mail:open-registration"));
  } finally { await h.cleanup(); }
});
