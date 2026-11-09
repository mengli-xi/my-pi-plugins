import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CcStyleObservability } from "../src/observability.ts";

function observer() {
  return { now: () => performance.now(), record: () => {}, painted: () => {} };
}

class FakeTui {
  requestRender(): void {}
  doRender(): void {}
  handleTerminalInput(_data: string): void {}
}

test("pi-perf owns the TUI wrapper while cc-style is an independent telemetry producer", async (t) => {
  const providerUrl = new URL("../../pi-perf/src/ui-metrics.ts", import.meta.url);
  if (!existsSync(fileURLToPath(providerUrl))) {
    t.skip("optional sibling pi-perf package is not present");
    return;
  }
  const {
    deactivateUiInstrumentation,
    getUiObservabilityRegistry,
    installUiInstrumentation,
  } = await import(providerUrl.href);
  const telemetryUrl = new URL("../../pi-perf/src/telemetry.ts", import.meta.url);
  const { getTelemetryRegistry } = await import(telemetryUrl.href);
  const registry = getUiObservabilityRegistry();
  const telemetry = getTelemetryRegistry();
  registry.setEnabled?.(true, "integration-test");
  telemetry.setEnabled(true, "integration-test");
  const tui = new FakeTui();
  const providerObserver = observer();
  installUiInstrumentation(tui as any, providerObserver);
  const wrapped = FakeTui.prototype.doRender;
  installUiInstrumentation(tui as any, providerObserver);
  assert.equal(FakeTui.prototype.doRender, wrapped);

  const consumer = new CcStyleObservability();
  consumer.configure({ enabled: true, logEnabled: false, sampleWindow: 32, slowSampleMs: 50 });
  assert.deepEqual(registry.snapshot().owners, ["pi-perf"]);
  assert.deepEqual(telemetry.snapshot().owners, ["pi-claude-style"]);

  await consumer.dispose();
  assert.deepEqual(registry.snapshot().owners, ["pi-perf"]);
  assert.deepEqual(telemetry.snapshot().owners, []);
  assert.equal(FakeTui.prototype.doRender, wrapped);

  const secondConsumer = new CcStyleObservability();
  secondConsumer.configure({ enabled: true, logEnabled: false, sampleWindow: 32, slowSampleMs: 50 });
  deactivateUiInstrumentation(providerObserver);
  assert.deepEqual(registry.snapshot().owners, []);
  assert.deepEqual(telemetry.snapshot().owners, ["pi-claude-style"]);
  assert.equal(FakeTui.prototype.doRender, wrapped);
  await secondConsumer.dispose();
  registry.setEnabled?.(false, "integration-test");
  telemetry.setEnabled(false, "integration-test");
});
