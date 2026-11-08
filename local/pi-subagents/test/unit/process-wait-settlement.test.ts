import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChildSession } from "../../src/runtime/child-session.js";
import { ChildProcessWaitAdmissionV2 } from "../../src/child/process-wait-admission.js";
import type { ChildHostPort } from "../../src/runtime/child-tools.js";
import { canonicalDeliveryJsonV1 } from "../../src/persistence/canonical.js";
import { encodeDomainId } from "../../src/domain/ids.js";
import { SdkRuntimeControllerV1 } from "../../src/runtime/sdk-controller.js";
import type { AgentHostCoreV1 } from "../../src/host/core.js";

const agentId = encodeDomainId("agt", Buffer.alloc(16, 71));
const taskId = encodeDomainId("tsk", Buffer.alloc(16, 72));
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const START = "2027-03-01T00:00:00.000Z";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
async function waitFor(predicate: () => boolean): Promise<void> { const deadline = Date.now() + 2_000; while (!predicate()) { if (Date.now() > deadline) throw new Error("test wait timed out"); await new Promise((resolve) => setTimeout(resolve, 1)); } }
function uuid(index: number): string { return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; }

async function fixture(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const mainRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-wait-"))); await chmod(mainRoot, 0o700);
  const relative = `conversations/${agentId}/session.jsonl`;
  await mkdir(join(mainRoot, "conversations", agentId), { recursive: true, mode: 0o700 });
  const sessionFile = join(mainRoot, relative);
  await writeFile(sessionFile, `${[
    JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: START, cwd: mainRoot }),
    JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: START, message: { role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.parse(START) } }),
    JSON.stringify({ type: "message", id: "a", parentId: "u", timestamp: "2027-03-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "final answer" }], api: "x", provider: "p", model: "m", usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }, stopReason: "stop", timestamp: Date.parse(START) + 1_000 } }),
  ].join("\n")}\n`, { mode: 0o600 });
  t.after(() => rm(mainRoot, { recursive: true, force: true }));

  let task: Record<string, unknown> = { task_id: taskId, agent_id: agentId, phase: "admitted", runtime_generation: 1, admission_order: 7, started_at: START, message: "work", usage_baseline: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 }, ...overrides };
  const hostCalls: string[] = []; const settlements: Record<string, unknown>[] = []; const releases: Record<string, unknown>[] = []; const transitions: Record<string, unknown>[] = []; const retired: Record<string, unknown>[] = []; const activeRequests: Record<string, unknown>[] = [];
  const calls: { type: string; payload: Readonly<Record<string, unknown>> }[] = [];
  const ok = (value: Record<string, unknown>) => ({ ok: true as const, host_revision: 9, value });
  let ownerEvents: Record<string, unknown>[] = []; let sentOwnerEvents = 0; const settleRejections: string[] = [];
  const snapshot = () => ({ root: { outbox: [] }, agents: [{ agent: { lifecycle: "open", agent_id: agentId, task_path: "/root/worker", profile: { system_prompt_relative_path: "prompt" }, conversation: { relative_path: relative, session_id: "child-session" }, ...(task.phase === "settled" ? {} : { current_task_id: taskId }) }, tasks: [{ ...task }], mailbox: [], outbox: [], owner_events: ownerEvents.map((event) => ({ ...event })) }] });
  const host = {
    host_revision: 9, main_session_id: "main",
    options: { store: { mainRoot } },
    snapshot,
    async startTask() { hostCalls.push("start"); task = { ...task, phase: "starting" }; return ok({ started: true, deadline_at_ms: 1 }); },
    async recordUsageBaseline() { hostCalls.push("baseline"); return ok({ recorded: true }); },
    async markTaskRunning() { hostCalls.push("running"); task = { ...task, phase: "running" }; return ok({ running: true }); },
    async finishWaitingActivation() { delete task.activation_order; return ok({ waiting: true }); },
    async resumeWaitingTask() { hostCalls.push("resume"); const { waiting_on: _waiting, ...rest } = task; task = { ...rest, phase: "running" }; return ok({ running: true }); },
    async recordProcessWaitState(input: { blocking: readonly unknown[] }) { hostCalls.push("process-wait"); if (input.blocking.length === 0) return ok({ waiting: task.phase === "waiting" }); task = { ...task, phase: "waiting", waiting_on: { kind: "process", key: hex("wait") } }; return ok({ waiting: true }); },
    async settleTask(input: Record<string, unknown>) { const rejection = settleRejections.shift(); if (rejection !== undefined) { hostCalls.push("settle-rejected"); return { ok: false as const, host_revision: 9, error: { version: 1, code: "storage-capacity", message: rejection, retryable: false, current_host_revision: 9 } }; } hostCalls.push("settle"); settlements.push(input); task = { ...task, phase: "settled" }; return ok({ completion_id: "cmp_test", recipient: { kind: "main", session_id: "main" } }); },
    async recordFinishDeclaration(input: { declaration: Record<string, unknown> }) { hostCalls.push("finish"); task = { ...task, finish_declaration: input.declaration }; return ok({ recorded: true }); },
    async sendOwnerEvents() { const pending = ownerEvents.filter((event) => event.state === "pending"); sentOwnerEvents += pending.length; ownerEvents = ownerEvents.map((event) => ({ ...event, state: "sent" })); return ok({ events: pending.map((event) => ({ ...event, state: "sent" })) }); },
    async resetSentOwnerEvents() { return ok({ reset: 0 }); },
    async ackOwnerEvents() { ownerEvents = []; return ok({ acked: true }); },
    async persistOwnerEventApplication() { return ok({ persisted: true }); },
    async synthesizeMailboxDelivery() { return ok({}); },
    async synthesizeCompletionDelivery() { return ok({}); },
    async synthesizeSettledLeaseRelease() { return ok({}); },
  } as unknown as AgentHostCoreV1;

  let port!: ChildHostPort;
  let resolveAssembly!: () => void;
  const assemblyGate = new Promise<void>(resolve => { resolveAssembly = resolve; });
  let pauseAssembly = false;
  const original = ChildSession.create;
  const childOperations = { drain: async () => {}, interrupt: async () => {}, dispose: async () => {}, cancelProcessAdmission: (_taskId: string, _generation: number) => {} };
  ChildSession.create = async input => {
    port = input.host; calls.push({ type: "assemble", payload: {} });
    if (pauseAssembly) await assemblyGate;
    return { conversation: { appendMailboxMessages: async (items: any[]) => items.map(item => ({ messageId: item.messageId, bodySha256: item.bodySha256, entryId: "entry", state: "injected", injectedInto: item.injectedInto })) },
      cancelTaskMail: async () => {}, preflight: async () => {}, deliver: async () => {}, resumeFromCompletions: async () => { calls.push({ type: "recheck", payload: {} }); },
      drain: () => childOperations.drain(), interrupt: () => childOperations.interrupt(), dispose: () => childOperations.dispose(),
      cancelProcessAdmission: (taskId: string, generation: number) => childOperations.cancelProcessAdmission(taskId, generation), session: { isCompacting: false } } as unknown as ChildSession;
  };
  const errors: unknown[] = [];
  const runtime = new SdkRuntimeControllerV1({ host, agentDir: mainRoot, skillPath: "skill", taskTimeoutMs: 1_800_000,
    settings: () => ({}), registry: () => ({}) as never, reportOperationalError: ({ error }) => errors.push(error),
    scheduler: { requestActive: input => { activeRequests.push(input as never); }, confirmRuntime() { hostCalls.push("confirm"); },
      releaseGrant: input => { releases.push(input as never); }, transitionResident: input => { transitions.push(input as never); }, retireResident: input => { retired.push(input as never); } },
  });
  t.after(() => { resolveAssembly(); runtime.deadlines.dispose(); ChildSession.create = original; });
  const controller = {
    start: runtime.start.bind(runtime), flushAgent: async (id: typeof agentId) => { const result = await runtime.flushAgent(id); await tick(); return result; },
    interrupt: async (input: any) => { await runtime.interrupt(input); await waitFor(() => task.phase === "settled"); },
    requestProcessResume: (input: any) => port.processAdmission(input),
  };
  const ownerRequest = async (type: string, payload: Record<string, any>): Promise<Record<string, any>> => {
    let result: any;
    if (type === "process_wait_state") result = await port.recordProcessWait(payload as never);
    else if (type === "resume_process_wait") result = { admission: await port.processAdmission(payload as never) };
    else if (type === "task_settled") result = await port.settled({ taskId, aborted: false, sessionFile });
    else if (type === "finish_task") result = await port.tools.finish(payload);
    else throw new Error(type);
    await tick(); return { ok: true, result };
  };
  const reachRunning = () => controller.start({ grantId: "grant-1", coordinatorGeneration: 1, agentId, taskId, runtimeGeneration: 1 });
  const setOwnerEvents = (value: Record<string, any>[]) => {
    ownerEvents = value.map(event => {
      const payload = JSON.parse(event.payload_json);
      payload.items = payload.items.map((item: any) => ({ ...item, body: "note", bodySha256: hex("note") }));
      payload.chunkSha256 = hex(canonicalDeliveryJsonV1(payload.items));
      return { ...event, payload_json: JSON.stringify(payload), payload_sha256: hex(canonicalDeliveryJsonV1(payload)) };
    });
  };
  return { controller, runtime, childOperations, calls, hostCalls, settlements, releases, transitions, retired, activeRequests, ownerRequest, reachRunning,
    setOwnerEvents, get sentOwnerEvents() { return sentOwnerEvents; }, currentTask: () => task, patchTask: (patch: Record<string, unknown>) => { task = { ...task, ...patch }; },
    pauseAssembly: () => { pauseAssembly = true; }, resolveAssembly, errors, rejectNextSettle: (message: string) => { settleRejections.push(message); }, shutdownChild: () => port.shutdown() };

}

for (const activated of [false, true]) test(`same-Task Process recovery grants before the old run drains (activated=${activated})`, { timeout: 2_000 }, async t => {
  const f = await fixture(t); await f.reachRunning();
  await f.ownerRequest("process_wait_state", { taskId, blocking: [{ leaseId: "lease-queue", generation: 1, logicalKey: "proc" }] });
  await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  if (activated) f.patchTask({ activation_order: 8 });
  const child = new ChildProcessWaitAdmissionV2({ currentTaskId: () => taskId, childIdle: () => true,
    request: input => f.controller.requestProcessResume(input), report(error) { throw error; } });
  const pending = child.admit("batch-drain", true), settled = child.beforeTaskSettlement(taskId);
  f.childOperations.drain = async () => { assert.equal(await pending, "trigger"); assert.equal(await settled, true); };
  await f.controller.start({ grantId: "grant-queue", coordinatorGeneration: 1, agentId, taskId, runtimeGeneration: 1, residency: "existing" });
  assert.equal(f.currentTask().task_id, taskId); assert.equal(f.currentTask().runtime_generation, 1);
  assert.equal(f.currentTask().phase, "running"); assert.equal(f.settlements.length, 0);
  assert.equal(f.hostCalls.filter(call => call === "resume").length, 1);
});

for (const mode of ["interrupt", "deadline", "force-close", "failure"] as const) test(`${mode} releases Host and child admission before native abort/drain`, { timeout: 2_000 }, async t => {
  const f = await fixture(t); await f.reachRunning();
  await f.ownerRequest("process_wait_state", { taskId, blocking: [{ leaseId: "lease-cancel", generation: 1, logicalKey: "proc" }] });
  await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  const order: string[] = [];
  const child = new ChildProcessWaitAdmissionV2({ currentTaskId: () => taskId, childIdle: () => true,
    request: input => f.controller.requestProcessResume(input), report(error) { throw error; } });
  const pending = child.admit("batch-cancel", true), settled = child.beforeTaskSettlement(taskId);
  f.childOperations.cancelProcessAdmission = (id, generation) => { assert.equal(id, taskId); assert.equal(generation, 1); order.push("cancel"); child.cancel(id); };
  f.childOperations.interrupt = f.childOperations.dispose = async () => {
    order.push("native"); assert.equal(await pending, "record-only"); assert.equal(await settled, false);
  };
  if (mode === "force-close") await f.runtime.closeAgent(agentId);
  else if (mode === "failure") { f.shutdownChild(); await waitFor(() => f.settlements.length === 1); }
  else {
    f.patchTask({ interrupt_requested_at: START, interrupt_generation: 1, ...(mode === "deadline" ? { deadline_at_ms: Date.now() - 1 } : {}) });
    if (mode === "deadline") await f.runtime.deadlines.expired({ agentId, taskId, runtimeGeneration: 1 });
    else await f.controller.interrupt({ agentId, taskId, runtimeGeneration: 1 });
  }
  assert.equal(f.currentTask().phase, "settled"); assert.equal(f.settlements.length, 1);
  assert.equal(order[0], "cancel"); assert.ok(order.includes("native"));
  assert.equal(await f.controller.requestProcessResume({ admissionId: "late-grant", taskId, childIdle: true, continuationSignal: true, settledBoundary: true }), "record-only");
});

test("Process satisfied at the child settled boundary resumes the Task in place instead of stalling", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  // 子进程在 agent_settled 里先记录 Process wait，再在 settled boundary 重试 admission。
  const waitState = await f.ownerRequest("process_wait_state", { taskId, blocking: [{ leaseId: "lease-1", generation: 1, logicalKey: "proc" }] });
  assert.equal(waitState.ok, true);
  assert.equal(f.currentTask().phase, "waiting");
  const resumed = await Promise.race([
    f.ownerRequest("resume_process_wait", { admissionId: "batch-settled-boundary", taskId, childIdle: true, continuationSignal: true, settledBoundary: true }),
    new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ admission: "timed-out" }), 500)),
  ]);
  assert.equal(((resumed.result ?? resumed) as Record<string, unknown>).admission ?? (resumed as Record<string, unknown>).admission, "trigger");
  assert.equal(f.currentTask().phase, "running");
  assert.equal(f.activeRequests.length, 0);
});
test("a mailbox activation cannot settle a Process Task between lease release and batch admission", async t => {
  const f = await fixture(t, { phase: "waiting", waiting_on: { kind: "process", key: hex("wait") }, activation_order: 9 });
  await f.reachRunning();
  assert.equal(f.calls.some(call => call.type === "recheck"), true, "new grant rechecks accepted Task mail even after source ACK");
  await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  assert.equal(f.currentTask().phase, "waiting"); assert.equal(f.settlements.length, 0);
  assert.equal(f.hostCalls.includes("resume"), false, "only Process admission may resume this dependency");
  assert.equal(f.releases.some(release => release.nextResidency === "waiting-pinned"), true);
});

test("task_settled while an interrupt is pending settles instead of pinning the Task on Process wait", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  f.patchTask({ phase: "waiting", waiting_on: { kind: "process", key: hex("wait") }, interrupt_requested_at: START, interrupt_generation: 1 });
  const response = await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(f.currentTask().phase, "settled");
  assert.equal(f.settlements.length, 1);
  assert.equal((f.settlements[0] as Record<string, unknown>).outcome, "interrupted");
  assert.equal(f.releases.some((item) => item.nextResidency === "waiting-pinned"), false);
});

test("a late duplicate task_settled on a settled Task is answered idempotently", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  const first = await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(f.currentTask().phase, "settled");
  const second = await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(f.settlements.length, 1);
});

test("a declared finish blocks any further Process continuation turn", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  const text = "partial result";
  const declared = await f.ownerRequest("finish_task", { taskId, toolCallId: "call-1", outcome: "partial", text, textSha256: hex(text) });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(await f.controller.requestProcessResume({ agentId, taskId, admissionId: "batch-finished-a", childIdle: false, continuationSignal: true, settledBoundary: false }), "record-only");
  assert.equal(await f.controller.requestProcessResume({ agentId, taskId, admissionId: "batch-finished-b", childIdle: true, continuationSignal: true, settledBoundary: true }), "record-only");
});

test("a Process wait recorded after finish_task never pins the Task", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  const text = "partial result";
  await f.ownerRequest("finish_task", { taskId, toolCallId: "call-1", outcome: "partial", text, textSha256: hex(text) });
  // 子进程结算前仍会上报还没释放的 Process lease，Host 不能因此把已定稿的 Task 挂住。
  await f.ownerRequest("process_wait_state", { taskId, blocking: [{ leaseId: "lease-1", generation: 1, logicalKey: "proc" }] });
  const settled = await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.equal(f.currentTask().phase, "settled");
});

test("interrupting a Process-parked runtime settles the Task instead of aborting an idle child", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  await f.ownerRequest("process_wait_state", { taskId, blocking: [{ leaseId: "lease-1", generation: 1, logicalKey: "proc" }] });
  const parked = await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  assert.equal(parked.ok, true, JSON.stringify(parked));
  assert.equal(f.currentTask().phase, "waiting");
  f.patchTask({ interrupt_requested_at: START, interrupt_generation: 1 });
  await f.controller.interrupt({ agentId, taskId, runtimeGeneration: 1 });
  assert.equal(f.currentTask().phase, "settled");
  assert.equal((f.settlements[0] as Record<string, unknown>).outcome, "interrupted");
  assert.equal(f.calls.some((item) => item.type === "taskAbort"), false);
});

test("owner events are never flushed to a runtime that has not acknowledged ready", async (t) => {
  const f = await fixture(t);
  f.pauseAssembly();
  const start = f.controller.start({ grantId: "grant-1", coordinatorGeneration: 1, agentId, taskId, runtimeGeneration: 1 });
  await waitFor(() => f.calls.some((item) => item.type === "assemble")); await tick();
  const before = f.calls.length;
  assert.equal(await f.controller.flushAgent(agentId), false);
  assert.equal(f.calls.slice(before).some((item) => item.type === "ownerWrite"), false);
  f.resolveAssembly(); await start;
});

test("a mailbox for a Process-parked Task is held back until the Host approves the resume", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  await f.ownerRequest("process_wait_state", { taskId, blocking: [{ leaseId: "lease-1", generation: 1, logicalKey: "proc" }] });
  await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  assert.equal(f.currentTask().phase, "waiting");
  f.patchTask({ activation_order: 8 });
  f.setOwnerEvents([{ event_sequence: 1, event_id: "evt_1", kind: "mailbox_delivery", state: "pending", payload_json: JSON.stringify({ kind: "mailbox_delivery", items: [{ messageId: "msg_1", injectedInto: { kind: "task", taskId } }] }) }]);
  const before = f.calls.filter((item) => item.type === "ownerWrite").length;
  assert.equal(await f.controller.flushAgent(agentId), true);
  // 没有 Host 批准之前不能把 mailbox 推给挂起的子进程，否则它会私起一个 turn。
  assert.equal(f.calls.filter((item) => item.type === "ownerWrite").length, before);
  assert.deepEqual(f.activeRequests.map((item) => item.taskId), [taskId]);
  const resumed = f.controller.start({ grantId: "grant-2", coordinatorGeneration: 1, agentId, taskId, runtimeGeneration: 1, residency: "existing" });
  await resumed;
  assert.equal(f.currentTask().phase, "waiting");
  assert.equal(f.hostCalls.includes("resume"), false);
  // 恢复不是 Process continuation，额度没被消费：Process 完成时仍然能 trigger 一次。
  assert.equal(await f.controller.requestProcessResume({ agentId, taskId, admissionId: "batch-resume", childIdle: true, continuationSignal: true, settledBoundary: true }), "trigger");
  assert.equal(await f.controller.requestProcessResume({ agentId, taskId, admissionId: "batch-resume", childIdle: true, continuationSignal: true, settledBoundary: true }), "trigger");
  assert.equal(await f.controller.requestProcessResume({ agentId, taskId, admissionId: "batch-second", childIdle: false, continuationSignal: true, settledBoundary: false }), "record-only");
});

test("an idle-conversation mailbox is flushed to a parked runtime without any resume", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  await f.ownerRequest("process_wait_state", { taskId, blocking: [{ leaseId: "lease-1", generation: 1, logicalKey: "proc" }] });
  await f.ownerRequest("task_settled", { taskId, sessionFile: "" });
  f.setOwnerEvents([{ event_sequence: 1, event_id: "evt_2", kind: "mailbox_delivery", state: "pending", payload_json: JSON.stringify({ kind: "mailbox_delivery", items: [{ messageId: "msg_2", injectedInto: { kind: "idle-conversation" } }] }) }]);
  assert.equal(await f.controller.flushAgent(agentId), true);
  assert.deepEqual(f.activeRequests, []);
  assert.equal(f.sentOwnerEvents, 1);
});

test("a settlement refused for storage capacity ends in a truthful Chinese storage card, never a user interrupt", async (t) => {
  const f = await fixture(t); await f.reachRunning();
  f.rejectNextSettle("[subagent/storage-capacity] 事务 settle-task 因存储容量不足已拒绝，store 未改动（metadata hard ceiling would be exceeded）。");
  // agent_settled 里结算被拒：子会话的失败路径随后请求 shutdown，原来会把 Task 结成 interrupted / user-interrupt。
  await assert.rejects(f.ownerRequest("task_settled", { taskId, sessionFile: "" }), /storage-capacity/);
  f.shutdownChild();
  await waitFor(() => f.settlements.length === 1);
  const fallback = f.settlements[0] as Record<string, string>;
  assert.equal(fallback.outcome, "failed"); assert.equal(fallback.reason, "storage-error");
  assert.match(fallback.finalText, /存储容量不足没能保存/u); assert.match(fallback.finalText, new RegExp(`/subagents ${agentId}`, "u")); assert.match(fallback.finalText, /conversations\/agt_.*\/session\.jsonl/u);
  assert.equal(fallback.summary, "结果因存储容量不足没能保存，完整输出在子 Agent 会话里。");
  assert.doesNotMatch(JSON.stringify(fallback), /user-interrupt|SDK child runtime ended/u);
});
