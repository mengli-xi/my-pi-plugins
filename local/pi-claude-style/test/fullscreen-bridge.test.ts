import { AgentSession, InteractiveMode, UserMessageComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { installRetryRecording, installRetryViewProjection, PROBES as RETRY_PROBES } from "../src/compat/retry-session.ts";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { loadApprovedFactoryModule } from "../../pi-session-runtime/src/factory-loader.ts";
import { fileURLToPath } from "node:url";
import { PROBES as WIDGET_PROBES } from "../src/host/widget-spacing.ts";
import { DEFAULT_EFFECTIVE_CONFIG } from "../src/config/defaults.ts";
const DEFAULT_CONFIG = DEFAULT_EFFECTIVE_CONFIG.layout;
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { auditInternals, flushInternalsHealth, declareProbes, HEALTH_PATH, markBroken, resetInternals, setHealthPath } from "../src/internals.ts";

import {
  Container,
  Editor as NativeEditor,
  ScrollView,
  TuiAltScreen,
  stripTerminalSequences,
  VStack,
  type Component,
  type Terminal,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { resolvePublishedEditorSlotGeometry } from "../src/host/fullscreen/editor-slot.ts";
import { HistoryAnchor } from "../src/history-batches.ts";
import {
  fullscreenOutsideClickPatched,
  installFullscreenBridge,
  snapshotFullscreenEditorSlot,
  PROBES,
} from "../src/host/fullscreen/bridge.ts";

const warmBridge = installFullscreenBridge();
await new Promise(resolve => setImmediate(resolve));
warmBridge.release();

class Lines implements Component {
  readonly lines: string[];
  constructor(lines: string[]) { this.lines = lines; }
  render(): string[] { return this.lines; }
  invalidate(): void {}
}

class Editor extends Lines {
  getText(): string { return "draft"; }
  setText(): void {}
  handleInput(): void {}
}

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  private input: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.input = undefined; }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  send(data: string): void { this.input?.(data); }
}

function fullscreen(rows = 24) {
  const terminal = new FakeTerminal();
  terminal.rows = rows;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false });
  const transcript = new ScrollView(new Lines(Array.from({ length: 40 }, (_, index) => `chat-${index}`)), {
    follow: "end",
    primary: true,
  });
  const pending = new Lines([]);
  const status = new Lines(["status"]);
  const above = new Lines(["todo"]);
  const editor = new Editor(["editor-top", "draft", "editor-bottom"]);
  const editorRoot = new Container();
  editorRoot.addChild(editor);
  const below = new Lines(["statusline"]);
  const footer = new Lines(["footer"]);
  const dock = new VStack([
    { component: pending, shrink: 1, minSize: 0 },
    { component: status, shrink: 1, minSize: 0 },
    { component: above, shrink: 1, minSize: 0 },
    { component: editorRoot, shrink: 1, minSize: 3 },
    { component: below, shrink: 1, minSize: 0 },
    { component: footer, shrink: 1, minSize: 1 },
  ]);
  tui.setLayoutRoot(new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]));
  return { tui, terminal, editorRoot, transcript };
}

test("reads the allocated fullscreen editor bottom, including short-terminal shrink", () => {
  const normal = fullscreen(24);
  assert.deepEqual(snapshotFullscreenEditorSlot(normal.tui), {
    version: 1,
    width: 80,
    bottomMargin: 2,
    availableHeight: 22,
  });

  const short = fullscreen(8);
  const geometry = snapshotFullscreenEditorSlot(short.tui);
  assert.ok(geometry);
  assert.equal(geometry.width, 80);
  assert.equal(geometry.availableHeight + geometry.bottomMargin, 8);
  assert.equal(geometry.availableHeight, 6, "uses allocated rows, not six natural trailing rows");
});

test("recomputes fullscreen geometry after a resize before the next host frame", () => {
  const view = fullscreen(24);
  assert.equal(snapshotFullscreenEditorSlot(view.tui)?.availableHeight, 22);
  view.terminal.rows = 8;
  assert.equal(snapshotFullscreenEditorSlot(view.tui)?.availableHeight, 6);
});

function isolatedGeometryHealth(t: test.TestContext): () => ReturnType<typeof auditInternals>[number] | undefined {
  const root = mkdtempSync(join(tmpdir(), "pinned-geometry-health-"));
  resetInternals(); setHealthPath(join(root, "health.json")); declareProbes(PROBES);
  t.after(async () => { await flushInternalsHealth(); resetInternals(); setHealthPath(HEALTH_PATH); rmSync(root, { recursive: true, force: true }); });
  return () => auditInternals().find(row => row.id === "fullscreen.editorGeometry");
}

test("a native non-editor replacement has no geometry without poisoning probe health", (t) => {
  const health = isolatedGeometryHealth(t);
  const view = fullscreen();
  assert.ok(snapshotFullscreenEditorSlot(view.tui));
  view.editorRoot.clear();
  view.editorRoot.addChild(new Lines(["custom view"]));
  assert.equal(snapshotFullscreenEditorSlot(view.tui), undefined);
  assert.equal(health()?.state, "ok");
});

test("first fullscreen attach validates stale geometry health using an existing native frame", (t) => {
  const health = isolatedGeometryHealth(t);
  const view = fullscreen();
  const host = view.tui as unknown as { layoutRoot: Component; currentLayout: ReturnType<typeof renderLayoutFrame> };
  host.currentLayout = renderLayoutFrame(host.layoutRoot, 80, 24, () => {});
  markBroken("fullscreen.editorGeometry", "currentLayout 中找不到 editor box");
  const support = installFullscreenBridge();
  t.after(() => support.release());
  support.prepare(view.tui, DEFAULT_CONFIG);
  assert.equal(health()?.state, "ok");
});

test("geometry diagnostics do not force an early layout and still report real rendering failures", (t) => {
  const health = isolatedGeometryHealth(t);
  class BrokenLayout extends Lines { override render(): string[] { throw new Error("layout failed"); } }
  const broken = fullscreen();
  broken.tui.setLayoutRoot(new BrokenLayout([]));
  const support = installFullscreenBridge();
  t.after(() => support.release());
  support.prepare(broken.tui, DEFAULT_CONFIG);
  assert.notEqual(health()?.state, "broken", "attach must wait for a native frame rather than render the unfinished tree");
  assert.equal(snapshotFullscreenEditorSlot(broken.tui), undefined);
  assert.equal(health()?.state, "broken");
  assert.match(health()?.detail ?? "", /layout failed/u);
});

test("a runtime resolver follows its explicitly prepared TUI and resize", () => {
  const support = installFullscreenBridge();
  const first = fullscreen(24);
  const replacement = fullscreen(8);
  support.prepare(first.tui, DEFAULT_CONFIG);
  assert.deepEqual(resolvePublishedEditorSlotGeometry(first.tui), {
    version: 1,
    width: 80,
    bottomMargin: 2,
    availableHeight: 22,
  });
  assert.equal(resolvePublishedEditorSlotGeometry(replacement.tui), undefined);
  support.prepare(replacement.tui, DEFAULT_CONFIG);
  assert.equal(resolvePublishedEditorSlotGeometry(first.tui), undefined);
  assert.equal(resolvePublishedEditorSlotGeometry(replacement.tui)?.availableHeight, 6);
  replacement.terminal.rows = 12;
  assert.equal(resolvePublishedEditorSlotGeometry(replacement.tui)?.availableHeight, 10);
  support.release();
  assert.equal(resolvePublishedEditorSlotGeometry(replacement.tui), undefined);
});

test("native dispatch owns inside wheel, capture and release without raw input", () => {
  const support = installFullscreenBridge();
  const { tui, terminal } = fullscreen();
  const received: TuiMouseEvent[] = [];
  let raw = 0;
  const overlay = {
    focused: false, wantsMouse: true,
    render: () => ["overlay"], invalidate() {},
    handleInput() { raw++; },
    handleMouse(event: TuiMouseEvent) {
      received.push(event);
      return { handled: true, capture: event.type === "press" };
    },
  };
  try {
    tui.showOverlay(overlay, { anchor: "bottom-left", width: "100%" });
    tui.start();
    tui.renderNow();
    for (const report of ["\x1b[<64;2;24M", "\x1b[<0;2;24M", "\x1b[<32;3;2M", "\x1b[<0;3;2m"]) terminal.send(report);
    assert.deepEqual(received.map(event => event.type), ["wheel", "press", "drag", "release"]);
    assert.equal(received[1]?.y, 0);
    assert.equal(received[2]?.screenY, 1, "capture reaches outside the panel");
    assert.equal(raw, 0);
  } finally { support.release(); tui.stop(); }
});

test("only outside left press is adapted, and closing cannot dispatch to the restored editor", () => {
  const support = installFullscreenBridge();
  const { tui, terminal } = fullscreen();
  let editorMouse = 0;
  const editor = { render: () => ["editor"], invalidate() {}, handleMouse() { editorMouse++; return { handled: true }; } };
  tui.setFocus(editor);
  const received: string[] = [];
  let hide: () => void;
  const overlay = { focused: false, wantsMouse: true, render: () => ["overlay"], invalidate() {},
    handleMouse(event: TuiMouseEvent) {
      received.push(event.type);
      if (event.type === "press") hide();
      return { handled: true };
    },
  };
  try {
    hide = tui.showOverlay(overlay, { anchor: "bottom-left", width: "100%" }).hide;
    tui.start();
    tui.renderNow();
    terminal.send("\x1b[<64;2;2M");
    terminal.send("\x1b[<2;2;2M");
    assert.deepEqual(received, []);
    terminal.send("\x1b[<0;2;2M");
    terminal.send("\x1b[<0;2;2m");
    assert.equal(received.filter(type => type === "press").length, 1);
    assert.equal(editorMouse, 0);
  } finally { support.release(); tui.stop(); }
});

test("independent host prototypes retain exact patch/probe state through opposite and late teardown", async (t) => {
  isolatedGeometryHealth(t);
  const selectionTheme = {
    getBgAnsi: () => "\x1b[48;5;22m", getFgAnsi: () => "\x1b[38;5;231m",
  } as unknown as Theme;
  class OtherMode {}
  class OtherTui extends TuiAltScreen {}
  const methods = ["applySelectionHighlight", "applySelection", "dispatchMouseToOverlay"];
  const nativeMethods = methods.map(key => Reflect.get(TuiAltScreen.prototype, key));
  for (const [index, key] of methods.entries()) Object.defineProperty(OtherTui.prototype, key, {
    configurable: true, writable: true, value: nativeMethods[index],
  });
  const nativeWidgets = Reflect.get(piCodingAgent.InteractiveMode.prototype, "renderWidgetContainer");
  Object.defineProperty(OtherMode.prototype, "renderWidgetContainer", { configurable: true, writable: true, value: nativeWidgets });
  // Use the same approved loader as SDK consumers, with genuinely independent
  // prototype identities and Pi's unchanged native methods, not weaker mocks.
  const loaded = await loadApprovedFactoryModule({
    path: fileURLToPath(new URL("../src/host/fullscreen/bridge.ts", import.meta.url)),
    exports: ["installFullscreenBridge"],
    publicModules: {
      "@earendil-works/pi-coding-agent": { ...piCodingAgent, InteractiveMode: OtherMode },
      "@earendil-works/pi-tui": { ...piTui, TuiAltScreen: OtherTui },
    },
  });
  const installOther = loaded.installFullscreenBridge as typeof installFullscreenBridge;
  const first = installFullscreenBridge();
  const main = fullscreen();
  const config = { ...DEFAULT_CONFIG, stickyUserMessage: false, floatAutocomplete: false };
  first.prepare(main.tui, config, () => selectionTheme);
  const firstSelection = Reflect.get(TuiAltScreen.prototype, "applySelectionHighlight");
  const firstWidgets = Reflect.get(piCodingAgent.InteractiveMode.prototype, "renderWidgetContainer");
  const second = installOther();
  const other = new OtherTui(new FakeTerminal());
  second.prepare(other, config, () => selectionTheme);
  let replacement: ReturnType<typeof installFullscreenBridge> | undefined;
  try {
    assert.equal(PROBES.find(probe => probe.id === "fullscreen.selectionColors")?.check?.(), true);
    assert.equal(WIDGET_PROBES[0]?.check?.(), true);
    for (const id of ["fullscreen.selectionColors", "shell.widgetSpacing"]) {
      assert.equal(auditInternals().find(probe => probe.id === id)?.state, "ok", `the second host's ${id} remains strict and healthy`);
    }
    second.release();
    assert.equal(Reflect.get(TuiAltScreen.prototype, "applySelectionHighlight"), firstSelection);
    assert.equal(Reflect.get(piCodingAgent.InteractiveMode.prototype, "renderWidgetContainer"), firstWidgets);
    replacement = installOther();
    const replaced = methods.map(key => Reflect.get(OtherTui.prototype, key));
    second.release();
    assert.deepEqual(methods.map(key => Reflect.get(OtherTui.prototype, key)), replaced, "late teardown cannot overwrite a replacement host");
    first.release();
    assert.deepEqual(methods.map(key => Reflect.get(TuiAltScreen.prototype, key)), nativeMethods);
    assert.deepEqual(methods.map(key => Reflect.get(OtherTui.prototype, key)), replaced);
  } finally { first.release(); second.release(); replacement?.release(); }
  assert.deepEqual(methods.map(key => Reflect.get(OtherTui.prototype, key)), nativeMethods);
  assert.equal(Reflect.get(piCodingAgent.InteractiveMode.prototype, "renderWidgetContainer"), nativeWidgets);
  assert.equal(Reflect.get(OtherMode.prototype, "renderWidgetContainer"), nativeWidgets);
});

test("retry recording isolates host prototype pairs, interleaved leases and late replacement teardown", async (t) => {
  isolatedGeometryHealth(t);
  class OtherSession {}
  class OtherMode {}
  const bind = AgentSession.prototype.bindExtensions, init = InteractiveMode.prototype.init;
  Object.defineProperty(OtherSession.prototype, "bindExtensions", { configurable: true, writable: true, value: bind });
  Object.defineProperty(OtherMode.prototype, "init", { configurable: true, writable: true, value: init });
  const loaded = await loadApprovedFactoryModule({
    path: fileURLToPath(new URL("../src/compat/retry-session.ts", import.meta.url)),
    exports: ["installRetryRecording", "installRetryViewProjection"],
    publicModules: {
      "@earendil-works/pi-coding-agent": { ...piCodingAgent, AgentSession: OtherSession, InteractiveMode: OtherMode },
      "@earendil-works/pi-tui": piTui,
    },
  });
  const installOther = loaded.installRetryRecording as typeof installRetryRecording;
  const projectOther = loaded.installRetryViewProjection as typeof installRetryViewProjection;
  type Handler = (event: unknown, ctx: { sessionManager: object }) => unknown;
  function extension() {
    const handlers = new Map<string, Set<Handler>>();
    const api = { on(name: string, handler: Handler) {
      const listeners = handlers.get(name) ?? new Set(); handlers.set(name, listeners); listeners.add(handler);
      return () => { listeners.delete(handler); };
    } } as unknown as ExtensionAPI;
    return { api, async start(sessionManager: object) {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, { sessionManager });
    } };
  }
  function session(prototype: object, owner: ReturnType<typeof extension>) {
    const manager = {}, listeners = new Set<Parameters<AgentSession["subscribe"]>[0]>();
    const value = Object.create(prototype) as AgentSession;
    let applications = 0;
    const fields = { sessionManager: manager,
      subscribe(listener: Parameters<AgentSession["subscribe"]>[0]) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      _sessionStartEvent: { type: "session_start", reason: "startup" },
      _extensionRunner: { emit: () => owner.start(manager), reportUnhandledMcpServers() {} },
      _applyExtensionBindings() { applications++; }, async extendResourcesFromExtensions() {},
    };
    Object.defineProperties(value, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, writable: true, configurable: true }])));
    return { value, listeners, applications: () => applications, retry(attempt: number) {
      for (const listener of listeners) listener({ type: "auto_retry_start", attempt, maxAttempts: 10, delayMs: 5000, errorMessage: "503 overloaded" });
    } };
  }
  const owners = [extension(), extension(), extension(), extension(), extension()];
  const first = installRetryRecording(owners[0]!.api), shared = installRetryRecording(owners[1]!.api);
  const mainBind = AgentSession.prototype.bindExtensions, mainInit = InteractiveMode.prototype.init;
  const other = installOther(owners[2]!.api);
  const recordings = [first, shared, other], releases: Array<() => void> = [];
  const mainView = Object.assign(Object.create(InteractiveMode.prototype), { isInitialized: true }) as InteractiveMode;
  const otherView = Object.assign(Object.create(OtherMode.prototype), { isInitialized: true }) as InteractiveMode;
  const projected: string[] = [];
  releases.push(installRetryViewProjection(mode => { assert.equal(mode, mainView); projected.push("main"); }));
  releases.push(projectOther(mode => { assert.equal(mode, otherView); projected.push("other"); }));
  try {
    assert.ok(recordings.every(recording => recording.available));
    assert.notEqual(mainBind, bind); assert.notEqual(Reflect.get(OtherSession.prototype, "bindExtensions"), bind);
    assert.notEqual(mainInit, init); assert.notEqual(Reflect.get(OtherMode.prototype, "init"), init);
    for (const probe of RETRY_PROBES) assert.equal(probe.check?.(), true, probe.id);
    for (const { id } of RETRY_PROBES) assert.equal(auditInternals().find(probe => probe.id === id)?.state, "ok", `other host: ${id}`);
    const sessions = [session(AgentSession.prototype, owners[0]!), session(AgentSession.prototype, owners[1]!), session(OtherSession.prototype, owners[2]!)];
    for (const [index, item] of sessions.entries()) {
      await item.value.bindExtensions({ mode: "print" }); item.retry(index + 1);
      assert.equal(item.applications(), 1, "the original bind body receives the call");
      assert.equal(Reflect.get(item.value, "_extensionMode"), "print");
      assert.equal(recordings[index]!.snapshot()?.attempt, index + 1);
    }
    await mainView.init(); await otherView.init(); assert.deepEqual(projected, ["main", "other"]);
    const failure = new Error("native init failed");
    await assert.rejects(mainInit.call(Object.defineProperty({}, "isInitialized", { get() { throw failure; } }) as InteractiveMode), error => error === failure);
    assert.deepEqual(projected, ["main", "other"], "failed native init never projects a view");
    first.dispose(); assert.equal(sessions[0]!.listeners.size, 0);
    assert.equal(shared.snapshot()?.attempt, 2); assert.equal(sessions[1]!.listeners.size, 1);
    assert.equal(AgentSession.prototype.bindExtensions, mainBind); assert.equal(InteractiveMode.prototype.init, mainInit);
    other.dispose(); assert.equal(Reflect.get(OtherSession.prototype, "bindExtensions"), bind); assert.equal(Reflect.get(OtherMode.prototype, "init"), init);
    assert.equal(AgentSession.prototype.bindExtensions, mainBind);
    const replacementOther = installOther(owners[3]!.api); recordings.push(replacementOther);
    const otherBind = Reflect.get(OtherSession.prototype, "bindExtensions"), otherInit = Reflect.get(OtherMode.prototype, "init");
    releases.push(projectOther(() => projected.push("replacement-other")));
    releases[1]!(); other.dispose();
    assert.equal(Reflect.get(OtherSession.prototype, "bindExtensions"), otherBind); assert.equal(Reflect.get(OtherMode.prototype, "init"), otherInit);
    await otherView.init(); assert.equal(projected.at(-1), "replacement-other");
    shared.dispose(); assert.equal(AgentSession.prototype.bindExtensions, bind); assert.equal(InteractiveMode.prototype.init, init);
    assert.equal(Reflect.get(OtherSession.prototype, "bindExtensions"), otherBind);
    const replacementMain = installRetryRecording(owners[4]!.api); recordings.push(replacementMain);
    const replacedBind = AgentSession.prototype.bindExtensions, replacedInit = InteractiveMode.prototype.init;
    releases.push(installRetryViewProjection(() => projected.push("replacement-main")));
    releases[0]!(); first.dispose(); shared.dispose();
    assert.equal(AgentSession.prototype.bindExtensions, replacedBind); assert.equal(InteractiveMode.prototype.init, replacedInit);
    await mainView.init(); assert.equal(projected.at(-1), "replacement-main");
    for (const [prototype, owner, recording] of [[AgentSession.prototype, owners[4]!, replacementMain], [OtherSession.prototype, owners[3]!, replacementOther]] as const) {
      const item = session(prototype, owner); await item.value.bindExtensions({ mode: "print" }); item.retry(7); assert.equal(recording.snapshot()?.attempt, 7);
    }
    // Re-declare the other realm's real probes through a temporary same-pair lease.
    const validation = installOther(extension().api); recordings.push(validation); assert.equal(validation.available, true);
    for (const probe of RETRY_PROBES) assert.equal(probe.check?.(), true, probe.id);
    for (const { id } of RETRY_PROBES) assert.equal(auditInternals().find(probe => probe.id === id)?.state, "ok", `other host after replacement: ${id}`);
  } finally { for (const recording of [...recordings].reverse()) recording.dispose(); for (const release of releases) release(); }
  assert.equal(AgentSession.prototype.bindExtensions, bind); assert.equal(InteractiveMode.prototype.init, init);
  assert.equal(Reflect.get(OtherSession.prototype, "bindExtensions"), bind); assert.equal(Reflect.get(OtherMode.prototype, "init"), init);
});

test("runtime owners share one patch and the last release restores Pi", () => {
  const nativeSelection = Reflect.get(TuiAltScreen.prototype, "applySelection");
  const first = installFullscreenBridge();
  const second = installFullscreenBridge();
  const sharedSelection = Reflect.get(TuiAltScreen.prototype, "applySelection");
  assert.notEqual(sharedSelection, nativeSelection);
  assert.equal(fullscreenOutsideClickPatched(), true);
  first.release();
  assert.equal(fullscreenOutsideClickPatched(), true);
  assert.equal(Reflect.get(TuiAltScreen.prototype, "applySelection"), sharedSelection);
  second.release();
  assert.equal(fullscreenOutsideClickPatched(), false);
  assert.equal(Reflect.get(TuiAltScreen.prototype, "applySelection"), nativeSelection);
  second.release();
  assert.equal(fullscreenOutsideClickPatched(), false);
  assert.equal(Reflect.get(TuiAltScreen.prototype, "applySelection"), nativeSelection);
});

test("ordinary fullscreen selection keeps owning mouse reports without a mouse overlay", () => {
  const support = installFullscreenBridge();
  const { tui, terminal } = fullscreen();
  let received = 0;
  const focused = {
    focused: false,
    render: () => ["focused"],
    invalidate() {},
    handleInput() { received++; },
  };
  tui.showOverlay(focused, { anchor: "bottom-left" });
  tui.start();
  terminal.send("\x1b[<0;2;2M");
  assert.equal(received, 0);
  support.release();
  tui.stop();
});


const editorTheme = {
  borderColor: (text: string) => text,
  selectList: { selectedPrefix: (text: string) => text, selectedText: (text: string) => text,
    description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text },
};

async function nativeAutocompleteView(useReference = false) {
  const view = fullscreen();
  const editor = new NativeEditor(view.tui, editorTheme);
  editor.setAutocompleteProvider({
    getSuggestions: async () => ({ prefix: "/", items: [{ value: "/one", label: "one" }, { value: "/two", label: "two" }] }),
    applyCompletion: (_lines, _line, _col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }),
  });
  view.editorRoot.clear(); view.editorRoot.addChild(editor);
  view.tui.addChild(view.editorRoot);
  view.tui.setFocus(editor);
  const support = installFullscreenBridge();
  const reference = useReference ? new Proxy(view.tui, {
    get(target, key) { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; },
  }) : view.tui;
  support.prepare(reference, { ...DEFAULT_CONFIG, popupGap: 0, stickyUserMessage: false });
  view.tui.start(); view.tui.renderNow();
  editor.handleInput("/");
  await new Promise(resolve => setImmediate(resolve));
  view.tui.renderNow();
  return { ...view, editor, support };
}

test("fullscreen completion floats above a constant-height editor and keeps keyboard focus", async () => {
  const { tui, editor, support } = await nativeAutocompleteView();
  try {
    assert.equal(editor.render(80).length, 3, "autocomplete never grows the editor or shrinks transcript");
    assert.equal(tui.getFocusedComponent(), editor);
    const screen = (tui as unknown as { previousScreen: string[] }).previousScreen;
    const input = screen.findIndex(line => line.includes("/"));
    const suggestion = screen.findIndex(line => line.includes("one"));
    assert.ok(suggestion >= 0 && suggestion < input, "suggestions precede the input row");
    editor.handleInput("\t");
    assert.equal(editor.getText(), "/one");
    editor.handleInput("\x1b"); tui.renderNow();
    assert.equal(editor.isShowingAutocomplete(), false);
    assert.equal(tui.getFocusedComponent(), editor);
  } finally { support.release(); tui.stop(); }
});

test("clicking fullscreen floating completion applies exactly once without focusing overlay", async () => {
  const { tui, editor, terminal, support } = await nativeAutocompleteView();
  try {
    const screen = (tui as unknown as { previousScreen: string[] }).previousScreen;
    const row = screen.findIndex(line => line.includes("two")) + 1;
    assert.ok(row > 0);
    terminal.send(`\x1b[<0;4;${row}M`); terminal.send(`\x1b[<0;4;${row}m`);
    assert.equal(editor.getText(), "/two");
    assert.equal(editor.isShowingAutocomplete(), false);
    assert.equal(tui.getFocusedComponent(), editor);
  } finally { support.release(); tui.stop(); }
});

test("disable and release restore native editor rendering", async () => {
  const { tui, editor, support } = await nativeAutocompleteView();
  try {
    support.prepare(tui, { ...DEFAULT_CONFIG, floatAutocomplete: false });
    assert.ok(editor.render(80).length > 3);
    support.prepare(tui, DEFAULT_CONFIG);
    tui.renderNow();
    assert.equal(editor.render(80).length, 3);
    support.release();
    assert.ok(editor.render(80).length > 3);
  } finally { support.release(); tui.stop(); }
});


test("frame capture follows the stable TUI reference supplied to extension factories", async () => {
  const { tui, editor, support } = await nativeAutocompleteView(true);
  try {
    const screen = (tui as unknown as { previousScreen: string[] }).previousScreen;
    assert.ok(screen.findIndex(line => line.includes("one")) >= 0);
    assert.equal(tui.getFocusedComponent(), editor);
  } finally { support.release(); tui.stop(); }
});


function stickyView() {
  const view = fullscreen();
  const document = new Container();
  const makeUser = (text: string): Component => Object.assign(Object.create(UserMessageComponent.prototype), {
    text, render: () => [text, ""], invalidate() {},
  });
  let renders = 0;
  const answer = { render: () => { renders++; return Array.from({ length: 30 }, (_, i) => `answer-${i}`); }, invalidate() {} };
  document.addChild(makeUser("First question")); document.addChild(answer);
  document.addChild(makeUser("Second question")); document.addChild(answer);
  const scroll = new ScrollView(document, { primary: true, follow: "end" });
  const dock = new VStack([{ component: view.editorRoot, basis: "auto" }]);
  view.tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1 }, { component: dock, basis: "auto" }]));
  view.tui.addChild(view.editorRoot);
  const support = installFullscreenBridge();
  support.prepare(view.tui, { ...DEFAULT_CONFIG, floatAutocomplete: false });
  view.tui.start(); view.tui.renderNow();
  return { ...view, scroll, document, support, get renders() { return renders; } };
}

test("fullscreen sticky names the offscreen user without rendering transcript a second time", () => {
  const view = stickyView();
  try {
    view.scroll.scrollTo(8);
    const before = view.renders;
    view.tui.renderNow();
    assert.equal(view.renders - before, 2, "each of the two native answer entries renders exactly once");
    const screen = (view.tui as unknown as { previousScreen: string[] }).previousScreen;
    assert.match(screen[0] ?? "", /▲ First question/);
    assert.equal(view.tui.getFocusedComponent(), null, "sticky never claims keyboard focus");
    assert.equal(view.tui.hasOverlay(), false, "sticky stays in the frame so native selection anchors to transcript");
    view.scroll.scrollTo(35); view.tui.renderNow();
    assert.match((view.tui as unknown as { previousScreen: string[] }).previousScreen[0] ?? "", /▲ Second question/);
  } finally { view.support.release(); view.tui.stop(); }
});

test("clicking fullscreen sticky jumps to its message and hides the duplicate header", () => {
  const view = stickyView();
  try {
    view.scroll.scrollTo(8); view.tui.renderNow();
    view.terminal.send("\x1b[<0;8;1M"); view.terminal.send("\x1b[<0;8;1m"); view.tui.renderNow();
    assert.equal(view.scroll.scrollTop, 0);
    assert.doesNotMatch((view.tui as unknown as { previousScreen: string[] }).previousScreen[0] ?? "", /▲ /);
    view.scroll.scrollTo(1); view.tui.renderNow();
    assert.doesNotMatch((view.tui as unknown as { previousScreen: string[] }).previousScreen[0] ?? "", /▲ /, "partly visible user is not repeated");
  } finally { view.support.release(); view.tui.stop(); }
});

test("an unloaded height anchor preserves the sticky question and its jump position", () => {
  const view = stickyView();
  try {
    let jumps = 0;
    view.document.clear();
    view.document.addChild(new HistoryAnchor(64, [{ summary: "Unloaded question", start: 0, end: 2, jump: () => { jumps++; } }], () => {}));
    view.scroll.scrollTo(8); view.tui.renderNow();
    assert.match((view.tui as any).previousScreen[0], /▲ Unloaded question/u);
    view.terminal.send("\x1b[<0;8;1M"); view.terminal.send("\x1b[<0;8;1m"); view.tui.renderNow();
    assert.equal(view.scroll.scrollTop, 0);
    assert.equal(jumps, 1, "sticky forwards the unloaded record's identity target");
  } finally { view.support.release(); view.tui.stop(); }
});

test("fullscreen sticky toggle and teardown restore document method identity", () => {
  const view = stickyView();
  try {
    view.support.prepare(view.tui, { ...DEFAULT_CONFIG, stickyUserMessage: false, floatAutocomplete: false });
    assert.equal(view.document.render, Container.prototype.render);
    view.support.prepare(view.tui, { ...DEFAULT_CONFIG, floatAutocomplete: false });
    assert.notEqual(view.document.render, Container.prototype.render);
    view.support.release();
    assert.equal(view.document.render, Container.prototype.render);
  } finally { view.support.release(); view.tui.stop(); }
});


test("a real editor keeps native suggestions until the frame seam has delivered a usable layout", async () => {
  for (const prototype of [{}, { compositeScrollToEndIndicator(screen: string[]) { return screen; } }]) {
    const host = Object.assign(Object.create(prototype), {
      mode: "fullscreen", terminal: { columns: 80, rows: 24 }, children: [] as Component[],
      requestRender() {}, showOverlay() { throw new Error("must not float without a frame"); },
    });
    const editor = new NativeEditor(host, editorTheme);
    editor.setAutocompleteProvider({
      getSuggestions: async () => ({ prefix: "/", items: [{ value: "/one", label: "one" }, { value: "/two", label: "two" }] }),
      applyCompletion: () => ({ lines: ["/one"], cursorLine: 0, cursorCol: 4 }),
    });
    editor.handleInput("/");
    await new Promise(resolve => setImmediate(resolve));
    const root = new Container(); root.addChild(editor); host.children.push(root);
    const original = editor.render;
    const native = editor.render(80);
    const bridge = installFullscreenBridge();
    try {
      bridge.prepare(host, DEFAULT_CONFIG);
      assert.equal(editor.render, original);
      assert.deepEqual(editor.render(80), native);
      assert.ok(native.some(line => line.includes("one")));
    } finally { bridge.release(); }
  }
});

test("a failed frame consumer restores the real editor and closes floating autocomplete", async () => {
  const view = await nativeAutocompleteView();
  try {
    assert.equal(view.editor.render(80).length, 3);
    const host = view.tui as unknown as { currentLayout: ReturnType<typeof renderLayoutFrame>;
      compositeScrollToEndIndicator(screen: string[], frame: unknown, width: number): string[] };
    const invalid = { ...host.currentLayout, width: NaN };
    host.compositeScrollToEndIndicator([], invalid, 80);
    assert.equal(auditInternals().find(row => row.id === "fullscreen.frame")?.state, "broken");
    assert.equal(view.editor.render, NativeEditor.prototype.render);
    assert.ok(view.editor.render(80).some(line => line.includes("one")));
    assert.equal(view.tui.hasOverlay(), false);
    view.tui.renderNow();
    assert.equal(view.editor.render(80).length, 3, "a later valid frame can resume floating");
    assert.equal(auditInternals().find(row => row.id === "fullscreen.frame")?.state, "ok");
  } finally { view.support.release(); view.tui.stop(); }
});

test("selection cannot repaint sticky text or redraw it over an overlay", () => {
  const view = stickyView();
  try {
    view.scroll.scrollTo(8); view.tui.renderNow();
    view.terminal.send("\x1b[<0;3;3M"); view.terminal.send("\x1b[<32;7;5M"); view.terminal.send("\x1b[<0;7;5m");
    view.scroll.scrollTo(10); view.tui.renderNow();
    const header = view.tui.getScreenLines()[0]!;
    assert.match(header, /▲ First question/);
    assert.doesNotMatch(header, /\x1b\[7m/, "no native inverse selection on sticky text");
    const overlay = view.tui.showOverlay({ render: () => ["PANEL_COVERS_HEADER"], invalidate() {} }, { row: 0, col: 0, width: "100%" });
    view.tui.renderNow();
    assert.match(stripTerminalSequences(view.tui.getScreenLines()[0]!), /PANEL_COVERS_HEADER/);
    assert.doesNotMatch(view.tui.getScreenLines()[0]!, /First question/);
    overlay.hide();
  } finally { view.support.release(); view.tui.stop(); }
});


test("an unavailable post-selection seam keeps the native method untouched", () => {
  const prototype = TuiAltScreen.prototype as unknown as { applySelection?: unknown };
  const native = prototype.applySelection;
  prototype.applySelection = undefined;
  try {
    const bridge = installFullscreenBridge();
    assert.equal(prototype.applySelection, undefined, "missing method is not replaced with a guessed implementation");
    bridge.release();
    assert.equal(prototype.applySelection, undefined);
  } finally { prototype.applySelection = native; }
});
