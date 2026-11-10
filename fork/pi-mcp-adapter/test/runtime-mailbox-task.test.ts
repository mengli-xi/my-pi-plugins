import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskRegistry, type TaskDelivery } from "../task-jobs.ts";
import { acceptedTaskResultEntry, frozenTaskResultEntry, frozenTaskResultsFromBranch, MCP_TASK_CUSTOM_TYPE, MCP_TASK_RESULT_TYPE, pendingTaskEntry, pendingTasksFromBranch, taskRecoveryFromSession, taskCheckpointEntry, type FrozenTaskResult } from "../task-entries.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const origin = { deliveryId: "task:original:attempt", anchorEntryId: "original-leaf", scope: "branch" as const };
const reference = { endpointId: "endpoint", generation: "v2" as const, taskId: "t1", originalOperation: "tools/call" };
const custom = (data: unknown) => ({ type: "custom", customType: MCP_TASK_CUSTOM_TYPE, data });
const task = { key: "demo/t1", server: "demo", tool: "build", reference, ...origin };
const frozen: FrozenTaskResult = {
  key: task.key, server: task.server, tool: task.tool, ...origin,
  message: { customType: MCP_TASK_RESULT_TYPE, display: true, content: [{ type: "text", text: "done" }],
    details: { server: "demo", deliveryId: origin.deliveryId, task: { server: "demo", tool: "build", id: "t1", status: "completed" } } },
};

function registry(send: TaskDelivery["send"]) {
  const manager = { decrementInFlight: vi.fn(), touch: vi.fn() };
  const captured = vi.fn((restored?: typeof origin): TaskDelivery => ({ ...(restored ?? origin), send: Object.assign(send, { isCurrent: () => true }) }));
  const persist = vi.fn();
  const accepted = vi.fn();
  const handedOff = vi.fn();
  const instance = new BackgroundTaskRegistry(manager as any, captured, new AbortController().signal, () => {}, handedOff, persist, accepted);
  return { instance, manager, captured, persist, accepted, handedOff };
}

function execution() {
  const settled = deferred<any>();
  return { settled, value: { settle: vi.fn(() => settled.promise), cancel: vi.fn(), release: vi.fn() } };
}

const body = { content: [{ type: "text" as const, text: "build ok" }], details: {} };

describe("Task durable mailbox delivery", () => {
  it("captures before following, freezes once, and ACKs only after durable acceptance", async () => {
    const put = deferred<void>();
    const sent = vi.fn(() => put.promise);
    const runtime = registry(sent);
    const remote = execution();
    const render = vi.fn(async () => structuredClone(body));
    const done = runtime.instance.start({ server: "demo", tool: "build", taskId: "t1", execution: remote.value as any, render, guard: render });
    expect(runtime.captured).toHaveBeenCalledTimes(1);
    remote.settled.resolve({ outcome: { status: "completed", result: { resultType: "complete", content: [] } } });
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(runtime.persist).toHaveBeenCalledTimes(1);
    expect(runtime.accepted).not.toHaveBeenCalled();
    expect(runtime.manager.decrementInFlight).not.toHaveBeenCalled();
    expect(sent.mock.calls[0]).toEqual([expect.objectContaining({ customType: MCP_TASK_RESULT_TYPE,
      details: expect.objectContaining({ server: "demo", deliveryId: origin.deliveryId }) }), origin.deliveryId]);
    put.resolve();
    await done;
    expect(runtime.accepted).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(runtime.manager.decrementInFlight).toHaveBeenCalledTimes(1);
  });

  it("uses the target captured before the tool request instead of capturing again on its late Task handle", async () => {
    const send = vi.fn(async () => {});
    const runtime = registry(send);
    const delivery = runtime.instance.capture();
    runtime.captured.mockImplementation(() => { throw new Error("late capture must not run"); });
    const remote = execution();
    const render = vi.fn(async () => structuredClone(body));
    const done = runtime.instance.start({ server: "demo", tool: "build", taskId: "t1", execution: remote.value as any, delivery, render, guard: render });
    remote.settled.resolve({ outcome: { status: "completed", result: { content: [] } } });
    await done;
    expect(runtime.captured).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ deliveryId: origin.deliveryId }) }), origin.deliveryId);
  });

  it("retries a failed put on exit with the same key/bytes, without rendering or executing again", async () => {
    const sent = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const runtime = registry(sent);
    const remote = execution();
    const render = vi.fn(async () => structuredClone(body));
    const done = runtime.instance.start({ server: "demo", tool: "build", taskId: "t1", execution: remote.value as any, render, guard: render });
    remote.settled.resolve({ outcome: { status: "completed", result: { content: [] } } });
    await done;
    expect(runtime.accepted).not.toHaveBeenCalled();
    await runtime.instance.handOffForShutdown();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[0]).toEqual(sent.mock.calls[1]);
    expect(runtime.persist).toHaveBeenCalledTimes(1);
    expect(runtime.accepted).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(remote.value.settle).toHaveBeenCalledTimes(1);
  });

  it("waits for an already-settled result being rendered before shutdown retires transport", async () => {
    const rendering = deferred<typeof body>();
    const runtime = registry(vi.fn(async () => {}));
    const remote = execution();
    const render = vi.fn(() => rendering.promise);
    const done = runtime.instance.start({ server: "demo", tool: "build", taskId: "t1", execution: remote.value as any, render, guard: render });
    remote.settled.resolve({ outcome: { status: "completed", result: { content: [] } } });
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = runtime.instance.handOffForShutdown().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    rendering.resolve(body);
    await stopping;
    await done;
    expect(runtime.persist).toHaveBeenCalledTimes(1);
    expect(runtime.accepted).toHaveBeenCalledTimes(1);
    expect(runtime.handedOff).not.toHaveBeenCalled();
  });

  it("restores only the frozen outcome, preserving its original target and bytes", async () => {
    const sent = vi.fn(async () => {});
    const runtime = registry(sent);
    await runtime.instance.restoreResult(frozen);
    expect(runtime.captured).toHaveBeenCalledWith(frozen);
    expect(sent).toHaveBeenCalledWith(frozen.message, origin.deliveryId);
    expect(runtime.persist).not.toHaveBeenCalled();
    expect(runtime.accepted).toHaveBeenCalledWith(frozen);
    expect(runtime.manager.decrementInFlight).not.toHaveBeenCalled();
  });

  it("coalesces recovery and shutdown while the same durable put is pending", async () => {
    const put = deferred<void>();
    const send = vi.fn(() => put.promise);
    const runtime = registry(send);
    const restoring = runtime.instance.restoreResult(frozen);
    const replay = runtime.instance.restoreResult({ ...frozen, scope: "origin-leaf" });
    const stopping = runtime.instance.handOffForShutdown();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(runtime.accepted).not.toHaveBeenCalled();
    put.resolve();
    await Promise.all([restoring, replay, stopping]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(runtime.accepted).toHaveBeenCalledTimes(1);
  });

  it("holds frozen outcomes at origin when the sender supplies no lineage proof", async () => {
    const persist = vi.fn();
    const send = vi.fn(async () => { throw new Error("held"); });
    const instance = new BackgroundTaskRegistry({ decrementInFlight() {}, touch() {} } as any,
      () => ({ ...origin, send }), new AbortController().signal, () => {}, () => {}, persist);
    const remote = execution();
    const render = vi.fn(async () => body);
    const done = instance.start({ server: "demo", tool: "build", taskId: "t1", execution: remote.value as any, render, guard: render });
    remote.settled.resolve({ outcome: { status: "completed", result: { content: [] } } });
    await done;
    expect(persist.mock.calls[0][0].scope).toBe("origin-leaf");
  });

  it("captures an unfinished restore before reconnect starts", async () => {
    const runtime = registry(vi.fn(async () => {}));
    const remote = execution();
    const resumeTask = vi.fn(async () => ({ kind: "task", ...remote.value }));
    const render = vi.fn(async () => body);
    const reconnect = vi.fn(async () => {
      expect(runtime.captured).toHaveBeenCalledTimes(1);
      return { taskSession: { resumeTask } as any, closed: () => false };
    });
    const done = runtime.instance.restore({ server: "demo", tool: "build", reference, ...origin, render, guard: render }, reconnect);
    await vi.waitFor(() => expect(resumeTask).toHaveBeenCalledTimes(1));
    remote.settled.resolve({ outcome: { status: "completed", result: { content: [] } } });
    await done;
    expect(runtime.captured.mock.calls[0]).toEqual([origin]);
  });
});

describe("Task source recovery records", () => {
  it("a frozen outcome suppresses task resume before put acceptance; only durable ACK clears it", () => {
    const branch = [custom(pendingTaskEntry("original", task)), custom(frozenTaskResultEntry("original", frozen))];
    expect(pendingTasksFromBranch(branch, "original")).toEqual([]);
    expect(frozenTaskResultsFromBranch(branch, "original")).toEqual([frozen]);
    branch.push(custom(acceptedTaskResultEntry("original", frozen)));
    expect(frozenTaskResultsFromBranch(branch, "original")).toEqual([]);
  });

  it("a different session/fork takes over neither a pending task nor frozen outcome", () => {
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("original", task))], "fork")).toEqual([]);
    expect(frozenTaskResultsFromBranch([custom(frozenTaskResultEntry("original", frozen))], "fork")).toEqual([]);
  });

  it("holds stale results and references on a shared-ancestor sibling, then finds their off-branch records at exact origin", () => {
    const a = { id: origin.anchorEntryId }, b = { id: "sibling-B" };
    const stale = { ...frozen, scope: "origin-leaf" as const };
    const result = { ...custom(frozenTaskResultEntry("original", stale)), id: "result-on-B" };
    const pending = { ...custom(pendingTaskEntry("original", { ...task, scope: "origin-leaf" })), id: "pending-on-B" };
    for (const entry of [result, pending]) {
      const tree = [a, b, entry];
      const blocked = taskRecoveryFromSession(tree, "original", tree);
      expect(blocked.results).toEqual([]);
      expect(blocked.pending).toEqual([]);
      expect(blocked.held).toHaveLength(1);
      const eligible = taskRecoveryFromSession([a], "original", tree);
      expect(eligible.held).toEqual([]);
      expect(eligible.results.length + eligible.pending.length).toBe(1);
    }
  });

  it("keeps valid original-branch recovery and never treats legacy missing-scope captures as sibling permission", () => {
    const a = { id: origin.anchorEntryId }, b = { id: "B" };
    const record = { ...custom(frozenTaskResultEntry("original", frozen)), id: "source-result" };
    expect(taskRecoveryFromSession([a, b, record], "original").results).toEqual([frozen]);
    expect(taskRecoveryFromSession([a, b], "original", [a, b, record]).held).toHaveLength(1);
    expect(taskRecoveryFromSession([a, record, b], "original").held).toHaveLength(1);
    expect(taskRecoveryFromSession([a], "original", [a, b, record]).results).toEqual([frozen]);
    const { scope: _scope, ...legacy } = frozen;
    const old = { ...custom(frozenTaskResultEntry("original", legacy)), id: "legacy-result" };
    expect(taskRecoveryFromSession([a, b, old], "original").results).toEqual([]);
    expect(taskRecoveryFromSession([a], "original", [a, b, old]).results).toEqual([legacy]);
  });

  it("restores a clean grouped leaf checkpoint but never treats its ancestry as a new branch grant", () => {
    const pending = { ...task, key: "demo/t2", deliveryId: "task:original:second", reference: { ...reference, taskId: "t2" } };
    const entry = { ...custom(taskCheckpointEntry("original", { pending: [pending], results: [frozen] })), id: "clean-checkpoint" };
    const a = { id: origin.anchorEntryId }, b = { id: "new-B" };
    const clean = taskRecoveryFromSession([a, entry], "original");
    expect(clean.pending).toEqual([pending]);
    expect(clean.results).toEqual([frozen]);
    const moved = taskRecoveryFromSession([a, entry, b], "original");
    expect(moved.pending).toEqual([]);
    expect(moved.results).toEqual([]);
    expect(moved.held).toHaveLength(2);
  });

  it("treats all-tree accepted IDs as monotonic even if an older checkpoint is appended again", () => {
    const result = { ...custom(frozenTaskResultEntry("original", frozen)), id: "result-B" };
    const accepted = { ...custom(acceptedTaskResultEntry("original", frozen)), id: "accepted-A" };
    const checkpoint = { ...custom(taskCheckpointEntry("original", { pending: [task], results: [frozen] })), id: "late-checkpoint" };
    const recovery = taskRecoveryFromSession([checkpoint], "original", [result, accepted, checkpoint]);
    expect(recovery.pending).toEqual([]);
    expect(recovery.results).toEqual([]);
    expect(recovery.held).toEqual([]);
  });

  it("keeps an originless legacy reference held once a modern identity claimed that key anywhere in the tree", () => {
    const legacy = { ...custom(pendingTaskEntry("original", { key: task.key, server: task.server, tool: task.tool, reference })), id: origin.anchorEntryId };
    const result = { ...custom(frozenTaskResultEntry("original", frozen)), id: "modern-result" };
    const accepted = { ...custom(acceptedTaskResultEntry("original", frozen)), id: "accepted-elsewhere" };
    const recovery = taskRecoveryFromSession([legacy], "original", [legacy, result, accepted]);
    expect(recovery.pending).toEqual([]);
    expect(recovery.results).toEqual([]);
    expect(recovery.held).toHaveLength(1);
  });

  it("round-trips the original identity and rejects a changed source server", () => {
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("original", task))], "original")).toEqual([task]);
    const bad = frozenTaskResultEntry("original", frozen);
    bad.message.details = { ...(bad.message.details as object), server: "other" };
    expect(frozenTaskResultsFromBranch([custom(bad)], "original")).toEqual([]);
  });
});
