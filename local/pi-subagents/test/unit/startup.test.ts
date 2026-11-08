import { emptyMailboxBinding } from "../fixtures/mailbox.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../../src/index.ts";
import { mainKey } from "../../src/domain/ids.ts";
import { getProcessServiceCellV1 } from "../../src/host/service-cell.ts";
import { hasStoredMainV1 } from "../../src/host/recovery-presence.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "subagents-startup-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const cell = getProcessServiceCellV1();
  cell.promise = undefined;
  cell.service = undefined;
  const events = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const widgets: any[] = [], notices: any[] = [], calls: string[] = [];
  const sessionId = "startup-main";
  const ctx: any = { cwd: root, hasUI: true, isProjectTrusted: () => false, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: {
    theme: { fg: (_color: string, text: string) => text }, setWidget: (...args: any[]) => widgets.push(args),
    onTerminalInput: () => () => {}, notify: (...args: any[]) => notices.push(args), custom: async () => ({ action: "close" }),
  } };
  const pi: any = { on: (name: string, handler: any) => {
    const previous = events.get(name);
    events.set(name, (...args: any[]) => { const result = previous?.(...args); return result instanceof Promise ? result.then(() => handler(...args)) : handler(...args); });
    return () => {};
  },
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    registerTool: (definition: any) => tools.set(definition.name, definition), registerMessageRenderer() {},
    events: { emit() {} },
  };
  const binding: any = { context: ctx, host: { setWorkDiagnostic() {}, snapshot: () => ({ root: { inbox: [] }, agents: [] }) } };
  const service: any = {
    async attach() { calls.push("attach"); return binding; }, binding: () => binding,
    executor: () => async ({ tool }: any) => { calls.push(tool); return { details: { version: 1, tool, outcome: "ok", host_revision: 1, data: { agents: [] } } }; },
    async endMainSession() { calls.push("detach"); }, detach() { calls.push("detach"); }, async close() { calls.push("close"); },
    signalMainRunStarted() { calls.push("run-start"); },
  };
  extension(pi, emptyMailboxBinding);
  const start = () => events.get("session_start")({}, ctx);
  const stop = () => events.get("session_shutdown")({ reason: "quit" }, ctx);
  const list = () => tools.get("list_agents").execute("call", {}, undefined, undefined, ctx);
  t.after(async () => {
    await stop();
    cell.promise = undefined; cell.service = undefined;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessionId, cell, ctx, events, commands, tools, widgets, notices, calls, binding, service, start, stop, list };
}

test("empty startup registers commands, tools and a hidden strip without creating a service or store", async (t) => {
  const f = await fixture(t);
  assert.ok(f.commands.has("subagents"));
  assert.equal(f.tools.size, 8);
  await f.start();
  assert.equal(f.cell.promise, undefined);
  assert.equal(f.cell.service, undefined);
  assert.equal(await hasStoredMainV1(f.root, f.sessionId), false);
  const strip = f.widgets[0][1]({ requestRender() {}, terminal: { write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } }, f.ctx.ui.theme);
  assert.deepEqual(strip.render(80), []);
  strip.dispose();
  assert.deepEqual(f.notices, []);
});

test("first operations await one shared ready binding", async (t) => {
  const f = await fixture(t); await f.start();
  let ready!: (service: any) => void;
  f.cell.promise = new Promise((resolve) => { ready = resolve; });
  const first = f.list(), second = f.list();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
  ready(f.service);
  assert.equal((await first).isError, undefined);
  await second;
  assert.deepEqual(f.calls, ["attach", "list_agents", "list_agents"]);
});

test("first use during a Main run adopts the running settlement boundary", async (t) => {
  const f = await fixture(t); await f.start();
  f.events.get("agent_start")({}, f.ctx);
  f.cell.promise = Promise.resolve(f.service);
  await f.list();
  assert.deepEqual(f.calls, ["attach", "run-start", "list_agents"]);
});

test("ready failure rejects tools and leaves the next operation able to initialize", async (t) => {
  const f = await fixture(t); await f.start();
  f.cell.promise = Promise.reject(new Error("identity probe failed"));
  const result = await f.list();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /identity probe failed/);
  assert.equal(f.cell.promise, undefined);
  assert.deepEqual(f.calls, []);
  f.cell.promise = Promise.resolve(f.service);
  assert.equal((await f.list()).isError, undefined);
  assert.deepEqual(f.calls, ["attach", "list_agents"]);
});

test("an existing durable Main enters recovery before session_start returns", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "pi-subagents", "store-v2", "mains", mainKey(f.sessionId)), { recursive: true });
  f.cell.promise = Promise.resolve(f.service);
  await f.start();
  assert.deepEqual(f.calls, ["attach"]);
});

test("shutdown during first-use readiness prevents stale attach and closes the created owner", async (t) => {
  const f = await fixture(t); await f.start();
  let ready!: (service: any) => void;
  f.cell.promise = new Promise((resolve) => { ready = resolve; });
  const first = f.list();
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = f.stop();
  ready(f.service);
  assert.equal((await first).isError, true);
  await stopped;
  assert.equal(f.calls.includes("attach"), false);
  assert.ok(f.calls.includes("close"));
  assert.equal(f.cell.service, undefined);
});

test("subagents completion includes closed IDs and paths for empty, partial and unknown prefix",async t=>{
 const f=await fixture(t);await f.start();f.cell.service=f.service;await f.list();
 f.binding.host.snapshot=()=>({root:{inbox:[]},agents:[{agent:{agent_id:"agt_closed",task_path:"/root/closed",task_name:"closed",lifecycle:"closed"}},{agent:{agent_id:"agt_open",task_path:"/root/open",task_name:"open",lifecycle:"open"}}]});
 const complete=f.commands.get("subagents").getArgumentCompletions;
 assert.ok(complete("").some((item:any)=>item.value==="agt_closed"));assert.ok(complete("agt_c").some((item:any)=>item.value==="agt_closed"));assert.ok(complete("/root/c").some((item:any)=>item.value==="/root/closed"));assert.equal(complete("unknown"),null);
});

test("unknown Agent target explains scope without claiming old storage was deleted",async t=>{
 const f=await fixture(t);await f.start();f.cell.service=f.service;
 await f.commands.get("subagents").handler("agt_migrated",f.ctx);
 assert.match(f.notices.at(-1)[0],/找不到这个 Agent.*当前会话、Agent ID 或 task path.*不会自动转换或删除旧存储/);
 assert.deepEqual(f.calls,["attach"]);assert.equal(f.binding.host.snapshot().agents.length,0);
});
