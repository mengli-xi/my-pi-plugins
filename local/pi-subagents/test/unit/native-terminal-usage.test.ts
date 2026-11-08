import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { readNativeTerminalProofV1 } from "../../src/persistence/native-terminal.ts";

const at="2026-08-21T06:00:00.000Z",agentId=encodeDomainId("agt",Buffer.alloc(16,1)),taskId=encodeDomainId("tsk",Buffer.alloc(16,2));

test("an aborted settled boundary proves cancellation before any user or assistant is appended", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-preflight-abort-")));
  await mkdir(join(root, "conversations", agentId), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "conversations", agentId, "session.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: at, cwd: root })}\n`);
  const state: any = { root: {}, agents: [{ agent: { agent_id: agentId, conversation: { relative_path: `conversations/${agentId}/session.jsonl` } }, tasks: [{ task_id: taskId, phase: "running", started_at: at, interrupt_requested_at: at }] }] };
  assert.equal(await readNativeTerminalProofV1({ mainRoot: root, state, agentId, taskId }), undefined);
  const proof = await readNativeTerminalProofV1({ mainRoot: root, state, agentId, taskId, aborted: true });
  assert.equal(proof?.outcome, "interrupted");
  assert.equal(proof?.reason, "user-interrupt");
  assert.equal(proof?.usage.total_tokens, 0);
});
test("TUI task proof uses task-local assistant usage without subtracting the session baseline twice",async t=>{const root=await realpath(await mkdtemp(join(tmpdir(),"native-usage-")));await chmod(root,0o700);await mkdir(join(root,"conversations",agentId),{recursive:true,mode:0o700});t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,"conversations",agentId,"session.jsonl"),user={type:"message",id:"u",parentId:null,timestamp:at,message:{role:"user",content:[{type:"text",text:"work"}],timestamp:Date.parse(at)}},assistant={type:"message",id:"a",parentId:"u",timestamp:"2026-08-21T06:00:01.000Z",message:{role:"assistant",content:[{type:"text",text:"done"}],api:"x",provider:"p",model:"m",usage:{input:3,output:293,cacheRead:0,cacheWrite:8147,totalTokens:8443,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.parse(at)+1000}};await writeFile(file,[JSON.stringify({type:"session",version:3,id:"session",timestamp:at,cwd:root}),JSON.stringify(user),JSON.stringify(assistant)].join("\n")+"\n");const state:any={root:{},agents:[{agent:{agent_id:agentId,conversation:{relative_path:`conversations/${agentId}/session.jsonl`},current_task_id:taskId},tasks:[{task_id:taskId,phase:"running",started_at:at,usage_baseline:{input_tokens:7870,output_tokens:24,cache_read_tokens:0,cache_write_tokens:0,total_tokens:7894}}]}]};const proof=await readNativeTerminalProofV1({mainRoot:root,state,agentId,taskId});assert.deepEqual(proof?.usage,{input_tokens:3,output_tokens:293,cache_read_tokens:0,cache_write_tokens:8147,total_tokens:8443});});

test("a finish_task declaration proves settlement even though the terminal assistant stopped on a tool call", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-finish-"))); await chmod(root, 0o700);
  await mkdir(join(root, "conversations", agentId), { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "conversations", agentId, "session.jsonl");
  const user = { type: "message", id: "u", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.parse(at) } };
  const assistant = { type: "message", id: "a", parentId: "u", timestamp: "2026-08-21T06:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", toolName: "finish_task", id: "call" }], api: "x", provider: "p", model: "m", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 }, stopReason: "toolUse", timestamp: Date.parse(at) + 1000 } };
  await writeFile(file, `${[JSON.stringify({ type: "session", version: 3, id: "session", timestamp: at, cwd: root }), JSON.stringify(user), JSON.stringify(assistant)].join("\n")}\n`);
  const declaration = { outcome: "partial", text: "partial answer", text_sha256: "b".repeat(64), declared_at: at, tool_call_id: "call", request_id: "req", runtime_generation: 1 };
  const state: any = { root: {}, agents: [{ agent: { agent_id: agentId, conversation: { relative_path: `conversations/${agentId}/session.jsonl` }, current_task_id: taskId }, tasks: [{ task_id: taskId, phase: "running", started_at: at, finish_declaration: declaration }] }] };
  const proof = await readNativeTerminalProofV1({ mainRoot: root, state, agentId, taskId });
  assert.equal(proof?.outcome, "partial");
  assert.equal(proof?.reason, "finish-task");
  assert.equal(proof?.finalText, "partial answer");
});

test("one Task counts earlier wait turns and compaction summaries across its resumed prompt", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-resumed-usage-")));
  await mkdir(join(root, "conversations", agentId), { recursive: true }); t.after(() => rm(root, { recursive: true, force: true }));
  const usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const entries = [
    { type: "session", version: 3, id: "session", timestamp: at, cwd: root },
    { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: "initial", timestamp: Date.parse(at) } },
    { type: "message", id: "a1", parentId: "u1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "waiting" }], stopReason: "stop", usage, api: "x", provider: "p", model: "m", timestamp: Date.parse(at) } },
    { type: "compaction", id: "c", parentId: "a1", timestamp: at, summary: "summary", firstKeptEntryId: "a1", tokensBefore: 100, usage },
    { type: "message", id: "u2", parentId: "c", timestamp: at, message: { role: "user", content: "continue", timestamp: Date.parse(at) } },
    { type: "message", id: "a2", parentId: "u2", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage, api: "x", provider: "p", model: "m", timestamp: Date.parse(at) } },
  ];
  await writeFile(join(root, "conversations", agentId, "session.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const state: any = { root: {}, agents: [{ agent: { agent_id: agentId, conversation: { relative_path: `conversations/${agentId}/session.jsonl` } }, tasks: [{ task_id: taskId, phase: "running", started_at: at }] }] };
  const proof = await readNativeTerminalProofV1({ mainRoot: root, state, agentId, taskId });
  assert.equal(proof?.finalText, "done"); assert.equal(proof?.usage.total_tokens, 21);
});
