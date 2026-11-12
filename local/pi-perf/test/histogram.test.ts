import assert from "node:assert/strict";
import test from "node:test";
import { addValue, BUCKET_COUNT, emptyHistogram, histogramDistribution, mergeHistogram, parseHistogram } from "../src/histogram.ts";

test("log histogram merges with bounded quantile error and fixed space", () => {
  const a = emptyHistogram(), b = emptyHistogram(), all = emptyHistogram();
  const values = Array.from({ length: 20_000 }, (_, i) => 10 ** (-2 + i / 2000));
  for (let i = 0; i < values.length; i++) { addValue(i % 2 ? a : b, values[i]); addValue(all, values[i]); }
  mergeHistogram(a, b);
  assert.deepEqual(a.bins, all.bins);
  const result = histogramDistribution(a);
  for (const [p, actual] of [[.5, result.p50], [.95, result.p95]]) {
    const exact = values[Math.ceil(values.length * p) - 1];
    assert.ok(Math.abs(actual / exact - 1) <= .025, `${actual} vs ${exact}`);
  }
  assert.equal(result.count, values.length); assert.equal(result.max, values.at(-1));
  assert.ok(Object.keys(a.bins).length <= BUCKET_COUNT);
  const size = JSON.stringify(a).length;
  for (let i = 0; i < 100_000; i++) addValue(a, 100);
  assert.ok(JSON.stringify(a).length < size + 100, "space cannot grow with sample count");
  assert.deepEqual(parseHistogram(a), a);
});
test("invalid persisted histogram counts and bucket identities are rejected", () => {
  const histogram = emptyHistogram(); addValue(histogram, 1);
  assert.throws(() => parseHistogram({ ...histogram, count: 2 }));
  assert.throws(() => parseHistogram({ ...histogram, bins: { [BUCKET_COUNT]: 1 } }));
  assert.throws(() => parseHistogram({ ...histogram, min: -1 }));
});


test("invalid observations cannot poison a histogram", () => {
  const histogram = emptyHistogram(); addValue(histogram, 12);
  const before = structuredClone(histogram);
  for (const value of [NaN, Infinity, -Infinity, -1]) addValue(histogram, value);
  assert.deepEqual(histogram, before);
});
