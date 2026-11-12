import assert from "node:assert/strict";
import test from "node:test";
import { getTelemetryRegistry, type TelemetrySample } from "../src/telemetry.ts";

let sequence = 0;

function enabledRegistry() {
  const registry = getTelemetryRegistry();
  const provider = `telemetry-test-provider-${++sequence}`;
  registry.setEnabled(true, provider);
  registry.resetAll(provider);
  return { registry, provider };
}

test("aggregates measures, observations, counters, and gauges by producer", () => {
  const { registry, provider } = enabledRegistry();
  const first = registry.acquireReporter("plugin-a");
  const second = registry.acquireReporter("plugin-b");
  first.reporter.configure({ sampleWindow: 16 });
  first.reporter.measure("render", 4);
  first.reporter.measure("render", 12);
  first.reporter.observe("batch", 5, "chars");
  first.reporter.increment("hits", 2);
  first.reporter.gauge("backlog", 20, "chars");
  first.reporter.gauge("backlog", 3, "chars");
  second.reporter.measure("restore", 8);

  const firstSnapshot = registry.snapshot("plugin-a");
  assert.deepEqual(firstSnapshot.owners, ["plugin-a"]);
  assert.deepEqual(firstSnapshot.measures[0], {
    owner: "plugin-a",
    name: "render",
    count: 2,
    lastMs: 12,
    p50Ms: 4,
    p95Ms: 12,
    maxMs: 12,
  });
  assert.equal(firstSnapshot.observations[0]?.last, 5);
  assert.equal(firstSnapshot.counters[0]?.value, 2);
  assert.deepEqual(firstSnapshot.gauges[0], {
    owner: "plugin-a",
    name: "backlog",
    value: 3,
    peak: 20,
    unit: "chars",
  });
  assert.deepEqual(registry.snapshot().owners, ["plugin-a", "plugin-b"]);

  first.release();
  second.release();
  registry.setEnabled(false, provider);
});

test("provider disable makes existing reporters no-op", () => {
  const { registry, provider } = enabledRegistry();
  const handle = registry.acquireReporter("plugin-disabled");
  handle.reporter.measure("before", 3);
  registry.setEnabled(false, provider);
  handle.reporter.measure("after", 9);
  assert.deepEqual(registry.snapshot("plugin-disabled").measures.map(({ name }) => name), ["before"]);
  handle.release();
});

test("producer reset cannot erase another producer", () => {
  const { registry, provider } = enabledRegistry();
  const first = registry.acquireReporter("plugin-reset-a");
  const second = registry.acquireReporter("plugin-reset-b");
  first.reporter.measure("work", 1);
  second.reporter.measure("work", 2);
  registry.reset("plugin-reset-a");
  assert.equal(registry.snapshot("plugin-reset-a").measures.length, 0);
  assert.equal(registry.snapshot("plugin-reset-b").measures.length, 1);
  first.release();
  second.release();
  registry.setEnabled(false, provider);
});

test("observers receive sanitized metadata and producer log policy", () => {
  const { registry, provider } = enabledRegistry();
  const samples: TelemetrySample[] = [];
  const unsubscribe = registry.acquireObserver("test-observer", (sample) => samples.push(sample));
  const handle = registry.acquireReporter("plugin-observed");
  handle.reporter.configure({ logEnabled: true, slowSampleMs: 7 });
  handle.reporter.measure("work", 9, {
    phase: "render",
    count: 4,
    ignored: Number.NaN,
  });
  assert.deepEqual(samples, [{
    owner: "plugin-observed",
    kind: "measure",
    name: "work",
    value: 9,
    unit: "ms",
    attributes: { phase: "render", count: 4 },
    logEnabled: true,
    slowSampleMs: 7,
  }]);
  unsubscribe();
  handle.release();
  registry.setEnabled(false, provider);
});
