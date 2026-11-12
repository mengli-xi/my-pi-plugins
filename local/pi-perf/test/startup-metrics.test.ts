import assert from "node:assert/strict";
import test from "node:test";
import {
  PI_PERF_LAUNCH_EPOCH_US,
  resolveStartupBoundaries,
} from "../src/startup-metrics.ts";

test("converts launcher epoch microseconds to the process monotonic clock", () => {
  const boundaries = resolveStartupBoundaries(
    { [PI_PERF_LAUNCH_EPOCH_US]: "1720000000123456" },
    1_720_000_000_100,
    1_720_000_000_500,
  );

  assert.equal(boundaries.processStartedAt, 0);
  assert.ok(Math.abs((boundaries.launcherStartedAt ?? 0) - 23.456) < 0.001);
});

test("rejects malformed, stale, and implausibly future launcher timestamps", () => {
  assert.equal(resolveStartupBoundaries({ [PI_PERF_LAUNCH_EPOCH_US]: "oops" }, 1_000, 2_000).launcherStartedAt, undefined);
  assert.equal(resolveStartupBoundaries({ [PI_PERF_LAUNCH_EPOCH_US]: "1000000000000" }, 0, 2_000_000_000).launcherStartedAt, undefined);
  assert.equal(resolveStartupBoundaries({ [PI_PERF_LAUNCH_EPOCH_US]: "2000000000000000" }, 0, 1_000_000_000_000).launcherStartedAt, undefined);
});
