import assert from "node:assert/strict";
import { test } from "node:test";
import { deadline, deadlinePlan, fits, overThreshold, reserveForWindow, reserveThreshold, tokens } from "../src/budget.ts";
import { compactSections } from "../src/focus.ts";
test("90% is strict and integer-rounded; prefix/output/error margin all consume window", () => {
  assert.equal(reserveForWindow(128000), 12800);
  assert.equal(overThreshold(115200, 128000), false);
  assert.equal(overThreshold(115201, 128000), true);
  assert.equal(fits(115000, 4096, 128000), false);
  assert.ok(tokens("汉字🙂") >= 3);
});
test("reserve diagnostics derive the native boundary and first integer trigger without a fixed ratio label", () => {
  assert.deepEqual(reserveThreshold(500000, 16384), { comparison: ">", boundaryTokens: 483616, triggerTokens: 483617, ratio: 0.967232 });
  assert.equal(reserveThreshold(500000, 50000)?.triggerTokens, 450001);
  assert.equal(reserveThreshold(500000, 50001)?.triggerTokens, 450000);
  assert.equal(reserveThreshold(101, 11)?.triggerTokens, 91);
  for (const [window, reserve] of [[0, 10], [NaN, 10], [100, -1], [100, NaN]]) assert.equal(reserveThreshold(window!, reserve!), undefined);
});
test("deadline is input/output scaled and missing/stale/wrong concurrency uses conservative defaults", () => {
  const now = Date.now();
  const p = { version: "sample-1", measuredAt: new Date(now).toISOString(), inputTokensPerSecond: 100, outputTokensPerSecond: 10, safetyFactor: 2, cache: "cold" as const, concurrency: "single" as const };
  assert.equal(deadline(1000, 100, p, "single", now), 40000);
  assert.equal(deadline(2000, 100, p, "single", now), 60000);
  assert.ok(deadline(1, 1, undefined, "single") > 0);
  assert.ok(deadline(1, 1, p, "shadow") > 0);
  assert.ok(deadline(1, 1, p, "single", now + 8 * 86400000) > 0);
  assert.equal(deadlinePlan(1000,100,undefined,"single",now).throughputSource,"default");
  assert.equal(deadlinePlan(1000,100,p,"single",now+8*86400000).throughputSource,"stale");
  assert.ok(deadline(2000,100,undefined,"single")>deadline(1000,100,undefined,"single"));
});
test("Compact Instructions exclude code/quote examples and preserve duplicates/subheadings", () => {
  assert.deepEqual(compactSections('```md\n## Compact Instructions\nignore\n```\n> ## Compact Instructions\n> no\n\n    ## Compact Instructions\n\n## Compact Instructions\nfirst\n### Nested\nkeep\n## Other\nno\n## Compact Instructions\nsecond\n# Stop\nno'), ["first\n### Nested\nkeep", "second"]);
});
