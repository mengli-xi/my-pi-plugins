import assert from "node:assert/strict";
import test from "node:test";
import { Container, ScrollView, TuiAltScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { CompactionSummaryMessageComponent, CustomMessageComponent, InteractiveMode, initTheme, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { HistoryAnchor, historyComponentIdentity, historyEvictions, identifyHistoryComponents, isHistoryAnchor, rememberHistoryExpansion } from "../src/history-batches.ts";
import { HistoryResidency, type HistoryViewport } from "../src/history-residency.ts";
import { drawHistory } from "../src/compat/full-history.ts";

test("eviction chooses complete farthest batches with LRU ties and both limits", () => {
  const batches = Array.from({ length: 6 }, (_, index) => ({ start: index * 200, end: (index + 1) * 200,
    top: index * 100, rows: 100, loaded: true, touched: index }));
  assert.deepEqual(historyEvictions(batches, 220, 240, new Set([2, 5]), 800, 1000), [4, 0]);
  assert.deepEqual(historyEvictions(batches, 220, 240, new Set([0, 1, 2, 3, 5]), 200, 1000), [4]);
  assert.equal(historyEvictions(batches, 220, 240, new Set([2, 5]), 10000, 300).length, 3);
});

test("anchor metadata detection leaves foreign renderer proxies untouched", () => {
  const foreign = new Proxy({ render: () => [], invalidate() {} }, { get(target, key) {
    if (typeof key === "symbol") throw new Error("foreign metadata");
    return Reflect.get(target, key);
  } });
  assert.equal(isHistoryAnchor(foreign), false);
  assert.equal(isHistoryAnchor(new HistoryAnchor(10, [{ summary: "question", start: 0, end: 2 }], () => {})), true);
});

function fixture(summary = false, { count = 4000, prefixRows = 0, chatTop = 0, wrapped = false, custom = false } = {}) {
  initTheme("dark");
  const branch = Array.from({ length: count }, (_, id) => ({ type: "message", id: String(id), parentId: null,
    timestamp: "2026-10-19T00:00:00Z", message: { role: "user", content: `row-${id}`, timestamp: id } } as SessionEntry));
  const chat = new Container();
  let banner = custom, width = 80;
  let cache: HistoryResidency;
  const header: Component = { render: () => cache.start > 0 ? ["earlier"] : [], invalidate() {} };
  const draw = (start: number, end: number): Component[] => {
    const result: Component[] = [];
    const sources = new Map<Component, { recordId: string; message: number; presentation?: boolean }>();
    const customMessage = (id: string) => new CustomMessageComponent({ role: "custom", customType: id, content: id, display: true, timestamp: 1 },
      (_message, { expanded }) => ({ render: () => [expanded ? `${id}:expanded` : `${id}:collapsed`], invalidate() {} }));
    if (banner && start === 0) {
      const marker = custom ? customMessage("cc-history-boundary") : { render: () => ["new context marker", ""], invalidate() {} };
      result.push(marker); sources.set(marker, { recordId: "cc-history-boundary", message: 0, presentation: true });
    }
    if (custom && start === 0) {
      const component = customMessage("real-custom"); result.push(component); sources.set(component, { recordId: "real-custom", message: 0 });
    }
    if (summary && start === 0) {
      const component = new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: "FOLD_PAYLOAD", tokensBefore: 1, timestamp: 1 });
      result.push(component); sources.set(component, { recordId: "summary-0", message: 0 });
    }
    for (let row = start; row < end; row++) {
      const component = { render: (columns: number) => wrapped && columns < 80 ? [`row-${row}`, `row-${row}:continued`] : [`row-${row}`], invalidate() {} };
      result.push(component); sources.set(component, { recordId: String(row), message: 0 });
    }
    identifyHistoryComponents(result, sources);
    return result;
  };
  const components = draw(count - 200, count);
  const prefix: Component[] = prefixRows ? [{ render: () => Array.from({ length: prefixRows }, (_, i) => `prefix-${i}`), invalidate() {} }] : [];
  chat.children.push(...prefix, header, ...components);
  const projections: string[][] = [];
  cache = new HistoryResidency({ chat, prefix, header, branch, start: count - 200, components,
    draw, project: entries => projections.push(entries.map(entry => entry.id)), sticky: component => {
      const id = historyComponentIdentity(component)?.recordId;
      return id && /^\d+$/u.test(id) ? `row-${id}` : undefined;
    },
    changed() {}, request() {} });
  let top = 0;
  const view = (extra: Partial<HistoryViewport> = {}): HistoryViewport => ({ top, height: 20, width, chatTop, idle: true, expanded: false, ...extra });
  const reconcile = (extra: Partial<HistoryViewport> = {}) => {
    cache.observe(view(extra));
    const change = cache.reconcile();
    if (change) top = change.top;
    return change;
  };
  const visitStart = () => {
    let count = 0;
    while (cache.start > 0 && count++ < 30) { cache.requestEarlier(); reconcile(); }
    assert.equal(cache.start, 0);
  };
  return { cache, chat, branch, projections, reconcile, visitStart,
    addBanner() { banner = true; },
    removeBanner() { banner = false; },
    setWidth(value: number) { width = value; },
    setTop(value: number) { top = value; }, getTop: () => top,
    lines: () => chat.render(width),
    gap(id: number) {
      let row = chatTop;
      for (const component of chat.children) {
        if (component instanceof HistoryAnchor) {
          const span = component.stickySpans.find(item => item.summary === `row-${id}`);
          if (span) return { row: row + span.start, span };
        }
        row += component.render(width).length;
      }
      assert.fail(`row-${id} must be unloaded`);
    },
    anchor() {
      let row = 0;
      for (const component of chat.children) {
        if (component instanceof HistoryAnchor) return { component, row };
        row += component.render(80).length;
      }
      return undefined;
    },
  };
}

test("unloading preserves height/viewport and gaps reload in both directions", () => {
  const f = fixture(); f.visitStart();
  assert.equal(f.lines().length, 4000);
  assert.ok(f.anchor());
  const visited = new Set(f.projections.flat());
  assert.equal(visited.size, 4000);
  for (const location of [3900, 100, 2700, 300]) {
    f.setTop(location);
    const beforeHeight = f.lines().length;
    f.reconcile();
    assert.equal(f.lines().length, beforeHeight);
    assert.equal(f.getTop(), location);
    assert.equal(f.lines()[location], `row-${location}`);
  }
});

test("selected batches and active content survive while the latest complete batch is pinned", () => {
  const f = fixture(); f.visitStart();
  f.setTop(100); f.reconcile();
  f.setTop(2700); f.reconcile({ selected: { start: 50, end: 150 } });
  assert.equal(f.lines()[100], "row-100");
  assert.equal(f.lines().at(-1), "row-3999");
  const before = [...f.chat.children];
  const anchor = f.anchor()!; anchor.component.handleMouse({ type: "press" } as any);
  f.reconcile({ idle: false });
  assert.deepEqual(f.chat.children, before, "busy session never reconstructs or unloads tool components");
});

test("public expansion state survives eviction and a later reload", () => {
  const f = fixture(true); f.visitStart(); f.setTop(0); f.reconcile();
  const summary = f.chat.children.find(component => component instanceof CompactionSummaryMessageComponent) as CompactionSummaryMessageComponent;
  assert.ok(summary); summary.setExpanded(true);
  f.reconcile();
  for (const row of [1000, 1400, 1800, 3700]) { f.setTop(row); f.reconcile(); }
  assert.ok(!f.chat.children.includes(summary));
  f.setTop(0); f.reconcile();
  const restored = f.chat.children.find(component => component instanceof CompactionSummaryMessageComponent);
  assert.ok(restored && restored !== summary);
  assert.match(restored.render(80).join("\n"), /FOLD_PAYLOAD/u);
});

test("compaction markers remap selected rows inside a rebuilt resident batch", () => {
  const f = fixture(); f.visitStart(); f.setTop(0); f.reconcile();
  const before = f.lines()[50];
  f.addBanner();
  const change = f.cache.refresh(f.branch)!;
  assert.equal(f.lines()[change.mapRow(50)], before);
  assert.equal(change.mapRow(50), 52);
  assert.ok(f.anchor(), "refresh retains unloaded batches");
});

test("prepending keeps document/chat prefix selections at their original rows", () => {
  const f = fixture(false, { count: 800, prefixRows: 1, chatTop: 2 });
  f.cache.requestEarlier();
  const transition = f.reconcile({ selected: { start: 0, end: 2 } })!;
  assert.ok(transition);
  for (const row of [0, 1, 2]) assert.equal(transition.mapRow(row), row);
  assert.ok(transition.top > 0, "viewport advances with the old transcript, independently of prefix selections");
  assert.equal(f.lines()[2], "row-400");
});

test("native copy of document warnings is unchanged after history prepend", () => {
  const f = fixture(false, { count: 800, prefixRows: 1, chatTop: 2 });
  const document = new Container();
  document.addChild({ render: () => ["warning-A", "warning-B"], invalidate() {} }); document.addChild(f.chat);
  const scroll = new ScrollView(document, { primary: true });
  const renderer = new TuiAltScreen({ columns: 80, rows: 20, write() {} } as unknown as Terminal);
  const native = renderer as any;
  const layout = () => { native.currentLayout = renderLayoutFrame(scroll, 80, 20, () => {}); };
  layout();
  native.selectionAnchor = { row: 0, col: 0, scrollView: scroll };
  native.selectionFocus = { row: 1, col: 9, scrollView: scroll };
  const before = native.getActiveSelectionText(); assert.equal(before, "warning-A\nwarning-B");
  f.cache.requestEarlier(); const transition = f.reconcile({ selected: { start: 0, end: 1 } })!;
  for (const point of [native.selectionAnchor, native.selectionFocus]) point.row = transition.mapRow(point.row);
  layout();
  assert.equal(native.getActiveSelectionText(), before);
});

test("a selection crossing the loading header defers prepend until deselection", () => {
  const f = fixture(false, { count: 800, prefixRows: 1, chatTop: 2 });
  f.cache.requestEarlier();
  assert.equal(f.reconcile({ selected: { start: 2, end: 6 } }), undefined);
  assert.equal(f.cache.start, 600);
  assert.ok(f.reconcile());
  assert.equal(f.cache.start, 400, "the pending request survives deselection");
});

test("the final prepend protects a selected header and maps body rows after its removal", () => {
  const f = fixture(false, { count: 400, prefixRows: 1, chatTop: 2 });
  f.cache.requestEarlier();
  assert.equal(f.reconcile({ selected: { start: 3, end: 3 } }), undefined);
  assert.equal(f.cache.start, 200);
  f.setTop(4);
  const transition = f.reconcile({ selected: { start: 4, end: 5 } })!;
  assert.equal(f.cache.start, 0);
  assert.equal(transition.mapRow(2), 2, "chat prefix does not move");
  assert.equal(transition.mapRow(4), 203, "body moves by the new batch minus the removed header");
  assert.equal(f.lines()[transition.mapRow(4) - 2], "row-200");
  assert.doesNotMatch(f.lines().join("\n"), /earlier/u);
});

test("width changes reload both directions by record identity and sticky targets that same record", () => {
  const f = fixture(false, { wrapped: true });
  f.visitStart();
  f.setWidth(40); f.reconcile();
  for (const id of [300, 1500]) {
    const gap = f.gap(id);
    f.setTop(gap.row);
    const transition = f.reconcile()!;
    assert.ok(transition);
    assert.equal(f.lines()[transition.top], `row-${id}`);
    assert.equal(f.lines()[transition.top + 1], `row-${id}:continued`);
  }
  const gap = f.gap(500);
  f.setTop(gap.row + 20); // A sticky click can arrive while positioned below its caption.
  gap.span.jump!();
  const transition = f.reconcile()!;
  assert.equal(f.lines()[transition.top], "row-500");
});

test("an explicit gap reload takes priority over automatic earlier-history loading", () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) { f.cache.requestEarlier(); f.reconcile(); }
  const start = f.cache.start, gap = f.anchor(); assert.ok(gap && start > 0);
  gap.component.handleMouse({ type: "press" } as any);
  f.setTop(0); f.reconcile();
  assert.equal(f.cache.start, start);
  assert.ok(!f.chat.children.includes(gap.component));
});

test("refresh moving a presentation marker preserves the real custom message's expansion", () => {
  const f = fixture(false, { custom: true });
  f.visitStart(); f.setTop(0); f.reconcile();
  const actual = () => f.chat.children.find(component => historyComponentIdentity(component)?.recordId === "real-custom") as CustomMessageComponent;
  const original = actual(); assert.ok(original);
  original.setExpanded(true);
  f.removeBanner(); f.cache.refresh(f.branch);
  assert.notEqual(actual(), original);
  assert.match(actual().render(80).join("\n"), /real-custom:expanded/u);
});

test("native append capture gives a real custom message the same fold key when a marker moves", () => {
  initTheme("dark");
  const native = InteractiveMode.prototype as any, chat = new Container();
  const receiver = { chatContainer: chat, toolOutputExpanded: false, outputPad: 1,
    session: { extensionRunner: { getMessageRenderer: () => (_message: unknown, { expanded }: { expanded: boolean }) => ({ render: () => [expanded ? "expanded" : "collapsed"], invalidate() {} }) } },
    getMarkdownThemeWithSettings() { return undefined; }, addMessageToChat: native.addMessageToChat,
    renderSessionItems(items: unknown[]) { for (const item of items) this.addMessageToChat(item); },
  };
  const entry = (id: string): SessionEntry => ({ type: "custom_message", id, parentId: null, timestamp: "2026-10-19T00:00:00Z", customType: id, content: id, display: true });
  const first = drawHistory(receiver, chat, [entry("cc-history-boundary"), entry("actual-record")], native.renderSessionEntries);
  const real = first[1] as CustomMessageComponent;
  assert.equal(historyComponentIdentity(real)?.recordId, "actual-record");
  const saved = new Map<string, boolean>(); rememberHistoryExpansion(first, saved); real.setExpanded(true);
  assert.equal(saved.size, 1, "the marker consumes no fold key");
  chat.clear();
  const next = drawHistory(receiver, chat, [entry("actual-record")], native.renderSessionEntries);
  rememberHistoryExpansion(next, saved);
  assert.equal(historyComponentIdentity(next[0]!)?.key, historyComponentIdentity(real)?.key);
  assert.match(next[0]!.render(80).join("\n"), /expanded/u);
  assert.equal(Object.hasOwn(receiver, "addMessageToChat"), true, "the original own method is restored");
  chat.clear();
  receiver.addMessageToChat({ role: "custom", customType: "live", content: "live", display: true, timestamp: 1 });
  const live = chat.children[0] as CustomMessageComponent, liveSaved = new Map<string, boolean>();
  rememberHistoryExpansion([live], liveSaved); live.setExpanded(true);
  chat.clear();
  const persisted = drawHistory(receiver, chat, [entry("live")], native.renderSessionEntries);
  rememberHistoryExpansion(persisted, liveSaved);
  assert.match(persisted[0]!.render(80).join("\n"), /expanded/u, "a live fold migrates when its record becomes available");
});
