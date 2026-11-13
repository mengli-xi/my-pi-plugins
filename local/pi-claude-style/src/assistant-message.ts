import { presentationPrototype, recordAssistantThinkingPresentation } from "./presentation-owner.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  sliceByColumn,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { clickable } from "./clickable.ts";
import {
  assistantMessagePrototype,
  assistantPresentationChildCompat,
  assistantPresentationState,
  markdownDefaultStyleCompat,
  retainAssistantSourceMessage,
} from "./compat/assistant-message.ts";
import { CodeFenceMarkerHidingComponent } from "./code-fence.ts";
import { snapshotExtensionContext } from "./extension-context.ts";
import {
  mutedEllipsis,
  paintWithMutedEllipses,
} from "./ellipsis.ts";
import { declareProbes, markBroken, markOk, type Probe } from "./internals.ts";
import type {
  ActivityTimelineStore,
  ThinkingChatProjection,
} from "./activity-timeline.ts";
import type { TextOpener } from "./openers.ts";
import type { CcStyleObservability } from "./observability.ts";
import {
  sanitizeAssistantErrorPresentation,
  type RepeatedErrorCollapser,
} from "./repeated-errors.ts";
import {
  formatThinkingElapsed,
  ThinkingDocument,
} from "./thinking-document.ts";
export { formatThinkingElapsed, ThinkingDocument } from "./thinking-document.ts";
import {
  StreamingTypewriter,
  type TypewriterClock,
} from "./streaming-typewriter.ts";
import type { AssistantMessagesConfig } from "./types.ts";
import { stripLatestActivityHeadline } from "./working-activity.ts";

/** @see ./internals.ts — the names this patch cannot do without. */
const THINKING_RUNS = Symbol("pi-claude-transcript.thinking-runs");

export const PROBES: Probe[] = [
  {
    id: "assistant-message.contentContainer",
    needs: "AssistantMessageComponent 实例的 contentContainer.children / outputPad",
    breaks: "同上：装饰无处可挂，思考块也不再能点开",
  },
  {
    id: "assistant-message.childShape",
    needs: "MouseRegion 的 child 与 Markdown 的 defaultTextStyle 字段",
    breaks: "无法区分文本与 thinking Markdown，相关子块退回原生布局",
  },
  {
    id: "assistant-message.lastMessage",
    needs: "AssistantMessageComponent 实例的 lastMessage 字段",
    breaks: "流式 thinking 展开或重绘后可能重新显示 spinner 已接管的标题",
  },
];

type UpdateContentFn = (
  message: AssistantMessage,
  isStreaming?: boolean,
) => void;
interface PatchableAssistantMessage {
  [THINKING_RUNS]?: ThinkingRun[];
}

const THINKING_CLOCK: TypewriterClock = {
  now: Date.now,
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};

interface ThinkingRun {
  id?: string;
  document: ThinkingDocument;
  startedAt?: number;
  endedAt?: number;
  active?: boolean;
  visible?: boolean;
  isVisible?: () => boolean;
  current?: () => { startedAt?: number; endedAt?: number; active?: boolean } | undefined;
}

interface PatchablePrototype {
  updateContent: UpdateContentFn;
  [key: symbol]: unknown;
}

interface PatchState {
  version: 1;
  owner: symbol;
  original: UpdateContentFn;
  patched: UpdateContentFn;
  disposeTypewriter?: () => void;
}

const PATCH_STATE = Symbol.for("pi-claude-transcript.assistant-message.patch");
const PATCH_OWNER = Symbol("pi-claude-transcript.assistant-message.owner");
const TYPEWRITER_WIDGET_KEY = "pi-claude-transcript:typewriter-render-pulse";
const HIDDEN_THINKING_LABEL = "Thinking...";
const THINKING_PREVIEW_PREFIX = "Thinking: ";
const EXPANDED_THINKING_LABEL = "Thinking：";
const THINKING_OVERLAY_TITLE = "Thinking";
const MIN_PREVIEW_WIDTH = 12;
/** Rows a folded thinking run may occupy, continuation included. */
const PREVIEW_ROWS = 2;
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
/** Columns thinking gains so it lines up with bullet-prefixed text. */
const THINKING_INDENT = 1;
/** Extra hanging indent beneath the expanded Thinking label. */
const THINKING_BODY_INDENT = 2;

function colorMarker(
  theme: Theme | undefined,
  config: AssistantMessagesConfig,
): string {
  if (!theme) return config.marker;
  try {
    return theme.fg(config.markerColor, config.marker);
  } catch {
    return config.marker;
  }
}

function plainLine(line: string): string {
  return line.replace(ANSI_OSC_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
}

/**
 * Adds one marker to a logical component while preserving the component's own
 * Markdown wrapping, ANSI styling, padding, and blank lines.
 */
export class LogicalBulletComponent implements Component {
  private readonly child: Component;
  private readonly config: AssistantMessagesConfig;
  private readonly getTheme: () => Theme | undefined;

  constructor(
    child: Component,
    config: AssistantMessagesConfig,
    getTheme: () => Theme | undefined,
  ) {
    this.child = child;
    this.config = config;
    this.getTheme = getTheme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const markerWidth = visibleWidth(this.config.marker);
    if (markerWidth < 1 || safeWidth <= markerWidth) {
      return this.child.render(safeWidth);
    }
    const lines = this.child.render(safeWidth - markerWidth);
    if (!lines.length) return lines;
    const continuation = " ".repeat(markerWidth);
    const marker = colorMarker(this.getTheme(), this.config);
    return lines.map((line, index) =>
      `${index === 0 ? marker : continuation}${line}`
    );
  }

  invalidate(): void {
    this.child.invalidate?.();
  }
}

/**
 * Shifts a child right so thinking lines up with the text and tool rows around
 * it. Pi renders a thinking run with only its own padding and no leading
 * glyph, which lands it one column left of body text (which carries the
 * bullet) and of the grouped tool rows (which carry a status glyph).
 */
export class IndentedComponent implements Component {
  private readonly child: Component;
  private readonly columns: number;

  constructor(child: Component, columns: number) {
    this.child = child;
    this.columns = Math.max(0, columns);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (this.columns < 1 || safeWidth <= this.columns) {
      return this.child.render(safeWidth);
    }
    const pad = " ".repeat(this.columns);
    // Blank lines stay blank rather than gaining trailing spaces.
    return this.child
      .render(safeWidth - this.columns)
      .map((line) => (line.length > 0 ? `${pad}${line}` : line));
  }

  invalidate(): void {
    this.child.invalidate?.();
  }
}

/**
 * Gives expanded reasoning a stable label and a compact hanging body:
 *
 * Thinking：
 *    reasoning line
 *    next line
 *
 * Pi's Markdown child already owns `outputPad`; the extra body indent is
 * added outside it. Empty Markdown layout rows are omitted so paragraphs do
 * not turn a streamed thought into a vertically loose transcript block.
 */
export class ExpandedThinkingComponent implements Component {
  private readonly child: Component;
  private readonly paddingX: number;
  private readonly bodyIndent: number;
  private readonly getTheme: () => Theme | undefined;
  private readonly elapsed: (() => string | undefined) | undefined;
  private readonly preserveMarkdownLayout: boolean;
  private readonly disclosure: (() => string) | undefined;
  private readonly labelAtBottom: boolean;

  constructor(
    child: Component,
    paddingX: number,
    getTheme: () => Theme | undefined,
    bodyIndent: number = THINKING_BODY_INDENT,
    elapsed?: () => string | undefined,
    preserveMarkdownLayout = false,
    disclosure?: () => string,
    labelAtBottom = false,
  ) {
    this.child = child;
    this.paddingX = Math.max(0, paddingX);
    this.bodyIndent = Math.max(0, bodyIndent);
    this.getTheme = getTheme;
    this.elapsed = elapsed;
    this.preserveMarkdownLayout = preserveMarkdownLayout;
    this.disclosure = disclosure;
    this.labelAtBottom = labelAtBottom;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth <= this.paddingX) return [];
    const currentElapsed = this.elapsed?.();
    const elapsed = currentElapsed ? ` ${currentElapsed}` : "";
    const label = `${" ".repeat(this.paddingX)}${this.style(
      truncateToWidth(
        `${this.disclosure?.() ?? ""}Thinking${elapsed}${this.labelAtBottom ? "" : "："}`,
        Math.max(0, safeWidth - this.paddingX),
        "",
      ),
    )}`;
    const childWidth = Math.max(0, safeWidth - this.bodyIndent);
    const pad = " ".repeat(this.bodyIndent);
    const rendered = this.child.render(childWidth);
    const body = this.preserveMarkdownLayout
      ? trimOuterBlankLines(rendered).map((line) =>
        plainLine(line).trim().length > 0 ? `${pad}${line}` : ""
      )
      : rendered
        .filter((line) => plainLine(line).trim().length > 0)
        .map((line) => `${pad}${line}`);
    if (!this.labelAtBottom) return [label, ...body];
    return body.length > 0 ? [...body, "", label] : [label];
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  private style(text: string): string {
    const theme = this.getTheme();
    if (!theme) return text;
    try {
      return theme.italic(theme.fg("thinkingText", text));
    } catch {
      return text;
    }
  }
}

function trimOuterBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && plainLine(lines[start]!).trim().length === 0) start++;
  while (end > start && plainLine(lines[end - 1]!).trim().length === 0) end--;
  return lines.slice(start, end);
}

/**
 * Split a flattened preview across at most `rows` lines of `width` columns,
 * marking the last one with an ellipsis when there is more text than fits.
 *
 * Wrapping is done here rather than with the shared text wrapper because the
 * preview is already stripped of markup and has to obey a row budget: the row
 * count of a folded run must not depend on its content, or the transcript
 * resizes every time one is drawn.
 */
export function foldPreview(
  preview: string,
  width: number,
  rows: number,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  let rest = preview.trim();
  for (let row = 0; row < rows && rest.length > 0; row++) {
    if (visibleWidth(rest) <= safeWidth) {
      lines.push(rest);
      return lines;
    }
    if (row === rows - 1) {
      const cut = charsWithin(rest, Math.max(1, safeWidth - 1));
      lines.push(`${rest.slice(0, cut).trimEnd()}…`);
      return lines;
    }
    const cut = charsWithin(rest, safeWidth);
    // Prefer a word boundary, but only when one is close enough to the edge
    // that breaking there does not leave the line visibly short. CJK has no
    // spaces, so it always falls through to the column break.
    const space = rest.slice(0, cut).lastIndexOf(" ");
    const at = space > cut / 2 ? space : cut;
    lines.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  return lines;
}

/**
 * How much of `text` fits in `width` columns, as a slice index.
 *
 * `truncateToWidth` cannot answer this: it appends an ellipsis and colour
 * resets, so the string it returns is neither the prefix that fits nor an
 * index into the original.
 */
function charsWithin(text: string, width: number): number {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const columns = visibleWidth(char);
    if (used + columns > width) break;
    used += columns;
    index += char.length;
  }
  return index;
}

/** Collapses one thinking run into a single previewed line. */
export function buildThinkingPreview(thinking: string): string {
  const inline = thinking
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return inline;
}

/**
 * Replaces Pi's static hidden-thinking label with a single line that previews
 * the folded reasoning, so a collapsed run still says what it was about.
 */
export class CollapsedThinkingComponent implements Component {
  private readonly preview: string;
  private readonly paddingX: number;
  private readonly getTheme: () => Theme | undefined;
  private readonly markdown: Markdown;

  constructor(
    preview: string,
    paddingX: number,
    getTheme: () => Theme | undefined,
  ) {
    this.preview = preview;
    this.paddingX = Math.max(0, paddingX);
    this.getTheme = getTheme;
    // Keep one Markdown child for the lifetime of this preview. Constructing a
    // fresh parser on every TUI frame made the folded block needlessly hot;
    // replacing it with plain text after the first update lost inline Markdown
    // styling. The style callbacks remain theme-aware when the child is
    // invalidated after a theme change.
    this.markdown = new Markdown(
      preview,
      0,
      0,
      getMarkdownTheme(),
      {
        color: (text) => this.color(text),
        italic: true,
      },
    );
  }

  render(width: number): string[] {
    const available = Math.max(0, Math.floor(width) - this.paddingX * 2);
    const pad = " ".repeat(this.paddingX);
    const prefixWidth = visibleWidth(THINKING_PREVIEW_PREFIX);
    const previewWidth = available - prefixWidth;
    if (!this.preview || previewWidth < MIN_PREVIEW_WIDTH) {
      return [
        `${pad}${this.styleWithMutedEllipses(
          truncateToWidth(HIDDEN_THINKING_LABEL, available, "…"),
        )}`,
      ];
    }
    // Render Markdown through one persistent child, then enforce the folded
    // row budget on its rendered output. This preserves emphasis and inline
    // code on every frame without allowing Markdown layout to grow the block.
    const rendered = this.markdown.render(previewWidth).map((line) => {
      const trimmedWidth = visibleWidth(plainLine(line).trimEnd());
      return sliceByColumn(line, 0, trimmedWidth, true);
    });
    const previewRows = rendered.length > 0
      ? rendered.slice(0, PREVIEW_ROWS)
      : foldPreview(this.preview, previewWidth, PREVIEW_ROWS);
    if (rendered.length > PREVIEW_ROWS && previewRows[PREVIEW_ROWS - 1]) {
      previewRows[PREVIEW_ROWS - 1] = `${truncateToWidth(
        previewRows[PREVIEW_ROWS - 1]!,
        Math.max(1, previewWidth - 1),
        "",
      )}${this.ellipsis()}`;
    }
    const [first = "", second] = previewRows;
    const rows = [
      `${pad}${this.style(THINKING_PREVIEW_PREFIX)}${first}`,
    ];
    if (second) {
      rows.push(
        `${pad}${" ".repeat(prefixWidth)}${this.styleWithMutedEllipses(second)}`,
      );
    }
    return rows;
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  private color(text: string): string {
    const theme = this.getTheme();
    if (!theme) return text;
    try {
      return theme.fg("thinkingText", text);
    } catch {
      return text;
    }
  }

  private style(text: string): string {
    const theme = this.getTheme();
    if (!theme) return text;
    try {
      return theme.italic(this.color(text));
    } catch {
      return text;
    }
  }

  private ellipsis(): string {
    const theme = this.getTheme();
    return theme ? mutedEllipsis(theme) : "…";
  }

  private styleWithMutedEllipses(text: string): string {
    const theme = this.getTheme();
    return theme
      ? paintWithMutedEllipses(text, theme, (part) => this.style(part))
      : text;
  }
}

/** A hidden structural row; used only when Pi emitted no usable run text. */
export class HiddenThinkingComponent implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

/** Keeps an already-mounted historical row in sync with the shared Activity projection. */
class ProjectedThinkingComponent implements Component {
  private readonly child: Component;
  private readonly isVisible: () => boolean;

  constructor(child: Component, isVisible: () => boolean) {
    this.child = child;
    this.isVisible = isVisible;
  }

  render(width: number): string[] {
    return this.isVisible() ? this.child.render(width) : [];
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.isVisible()) return undefined;
    return this.child.handleMouse?.(event);
  }

  isCurrentlyVisible(): boolean {
    return this.isVisible();
  }
}

/**
 * Projects Pi's physical spacers onto the currently visible logical blocks.
 * Hidden or merged Thinking children may leave several native spacers in one
 * logical gap; exactly one survives, and a fully hidden message renders none.
 */
class ProjectedSpacerLayout {
  private readonly children: readonly Component[];
  private readonly limit: number;
  private cachedWidth: number | undefined;
  private visible: readonly number[] = [];
  private spacers: readonly number[] = [];

  constructor(children: readonly Component[], limit: number) {
    this.children = children;
    this.limit = limit;
  }

  rendersSpacer(index: number, width: number): boolean {
    if (this.cachedWidth !== width) this.measure(width);
    const visible = this.visible;
    const spacers = this.spacers;
    const first = visible[0];
    if (first === undefined) return false;
    if (index < first) {
      return index === spacers.filter((candidate) => candidate < first).at(-1);
    }
    const before = visible.filter((candidate) => candidate < index).at(-1);
    const after = visible.find((candidate) => candidate > index);
    if (before === undefined || after === undefined) return false;
    return index === spacers.filter(
      (candidate) => candidate > before && candidate < after,
    ).at(-1);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
  }

  private measure(width: number): void {
    const visible: number[] = [];
    const spacers: number[] = [];
    for (let cursor = 0; cursor < this.limit; cursor++) {
      const component = this.children[cursor];
      if (!component) continue;
      if (component instanceof ProjectedSpacerComponent || isSpacerComponent(component)) {
        spacers.push(cursor);
      } else if (componentRenders(component, width)) {
        visible.push(cursor);
      }
    }
    this.cachedWidth = width;
    this.visible = visible;
    this.spacers = spacers;
  }
}

class ProjectedSpacerComponent implements Component {
  private readonly spacer: Component;
  private readonly layout: ProjectedSpacerLayout;
  private readonly index: number;

  constructor(spacer: Component, layout: ProjectedSpacerLayout, index: number) {
    this.spacer = spacer;
    this.layout = layout;
    this.index = index;
  }

  render(width: number): string[] {
    return this.layout.rendersSpacer(this.index, width)
      ? this.spacer.render(width)
      : [];
  }

  invalidate(): void {
    this.layout.invalidate();
    this.spacer.invalidate?.();
  }
}

function componentRenders(component: Component, width: number): boolean {
  if (component instanceof HiddenThinkingComponent) return false;
  if (component instanceof ProjectedThinkingComponent && !component.isCurrentlyVisible()) {
    return false;
  }
  return component.render(width).length > 0;
}

function projectedThinking(
  child: Component,
  state: (ThinkingRun | ThinkingChatProjection) & { isVisible?: () => boolean } | undefined,
  isVisible?: () => boolean,
): Component {
  const visible = isVisible ?? state?.isVisible;
  return visible ? new ProjectedThinkingComponent(child, visible) : child;
}

/** Preserves Pi's rendered Markdown while presenting several native blocks as one run. */
class RetainedThinkingComponent implements Component {
  private readonly expanded: Component;
  private readonly collapsed: Component;
  private readonly isExpanded: () => boolean;
  private readonly isCurrent: () => boolean;
  private readonly toggle: () => boolean;
  private readonly openHistorical: () => boolean;
  private toggleRow = 0;

  constructor(
    expanded: Component,
    collapsed: Component,
    isExpanded: () => boolean,
    isCurrent: () => boolean,
    toggle: () => boolean,
    openHistorical: () => boolean,
  ) {
    this.expanded = expanded;
    this.collapsed = collapsed;
    this.isExpanded = isExpanded;
    this.isCurrent = isCurrent;
    this.toggle = toggle;
    this.openHistorical = openHistorical;
  }

  render(width: number): string[] {
    const expanded = this.isExpanded();
    const lines = (expanded ? this.expanded : this.collapsed).render(width);
    this.toggleRow = expanded ? Math.max(0, lines.length - 1) : 0;
    return lines;
  }

  invalidate(): void {
    this.expanded.invalidate?.();
    this.collapsed.invalidate?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    if (this.isCurrent()) {
      if (event.y !== this.toggleRow) return undefined;
      return this.toggle() ? { handled: true } : undefined;
    }
    return this.openHistorical() ? { handled: true } : undefined;
  }
}

/** Keep the latest block expanded until a different block becomes active. */
function weakThinkingInvalidator(component: Component, requestRender: () => void): () => void {
  const reference = new WeakRef(component);
  return () => { reference.deref()?.invalidate?.(); requestRender(); };
}

class ThinkingBlockHandoff {
  private current: ThinkingDocument | string | undefined;
  private invalidateCurrent: (() => void) | undefined;
  private readonly manuallyCollapsed = new WeakSet<ThinkingDocument>();
  private readonly collapsedIds = new Set<string>();

  observe(state: ThinkingRun, invalidate: () => void): void {
    const current = state.current?.();
    const active = current?.active ?? state.active === true;
    if (!active) return;
    const key = state.id ?? state.document;
    if (this.current === key) {
      this.invalidateCurrent = invalidate;
      return;
    }
    const invalidatePrevious = this.invalidateCurrent;
    this.current = key;
    this.invalidateCurrent = invalidate;
    invalidatePrevious?.();
  }

  retains(state: ThinkingRun): boolean {
    return this.current === (state.id ?? state.document);
  }

  isCollapsed(state: ThinkingRun): boolean {
    return state.id ? this.collapsedIds.has(state.id) : this.manuallyCollapsed.has(state.document);
  }

  toggle(state: ThinkingRun): boolean {
    if (!this.retains(state)) return false;
    if (state.id) {
      if (this.collapsedIds.has(state.id)) this.collapsedIds.delete(state.id);
      else this.collapsedIds.add(state.id);
    } else if (this.manuallyCollapsed.has(state.document)) {
      this.manuallyCollapsed.delete(state.document);
    } else {
      this.manuallyCollapsed.add(state.document);
    }
    this.invalidateCurrent?.();
    return true;
  }

  dispose(): void {
    this.current = undefined;
    this.invalidateCurrent = undefined;
    this.collapsedIds.clear();
  }
}

class MergedThinkingComponent implements Component {
  private readonly children: readonly Component[];

  constructor(children: readonly Component[]) {
    this.children = children;
  }

  render(width: number): string[] {
    const rendered: string[] = [];
    for (const child of this.children) {
      const lines = child.render(width);
      if (!lines.length) continue;
      if (rendered.length) rendered.push("");
      rendered.push(...lines);
    }
    return rendered;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }
}

/** One persistent folded-thinking row; its timer freezes when the run ends. */
export class ActiveThinkingComponent implements Component {
  private readonly startedAt: number | undefined;
  private readonly endedAt: number | undefined;
  private readonly currentTiming:
    | (() => { startedAt?: number; endedAt?: number } | undefined)
    | undefined;
  private readonly paddingX: number;
  private readonly getTheme: () => Theme | undefined;
  private readonly now: () => number;
  private readonly disclosure: (() => string) | undefined;

  constructor(
    startedAt: number | undefined,
    paddingX: number,
    getTheme: () => Theme | undefined,
    now: () => number = Date.now,
    endedAt?: number,
    currentTiming?: () => { startedAt?: number; endedAt?: number } | undefined,
    disclosure?: () => string,
  ) {
    this.startedAt = startedAt;
    this.endedAt = endedAt;
    this.currentTiming = currentTiming;
    this.paddingX = Math.max(0, paddingX);
    this.getTheme = getTheme;
    this.now = now;
    this.disclosure = disclosure;
  }

  render(width: number): string[] {
    const available = Math.max(0, Math.floor(width) - this.paddingX * 2);
    if (available < 1) return [];
    const pad = " ".repeat(this.paddingX);
    const timing = this.currentTiming?.();
    const startedAt = timing?.startedAt ?? this.startedAt;
    const endedAt = timing?.endedAt ?? this.endedAt;
    const elapsed = startedAt === undefined
      ? ""
      : ` ${formatThinkingElapsed((endedAt ?? this.now()) - startedAt)}`;
    const label = `${this.disclosure?.() ?? ""}Thinking${elapsed}`;
    return [
      `${pad}${this.styleWithMutedEllipses(
        truncateToWidth(label, available, "…"),
      )}`,
    ];
  }

  invalidate(): void {}

  private style(text: string): string {
    const theme = this.getTheme();
    if (!theme) return text;
    try {
      return theme.italic(theme.fg("thinkingText", text));
    } catch {
      return text;
    }
  }

  private styleWithMutedEllipses(text: string): string {
    const theme = this.getTheme();
    return theme
      ? paintWithMutedEllipses(text, theme, (part) => this.style(part))
      : text;
  }
}

export function isActivelyThinking(
  message: AssistantMessage,
  isStreaming: boolean,
): boolean {
  if (!isStreaming) return false;
  for (let index = message.content.length - 1; index >= 0; index--) {
    const content = message.content[index]!;
    if (content.type === "thinking") {
      if (content.thinking.trim()) return true;
      continue;
    }
    if (content.type === "text") {
      if (content.text.trim()) return false;
      continue;
    }
    // A tool call ends the current thinking block. A later reasoning segment
    // can still join the same Activity phase, but it starts its own live view.
    if (content.type === "toolCall") return false;
    return false;
  }
  return false;
}

function hasVisibleContent(message: AssistantMessage): boolean {
  return message.content.some(
    (content) =>
      (content.type === "text" && content.text.trim().length > 0) ||
      (content.type === "thinking" && content.thinking.trim().length > 0),
  );
}

/**
 * Codex reasoning-summary headlines are already the live working-spinner
 * label. Remove only the newest one from a presentation clone while the turn
 * is streaming, so expanded thinking keeps its body without drawing the same
 * headline twice. The session message remains byte-for-byte unchanged.
 */
export function withoutSpinnerHeadline(message: AssistantMessage): {
  message: AssistantMessage;
  spinnerOwnsHeadline: boolean;
} {
  let candidate:
    | { index: number; thinking: string }
    | undefined;
  for (let index = 0; index < message.content.length; index++) {
    const content = message.content[index]!;
    if (content.type !== "thinking") continue;
    const stripped = stripLatestActivityHeadline(content.thinking);
    if (stripped.headline) {
      candidate = { index, thinking: stripped.thinking };
    }
  }
  if (!candidate) return { message, spinnerOwnsHeadline: false };

  const content = [...message.content];
  const original = content[candidate.index]!;
  if (original.type !== "thinking") {
    return { message, spinnerOwnsHeadline: false };
  }
  content[candidate.index] = {
    ...original,
    thinking: candidate.thinking,
  };
  return {
    message: { ...message, content },
    spinnerOwnsHeadline: true,
  };
}

/**
 * Pi appends up to two trailing children (a Spacer plus an error Text) after
 * the content blocks. Excluding them keeps an error row from being mistaken
 * for a folded thinking label.
 */
function contentChildCount(
  children: readonly Component[],
  message: AssistantMessage,
): number {
  const hasToolCalls = message.content.some(
    (content) => content.type === "toolCall",
  );
  const hasErrorRow =
    message.stopReason === "length" ||
    (!hasToolCalls &&
      (message.stopReason === "aborted" || message.stopReason === "error"));
  return Math.max(0, children.length - (hasErrorRow ? 2 : 0));
}

interface ThinkingRunLayout {
  runs: string[];
  /** Logical run index for each native thinking child emitted by Pi. */
  nativeRunIndices: number[];
}

/**
 * Groups reasoning by visible conversation boundaries. Tool calls may split
 * Pi's native Markdown children, but they do not create a second transcript
 * Thinking row; only visible assistant prose starts a new logical run.
 */
function thinkingRunLayout(message: AssistantMessage): ThinkingRunLayout {
  const runs: string[] = [];
  const nativeRunIndices: number[] = [];
  let logicalRun: number | undefined;
  let nativeRunHasText = false;

  for (const content of message.content) {
    if (content.type === "thinking") {
      const thinking = content.thinking.trim();
      if (!thinking) continue;
      if (logicalRun === undefined) {
        logicalRun = runs.length;
        runs.push("");
      }
      if (!nativeRunHasText) nativeRunIndices.push(logicalRun);
      runs[logicalRun] = runs[logicalRun]
        ? `${runs[logicalRun]}\n\n${thinking}`
        : thinking;
      nativeRunHasText = true;
      continue;
    }

    nativeRunHasText = false;
    if (content.type === "text" && content.text.trim()) {
      logicalRun = undefined;
    }
  }

  return { runs, nativeRunIndices };
}

export function thinkingRuns(message: AssistantMessage): string[] {
  return thinkingRunLayout(message).runs;
}

function syncThinkingRuns(
  instance: PatchableAssistantMessage,
  message: AssistantMessage,
  activeThinking: boolean,
  now: number,
  clock: TypewriterClock,
): ThinkingRun[] {
  const bodies = thinkingRuns(message);
  const states = instance[THINKING_RUNS] ??= [];
  for (let index = 0; index < bodies.length; index++) {
    const body = bodies[index]!;
    const state = states[index] ??= {
      document: new ThinkingDocument(body, clock),
      startedAt: activeThinking && index === bodies.length - 1 ? now : undefined,
    };
    state.document.update(body);
    const active = activeThinking && index === bodies.length - 1;
    if (active && state.endedAt === undefined) {
      state.startedAt ??= now;
    } else if (!active && state.startedAt !== undefined) {
      // A run only moves from live to ended. Later component updates (theme,
      // folding, typewriter or replay) must not rewrite its elapsed time.
      state.endedAt ??= now;
    }
    state.active = active;
    state.document.updateTiming(state.startedAt, state.endedAt, active);
  }
  return states;
}

type ChildRole = "text" | "thinking" | "skip";

/**
 * Pi renders body text as a plain Markdown child and a thinking run as a
 * Markdown child carrying a default text style (or, when folded, as a Text
 * child). Classifying by component shape instead of by position keeps the
 * bullet marker off thinking blocks no matter what else is in the container.
 */
function constructorName(child: Component): unknown {
  return (child as { constructor?: { name?: unknown } }).constructor?.name;
}

function isSpacerComponent(child: Component | undefined): boolean {
  return child instanceof Spacer || (child ? constructorName(child) === "Spacer" : false);
}

function classifyChild(child: Component): {
  component: Component | undefined;
  preserveWrapper(replacement: Component): Component;
  role: ChildRole;
} {
  // npm's published pi-coding-agent carries its own pi-tui dependency, so a
  // component created inside Pi is not necessarily `instanceof` the copy an
  // extension imports. Constructor names plus the fields used below are the
  // cross-package boundary; relying on identity makes package-local installs
  // silently lose every decoration.
  if (isSpacerComponent(child)) {
    return { component: child, preserveWrapper: (replacement) => replacement, role: "skip" };
  }
  const compatible = assistantPresentationChildCompat(child);
  if (!compatible.component) {
    markBroken("assistant-message.childShape", "MouseRegion 上没有可用的 child 字段");
    return {
      component: undefined,
      preserveWrapper: compatible.preserveWrapper,
      role: "skip",
    };
  }
  const component = compatible.component;
  const name = constructorName(component);
  if (component instanceof Markdown || name === "Markdown") {
    const style = markdownDefaultStyleCompat(component as object);
    if (!style.compatible) {
      markBroken("assistant-message.childShape", "Markdown 上没有 defaultTextStyle 字段");
      return { component, preserveWrapper: compatible.preserveWrapper, role: "skip" };
    }
    markOk("assistant-message.childShape");
    return {
      component,
      preserveWrapper: compatible.preserveWrapper,
      role: style.styled ? "thinking" : "text",
    };
  }
  if (component instanceof Text || name === "Text") {
    markOk("assistant-message.childShape");
    return { component, preserveWrapper: compatible.preserveWrapper, role: "thinking" };
  }
  return { component, preserveWrapper: compatible.preserveWrapper, role: "skip" };
}

interface ChildPlan {
  component: Component;
  index: number;
  preserveWrapper(replacement: Component): Component;
  role: Exclude<ChildRole, "skip">;
  /** Set for thinking children whose run text is known. */
  runIndex?: number;
}

export function planAssistantChildren(
  children: readonly Component[],
  message: AssistantMessage,
  preserveNativeThinkingRuns = false,
): ChildPlan[] {
  const limit = contentChildCount(children, message);
  const plans: ChildPlan[] = [];
  const nativeRunIndices = preserveNativeThinkingRuns
    ? thinkingRunLayout(message).nativeRunIndices.map((_, index) => index)
    : thinkingRunLayout(message).nativeRunIndices;
  let nativeRunIndex = 0;
  for (let index = 0; index < limit; index++) {
    const child = children[index];
    if (!child) continue;
    const classified = classifyChild(child);
    if (classified.role === "skip" || !classified.component) continue;
    if (classified.role === "text") {
      plans.push({
        component: classified.component,
        index,
        preserveWrapper: classified.preserveWrapper,
        role: classified.role,
      });
      continue;
    }
    plans.push({
      component: classified.component,
      index,
      preserveWrapper: classified.preserveWrapper,
      role: classified.role,
      runIndex: nativeRunIndices[nativeRunIndex++],
    });
  }
  return plans;
}

/**
 * Marks body text, keeps expanded thinking clickable, and collapses thinking
 * according to policy. `activity` keeps one compact elapsed row per run.
 */
function decorateChildren(
  instance: PatchableAssistantMessage,
  message: AssistantMessage,
  config: AssistantMessagesConfig,
  getTheme: () => Theme | undefined,
  thinkingStates: readonly ThinkingRun[],
  openText: TextOpener,
  now: () => number,
  requestRender: () => void,
  thinkingHandoff?: ThinkingBlockHandoff,
  projected = false,
): void {
  const presentation = assistantPresentationState(instance);
  const children = presentation.children;
  if (!Array.isArray(children)) return;
  if (!hasVisibleContent(message)) return;

  const plans = planAssistantChildren(children, message, projected);
  // All native runs must be accounted for. Missing/opaque runs (including an
  // empty native hidden label) cannot be treated as CC-owned presentation.
  const representedRuns = new Set(plans.filter(plan => plan.role === "thinking").map(plan => plan.runIndex));
  let labelIndependent = !representedRuns.has(undefined)
    && representedRuns.size === thinkingRunLayout(message).nativeRunIndices.length;
  const runs = projected
    ? thinkingStates.map((state) => state.document.snapshot())
    : thinkingRuns(message);
  const paddingX = typeof presentation.outputPad === "number"
    ? presentation.outputPad
    : 1;
  const spacerAt: number[] = [];
  const firstThinkingPosition = new Map<number, number>();
  const thinkingChildren = new Map<number, Component[]>();
  for (let position = 0; position < plans.length; position++) {
    const plan = plans[position]!;
    if (plan.role !== "thinking" || plan.runIndex === undefined) continue;
    firstThinkingPosition.set(
      plan.runIndex,
      firstThinkingPosition.get(plan.runIndex) ?? position,
    );
    const grouped = thinkingChildren.get(plan.runIndex) ?? [];
    grouped.push(plan.component);
    thinkingChildren.set(plan.runIndex, grouped);
  }

  for (let position = 0; position < plans.length; position++) {
    const plan = plans[position]!;
    if (plan.role === "text") {
      children[plan.index] = plan.preserveWrapper(new LogicalBulletComponent(
        config.hideCodeFenceMarkers
          ? new CodeFenceMarkerHidingComponent(plan.component)
          : plan.component,
        config,
        getTheme,
      ));
      continue;
    }

    const run = plan.runIndex === undefined ? undefined : runs[plan.runIndex];
    const state = plan.runIndex === undefined ? undefined : thinkingStates[plan.runIndex];
    const firstPosition = plan.runIndex === undefined
      ? undefined
      : firstThinkingPosition.get(plan.runIndex);
    if (firstPosition !== undefined && position !== firstPosition) {
      children[plan.index] = new HiddenThinkingComponent();
      const previousPlan = plans[position - 1];
      if (previousPlan?.role === "thinking" && previousPlan.runIndex === plan.runIndex) {
        for (let index = previousPlan.index + 1; index < plan.index; index++) {
          if (isSpacerComponent(children[index])) {
            children[index] = new HiddenThinkingComponent();
          }
        }
      }
      continue;
    }
    const invalidate = weakThinkingInvalidator(instance as unknown as Component, requestRender);
    if (config.collapsedThinking === "activity" && state && thinkingHandoff) {
      thinkingHandoff.observe(state, invalidate);
    }
    const retainedVisibility = config.collapsedThinking === "activity" && state && thinkingHandoff
      ? () => thinkingHandoff.retains(state) || state.isVisible?.() === true ||
        (!state.isVisible && state.visible !== false)
      : undefined;
    if (!retainedVisibility && !state?.isVisible && state?.visible === false) {
      children[plan.index] = new HiddenThinkingComponent();
      continue;
    }
    const openRun = () => openText(
      THINKING_OVERLAY_TITLE,
      state?.document.snapshot() ?? run ?? "",
      {
        format: "markdown",
        tone: "thinkingText",
        live: state?.document,
        hideCodeFenceMarkers: config.hideCodeFenceMarkers,
      },
    );
    const withoutFences = (component: Component): Component =>
      config.hideCodeFenceMarkers ? new CodeFenceMarkerHidingComponent(component) : component;
    const nativeChildren = plan.runIndex === undefined
      ? [plan.component]
      : thinkingChildren.get(plan.runIndex) ?? [plan.component];
    const candidate = nativeChildren.length > 1
      ? new MergedThinkingComponent(nativeChildren)
      : nativeChildren[0]!;
    const collapsed = nativeChildren.every(
      (child) => child instanceof Text || constructorName(child) === "Text",
    );
    if (config.collapsedThinking === "activity" && state && run) {
      const previous = plans[position - 1];
      if (previous?.role === "text" && !isSpacerComponent(children[plan.index - 1])) {
        spacerAt.push(plan.index);
      }
      const presentationBody = thinkingRuns(message)[plan.runIndex ?? -1] ?? run;
      const markdown = new Markdown(
        presentationBody,
        0,
        0,
        getMarkdownTheme(),
        {
          color: (text) => {
            const theme = getTheme();
            try { return theme ? theme.fg("thinkingText", text) : text; }
            catch { return text; }
          },
          italic: true,
        },
      );
      const expanded = new ExpandedThinkingComponent(
        withoutFences(markdown),
        paddingX,
        getTheme,
        THINKING_BODY_INDENT,
        () => state.document.panelSnapshot().note,
        true,
        () => thinkingHandoff?.retains(state) === true ? "▴ " : "",
        true,
      );
      const compact = new ActiveThinkingComponent(
        state.startedAt,
        paddingX,
        getTheme,
        now,
        state.endedAt,
        state.current,
        () => thinkingHandoff?.retains(state) === true ? "▸ " : " ",
      );
      const isCurrent = () => thinkingHandoff?.retains(state) === true;
      const content = new RetainedThinkingComponent(
        expanded,
        compact,
        () => isCurrent() ? !thinkingHandoff?.isCollapsed(state) : !collapsed,
        isCurrent,
        () => thinkingHandoff?.toggle(state) ?? false,
        openRun,
      );
      children[plan.index] = projectedThinking(
        content,
        state,
        retainedVisibility,
      );
      continue;
    }

    // Native Pi does not separate a thinking run that follows visible text in
    // the same assistant message. Add only that missing boundary; thinking
    // runs already add their own trailing spacer when more content follows.
    const previous = plans[position - 1];
    if (previous?.role === "text" && !isSpacerComponent(children[plan.index - 1])) {
      spacerAt.push(plan.index);
    }

    if (config.collapsedThinking === "preview" && collapsed) {
      const preview = run ? buildThinkingPreview(run) : "";
      if (preview) {
        children[plan.index] = projectedThinking(
          clickable(
            new CollapsedThinkingComponent(
              preview,
              paddingX + THINKING_INDENT,
              getTheme,
            ),
            openRun,
          ),
          state,
        );
        continue;
      }
    }
    // The activity/preview branches above own their labels. This fallback can
    // still retain native Text labels, whereas expanded Markdown has none.
    if (nativeChildren.some(child => child instanceof Text || constructorName(child) === "Text")) labelIndependent = false;
    children[plan.index] = projectedThinking(
      clickable(
        collapsed
          ? new IndentedComponent(nativeChildren[0]!, THINKING_INDENT)
          : new ExpandedThinkingComponent(withoutFences(candidate), paddingX, getTheme),
        openRun,
      ),
      state,
    );
  }

  for (let position = spacerAt.length - 1; position >= 0; position--) {
    children.splice(spacerAt[position]!, 0, new Spacer(1));
  }
  const contentLimit = contentChildCount(children, message);
  const layout = new ProjectedSpacerLayout(children, contentLimit);
  for (let index = 0; index < contentLimit; index++) {
    const spacer = children[index];
    if (!isSpacerComponent(spacer)) continue;
    children[index] = new ProjectedSpacerComponent(spacer!, layout, index);
  }
  recordAssistantThinkingPresentation(instance as unknown as object, labelIndependent);
}

export function installClaudeAssistantMessages(
  pi: ExtensionAPI,
  config: AssistantMessagesConfig,
  observability?: CcStyleObservability,
  openText: TextOpener = () => false,
  typewriterClock?: TypewriterClock,
  activityTimeline?: ActivityTimelineStore,
  repeatedErrors?: RepeatedErrorCollapser,
): () => void {
  if (!config.enabled || config.style === "native" || !config.marker) {
    return () => {};
  }

  declareProbes(PROBES);
  const prototype = presentationPrototype(pi, assistantMessagePrototype<PatchablePrototype>(), "assistant");
  /**
   * `/reload` builds a fresh module instance but runs the disposer only on
   * `session_shutdown`, which it never emits — so the prototype still carries
   * the previous instance's patch. Adopt the original that instance saved and
   * install over it. Bailing out instead leaves every assistant message being
   * decorated by a module whose session, theme and click openers are gone,
   * which is indistinguishable from the feature not existing.
   */
  const previous = prototype[PATCH_STATE] as PatchState | undefined;
  if (previous?.version === 1) previous.disposeTypewriter?.();
  const original = previous?.version === 1
    ? previous.original
    : prototype.updateContent;
  let activeTheme: Theme | undefined;
  let activeUI: ExtensionUIContext | undefined;
  let activeTui: TUI | undefined;
  const clock = typewriterClock ?? THINKING_CLOCK;
  const thinkingHandoff = new ThinkingBlockHandoff();
  const typewriter = new StreamingTypewriter(
    config.typewriter,
    observability,
    typewriterClock,
    () => observability?.pressureSnapshot(),
  );
  const patched: UpdateContentFn = function claudeAssistantMessage(
    this: PatchableAssistantMessage,
    message: AssistantMessage,
    isStreaming?: boolean,
  ): void {
    const streaming = isStreaming ?? assistantPresentationState(this).isStreaming ?? false;
    const activeThinking = isActivelyThinking(message, streaming);
    const now = typewriterClock?.now() ?? Date.now();
    activityTimeline?.ensureAssistant(message, streaming, now);
    activityTimeline?.registerMessage(message, () => {
      (this as unknown as Component).invalidate?.();
      activeTui?.requestRender();
    });
    const projectedThinking = activityTimeline?.thinkingForMessage(message)?.map((state) => ({
      ...state,
      isVisible: () => activityTimeline.isThinkingVisible(state.id),
      current: () => activityTimeline.thinking(state.id),
    }));
    const thinkingStates: readonly (ThinkingRun | ThinkingChatProjection)[] =
      projectedThinking ?? syncThinkingRuns(
        this,
        message,
        activeThinking,
        now,
        typewriterClock ?? THINKING_CLOCK,
      );
    typewriter.update(this, message, streaming, (visible, visibleStreaming) => {
      const presentation = visibleStreaming
        ? withoutSpinnerHeadline(visible)
        : { message: visible, spinnerOwnsHeadline: false };
      const nativePresentation = sanitizeAssistantErrorPresentation(presentation.message);
      original.call(this, nativePresentation, visibleStreaming);
      if (retainAssistantSourceMessage(this, visible)) {
        markOk("assistant-message.lastMessage");
      } else {
        markBroken(
          "assistant-message.lastMessage",
          "AssistantMessageComponent 上没有 lastMessage 字段",
        );
      }
      try {
        const state = assistantPresentationState(this);
        const collapsedError = repeatedErrors?.presentAssistant(
          this,
          presentation.message,
          visibleStreaming,
          state.children,
          state.outputPad,
        ) ?? false;
        if (!collapsedError) {
          decorateChildren(
            this,
            presentation.message,
            config,
            () => activeTheme,
            thinkingStates,
            openText,
            () => clock.now(),
            () => activeTui?.requestRender(),
            thinkingHandoff,
            projectedThinking !== undefined,
          );
        }
        markOk("assistant-message.contentContainer");
      } catch (error) {
        // Preserve Pi's native assistant rendering if its internal child layout
        // changes in a future release — but leave a trace that it did.
        markBroken(
          "assistant-message.contentContainer",
          error instanceof Error ? error.message : String(error),
        );
      }
      activeTui?.requestRender();
    });
  };
  prototype.updateContent = patched;
  prototype[PATCH_STATE] = {
    version: 1,
    owner: PATCH_OWNER,
    original,
    patched,
    disposeTypewriter: () => typewriter.dispose(),
  } satisfies PatchState;

  const captureContext = (ctx: ExtensionContext): boolean => {
    const snapshot = snapshotExtensionContext(ctx);
    if (!snapshot) return false;
    activeTheme = snapshot.ui?.theme;
    activeUI = snapshot.ui;
    if (snapshot.mode === "tui" && snapshot.ui) {
      // The invisible pulse supplies the TUI render handle used when a new
      // Thinking block retires the previous block, even with typewriter off.
      snapshot.ui.setWidget(
        TYPEWRITER_WIDGET_KEY,
        (tui) => {
          activeTui = tui;
          return { render: () => [], invalidate: () => {} };
        },
        { placement: "aboveEditor" },
      );
    }
    return true;
  };
  pi.on("session_start", (_event, ctx) => {
    captureContext(ctx);
  });
  pi.on("resources_discover", (_event, ctx) => {
    captureContext(ctx);
    return {};
  });
  pi.on("session_info_changed", (_event, ctx) => {
    captureContext(ctx);
  });

  return () => {
    activeUI?.setWidget(TYPEWRITER_WIDGET_KEY, undefined);
    typewriter.dispose();
    thinkingHandoff.dispose();
    const state = prototype[PATCH_STATE] as PatchState | undefined;
    if (state?.owner !== PATCH_OWNER) return;
    if (prototype.updateContent === state.patched) {
      prototype.updateContent = state.original;
    }
    delete prototype[PATCH_STATE];
    activeTheme = undefined;
    activeUI = undefined;
    activeTui = undefined;
  };
}
