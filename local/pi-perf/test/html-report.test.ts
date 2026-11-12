import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserLaunchSpec, renderPerfReportHtml, renderTrendCharts, writePerfReport, type PerfReportData } from "../src/html-report.ts";

function fixture(): PerfReportData {
  const point = { at: 1000, rss: 200, heapUsed: 100, heapTotal: 120, external: 10, arrayBuffers: 5 };
  return {
    trends: [{ day: "2026-11-12", piVersion: "1.5.0", packagesHash: "abcd", packages: ["plugin-a"], mode: "tui", sessions: 2, startups: 1,
      metrics: { readyMs: { count: 1, p50: 300, p95: 300, max: 300, mean: 300 } } }],
    generatedAt: 1000,
    sessionId: "session</script><script>alert(1)</script>",
    monitoringEnabled: true,
    uiMetrics: [{ name: "render", count: 2, lastMs: 4, p50Ms: 3, p95Ms: 4, maxMs: 4 }],
    telemetry: {
      at: 1000,
      owners: ["plugin-a"],
      measures: [{ owner: "plugin-a", name: "layout", count: 1, lastMs: 2, p50Ms: 2, p95Ms: 2, maxMs: 2 }],
      observations: [],
      counters: [],
      gauges: [],
    },
    memory: { start: point, current: point, peak: point },
    eventLoop: { p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4, utilization: 0.1 },
    instrumentation: {
      frame: true,
      request: true,
      input: true,
      hostReloadCache: true,
      hostReloadCacheDetail: "host reload cache on",
    },
    timeline: [
      { at: 1000, source: "ui", owner: "pi", metric: "render", value: 4, unit: "ms", interaction: 7 },
      { at: 1000, source: "runtime", owner: "runtime", metric: "memory.rss", value: 200, unit: "bytes" },
    ],
  };
}

test("HTML report is self-contained, visual, and script-safe", () => {
  const html = renderPerfReportHtml(fixture());
  assert.match(html, /Timeline explorer/);
  assert.match(html, /长期趋势/);
  assert.match(html, /<svg role="img"/);
  assert.match(html, /<polyline/);
  const embedded = JSON.parse(html.match(/<script id="perf-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
  assert.equal(embedded.trends[0].metrics.readyMs.p95, 300);
  assert.equal(embedded.trends[0].packagesHash, "abcd");
  assert.match(html, /Interaction waterfall/);
  assert.match(html, /Plugin span ranking/);
  assert.match(html, /host reload cache on/);
  assert.match(html, /no network requests/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /session\\u003c\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);

  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
  const program = scripts.at(-1)?.[1] ?? "";
  const checked = spawnSync(process.execPath, ["--check", "-"], { input: program, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("writes a standalone report to the requested path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-perf-report-"));
  const path = join(directory, "nested", "report.html");
  try {
    assert.equal(await writePerfReport(fixture(), path), path);
    const html = await readFile(path, "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /plugin-a/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser launch keeps report paths as one argument", () => {
  const path = "/tmp/report with spaces.html";
  assert.deepEqual(browserLaunchSpec(path, "darwin"), { command: "open", args: [path] });
  assert.deepEqual(browserLaunchSpec(path, "linux"), { command: "xdg-open", args: [path] });
  assert.deepEqual(browserLaunchSpec(path, "win32"), { command: "cmd", args: ["/c", "start", "", path] });
});


test("long-term SVG lines preserve dates, modes and package identities and warn on skipped data", () => {
  const data = fixture();
  const base = data.trends![0];
  data.trends = [base, { ...base, day: "2026-11-13" }, { ...base, mode: "rpc" }];
  data.skippedDailyFiles = 2;
  data.maintenanceError = "summary.jsonl.bad: invalid JSON";
  const svg = renderTrendCharts(data.trends);
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2, "TUI and RPC must have separate startup lines");
  assert.match(svg, /2026-11-12/); assert.match(svg, /2026-11-13/);
  assert.match(svg, /tui/); assert.match(svg, /rpc/); assert.match(svg, /plugin-a/);
  const html = renderPerfReportHtml(data); assert.match(html, /跳过 2 个 daily 文件/);
  assert.match(html, /summary.jsonl.bad: invalid JSON/);
});
