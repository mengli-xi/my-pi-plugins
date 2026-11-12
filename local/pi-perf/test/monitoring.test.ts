import { PI_VERSION } from "./history-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piPerf from "../index.ts";
import { PerfHistory } from "../src/history.ts";
import { PerfConfig } from "../src/config.ts";
import { getTelemetryRegistry } from "../src/telemetry.ts";
import { firstObservedFrame } from "../src/first-observed-frame.ts";

function harness(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "perf-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  Reflect.deleteProperty(globalThis, Symbol.for("pi.perf.startup-observed-frame.v1"));
  Reflect.deleteProperty(globalThis, Symbol.for("pi.perf.package-inventory.v1"));
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, Function[]>();
  let command: any;
  const notifications: string[] = [];
  class Tui { requestRender() {} doRender() {} handleTerminalInput() {} }
  const tui = new Tui();
  let widget: any;
  const ctx = { cwd: root, mode: "tui", sessionManager: { getSessionId: () => "opaque", getEntries: () => [] }, getContextUsage: () => ({ tokens: 123 }),
    ui: { notify: (message: string) => notifications.push(message), onTerminalInput: () => () => {},
      setWidget: (_key: string, factory: any) => { widget?.dispose?.(); widget = factory?.(tui); } } };
  const pi = { on: (name: string, handler: Function) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    getAllTools: () => [], getCommands: () => [], events: { on: () => () => {} }, getSettings: () => ({ packages: ["/private/user/plugin"] }), registerCommand: (_name: string, value: any) => { command = value; } };
  return { root, pi, ctx, tui, notifications,
    emit: async (name: string, reason = "startup") => { for (const handler of handlers.get(name) ?? []) await handler({ reason }, ctx); },
    run: async (value: string) => command.handler(value, ctx) };
}
test("default minute monitoring, cold-start phases and first observed frame, opt-in detail, persistent off, reload safety", async t => {
  const h = harness(t); piPerf(h.pi as any);
  assert.equal(getTelemetryRegistry().getStatus().enabled, false);
  const original = h.tui.doRender;
  await h.emit("session_start"); assert.notEqual(h.tui.doRender, original);
  h.tui.doRender(); assert.equal(h.tui.doRender, original, "one-shot observed frame restores instance");
  await h.run("on"); assert.equal(getTelemetryRegistry().getStatus().enabled, true);
  await h.run("off"); assert.equal(getTelemetryRegistry().getStatus().enabled, false);
  assert.equal(new PerfConfig(h.root).enabled, false);
  await h.emit("session_shutdown");
  const raw = readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8");
  assert.ok(!raw.includes("/private/user"));
  const records = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.filter(row => row.kind === "session").length, 1);
  assert.equal(records.filter(row => row.values.readyMs !== undefined).length, 1);
  assert.equal(records.filter(row => row.values.firstObservedFrameMs !== undefined).length, 1);
  assert.ok(records.find(row => row.values.readyMs !== undefined).values.extensionToReadyMs >= 0);
  // Same process reload must not start detailed probes or re-label startup.
  piPerf(h.pi as any); await h.emit("session_start");
  await h.emit("session_shutdown");
  assert.equal(getTelemetryRegistry().getStatus().enabled, false);
  assert.equal(readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8"), raw);
});
test("/perf surfaces log write failure, rejects unknown commands, and shares finite completions", async t => {
  const h = harness(t);
  mkdirSync(join(h.root, "perf")); writeFileSync(join(h.root, "perf/ui.jsonl"), "");
  // A directory at the log path makes buffered writes fail deterministically.
  rmSync(join(h.root, "perf/ui.jsonl")); mkdirSync(join(h.root, "perf/ui.jsonl"));
  piPerf(h.pi as any); await h.emit("session_start"); await h.run("on");
  const { publishUiMetric } = await import("../src/ui-metrics.ts");
  publishUiMetric("render", 100);
  await h.run("log"); assert.ok(h.notifications.some(value => value.includes("log write failed")));
  await h.run("unknown"); assert.match(h.notifications.at(-1)!, /用法/);
  await h.run("7d"); assert.match(h.notifications.at(-1)!, /插件组合/);
  await h.run("30d"); assert.match(h.notifications.at(-1)!, /冷启动/);
  await h.emit("session_shutdown");
});
test("first-observed-frame hook releases on dispose and preserves original exceptions", () => {
  let paints = 0;
  const original = () => { throw new Error("original failure"); };
  const target = { doRender: original };
  firstObservedFrame(target, () => paints++);
  assert.throws(() => target.doRender(), /original failure/);
  assert.equal(target.doRender, original); assert.equal(paints, 0);
  const release = firstObservedFrame(target, () => paints++); release(); release();
  assert.equal(target.doRender, original);
});
test("legacy v2 conflict also refuses the low-frequency first-observed-frame hook", async t => {
  const h = harness(t);
  const host = globalThis as Record<PropertyKey, unknown>;
  const v3 = Symbol.for("pi.perf.ui-metrics.v3"), v2 = Symbol.for("pi.perf.ui-metrics.v2");
  const existing = host[v3]; delete host[v3]; host[v2] = { version: 2 };
  try {
    piPerf(h.pi as any); const original = h.tui.doRender;
    await h.emit("session_start");
    assert.equal(h.tui.doRender, original);
    assert.ok(h.notifications.some(value => value.includes("legacy")));
    await h.emit("session_shutdown");
  } finally { delete host[v2]; host[v3] = existing; }
});


test("default runtime takeover retires old resources without starting timeline timers", async t => {
  const h = harness(t); piPerf(h.pi as any); await h.emit("session_start"); h.tui.doRender();
  piPerf(h.pi as any); await h.emit("session_start");
  assert.equal(getTelemetryRegistry().getStatus().enabled, false);
  await delay(300);
  await h.run("export");
  const reports = join(h.root, "perf/reports");
  const html = readFileSync(join(reports, readdirSync(reports)[0]), "utf8");
  const data = JSON.parse(html.match(/<script id="perf-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
  assert.deepEqual(data.timeline, []);
  await h.emit("session_shutdown");
  const raw = readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8");
  assert.equal(raw.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.values.readyMs !== undefined).length, 1);
});


test("late installation and enabling after startup never produce cold-start records", async t => {
  const h = harness(t);
  new PerfConfig(h.root).setEnabled(false);
  piPerf(h.pi as any); await h.emit("session_start", "startup");
  await h.run("on"); h.tui.doRender(); await h.emit("session_shutdown");
  for (const reason of ["reload", "new", "resume", "fork"]) {
    piPerf(h.pi as any); await h.emit("session_start", reason); h.tui.doRender();
    await h.emit("session_shutdown");
  }
  const records = readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.every(row => row.kind !== "startup"));
  assert.ok(records.every(row => row.mode === "tui"));
});
test("default /perf shows trends without empty detailed tables; enabling shows them", async t => {
  const h = harness(t); piPerf(h.pi as any); await h.emit("session_start"); h.tui.doRender();
  await h.run(""); assert.match(h.notifications.at(-1)!, /最近 7 天/); assert.doesNotMatch(h.notifications.at(-1)!, /UI latency|Plugin spans/);
  await h.run("on"); await h.run(""); assert.match(h.notifications.at(-1)!, /UI latency/);
  assert.match(h.notifications.at(-1)!, /本分钟窗口/);
  await h.emit("session_shutdown");
});


test("/perf keeps good trend rows and reports skipped daily files", async t => {
  const h = harness(t); piPerf(h.pi as any); await h.emit("session_start"); h.tui.doRender();
  await h.run("7d");
  const daily = join(h.root, "perf/daily", readdirSync(join(h.root, "perf/daily"))[0]);
  await writeFile(join(daily, "invalid.json"), "{}");
  await h.run("7d");
  assert.match(h.notifications.at(-1)!, /跳过 1 个/); assert.ok(h.notifications.at(-1)!.includes(PI_VERSION));
  await h.emit("session_shutdown");
});


for (const mode of ["rpc", "print", "json"]) test(`${mode} startup records its own mode but never a TUI paint`, async t => {
  const h = harness(t); h.ctx.mode = mode;
  let maintenanceCalls = 0;
  t.mock.method(PerfHistory.prototype, "scheduleCleanup", () => { maintenanceCalls++; return () => {}; });
  piPerf(h.pi as any); await h.emit("session_start"); await h.emit("session_shutdown");
  const records = readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.every(row => row.mode === mode));
  assert.equal(maintenanceCalls, 0);
  assert.equal(existsSync(join(h.root, "perf/.maintenance")), false);
  assert.equal(records.filter(row => row.values.readyMs !== undefined).length, 1);
  assert.ok(records.every(row => row.values.firstObservedFrameMs === undefined));
});


test("session_start returns before package I/O and tolerates unavailable session IDs", async t => {
  const h = harness(t);
  h.ctx.sessionManager.getSessionId = () => { throw new Error("not available"); };
  piPerf(h.pi as any);
  await h.emit("session_start");
  const cell = (globalThis as any)[Symbol.for("pi.perf.package-inventory.v1")];
  let parsed = false; void cell.result.then(() => { parsed = true; });
  await Promise.resolve(); assert.equal(parsed, false, "session handler must not await manifest parsing");
  h.tui.doRender(); await h.emit("session_shutdown");
  const records = readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.every(row => Number.isFinite(row.packageResolveMs)));
});
test("top, memory and log do not open daily trends", async t => {
  const h = harness(t); piPerf(h.pi as any); await h.emit("session_start");
  const { PerfHistory } = await import("../src/history.ts");
  const original = PerfHistory.prototype.trends;
  let calls = 0;
  PerfHistory.prototype.trends = async () => { calls++; throw new Error("must not be read"); };
  try { for (const command of ["top", "memory", "log"]) await h.run(command); assert.equal(calls, 0); }
  finally { PerfHistory.prototype.trends = original; await h.emit("session_shutdown"); }
});


test("ambiguous relative settings package roots cannot adopt a user's project name", async t => {
  const h = harness(t);
  writeFileSync(join(h.root, "package.json"), '{"name":"private-project-name"}');
  h.pi.getSettings = () => ({ packages: ["."] });
  piPerf(h.pi as any); await h.emit("session_start"); await h.emit("session_shutdown");
  const records = readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.every(row => row.packages.join(",") === "local"));
});


test("maintenance is first scheduled by a TUI context, not factory construction", async t => {
  const h = harness(t); let scheduled = 0, stopped = 0;
  t.mock.method(PerfHistory.prototype, "scheduleCleanup", () => { scheduled++; return () => { stopped++; }; });
  piPerf(h.pi as any); assert.equal(scheduled, 0);
  await h.emit("session_start"); assert.equal(scheduled, 1);
  await h.emit("session_shutdown"); assert.equal(stopped, 1);
});
test("reload with changed package roots gets a new identity", async t => {
  const h = harness(t), first = join(h.root, "first"), second = join(h.root, "second");
  for (const [directory, name] of [[first, "plugin-first"], [second, "plugin-second"]]) {
    mkdirSync(directory); writeFileSync(join(directory, "package.json"), JSON.stringify({ name }));
  }
  h.pi.getSettings = () => ({ packages: [first] });
  piPerf(h.pi as any); await h.emit("session_start"); await h.run("log"); await h.emit("session_shutdown");
  h.pi.getSettings = () => ({ packages: [second] });
  piPerf(h.pi as any); await h.emit("session_start", "reload"); await h.emit("session_shutdown");
  const records = readFileSync(join(h.root, "perf/raw", readdirSync(join(h.root, "perf/raw"))[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.some(row => row.packages.includes("plugin-first")));
  assert.ok(records.some(row => row.packages.includes("plugin-second")));
});
test("/perf shows persisted maintenance failures without running maintenance", async t => {
  const h = harness(t); mkdirSync(join(h.root, "perf/.maintenance"), { recursive: true });
  writeFileSync(join(h.root, "perf/.maintenance/state.json"), JSON.stringify({ errorCount: 1,
    failedDays: { "2026-11-01": "summary.jsonl quarantined as summary.jsonl.bad: invalid JSON" } }));
  piPerf(h.pi as any); await h.emit("session_start"); await h.run("log");
  assert.ok(h.notifications.some(message => message.includes("summary.jsonl.bad") && message.includes("invalid JSON")));
  await h.emit("session_shutdown");
});
