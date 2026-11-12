import assert from "node:assert/strict";
import test from "node:test";
import { formatMs, percentile, SpanRecorder } from "../src/spans.ts";

/** A clock the test drives, so durations are exact rather than nearly right. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("a span measures the gap between begin and end", () => {
  const clock = fakeClock();
  const spans = new SpanRecorder(clock.now);
  spans.begin("send");
  clock.advance(120);
  assert.equal(spans.end("send"), 120);
  assert.equal(spans.stats()[0]?.count, 1);
});

test("ending a span that never began reports nothing rather than zero", () => {
  const spans = new SpanRecorder(fakeClock().now);
  assert.equal(spans.end("turn"), undefined);
  assert.deepEqual(spans.stats(), [], "a phantom span must not enter the statistics");
});

test("beginning twice measures from the later start", () => {
  const clock = fakeClock();
  const spans = new SpanRecorder(clock.now);
  spans.begin("send");
  clock.advance(500);
  spans.begin("send");
  clock.advance(10);
  assert.equal(spans.end("send"), 10);
});

test("an open span is visible, a closed one is not", () => {
  const spans = new SpanRecorder(fakeClock().now);
  assert.equal(spans.isOpen("turn"), false);
  spans.begin("turn");
  assert.equal(spans.isOpen("turn"), true);
  spans.end("turn");
  assert.equal(spans.isOpen("turn"), false);
});

test("statistics summarise every sample, percentiles the recent ones", () => {
  const spans = new SpanRecorder(fakeClock().now);
  for (const ms of [10, 20, 30, 40, 1000]) spans.record("send", ms);
  const [send] = spans.stats();
  assert.equal(send?.count, 5);
  assert.equal(send?.totalMs, 1100);
  assert.equal(send?.maxMs, 1000);
  assert.equal(send?.lastMs, 1000);
  assert.equal(send?.p50Ms, 30);
  assert.equal(send?.p95Ms, 1000);
});

test("the sample window is bounded, but count and max are not", () => {
  const spans = new SpanRecorder(fakeClock().now);
  spans.record("turn", 9999);
  for (let i = 0; i < 500; i++) spans.record("turn", 5);
  const [turn] = spans.stats();
  assert.equal(turn?.count, 501, "every sample is still counted");
  assert.equal(turn?.maxMs, 9999, "the worst one is never forgotten");
  assert.equal(turn?.p50Ms, 5, "percentiles follow the recent window");
});

test("spans are ranked by where the time actually went", () => {
  const spans = new SpanRecorder(fakeClock().now);
  spans.record("send", 50);
  spans.record("tool:read", 20);
  spans.record("tool:read", 20);
  spans.record("turn", 400);
  assert.deepEqual(spans.stats().map((row) => row.name), ["turn", "send", "tool:read"]);
});

test("reset clears samples and any span still open", () => {
  const spans = new SpanRecorder(fakeClock().now);
  spans.record("send", 10);
  spans.begin("turn");
  spans.reset();
  assert.deepEqual(spans.stats(), []);
  assert.equal(spans.isOpen("turn"), false);
});

test("nearest-rank percentiles name a real sample", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
});

test("durations read as milliseconds until they are worth reading as seconds", () => {
  assert.equal(formatMs(0), "0ms");
  assert.equal(formatMs(999), "999ms");
  assert.equal(formatMs(1000), "1.00s");
  assert.equal(formatMs(12_345), "12.3s");
});
