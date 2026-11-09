import assert from "node:assert/strict";
import test from "node:test";
import { spinnerFrameIndex, workingTickMs } from "../src/working.ts";

test("one working clock follows the faster configured visual", () => {
  assert.equal(workingTickMs({ refreshMs: 150, spinnerIntervalMs: 180 }), 150);
  assert.equal(workingTickMs({ refreshMs: 500, spinnerIntervalMs: 120 }), 120);
});

test("spinner phase follows wall time and skips delayed frames", () => {
  assert.equal(spinnerFrameIndex(10, 120, 0), 0);
  assert.equal(spinnerFrameIndex(10, 120, 119), 0);
  assert.equal(spinnerFrameIndex(10, 120, 120), 1);
  assert.equal(spinnerFrameIndex(10, 120, 1_440), 2);
});
