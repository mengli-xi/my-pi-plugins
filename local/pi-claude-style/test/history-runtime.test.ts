import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container, Editor, ScrollView, TuiAltScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { installFullHistory, PROBES } from "../src/compat/full-history.ts";
import { historyInputEntries, historyProjectionEntries, subscribeHistoryProjection } from "../src/history-window.ts";
import { disposePresentationOwner, installPresentationOwner } from "../src/presentation-owner.ts";
import { auditInternals } from "../src/internals.ts";

const timestamp = "2026-10-19T00:00:00.000Z";
function message(id: number, role: "user" | "assistant", content: unknown): SessionEntry {
  return { type: "message", id: String(id), parentId: null, timestamp, message: { role, content, timestamp: id } } as SessionEntry;
}
async function waitFor(condition: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "history update did not complete within 2s");
    await new Promise(done => setTimeout(done, 5));
  }
}

/** Real native entry conversion/editor history and public layout, with only
 * component construction stubbed. No Pi process, provider or request is used. */
function fixture() {
  const handlers = new Map<string, Set<Function>>();
  const pi = { on(name: string, handler: Function) {
    const set = handlers.get(name) ?? new Set(); set.add(handler); handlers.set(name, set);
    return () => { set.delete(handler); };
  }, registerMessageRenderer() {}, registerEntryRenderer() {} } as unknown as ExtensionAPI;
  const terminal = { columns: 120, rows: 40, write() {}, setProgress() {} } as unknown as Terminal;
  const renderer = new TuiAltScreen(terminal);
  const chat = new Container(), document = new Container();
  document.addChild(chat); renderer.addChild(document);
  const scroll = new ScrollView(document, { primary: true, follow: "end" });
  renderer.setLayoutRoot(scroll);
  const layout = () => { (renderer as any).currentLayout = renderLayoutFrame(scroll, 120, 40, () => {}); };
  const entries: SessionEntry[] = [];
  for (let user = 0; user < 150; user++) {
    entries.push(message(entries.length, "user", ` input-${user} `));
    for (let i = 0; i < 10; i++) entries.push(message(entries.length, "assistant", []));
  }
  let context = entries, idle = true, failProjection = false;
  const manager = { getBranch: () => entries, buildContextEntries: () => context, getSessionId: () => "history-runtime" };
  const editor = { history: [] as string[], addToHistory: Editor.prototype.addToHistory };
  const selections: boolean[] = [];
  const nativeReset = renderer.resetTextSelection;
  const add = (text: string) => chat.addChild({ render: () => [text], invalidate() {} });
  const receiver = Object.assign(Object.create(InteractiveMode.prototype), {
    renderer, chatContainer: chat, isInitialized: true, footer: { invalidate() {} },
    programStatus: { handleEvent() {} },
    ui: { requestRender() {} }, defaultEditor: {}, clearStatusIndicator() {}, flushCompactionQueue: async () => {},
    entriesRenderedByBoundaryCompaction: new Set(),
    renderSessionItems(items: any[], options: { populateHistory?: boolean }) {
      selections.push(renderer.resetTextSelection === nativeReset);
      for (const item of items) {
        if (item.role === "user") {
          const text = typeof item.content === "string" ? item.content : item.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
          if (options.populateHistory) editor.addToHistory.call(editor as any, text);
          add(text.trim());
        } else if (item.role === "compactionSummary") add("summary");
      }
    },
    addMessageToChat(item: { role: string; content: string }, options: { populateHistory?: boolean }) {
      if (item.role === "compactionSummary") add("summary");
      if (item.role === "user") { add(item.content); if (options?.populateHistory) editor.addToHistory.call(editor as any, item.content); }
    },
  });
  Object.defineProperty(receiver, "sessionManager", { value: manager });
  Object.defineProperty(receiver, "settingsManager", { value: { getShowTerminalProgress: () => false } });
  const ctx = { mode: "tui", hasUI: true, isIdle: () => idle, sessionManager: manager,
    ui: { setWidget(_key: string, factory: (tui: TuiAltScreen) => Component) { factory(renderer); } },
  } as unknown as ExtensionContext;
  installPresentationOwner(pi);
  const history = installFullHistory(pi);
  const projections: readonly SessionEntry[][] = [];
  const stopProjection = subscribeHistoryProjection(pi, values => {
    if (failProjection) { failProjection = false; throw new Error("projection failure after selection suppression"); }
    (projections as SessionEntry[][]).push([...values]);
  });
  const emit = (name: string) => { for (const fn of handlers.get(name) ?? []) fn({}, ctx); };
  emit("session_start"); emit("resources_discover"); history.attach(renderer);
  receiver.renderSessionEntries(context, { populateHistory: true }); layout();
  const header = () => chat.children.find(component => component.render(120).join("").startsWith("↑ 加载更早的"));
  const load = async () => {
    const before = selections.length;
    header()?.handleMouse?.({ type: "click", button: "left", x: 0, y: 0 } as any);
    // A geometry failure falls back one timer later, so wait past the first load.
    await waitFor(() => selections.length > before && renderer.resetTextSelection === nativeReset);
    layout();
  };
  return { pi, entries, editor, renderer, chat, receiver, nativeReset, projections, selections, header, load, emit,
    text: () => chat.render(120).join("\n"), setContext(value: SessionEntry[]) { context = value; },
    setIdle(value: boolean) { idle = value; }, failProjection() { failProjection = true; },
    breakGeometry() { (renderer as any).currentLayout.root = { children: [] }; },
    close() { stopProjection(); history.dispose(); disposePresentationOwner(pi); },
  };
}

test("input history retains the last 100 inputs independently of assistant-heavy transcript batches", async () => {
  const f = fixture();
  try {
    await waitFor(() => f.editor.history.length === 100);
    assert.equal(f.text().match(/input-/gu)?.length, 19);
    const expected = Array.from({ length: 100 }, (_, index) => `input-${149 - index}`);
    assert.deepEqual(f.editor.history, expected);
    while (f.header()) await f.load();
    assert.equal(f.text().match(/input-/gu)?.length, 150);
    assert.deepEqual(f.editor.history, expected);
  } finally { f.close(); }
});

test("input selection matches native trimming, adjacent dedup and image-only/blank exclusion", () => {
  const entries = [message(1, "user", " a "), message(2, "assistant", []), message(3, "user", "a"),
    message(4, "user", [{ type: "image", data: "", mimeType: "image/png" }]), message(5, "user", "   "),
    message(6, "user", [{ type: "text", text: " b" }, { type: "text", text: "c " }]), message(7, "user", "a")];
  const apply = (values: readonly SessionEntry[]) => {
    const editor = { history: [] as string[] };
    for (const entry of values) if (entry.type === "message" && entry.message.role === "user") {
      const content = entry.message.content;
      Editor.prototype.addToHistory.call(editor as any, typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join(""));
    }
    return editor.history;
  };
  assert.deepEqual(apply(historyInputEntries(entries)), apply(entries));
  assert.deepEqual(apply(entries), ["a", "bc", "a"]);
});

for (const failure of ["geometry", "projection", "selection"] as const) test(`installed adapter fully restores native context after live ${failure} failure`, async () => {
  const f = fixture();
  try {
    if (failure === "geometry") f.breakGeometry();
    else if (failure === "projection") f.failProjection();
    else delete (f.renderer as any).selectionInitialRange;
    await f.load();
    assert.equal(f.header(), undefined);
    assert.equal(f.text().match(/input-/gu)?.length, 150);
    assert.deepEqual(f.projections.at(-1), f.entries);
    assert.deepEqual(historyProjectionEntries(f.pi, [], () => f.entries), f.entries);
    assert.equal(f.renderer.resetTextSelection, f.nativeReset);
    assert.equal(f.selections.at(-1), true, "native selection must be restored before fallback rendering");
    assert.ok(auditInternals().some(row => row.id.startsWith("history.") && row.state === "broken"));
  } finally { f.close(); }
});

test("runtime fallback waits for idle and then rebuilds on the settled boundary", async () => {
  const f = fixture();
  try {
    f.setIdle(false);
    const before = f.selections.length;
    delete (f.renderer as any).selectionInitialRange;
    f.receiver.renderSessionEntries(f.entries);
    // The fallback is a 0ms timer queued before this one, so it has run once
    // while busy by the time this resolves; it must not rebuild. A longer
    // fallback delay would make this check vacuous.
    await new Promise(done => setTimeout(done, 0));
    assert.equal(f.text().match(/input-/gu)?.length, 19);
    f.setIdle(true); f.emit("agent_settled");
    await waitFor(() => f.selections.length > before);
    assert.equal(f.text().match(/input-/gu)?.length, 150);
    assert.equal(f.header(), undefined);
    assert.deepEqual(f.projections.at(-1), f.entries);
  } finally { f.close(); }
});

test("compaction probe rejects unchanged method names with deferred clear/render", async () => {
  const proto = InteractiveMode.prototype as any, original = proto.handleEvent;
  proto.handleEvent = async function (event: any) {
    // Same contracts: entry_appended / compaction_end / chatContainer / renderSessionEntries.
    await Promise.resolve();
    return original.call(this, event);
  };
  try {
    assert.equal(PROBES.find(probe => probe.id === "history.renderEntries")!.check!(), false);
    await Promise.resolve();
  } finally { proto.handleEvent = original; }
});

test("live conditional compaction drift is detected and restores one native summary/projection", async () => {
  const proto = InteractiveMode.prototype as any, original = proto.handleEvent;
  let defer = false;
  proto.handleEvent = function (event: any) {
    // Same contracts: entry_appended / compaction_end / chatContainer / renderSessionEntries.
    return defer ? Promise.resolve().then(() => original.call(this, event)) : original.call(this, event);
  };
  const f = fixture();
  try {
    const entry = { type: "compaction", id: "live-compaction", parentId: null, timestamp,
      summary: "synthetic", tokensBefore: 1, firstKeptEntryId: f.entries.at(-11)!.id } as SessionEntry;
    f.entries.push(entry);
    const context = [entry, ...f.entries.slice(-12, -1)];
    f.setContext(context); defer = true;
    await f.receiver.handleEvent({ type: "compaction_end", result: entry });
    await waitFor(() => f.projections.at(-1)?.[0] === entry);
    assert.equal(f.text().match(/summary/gu)?.length, 1);
    assert.equal(f.header(), undefined);
    assert.deepEqual(f.projections.at(-1), context);
    defer = false;
    assert.equal(auditInternals().find(row => row.id === "history.renderEntries")?.state, "broken");
  } finally { f.close(); proto.handleEvent = original; }
});
