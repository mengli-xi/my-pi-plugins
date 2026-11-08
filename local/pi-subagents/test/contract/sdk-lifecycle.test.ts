import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";

async function ready(fixture: Awaited<ReturnType<typeof createSdkFixture>>) {
  await fixture.runtime.session.prompt("SPAWN_NONE");
  const service = fixture.cell.service!, mainId = fixture.runtime.session.sessionId, binding = service.binding(mainId)!;
  service.detach(binding.pi!, mainId);
  const diagnostics = () => ({ errors: service.diagnostics(), agents: binding.host.snapshot().agents });
  await until(() => binding.host.snapshot().agents[0]?.tasks[0]?.phase === "settled", "initial Task", diagnostics);
  return { service, binding, diagnostics, execute: (tool: "spawn_agent" | "send_input", params: unknown) => service.executor(mainId)({ tool, toolCallId: tool, params, context: fixture.context }) };
}

for (const boundary of ["apply-before", "apply-after", "ack"] as const) test(`P1-1: release receipt survives ${boundary} failure`, async () => {
  const fixture = await createSdkFixture();
  try {
    const { binding, execute, diagnostics } = await ready(fixture);
    let injected = false;
    const apply = binding.host.persistOwnerEventApplication.bind(binding.host);
    binding.host.persistOwnerEventApplication = async input => {
      if (!injected && boundary !== "ack" && input.result.kind === "settled_task_release_result") {
        injected = true; if (boundary === "apply-after") assert.equal((await apply(input)).ok, true);
        throw new Error(`transient ${boundary}`);
      }
      return apply(input);
    };
    const ack = binding.host.ackOwnerEvents.bind(binding.host);
    binding.host.ackOwnerEvents = async input => {
      const event = binding.host.snapshot().agents.flatMap(item => item.owner_events).find(event => event.target.agent_id === input.caller.conversation.agent_id && event.event_sequence === input.eventSequence);
      if (!injected && boundary === "ack" && event?.kind === "release_task_lease") { injected = true; throw new Error("transient ACK"); }
      return ack(input);
    };
    assert.equal((await execute("spawn_agent", { task_name: "parent", message: "NESTED_PARENT" })).details.outcome, "ok");
    await until(() => injected, "receipt fault", diagnostics);
    const parent = binding.host.snapshot().agents.find(item => item.agent.task_name === "parent")!;
    await until(() => diagnostics().errors.some(error => error.message.includes("transient")), "fault reported", diagnostics);
    await binding.runtime.flushAgent(parent.agent.agent_id);
    await until(() => binding.host.snapshot().agents.find(item => item.agent.agent_id === parent.agent.agent_id)?.tasks[0]?.phase === "settled", "parent resumed", diagnostics);
    const child = binding.host.snapshot().agents.find(item => item.agent.task_name === "grandchild")!;
    assert.equal(child.tasks[0]!.lease_disposition, "released");
    const state = binding.host.snapshot(), partitions = [state.root, ...state.agents];
    const outbox = partitions.flatMap(item => item.outbox).find(item => item.completion_ids.includes(child.tasks[0]!.completion_id!))!;
    assert.equal(outbox.wake_epoch, 1); assert.equal(outbox.state, "delivered");
    assert.equal(partitions.flatMap(item => item.wake_receipts).filter(receipt => receipt.outbox_id === outbox.outbox_id).length, 1);
    assert.equal(binding.host.snapshot().agents.find(item => item.agent.agent_id === parent.agent.agent_id)!.owner_events.every(event => event.state === "acked"), true);
  } finally { await fixture.close(); }
});

test("P1-2: quit waits for assembling children and disposes before returning", async () => {
  const fixture = await createSdkFixture(); let release!: () => void;
  fixture.control.assemblyGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await fixture.runtime.session.prompt("SPAWN_NONE");
    await until(() => fixture.control.started.length === 1, "child entered assembly", () => fixture.cell.service?.diagnostics());
    const service = fixture.cell.service!;
    let closed = false; const quit = fixture.disposeMain().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(closed, false);
    release(); await quit;
    assert.deepEqual(fixture.control.disposed, fixture.control.started);
    assert.equal(service.coordinatorClaim.coordinator.snapshot().residents.length, 0);
    assert.equal(service.coordinatorClaim.coordinator.snapshot().grants.length, 0);
    assert.deepEqual(service.diagnostics(), []);
  } finally { release(); await fixture.close(); }
});

test("P1-3: busy quit drains native tool results and all shell descendants", async () => {
  const fixture = await createSdkFixture();
  try {
    const { binding, execute, diagnostics } = await ready(fixture);
    assert.equal((await execute("spawn_agent", { task_name: "bash", message: "ABORT_CHILD" })).details.outcome, "ok");
    let descendant = 0;
    for (let attempt = 0; attempt < 500 && !descendant; attempt++) { try { descendant = Number(await readFile(join(fixture.dir, "bash-child.pid"), "utf8")); } catch {} if (!descendant) await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(descendant > 1, JSON.stringify(diagnostics()));
    const agent = binding.host.snapshot().agents.find(item => item.agent.task_name === "bash")!;
    await fixture.disposeMain();
    const entries = (await readFile(join(binding.store.mainRoot, agent.agent.conversation.relative_path), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const calls = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : []).filter(block => block.type === "toolCall" && block.name === "bash");
    const results = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bash");
    assert.equal(calls.length, 1); assert.equal(results.length, 1); assert.equal(results[0].message.toolCallId, calls[0].id);
    await until(() => { try { process.kill(descendant, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }, "no descendant", diagnostics);
  } finally { await fixture.close(); }
});

test("P1-3: quit also fences a prompt still awaiting public input preflight", async () => {
  const fixture = await createSdkFixture(); let release!: () => void;
  fixture.control.inputGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await fixture.runtime.session.prompt("SPAWN_NONE");
    const service = fixture.cell.service!, binding = service.binding(fixture.runtime.session.sessionId)!;
    await until(() => fixture.control.inputEntered.length === 1, "child prompt preflight", () => service.diagnostics());
    let closed = false; const quit = fixture.disposeMain().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(closed, false);
    release(); await quit;
    assert.deepEqual(fixture.control.disposed, fixture.control.started);
    assert.equal(binding.host.snapshot().agents[0]!.tasks[0]!.phase, "settled");
    assert.deepEqual(service.diagnostics(), []);
  } finally { release(); await fixture.close(); }
});

test("P1-4: an old deferred interrupt cannot abort the next resident Task", async () => {
  const fixture = await createSdkFixture(); const realTimeout = globalThis.setTimeout;
  let release!: () => void; fixture.control.responses.set("HOLD_A", new Promise<void>(resolve => { release = resolve; }));
  try {
    const { binding, execute, diagnostics } = await ready(fixture);
    const id = binding.host.snapshot().agents[0]!.agent.agent_id;
    await execute("send_input", { target: id, message: "HOLD_A" });
    await until(() => binding.host.snapshot().agents[0]?.tasks[1]?.phase === "running", "A running", diagnostics);
    await binding.host.followupTask({ request_id: (await import("node:crypto")).randomUUID(), caller: { kind: "main-model", conversation: { kind: "main", session_id: binding.mainSessionId }, binding_generation: binding.bindingGeneration }, input: { target: id, message: "TIMEOUT_CHILD" } });
    const callbacks: (() => void)[] = [], interrupt = binding.runtime.interrupt.bind(binding.runtime);
    binding.runtime.interrupt = (input: Parameters<typeof interrupt>[0]) => {
      globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
        if (ms === 0) { callbacks.push(() => callback(...args)); return realTimeout(() => {}, 1); }
        return realTimeout(callback, ms, ...args);
      }) as typeof setTimeout;
      try { return interrupt(input); } finally { globalThis.setTimeout = realTimeout; }
    };
    await binding.runtime.requestInterrupt(id); binding.runtime.interrupt = interrupt;
    assert.equal(callbacks.length, 1);
    assert.ok(binding.host.snapshot().agents[0]!.tasks[1]!.interrupt_requested_at); release();
    await until(() => binding.host.snapshot().agents[0]?.tasks[2]?.phase === "running", "B running", diagnostics);
    callbacks[0]!(); await new Promise(resolve => realTimeout(resolve, 50));
    const tasks = binding.host.snapshot().agents[0]!.tasks;
    assert.equal(tasks[1]!.reason, "user-interrupt"); assert.equal(tasks[2]!.phase, "running"); assert.equal(tasks[2]!.interrupt_requested_at, undefined);
  } finally { release(); globalThis.setTimeout = realTimeout; await fixture.close(); }
});

test("P1-5: final child receipt releases the completed parent's control pin", async () => {
  const fixture = await createSdkFixture();
  let release!: () => void; fixture.control.responses.set("HOLD_LEAF", new Promise<void>(resolve => { release = resolve; }));
  try {
    const { binding, service, execute, diagnostics } = await ready(fixture);
    assert.equal((await execute("spawn_agent", { task_name: "parent", message: "EARLY_PARENT" })).details.outcome, "ok");
    await until(() => binding.host.snapshot().agents.find(item => item.agent.task_name === "parent")?.tasks[0]?.phase === "settled", "parent finished while child runs", diagnostics);
    const parent = binding.host.snapshot().agents.find(item => item.agent.task_name === "parent")!;
    assert.equal(service.coordinatorClaim.coordinator.snapshot().residents.find(item => item.agentId === parent.agent.agent_id)?.state, "control-pinned");
    release();
    await until(() => binding.host.snapshot().agents.find(item => item.agent.task_name === "grandchild")?.outbox[0]?.state === "delivered", "child delivered", diagnostics);
    await until(() => { const resident = service.coordinatorClaim.coordinator.snapshot().residents.find(item => item.agentId === parent.agent.agent_id); return !resident || resident.state === "idle"; }, "control pin released", diagnostics);
  } finally { release(); await fixture.close(); }
});
