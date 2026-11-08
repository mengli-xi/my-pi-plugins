import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";

async function ready() {
  const fixture = await createSdkFixture();
  await fixture.runtime.session.prompt("SPAWN_NONE");
  const binding = fixture.cell.service!.binding(fixture.runtime.session.sessionId)!;
  const agentId=binding.host.snapshot().agents[0]!.agent.agent_id;
  const item = () => binding.host.snapshot().agents.find(item=>item.agent.agent_id===agentId)!;
  await until(() => item().tasks[0]?.phase === "settled", "initial completion", () => binding.host.snapshot());
  await until(() => fixture.runtime.session.isIdle && item().outbox.every(outbox=>outbox.state==="delivered"), "Main delivery idle", () => binding.host.snapshot());
  const caller = { kind: "user" as const, main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 };
  return { fixture, binding, item, caller };
}

test("view immediate keeps Task/owner/deadline; after-current is FIFO user Tasks; retry is durable", { timeout: 60000 }, async () => {
  const { fixture, binding, item, caller } = await ready(); let release!: () => void;
  fixture.control.responses.set("HOLD_VIEW", new Promise<void>(resolve => { release = resolve; }));
  try {
    const id = item().agent.agent_id, request = randomUUID();
    const first = await binding.runtime.admitViewInput(id, caller, "HOLD_VIEW", "immediate", request);
    assert.deepEqual(await binding.runtime.admitViewInput(id, caller, "HOLD_VIEW", "immediate", request), first);
    await until(() => item().tasks[1]?.phase === "running", "current running", () => item());
    const before = structuredClone(item().tasks[1]!);
    const steer = await binding.runtime.admitViewInput(id, caller, "VIEW_STEER");
    assert.equal(steer.task_id, before.task_id); assert.equal(steer.disposition, "steer");
    const next = await binding.runtime.admitViewInput(id, caller, "FIFO_VIEW_A", "after-current");
    const last = await binding.runtime.admitViewInput(id, caller, "FIFO_VIEW_B", "after-current");
    assert.deepEqual(item().agent.queued_task_ids, [next.task_id, last.task_id]);
    assert.deepEqual(item().tasks[1]!.owner_conversation, before.owner_conversation);
    assert.equal(item().tasks[1]!.deadline_at_ms, before.deadline_at_ms); assert.equal(item().tasks.length, 4);
    release(); await until(() => item().tasks.every(task => task.phase === "settled"), "all user work", () => item());
    assert.equal(item().completions.length, 4); assert.equal(item().mailbox.filter(mail => mail.body === "VIEW_STEER").length, 1);
    assert.ok(item().tasks.slice(1).every(task => task.initiator.kind === "user" && task.owner_conversation.kind === "main"));
    const settledId = item().tasks.at(-1)!.task_id;
    const later = await binding.runtime.admitViewInput(id, caller, "SETTLE_FIRST"); assert.notEqual(later.task_id, settledId);
    await until(() => item().tasks.at(-1)?.phase === "settled", "later Task", () => item());
  } finally { release(); await fixture.close(); }
});

test("starting view input binds first Task before assembly completes", { timeout: 60000 }, async () => {
  const fixture = await createSdkFixture(); let release!: () => void;
  fixture.control.assemblyGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await fixture.runtime.session.prompt("SPAWN_NONE"); const binding = fixture.cell.service!.binding(fixture.runtime.session.sessionId)!;
    const item = () => binding.host.snapshot().agents[0]!;
    await until(() => fixture.control.started.length === 1, "assembly blocked", () => item());
    const task = item().tasks[0]!, id = item().agent.agent_id;
    const result = await binding.runtime.admitViewInput(id, { kind: "user", main_session_id: binding.mainSessionId, binding_generation: binding.bindingGeneration, manager_generation: 1 }, "STARTING_VIEW_INPUT");
    assert.equal(result.task_id, task.task_id); assert.equal(item().tasks.length, 1);
    const queued=await binding.runtime.admitViewInput(id,{kind:"user",main_session_id:binding.mainSessionId,binding_generation:binding.bindingGeneration,manager_generation:1},"STARTING_ALT","after-current");
    assert.notEqual(queued.task_id,task.task_id);assert.equal(item().tasks.length,2);assert.deepEqual(item().agent.queued_task_ids,[queued.task_id]);
    release(); await until(() => item().tasks.every(task=>task.phase === "settled"), "first Task and queued Alt input", () => item());
    assert.equal(item().completions.length, 2); assert.ok(item().mailbox.every(mail => mail.state === "injected"));
  } finally { release(); await fixture.close(); }
});

test("closed Enter/Alt+Enter reject with zero requests; resume stays idle until Enter", { timeout: 60000 }, async () => {
  const { fixture, binding, item, caller } = await ready();
  try {
    const id = item().agent.agent_id;
    assert.equal((await binding.host.closeAgent({ request_id: randomUUID(), caller, input: { target: id } })).ok, true);
    const calls = fixture.control.childProviderCalls.length;
    for (const intent of ["immediate", "after-current"] as const) await assert.rejects(binding.runtime.admitViewInput(id, caller, "CLOSED_DRAFT", intent));
    assert.equal(fixture.control.childProviderCalls.length, calls); assert.equal(item().tasks.length, 1);
    assert.equal((await binding.host.resumeAgent({ request_id: randomUUID(), caller, input: { target: id } })).ok, true);
    assert.equal(item().agent.lifecycle, "open"); assert.equal(item().agent.current_task_id, undefined);
    assert.equal(fixture.control.childProviderCalls.length, calls); assert.equal(item().tasks.length, 1);
    await binding.runtime.admitViewInput(id, caller, "RESUMED_ENTER");
    await until(() => item().tasks[1]?.phase === "settled", "explicit Enter", () => item()); assert.equal(item().tasks[1]!.initiator.kind, "user");
  } finally { await fixture.close(); }
});

for (const ending of ["force-close", "timeout", "shutdown"] as const) test(`view accepted input races ${ending} without re-admission`, { timeout: 60000 }, async () => {
  const { fixture, binding, item, caller } = await ready(); let release!: () => void;
  fixture.control.responses.set("HOLD_CANCEL", new Promise<void>(resolve => { release = resolve; }));
  try {
    const id = item().agent.agent_id;
    await binding.runtime.admitViewInput(id, caller, "HOLD_CANCEL");
    await until(() => item().tasks.at(-1)?.phase === "running", "cancel Task", () => item());
    const task = item().tasks.at(-1)!, request = randomUUID();
    const receipt = await binding.runtime.admitViewInput(id, caller, "INPUT_BEFORE_CANCEL", "immediate", request);
    if (ending === "force-close") await binding.host.closeAgent({ request_id: randomUUID(), caller, input: { target: id, force: true } });
    if (ending === "timeout") {
      assert.equal((await binding.host.requestTaskTimeout({ agentId: id, taskId: task.task_id, runtimeGeneration: task.runtime_generation!, at: new Date(task.deadline_at_ms! + 1).toISOString() })).ok, true);
      await binding.runtime.interrupt({ agentId: id, taskId: task.task_id, runtimeGeneration: task.runtime_generation! });
    }
    if (ending === "shutdown") await fixture.disposeMain();
    release(); await until(() => item().tasks.at(-1)?.phase === "settled", "cancel settled", () => item());
    assert.equal(item().tasks.length, 2); assert.equal(item().completions.length, 2);
    assert.equal(item().tasks.at(-1)!.outcome, ending === "timeout" ? "failed" : "interrupted");
    if (ending !== "shutdown") assert.deepEqual(await binding.runtime.admitViewInput(id, caller, "INPUT_BEFORE_CANCEL", "immediate", request), receipt);
    assert.equal(item().tasks.length, 2); assert.equal(item().mailbox.filter(mail => mail.body === "INPUT_BEFORE_CANCEL").length, 1);
  } finally { release(); await fixture.close(); }
});

test("view input during native compaction is admitted once and waits for compaction_end", { timeout: 60000 }, async () => {
  const { fixture, binding, item, caller } = await ready(); let release!: () => void;
  fixture.control.responses.set("structured context checkpoint", new Promise<void>(resolve => { release = resolve; }));
  try {
    const id = item().agent.agent_id, child = await binding.runtime.childForView(id); assert.ok(child);
    const compact = child.session.compact();
    await until(() => child.session.isCompacting, "native compaction", () => item());
    const accepted = await binding.runtime.admitViewInput(id, caller, "COMPACT_VIEW_INPUT");
    assert.equal(item().tasks.at(-1)!.task_id, accepted.task_id); assert.equal(item().tasks.length, 2);
    release(); await compact;
    await until(() => item().tasks.at(-1)?.phase === "settled", "input after compact", () => ({ item: item(), errors: fixture.cell.service?.diagnostics() }));
    assert.equal(item().completions.length, 2); assert.equal(item().tasks.at(-1)!.outcome, "completed");
  } finally { release(); await fixture.close(); }
});

test("view-loaded receipt clears only produced completions; received descendant results need an exact click",{timeout:60000},async()=>{
 const {fixture,binding,item,caller}=await ready();
 try{
  const id=item().agent.agent_id;await binding.runtime.markViewLoaded(id);
  assert.ok(binding.host.snapshot().root.inbox.every(inbox=>inbox.ui_read_at));
  await binding.runtime.admitViewInput(id,caller,"NESTED_PARENT");
  await until(()=>item().tasks[1]?.phase==="settled"&&item().inbox.every(inbox=>inbox.state==="appended"),"nested complete",()=>binding.host.snapshot());
  const received=item().inbox[0]!;assert.equal(received.ui_read_at,undefined);
  await until(()=>item().outbox.every(outbox=>outbox.state==="delivered"),"own completion appended",()=>binding.host.snapshot());
  await binding.runtime.markViewLoaded(id);
  assert.equal(item().inbox[0]!.ui_read_at,undefined);assert.ok(binding.host.snapshot().root.inbox.every(inbox=>inbox.ui_read_at));
  await binding.runtime.markClickedInbox({inbox_id:received.inbox_id,completion_id:received.completion_id,projection_sha256:received.projection.projection_sha256},received.projection.content);
  assert.ok(item().inbox[0]!.ui_read_at);
 }finally{await fixture.close();}
});
