import assert from "node:assert/strict";
import test from "node:test";
import { createSdkFixture, until } from "../fixtures/sdk-runtime.js";

test("view Host admission binds waiting input to the same Task and immediately requests a slot", { timeout: 30_000 }, async () => {
  const fixture = await createSdkFixture();
  let release!: () => void;
  fixture.control.responses.set("DEPTH_TWO", new Promise<void>(resolve => { release = resolve; }));
  try {
    await fixture.runtime.session.prompt("SPAWN_NONE");
    const service = fixture.cell.service!, mainId = fixture.runtime.session.sessionId, binding = service.binding(mainId)!;
    const spawned = await service.executor(mainId)({ tool: "spawn_agent", toolCallId: "view-wait", context: fixture.context,
      params: { task_name: "view_wait", message: "NESTED_PARENT", fork_turns: "none" } });
    assert.equal(spawned.details.outcome, "ok", JSON.stringify(spawned));
    const parent = () => binding.host.snapshot().agents.find(item => item.agent.task_name === "view_wait")!;
    await until(() => parent()?.tasks[0]?.phase === "waiting", "parent waiting", () => binding.host.snapshot());
    const waiting = structuredClone(parent().tasks[0]!);
    assert.ok("admitViewInput" in binding.runtime);
    await binding.runtime.admitViewInput(parent().agent.agent_id, { kind: "user", main_session_id: mainId,
      binding_generation: binding.bindingGeneration, manager_generation: 1 }, "WAIT_INPUT");
    const queued = parent();
    assert.equal(queued.tasks.length, 1);
    assert.equal(queued.tasks[0]!.phase, "waiting");
    assert.equal(queued.tasks[0]!.task_id, waiting.task_id);
    assert.equal(queued.tasks[0]!.runtime_generation, waiting.runtime_generation);
    assert.equal(queued.tasks[0]!.deadline_at_ms, waiting.deadline_at_ms);
    assert.deepEqual(queued.tasks[0]!.waiting_on, waiting.waiting_on);
    assert.ok(queued.mailbox.some(mail => mail.body === "WAIT_INPUT" && mail.task_id === waiting.task_id));
    release();
    await until(() => parent().tasks.every(task => task.phase === "settled"), "same Task settles", () => binding.host.snapshot());
    assert.ok(parent().tasks.every(task => task.outcome === "completed"), JSON.stringify({parent: parent(), errors: service.diagnostics()}));
  } finally { release(); await fixture.close(); }
});
