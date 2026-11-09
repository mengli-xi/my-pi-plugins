import assert from "node:assert/strict";
import test from "node:test";
import { createCompactReinjection } from "../../src/compact-reinject.ts";

test("compact snapshot lists live processes and full scripts/log locations once without waking or display", () => {
  const sent: any[] = [], branch: any[] = [];
  const pi: any = { sendMessage: (message: any, options: any) => { sent.push({ message, options }); branch.push({ type: "custom_message", ...message }); } };
  const ctx: any = { sessionManager: { getSessionId: () => "main", getBranch: () => branch } };
  const records = ["starting", "running", "stopping", "succeeded", "failed"].map((state, index) => ({ id: `proc_${index}`, name: `process-${index}`, state }));
  const host: any = { records: () => records, command: () => "printf hello\nsleep 30", logPath: (id: string) => `/tmp/owned/records/${id}.*.jsonl` };
  const handler = createCompactReinjection(pi, () => host);
  const event: any = { compactionEntry: { id: "compact-1" } };
  handler(event, ctx); handler(event, ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.display, false);
  assert.deepEqual(sent[0].options, { triggerTurn: false, deliverAs: "steer" });
  assert.match(sent[0].message.content, /^这是压缩完成时的实时状态，与摘要冲突时以此为准。/);
  for (const text of ["proc_0", "proc_1", "proc_2", "starting", "running", "stopping", 'printf hello\\nsleep 30', "/tmp/owned/records/proc_1.*.jsonl"]) assert.ok(sent[0].message.content.includes(text), text);
  assert.equal(sent[0].message.content.includes("proc_3"), false);
  assert.equal(sent[0].message.content.includes("proc_4"), false);
  createCompactReinjection(pi, () => host)(event, ctx);
  assert.equal(sent.length, 1);
  records.splice(0);
  handler({ compactionEntry: { id: "empty" } } as any, ctx);
  records.push({ id: "later", name: "later", state: "running" });
  handler({ compactionEntry: { id: "empty" } } as any, ctx);
  assert.equal(sent.length, 1);
  createCompactReinjection(pi, () => undefined)({ compactionEntry: { id: "absent" } } as any, ctx);
  assert.equal(sent.length, 1);
});


test("synchronous collection uses owner text and embedded identity suppresses a duplicate", () => {
 const hooks = new Map<string, any>(), bus = new Map<string, any>(), sent: any[] = [];
 const ctx: any = { sessionManager: { getSessionId: () => "session", getBranch: () => [] } };
 const pi: any = { on: (key: string, handler: any) => hooks.set(key, handler), events: { on: (key: string, handler: any) => { bus.set(key, handler); return () => bus.delete(key); } }, sendMessage: (message: any) => sent.push(message) };
 const handler = createCompactReinjection(pi, () => ({ records: () => [{ id: "proc", name: "live", state: "running" }], command: () => "sleep 30", logPath: () => "/owned/records/proc.*.jsonl" } as any));
 hooks.get("session_start")({}, ctx);
 const replies: any[] = [];
 const request = { version: 1, sessionId: "session", operationId: "op", reply: (item: any) => replies.push(item) };
 const collect = bus.get("pi-session-compact:collect-recovery-v1");
 collect({ ...request, sessionId: "other" }); assert.equal(replies.length, 0);
 collect(request); assert.equal(replies.length, 1);
 assert.equal(replies[0].owner, "pi-processes"); assert.equal(replies[0].customType, "process-compact-state-v1");
 handler({ compactionEntry: { id: "embedded", details: { recovery: { version: 1, items: [replies[0]] } } } } as any, ctx);
 assert.equal(sent.length, 0);
 handler({ compactionEntry: { id: "legacy" } } as any, ctx);
 assert.equal(sent.length, 1); assert.equal(sent[0].content, replies[0].content);
 hooks.get("session_shutdown")({ reason: "switch" }); hooks.get("session_start")({}, ctx);
 assert.equal(bus.has("pi-session-compact:collect-recovery-v1"), true);
 hooks.get("session_shutdown")({ reason: "quit" });
 assert.equal(bus.has("pi-session-compact:collect-recovery-v1"), false);
});
