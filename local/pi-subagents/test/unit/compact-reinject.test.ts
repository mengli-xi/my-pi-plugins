import assert from "node:assert/strict";
import test from "node:test";
import { createCompactReinjection, latestTaskProgress } from "../../src/host/compact-reinject.ts";

test("compact snapshot includes every unfinished Task once, stays hidden, and never wakes Main", () => {
  const sent: any[] = [], branch: any[] = [];
  const pi: any = { sendMessage: (message: any, options: any) => { sent.push({ message, options }); branch.push({ type: "custom_message", ...message }); } };
  const ctx: any = { sessionManager: { getSessionId: () => "main", getBranch: () => branch } };
  const tasks = [{ task_id: "task-1", phase: "running" }, { task_id: "task-2", phase: "waiting", waiting_on: { kind: "process", key: "proc-1" } }, { task_id: "task-3", phase: "admitted" }, { task_id: "done", phase: "settled" }];
  const binding: any = { host: { snapshot: () => ({ agents: [{ agent: { agent_id: "agent-1", task_name: "worker", task_path: "/root/worker" }, tasks }] }) }, runtime: { taskProgress: (_id: string, taskId: string) => taskId === "task-1" ? "Tests running" : undefined } };
  const event: any = { compactionEntry: { id: "compact-1" } };
  const handler = createCompactReinjection(pi, () => binding);
  handler(event, ctx); handler(event, ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { triggerTurn: false, deliverAs: "steer" });
  assert.equal(sent[0].message.display, false);
  assert.match(sent[0].message.content, /^这是压缩完成时的实时状态，与摘要冲突时以此为准。/);
  for (const text of ["agent-1", "worker", "task-1", "running", "Tests running", "task-2", "proc-1", "task-3", "wait_agents", "subagent-completion-v1"]) assert.ok(sent[0].message.content.includes(text), text);
  assert.equal(sent[0].message.content.includes("Task done"), false);
  // Reconstructing/reloading the callback does not replay an already persisted snapshot.
  createCompactReinjection(pi, () => binding)(event, ctx);
  assert.equal(sent.length, 1);
  tasks.splice(0);
  handler({ compactionEntry: { id: "empty" } } as any, ctx);
  tasks.push({ task_id: "later", phase: "running" });
  handler({ compactionEntry: { id: "empty" } } as any, ctx);
  assert.equal(sent.length, 1);
  createCompactReinjection(pi, () => undefined)({ compactionEntry: { id: "lazy" } } as any, ctx);
  assert.equal(sent.length, 1);
});

test("progress uses current Task finalized text/tool activity and never leaks thinking or past Tasks", () => {
  const start = "2026-10-19T00:00:00Z", timestamp = Date.parse(start);
  const messages: any[] = [{ role: "assistant", timestamp: timestamp - 1, content: [{ type: "text", text: "OLD" }] }, { role: "assistant", timestamp, content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "Checking\n tests" }] }];
  assert.equal(latestTaskProgress(messages, start), "Checking tests");
  messages.push({ role: "assistant", timestamp, content: [{ type: "toolCall", name: "bash" }] });
  assert.equal(latestTaskProgress(messages, start), "正在调用工具：bash");
  messages.push({ role: "toolResult", timestamp, toolName: "bash" });
  assert.equal(latestTaskProgress(messages, start), "最近完成工具：bash");
  assert.equal(latestTaskProgress(messages), undefined);
  assert.equal(latestTaskProgress(messages, "2026-10-20T00:00:00Z"), undefined);
});


test("synchronous collection uses owner text and embedded identity suppresses a duplicate", () => {
 const hooks = new Map<string, any>(), bus = new Map<string, any>(), sent: any[] = [];
 const ctx: any = { sessionManager: { getSessionId: () => "session", getBranch: () => [] } };
 const pi: any = { on: (key: string, handler: any) => hooks.set(key, handler), events: { on: (key: string, handler: any) => { bus.set(key, handler); return () => bus.delete(key); } }, sendMessage: (message: any) => sent.push(message) };
 const handler = createCompactReinjection(pi, () => ({ host: { snapshot: () => ({ agents: [{ agent: { agent_id: "agent", task_name: "live", task_path: "/root/live" }, tasks: [{ task_id: "task", phase: "running" }] }] }) }, runtime: { taskProgress: () => "Checking" } } as any));
 hooks.get("session_start")({}, ctx);
 const replies: any[] = [];
 const request = { version: 1, sessionId: "session", operationId: "op", reply: (item: any) => replies.push(item) };
 const collect = bus.get("pi-session-compact:collect-recovery-v1");
 collect({ ...request, sessionId: "other" }); assert.equal(replies.length, 0);
 collect(request); assert.equal(replies.length, 1);
 assert.equal(replies[0].owner, "pi-subagents"); assert.equal(replies[0].customType, "subagent-compact-state-v1");
 handler({ compactionEntry: { id: "embedded", details: { recovery: { version: 1, items: [replies[0]] } } } } as any, ctx);
 assert.equal(sent.length, 0);
 handler({ compactionEntry: { id: "legacy" } } as any, ctx);
 assert.equal(sent.length, 1); assert.equal(sent[0].content, replies[0].content);
 hooks.get("session_shutdown")({ reason: "switch" }); hooks.get("session_start")({}, ctx);
 assert.equal(bus.has("pi-session-compact:collect-recovery-v1"), true);
 hooks.get("session_shutdown")({ reason: "quit" });
 assert.equal(bus.has("pi-session-compact:collect-recovery-v1"), false);
});
