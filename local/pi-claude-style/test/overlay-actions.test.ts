import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setCapabilities } from "@earendil-works/pi-tui";
import { ActivityTimelineStore } from "../src/activity-timeline.ts";
import { DEFAULT_DIFF, DEFAULT_OVERLAY } from "../src/config.ts";
import { TranscriptOverlayActions } from "../src/features/transcript/overlay-actions.ts";
import { ThinkingDocument } from "../src/assistant-message.ts";
import { RuntimeScope } from "../src/runtime-scope.ts";
import type { ToolGroupSnapshot } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("double activation mounts only one text overlay per UI", async () => {
  const overlays = new TranscriptOverlayActions();
  const pending: Array<ReturnType<typeof deferred<void>>> = [];
  const options: unknown[] = [];
  let mounts = 0;
  const ui = {
    custom(_factory: unknown, customOptions?: unknown): Promise<void> {
      mounts++;
      options.push(customOptions);
      const next = deferred<void>();
      pending.push(next);
      return next.promise;
    },
    notify(): void {},
  };
  const ctx = { hasUI: true, ui } as unknown as ExtensionContext;

  const first = overlays.openText(ctx, "Thinking", "first", DEFAULT_OVERLAY);
  const duplicate = overlays.openText(ctx, "Thinking", "second", DEFAULT_OVERLAY);

  await duplicate;
  // The overlay implementation is a first-use dynamic import. The single-
  // flight claim is synchronous, but the winning mount follows that import.
  for (let attempts = 0; attempts < 100 && mounts === 0; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(mounts, 1, "the second activation must not push another modal");
  assert.equal((options[0] as { overlay?: unknown }).overlay, true);
  assert.equal(
    typeof (options[0] as { overlayOptions?: unknown }).overlayOptions,
    "function",
    "the view resolves its editor-position geometry without replacing the editor",
  );

  pending[0]!.resolve();
  await first;

  const afterClose = overlays.openText(ctx, "Thinking", "third", DEFAULT_OVERLAY);
  for (let attempts = 0; attempts < 100 && mounts === 1; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(mounts, 2, "closing releases the UI for the next overlay");
  pending[1]!.resolve();
  await afterClose;
});

test("an image preview replaces the editor without entering the overlay compositor", async () => {
  const overlays = new TranscriptOverlayActions();
  const closed = deferred<void>();
  let panel: { render(width: number): string[] } | undefined;
  const tui = {
    terminal: { rows: 24, columns: 80, write() {} },
    requestRender() {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom(factory: (...args: unknown[]) => unknown): Promise<void> {
        panel = factory(tui, theme, {}, () => closed.resolve()) as typeof panel;
        return closed.promise;
      },
      notify(): void {},
      setStatus(): void {},
    },
  } as unknown as ExtensionContext;
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });

  const opened = overlays.openImages(ctx, [{
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5p6cAAAAASUVORK5CYII=",
    mimeType: "image/png",
    sizeBytes: 68,
    path: "screen.png",
  }]);
  for (let attempts = 0; attempts < 100 && !panel; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(panel);
  const rendered = panel.render(80).join("\n");
  assert.match(rendered, /Image · screen\.png \(68 B\)/u);
  assert.match(rendered, /\[Image: screen\.png \(68 B\) \[image\/png\] 1x1\]/u);

  closed.resolve();
  await opened;
});

test("an image conversion finishing after session replacement cannot mount a stale panel", async () => {
  const runtime = new RuntimeScope();
  const conversion = deferred<void>();
  let conversions = 0;
  let mounts = 0;
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom(): Promise<void> {
        mounts++;
        return Promise.resolve();
      },
      notify(message: string): void { notifications.push(message); },
      setStatus(): void {},
    },
  } as unknown as ExtensionContext;
  runtime.bindSession(ctx);
  const overlays = new TranscriptOverlayActions(
    runtime,
    undefined,
    async (data) => {
      conversions++;
      await conversion.promise;
      return { data, mimeType: "image/png" };
    },
  );
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

  const opened = overlays.openImages(ctx, [{
    data: "jpeg-data",
    mimeType: "image/jpeg",
    sizeBytes: 9,
    path: "screen.jpg",
  }]);
  for (let attempts = 0; attempts < 100 && conversions === 0; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(conversions, 1);
  runtime.bindSession(ctx);
  conversion.resolve();
  await opened;

  assert.equal(mounts, 0, "the retired session cannot replace the current editor");
  assert.deepEqual(notifications, []);

  await overlays.openImages(ctx, [{
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5p6cAAAAASUVORK5CYII=",
    mimeType: "image/png",
    sizeBytes: 68,
    path: "current.png",
  }]);
  assert.equal(mounts, 1, "discarding the stale continuation releases the single-flight guard");
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});

test("an image preview renders a real Kitty image sequence when supported", async () => {
  const overlays = new TranscriptOverlayActions();
  const closed = deferred<void>();
  let panel: { render(width: number): string[] } | undefined;
  const tui = {
    terminal: { rows: 24, columns: 80, write() {} },
    requestRender() {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom(factory: (...args: unknown[]) => unknown): Promise<void> {
        panel = factory(tui, theme, {}, () => closed.resolve()) as typeof panel;
        return closed.promise;
      },
      notify(): void {},
      setStatus(): void {},
    },
  } as unknown as ExtensionContext;
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

  const opened = overlays.openImages(ctx, [{
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5p6cAAAAASUVORK5CYII=",
    mimeType: "image/png",
    sizeBytes: 68,
    path: "screen.png",
  }]);
  for (let attempts = 0; attempts < 100 && !panel; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(panel);
  assert.match(panel.render(80).join("\n"), /\x1b_Ga=T,f=100/u);

  closed.resolve();
  await opened;
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});

test("a text overlay with lifecycle cleanup closes through the UIKit host", async () => {
  const overlays = new TranscriptOverlayActions();
  const closed = deferred<void>();
  let panel: { focused: boolean; handleInput(data: string): void } | undefined;
  let lifecycleCloses = 0;
  const tui = {
    terminal: { rows: 24, columns: 80, write() {} },
    requestRender() {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom(factory: (...args: unknown[]) => unknown): Promise<void> {
        const mounted = factory(tui, theme, {}, () => closed.resolve()) as NonNullable<typeof panel>;
        panel = mounted;
        mounted.focused = true;
        return closed.promise;
      },
      notify(): void {},
      setStatus(): void {},
    },
  } as unknown as ExtensionContext;

  const opened = overlays.openText(ctx, "bash", "running", DEFAULT_OVERLAY, {
    format: "plain",
    onClose: () => { lifecycleCloses++; },
  });
  for (let attempts = 0; attempts < 100 && !panel; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(panel);
  panel.handleInput("\x1b");
  await opened;
  assert.equal(lifecycleCloses, 1);
});

test("an open Markdown thinking panel follows body and elapsed snapshots, then unsubscribes", async () => {
  const overlays = new TranscriptOverlayActions();
  const closed = deferred<void>();
  let now = 1_000;
  let timerCallback: (() => void) | undefined;
  const clock = {
    now: () => now,
    setTimer: (callback: () => void, _delayMs: number) => {
      timerCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (_timer: ReturnType<typeof setTimeout>) => {
      timerCallback = undefined;
    },
  };
  const document = new ThinkingDocument("**first thought**", clock);
  document.updateTiming(1_000, undefined, true);
  let renders = 0;
  let panel: { render(width: number): string[] } | undefined;
  const tui = {
    terminal: { rows: 24, columns: 80, write() {} },
    requestRender() { renders++; },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ui = {
    custom(factory: (...args: unknown[]) => unknown): Promise<void> {
      panel = factory(tui, theme, {}, () => closed.resolve()) as typeof panel;
      return closed.promise;
    },
    notify(): void {},
  };
  const ctx = { hasUI: true, mode: "tui", ui } as unknown as ExtensionContext;

  const opened = overlays.openText(ctx, "Thinking", document.snapshot(), DEFAULT_OVERLAY, {
    format: "markdown",
    tone: "thinkingText",
    live: document,
  });
  for (let attempts = 0; attempts < 100 && renders === 0; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const afterInitialSnapshot = renders;
  assert.ok(afterInitialSnapshot > 0, "subscription paints the current snapshot");
  assert.ok(panel);
  assert.match(panel.render(60).join("\n"), /Thinking .* 0s/u);
  assert.match(panel.render(60).join("\n"), /first thought/u, "Markdown content renders in the panel");

  document.update("**first thought and a delta**");
  assert.equal(renders, afterInitialSnapshot + 1, "a delta repaints the mounted panel");

  now = 2_000;
  const tick = timerCallback;
  assert.ok(tick);
  timerCallback = undefined;
  tick();
  assert.match(panel.render(60).join("\n"), /Thinking .* 1s/u, "elapsed time updates without body deltas");

  const beforeClose = renders;
  closed.resolve();
  await opened;
  document.update("must not reach a closed panel");
  assert.equal(renders, beforeClose, "close removes the live listener");
  assert.equal(timerCallback, undefined, "close clears the elapsed timer");
});

test("a CC Thinking panel hides fence marker rows, also after a live delta", async () => {
  const overlays = new TranscriptOverlayActions();
  const closed = deferred<void>();
  const clock = {
    now: () => 1_000,
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  };
  const document = new ThinkingDocument("plan\n\n```js\nconst first = 1;\n```", clock);
  let renders = 0;
  let panel: { render(width: number): string[] } | undefined;
  const tui = { terminal: { rows: 24, columns: 80, write() {} }, requestRender() { renders++; } };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ui = {
    custom(factory: (...args: unknown[]) => unknown): Promise<void> {
      panel = factory(tui, theme, {}, () => closed.resolve()) as typeof panel;
      return closed.promise;
    },
    notify(): void {},
  };
  const ctx = { hasUI: true, mode: "tui", ui } as unknown as ExtensionContext;
  const opened = overlays.openText(ctx, "Thinking", document.snapshot(), DEFAULT_OVERLAY, {
    format: "markdown",
    tone: "thinkingText",
    live: document,
    hideCodeFenceMarkers: true,
  });
  for (let attempts = 0; attempts < 100 && !panel; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(panel);
  const body = () => panel!.render(60).join("\n");
  assert.match(body(), /const first = 1;/u);
  assert.doesNotMatch(body(), /```/u);
  document.update("plan\n\n```js\nconst second = 2;\n```");
  assert.match(body(), /const second = 2;/u, "the fence-free body follows the live document");
  assert.doesNotMatch(body(), /```/u);
  closed.resolve();
  await opened;
});

test("an open tool panel follows snapshots without resetting expanded calls", async () => {
  const overlays = new TranscriptOverlayActions();
  const closed = deferred<void>();
  const initial: ToolGroupSnapshot = {
    id: "live-group",
    anchorToolCallId: "live-1",
    presentation: "grouped",
    status: "collecting",
    createdAt: 0,
    updatedAt: 10,
    failureCount: 0,
    runningCount: 1,
    activities: [{
      id: "live-1",
      groupId: "live-group",
      toolName: "bash",
      args: { command: "echo ready" },
      status: "running",
      startedAt: 0,
      result: { text: "rea", truncated: false, isError: false },
    }],
  };
  let listener: ((snapshot: ToolGroupSnapshot | undefined) => void) | undefined;
  let unsubscribed = 0;
  let panel: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let renders = 0;
  const tui = {
    terminal: { rows: 24, columns: 80, write() {} },
    requestRender() { renders++; },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ui = {
    custom(factory: (...args: unknown[]) => unknown): Promise<void> {
      panel = factory(tui, theme, {}, () => closed.resolve()) as typeof panel;
      return closed.promise;
    },
    notify(): void {},
  };
  const ctx = { hasUI: true, mode: "tui", ui } as unknown as ExtensionContext;

  const opened = overlays.openGroup(
    ctx,
    initial,
    5_000,
    DEFAULT_OVERLAY,
    DEFAULT_DIFF,
    () => "$ echo ready",
    (next) => {
      listener = next;
      next(initial);
      return () => { unsubscribed++; };
    },
  );
  for (let attempts = 0; attempts < 100 && !panel; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(panel);
  panel.render(80);
  panel.handleInput("\r");
  assert.match(panel.render(80).join("\n"), /  Arguments/u);
  assert.match(panel.render(80).join("\n"), /rea/u);

  const completed: ToolGroupSnapshot = {
    ...initial,
    status: "completed",
    updatedAt: 350,
    runningCount: 0,
    activities: [{
      ...initial.activities[0]!,
      status: "completed",
      endedAt: 350,
      result: { text: "ready", truncated: false, isError: false },
    }],
  };
  const beforeUpdate = renders;
  listener?.(completed);
  const updated = panel.render(80).join("\n");
  assert.ok(renders > beforeUpdate, "a live snapshot requests an in-place repaint");
  assert.match(updated, /  Arguments/u, "the user's expanded state survives the delta");
  assert.match(updated, /ready/u);
  assert.match(updated, /completed/u);

  closed.resolve();
  await opened;
  assert.equal(unsubscribed, 1);
});

test("an open Activity panel follows timeline and Thinking snapshots", async () => {
  const overlays = new TranscriptOverlayActions();
  const closed = deferred<void>();
  const timeline = new ActivityTimelineStore({ isManagedTool: () => true });
  timeline.observeAssistant({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "first thought" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
    ],
  } as never, true, 1_000);
  const initialPhase = timeline.list()[0]!;
  const group: ToolGroupSnapshot = {
    id: "activity-group",
    anchorToolCallId: "call-1",
    presentation: "grouped",
    status: "completed",
    createdAt: 1_000,
    updatedAt: 1_100,
    failureCount: 0,
    runningCount: 0,
    activities: [{
      id: "call-1",
      groupId: "activity-group",
      toolName: "read",
      args: { path: "a.ts" },
      status: "completed",
      startedAt: 1_000,
      endedAt: 1_100,
      result: { text: "source", truncated: false, isError: false },
    }],
  };
  let panel: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  let renders = 0;
  const tui = {
    terminal: { rows: 28, columns: 80, write() {} },
    requestRender() { renders++; },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom(factory: (...args: unknown[]) => unknown): Promise<void> {
        panel = factory(tui, theme, {}, () => closed.resolve()) as typeof panel;
        return closed.promise;
      },
      notify(): void {},
    },
  } as unknown as ExtensionContext;

  const opened = overlays.openGroup(
    ctx,
    group,
    5_000,
    DEFAULT_OVERLAY,
    DEFAULT_DIFF,
    () => "Read a.ts",
    undefined,
    {
      phase: initialPhase,
      resolveActivity: (id) => id === "call-1" ? group.activities[0] : undefined,
      subscribe: (listener) => timeline.subscribe(initialPhase.id, listener),
    },
  );
  for (let attempts = 0; attempts < 100 && !panel; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(panel);
  panel.render(80);
  panel.handleInput("\r");
  assert.match(panel.render(80).join("\n"), /first thought/u);
  panel.handleInput("\x1b[B");

  const before = renders;
  timeline.observeAssistant({
    role: "assistant",
    content: [{ type: "thinking", thinking: "second thought" }],
  } as never, true, 2_000);
  const updated = panel.render(80).join("\n");
  assert.ok(renders > before, "a timeline delta repaints the mounted panel");
  assert.match(updated, /▸ Thinking/u, "the new segment appears folded");
  assert.match(updated, /→\s+▸ Read/u, "selection stays on the same tool item");

  const beforeRetire = renders;
  timeline.clear();
  await opened;
  assert.ok(renders >= beforeRetire, "retiring the projection closes its mounted panel");
  const afterClose = renders;
  timeline.observeAssistant({
    role: "assistant",
    content: [{ type: "thinking", thinking: "after close" }],
  } as never, true, 3_000);
  assert.equal(renders, afterClose, "close removes timeline and document listeners");
});

test("a failed mount releases the overlay guard", async () => {
  const overlays = new TranscriptOverlayActions();
  let attempts = 0;
  const notifications: string[] = [];
  const ui = {
    custom(): Promise<void> {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("mount failed"))
        : Promise.resolve();
    },
    notify(message: string): void {
      notifications.push(message);
    },
  };
  const ctx = { hasUI: true, ui } as unknown as ExtensionContext;

  await overlays.openText(ctx, "Thinking", "first", DEFAULT_OVERLAY);
  await overlays.openText(ctx, "Thinking", "second", DEFAULT_OVERLAY);

  assert.equal(attempts, 2);
  assert.match(notifications[0]!, /mount failed/);
});


test("tool overlay duplicate activation skips loading and stale sessions cannot mount it", async () => {
  const runtime = new RuntimeScope();
  const pending = deferred<typeof import("../src/overlay.ts")>();
  let mounts = 0;
  let subscriptions = 0;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom() { mounts++; return Promise.resolve(); },
      notify() {},
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  runtime.bindSession(ctx);
  const overlays = new TranscriptOverlayActions(runtime);
  assert.deepEqual(runtime.moduleStates(), {}, "construction does not load cold UI");
  const implementation = runtime.module<typeof import("../src/overlay.ts")>("transcript-overlay");
  const firstImport = implementation.load(() => pending.promise, () => {});
  const getModule = runtime.module.bind(runtime);
  let loadRequests = 0;
  runtime.module = <T>(name: string) => {
    if (name === "transcript-overlay") loadRequests++;
    return getModule<T>(name);
  };
  const group: ToolGroupSnapshot = {
    id: "lazy", anchorToolCallId: "call", presentation: "grouped", status: "completed",
    createdAt: 0, updatedAt: 1, failureCount: 0, runningCount: 0, activities: [],
  };
  const open = () => overlays.openGroup(ctx, group, 5_000, DEFAULT_OVERLAY, DEFAULT_DIFF, () => "tool",
    () => { subscriptions++; return () => { subscriptions--; }; });
  const stale = open();
  assert.equal(loadRequests, 1, "the first activation enters the loading flow");
  const duplicate = open();
  assert.equal(loadRequests, 1, "claimOverlay rejects the duplicate before it can request a module");
  await duplicate;
  runtime.bindSession(ctx);
  pending.resolve(await import("../src/overlay.ts"));
  await Promise.all([firstImport, stale]);
  assert.equal(implementation.state, "idle", "the stale in-flight cache must be retryable");
  assert.equal(mounts, 0);
  assert.equal(subscriptions, 0, "stale loads must not subscribe to the retired projection");

  await open();
  assert.equal(mounts, 1, "the new session can load and open after the discarded continuation");
  assert.equal(implementation.state, "ready");
  await open();
  assert.equal(mounts, 2, "a closed overlay can reuse its ready implementation");
  await runtime.dispose("reload");
  overlays.dispose();
  await open();
  assert.equal(mounts, 2, "a disposed owner cannot reopen cached UI");
});


test("a failed tool overlay import can be opened successfully on the next attempt", async () => {
  const runtime = new RuntimeScope();
  const implementation = runtime.module<typeof import("../src/overlay.ts")>("transcript-overlay");
  const load = implementation.load.bind(implementation);
  let attempts = 0;
  implementation.load = (loader, accept, generation) => load(() => {
    attempts++;
    return attempts === 1 ? Promise.reject(new Error("import unavailable")) : loader();
  }, accept, generation);
  let mounts = 0;
  const warnings: string[] = [];
  const ctx = {
    hasUI: true, mode: "tui",
    ui: {
      custom() { mounts++; return Promise.resolve(); },
      notify(message: string) { warnings.push(message); },
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  runtime.bindSession(ctx);
  const overlays = new TranscriptOverlayActions(runtime);
  const group: ToolGroupSnapshot = {
    id: "retry", anchorToolCallId: "call", presentation: "grouped", status: "completed",
    createdAt: 0, updatedAt: 1, failureCount: 0, runningCount: 0, activities: [],
  };
  const open = () => overlays.openGroup(ctx, group, 5_000, DEFAULT_OVERLAY, DEFAULT_DIFF, () => "tool");
  await open();
  assert.equal(mounts, 0);
  assert.match(warnings[0]!, /import unavailable/u);
  assert.equal(implementation.state, "idle");
  await open();
  assert.equal(mounts, 1, "the same session retries the real implementation and mounts the panel");
  assert.equal(attempts, 2);
  assert.equal(implementation.state, "ready");
  assert.equal(implementation.error, undefined);
  assert.equal(warnings.length, 1);
  await runtime.dispose("quit");
});
