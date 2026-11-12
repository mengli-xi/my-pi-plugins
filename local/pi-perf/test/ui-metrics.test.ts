import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { uiObserverDiagnostics, classifyInputAction, deactivateUiInstrumentation, PaintMarks, getUiObservabilityRegistry, installUiInstrumentation, publishUiMetric, UI_OBSERVABILITY_KEY, type UiMetricObserver } from "../src/ui-metrics.ts";

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    advance: (ms: number) => { value += ms; },
  };
}

test("an event is measured through the next completed frame", () => {
  const clock = fakeClock();
  const samples: Array<{ name: string; ms: number; coalesced?: number }> = [];
  const marks = new PaintMarks((name, ms, detail) => {
    samples.push({ name, ms, coalesced: detail?.coalesced });
  }, clock.now);
  marks.mark("message-update→paint");
  clock.advance(40);
  marks.mark("message-update→paint");
  clock.advance(10);
  marks.painted(clock.now());
  assert.deepEqual(samples, [{ name: "message-update→paint", ms: 50, coalesced: 2 }]);
});

test("live TUI wrappers separate render work from request-to-paint latency", () => {
	getUiObservabilityRegistry().setEnabled?.(true, "test-live-tui");
  const clock = fakeClock();
  const samples: Array<{ name: string; ms: number }> = [];
  let paints = 0;

  class FakeBase {
    requestRender(): void {}
    handleTerminalInput(_data: string): void {}
  }
  class FakeRenderer extends FakeBase {
    mode = "fullscreen";
    fullRedraws = 0;
    doRender(): void {
      clock.advance(12);
    }
  }

  const observer: UiMetricObserver = {
    now: clock.now,
    record: (name, ms) => samples.push({ name, ms }),
    painted: () => { paints += 1; },
    terminalInput: (data, at) => samples.push({ name: `input:${data}`, ms: at }),
  };
  const tui = new FakeRenderer();
  const status = installUiInstrumentation(tui as unknown as TUI, observer);
  assert.deepEqual(
    { requestRender: status.requestRender, doRender: status.doRender, handleTerminalInput: status.handleTerminalInput },
    { requestRender: true, doRender: true, handleTerminalInput: true },
  );

  tui.handleTerminalInput("x");
  tui.requestRender();
  clock.advance(8);
  tui.doRender();
  assert.deepEqual(samples, [
    { name: "input:x", ms: 0 },
    { name: "typing-handler", ms: 0 },
    { name: "typing→request", ms: 0 },
    { name: "render", ms: 12 },
    { name: "ui-request→paint", ms: 20 },
    { name: "typing→paint", ms: 20 },
  ]);
  assert.equal(paints, 1);
	deactivateUiInstrumentation(observer);
	getUiObservabilityRegistry().setEnabled?.(false, "test-live-tui");
});

test("a reloaded module joins the stable v3 wrapper instead of reporting disabled", async () => {
  const owner = "test-reload-first";
  const registry = getUiObservabilityRegistry();
  registry.setEnabled?.(true, owner);
  class ReloadRenderer {
    requestRender(): void {}
    handleTerminalInput(_data: string): void {}
    doRender(): void {}
  }
  const firstObserver: UiMetricObserver = {
    now: () => 0,
    record: () => {},
    painted: () => {},
  };
  const tui = new ReloadRenderer();
  assert.equal(installUiInstrumentation(tui as unknown as TUI, firstObserver).doRender, true);

  const reloaded = await import(new URL("../src/ui-metrics.ts?reload-regression", import.meta.url).href) as
    typeof import("../src/ui-metrics.ts");
  const secondOwner = "test-reload-second";
  reloaded.getUiObservabilityRegistry().setEnabled?.(true, secondOwner);
  const samples: string[] = [];
  const secondObserver: UiMetricObserver = {
    now: () => 0,
    record: (name) => samples.push(name),
    painted: () => {},
  };
  const status = reloaded.installUiInstrumentation(tui as unknown as TUI, secondObserver);
  assert.equal(status.doRender, true);
  tui.doRender();
  assert.ok(samples.includes("render"));

  reloaded.deactivateUiInstrumentation(secondObserver);
  deactivateUiInstrumentation(firstObserver);
  reloaded.getUiObservabilityRegistry().setEnabled?.(false, secondOwner);
  registry.setEnabled?.(false, owner);
});

test("classifies printable, Kitty, submit, paste and control input", () => {
  assert.equal(classifyInputAction("x"), "typing");
  assert.equal(classifyInputAction("中文"), "typing");
  assert.equal(classifyInputAction("\x1b[97;1u"), "typing");
  assert.equal(classifyInputAction("\r"), "submit");
  assert.equal(classifyInputAction("\x1b[13;1u"), "submit");
  assert.equal(classifyInputAction("\x7f"), "other");
  assert.equal(classifyInputAction("\x1b[200~many chars\x1b[201~"), "other");
});

test("submit input is split into handler, request, and paint with one interaction id", () => {
  const registry = getUiObservabilityRegistry();
  registry.setEnabled?.(true, "test-submit-stages");
  registry.reset("test-submit-stages");
  const clock = fakeClock();
  const samples: Array<{
    name: string;
    ms: number;
    interaction?: unknown;
  }> = [];

  class SubmitRenderer {
    mode = "fullscreen";
    fullRedraws = 0;
    requestRender(): void {}
    handleTerminalInput(_data: string): void {
      clock.advance(4);
      this.requestRender();
    }
    doRender(): void {
      clock.advance(6);
    }
  }
  const observer: UiMetricObserver = {
    now: clock.now,
    record: (name, ms, detail) =>
      samples.push({ name, ms, interaction: detail?.interaction }),
    painted: () => {},
    terminalInput: (_data, at, detail) =>
      samples.push({ name: "raw-submit", ms: at, interaction: detail?.interaction }),
  };
  const tui = new SubmitRenderer();
  installUiInstrumentation(tui as unknown as TUI, observer);
  tui.handleTerminalInput("\r");
  tui.doRender();

  assert.deepEqual(
    samples.map(({ name, ms }) => ({ name, ms })),
    [
      { name: "raw-submit", ms: 0 },
      { name: "submit-key→request", ms: 4 },
      { name: "submit-handler", ms: 4 },
      { name: "render", ms: 6 },
      { name: "ui-request→paint", ms: 6 },
      { name: "submit-key→paint", ms: 10 },
    ],
  );
  const interactions = new Set(
    samples
      .filter(({ name }) => name.startsWith("submit") || name === "raw-submit")
      .map(({ interaction }) => interaction),
  );
  assert.equal(interactions.size, 1);
  assert.equal(typeof [...interactions][0], "number");

  deactivateUiInstrumentation(observer);
  registry.setEnabled?.(false, "test-submit-stages");
});

test("an Enter that closes an overlay is kept out of the editor submit metrics", () => {
  const registry = getUiObservabilityRegistry();
  registry.setEnabled?.(true, "test-overlay-submit-stages");
  registry.reset("test-overlay-submit-stages");
  const clock = fakeClock();
  const samples: Array<{
    name: string;
    ms: number;
    inputKind?: unknown;
    overlayClosed?: unknown;
  }> = [];

  class OverlayRenderer {
    mode = "fullscreen";
    fullRedraws = 0;
    overlayVisible = true;
    hasOverlay(): boolean { return this.overlayVisible; }
    requestRender(): void {}
    handleTerminalInput(_data: string): void {
      clock.advance(2);
      this.requestRender();
      this.overlayVisible = false;
      clock.advance(3);
    }
    doRender(): void { clock.advance(7); }
  }
  const observer: UiMetricObserver = {
    now: clock.now,
    record: (name, ms, detail) => samples.push({
      name,
      ms,
      inputKind: detail?.inputKind,
      overlayClosed: detail?.overlayClosed,
    }),
    painted: () => {},
    terminalInput: (_data, at, detail) => samples.push({
      name: "raw-overlay-enter",
      ms: at,
      inputKind: detail?.inputKind,
      overlayClosed: detail?.overlayClosed,
    }),
    inputHandled: (_data, _startedAt, finishedAt, detail) => samples.push({
      name: "handled-overlay-enter",
      ms: finishedAt,
      inputKind: detail?.inputKind,
      overlayClosed: detail?.overlayClosed,
    }),
  };
  const tui = new OverlayRenderer();
  installUiInstrumentation(tui as unknown as TUI, observer);
  tui.handleTerminalInput("\r");
  tui.doRender();

  assert.deepEqual(samples, [
    { name: "raw-overlay-enter", ms: 0, inputKind: "overlay", overlayClosed: undefined },
    { name: "overlay-enter→request", ms: 2, inputKind: "overlay", overlayClosed: undefined },
    { name: "handled-overlay-enter", ms: 5, inputKind: "overlay", overlayClosed: true },
    { name: "overlay-close-handler", ms: 5, inputKind: "overlay", overlayClosed: true },
    { name: "render", ms: 7, inputKind: undefined, overlayClosed: undefined },
    { name: "ui-request→paint", ms: 10, inputKind: undefined, overlayClosed: undefined },
    { name: "overlay-close→paint", ms: 12, inputKind: "overlay", overlayClosed: true },
  ]);
  assert.equal(samples.some(({ name }) => name.startsWith("submit")), false);

  deactivateUiInstrumentation(observer);
  registry.setEnabled?.(false, "test-overlay-submit-stages");
});

test("terminal resize reports each completed frame and the final settled burst", async () => {
  const registry = getUiObservabilityRegistry();
  registry.setEnabled?.(true, "test-resize-stages");
  registry.reset("test-resize-stages");
  const clock = fakeClock();
  const samples: Array<{ name: string; ms: number; detail?: Record<string, unknown> }> = [];

  class ResizeRenderer {
    mode = "fullscreen";
    fullRedraws = 0;
    terminal = { columns: 80, rows: 24 };
    requestRender(): void {}
    handleTerminalInput(_data: string): void {}
    doRender(): void { clock.advance(6); }
  }
  const observer: UiMetricObserver = {
    now: clock.now,
    record: (name, ms, detail) => samples.push({ name, ms, detail }),
    painted: () => {},
  };
  const tui = new ResizeRenderer();
  installUiInstrumentation(tui as unknown as TUI, observer);

  tui.terminal = { columns: 100, rows: 30 };
  tui.requestRender();
  clock.advance(4);
  tui.doRender();
  tui.terminal = { columns: 120, rows: 32 };
  tui.requestRender();
  clock.advance(5);
  tui.doRender();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const resize = samples.filter(({ name }) => name.startsWith("resize"));
  assert.deepEqual(resize.map(({ name, ms }) => ({ name, ms })), [
    { name: "resize-render", ms: 6 },
    { name: "resize→paint", ms: 10 },
    { name: "resize-render", ms: 6 },
    { name: "resize→paint", ms: 11 },
    { name: "resize-burst→settled", ms: 21 },
  ]);
  assert.deepEqual(
    resize.at(-1)?.detail,
    {
      interaction: resize[0]?.detail?.interaction,
      changes: 2,
      frames: 2,
      fullRedraws: 0,
      fromColumns: 80,
      fromRows: 24,
      toColumns: 120,
      toRows: 32,
    },
  );

  deactivateUiInstrumentation(observer);
  registry.setEnabled?.(false, "test-resize-stages");
});

test("v3 registry supports multiple owners and idempotent release", () => {
	const registry = getUiObservabilityRegistry();
	const published = (globalThis as Record<PropertyKey, unknown>)[UI_OBSERVABILITY_KEY] as Record<string, unknown>;
	assert.equal(published, registry);
	assert.equal(published.version, 3);
	assert.equal("api" in published, false);
	registry.setEnabled?.(true, "test-multi-owner");
	registry.reset();
	const seen: string[] = [];
	const observer = (owner: string): UiMetricObserver => ({
		now: () => 0,
		record: (name) => seen.push(`${owner}:${name}`),
		painted: () => {},
	});
	const releaseA = registry.acquire("a", observer("a"));
	const releaseB = registry.acquire("b", observer("b"));
	assert.deepEqual(registry.snapshot().owners, ["a", "b"]);
	publishUiMetric("semantic→paint", 12);
	assert.equal(registry.snapshot().metrics.find(({ name }) => name === "semantic→paint")?.lastMs, 12);
	registry.updateRuntime?.({
		at: 1,
		rssBytes: 2,
		heapUsedBytes: 3,
		externalBytes: 4,
		arrayBuffersBytes: 5,
		eventLoopUtilization: 0.25,
	});
	assert.equal(registry.snapshot().runtime?.heapUsedBytes, 3);
	releaseA();
	releaseA();
	assert.deepEqual(registry.snapshot().owners, ["b"]);
	releaseB();
	registry.setEnabled?.(false, "test-multi-owner");
});

test("a consumer reset cannot erase provider-owned samples", () => {
	const registry = getUiObservabilityRegistry();
	registry.setEnabled?.(true, "provider-reset-owner");
	registry.reset("provider-reset-owner");
	publishUiMetric("provider-owned", 7);
	registry.reset("consumer-owner");
	assert.equal(registry.snapshot().metrics.find(({ name }) => name === "provider-owned")?.lastMs, 7);
	registry.reset("provider-reset-owner");
	assert.equal(registry.snapshot().metrics.length, 0);
	registry.setEnabled?.(false, "provider-reset-owner");
});

test("the provider can reset shared samples while monitoring is off", () => {
	const registry = getUiObservabilityRegistry();
	registry.setEnabled?.(true, "provider-off-reset-owner");
	registry.reset("provider-off-reset-owner");
	publishUiMetric("before-off", 9);
	registry.setEnabled?.(false, "provider-off-reset-owner");
	registry.reset("provider-off-reset-owner");
	assert.equal(registry.snapshot().metrics.length, 0);
});

test("subscriber release never unwraps the stable TUI methods", () => {
	const registry = getUiObservabilityRegistry();
	registry.setEnabled?.(true, "test-stable-wrapper");
	class Renderer {
		mode = "fullscreen";
		fullRedraws = 0;
		requestRender(): void {}
		doRender(): void {}
		handleTerminalInput(_data: string): void {}
	}
	const tui = new Renderer();
	const original = Renderer.prototype.doRender;
	const observer: UiMetricObserver = { now: () => 0, record: () => {}, painted: () => {} };
	installUiInstrumentation(tui as unknown as TUI, observer);
	const wrapped = Renderer.prototype.doRender;
	assert.notEqual(wrapped, original);
	deactivateUiInstrumentation(observer);
	assert.equal(Renderer.prototype.doRender, wrapped);
	installUiInstrumentation(tui as unknown as TUI, observer);
	assert.equal(Renderer.prototype.doRender, wrapped);
	deactivateUiInstrumentation(observer);
	registry.setEnabled?.(false, "test-stable-wrapper");
});

test("a live legacy v2 registry fails closed instead of installing parallel v3 hooks", () => {
	const moduleUrl = new URL("../src/ui-metrics.ts", import.meta.url).href;
	const script = `
		globalThis[Symbol.for("pi.perf.ui-metrics.v2")] = { version: 2 };
		const imported = await import(${JSON.stringify(moduleUrl)});
		const registry = imported.getUiObservabilityRegistry();
		const status = registry.getStatus();
		if (status.provider !== "unavailable" || !String(status.detail).includes("legacy")) process.exit(2);
		if (globalThis[Symbol.for("pi.perf.ui-metrics.v3")] !== undefined) process.exit(3);
	`;
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("every observer callback failure is quarantined without swallowing input, render or original errors", () => {
  const registry = getUiObservabilityRegistry(); registry.setEnabled?.(true, "faults");
  const calls = { input: 0, request: 0, render: 0 };
  class Renderer {
    requestRender() { calls.request++; }
    handleTerminalInput(_data: string) { calls.input++; this.requestRender(); }
    doRender() { calls.render++; }
  }
  const failed = () => { throw new Error("private content must not enter diagnostics"); };
  const observer: UiMetricObserver = { now: failed, record: failed, painted: failed, terminalInput: failed, inputHandled: failed };
  const renderer = new Renderer(); installUiInstrumentation(renderer as unknown as TUI, observer);
  renderer.handleTerminalInput("x"); renderer.doRender();
  renderer.handleTerminalInput("y"); renderer.doRender();
  assert.deepEqual(calls, { input: 2, request: 2, render: 2 });
  const diagnostics = uiObserverDiagnostics().join(" ");
  for (const name of ["now", "record", "painted", "terminalInput", "inputHandled"]) assert.ok(diagnostics.includes(`observer.${name} failed`));
  assert.ok(!diagnostics.includes("private content"));
  assert.match(registry.getStatus().detail!, /callback quarantined/);
  deactivateUiInstrumentation(observer);
  class BrokenRenderer {
    requestRender() { throw new Error("original request"); }
    handleTerminalInput() { throw new Error("original input"); }
    doRender() { throw new Error("original render"); }
  }
  const broken = new BrokenRenderer(); installUiInstrumentation(broken as unknown as TUI, observer);
  assert.throws(() => broken.requestRender(), /original request/);
  assert.throws(() => broken.handleTerminalInput(), /original input/);
  assert.throws(() => broken.doRender(), /original render/);
  deactivateUiInstrumentation(observer); registry.setEnabled?.(false, "faults");
});


test("host getters and wrapper bookkeeping cannot swallow calls or replace original errors", () => {
  const registry = getUiObservabilityRegistry(); registry.setEnabled?.(true, "host-fault");
  const observer: UiMetricObserver = { now: () => performance.now(), record: () => {}, painted: () => {} };
  let requests = 0, inputs = 0, renders = 0, failAfterRender = false;
  const originalError = new Error("original render failure");
  class Host {
    get terminal(): any { throw new Error("dimensions failed"); }
    get hasOverlay(): any { throw new Error("overlay getter failed"); }
    get fullRedraws() { if (failAfterRender) throw new Error("redraw getter failed"); return 0; }
    get mode(): any { throw new Error("mode getter failed"); }
    requestRender() { requests++; return 17; }
    handleTerminalInput(_data: string) { inputs++; return 18; }
    doRender() { renders++; failAfterRender = true; throw originalError; }
  }
  const target = new Host(); installUiInstrumentation(target as unknown as TUI, observer);
  assert.equal(target.requestRender(), 17); assert.equal(target.handleTerminalInput("\r"), 18);
  assert.throws(() => target.doRender(), error => error === originalError);
  assert.deepEqual([requests, inputs, renders], [1, 1, 1]);
  assert.match(uiObserverDiagnostics().join(" "), /instrumentation.requestRender/);
  assert.match(uiObserverDiagnostics().join(" "), /instrumentation.input.begin/);
  assert.match(uiObserverDiagnostics().join(" "), /instrumentation.doRender.end/);
  deactivateUiInstrumentation(observer); registry.setEnabled?.(false, "host-fault");
});


test("a failed frame metric still clears pending input and calls every painted observer", () => {
  const registry = getUiObservabilityRegistry(); registry.setEnabled?.(true, "frame-finish");
  let fault = false, paints = 0; const names: string[] = [];
  class Host {
    fullRedraws = 0;
    get mode() { if (fault) throw new Error("mode unavailable"); return "test"; }
    requestRender() {}
    handleTerminalInput(_data: string) {}
    doRender() {}
  }
  const observer: UiMetricObserver = { now: () => performance.now(), record: name => names.push(name), painted: () => { paints++; } };
  const target = new Host(); installUiInstrumentation(target as unknown as TUI, observer);
  target.handleTerminalInput("x"); fault = true; target.doRender();
  assert.equal(paints, 1);
  fault = false; target.doRender(); assert.equal(paints, 2);
  assert.equal(names.includes("typing→paint"), false, "stale input must not leak into the next frame");
  deactivateUiInstrumentation(observer); registry.setEnabled?.(false, "frame-finish");
});
