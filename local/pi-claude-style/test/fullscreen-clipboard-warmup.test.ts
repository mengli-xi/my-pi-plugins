import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_EFFECTIVE_CONFIG } from "../src/config/defaults.ts";
import { CLIPBOARD_WARM_DELAY_MS, warmNativeClipboardOnIdle } from "../src/host/fullscreen/clipboard-warmup.ts";
import { installFullscreenHost } from "../src/host/fullscreen/install.ts";

const fullscreenView = () => new TuiAltScreen({ columns: 80, rows: 24 } as unknown as Terminal);
const inlineView = () => ({ mode: "inline" } as unknown as TUI);

interface ScheduledTimer { delay: number; run: () => void; unrefs: number; cleared: boolean; unref(): ScheduledTimer }

/** Records the warm-up timer instead of waiting for it; clearTimeout stays observable. */
function timerHarness(t: test.TestContext, value: NodeJS.Platform = "darwin") {
  t.after(platform(value));
  const real = [globalThis.setTimeout, globalThis.clearTimeout] as const;
  const timers: ScheduledTimer[] = [];
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    const timer: ScheduledTimer = {
      delay: delay ?? 0, run, unrefs: 0, cleared: false,
      unref() { timer.unrefs++; return timer; },
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ScheduledTimer) => { timer.cleared = true; }) as unknown as typeof clearTimeout;
  t.after(() => { [globalThis.setTimeout, globalThis.clearTimeout] = real; });
  return {
    pending: (): ScheduledTimer[] => timers.filter(timer => !timer.cleared),
    fire: (timer: ScheduledTimer): void => { if (!timer.cleared) { timer.cleared = true; timer.run(); } },
  };
}

/** Overrides process.platform and returns its restore. */
function platform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value });
  return () => { Object.defineProperty(process, "platform", original); };
}

test("darwin warms once on an unref'd timer, after the turn goes idle", (t) => {
  const timers = timerHarness(t);
  let idle = false, loads = 0;
  t.after(warmNativeClipboardOnIdle(fullscreenView(), () => idle, () => { loads++; }));

  const [first] = timers.pending();
  assert.ok(first, "the warm-up is deferred, never synchronous");
  assert.equal(first.delay, CLIPBOARD_WARM_DELAY_MS);
  assert.equal(first.unrefs, 1, "the wait must not hold the process open");
  timers.fire(first);
  assert.equal(loads, 0, "a streaming turn leaves the load for the next idle window");
  const [retry] = timers.pending();
  assert.ok(retry);
  idle = true;
  timers.fire(retry);
  assert.equal(loads, 1);
  assert.equal(timers.pending().length, 0, "one load per view");
});

test("linux and inline views never schedule the load", (t) => {
  const timers = timerHarness(t);
  let loads = 0;
  const linux = platform("linux");
  warmNativeClipboardOnIdle(fullscreenView(), () => true, () => { loads++; });
  linux();
  const darwin = platform("darwin");
  warmNativeClipboardOnIdle(inlineView(), () => true, () => { loads++; });
  darwin();
  assert.deepEqual(timers.pending(), []);
  assert.equal(loads, 0);
});

/** The real mount path: a fake Pi API and context around an alt-screen view. */
function mainView(t: test.TestContext, options: { warmClipboard?: boolean } = {}) {
  const starts: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
  const api = {
    on(type: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      if (type === "session_start") starts.push(handler);
      return () => {};
    },
    getSettings: () => ({ packages: [] }),
    registerMessageRenderer() {},
    registerEntryRenderer() {},
  } as unknown as ExtensionAPI;
  const host = installFullscreenHost(api, () => DEFAULT_EFFECTIVE_CONFIG.layout, options);
  t.after(() => host.dispose());
  return {
    host,
    start(ctx: ExtensionContext = {
      mode: "tui", hasUI: true, isIdle: () => true,
      ui: { theme: {}, setWidget: (_key: string, factory: unknown) => { if (typeof factory === "function") factory(fullscreenView()); } },
    } as unknown as ExtensionContext) {
      for (const handler of starts) handler({}, ctx);
    },
  };
}

test("Main warms; a child view never does and a disposed host drops its timer", (t) => {
  const timers = timerHarness(t);
  mainView(t).start();
  assert.deepEqual(timers.pending(), [], "a child view preloads nothing");

  const main = mainView(t, { warmClipboard: true });
  main.start();
  const [scheduled] = timers.pending();
  assert.ok(scheduled, "Main schedules the deferred load");
  main.host.dispose();
  assert.equal(scheduled.cleared, true, "shutdown drops the pending warm-up");
});
