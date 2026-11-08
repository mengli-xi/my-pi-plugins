import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";
import { checkpointDirectoryName, journalFileName } from "../../src/persistence/checkpoint.js";
import { scanJournalV1 } from "../../src/persistence/journal.js";
import { reconcileMainDeliveryV1 } from "../../src/host/delivery-engine.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function hasUser(serialized: string, body: string) {
  return JSON.parse(serialized).some((m: any) => m.role === "user" && JSON.stringify(m.content).includes(body));
}
function terminals(entries: any[]) { return entries.filter(e => e.customType === "agent-mailbox-delivery-v1").flatMap(e => e.data.terminals); }

async function quiescent(f: Awaited<ReturnType<typeof createSdkFixture>>, b: NonNullable<ReturnType<NonNullable<typeof f.cell.service>["binding"]>>, id: Parameters<typeof b.runtime.childForView>[0]) {
  const child = (await b.runtime.childForView(id))!;
  await until(() => child.session.isIdle && b.runtime.residency(id)?.state === "idle"
    && b.host.snapshot().agents.find(p => p.agent.agent_id === id)!.tasks.every(task => task.phase === "settled")
    && b.host.snapshot().agents.find(p => p.agent.agent_id === id)!.owner_events.every(event => ["acked", "cancelled"].includes(event.state))
    && [b.host.snapshot().root, ...b.host.snapshot().agents].flatMap(p => p.outbox).filter(o => o.recipient.agent_id === id).every(o => o.state === "delivered")
    && child.conversation.reloadRefusalReason() === undefined,
  "execution owner obligations settled", () => ({ state: b.host.snapshot(), errors: f.cell.service?.diagnostics() }));
  await child.drain(); await b.runtime.drainControl(id); await new Promise<void>(resolve => setImmediate(resolve));
  return child;
}

async function reloadQuiescent(f: Awaited<ReturnType<typeof createSdkFixture>>, b: Parameters<typeof quiescent>[1], id: Parameters<typeof quiescent>[2], options?: Parameters<Awaited<ReturnType<typeof quiescent>>["session"]["reload"]>[0]) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const child = await quiescent(f, b, id), shutdowns = f.control.disposed.length;
    try { await child.session.reload(options); return; }
    catch (error) {
      // An empty control flush can overtake drainControl. Poll only this public
      // pre-shutdown refusal; any native attempt/failure is returned immediately.
      if (f.control.disposed.length !== shutdowns || !(error instanceof Error) || !error.message.includes("Child SDK reload refused: execution control is still active") || Date.now() >= deadline) throw error;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}

test("active SDK reload is visibly refused before shutdown and the original Task settles once", { timeout: 60_000 }, async () => {
  const f = await createSdkFixture(), gate = deferred();
  f.control.responses.set("CHILD_WORK", gate.promise);
  try {
    await f.runtime.session.prompt("SPAWN_NONE");
    const s = f.cell.service!, b = s.binding(f.runtime.session.sessionId)!;
    const item = () => b.host.snapshot().agents[0]!;
    await until(() => item().tasks[0]?.phase === "running" && f.control.providerCalls.some(c => hasUser(c, "CHILD_WORK")), "child provider entered", () => s.diagnostics());
    const child = (await b.runtime.childForView(item().agent.agent_id))!, previous = child.conversation;
    const taskId = item().tasks[0]!.task_id, generation = child.identity.generation, sessionId = child.session.sessionId;
    const notices: string[] = [], ui = child.session.extensionRunner.getUIContext(), disposed = [...f.control.disposed];
    child.session.extensionRunner.setUIContext({ ...ui, notify: text => { notices.push(text); } }, "rpc");
    await assert.rejects(child.session.reload(), /Child SDK reload refused:.*non-terminal Task/);
    assert.match(notices[0]!, /Finish or close.*retry/);
    assert.deepEqual(f.control.disposed, disposed); assert.equal(child.conversation, previous);
    assert.equal(child.session.sessionId, sessionId); assert.equal(child.identity.generation, generation);
    gate.resolve();
    await until(() => item().tasks[0]?.phase === "settled", "reloaded original Task settled", () => ({ item: item(), diagnostics: s.diagnostics() }));
    assert.equal(item().tasks[0]!.task_id, taskId); assert.equal(item().tasks[0]!.outcome, "completed");
    assert.equal(item().completions.length, 1); assert.equal(item().outbox.length, 1);
    assert.equal(f.control.providerCalls.filter(c => hasUser(c, "CHILD_WORK")).length, 1, "reload must not repeat the original child request");
    assert.deepEqual(s.diagnostics(), []);
  } finally { gate.resolve(); await f.close(); }
});

test("refused SDK reload preserves durable cancellation and the earlier fulfilled receipt", { timeout: 60_000 }, async () => {
  const f = await createSdkFixture(), first = deferred(), held = deferred();
  const deliveryEntered = deferred(), deliveryRelease = deferred();
  f.control.responses.set("CHILD_WORK", first.promise); f.control.responses.set("HOLD_CANCEL", held.promise);
  try {
    await f.runtime.session.prompt("SPAWN_NONE");
    const s = f.cell.service!, b = s.binding(f.runtime.session.sessionId)!;
    const item = () => b.host.snapshot().agents[0]!, id = item().agent.agent_id;
    // Hold Task settlement before the pending -> delivering transaction. Main
    // reconcile must enter the same pending Outbox before we release that gate.
    const begin = b.host.beginOutboxDelivery.bind(b.host);
    let begins = 0;
    b.host.beginOutboxDelivery = async input => { begins++; deliveryEntered.resolve(); await deliveryRelease.promise; return begin(input); };
    const caller = { kind: "user" as const, main_session_id: b.mainSessionId, binding_generation: b.bindingGeneration, manager_generation: 1 };
    const entries = (): any[] => readFileSync(join(b.store.mainRoot, item().agent.conversation.relative_path), "utf8").trim().split("\n").map(line => JSON.parse(line));
    await until(() => item().tasks[0]?.phase === "running" && f.control.providerCalls.some(c => hasUser(c, "CHILD_WORK")), "initial request held", () => s.diagnostics());
    await b.runtime.admitViewInput(id, caller, "FIRST_FULFILLED_INPUT"); first.resolve();
    await until(() => item().tasks[0]?.phase === "settled", "first input handled", () => ({ item: item(), diagnostics: s.diagnostics() }));
    await deliveryEntered.promise;
    assert.equal(item().outbox[0]!.state, "pending");
    const reports: unknown[] = [];
    const reconcile = await reconcileMainDeliveryV1({ host: b.host, delivery: b.delivery, mainSessionId: b.mainSessionId, report: value => reports.push(value) });
    assert.deepEqual(reconcile.deferred, [{ outboxId: item().outbox[0]!.outbox_id, reason: "delivering" }]);
    assert.deepEqual(reconcile.failed, []);
    deliveryRelease.resolve();
    assert.deepEqual(reports, [], "concurrent Main reconcile must quietly defer to Task settlement");
    assert.equal(begins, 1, "only one caller may begin the same Outbox delivery");
    b.host.beginOutboxDelivery = begin;
    await until(() => item().outbox[0]?.state === "delivered", "single delivery settled", () => ({ item: item(), diagnostics: s.diagnostics() }));
    assert.equal(item().outbox[0]!.delivery_attempts, 1);
    const completionId = item().completions[0]!.completion_id;
    assert.equal(f.context.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "subagent-completion-v1"
      && (e.details as any)?.completion_id === completionId).length, 1, "one native completion card is delivered");
    assert.equal(f.context.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "subagent-continuation-v1"
      && (e.details as any)?.outbox_id === item().outbox[0]!.outbox_id).length, 1, "one continuation is delivered");
    const earlier = terminals(entries()).filter(t => t.mail.messages.some((m: any) => m.content === "FIRST_FULFILLED_INPUT"));
    assert.equal(earlier.length, 1); assert.equal(earlier[0].evidence.outcome, "fulfilled");
    await b.runtime.admitViewInput(id, caller, "HOLD_CANCEL");
    await until(() => item().tasks[1]?.phase === "running" && f.control.providerCalls.some(c => hasUser(c, "HOLD_CANCEL")), "second request held", () => s.diagnostics());
    const child = (await b.runtime.childForView(id))!, previous = child.conversation, task = item().tasks[1]!;
    await assert.rejects(child.session.reload(), /Child SDK reload refused/); assert.equal(child.conversation, previous);
    await b.runtime.admitViewInput(id, caller, "CANCEL_AFTER_RELOAD");
    await until(() => entries().some(e => e.customType === "subagent-mailbox-intent-v1" && e.data.mail.messages.some((m: any) => m.content === "CANCEL_AFTER_RELOAD")), "actual frozen input intent", () => s.diagnostics());
    await b.runtime.drainControl(id); // complete its durable acceptance before replacing the owner
    const intent = entries().find(e => e.customType === "subagent-mailbox-intent-v1" && e.data.mail.messages.some((m: any) => m.content === "CANCEL_AFTER_RELOAD"));
    await child.cancelTaskMail(task.task_id, task.runtime_generation!);
    // Cancel is a durable transport tombstone; it need not create a fulfilled
    // delivery receipt in the native transcript before its source ACK.
    const transport = JSON.parse(readFileSync(join(f.dir, "mailbox", "v1", child.session.sessionId, "pending.json"), "utf8"));
    const cancelled = transport.terminal.filter((t: any) => t.mail.key === intent.data.mail.key);
    assert.equal(cancelled.length, 1); assert.equal(cancelled[0].evidence.outcome, "cancelled");
    assert.equal(cancelled[0].evidence.scope.sessionId, child.session.sessionId);
    assert.equal(transport.pending.some((m: any) => m.key === intent.data.mail.key), false);
    const closed = await b.host.closeAgent({ request_id: randomUUID(), caller, input: { target: id, force: true } });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(item().tasks[1]!.phase, "settled"); assert.equal(item().tasks[1]!.outcome, "interrupted");
    assert.equal(item().completions.length, 2); assert.equal(item().outbox.length, 2);
    const input = item().mailbox.find(m => m.body === "CANCEL_AFTER_RELOAD")!;
    assert.equal(input.state, "cancelled"); assert.equal(input.consumed_at, undefined);
    const pointer = JSON.parse(readFileSync(join(b.store.mainRoot, "CURRENT"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(b.store.mainRoot, "checkpoints", checkpointDirectoryName(pointer.checkpoint_generation), "manifest.json"), "utf8"));
    const scan = scanJournalV1(readFileSync(join(b.store.mainRoot, "journals", journalFileName(pointer.journal_generation))), manifest.last_journal_sequence, manifest.host_revision,
      { checkpointGeneration: pointer.checkpoint_generation, stateSha256: manifest.state_sha256 });
    assert.equal(scan.status, "valid");
    assert.ok(scan.committed.some(t => t.mutations.some(m => m.type === "put" && m.entity_type === "mailbox" && m.entity_id === input.message_id && (m.value as any).state === "cancelled")));
    assert.deepEqual(terminals(entries()).filter(t => t.mail.key === earlier[0].mail.key), earlier, "already fulfilled receipt is unchanged and unique");
    assert.equal(f.control.providerCalls.some(c => hasUser(c, "CANCEL_AFTER_RELOAD")), false);
    assert.deepEqual(s.diagnostics(), []);
  } finally { deliveryRelease.resolve(); first.resolve(); held.resolve(); await f.close(); }
});

for (const early of [false, true]) test(`parent SDK reload preserves descendant lease (${early ? "parent already settled" : "parent waiting"})`, { timeout: 60_000 }, async () => {
  const f = await createSdkFixture(), leaf = deferred(); f.control.responses.set("HOLD_LEAF", leaf.promise);
  try {
    await f.runtime.session.prompt("SPAWN_NONE");
    const service = f.cell.service!, b = service.binding(f.runtime.session.sessionId)!;
    await until(() => b.host.snapshot().agents[0]?.tasks[0]?.phase === "settled", "seed settled", () => service.diagnostics());
    const result = await service.executor(b.mainSessionId)({ tool: "spawn_agent", toolCallId: "reload-parent", context: f.context,
      params: { task_name: "parent", message: early ? "EARLY_PARENT" : "NESTED_PARENT", fork_turns: "none" } });
    assert.equal(result.details.outcome, "ok", JSON.stringify(result));
    const parent = () => b.host.snapshot().agents.find(a => a.agent.task_name === "parent")!, descendant = () => b.host.snapshot().agents.find(a => a.agent.task_name === "grandchild")!;
    await until(() => parent()?.tasks[0]?.phase === (early ? "settled" : "waiting") && descendant()?.tasks[0]?.phase === "running", "parent and held descendant", () => ({ state: b.host.snapshot(), errors: service.diagnostics() }));
    const child = (await b.runtime.childForView(parent().agent.agent_id))!, original = child.conversation, taskId = parent().tasks[0]!.task_id;
    await child.drain(); await b.runtime.drainControl(parent().agent.agent_id);
    const leases = original.activeLeaseTaskIds(), disposed = [...f.control.disposed]; assert.ok(leases.includes(descendant().tasks[0]!.task_id));
    await assert.rejects(child.session.reload(), early ? /blocking Task lease/ : /non-terminal Task/);
    assert.equal(child.conversation, original); assert.deepEqual(original.activeLeaseTaskIds(), leases); assert.deepEqual(f.control.disposed, disposed);
    leaf.resolve();
    await until(() => parent().tasks[0]!.phase === "settled" && descendant().tasks[0]!.phase === "settled"
      && parent().owner_events.some(e => e.kind === "release_task_lease" && e.state === "acked"), "descendant delivered and lease ACKed", () => ({ state: b.host.snapshot(), errors: service.diagnostics() }));
    await child.drain(); await b.runtime.drainControl(parent().agent.agent_id);
    assert.equal(parent().tasks[0]!.task_id, taskId); assert.equal(parent().completions.length, 1); assert.equal(descendant().completions.length, 1);
    assert.equal(original.activeLeaseTaskIds().length, 0);
    assert.ok(parent().owner_events.some(e => e.kind === "release_task_lease" && e.state === "acked"));
    assert.equal(service.diagnostics().some(d => /lease is absent|session is unavailable/.test(d.message)), false);
    await reloadQuiescent(f, b, parent().agent.agent_id); assert.notEqual(child.conversation, original, "completed Wake/proof history must not block a quiescent reload");
  } finally { leaf.resolve(); await f.close(); }
});

for (const boundary of ["resource-reload", "before-session-start"] as const) test(`native reload failure remains unavailable until explicit close/resume (${boundary})`, { timeout: 60_000 }, async () => {
  const f = await createSdkFixture(); let restore: (() => void) | undefined;
  try {
    await f.runtime.session.prompt("SPAWN_NONE"); const service = f.cell.service!, b = service.binding(f.runtime.session.sessionId)!;
    const item = () => b.host.snapshot().agents[0]!;
    await until(() => item().tasks[0]?.phase === "settled" && item().tasks[0]?.lease_disposition === "released"
      && item().outbox[0]?.turn_settlement?.state === "settled", "seed terminal facts and source settlement complete", () => ({ item: item(), errors: service.diagnostics() }));
    const id = item().agent.agent_id, child = await quiescent(f, b, id), generation = child.identity.generation;
    const tasks = structuredClone(item().tasks), completions = structuredClone(item().completions), outbox = structuredClone(item().outbox);
    const notices: string[] = [], ui = child.session.extensionRunner.getUIContext();
    child.session.extensionRunner.setUIContext({ ...ui, notify: message => { notices.push(message); } }, "rpc");
    const expected = new Error(`controlled native ${boundary} failure`); let nativeAttempts = 0;
    if (boundary === "resource-reload") {
      const loader = child.runtime.services.resourceLoader, original = loader.reload;
      loader.reload = async () => { nativeAttempts++; throw expected; }; restore = () => { loader.reload = original; };
    }
    await assert.rejects(reloadQuiescent(f, b, id, { beforeSessionStart: async () => {
      // The new runner has a new UI binding too; observe that public surface
      // without running any session_start/business initialization.
      child.session.extensionRunner.setUIContext({ ...ui, notify: message => { notices.push(message); } }, "rpc");
      nativeAttempts++; throw expected;
    } }), error => error === expected);
    restore?.(); restore = undefined;
    assert.equal(nativeAttempts, 1); assert.ok(notices.some(message => /reload failed.*close_agent.*resume_agent/.test(message)));
    const calls = f.control.providerCalls.length, disposed = [...f.control.disposed];
    const caller = { kind: "user" as const, main_session_id: b.mainSessionId, binding_generation: b.bindingGeneration, manager_generation: 1 };
    const recovery = /reload failed.*close_agent.*resume_agent/;
    await assert.rejects(b.runtime.admitViewInput(id, caller, "AFTER_FAILED_RELOAD"), recovery);
    for (const result of [await b.host.sendInput({ request_id: randomUUID(), caller, input: { target: id, message: "FAILED_INPUT" } }),
      await b.host.followupTask({ request_id: randomUUID(), caller, input: { target: id, message: "FAILED_FOLLOWUP" } }),
      await b.host.resumeAgent({ request_id: randomUUID(), caller, input: { target: id } })]) {
      assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.error.code, "agent-busy"); assert.match(result.error.message, recovery); }
    }
    const owner = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: child.session.sessionId, agent_id: id }, runtime_generation: generation, owner_request_id: randomUUID() };
    const prepared = await b.host.prepareOwnerTask({ caller: owner, clientOperationId: randomUUID(), kind: "followup", payload: { target: id, message: "FAILED_PREPARE" } });
    const committed = await b.host.commitOwnerTask({ caller: owner, clientOperationId: randomUUID(), preparedToken: "no-new-prepare", taskId: tasks[0]!.task_id,
      lease: { leaseId: "no-new-lease", generation, logicalKey: tasks[0]!.task_id } });
    for (const result of [prepared, committed]) { assert.equal(result.ok, false); if (!result.ok) assert.match(result.error.message, recovery); }
    await assert.rejects(child.session.reload({ beforeSessionStart: async () => { nativeAttempts++; } }), recovery);
    assert.equal(nativeAttempts, 1); assert.deepEqual(f.control.disposed, disposed); assert.equal(f.control.providerCalls.length, calls);
    const listed = await b.host.listAgents({ request_id: randomUUID(), caller, input: {} }); assert.equal(listed.ok, true);
    if (listed.ok) { assert.equal(listed.value.agents[0]!.state, "unavailable"); assert.equal(listed.value.agents[0]!.availability_reason, "runtime-unavailable"); }
    assert.deepEqual(item().tasks, tasks); assert.deepEqual(item().completions, completions); assert.deepEqual(item().outbox, outbox);
    assert.ok(item().tasks.every(task => task.phase === "settled"));
    assert.equal((await b.host.closeAgent({ request_id: randomUUID(), caller, input: { target: id } })).ok, true);
    assert.equal(item().agent.lifecycle, "closed");
    assert.equal((await b.host.resumeAgent({ request_id: randomUUID(), caller, input: { target: id } })).ok, true);
    const fresh = (await b.runtime.childForView(id))!; assert.notEqual(fresh, child); assert.ok(fresh.identity.generation > generation);
    assert.equal(f.control.providerCalls.length, calls, "manual resume is idle");
    await b.runtime.admitViewInput(id, caller, "RECOVERED_EXECUTION");
    await until(() => item().tasks[1]?.phase === "settled", "fresh execution works after manual recovery", () => ({ item: item(), errors: service.diagnostics() }));
    assert.equal(item().tasks[1]!.outcome, "completed"); assert.equal(item().completions.length, 2); assert.equal(item().tasks.length, 2);
    assert.deepEqual(item().tasks[0], tasks[0]); assert.deepEqual(item().completions[0], completions[0]);
    assert.equal(service.diagnostics().some(d => /session is unavailable/.test(d.message)), false);
  } finally { restore?.(); await f.close(); }
});

for (const outcome of ["failed", "succeeded"] as const) test(`replaced execution reload ${outcome} cannot change its successor's reload state`, { timeout: 60_000 }, async () => {
  const f = await createSdkFixture(), entered = deferred(), release = deferred(); let oldReload: Promise<unknown> | undefined;
  try {
    await f.runtime.session.prompt("SPAWN_NONE"); const service = f.cell.service!, b = service.binding(f.runtime.session.sessionId)!;
    const item = () => b.host.snapshot().agents[0]!;
    await until(() => item().tasks[0]?.phase === "settled" && item().tasks[0]?.lease_disposition === "released"
      && item().outbox[0]?.turn_settlement?.state === "settled", "seed fully settled", () => ({ item: item(), errors: service.diagnostics() }));
    const id = item().agent.agent_id, old = await quiescent(f, b, id), original = structuredClone(item());
    const oldFailure = new Error("replaced execution reload failure"), newFailure = new Error("current execution reload failure");
    oldReload = reloadQuiescent(f, b, id, { beforeSessionStart: async () => {
      entered.resolve(); await release.promise; if (outcome === "failed") throw oldFailure;
    } }).then(() => undefined, error => error);
    await entered.promise;
    const caller = { kind: "user" as const, main_session_id: b.mainSessionId, binding_generation: b.bindingGeneration, manager_generation: 1 };
    const close = () => b.host.closeAgent({ request_id: randomUUID(), caller, input: { target: id } });
    const resume = () => b.host.resumeAgent({ request_id: randomUUID(), caller, input: { target: id } });
    const listed = async () => { const result = await b.host.listAgents({ request_id: randomUUID(), caller, input: {} }); assert.equal(result.ok, true); if (!result.ok) throw new Error(JSON.stringify(result)); return result.value.agents[0]!; };
    assert.equal((await close()).ok, true); assert.equal((await resume()).ok, true);
    const fresh = await quiescent(f, b, id); assert.notEqual(fresh, old); assert.ok(fresh.identity.generation > old.identity.generation);
    assert.equal((await listed()).state, "idle");
    const calls = f.control.providerCalls.length;
    if (outcome === "succeeded") {
      await assert.rejects(reloadQuiescent(f, b, id, { beforeSessionStart: async () => { throw newFailure; } }), error => error === newFailure);
      assert.equal((await listed()).state, "unavailable");
    }
    release.resolve(); assert.equal(await oldReload, outcome === "failed" ? oldFailure : undefined);
    assert.deepEqual(item().tasks, original.tasks); assert.deepEqual(item().completions, original.completions); assert.deepEqual(item().outbox, original.outbox);
    assert.equal(f.control.providerCalls.length, calls, "reload completions do not start model work");
    if (outcome === "failed") {
      assert.equal((await listed()).state, "idle", "late failure must not fence the healthy successor");
      assert.equal(service.diagnostics().some(d => d.operation === "child-reload-failed"), false, "retired failure does not diagnose the current execution as failed");
    } else {
      const current = await listed(); assert.equal(current.state, "unavailable"); assert.equal(current.availability_reason, "runtime-unavailable");
      const rejected = await b.host.sendInput({ request_id: randomUUID(), caller, input: { target: id, message: "FAILED_SUCCESSOR_MUST_NOT_RUN" } });
      assert.equal(rejected.ok, false); if (!rejected.ok) assert.match(rejected.error.message, /reload failed.*close_agent.*resume_agent/);
      await assert.rejects(fresh.session.reload(), /reload failed.*close_agent.*resume_agent/);
      assert.equal(item().tasks.length, 1); assert.ok(item().tasks.every(task => task.phase === "settled")); assert.equal(f.control.providerCalls.length, calls);
      assert.equal((await close()).ok, true); assert.equal((await resume()).ok, true);
    }
    await b.runtime.admitViewInput(id, caller, "CURRENT_EXECUTION_WORKS");
    await until(() => item().tasks[1]?.phase === "settled", "current execution finishes exactly one new Task", () => ({ item: item(), errors: service.diagnostics() }));
    assert.equal(item().tasks[1]!.outcome, "completed"); assert.equal(item().tasks.length, 2); assert.equal(item().completions.length, 2);
    assert.deepEqual(item().tasks[0], original.tasks[0]); assert.deepEqual(item().completions[0], original.completions[0]);
    assert.equal(service.diagnostics().some(d => /session is unavailable/.test(d.message)), false);
  } finally { release.resolve(); await oldReload; await f.close(); }
});

test("quiescent SDK reload fences concurrent Task admissions in both queue orders", { timeout: 60_000 }, async () => {
  const f = await createSdkFixture(), entered = deferred(), release = deferred(); let reload: Promise<void> | undefined;
  try {
    await f.runtime.session.prompt("SPAWN_NONE"); const service = f.cell.service!, b = service.binding(f.runtime.session.sessionId)!;
    const item = () => b.host.snapshot().agents[0]!;
    await until(() => item().tasks[0]?.phase === "settled", "seed settled", () => service.diagnostics());
    const child = (await b.runtime.childForView(item().agent.agent_id))!, original = child.conversation, generation = child.identity.generation;
    await child.drain(); await b.runtime.drainControl(item().agent.agent_id);
    reload = reloadQuiescent(f, b, item().agent.agent_id, { beforeSessionStart: async () => { entered.resolve(); await release.promise; } }); await entered.promise;
    const caller = { kind: "user" as const, main_session_id: b.mainSessionId, binding_generation: b.bindingGeneration, manager_generation: 1 };
    const calls = f.control.providerCalls.length;
    const rejected = await b.host.sendInput({ request_id: randomUUID(), caller, input: { target: item().agent.agent_id, message: "RELOAD_RACE_INPUT" } });
    assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "agent-busy");
    const queued = await b.host.followupTask({ request_id: randomUUID(), caller, input: { target: item().agent.agent_id, message: "RELOAD_RACE_QUEUED" } });
    assert.equal(queued.ok, false); if (!queued.ok) assert.equal(queued.error.code, "agent-busy");
    assert.equal(item().tasks.length, 1); assert.equal(f.control.providerCalls.length, calls);
    release.resolve(); await reload; assert.notEqual(child.conversation, original); assert.equal(child.identity.generation, generation);
    const admitted = b.runtime.admitViewInput(item().agent.agent_id, caller, "SLOW_CHILD");
    await assert.rejects(child.session.reload(), /Child SDK reload refused/); await admitted;
    await until(() => item().tasks[1]?.phase === "settled", "admission won, original work settled", () => ({ item: item(), errors: service.diagnostics() }));
    assert.equal(item().tasks.length, 2); assert.equal(item().completions.length, 2); assert.equal(item().tasks[1]!.outcome, "completed");
    assert.equal(f.control.providerCalls.some(c => hasUser(c, "RELOAD_RACE_INPUT") || hasUser(c, "RELOAD_RACE_QUEUED")), false);
  } finally { release.resolve(); await reload?.catch(() => {}); await f.close(); }
});
