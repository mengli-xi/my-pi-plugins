import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SchedulerMailboxDaemon } from "../src/mailbox-daemon.ts";
import { OccupancyRegistry } from "../src/occupancy.ts";
import type { SchedulerRequest, SchedulerResponse } from "../src/protocol.ts";
import { SchedulerStore } from "../src/store.ts";

// Exercise the actual extension lifecycle and daemon authorization. Only host
// UI/mailbox admission and the IPC transport are replaced; no model can run.
const root = globalThis as unknown as { schedulerHolderTest: {
  send: (request: SchedulerRequest) => Promise<SchedulerResponse>; puts: unknown[];
} };
const modules: Record<string, string> = {
  "@earendil-works/pi-coding-agent": `export const getAgentDir=()=>"/isolated-holder-test"; export const getPackageDir=()=>${JSON.stringify(getPackageDir())};`,
  "@earendil-works/pi-tui": 'export class Box{}; export class Text{};',
  "pi-li-uikit/collapsible-block": 'export const renderCollapsibleRows=()=>[];',
  "pi-session-inject/mailbox-v1/light": `export const bindMailbox=()=>({registerProducer:()=>({
    target:ctx=>({session:{id:ctx.sessionManager.getSessionId()},bindingGeneration:1}),
    put:async mail=>{globalThis.schedulerHolderTest.puts.push(mail);return {kind:"accepted"};}
  })});`,
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  const source = specifier === "./src/autostart.ts" && context.parentURL?.endsWith("/pi-scheduler/index.ts")
    ? 'export const requestWithAutostart=body=>globalThis.schedulerHolderTest.send(body); export const reconcileDaemonBuild=()=>new Promise(()=>{});'
    : modules[specifier];
  return source === undefined ? next(specifier, context)
    : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
} });
const { default: scheduler } = await import("../index.ts");
hooks.deregister();

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-holder-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  const occupancy = new OccupancyRegistry(() => true);
  const store = new SchedulerStore(directory);
  const daemon = new SchedulerMailboxDaemon({ store, occupancy, now: () => Date.now() });
  const requests: SchedulerRequest[] = [], warnings: string[] = [], puts: unknown[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => "session-holder-test",
    getBranch: () => [], getLeafId: () => null }, ui: { notify: (message: string) => warnings.push(message) } } as unknown as ExtensionContext;
  const apply = (body: SchedulerRequest): SchedulerResponse => {
    requests.push(body);
    if (body.type === "occupancy.register") {
      const r = occupancy.register(body.sessionId, body.pid, body.holderToken, body.bindingGen);
      return r.accepted ? { ok: true, type: "ack" } : { ok: false, error: "stale session binding", currentGeneration: r.currentGeneration };
    }
    if (body.type === "occupancy.unregister") {
      occupancy.unregister(body.sessionId, body.pid, body.holderToken, body.bindingGen);
      return { ok: true, type: "ack" };
    }
    if (body.type === "failures.list") return { ok: true, type: "failures", failures: [] };
    if (body.type === "injection.offers") return daemon.apply(body);
    throw new Error(`unexpected request ${body.type}`);
  };
  root.schedulerHolderTest = { send: async body => apply(body), puts };
  scheduler({ on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {} } as unknown as ExtensionAPI);
  const emit = async (name: string) => { await handlers.get(name)!({ reason: "reload" }, ctx); await flush(); };
  t.after(async () => { await emit("session_shutdown"); t.mock.timers.reset(); });
  const holder = () => occupancy.getUniqueHolder("session-holder-test")!;
  const revoke = () => { const h = holder(); occupancy.unregister(h.sessionId, h.pid, h.holderToken, h.bindingGen); };
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const registrations = () => requests.filter(r => r.type === "occupancy.register").length;
  return { occupancy, store, requests, warnings, puts, apply, emit, holder, revoke, advance, registrations };
}

for (const legacy of [false, true]) test(`revoked holder recovers after bounded backoff and warnings reset (legacy=${legacy})`, async t => {
  const h = harness(t);
  await h.emit("session_start");
  const original = h.holder();
  if (legacy) root.schedulerHolderTest.send = async body => {
    const reply = h.apply(body);
    return !reply.ok && reply.holderRejection ? { ok: false, error: reply.error } : reply;
  };
  h.revoke();
  await h.emit("agent_settled");
  await h.emit("agent_settled");
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!, /sessionId=session-holder-test pid=\d+ generation=\d+ token=.{8} binding=current registered=false retired=false/);
  assert.equal(h.registrations(), 1);
  await h.advance(4999);
  assert.equal(h.registrations(), 1, "no immediate recovery or settled busy loop");
  h.store.putInjection({ injectionId: "task:1000", taskId: "task", title: "test", prompt: "no model",
    scheduledTime: 1000, createdAt: 1000, staleAt: 100000, sessionId: original.sessionId, phase: "pending" });
  await h.advance(1);
  assert.deepEqual(h.holder(), original);
  assert.equal(h.registrations(), 2);
  assert.equal(h.puts.length, 1, "successful recovery pumps an actual daemon offer");
  assert.equal(h.warnings.length, 1);
  h.revoke(); await h.emit("agent_settled");
  assert.equal(h.warnings.length, 2, "a new fault after successful offers is visible again");
});

test("multiple live pids stay occupied, warn once and retry without takeover", async t => {
  const h = harness(t);
  await h.emit("session_start");
  const original = h.holder();
  h.occupancy.register(original.sessionId, process.pid + 1, "other-pid", 500);
  await h.emit("agent_settled");
  assert.match(h.warnings[0]!, /multiple-live-holders/);
  for (let i = 0; i < 3; i++) await h.advance(5000);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.registrations(), 4, "at most one registration per backoff");
  assert.equal(h.puts.length, 0);
  assert.equal(h.occupancy.snapshot().length, 2);
  assert.ok(h.occupancy.snapshot().some(row => row.pid === process.pid + 1 && row.holderToken === "other-pid"));
});

test("retired bindings ignore delayed offers and compensate delayed recovery registration", async t => {
  const h = harness(t);
  await h.emit("session_start");
  h.revoke();
  let release: (() => void) | undefined;
  root.schedulerHolderTest.send = body => {
    const reply = h.apply(body);
    return body.type === "injection.offers" ? new Promise(resolve => { release = () => resolve(reply); }) : Promise.resolve(reply);
  };
  await h.emit("agent_settled");
  assert.ok(release);
  await h.emit("session_shutdown");
  release(); await flush(); await h.advance(10000);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.registrations(), 1, "late rejection cannot schedule recovery after retirement");
  root.schedulerHolderTest.send = async body => h.apply(body);
  await h.emit("session_start");
  h.revoke(); await h.emit("agent_settled");
  root.schedulerHolderTest.send = body => {
    if (body.type === "occupancy.register") return new Promise(resolve => { release = () => resolve(h.apply(body)); });
    return Promise.resolve(h.apply(body));
  };
  await h.advance(5000);
  await h.emit("session_shutdown");
  release!(); await flush(); await h.advance(10000);
  assert.equal(h.occupancy.snapshot().length, 0, "late registration is compensated with the exact retired identity");
  assert.equal(h.registrations(), 3);
  assert.equal(h.warnings.length, 1);
});
