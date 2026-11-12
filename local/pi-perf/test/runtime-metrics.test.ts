import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, formatDelta, MemoryTracker } from "../src/runtime-metrics.ts";

test("memory tracker keeps baseline, current value, and per-field peaks", () => {
  const values: NodeJS.MemoryUsage[] = [
    { rss: 100, heapTotal: 80, heapUsed: 50, external: 10, arrayBuffers: 5 },
    { rss: 140, heapTotal: 90, heapUsed: 70, external: 8, arrayBuffers: 4 },
    { rss: 120, heapTotal: 85, heapUsed: 60, external: 20, arrayBuffers: 9 },
  ];
  let index = 0;
  const tracker = new MemoryTracker(() => values[Math.min(index++, values.length - 1)]!, () => index);
  tracker.sample();
  const summary = tracker.summary();
  assert.equal(summary.start.rss, 100);
  assert.equal(summary.current.rss, 120);
  assert.equal(summary.peak.rss, 140);
  assert.equal(summary.peak.external, 20);
});

test("byte values are readable and signed deltas keep their sign", () => {
  assert.equal(formatBytes(1024 ** 2), "1.0MB");
  assert.equal(formatDelta(1024 ** 2), "+1.0MB");
  assert.equal(formatDelta(-(1024 ** 2)), "-1.0MB");
});
