import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessAdmissionOwner } from "../local/pi-subagents/src/host/process-admission.ts";
import { createSdkFixture, until } from "../local/pi-subagents/test/fixtures/sdk-runtime.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

// Jiti retains its first cache directory for this process. Keep that isolated
// directory alive across fixtures instead of deleting it between tests.
let scratch: string, previousTmp: string | undefined;
test.before(async () => { previousTmp = process.env.TMPDIR; scratch = await mkdtemp(join(tmpdir(), "processes-task-")); process.env.TMPDIR = scratch; });
test.after(async () => {
  if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
  await rm(scratch, { recursive: true, force: true });
});

// The existing fixture installs real Processes and Subagents. Its only provider
// is faux; Task records, grants, deadlines and child sessions belong to Subagents.
async function ready() {
  const f = await createSdkFixture();
  await f.runtime.session.prompt("SPAWN_NONE");
  const service = f.cell.service!, binding = service.binding(f.runtime.session.sessionId)!;
  service.detach(binding.pi!, binding.mainSessionId);
  const diagnostics = () => ({ agents: binding.host.snapshot().agents, errors: service.diagnostics() });
  await until(() => binding.host.snapshot().agents[0]?.tasks[0]?.phase === "settled", "initial authorized Task", diagnostics);
  const execute = (tool: "spawn_agent" | "close_agent" | "resume_agent" | "send_input", params: unknown) =>
    service.executor(binding.mainSessionId)({ tool, params, toolCallId: randomUUID(), context: f.context });
  return { f, binding, service, diagnostics, execute };
}

test("real Process wait preserves the Task deadline and rechecks cached admission after settlement", { timeout: 60000 }, async () => {
  const { f, binding, service, diagnostics, execute } = await ready();
  const gate = deferred();
  f.control.responses.set("PROCESS_CHILD", gate.promise);
  try {
    assert.equal((await execute("spawn_agent", { task_name: "process", message: "PROCESS_CHILD", task_timeout_ms: 60000 })).details.outcome, "ok");
    const item = () => binding.host.snapshot().agents.find(item => item.agent.task_name === "process")!;
    await until(() => item()?.tasks[0]?.phase === "running" && f.control.childProviderCalls.some(call => call.includes("PROCESS_CHILD")), "child request entered", diagnostics);
    // Compose the production admission factory with the actual durable Task.
    // SDK bridges are execution-local, not entries in the legacy global registry.
    const admission = new ProcessAdmissionOwner({ task: () => item().tasks[0], phase: () => item().tasks[0]!.phase,
      resume: async () => { throw new Error("notification admission must not resume a Task"); },
      requestGrant: () => { throw new Error("running Task already owns its grant"); } });
    const input = { admissionId: randomUUID(), taskId: item().tasks[0]!.task_id, childIdle: false, continuationSignal: false, settledBoundary: false };
    assert.equal(await admission.admit(input), "trigger", "the production factory grants the real running Task");
    const deadline = item().tasks[0]!.deadline_at_ms;
    assert.ok(deadline);
    f.control.responses.delete("PROCESS_CHILD"); gate.resolve();
    await until(() => item().tasks[0]?.phase === "waiting", "real Process parks its Task", diagnostics);
    assert.equal(item().tasks[0]!.waiting_on?.kind, "process");
    assert.equal(item().tasks[0]!.deadline_at_ms, deadline);
    await until(() => item().tasks[0]?.phase === "settled", "real Process completion resumes the same Task", diagnostics);
    assert.equal(item().tasks.length, 1);
    assert.equal(item().tasks[0]!.deadline_at_ms, deadline, "waiting never extends the frozen deadline");
    assert.equal(item().tasks[0]!.outcome, "completed");
    const child = await binding.runtime.childForView(item().agent.agent_id);
    assert.ok(child);
    assert.match(child.session.getLastAssistantText() ?? "", /PROCESS_DONE/);
    const requests = f.control.childProviderCalls.length;
    assert.equal(await admission.admit(input), "record-only", "a cached grant cannot authorize a settled real Task");
    assert.equal(f.control.childProviderCalls.length, requests);
    assert.deepEqual(service.diagnostics(), []);
  } finally { gate.resolve(); await f.close(); }
});

// The Task deadline itself is 60 seconds; the test only has to survive it plus
// fixture setup and cleanup, so the bound stays far above the observed ~61s.
test("an actual Task deadline revokes a cached grant while its real Process is still live", { timeout: 150000 }, async () => {
  const { f, binding, service, diagnostics, execute } = await ready();
  try {
    assert.equal((await execute("spawn_agent", { task_name: "deadline", message: "TIMEOUT_CHILD", task_timeout_ms: 60000 })).details.outcome, "ok");
    const item = () => binding.host.snapshot().agents.find(item => item.agent.task_name === "deadline")!;
    await until(() => item()?.tasks[0]?.phase === "running" && f.control.childProviderCalls.some(call => call.includes("TIMEOUT_CHILD")), "real Task streaming", diagnostics);
    const child = await binding.runtime.childForView(item().agent.agent_id);
    assert.ok(child);
    const admission = new ProcessAdmissionOwner({ task: () => item().tasks[0], phase: () => item().tasks[0]!.phase,
      resume: async () => { throw new Error("notification admission must not resume a Task"); },
      requestGrant: () => { throw new Error("running Task already owns its grant"); } });
    const input = { admissionId: randomUUID(), taskId: item().tasks[0]!.task_id, childIdle: false, continuationSignal: false, settledBoundary: false };
    assert.equal(await admission.admit(input), "trigger");
    // Invoke the actual registered Process tool while the real Task is active.
    // This test-side operation is not presented as a provider-generated tool call.
    const tool = child.session.getToolDefinition("process");
    assert.ok(tool);
    const gate = join(f.dir, "deadline-process-gate");
    const result = await tool.execute(randomUUID(), { action: "start", name: "deadline", command: `while [ ! -f '${gate}' ]; do sleep 0.02; done; printf DEADLINE_PROCESS_DONE`, timeout: 75,
      continuation: { mode: "detached" }, notify: { onSuccess: "turn" } } as never, undefined, undefined,
    { ...child.session.extensionRunner.createContext(), tools: [], executeTool: async () => { throw new Error("Fixture does not execute nested tools"); } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const pgid = (result.details as { data: { process: { pgid: number } } }).data.process.pgid;
    assert.ok(Number.isInteger(pgid) && pgid > 0);
    const deadline = item().tasks[0]!.deadline_at_ms;
    await until(() => item().tasks[0]?.phase === "settled", "real 60-second Task deadline", diagnostics, 120000);
    assert.equal(item().tasks[0]!.deadline_at_ms, deadline);
    assert.equal(item().tasks[0]!.outcome, "failed");
    assert.equal(item().completions[0]!.reason, "timeout");
    assert.equal(await admission.admit(input), "record-only");
    const requests = f.control.childProviderCalls.length;
    assert.doesNotThrow(() => process.kill(-pgid, 0), "the Process outlives the expired Task");
    await writeFile(gate, "release");
    await until(() => {
      try { process.kill(-pgid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    }, "late Process really exits", diagnostics);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.control.childProviderCalls.length, requests, "late Process completion cannot undo the Task deadline");
    assert.equal(item().tasks.length, 1);
    assert.deepEqual(service.diagnostics(), []);
  } finally { await f.close(); }
});

test("real queued Process grant refuses reload and is revoked before a reopened child can run", { timeout: 60000 }, async () => {
  const { f, binding, service, diagnostics, execute } = await ready();
  const busy = deferred();
  f.control.responses.set("HOLD_SLOT", busy.promise);
  try {
    assert.equal((await execute("spawn_agent", { task_name: "waiter", message: "PROCESS_CHILD" })).details.outcome, "ok");
    const item = () => binding.host.snapshot().agents.find(item => item.agent.task_name === "waiter")!;
    await until(() => item()?.tasks[0]?.phase === "waiting", "Process waiter parked", diagnostics);
    const child = await binding.runtime.childForView(item().agent.agent_id);
    assert.ok(child);
    const deadline = item().tasks[0]!.deadline_at_ms;
    binding.scheduler.options.coordinator.updateHostLimits(binding.scheduler.token, { activeTasksPerMain: 1 });
    assert.equal((await execute("spawn_agent", { task_name: "busy", message: "HOLD_SLOT" })).details.outcome, "ok");
    await until(() => binding.host.snapshot().agents.some(partition => partition.agent.task_name === "busy" && partition.tasks[0]?.phase === "running"), "active slot occupied", diagnostics);
    await until(() => binding.scheduler.options.coordinator.snapshot().queuedCount > 0, "real Process exit queued its active-only grant", diagnostics);
    await assert.rejects(child.session.reload(), /Child SDK reload refused:.*non-terminal Task/);
    assert.equal(item().tasks[0]!.deadline_at_ms, deadline);
    const requests = f.control.childProviderCalls.length;
    assert.equal((await execute("close_agent", { target: item().agent.agent_id, force: true })).details.outcome, "ok");
    await until(() => binding.scheduler.options.coordinator.snapshot().queuedCount === 0, "cancellation revokes the queued real Task grant", diagnostics);
    busy.resolve();
    await until(() => item().tasks[0]?.phase === "settled", "cancelled Task settled", diagnostics);
    assert.equal((await execute("resume_agent", { target: item().agent.agent_id })).details.outcome, "ok");
    const reopened = await binding.runtime.childForView(item().agent.agent_id);
    assert.ok(reopened);
    assert.equal(item().tasks.length, 1, "idle recovery cannot create a replacement Task");
    assert.equal(reopened.currentTaskId(), "", "idle recovery owns no Task authority");
    assert.equal(reopened.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "process-notification-batch-v1").length, 0, "the original pending Process intent is never projected into the reopened model context");
    assert.equal(f.control.childProviderCalls.length, requests, "pending recovery and idle resume cannot request another child turn");
    assert.deepEqual(service.diagnostics(), []);
  } finally { busy.resolve(); await f.close(); }
});
