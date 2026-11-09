/** Pi 1.3 history presentation only. Never replace buildContextEntries or write
 * session entries: the model's context and compaction policy belong to Pi. */
import { InteractiveMode, UserMessageComponent, sessionEntryToContextMessages, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen, truncateToWidth, type Component, type ScrollView, type TUI } from "@earendil-works/pi-tui";
import { declareProbes, markBroken, markOk, type Probe } from "../internals.ts";
import { originalPresentationMethod, presentationPrototype, presentationRunnerBelongsTo, registerPresentationModeResolver } from "../presentation-owner.ts";
import { historyBoundary, historyInputEntries, historyWindowStart, projectHistoryWindow, releaseHistoryView, setHistoryView } from "../history-window.ts";
import { subscribeFullscreenFrame } from "../host/fullscreen/bridge.ts";
import { userMessageSourceCompat, type TimestampOwner } from "./user-message.ts";
import { HistoryResidency } from "../history-residency.ts";
import { summarise } from "../host/fullscreen/sticky.ts";
import { identifyHistoryComponents } from "../history-batches.ts";

type RenderEntries = (this: object, entries: SessionEntry[], options?: { updateFooter?: boolean; populateHistory?: boolean }) => void;
type HandleEvent = (this: object, event: AgentSessionEvent) => Promise<void>;
interface HistoryMode { renderSessionEntries: RenderEntries; handleEvent: HandleEvent }
const prototype = InteractiveMode.prototype as unknown as HistoryMode;

/** history.renderEntries owns these reads. chatContainer is already covered by
 * user-message.timestampBinding; handleEvent by working.retryEvents. */
interface HistoryHost { session: AgentSession; sessionManager: ExtensionContext["sessionManager"]; renderer: TuiAltScreen; chatContainer: Container }
function readHistoryHost(receiver: object): HistoryHost | undefined {
  const host = receiver as HistoryHost;
  if (!host.renderer || !["regular", "fullscreen"].includes(host.renderer.mode)) throw new Error("history renderer unavailable");
  if (host.renderer.mode !== "fullscreen") return undefined;
  if (!(host.chatContainer instanceof Container) || !Array.isArray(host.chatContainer.children)
    || typeof host.sessionManager?.getBranch !== "function") throw new Error("history host shape changed");
  return host;
}

function historyRenderShape(method: unknown): method is RenderEntries {
  if (typeof method !== "function" || method.length !== 1) return false;
  let called = false;
  const options = {};
  try {
    method.call({ renderer: undefined, renderSessionItems(items: unknown[], messageMeta: unknown, received: unknown) {
      called = items.length === 0 && messageMeta instanceof Map && messageMeta.size === 0 && received === options;
    } }, [], options);
    return called;
  } catch { return false; }
}
function eventShape(): boolean {
  const method = originalPresentationMethod(prototype, "handleEvent");
  if (typeof method !== "function" || !["entry_appended", "compaction_end", "renderSessionEntries", "chatContainer"].every(token => String(method).includes(token))) return false;
  // These receivers and methods belong to the probe, never a real view. Check
  // both native compaction branches before their returned promises settle: a
  // source-name check alone cannot detect a newly inserted await.
  for (const type of ["entry_appended", "compaction_end"]) {
    const entry = { type: "compaction", id: "probe-compaction", summary: "probe", tokensBefore: 1, timestamp: "2026-01-01T00:00:00Z" };
    let clears = 0, renders = 0, summaries = 0;
    const receiver = {
      isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} },
      settingsManager: { getShowTerminalProgress: () => false }, defaultEditor: {},
      ui: { requestRender() {} }, chatContainer: { clear() { clears++; } },
      sessionManager: { buildContextEntries: () => [entry], getBranch: () => [entry] },
      entriesRenderedByBoundaryCompaction: new Set(), clearStatusIndicator() {},
      renderSessionEntries() { renders++; }, addMessageToChat() { summaries++; },
      flushCompactionQueue: async () => {},
    };
    try {
      const result = method.call(receiver, type === "entry_appended" ? { type, entry } : { type, result: entry });
      if (!result || typeof result.then !== "function") return false;
      void result.catch(() => {});
      if (clears !== 1 || renders !== (type === "entry_appended" ? 2 : 1) || summaries !== 1) return false;
    } catch { return false; }
  }
  return true;
}

interface Point { row: number; col: number; scrollView?: ScrollView }
interface SelectionHost {
  selectionAnchor?: Point; selectionFocus?: Point;
  selectionInitialRange?: { start: Point; end: Point };
  lastClick?: { row: number; scrollView?: ScrollView };
}
/** history.selectionAnchors owns all native content-coordinate reads/writes.
 * Pi's public resetTextSelection is suppressed only while prepending: all
 * mounted old components and their text remain intact. */
export function shiftHistorySelection(renderer: object, scroll: ScrollView, delta: number, fromRow = 0): void {
  if (!Number.isFinite(delta)) throw new Error("invalid history row delta");
  const host = renderer as SelectionHost;
  for (const key of ["selectionAnchor", "selectionFocus", "selectionInitialRange", "lastClick"]) {
    if (!Object.hasOwn(host, key)) throw new Error(`selection coordinate ${key} is unavailable`);
  }
  const points = new Set([host.selectionAnchor, host.selectionFocus, host.selectionInitialRange?.start, host.selectionInitialRange?.end, host.lastClick]);
  for (const point of points) {
    if (point && (!Number.isFinite(point.row) || ("col" in point && !Number.isFinite(point.col)))) throw new Error("invalid native selection point");
  }
  for (const point of points) if (point && point.scrollView === scroll && point.row >= fromRow) point.row += delta;
}
function historySelectionRange(renderer: object, scroll: ScrollView): { start: number; end: number } | undefined {
  // Same history.selectionAnchors contract; no new native selection fields.
  shiftHistorySelection(renderer, scroll, 0);
  const { selectionAnchor: anchor, selectionFocus: focus } = renderer as SelectionHost;
  if (!anchor || !focus || anchor.scrollView !== scroll || focus.scrollView !== scroll) return undefined;
  return { start: Math.min(anchor.row, focus.row), end: Math.max(anchor.row, focus.row) };
}
function remapHistorySelection(renderer: object, scroll: ScrollView, map: (row: number) => number): void {
  const host = renderer as SelectionHost;
  const points = new Set([host.selectionAnchor, host.selectionFocus, host.selectionInitialRange?.start, host.selectionInitialRange?.end, host.lastClick]);
  for (const point of points) if (point?.scrollView === scroll) point.row = map(point.row);
}
function selectionShape(): boolean {
  const source = String((TuiAltScreen.prototype as unknown as { resetTextSelection?: unknown }).resetTextSelection);
  // Source-level and Bun final-host names of these fields are stable property
  // names. Live instances must additionally prove all four own fields.
  return ["clearTextSelection", "lastClick"].every(token => source.includes(token));
}
export const PROBES: readonly Probe[] = [
  { id: "history.renderEntries", needs: "InteractiveMode.renderSessionEntries(entries, options), session/sessionManager/renderer; public AgentSession.extensionRunner identifies pre-bind reload; existing handleEvent compaction clear/render must be synchronous, plus chatContainer",
    breaks: "全屏历史退回 Pi 原生上下文条目，不补载更早记录", check: () => historyRenderShape(originalPresentationMethod(prototype, "renderSessionEntries")) && eventShape()
      && ["session", "sessionManager"].every(key => typeof Object.getOwnPropertyDescriptor(InteractiveMode.prototype, key)?.get === "function") },
  { id: "history.selectionAnchors", needs: "TuiAltScreen.selectionAnchor/selectionFocus/selectionInitialRange/lastClick content coordinates",
    breaks: "全屏历史退回 Pi 原生上下文条目，避免补载破坏选区", check: selectionShape },
];

const BOUNDARY_TYPE = "cc-history-boundary";
export function historyRenderEntries(branch: readonly SessionEntry[], start: number, end = branch.length): SessionEntry[] {
  const boundary = historyBoundary(branch);
  const result = branch.slice(start, end);
  if (boundary && boundary.index >= start && boundary.index < end) {
    result.splice(boundary.index - start, 0, {
      type: "custom_message", id: "cc-history-boundary", parentId: null,
      timestamp: branch[boundary.index]!.timestamp, customType: BOUNDARY_TYPE,
      content: `以上 ${boundary.count} 条消息已压缩进摘要 · 以下为模型保留的尾部（摘要见实际压缩位置）`, display: true,
    });
  }
  return result;
}

/** Existing user-message.timestampBinding append/container seam; conversion is
 * public Pi API. Capture record ownership without reading component internals. */
export function drawHistory(receiver: object, chat: Container, entries: SessionEntry[], render: RenderEntries, options?: Parameters<RenderEntries>[1]): Component[] {
  const owner = receiver as TimestampOwner, append = owner.addMessageToChat;
  if (typeof append !== "function") throw new Error("native message append unavailable");
  const descriptor = Object.getOwnPropertyDescriptor(owner, "addMessageToChat");
  const expected = entries.flatMap(entry => sessionEntryToContextMessages(entry).map((message, index) => ({
    role: message.role, recordId: entry.id, message: index, presentation: entry.id === "cc-history-boundary",
  })));
  const sources = new Map<Component, (typeof expected)[number]>();
  const offset = chat.children.length;
  let cursor = 0;
  owner.addMessageToChat = function (message, appendOptions) {
    const index = expected.findIndex((item, position) => position >= cursor && item.role === message.role);
    const source = expected[index];
    if (source) cursor = index + 1;
    const start = chat.children.length;
    append.call(this, message, appendOptions);
    if (source) for (const component of chat.children.slice(start)) sources.set(component, source);
  };
  try {
    render.call(receiver, entries, options);
    const components = chat.children.slice(offset);
    identifyHistoryComponents(components, sources);
    return components;
  } finally {
    if (descriptor) Object.defineProperty(owner, "addMessageToChat", descriptor);
    else delete owner.addMessageToChat;
  }
}

interface Window { host: HistoryHost; receiver: object; branch: readonly SessionEntry[]; start: number; header?: Component; residency?: HistoryResidency; dirty?: boolean; chatLength?: number; scroll?: ScrollView }
// LayoutBox metadata is the existing fullscreen.sticky contract, not another
// private seam. Use its allocated width so wrapped rows anchor on narrow views.
interface HistoryLayoutBox { scrollView?: ScrollView; rect: { width: number }; children: HistoryLayoutBox[] }
function historyScrollBox(box: HistoryLayoutBox, scroll: ScrollView): HistoryLayoutBox | undefined {
  if (box.scrollView === scroll) return box;
  for (const child of box.children) { const found = historyScrollBox(child, scroll); if (found) return found; }
  return undefined;
}
function componentRow(root: Component, target: Component, width: number): number | undefined {
  if (root === target) return 0;
  if (!(root instanceof Container)) return undefined;
  let offset = 0;
  for (const child of root.children) {
    const nested = componentRow(child, target, width);
    if (nested !== undefined) return offset + nested;
    offset += child.render(width).length;
  }
  return undefined;
}
export interface FullHistory { attach(tui: TUI): void; dispose(): void }

export function installFullHistory(pi: ExtensionAPI): FullHistory {
  declareProbes(PROBES);
  let enabled = true, disposed = false;
  for (const probe of PROBES) {
    if (probe.check?.()) markOk(probe.id);
    else { enabled = false; markBroken(probe.id, "Pi history contract changed; keeping native transcript"); }
  }
  const local = presentationPrototype(pi, prototype, "mode");
  const render = local.renderSessionEntries, handle = local.handleEvent;
  type Fallback = { receiver: object; host?: HistoryHost; entries?: SessionEntry[]; options?: Parameters<RenderEntries>[1] };
  let pendingFallback: Fallback | undefined;
  let current: Window | undefined, tui: TUI | undefined, releaseFrame: (() => void) | undefined;
  let loading = false, restoring = false, restoreSelection: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let gate: { receiver: object; calling: boolean; clears: number; renders: number } | undefined;
  let pendingInputs: { receiver: object; host: HistoryHost } | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined, editorBound = false, inputsRequested = false;
  let contextIdle = () => false;
  const idle = (): boolean => {
    if (disposed) return false;
    try { return contextIdle(); } catch { return false; } // Replacement invalidates the old context before its last frame.
  };
  const restoreNativeSelection = (): void => {
    const restore = restoreSelection;
    restoreSelection = undefined;
    restore?.();
  };
  function scheduleFallback(): void {
    if (!pendingFallback || disposed || fallbackTimer) return;
    fallbackTimer = setTimeout(flushFallback, 0);
  }
  function flushFallback(): void {
    fallbackTimer = undefined;
    if (!pendingFallback || disposed || loading || restoring || gate || !idle()) return;
    const target = pendingFallback;
    restoring = true;
    try {
      // Never rebuild while a prepend still suppresses native selection.
      restoreNativeSelection();
      const entries = target.host?.sessionManager.buildContextEntries() ?? target.entries;
      if (!entries) throw new Error("native fallback context unavailable");
      setHistoryView(pi, false);
      projectHistoryWindow(pi, entries); // GroupStore and Activity timeline.
      target.host?.chatContainer.clear();
      render.call(target.receiver, entries, { ...target.options, populateHistory: false });
      current = undefined;
      pendingFallback = undefined;
      releaseFrame?.(); releaseFrame = undefined;
      target.host?.renderer.requestRender();
    } catch (error) {
      markBroken("history.renderEntries", `Native history fallback failed: ${String(error)}`);
      // Retry only at a subsequent lifecycle/frame boundary, never a poll loop.
    } finally { restoring = false; }
  }
  function fail(id: string, error: unknown, target?: Fallback): void {
    if (disposed) return;
    enabled = false;
    markBroken(id, String(error));
    if (timer) clearTimeout(timer);
    timer = undefined;
    const previous = current;
    current = undefined;
    setHistoryView(pi, false);
    pendingFallback = target && !target.host && previous?.receiver === target.receiver
      ? { ...target, host: previous.host } : target ?? previous ?? pendingFallback;
    scheduleFallback();
  }
  const bindContext = (ctx: ExtensionContext): void => {
    contextIdle = () => ctx.isIdle();
    readExpanded = () => ctx.ui.getToolsExpanded();
    scheduleFallback();
  };
  const stops = [pi.on("session_start", (_event, ctx) => bindContext(ctx)),
    pi.on("resources_discover", (_event, ctx) => {
      bindContext(ctx);
      // session_start handlers have now installed the replacement editor.
      editorBound = true; scheduleInputs();
      return {};
    }),
    pi.on("agent_settled", () => { scheduleFallback(); scheduleInputs(); }),
    pi.on("session_compact", () => { scheduleFallback(); scheduleInputs(); }),
    pi.on("session_compact_failed", () => { scheduleFallback(); scheduleInputs(); })];
  const stopResolve = enabled ? registerPresentationModeResolver(pi, receiver => {
    if (!enabled) return false;
    try {
      const host = readHistoryHost(receiver);
      return !!host && presentationRunnerBelongsTo(pi, host.session.extensionRunner);
    } catch (error) { fail("history.renderEntries", error); return false; }
  }) : () => {};

  pi.registerMessageRenderer(BOUNDARY_TYPE, message => ({
    render: width => [truncateToWidth(`── ${String(message.content)} ──`, width)], invalidate() {},
  }));

  const publish = (window: Window): void => {
    setHistoryView(pi, true, () => window.residency?.entries() ?? window.host.sessionManager.getBranch().slice(window.start));
    projectHistoryWindow(pi, window.branch.slice(window.start));
  };
  const header = (window: Window): Component => ({
    render: width => enabled && window.start > 0 ? [truncateToWidth(`↑ 加载更早的 ${window.start} 条记录${idle() ? "" : "（生成结束后可加载）"}`, width)] : [],
    invalidate() {},
    handleMouse: event => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      window.residency?.requestEarlier();
      return { handled: true };
    },
  });
  const populateInputHistory = (receiver: object, host: HistoryHost): void => {
    const children = [...host.chatContainer.children];
    try {
      host.chatContainer.children.splice(0);
      // user-message.timestampBinding already owns this append/container seam.
      // Discard user components, retaining only native editor addToHistory.
      // Unlike renderSessionEntries this does not reset selection/pending tools.
      const append = (receiver as TimestampOwner).addMessageToChat;
      if (typeof append !== "function") throw new Error("native message append unavailable");
      for (const entry of historyInputEntries(host.sessionManager.getBranch())) {
        if (entry.type === "message") append.call(receiver, entry.message, { populateHistory: true });
      }
    } finally { host.chatContainer.children.splice(0, host.chatContainer.children.length, ...children); }
  };
  function scheduleInputs(): void {
    if (!pendingInputs || !editorBound || inputTimer || disposed) return;
    inputTimer = setTimeout(() => {
      inputTimer = undefined;
      if (!pendingInputs || disposed || loading || gate) return;
      const target = pendingInputs;
      pendingInputs = undefined;
      try { populateInputHistory(target.receiver, target.host); }
      catch (error) { fail("history.renderEntries", error, target); }
    }, 0);
  }
  const replace = (receiver: object, host: HistoryHost, options?: Parameters<RenderEntries>[1], preserveStart?: number, clear = false): void => {
    try { shiftHistorySelection(host.renderer, undefined as unknown as ScrollView, 0); }
    catch (error) { fail("history.selectionAnchors", error, { receiver, host }); throw error; }
    markOk("history.selectionAnchors");
    const branch = host.sessionManager.getBranch();
    const window: Window = { receiver, host, branch, start: preserveStart ?? historyWindowStart(branch) };
    publish(window);
    // The caller clears on rebuild. Initial rendering may already contain
    // native startup warnings, which are outside the persisted transcript.
    if (clear) host.chatContainer.clear();
    current = window;
    const prefix = [...host.chatContainer.children];
    if (window.start > 0) {
      window.header = header(window);
      host.chatContainer.addChild(window.header);
    }
    const components = drawHistory(receiver, host.chatContainer, historyRenderEntries(branch, window.start), render, { ...options, populateHistory: false });
    window.residency = new HistoryResidency({
      chat: host.chatContainer, prefix, header: window.header, branch, start: window.start,
      components,
      draw(start, end) {
        const saved = [...host.chatContainer.children];
        host.chatContainer.children.splice(0);
        try {
          return drawHistory(receiver, host.chatContainer, historyRenderEntries(window.branch, start, end), render, { populateHistory: false });
        } finally { host.chatContainer.children.splice(0, host.chatContainer.children.length, ...saved); }
      },
      project: entries => projectHistoryWindow(pi, entries),
      sticky(component) {
        if (!(component instanceof UserMessageComponent)) return undefined;
        // Reuse user-message.text; anchors retain only a bounded caption.
        const source = userMessageSourceCompat(component);
        if (!source.compatible) throw new Error("native user text unavailable for history anchor");
        return summarise(source.text ?? "").slice(0, 1024);
      },
      changed(start) { window.start = start; },
      request: () => scheduleLoad(),
    });
    window.dirty = true;
    markOk("history.renderEntries");
  };
  const patchedRender: RenderEntries = function (entries, options) {
    if (gate?.receiver === this) {
      gate.renders++;
      if (!gate.calling) fail("history.renderEntries", "Compaction rendered after handleEvent returned", pendingFallback);
      return;
    }
    if (!enabled) {
      if (pendingFallback) {
        pendingFallback = { ...pendingFallback, receiver: this, entries, options };
        scheduleFallback();
        return;
      }
      return render.call(this, entries, options);
    }
    let host: HistoryHost | undefined;
    try {
      host = readHistoryHost(this);
      if (!host) return render.call(this, entries, options);
      // /reload uses rebuildChatFromMessages without populateHistory, then
      // installs a new editor. Every new presentation seeds its first window.
      if (options?.populateHistory || !inputsRequested) {
        inputsRequested = true;
        pendingInputs = { receiver: this, host };
        scheduleInputs();
      }
      replace(this, host, options);
    } catch (error) { fail("history.renderEntries", error, { receiver: this, host, entries, options }); }
  };
  const patchedHandle: HandleEvent = function (event) {
    if (current && ["entry_appended", "message_start", "message_end", "agent_settled"].includes(event.type)) current.dirty = true;
    const compaction = (event.type === "compaction_end" && !!event.result)
      || (event.type === "entry_appended" && event.entry.type === "compaction");
    if (!enabled || !compaction) return handle.call(this, event);
    let host: HistoryHost | undefined;
    try { host = readHistoryHost(this); }
    catch (error) { fail("history.renderEntries", error); return handle.call(this, event); }
    if (!host) return handle.call(this, event);
    if (event.type === "entry_appended" && host.sessionManager.buildContextEntries()[0]?.id !== event.entry.id) return handle.call(this, event);
    const target = { receiver: this, host };
    const window = current;
    let previous: ReturnType<typeof observeResidency> | undefined;
    if (window?.residency) {
      try { previous = observeResidency(window); }
      catch (error) { fail("history.renderEntries", error, target); return handle.call(this, event); }
    }
    const active = { receiver: this, calling: true, clears: 0, renders: 0 };
    gate = active;
    const chat = host.chatContainer, clear = chat.clear;
    const descriptor = Object.getOwnPropertyDescriptor(chat, "clear");
    let result: Promise<void>;
    try {
      // Container.clear is public. Observe live dispatch too: a conditional
      // await must not pass just because the eager synthetic probe was sync.
      chat.clear = function () { active.clears++; return clear.call(this); };
      result = handle.call(this, event);
    } catch (error) {
      gate = undefined;
      fail("history.renderEntries", error, target);
      throw error;
    } finally {
      active.calling = false;
      if (descriptor) Object.defineProperty(chat, "clear", descriptor);
      else delete (chat as Partial<Container>).clear;
    }
    if (active.clears !== 1 || active.renders !== (event.type === "entry_appended" ? 2 : 1)) {
      fail("history.renderEntries", "Compaction clear/render did not complete synchronously", target);
    } else {
      try {
        if (window?.residency) {
          const descriptor = Object.getOwnPropertyDescriptor(host.renderer, "resetTextSelection");
          const scroll = previous?.scroll ?? window.scroll;
          const following = scroll?.isFollowingEnd;
          restoreSelection = () => {
            if (descriptor) Object.defineProperty(host!.renderer, "resetTextSelection", descriptor);
            else delete (host!.renderer as Partial<TuiAltScreen>).resetTextSelection;
          };
          try {
            host.renderer.resetTextSelection = () => {};
            window.branch = host.sessionManager.getBranch();
            const transition = window.residency.refresh(window.branch);
            if (transition && scroll) {
              scroll.updateLayout(transition.rows, scroll.viewportHeight, () => host!.renderer.requestRender());
              if (following) scroll.scrollToEnd();
              else scroll.scrollTo(transition.top, { disableFollow: true });
              remapHistorySelection(host.renderer, scroll, transition.mapRow);
            } else if (!transition) replace(this, host, undefined, undefined, true);
            window.dirty = true;
            host.renderer.requestRender();
            host.renderer.renderNow();
          } finally { restoreNativeSelection(); }
        } else replace(this, host, undefined, undefined, true);
      } catch (error) { fail("history.renderEntries", error, target); }
    }
    return Promise.resolve(result).catch(error => {
      fail("history.renderEntries", error, target);
      throw error;
    }).finally(() => {
      if (gate === active) gate = undefined;
      scheduleFallback();
      scheduleInputs();
    });
  };

  let readExpanded: (() => boolean) | undefined;
  const observeResidency = (window: Window, renderingFrame?: { primaryScrollView?: ScrollView; root: HistoryLayoutBox }) => {
    const renderer = window.host.renderer;
    // Existing fullscreen.sticky/frame metadata; all cache state is CC-owned.
    const frame = renderingFrame ?? (renderer as unknown as { currentLayout?: { primaryScrollView?: ScrollView; root: HistoryLayoutBox } }).currentLayout;
    const scroll = frame?.primaryScrollView;
    if (!scroll) return undefined; // A public ui.custom view can replace the chat viewport.
    const box = frame?.root && historyScrollBox(frame.root, scroll);
    if (!box) throw new Error("native scroll geometry unavailable");
    const document = scroll.children[0];
    const width = scroll.getContentWidth(box.rect.width);
    const chatTop = document ? componentRow(document, window.host.chatContainer, width) : undefined;
    if (chatTop === undefined) return undefined; // A custom view may have its own primary ScrollView.
    window.scroll = scroll;
    let expanded: boolean | undefined;
    try { expanded = readExpanded?.(); } catch { /* Retired public UI context. */ }
    const dirty = window.dirty || window.chatLength !== window.host.chatContainer.children.length;
    if (dirty) window.branch = window.host.sessionManager.getBranch();
    const changed = window.residency!.observe({ top: scroll.scrollTop, height: scroll.viewportHeight, width, chatTop,
      selected: historySelectionRange(renderer, scroll), expanded, idle: idle() }, dirty ? window.branch : undefined);
    window.dirty = false; window.chatLength = window.host.chatContainer.children.length;
    return { scroll, renderer, changed };
  };
  const load = (): void => {
    const window = current;
    if (!enabled || disposed || loading || !window?.residency || !idle()) return;
    const observed = observeResidency(window);
    if (!observed) return;
    const { scroll, renderer } = observed;
    const descriptor = Object.getOwnPropertyDescriptor(renderer, "resetTextSelection");
    const following = scroll.isFollowingEnd;
    loading = true;
    try {
      restoreSelection = () => {
        if (descriptor) Object.defineProperty(renderer, "resetTextSelection", descriptor);
        else delete (renderer as Partial<TuiAltScreen>).resetTextSelection;
      };
      renderer.resetTextSelection = () => {};
      const transition = window.residency.reconcile();
      if (!transition) return;
      scroll.updateLayout(transition.rows, scroll.viewportHeight, () => renderer.requestRender());
      if (following) scroll.scrollToEnd();
      else scroll.scrollTo(transition.top, { disableFollow: true });
      remapHistorySelection(renderer, scroll, transition.mapRow);
      markOk("history.selectionAnchors");
      window.chatLength = window.host.chatContainer.children.length;
      setHistoryView(pi, true, () => window.residency!.entries());
      renderer.requestRender();
      renderer.renderNow(); // Publish the remapped native selection before the next input/copy.
    } catch (error) { fail("history.renderEntries", error, window); }
    finally { restoreNativeSelection(); loading = false; scheduleFallback(); scheduleInputs(); }
  };
  function scheduleLoad(): void {
    if (!timer && enabled && !disposed && current?.residency && idle()) timer = setTimeout(() => {
      timer = undefined;
      try { load(); }
      catch (error) { fail("history.renderEntries", error); }
    }, 0);
  }
  if (enabled) { local.renderSessionEntries = patchedRender; local.handleEvent = patchedHandle; }
  return {
    attach(value) {
      tui = value;
      if (!enabled || value.mode !== "fullscreen") { setHistoryView(pi, false); scheduleFallback(); return; }
      setHistoryView(pi, true, current ? () => current!.residency?.entries() ?? current!.branch.slice(current!.start) : undefined);
      releaseFrame ??= subscribeFullscreenFrame((renderer, frame, screen) => {
        if (tui && renderer.terminal === tui.terminal && renderer.children === tui.children) {
          scheduleFallback();
          if (current?.residency) {
            try { if (observeResidency(current, frame)?.changed) scheduleLoad(); }
            catch (error) { fail("history.renderEntries", error); }
          }
        }
        return screen;
      }, value);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (inputTimer) clearTimeout(inputTimer);
      restoreNativeSelection();
      releaseFrame?.();
      stopResolve();
      for (const stop of stops) stop();
      if (local.renderSessionEntries === patchedRender) local.renderSessionEntries = render;
      if (local.handleEvent === patchedHandle) local.handleEvent = handle;
      current = undefined; pendingFallback = undefined; pendingInputs = undefined; tui = undefined;
      releaseHistoryView(pi);
    },
  };
}
