/**
 * Pi 1.3 fullscreen adaptations that no public API offers, moved here from the
 * retired pi-pinned-layout (claude-style round 2, batch 4): the editor-slot
 * geometry UIKit panels sit on, closing a focused panel on an outside left
 * press, the floating autocomplete list, the sticky header naming the user
 * question above the viewport, and themed selection colours.
 *
 * Every private name used here is declared in PROBES and fails open: a
 * missing seam leaves Pi's own behaviour in place.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
  TuiAltScreen,
  Container,
  compositeTuiLine,
  type ScrollView,
  type OverlayHandle,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
// Types only: erased at build time. The runtime fallback loads lazily below.
import type { LayoutBox, LayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { declareProbes, markBroken, markOk, type Probe } from "../../internals.ts";
import { publishEditorSlotGeometryResolver, type EditorSlotGeometryV1 } from "./editor-slot.ts";
import { highlightSelectionColors } from "./selection-colors.ts";
import { installWidgetSpacing } from "../widget-spacing.ts";
import { renderSticky, summarise } from "./sticky.ts";
import { isHistoryAnchor } from "../../history-batches.ts";

/** The `layout.*` settings in CC's config this bridge reads on every prepare. */
export interface FullscreenLayoutConfig {
  enabled: boolean;
  stickyUserMessage: boolean;
  floatAutocomplete: boolean;
  popupGap: number;
  minViewportRows: number;
}

// Private return metadata of TUI.dispatchMouseToOverlay, guarded by the probe.
interface TuiMouseDispatchResult extends TuiMouseEventResult {
  handled: true;
  target: { component: Component; originX: number; originY: number; width: number; height: number };
}

interface FullscreenTuiLike extends TUI {
  focusedComponent?: Component & { wantsMouse?: unknown };
  layoutRoot?: Component;
  currentLayout?: LayoutFrame;
  compositeScrollToEndIndicator?(screen: string[], frame: LayoutFrame, width: number): string[];
  isOverlayFocused?(): boolean;
  dispatchMouseToOverlay?(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult };
  applySelectionHighlight?(text: string): string;
  applySelection?(screen: string[], frame?: LayoutFrame): string[];
}

/** Private Pi 1.3 fullscreen seams used only by this versioned adapter. */
export const PROBES: readonly Probe[] = [
  {
    id: "fullscreen.selectionColors",
    needs: "TuiAltScreen.prototype.applySelectionHighlight(text), receiving sliceByColumn's SGR-prefixed selection",
    breaks: "fullscreen 鼠标选区退回原生反色",
    check: () => selectionHighlightShape((TuiAltScreen.prototype as unknown as FullscreenTuiLike).applySelectionHighlight),
  },
  {
    id: "fullscreen.stickySelection",
    needs: "TuiAltScreen.prototype.applySelection(screen, LayoutFrame), after overlay composition",
    breaks: "置顶问题条可能再次被正文选区着色；选区与复制仍归 Pi",
    check: () => typeof (TuiAltScreen.prototype as unknown as FullscreenTuiLike).applySelection === "function",
  },
  {
    id: "fullscreen.editorGeometry",
    needs: "TuiAltScreen 实例的 currentLayout / layoutRoot，以及兜底用的 pi-tui dist/layout.js renderLayoutFrame",
    breaks: "fullscreen 下详情面板无法精确贴住原输入框底边，退回 UIKit 估算",
  },
  {
    id: "fullscreen.outsideClick",
    needs: "TuiAltScreen.prototype.dispatchMouseToOverlay 与实例 focusedComponent/isOverlayFocused",
    breaks: "fullscreen 下详情面板的外部点击关闭失效，置顶问题条点了不跳转",
    check: () => typeof (TuiAltScreen.prototype as unknown as FullscreenTuiLike).dispatchMouseToOverlay === "function",
  },
  {
    id: "fullscreen.frame",
    needs: "TuiAltScreen.prototype.compositeScrollToEndIndicator(screen, LayoutFrame, width)",
    breaks: "fullscreen 浮动补全和置顶问题条取不到本帧布局",
    check: () => typeof (TuiAltScreen.prototype as unknown as FullscreenTuiLike).compositeScrollToEndIndicator === "function",
  },
  {
    id: "fullscreen.autocomplete",
    needs: "原生 editor 的 autocompleteState / autocompleteList 与末尾内嵌 menu render",
    breaks: "fullscreen 补全退回原生内嵌列表",
  },
  {
    id: "fullscreen.sticky",
    needs: "fullscreen primary ScrollView 的透明 Container document render 与 UserMessageComponent.text",
    breaks: "fullscreen 置顶用户问题不显示",
  },
];

type LayoutModule = typeof import("@earendil-works/pi-tui/dist/layout.js");
let layoutModule: LayoutModule | undefined;
let layoutModuleRequested = false;
/**
 * `renderLayoutFrame` is not exported from pi-tui's index. It only serves the
 * rare frame that Pi has not laid out at the current size yet, so it loads
 * lazily and a missing module just leaves those frames to UIKit's estimate.
 */
function requestLayoutModule(): void {
  if (layoutModuleRequested) return;
  layoutModuleRequested = true;
  // Pi 1.5 aliases the public root to index.js; a bare subpath becomes
  // index.js/dist/layout.js. Resolve from the host-reported package instead,
  // then import an absolute sibling URL. Missing private modules still fail
  // the geometry probe and leave UIKit's estimate in place.
  (async () => {
    const entry = createRequire(join(getPackageDir(), "package.json")).resolve("@earendil-works/pi-tui");
    return import(new URL("./layout.js", pathToFileURL(entry)).href) as Promise<LayoutModule>;
  })().then(
    (module) => { layoutModule = module; },
    (error: unknown) => markBroken("fullscreen.editorGeometry", `pi-tui dist/layout.js: ${String(error)}`),
  );
}

type SelectionHighlight = NonNullable<FullscreenTuiLike["applySelectionHighlight"]>;
const SELECTION_PATCH_KEY = Symbol.for("pi.claude-style.fullscreen-selection-colors.v2");
interface SelectionPatch {
  original: SelectionHighlight;
  patched: SelectionHighlight;
  owners: Map<symbol, () => Theme | undefined>;
}

function selectionHighlightShape(method: unknown): method is SelectionHighlight {
  const registry = (globalThis as Record<PropertyKey, unknown>)[SELECTION_PATCH_KEY] as WeakMap<object, SelectionPatch> | undefined;
  const installed = registry?.get(TuiAltScreen.prototype);
  if (installed && installed.patched === method) method = installed.original;
  if (typeof method !== "function" || method.length !== 1) return false;
  try {
    const source = "\x1b[31mA\x1b[0mB";
    return method.call(undefined, source) === "\x1b[7m\x1b[31m\x1b[7mA\x1b[0m\x1b[7mB\x1b[27m";
  } catch { return false; }
}

function installSelectionPatch(getTheme: () => Theme | undefined): () => void {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const prototype = TuiAltScreen.prototype as unknown as FullscreenTuiLike;
  // Main's bundled host and SDK hosts can have distinct public prototypes.
  // Keep each exact native method/lease separate; unknown shapes still fail open.
  const registry = (globals[SELECTION_PATCH_KEY] ??= new WeakMap()) as WeakMap<object, SelectionPatch>;
  let state = registry.get(prototype);
  const owner = Symbol("selection-colors.owner");
  if (!state || prototype.applySelectionHighlight !== state.patched) {
    const original = prototype.applySelectionHighlight;
    if (!selectionHighlightShape(original)) {
      markBroken("fullscreen.selectionColors", "applySelectionHighlight shape changed; keeping native selection");
      return () => {};
    }
    const owners = new Map<symbol, () => Theme | undefined>();
    const patched: SelectionHighlight = function (this: FullscreenTuiLike, text) {
      try {
        for (const readTheme of [...owners.values()].reverse()) {
          const theme = readTheme();
          if (!theme) continue;
          return highlightSelectionColors(text, theme.getBgAnsi("selectedBg") + theme.getFgAnsi("text"));
        }
      } catch (error) { markBroken("fullscreen.selectionColors", String(error)); }
      return original.call(this, text);
    };
    state = { original, patched, owners };
    prototype.applySelectionHighlight = patched;
    registry.set(prototype, state);
    markOk("fullscreen.selectionColors");
  }
  const installed = state;
  installed.owners.set(owner, getTheme);
  return () => {
    installed.owners.delete(owner);
    if (installed.owners.size) return;
    if (prototype.applySelectionHighlight === installed.patched) prototype.applySelectionHighlight = installed.original;
    if (registry.get(prototype) === installed) registry.delete(prototype);
  };
}

type SelectionApply = NonNullable<FullscreenTuiLike["applySelection"]>;
type SelectionFinish = (tui: FullscreenTuiLike, before: string[], after: string[], frame?: LayoutFrame) => string[];
const STICKY_SELECTION_KEY = Symbol.for("pi.claude-style.fullscreen-sticky-selection.v2");
interface StickySelectionPatch { original: SelectionApply; patched: SelectionApply; consumers: Set<SelectionFinish> }

/** Only restore a header that survived overlay composition unchanged. Never
 * redraw over a panel, change Pi's selection anchors, or alter copied text. */
function installStickySelectionPatch(finish: SelectionFinish): () => void {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const prototype = TuiAltScreen.prototype as unknown as FullscreenTuiLike;
  const registry = (globals[STICKY_SELECTION_KEY] ??= new WeakMap()) as WeakMap<object, StickySelectionPatch>;
  let state = registry.get(prototype);
  if (!state || prototype.applySelection !== state.patched) {
    const original = prototype.applySelection;
    if (typeof original !== "function") {
      markBroken("fullscreen.stickySelection", "applySelection missing; keeping pre-selection sticky rendering");
      return () => {};
    }
    const consumers = new Set<SelectionFinish>();
    const patched: SelectionApply = function (this: FullscreenTuiLike, screen, frame) {
      let rendered = original.call(this, screen, frame);
      for (const consume of consumers) {
        try { rendered = consume(this, screen, rendered, frame); }
        catch (error) { markBroken("fullscreen.stickySelection", String(error)); }
      }
      return rendered;
    };
    state = { original, patched, consumers };
    prototype.applySelection = patched;
    registry.set(prototype, state);
    markOk("fullscreen.stickySelection");
  }
  const installed = state;
  installed.consumers.add(finish);
  return () => {
    installed.consumers.delete(finish);
    if (installed.consumers.size > 0) return;
    if (prototype.applySelection === installed.patched) prototype.applySelection = installed.original;
    if (registry.get(prototype) === installed) registry.delete(prototype);
  };
}

function isFullscreen(tui: TUI): tui is FullscreenTuiLike {
  return tui.mode === "fullscreen";
}

/** InteractiveMode hands extension factories a stable TUI Proxy; native methods run on the renderer behind it. */
function sameTui(renderer: TUI, tui: TUI | undefined): boolean {
  return !!tui && renderer.terminal === tui.terminal && renderer.children === tui.children;
}

function childrenOf(component: Component): readonly Component[] {
  const children = (component as { children?: unknown }).children;
  return Array.isArray(children) ? children as readonly Component[] : [];
}

function containsEditor(component: Component, depth = 4): boolean {
  const candidate = component as { getText?: unknown; setText?: unknown; handleInput?: unknown };
  if (
    typeof candidate.getText === "function"
    && typeof candidate.setText === "function"
    && typeof candidate.handleInput === "function"
  ) return true;
  if (depth <= 0) return false;
  return childrenOf(component).some((child) => containsEditor(child, depth - 1));
}

function editorBox(box: LayoutBox): LayoutBox | undefined {
  for (const child of box.children ?? []) {
    const nested = editorBox(child);
    if (nested) return nested;
  }
  return containsEditor(box.component) ? box : undefined;
}

function validFrame(value: unknown): value is LayoutFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<LayoutFrame>;
  return Number.isFinite(frame.width) && Number.isFinite(frame.height)
    && typeof frame.root === "object" && frame.root !== null;
}

function frameFor(tui: FullscreenTuiLike): LayoutFrame | undefined {
  const width = Math.max(1, Math.floor(tui.terminal.columns));
  const height = Math.max(1, Math.floor(tui.terminal.rows));
  const current = tui.currentLayout;
  if (validFrame(current) && current.width === width && current.height === height) return current;
  if (!tui.layoutRoot || !layoutModule) return undefined;
  try {
    return layoutModule.renderLayoutFrame(tui.layoutRoot, width, height, () => tui.requestRender());
  } catch (error) {
    markBroken("fullscreen.editorGeometry", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export function snapshotFullscreenEditorSlot(tui: TUI): EditorSlotGeometryV1 | undefined {
  if (!isFullscreen(tui)) return undefined;
  const frame = frameFor(tui);
  return frame ? editorSlotFromFrame(frame) : undefined;
}

function editorSlotFromFrame(frame: LayoutFrame): EditorSlotGeometryV1 | undefined {
  const editor = editorBox(frame.root);
  // Native selectors/custom views can legitimately replace the editor. No
  // geometry is available then; absence alone is not a private API failure.
  if (!editor) return undefined;
  const bottom = Math.max(1, Math.min(frame.height, editor.rect.y + editor.rect.height));
  markOk("fullscreen.editorGeometry");
  return {
    version: 1,
    width: Math.max(1, editor.rect.width),
    bottomMargin: Math.max(0, frame.height - bottom),
    availableHeight: bottom,
  };
}

/** A press this bridge claims before Pi starts a selection or routes it to the layout. */
type PressInterceptor = (renderer: FullscreenTuiLike, event: TuiMouseEvent) => TuiMouseDispatchResult | undefined;
type OverlayDispatch = NonNullable<FullscreenTuiLike["dispatchMouseToOverlay"]>;
const MOUSE_PATCH_KEY = Symbol.for("pi.claude-style.fullscreen-outside-click.v2");
interface MousePatch {
  original: OverlayDispatch;
  patched: OverlayDispatch;
  interceptors: Set<PressInterceptor>;
}

/**
 * Pi only dispatches to hit overlays. Fill two gaps on a left press that hit
 * none: a focused UIKit panel (`wantsMouse`) closes on an outside press, and a
 * row this bridge draws itself (the sticky header) can claim its press. Inside
 * events, wheel, capture and selection stay Pi's.
 */
function installMousePatch(interceptor: PressInterceptor): () => void {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const prototype = TuiAltScreen.prototype as unknown as FullscreenTuiLike;
  const registry = (globals[MOUSE_PATCH_KEY] ??= new WeakMap()) as WeakMap<object, MousePatch>;
  let state = registry.get(prototype);
  if (!state || prototype.dispatchMouseToOverlay !== state.patched) {
    const original = prototype.dispatchMouseToOverlay;
    if (typeof original !== "function") {
      markBroken("fullscreen.outsideClick", "dispatchMouseToOverlay 不是函数");
      return () => {};
    }
    const interceptors = new Set<PressInterceptor>();
    const patched: OverlayDispatch = function fullscreenPress(this: FullscreenTuiLike, event) {
      const overlay = original.call(this, event);
      if (overlay.hit || event.type !== "press" || event.button !== "left") return overlay;
      for (const intercept of interceptors) {
        const claimed = intercept(this, event);
        if (claimed) { markOk("fullscreen.outsideClick"); return { hit: true, result: claimed }; }
      }
      if (this.focusedComponent?.wantsMouse !== true || this.isOverlayFocused?.() !== true) return overlay;
      const component = this.focusedComponent;
      const handled = component.handleMouse?.(event);
      if (!handled?.handled) return overlay;
      markOk("fullscreen.outsideClick");
      return { hit: true, result: { ...handled, handled: true,
        target: { component, originX: 0, originY: 0, width: event.width, height: event.height } } };
    };
    state = { original, patched, interceptors };
    prototype.dispatchMouseToOverlay = patched;
    registry.set(prototype, state);
  }
  const installed = state;
  installed.interceptors.add(interceptor);
  return () => {
    installed.interceptors.delete(interceptor);
    if (installed.interceptors.size) return;
    if (prototype.dispatchMouseToOverlay === installed.patched) prototype.dispatchMouseToOverlay = installed.original;
    if (registry.get(prototype) === installed) registry.delete(prototype);
  };
}

/** Whether the outside-press patch is installed; for diagnostics. */
export function fullscreenOutsideClickPatched(): boolean {
  const registry = (globalThis as Record<PropertyKey, unknown>)[MOUSE_PATCH_KEY] as WeakMap<object, MousePatch> | undefined;
  const state = registry?.get(TuiAltScreen.prototype);
  return !!state && (TuiAltScreen.prototype as unknown as FullscreenTuiLike).dispatchMouseToOverlay === state.patched;
}

type FrameComposite = NonNullable<FullscreenTuiLike["compositeScrollToEndIndicator"]>;
type FrameConsumer = (renderer: FullscreenTuiLike, frame: LayoutFrame, screen: string[], width: number) => string[];
const FRAME_PATCH_KEY = Symbol.for("pi.claude-style.fullscreen-frame.v1");
interface FramePatch {
  original: FrameComposite;
  patched: FrameComposite;
  consumers: Set<FrameConsumer>;
}

/** Reuse the frame Pi already laid out; never run a second layout pass. */
export function subscribeFullscreenFrame(consumer: FrameConsumer, tui: TUI): (() => void) | undefined {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const prototype = Object.getPrototypeOf(tui) as FullscreenTuiLike;
  let registry = globals[FRAME_PATCH_KEY] as WeakMap<object, FramePatch> | undefined;
  if (!registry) globals[FRAME_PATCH_KEY] = registry = new WeakMap();
  let state = registry.get(prototype);
  if (!state || prototype.compositeScrollToEndIndicator !== state.patched) {
    const original = prototype.compositeScrollToEndIndicator;
    if (typeof original !== "function") {
      markBroken("fullscreen.frame", "native frame composite seam missing");
      return undefined;
    }
    const consumers = new Set<FrameConsumer>();
    const patched: FrameComposite = function (this: FullscreenTuiLike, screen, frame, width) {
      let rendered = original.call(this, screen, frame, width);
      for (const consume of consumers) {
        try { rendered = consume(this, frame, rendered, width); }
        catch (error) { markBroken("fullscreen.frame", String(error)); }
      }
      return rendered;
    };
    state = { original, patched, consumers };
    prototype.compositeScrollToEndIndicator = patched;
    registry.set(prototype, state);
  }
  const installed = state;
  installed.consumers.add(consumer);
  return () => {
    installed.consumers.delete(consumer);
    if (installed.consumers.size) return;
    if (prototype.compositeScrollToEndIndicator === installed.patched) prototype.compositeScrollToEndIndicator = installed.original;
    if (registry.get(prototype) === installed) registry.delete(prototype);
  };
}

interface AutocompleteEditor extends Component {
  autocompleteState: unknown;
  autocompleteList?: Component;
  focused?: boolean;
  getText(): string;
  setText(text: string): void;
}

function autocompleteEditor(component: Component, depth = 8): AutocompleteEditor | undefined {
  if ("autocompleteState" in component && "autocompleteList" in component
    && typeof (component as Partial<AutocompleteEditor>).getText === "function") return component as AutocompleteEditor;
  if (depth <= 0) return undefined;
  for (const child of childrenOf(component)) {
    const editor = autocompleteEditor(child, depth - 1);
    if (editor) return editor;
  }
  return undefined;
}

function primaryScrollView(root: Component): ScrollView | undefined {
  const scroll = root as Partial<ScrollView>;
  if (scroll.primary === true && typeof scroll.scrollTo === "function" && typeof scroll.scrollTop === "number") return root as ScrollView;
  for (const child of childrenOf(root)) { const found = primaryScrollView(child); if (found) return found; }
  return undefined;
}

function scrollBox(root: LayoutBox, scroll: ScrollView): LayoutBox | undefined {
  if (root.scrollView === scroll) return root;
  for (const child of root.children) { const found = scrollBox(child, scroll); if (found) return found; }
  return undefined;
}

interface StickyRow { summary: string; start: number; jump?: () => void; scroll: ScrollView; row: number; column: number; width: number }

/** Owns the per-TUI state: floating autocomplete and the sticky header. */
class FullscreenView {
  private tui: TUI | undefined;
  private releaseFrame: (() => void) | undefined;
  private config: FullscreenLayoutConfig | undefined;
  private editor: AutocompleteEditor | undefined;
  private originalRender: Component["render"] | undefined;
  private patchedRender: Component["render"] | undefined;
  private overlay: OverlayHandle | undefined;
  private menu: string[] = [];
  private coreHeight = 0;
  private row = 0;
  private column = 0;
  private width = 0;
  private document: Container | undefined;
  private documentOriginal: Component["render"] | undefined;
  private documentPatched: Component["render"] | undefined;
  private messageSpans: Array<{ summary: string; start: number; end: number; jump?: () => void }> = [];
  private documentHeight = 0;
  private sticky: StickyRow | undefined;
  private stickyPaint: { frame: LayoutFrame; row: number; line: string } | undefined;
  private frameWidth = 0;
  private frameHeight = 0;
  private frameUsable = false;

  /** The sticky header is drawn into the frame, not as a Pi overlay: an
   * overlay makes Pi anchor every selection to the screen instead of the
   * transcript, so a highlight would stay put while the text scrolls. */
  readonly onFrame: FrameConsumer = (renderer, frame, screen, width) => {
    if (renderer.mode !== "fullscreen" || !sameTui(renderer, this.tui) || !this.config?.enabled) return screen;
    this.stickyPaint = undefined;
    try {
      if (!validFrame(frame) || frame.width !== renderer.terminal.columns || frame.height !== renderer.terminal.rows) {
        throw new Error("native frame dimensions are unavailable");
      }
      const box = editorBox(frame.root);
      if (box && Number.isFinite(box.rect.y) && box.rect.y > 0 && Number.isFinite(box.rect.width) && box.rect.width > 0) {
        this.row = box.rect.y;
        this.column = box.rect.x;
        this.width = box.rect.width;
        this.frameWidth = frame.width;
        this.frameHeight = frame.height;
        this.frameUsable = true;
        this.prepareAutocomplete(this.tui!);
      } else this.stopFloating(); // A native custom view can legitimately replace the editor.
      this.updateSticky(frame);
      markOk("fullscreen.frame");
      const sticky = this.sticky;
      if (!sticky || sticky.row < 0 || sticky.row >= screen.length) return screen;
      const result = [...screen];
      result[sticky.row] = compositeTuiLine(result[sticky.row] ?? "", renderSticky(sticky.summary, sticky.width), sticky.column, sticky.width, width);
      this.stickyPaint = { frame, row: sticky.row, line: result[sticky.row]! };
      return result;
    } catch (error) {
      this.sticky = undefined;
      this.stopFloating();
      markBroken("fullscreen.frame", String(error));
      return screen;
    }
  };

  readonly finishSelection: SelectionFinish = (renderer, before, after, frame) => {
    const paint = this.stickyPaint;
    if (!sameTui(renderer, this.tui) || !paint || paint.frame !== frame || !Array.isArray(after)
      || before[paint.row] !== paint.line || after[paint.row] === paint.line) return after;
    const result = [...after];
    result[paint.row] = paint.line;
    return result;
  };

  /** A press on the sticky header jumps to its question instead of starting a selection. */
  readonly onPress: PressInterceptor = (renderer, event) => {
    const sticky = this.sticky;
    if (!sticky || !sameTui(renderer, this.tui) || event.y !== sticky.row
      || event.x < sticky.column || event.x >= sticky.column + sticky.width) return undefined;
    sticky.scroll.scrollTo(sticky.start, { disableFollow: true });
    sticky.jump?.();
    const header: Component = {
      render: () => [],
      invalidate() {},
      // The rest of this gesture belongs to the header, not to the transcript under it.
      handleMouse: (next) => next.type === "click" || next.type === "release" ? { handled: true, render: false } : undefined,
    };
    return { handled: true, target: { component: header, originX: sticky.column, originY: sticky.row, width: sticky.width, height: 1 } };
  };

  prepare(tui: TUI, config: FullscreenLayoutConfig): void {
    if (this.tui !== tui) this.detach();
    this.tui = tui;
    this.config = config;
    if (tui.mode !== "fullscreen" || !config.enabled) {
      this.restoreDocument();
      this.sticky = undefined;
      this.stickyPaint = undefined;
      this.stopFloating();
      return;
    }
    this.releaseFrame ??= subscribeFullscreenFrame(this.onFrame, tui);
    if (!this.releaseFrame) { this.stopFloating(); return; }
    if (config.stickyUserMessage) this.prepareSticky(tui);
    else { this.restoreDocument(); this.sticky = undefined; }
    if (!config.floatAutocomplete) { this.stopFloating(); return; }
    if (this.frameUsable) this.prepareAutocomplete(tui);
  }

  private prepareAutocomplete(tui: TUI): void {
    if (!this.config?.floatAutocomplete) { this.stopFloating(); return; }
    const editor = tui.children.map(root => autocompleteEditor(root)).find(Boolean);
    if (!editor || this.editor === editor && editor.render === this.patchedRender) return;
    this.restoreEditor();
    this.editor = editor;
    const original = editor.render;
    this.originalRender = original;
    const view = this;
    const patched: Component["render"] = function (width) {
      if (view.tui?.mode !== "fullscreen" || !view.config?.enabled || !view.config.floatAutocomplete
        || !view.frameUsable || view.frameWidth !== tui.terminal.columns || view.frameHeight !== tui.terminal.rows
        || !editor.autocompleteState || !editor.autocompleteList) {
        view.menu = [];
        return original.call(editor, width);
      }
      const saved = editor.autocompleteState;
      let core: string[];
      try { editor.autocompleteState = null; core = original.call(editor, width); }
      finally { editor.autocompleteState = saved; }
      const full = original.call(editor, width);
      if (full.length < core.length || core.some((line, index) => full[index] !== line)) {
        markBroken("fullscreen.autocomplete", "editor menu is no longer an appended block");
        view.menu = [];
        return full;
      }
      view.coreHeight = core.length;
      view.menu = full.slice(core.length);
      markOk("fullscreen.autocomplete");
      return core;
    };
    this.patchedRender = patched;
    editor.render = patched;
    this.overlay = tui.showOverlay({
      render: () => [
        ...Array.from({ length: this.config?.popupGap ?? 0 }, () => " ".repeat(this.width)),
        ...this.menu,
      ].slice(-Math.max(1, this.row)),
      invalidate() {},
      handleMouse: event => {
        const gap = this.config?.popupGap ?? 0;
        const clipped = Math.max(0, this.menu.length + gap - this.row);
        const y = event.y + clipped - gap;
        if (y < 0 || y >= this.menu.length) return { handled: true, render: false };
        const result = this.editor?.handleMouse?.({ ...event, y: this.coreHeight + y });
        // Keep native editor focus; the overlay only hosts its relocated list.
        return result ? { ...result, focus: false } : undefined;
      },
    }, {
      nonCapturing: true,
      get row() { return Math.max(0, view.row - view.menu.length - (view.config?.popupGap ?? 0)); },
      get col() { return view.column; },
      get width() { return Math.max(1, view.width); },
      visible: () => this.frameUsable && this.menu.length > 0 && this.row > 0 && this.editor?.focused === true,
    });
    tui.requestRender(); // First successful frame enables floating on the next layout pass.
  }

  private stopFloating(): void {
    const wasFloating = !!this.patchedRender || !!this.overlay;
    this.frameUsable = false;
    this.restoreEditor();
    this.menu = [];
    this.overlay?.hide(); this.overlay = undefined;
    if (wasFloating) this.tui?.requestRender();
  }

  private prepareSticky(tui: TUI): void {
    const host = tui as FullscreenTuiLike;
    const scroll = host.currentLayout?.primaryScrollView ?? (host.layoutRoot ? primaryScrollView(host.layoutRoot) : undefined);
    const document = scroll?.children[0];
    if (!document || document === this.document) return;
    this.restoreDocument();
    if (!(document instanceof Container) || document.render !== Container.prototype.render) {
      markBroken("fullscreen.sticky", `primary ScrollView document is not a transparent Container (instance=${document instanceof Container}, nativeRender=${document.render === Container.prototype.render}, ownRender=${Object.hasOwn(document, "render")}, constructor=${document.constructor?.name})`);
      return;
    }
    this.document = document;
    const original = document.render;
    this.documentOriginal = original;
    const view = this;
    // Record which rows each user message drew, during the render Pi does anyway.
    const patched: Component["render"] = function (width) {
      const leaves: Component[] = [];
      const collect = (component: Component): void => {
        if (component instanceof Container && component.render === Container.prototype.render) {
          for (const child of component.children) collect(child);
        } else leaves.push(component);
      };
      for (const child of document.children) collect(child);
      const restorations: Array<() => void> = [];
      const spans: Array<{ summary: string; start: number; end: number; jump?: () => void }> = [];
      let offset = 0;
      let valid = true;
      try {
        for (const component of new Set(leaves)) {
          const render = component.render;
          const descriptor = Object.getOwnPropertyDescriptor(component, "render");
          component.render = function (columns) {
            const lines = render.call(this, columns);
            if (component instanceof UserMessageComponent) {
              try {
                const text: unknown = (component as unknown as { text?: unknown }).text;
                if (typeof text !== "string") throw new Error("UserMessageComponent.text is not a string");
                spans.push({ summary: summarise(text), start: offset, end: offset + lines.length });
              } catch (error) { valid = false; markBroken("fullscreen.sticky", String(error)); }
            }
            if (isHistoryAnchor(component)) {
              for (const span of component.stickySpans) spans.push({ summary: span.summary, start: offset + span.start, end: offset + span.end, jump: span.jump });
            }
            offset += lines.length;
            return lines;
          };
          restorations.push(() => {
            if (descriptor) Object.defineProperty(component, "render", descriptor);
            else delete (component as { render?: Component["render"] }).render;
          });
        }
        const lines = original.call(document, width);
        view.documentHeight = offset;
        view.messageSpans = valid && offset === lines.length ? spans : [];
        if (offset !== lines.length) markBroken("fullscreen.sticky", "document render no longer concatenates child rows");
        return lines;
      } finally { for (const restore of restorations) restore(); }
    };
    this.documentPatched = patched;
    document.render = patched;
    tui.requestRender();
  }

  private updateSticky(frame: LayoutFrame): void {
    this.sticky = undefined;
    if (!this.config?.enabled || !this.config.stickyUserMessage || !frame.primaryScrollView) return;
    const box = scrollBox(frame.root, frame.primaryScrollView);
    if (!box || box.rect.height <= this.config.minViewportRows
      || box.scrollContentLines?.length !== this.documentHeight) return;
    const top = frame.primaryScrollView.scrollTop;
    let owner: (typeof this.messageSpans)[number] | undefined;
    for (const span of this.messageSpans) {
      if (span.start > top) break;
      owner = span;
    }
    if (!owner || owner.end > top || !owner.summary) return;
    this.sticky = { summary: owner.summary, start: owner.start, jump: owner.jump, scroll: frame.primaryScrollView,
      row: box.rect.y, column: box.rect.x, width: box.rect.width };
    markOk("fullscreen.sticky");
  }

  private restoreDocument(): void {
    if (this.document && this.documentOriginal && this.document.render === this.documentPatched) this.document.render = this.documentOriginal;
    this.document = undefined; this.documentOriginal = undefined; this.documentPatched = undefined;
    this.messageSpans = []; this.documentHeight = 0;
  }

  private restoreEditor(): void {
    if (this.editor && this.originalRender && this.editor.render === this.patchedRender) this.editor.render = this.originalRender;
    this.editor = undefined; this.originalRender = undefined; this.patchedRender = undefined;
  }

  detach(): void {
    this.restoreEditor();
    this.restoreDocument();
    this.sticky = undefined;
    this.stickyPaint = undefined;
    this.frameUsable = false;
    this.overlay?.hide(); this.overlay = undefined;
    this.menu = []; this.tui = undefined;
    this.releaseFrame?.(); this.releaseFrame = undefined;
  }
}

export interface FullscreenBridge {
  prepare(tui: TUI, config: FullscreenLayoutConfig, getTheme?: () => Theme | undefined): void;
  release(): void;
}

/** One bridge per Pi view (Main, Side, each Subagent): geometry, outside press, autocomplete, sticky, selection colours. */
export function installFullscreenBridge(): FullscreenBridge {
  declareProbes(PROBES);
  requestLayoutModule();
  const releaseSpacing = installWidgetSpacing();
  const view = new FullscreenView();
  const releaseStickySelection = installStickySelectionPatch(view.finishSelection);
  const releaseMouse = installMousePatch(view.onPress);
  let readTheme: (() => Theme | undefined) | undefined;
  const releaseSelection = installSelectionPatch(() => readTheme?.());
  let attachedTui: TUI | undefined;
  const releaseResolver = publishEditorSlotGeometryResolver((tui) =>
    attachedTui && (tui === attachedTui || sameTui(tui, attachedTui)) ? snapshotFullscreenEditorSlot(tui) : undefined);
  let released = false;
  return {
    prepare(tui, config, getTheme) {
      if (released) return;
      const firstAttach = attachedTui !== tui;
      attachedTui = tui;
      readTheme = getTheme;
      view.prepare(tui, config);
      if (firstAttach && isFullscreen(tui)) {
        // Prove geometry on this live TUI with Pi's own frame; diagnostics must
        // not run layout while the widget factory is still building its tree.
        try {
          const frame = (tui as FullscreenTuiLike).currentLayout;
          if (validFrame(frame) && frame.width === tui.terminal.columns && frame.height === tui.terminal.rows) editorSlotFromFrame(frame);
        } catch (error) { markBroken("fullscreen.editorGeometry", String(error)); }
      }
    },
    release() {
      if (released) return;
      released = true;
      attachedTui = undefined;
      view.detach();
      readTheme = undefined;
      releaseSelection();
      releaseResolver();
      releaseMouse();
      releaseStickySelection();
      releaseSpacing();
    },
  };
}
