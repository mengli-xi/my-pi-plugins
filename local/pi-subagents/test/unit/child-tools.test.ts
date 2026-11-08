import assert from "node:assert/strict";
import test from "node:test";
import { childCollaborationExecutorV1, mandatoryChildReadyToolsV1, registerChildToolsV1 } from "../../src/child/tools.js";
import type { ChildToolPort } from "../../src/child/tool-port.js";

const agentId = `agt_${Buffer.alloc(16, 1).toString("base64url")}` as const;
const taskId = `tsk_${Buffer.alloc(16, 2).toString("base64url")}`;
const nestedTaskId = `tsk_${Buffer.alloc(16, 3).toString("base64url")}`;

function runtimeFixture(input: { depth?: 1 | 2; responses: Array<{ hostRevision: number; result: Readonly<Record<string, unknown>> } | Error> }) {
  const calls: Array<{ type: string; payload: Readonly<Record<string, unknown>>; requestId?: string }> = [];
  const leases: string[] = [];
  let revision = 4;
  const request = async (type: string, payload: Readonly<Record<string, unknown>>, requestId?: string) => {
    calls.push({ type, payload, ...(requestId ? { requestId } : {}) });
    const response = input.responses.shift(); if (!response) throw new Error("missing fixture response"); if (response instanceof Error) throw response; revision = response.hostRevision; return response;
  };
  const runtime: ChildToolPort = {
    agentDirectory: "/tmp", assertReady() {},
    identity: () => ({ depth: input.depth ?? 1, taskPath: "/root/parent", agentId, sessionId: "child-session", generation: 1 }),
    revision: () => revision, taskId: () => taskId,
    acquireTaskLease: id => { leases.push(id); return { leaseId: "lease-1", generation: 2, logicalKey: id }; },
    prepare: ({ requestId, kind, payload, artifacts }) => request("prepare_task", { kind, clientOperationId: requestId, ...(kind === "spawn" ? { spawn: payload, artifacts } : { followup: payload }) }, requestId),
    commit: ({ requestId, ...payload }) => request("commit_task", { clientOperationId: requestId, ...payload }),
    abort: ({ requestId, ...payload }) => request("abort_prepared_task", { clientOperationId: requestId, ...payload }),
    collaborate: request, finish: payload => request("finish_task", payload),
  };
  return { runtime, calls, leases };
}

test("mandatory child ready tool definitions are sorted, unique and complete", () => {
  const tools = mandatoryChildReadyToolsV1();
  assert.deepEqual(tools.map((item) => item.name), ["finish_task", "list_agents", "list_subagent_models", "list_subagent_roles", "send_input", "spawn_agent", "wait_agents"]);
  assert.equal(new Set(tools.map((item) => item.definitionSha256)).size, 7);
});

test("child model query filters its frozen model scope locally", async () => {
  const fx = runtimeFixture({ responses: [] }); const execute = childCollaborationExecutorV1(fx.runtime);
  const one = { provider: "one", id: "shared" }; const two = { provider: "two", id: "shared" };
  const result = await execute({ tool: "list_subagent_models", toolCallId: "call", params: { query: "two/" }, context: { modelRegistry: { getAvailable: () => [one, two] }, scopedModels: [{ model: two }] } as never });
  assert.equal(result.details.outcome, "ok");
  if (result.details.outcome === "ok") assert.deepEqual(result.details.data, { models: ["two/shared"], unavailable: [] });
  assert.deepEqual(fx.calls, []);
});

test("child model query reports unavailable scope matches without forwarding", async () => {
  const fx = runtimeFixture({ responses: [] }); const execute = childCollaborationExecutorV1(fx.runtime);
  const one = { provider: "one", id: "shared" }; const two = { provider: "two", id: "shared" };
  const result = await execute({ tool: "list_subagent_models", toolCallId: "call", params: { query: "shared ONE" }, context: { modelRegistry: { getAvailable: () => [one, two] }, scopedModels: [{ model: two }] } as never });
  assert.equal(result.details.outcome, "ok");
  if (result.details.outcome === "ok") {
    const data = result.details.data as { models: string[]; unavailable: { id: string; reason: string }[] };
    assert.deepEqual(data.models, []);
    assert.deepEqual(data.unavailable, [{ id: "one/shared", reason: "outside --models scope" }]);
  }
  assert.deepEqual(fx.calls, []);
});

test("direct child tools map owner success and wait armed terminates", async () => {
  const fx = runtimeFixture({ responses: [{ hostRevision: 5, result: { messageId: "msg" } }, { hostRevision: 6, result: { state: "armed", barrierId: "bar" } }] }); const execute = childCollaborationExecutorV1(fx.runtime);
  const sent = await execute({ tool: "send_input", toolCallId: "call", params: { target: "/root/a", message: "note" } });
  assert.equal(sent.details.outcome, "ok"); assert.equal(sent.details.host_revision, 5); assert.deepEqual(fx.calls[0], { type: "send_input", payload: { target: "/root/a", message: "note" } });
  const waited = await execute({ tool: "wait_agents", toolCallId: "call", params: { targets: ["/root/a"] } }); assert.equal(waited.terminate, true);
});

test("nested local prepare acquires exact Task lease and commits with stable operation id", async () => {
  const fx = runtimeFixture({ responses: [
    { hostRevision: 5, result: { state: "prepared", prepared: { preparedToken: "token", taskId: nestedTaskId, logicalLeaseKey: nestedTaskId, leaseOwner: { kind: "agent", sessionId: "child-session", agentId }, publicResult: { agent_id: "child" } } } },
    { hostRevision: 6, result: { agent_id: "child", task_id: nestedTaskId, state: "queued" } },
  ] });
  const preparation:any={bind:()=>()=>{},prepare:async(input:any)=>({sessionId:"nested-session",sessionJsonl:Buffer.from(`${JSON.stringify({type:"session",version:3,id:"nested-session",timestamp:new Date().toISOString(),cwd:"/tmp"})}\n`),systemPrompt:Buffer.from("prompt\n"),profile:{version:1,agent:input.agentId}})};
  const result = await childCollaborationExecutorV1(fx.runtime,preparation)({ tool: "spawn_agent", toolCallId: "call", params: { task_name: "nested", message: "work" },context:{} as any });
  assert.equal(result.details.outcome, "ok"); assert.deepEqual(fx.leases, [nestedTaskId]); assert.equal(fx.calls[0]!.type, "prepare_task"); assert.ok(fx.calls[0]!.payload.artifacts);
  const operationId = fx.calls[0]!.payload.clientOperationId; assert.equal(typeof operationId, "string"); assert.equal(fx.calls[0]!.requestId, operationId);
  assert.deepEqual(fx.calls[1], { type: "commit_task", payload: { clientOperationId: operationId, preparedToken: "token", taskId: nestedTaskId, lease: { leaseId: "lease-1", generation: 2, logicalKey: nestedTaskId } } });
});

test("aborted input is rejected before child admission", async () => {
  const fx = runtimeFixture({ responses: [] }), controller = new AbortController(); controller.abort();
  const result = await childCollaborationExecutorV1(fx.runtime)({ tool: "send_input", toolCallId: "call", params: { target: "/root/a", message: "next" }, signal: controller.signal });
  assert.equal(result.details.outcome, "rejected"); assert.deepEqual(fx.calls, []);
});

test("depth guard rejects spawn before owner admission", async () => {
  const fx = runtimeFixture({ depth: 2, responses: [] }); const result = await childCollaborationExecutorV1(fx.runtime)({ tool: "spawn_agent", toolCallId: "call", params: { task_name: "too_deep", message: "work" } });
  assert.equal(result.details.outcome, "rejected"); if (result.details.outcome === "rejected") assert.equal(result.details.error.code, "depth-limit"); assert.equal(fx.calls.length, 0);
});

test("depth-2 spawn rejection tells the child what to do instead", async () => {
  const fx = runtimeFixture({ depth: 2, responses: [] }); const execute = childCollaborationExecutorV1(fx.runtime);
  const result = await execute({ tool: "spawn_agent", toolCallId: "call", params: { task_name: "leaf", message: "m" } });
  assert.equal(result.details.outcome, "rejected");
  if (result.details.outcome === "rejected") { assert.equal(result.details.error.code, "depth-limit"); assert.match(result.details.error.message, /finish_task with blocked/); }
  assert.deepEqual(fx.calls, []);
});

test("partial finish_task drops a stray reason instead of rejecting the whole declaration", async () => {
  const fx = runtimeFixture({ responses: [{ hostRevision: 5, result: { recorded: true } }, { hostRevision: 6, result: { recorded: true } }] });
  const tools: any[] = [];
  const pi = { registerTool: (tool: unknown) => tools.push(tool) } as never;
  registerChildToolsV1(pi, fx.runtime);
  const finish = tools.find((tool) => tool.name === "finish_task");
  const partial = await finish.execute("call-1", { outcome: "partial", text: "half done", reason: "external-prerequisite" });
  assert.equal(partial.isError, undefined); assert.equal(partial.terminate, true);
  assert.equal(fx.calls.at(-1)?.type, "finish_task"); assert.equal(fx.calls.at(-1)?.payload.reason, undefined); assert.equal(fx.calls.at(-1)?.payload.outcome, "partial");
  await assert.rejects(() => finish.execute("call-2", { outcome: "blocked", text: "need approval" }), /requires reason: user-input-required, approval-required, or external-prerequisite/);
  const blocked = await finish.execute("call-3", { outcome: "blocked", text: "need approval", reason: "approval-required" });
  assert.equal(blocked.terminate, true); assert.equal(fx.calls.at(-1)?.payload.reason, "approval-required");
});
