import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// The scheduler cannot start without a built daemon and a Node/Bun runtime.
// Prove session_start reports that once instead of throwing an unhandled
// rejection and polling occupancy every 5s forever.
const root = globalThis as unknown as {
  schedulerStartupTest: { requests: unknown[]; reconciles: number; puts: unknown[] };
};
const modules: Record<string, string> = {
  "@earendil-works/pi-coding-agent": `export const getAgentDir=()=>"/isolated-startup-test"; export const getPackageDir=()=>${JSON.stringify(getPackageDir())};`,
  "@earendil-works/pi-tui": "export class Box{};",
  "pi-li-uikit/collapsible-block": "export const renderCollapsibleRows=()=>[];",
  "pi-session-inject/mailbox-v1/light": `export const bindMailbox=()=>({registerProducer:registration=>({
    target:ctx=>({session:{id:ctx.sessionManager.getSessionId()},bindingGeneration:1}),
    put:async mail=>{globalThis.schedulerStartupTest.puts.push(mail);return {kind:"accepted"};},
    cancel:async()=>({}),...registration
  })});`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const local = context.parentURL?.endsWith("/pi-scheduler/index.ts");
    let source = modules[specifier];
    if (local && specifier === "./src/runtime-resolver.ts") {
      // No Node/Bun runtime on this profile's PATH.
      source = "export const resolveDaemonRuntime=()=>undefined;";
    } else if (local && specifier === "./src/autostart.ts") {
      source = `export const requestWithAutostart=async body=>{globalThis.schedulerStartupTest.requests.push(body);return {ok:true,type:"ack"};};
export const reconcileDaemonBuild=()=>{globalThis.schedulerStartupTest.reconciles++;return new Promise(()=>{});};`;
    }
    return source === undefined ? next(specifier, context) : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { default: scheduler } = await import("../index.ts");
hooks.deregister();

test("session_start reports a missing daemon runtime once and schedules no retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  t.after(() => t.mock.timers.reset());
  const requests: unknown[] = [], puts: unknown[] = [], warnings: { message: string; level?: string }[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  interface ToolLike { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }
  const tools = new Map<string, ToolLike>();
  root.schedulerStartupTest = { requests, reconciles: 0, puts };
  const api = {
    on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
    registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
    registerCommand() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  scheduler(api);
  const ctx = {
    isIdle: () => true,
    sessionManager: { getSessionId: () => "startup-session", getBranch: () => [], getLeafId: () => null },
    ui: { notify: (message: string, level?: string) => warnings.push({ message, level }) },
  } as unknown as ExtensionContext;

  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.equal(warnings.length, 1, "exactly one warning, not an unhandled rejection");
  assert.equal(warnings[0]!.level, "warning");
  assert.match(warnings[0]!.message, /^Scheduler 不可用：.*Node\.js 或 Bun runtime/);
  assert.deepEqual(requests, [], "no occupancy registration was attempted");
  assert.equal(root.schedulerStartupTest.reconciles, 0, "build reconciliation never started");

  // No poller and no 5s occupancy retry were scheduled for this session.
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(5_000);
    for (let j = 0; j < 30; j++) await Promise.resolve();
  }
  await handlers.get("agent_settled")!({}, ctx);
  for (let j = 0; j < 30; j++) await Promise.resolve();
  assert.equal(warnings.length, 1);
  assert.deepEqual(requests, []);
  assert.equal(root.schedulerStartupTest.reconciles, 0);

  // Tool/command paths keep their existing wording instead of the startup notice.
  const reply = await tools.get("schedule_task")!.execute("call-1", { action: "list" }, undefined, undefined, ctx);
  assert.match(reply.content[0]!.text, /^Scheduler error: .*Node\.js 或 Bun runtime/);
  assert.equal(warnings.length, 1, "the tool path does not notify");
});
