import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { excessLoopDelay, LowFrequencySampler } from "../src/sampler.ts";

test("sampler records memory, CPU differences, loop percentiles and available session sizes", async () => {
  const rows: any[] = [];
  const sampler = new LowFrequencySampler(sample => rows.push(sample), () => ({ entries: 42, contextTokens: 1234 }));
  assert.equal(sampler.interval, 60_000);
  sampler.start(); sampler.start();
  try {
    await delay(60);
    const end = performance.now() + 60; while (performance.now() < end) Math.sqrt(performance.now());
    await delay(25);
    const sample = sampler.sample();
    assert.ok(sample.rss > 0 && sample.heapUsed > 0 && sample.heapTotal >= sample.heapUsed && sample.external > 0);
    assert.equal(sample.entries, 42); assert.equal(sample.contextTokens, 1234);
    assert.ok(sample.cpuPercent > 0); assert.ok(sample.loopMaxMs > 40);
    assert.ok(sample.loopP99Ms >= sample.loopP50Ms);
    const reset = sampler.sample(); assert.equal(reset.loopMaxMs, 0);
    assert.equal(rows.length, 2);
  } finally { sampler.stop(); sampler.stop(); }
});
test("timer boundary isolates session API failure, and stop releases future ticks", async () => {
  let calls = 0;
  const rows: any[] = [];
  const sampler = new LowFrequencySampler(sample => rows.push(sample), () => { calls++; throw new Error("unavailable"); }, 10);
  sampler.start(); await delay(40); sampler.stop();
  assert.match(sampler.error!, /session size unavailable: Error/);
  assert.ok(rows.length > 0 && rows[0].rss > 0);
  assert.equal(rows[0].entries, undefined);
  const stopped = calls; await delay(30); assert.equal(calls, stopped);
});


test("event-loop metrics are excess over resolution, clipped to zero", () => {
  assert.equal(excessLoopDelay(20e6), 0); assert.equal(excessLoopDelay(19e6), 0);
  assert.equal(excessLoopDelay(21e6), 1); assert.equal(excessLoopDelay(50e6), 30);
  assert.equal(excessLoopDelay(NaN), 0);
});
test("minute and detail callbacks share a single memory read when their ticks coincide", async () => {
  let reads = 0; const samples: number[] = [], details: number[] = [];
  const sampler = new LowFrequencySampler(sample => samples.push(sample.rss), () => ({}), 20,
    () => ({ rss: ++reads, heapUsed: 1, heapTotal: 2, external: 0, arrayBuffers: 0, at: Date.now() }));
  sampler.start(); sampler.setDetail(10, point => details.push(point.rss));
  try { await delay(100); } finally { sampler.stop(); }
  assert.ok(samples.length >= 2 && details.length >= 2);
  assert.ok(samples.some(value => details.includes(value)), "the same point must feed both consumers");
  assert.ok(reads < samples.length + details.length);
});
