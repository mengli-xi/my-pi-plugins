import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PI_VERSION, readyHistory } from "./history-fixture.ts";
import { JsonlWriter } from "../src/log-writer.ts";
import { DAY_MS, packageHash } from "../src/history.ts";
import { writePerfReport, type PerfReportData } from "../src/html-report.ts";

test("JSONL and HTML use private directories/files, including existing permissive output", async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-modes-"));
  try {
    const path = join(root, "perf/ui.jsonl"); await mkdir(join(root, "perf"), { mode: 0o755 });
    await writeFile(path, "", { mode: 0o644 });
    const writer = new JsonlWriter(path); writer.write({ metric: 1 }); await writer.flush();
    assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(join(root, "perf"))).mode & 0o777, 0o700);
    const report = join(root, "perf/reports/existing.html"); await mkdir(join(root, "perf/reports"));
    await writeFile(report, "old"); await chmod(report, 0o644);
    // Empty arrays are valid for this rendering-only boundary test.
    const point = { at: 0, rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 };
    const data: PerfReportData = { generatedAt: 0, sessionId: "", monitoringEnabled: false, uiMetrics: [],
      memory: { current: point, start: point, peak: point }, eventLoop: { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, utilization: 0 },
      telemetry: { at: 0, owners: [], measures: [], observations: [], counters: [], gauges: [] },
      instrumentation: { frame: false, request: false, input: false }, timeline: [] };
    await writePerfReport(data, report);
    assert.equal((await stat(report)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "perf/reports"))).mode & 0o777, 0o700);
    assert.match(await readFile(report, "utf8"), /<!doctype html>/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("startup cleanup reclaims stale temporaries without unlinking live writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-temp-")), now = Date.now();
  try {
    const dir = join(root, "daily/2026-11-12"); await mkdir(dir, { recursive: true });
    for (const name of ["dead.2147483647.tmp", `live.${process.pid}.tmp`, "legacy.tmp", "recent.tmp"]) await writeFile(join(dir, name), "partial");
    await utimes(join(dir, "legacy.tmp"), new Date(now - 2 * DAY_MS), new Date(now - 2 * DAY_MS));
    await writeFile(join(root, "ui.jsonl"), "old", { mode: 0o644 });
    await mkdir(join(root, "reports"), { mode: 0o755 });
    await writeFile(join(root, "reports/old.html"), "old", { mode: 0o644 });
    const history = readyHistory(root, { pid: process.pid, piVersion: PI_VERSION, packagesHash: packageHash([]), packages: [], mode: "tui" });
    await history.cleanup(now); assert.equal(history.error, undefined);
    assert.equal((await stat(join(root, "ui.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "reports/old.html"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "reports"))).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(dir)).sort(), [`live.${process.pid}.tmp`, "recent.tmp"].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
