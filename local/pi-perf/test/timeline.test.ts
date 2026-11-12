import assert from "node:assert/strict";
import test from "node:test";
import { PerfTimeline } from "../src/timeline.ts";

test("timeline is a fixed-capacity chronological ring", () => {
  let now = 100;
  const timeline = new PerfTimeline(3, () => now++);
  for (let value = 1; value <= 5; value++) {
    timeline.add({ source: "ui", owner: "pi", metric: "render", value, unit: "ms" });
  }
  assert.equal(timeline.length, 3);
  assert.deepEqual(timeline.snapshot().map(({ at, value }) => ({ at, value })), [
    { at: 102, value: 3 },
    { at: 103, value: 4 },
    { at: 104, value: 5 },
  ]);
});

test("timeline keeps only bounded scalar metadata", () => {
  const timeline = new PerfTimeline(2, () => 50);
  timeline.add({
    source: "plugin",
    owner: " plugin ",
    metric: "work",
    value: 4,
    unit: "ms",
    interaction: 7.8,
    attributes: {
      phase: "x".repeat(300),
      count: 2,
      active: true,
      ignored: { content: "secret" },
      invalid: Number.NaN,
    },
  });
  const row = timeline.snapshot()[0]!;
  assert.equal(row.owner, "plugin");
  assert.equal(row.interaction, 7);
  assert.deepEqual(row.attributes, {
    phase: "x".repeat(160),
    count: 2,
    active: true,
  });
  row.attributes!.phase = "mutated";
  assert.notEqual(timeline.snapshot()[0]?.attributes?.phase, "mutated");
});

test("clear releases retained samples", () => {
  const timeline = new PerfTimeline(2);
  timeline.add({ source: "runtime", owner: "runtime", metric: "rss", value: 1, unit: "bytes" });
  timeline.clear();
  assert.equal(timeline.length, 0);
  assert.deepEqual(timeline.snapshot(), []);
});
