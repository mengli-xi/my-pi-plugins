import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { DEFAULT_WORKING } from "../src/config.ts";
import { ProviderStatusTracker } from "../src/provider-status.ts";
import { RunMetrics } from "../src/metrics.ts";
import { WorkingController } from "../src/working.ts";
import { retryCategory, WorkingRetryState } from "../src/working-retry.ts";
import { installWorkingRetry, type WorkingRetryIndicator, type RetryStart } from "../src/compat/working-retry.ts";

const event: RetryStart = { type: "auto_retry_start", attempt: 2, maxAttempts: 10, delayMs: 4_000, errorMessage: "fetch failed: ECONNRESET" };

test("retry categories prefer rate and upstream status over network wrapper text", () => {
  for (const text of ["ECONNRESET", "connection reset", "timeout", "timed out", "fetch failed"]) assert.equal(retryCategory(text), "网络异常");
  for (const text of ["429 fetch failed", "rate_limit_exceeded"]) assert.equal(retryCategory(text), "限流");
  for (const text of ["503 fetch failed", "upstream_unavailable", "overloaded"]) assert.equal(retryCategory(text), "上游不可用");
  assert.equal(retryCategory("4027 bad response"), "异常");
  assert.equal(retryCategory(""), "异常");
});

test("retry text samples seconds, skips delayed ticks, and restores on end", () => {
  const state = new WorkingRetryState();
  state.start(event, 120);
  const expected = "网络异常 · 重试 2/10 · 4s 后（Esc 取消）";
  assert.equal(state.format(120), expected);
  assert.equal(state.format(1_119), expected);
  assert.equal(state.format(1_120), "网络异常 · 重试 2/10 · 3s 后（Esc 取消）");
  assert.equal(state.format(3_620), "网络异常 · 重试 2/10 · 1s 后（Esc 取消）");
  assert.equal(state.format(10_000), "网络异常 · 重试 2/10 · 0s 后（Esc 取消）");
  state.clear();
  assert.equal(state.format(10_001), "");
  assert.equal(state.active(), false);
  state.start({ ...event, attempt: 3, delayMs: 2_500, errorMessage: "429" }, 20_000);
  assert.equal(state.format(20_999), "限流 · 重试 3/10 · 3s 后（Esc 取消）");
  assert.equal(state.format(21_000), "限流 · 重试 3/10 · 2s 后（Esc 取消）");
});

function fixture(style: "plain" | "cyber", mode = "fullscreen") {
  let now = 1_000;
  let scheduled: (() => void) | undefined;
  let message = "";
  let visible = true;
  const warning: string[] = [];
  const theme = { fg: (color: string, value: string) => { if (color === "warning") warning.push(value); return value; }, bold: (value: string) => value } as Theme;
  const metrics = new RunMetrics({ now: () => now });
  const ui = {
    theme,
    setWidget(_key: string, content: unknown) {
      if (typeof content === "function") content({ mode, requestRender() {} }, theme);
    },
    setWorkingMessage(value = "") { message = value; },
    setWorkingIndicator() {},
    setWorkingVisible(value: boolean) { visible = value; },
  };
  const ctx = { mode: "tui", hasUI: true, ui } as unknown as ExtensionContext;
  const working = new WorkingController(metrics, { ...DEFAULT_WORKING, style, messageWidth: 300 }, new ProviderStatusTracker(), undefined, () => now, undefined, {
    setTimer(callback) { scheduled = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
    clearTimer() { scheduled = undefined; },
  });
  metrics.start();
  working.start(ctx);
  return { working, ctx, warning, message: () => stripAnsi(message), visible: () => visible,
    advance(ms: number) { now += ms; const callback = scheduled; scheduled = undefined; callback?.(); } };
}

for (const style of ["plain", "cyber"] as const) test(`${style} working row retains spinner, uses warning suffix and resets for request and end`, () => {
  const f = fixture(style);
  try {
    const indicator = f.working.startRetry(f.ctx, event);
    assert.ok(indicator);
    assert.ok(f.warning.some(text => text.includes("重试 2/10")));
    assert.match(stripAnsi(indicator.render(300).join("\n")), /网络异常 · 重试 2\/10 · 4s 后（Esc 取消）/u);
    assert.match(f.message().split("\n")[0]!, /… · 网络异常 · 重试 2\/10 · 4s 后（Esc 取消）/u);
    f.advance(999);
    assert.match(f.message(), /4s 后/u);
    f.advance(200);
    assert.match(f.message(), /3s 后/u);
    f.working.start(f.ctx);
    assert.ok(!f.message().includes("重试"));
    f.working.startRetry(f.ctx, event);
    f.working.endRetry();
    assert.ok(!f.message().includes("重试"));
    assert.equal(f.visible(), false, "native retry end cannot clear a working-kind indicator, so CC clears it publicly");
    indicator.dispose();
  } finally { f.working.clear(f.ctx.ui); }
});

test("regular mode leaves the native retry indicator available", () => {
  const f = fixture("plain", "regular");
  try { assert.equal(f.working.startRetry(f.ctx, event), undefined); }
  finally { f.working.clear(f.ctx.ui); }
});


test("native handler still owns Escape and final failure when CC replaces its indicator", async () => {
  initTheme("dark");
  const prototype = InteractiveMode.prototype as unknown as { handleEvent(event: unknown): Promise<void>; showStatusIndicator(indicator: unknown): void };
  let aborted = 0, ended = 0, failure = "";
  const escape = () => {};
  const indicator: WorkingRetryIndicator = {
    kind: "working", render: () => [], invalidate() {}, dispose() {}, setMessage() {}, setIndicator() {},
  };
  const receiver = Object.assign(Object.create(InteractiveMode.prototype), {
    isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} },
    defaultEditor: { onEscape: escape }, pendingTools: new Map(),
    ui: { requestRender() {} }, activeStatusIndicator: undefined,
    statusContainer: { clear() {}, addChild() {} },
    setEditorWorkingStatusIndicator() { return false; },
    clearStatusIndicator() {}, showError(value: string) { failure = value; },
  });
  Object.defineProperty(receiver, "session", { value: { abortRetry() { aborted++; } } });
  const dispose = installWorkingRetry(undefined, () => indicator, () => { ended++; });
  try {
    await prototype.handleEvent.call(receiver, event);
    assert.equal(receiver.activeStatusIndicator, indicator);
    receiver.defaultEditor.onEscape();
    assert.equal(aborted, 1);
    await prototype.handleEvent.call(receiver, { type: "agent_start" });
    assert.equal(receiver.defaultEditor.onEscape, escape);
    await prototype.handleEvent.call(receiver, { type: "auto_retry_end", success: false, attempt: 2, finalError: "fetch failed" });
    assert.equal(ended, 2);
    assert.equal(failure, "Retry failed after 2 attempts: fetch failed");
  } finally { dispose(); }
});

for (const style of ["plain", "cyber"] as const) test(`${style} retry wakes each second at legal 2000ms visual cadence using one timer`, () => {
  let now = 0, due = Infinity, pending: (() => void) | undefined, message = "", indicatorChanges = 0;
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
  const ui = { theme,
    setWidget(_key: string, value: unknown) { if (typeof value === "function") value({ mode: "fullscreen", requestRender() {} }, theme); },
    setWorkingMessage(value = "") { message = value; },
    setWorkingVisible() {}, setWorkingIndicator() { indicatorChanges++; },
  };
  const ctx = { hasUI: true, ui } as unknown as ExtensionContext;
  const metrics = new RunMetrics({ now: () => now }); metrics.start();
  const working = new WorkingController(metrics, { ...DEFAULT_WORKING, style, refreshMs: 2000, spinnerIntervalMs: 2000 }, new ProviderStatusTracker(), undefined, () => now, undefined, {
    setTimer(callback, delay) {
      assert.equal(pending, undefined, "there is only one live Working timer");
      pending = callback; due = now + delay;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }, clearTimer() { pending = undefined; due = Infinity; },
  });
  working.start(ctx);
  const indicator = working.startRetry(ctx, event);
  const headline = () => message.split(" · ")[0];
  const initialHeadline = headline();
  const changesAtStart = indicatorChanges;
  const advance = (time: number) => {
    now = time;
    if (pending && due <= now) { const callback = pending; pending = undefined; callback(); }
  };
  try {
    assert.equal(due, 1000);
    advance(999); assert.match(stripAnsi(message), /4s 后/u);
    advance(1000); assert.match(stripAnsi(message), /3s 后/u);
    assert.equal(headline(), initialHeadline, "retry-only repaint leaves shimmer unchanged");
    assert.equal(indicatorChanges, changesAtStart, "retry-only wake leaves spinner cadence unchanged");
    advance(2000); assert.match(stripAnsi(message), /2s 后/u);
    const secondHeadline = headline();
    assert.equal(indicatorChanges, changesAtStart + 1);
    advance(3000); assert.match(stripAnsi(message), /1s 后/u);
    assert.equal(headline(), secondHeadline);
    assert.equal(indicatorChanges, changesAtStart + 1);
    advance(4000); assert.match(stripAnsi(message), /0s 后/u);
    working.endRetry();
    assert.equal(pending, undefined, "retry cancellation retires its sole timer");
  } finally { indicator?.dispose(); working.clear(ctx.ui); }
});

test("restored retry state keeps its original second boundary", () => {
  const state = new WorkingRetryState();
  state.restore({ attempt: 2, maxAttempts: 10, delayMs: 4000, startedAt: 120, category: "限流" });
  assert.equal(state.format(1620), "限流 · 重试 2/10 · 3s 后（Esc 取消）");
  assert.equal(state.nextRefreshAt(1620), 2120);
  assert.equal(state.format(2120), "限流 · 重试 2/10 · 2s 后（Esc 取消）");
});
