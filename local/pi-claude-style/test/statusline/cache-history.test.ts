import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCacheHistory,
  applyCacheHistoryEntry,
  cacheHistorySnapshot,
  createCacheHistoryState,
} from "../../src/statusline/cache-history.ts";

function assistant(
  id: string,
  timestamp: number,
  usage: { input: number; cacheRead: number; cacheWrite: number },
  model = "model-a",
  provider = "provider-a",
) {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      stopReason: "stop",
      timestamp,
      provider,
      model,
      usage: { ...usage, output: 1, totalTokens: 1, cost: {} },
    },
  };
}

test("derives CH, RU, miss and weighted summaries from successful assistant requests", () => {
  const history = analyzeCacheHistory([
    assistant("a", 1_000, { input: 20, cacheRead: 80, cacheWrite: 0 }),
    assistant("b", 2_000, { input: 10, cacheRead: 90, cacheWrite: 0 }),
    assistant("c", 3_000, { input: 50, cacheRead: 50, cacheWrite: 0 }),
  ]);

  assert.equal(history.summary.requestCount, 3);
  assert.equal(history.summary.weightedHitPercent, 220 / 300 * 100);
  assert.equal(history.summary.weightedReusePercent, 140 / 200 * 100);
  assert.deepEqual(history.samples.map((sample) => ({
    ordinal: sample.ordinal,
    hit: sample.hitPercent,
    reuse: sample.reusePercent,
    miss: sample.missTokens,
  })), [
    { ordinal: 1, hit: 80, reuse: undefined, miss: undefined },
    { ordinal: 2, hit: 90, reuse: 90, miss: 10 },
    { ordinal: 3, hit: 50, reuse: 50, miss: 50 },
  ]);
});

test("compaction resets reuse while model changes stay measurable and marked", () => {
  const history = analyzeCacheHistory([
    assistant("a", 1_000, { input: 2_000, cacheRead: 8_000, cacheWrite: 0 }),
    assistant("b", 2_000, { input: 8_000, cacheRead: 2_000, cacheWrite: 0 }, "model-b"),
    { type: "compaction", id: "compact" },
    assistant("c", 3_000, { input: 4_000, cacheRead: 6_000, cacheWrite: 0 }, "model-b"),
  ]);

  assert.equal(history.samples[1]?.modelChanged, true);
  assert.equal(history.samples[1]?.significantMiss, true);
  assert.equal(history.samples[1]?.missTokens, 8_000);
  assert.equal(history.samples[2]?.reusePercent, undefined);
  assert.equal(history.samples[2]?.baselineReset, "compaction");
});

test("compares model changes across consecutive provider requests", () => {
  const history = analyzeCacheHistory([
    assistant("a", 1_000, { input: 2_000, cacheRead: 8_000, cacheWrite: 0 }),
    { type: "message", id: "user", message: { role: "user", content: "next" } },
    { type: "message", id: "tool", message: { role: "toolResult", toolName: "read" } },
    assistant("b", 2_000, { input: 1_000, cacheRead: 9_000, cacheWrite: 0 }, "model-b"),
  ]);

  assert.equal(history.samples.length, 2);
  assert.equal(history.samples[1]?.modelChanged, true);
  assert.equal(history.samples[1]?.reusePercent, 90);
});

test("leaves reuse unobservable until cache activity has been reported", () => {
  const unsupported = analyzeCacheHistory([
    assistant("a", 1_000, { input: 10_000, cacheRead: 0, cacheWrite: 0 }),
    assistant("b", 2_000, { input: 10_000, cacheRead: 0, cacheWrite: 0 }),
  ]);
  assert.equal(unsupported.samples[1]?.hitPercent, 0);
  assert.equal(unsupported.samples[1]?.reusePercent, undefined);
  assert.equal(unsupported.samples[1]?.missTokens, undefined);
  assert.equal(unsupported.summary.weightedReusePercent, undefined);

  const observable = analyzeCacheHistory([
    assistant("a", 1_000, { input: 2_000, cacheRead: 8_000, cacheWrite: 0 }),
    assistant("b", 2_000, { input: 10_000, cacheRead: 0, cacheWrite: 0 }),
  ]);
  assert.equal(observable.samples[1]?.reusePercent, 0);
  assert.equal(observable.samples[1]?.missTokens, 10_000);
  assert.equal(observable.samples[1]?.significantMiss, true);
});

test("incremental analysis matches a complete branch scan", () => {
  const entries = [
    assistant("a", 1_000, { input: 4_000, cacheRead: 6_000, cacheWrite: 0 }),
    assistant("b", 500_000, { input: 500, cacheRead: 9_500, cacheWrite: 0 }),
    assistant("ignored", 600_000, { input: 1, cacheRead: 0, cacheWrite: 0 }),
  ];
  entries[2]!.message.stopReason = "error";
  const state = createCacheHistoryState();
  for (const entry of entries) applyCacheHistoryEntry(state, entry);
  assert.deepEqual(cacheHistorySnapshot(state), analyzeCacheHistory(entries));
  assert.equal(cacheHistorySnapshot(state).samples[1]?.idleMs, 499_000);
});

test("bounds retained samples without losing full-branch weighted totals", () => {
  const entries = Array.from({ length: 125 }, (_, index) => assistant(
    `entry-${index + 1}`,
    index * 1_000,
    { input: 20, cacheRead: 80, cacheWrite: 0 },
  ));
  const history = analyzeCacheHistory(entries);
  assert.equal(history.samples.length, 120);
  assert.equal(history.samples[0]?.ordinal, 6);
  assert.equal(history.latest?.ordinal, 125);
  assert.equal(history.summary.requestCount, 125);
  assert.equal(history.summary.retainedCount, 120);
  assert.equal(history.summary.totalInputTokens, 2_500);
  assert.equal(history.summary.totalCacheReadTokens, 10_000);
  assert.equal(history.summary.weightedHitPercent, 80);
});
