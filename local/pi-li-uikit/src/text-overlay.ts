import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
/**
 * Shared, selectable text views for Pi extensions.
 *
 * pi-li-uikit is source-only and is consumed by both Node strip-only tests and
 * NodeNext builds. Shared helpers therefore use package self-exports instead of
 * relative TypeScript imports, so both loaders resolve the same public path.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { createEditorOverlayMount } from "pi-li-uikit/editor-overlay";
import { panelMouseEvent, type MouseEvent } from "pi-li-uikit/panel-mouse";
import { copyToClipboard } from "pi-li-uikit/clipboard";
import { panelFooterRule } from "pi-li-uikit/panel-footer";

export { parseMouseEvents, type MouseEvent, type MouseEventKind } from "pi-li-uikit/panel-mouse";

export interface OverlayConfig {
  mouseScrollLines: number;
}



/**
 * Text-view selection: geometry, highlighting, and text extraction.
 *
 * Ported from pi-pinned-layout, which needed the same model for the transcript
 * once it took the mouse. The two cannot share a module — they are separate
 * packages with no dependency between them — but the model is the same, and so
 * are its reasons.
 *
 * Selection is stored in *body* coordinates: an index into the popup's rendered
 * body lines plus a visible column, never a screen position. That is what lets
 * a selection survive scrolling and lets a drag run past the edge of the
 * viewport and keep going.
 */
const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07|\x1b[@-Z\\-_]/g;

const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";

export interface Point {
  /** Index into the transcript's rendered content lines. */
  row: number;
  /** Visible column, zero-based. */
  col: number;
}

export interface SelectionRange {
  start: Point;
  end: Point;
}

/** pi-tui does not export its ANSI stripper, and the regex is small enough to own. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

function before(a: Point, b: Point): boolean {
  return a.row !== b.row ? a.row < b.row : a.col < b.col;
}

/** Order the two ends of a drag, so the caller never has to care which way it went. */
export function normalizeRange(anchor: Point, focus: Point): SelectionRange {
  return before(focus, anchor)
    ? { start: focus, end: anchor }
    : { start: anchor, end: focus };
}

export function isEmptyRange(range: SelectionRange): boolean {
  return range.start.row === range.end.row && range.start.col === range.end.col;
}

/**
 * The selected column span on one content row, or undefined when the row is
 * outside the selection. `end` is exclusive.
 */
export function spanForRow(
  range: SelectionRange,
  row: number,
  width: number,
): { from: number; to: number } | undefined {
  if (row < range.start.row || row > range.end.row) return undefined;
  const from = row === range.start.row ? range.start.col : 0;
  const to = row === range.end.row ? range.end.col : width;
  return to > from ? { from, to } : undefined;
}

/**
 * Reverse-video a column span of an already-rendered line.
 *
 * The span is padded to its full width so the highlight reads as a solid block
 * even past the end of the text, which is what makes a multi-row selection look
 * continuous. `sliceByColumn` replays the SGR state that was active before each
 * slice, so colours on either side survive being cut apart.
 */
export function highlightSpan(
  line: string,
  from: number,
  to: number,
  width: number,
): string {
  const clampedFrom = Math.max(0, Math.min(from, width));
  const clampedTo = Math.max(clampedFrom, Math.min(to, width));
  if (clampedTo === clampedFrom) return line;

  // Cut on grapheme edges, never through the middle of a wide character. A
  // non-strict slice emits a straddling double-width cell whole on both sides,
  // which pushes the line one column past the terminal width - fatal in pi's
  // renderer, and easy to hit by dragging across CJK text.
  const lineWidth = visibleWidth(line);
  const head = sliceByColumn(line, 0, clampedFrom, true);
  const headWidth = visibleWidth(head);
  // Only a line that ends before the span needs padding to reach it; when a wide
  // character straddles the start, the highlight snaps left onto its edge.
  const bodyStart = headWidth >= lineWidth ? clampedFrom : headWidth;
  const headPad = " ".repeat(Math.max(0, bodyStart - headWidth));

  let body = sliceByColumn(line, bodyStart, clampedTo - bodyStart);
  if (bodyStart + visibleWidth(body) > width) {
    body = sliceByColumn(line, bodyStart, clampedTo - bodyStart, true);
  }
  const bodyEnd = bodyStart + visibleWidth(body);
  const bodyPad = " ".repeat(Math.max(0, clampedTo - bodyEnd));

  const tail = sliceByColumn(line, bodyEnd, Math.max(0, width - bodyEnd), true);

  return `${head}${headPad}${REVERSE_ON}${body}${bodyPad}${REVERSE_OFF}${tail}`;
}

/**
 * The selected text as the user sees it: rendered lines, ANSI stripped, right
 * edge trimmed. Copying the rendered form rather than the source means what
 * lands on the clipboard matches what was highlighted, wrapping included —
 * which is the whole point of selecting rather than pressing `y`.
 */
export function extractText(
  content: readonly string[],
  range: SelectionRange,
  width: number,
): string {
  const lines: string[] = [];
  const lastRow = Math.min(range.end.row, content.length - 1);

  for (let row = Math.max(0, range.start.row); row <= lastRow; row++) {
    const span = spanForRow(range, row, width);
    if (!span) {
      lines.push("");
      continue;
    }
    const slice = sliceByColumn(content[row] ?? "", span.from, span.to - span.from);
    lines.push(stripAnsi(slice).replace(/\s+$/, ""));
  }

  return lines.join("\n");
}

/** Columns of blank between the frame and the ends of a divider. */
const RULE_MARGIN = 2;

/** @deprecated Editor-position TextPanel views use the editor's full width. */
export const POPUP_WIDTH_RATIO = 0.8;

/**
 * Stable vertical bounds for every rich text view. The floor stops a two-line
 * thought opening as a sliver; the ceiling keeps transcript context visible
 * behind the panel.
 */
export const POPUP_MAX_HEIGHT_RATIO = 0.75;
export const POPUP_MIN_HEIGHT_RATIO = 0.3;

/** Border, title, rule above the body; rule, footer, border below it. */
const CHROME_ROWS = 6;

/** Titled rule, one blank row, a footer spacer, and a footer rule. */
const TEXT_OVERLAY_CHROME_ROWS = 4;
/** Read-only information viewers always reserve three readable body rows when space permits. */
const TEXT_PANEL_MIN_BODY_ROWS = 3;
/** Existing TextPanel consumers share the information-panel height ceiling. */
const TEXT_PANEL_MAX_HEIGHT_RATIO = 0.7;

/** Body lines plus the offsets of the rows that act as section headers. */
export interface BodyLayout {
  lines: string[];
  headings: number[];
}

export interface ScrollOverlayOptions {
  tui: TUI;
  theme: Theme;
  overlay: OverlayConfig;
  /** Injectable clipboard adapter; defaults to the platform clipboard. */
  copy?: (text: string) => void | Promise<void>;
  /**
   * Where the caller anchors this view, which is what turns a mouse
   * report's absolute coordinates into a position inside it — for a click on a
   * row, and for telling a click outside the overlay from one inside it.
   * Editor-position views receive their exact composited origin through
   * `setScreenOrigin`; top/center remain supported for direct compatibility.
   */
  placement: { anchor: "top" | "center" | "editor"; marginX: number };
  onClose: () => void;
}

export abstract class ScrollOverlay implements Component, Focusable {
  /** CC fullscreen host uses this marker to route an outside press to the panel. */
  readonly wantsMouse = true;
  protected scrollOffset = 0;
  protected headings: number[] = [];
  /**
   * Set by ←/→ and re-derived on any manual scroll. Tracking it separately
   * matters because the final section is often shorter than the viewport, so
   * scrolling to its header clamps short of it — the derived index would then
   * report the previous section.
   */
  protected activeHeading: number | undefined;
  private _focused = true;
  /** Overlay-line offset of the first body row, and how many rows it has. */
  private bodyTop = 0;
  protected bodyHeight = 0;
  /** Last frame's size, which is what the overlay's screen position follows from. */
  private lastWidth = 0;
  private lastHeight = 0;
  /** Last frame's body length, for the scrollbar and the position readout. */
  private lastTotalLines = 0;
  /** What the last copy did, shown in the footer until the next keystroke. */
  private copyNotice: string | undefined;
  private pendingCopy: Promise<void> | undefined;
  private closed = false;
  protected availableHeight: number | undefined;
  /** Last frame's body lines and their width, for highlighting and extraction. */
  private lastBody: readonly string[] = [];
  private lastInnerWidth = 0;
  /** Where the current drag started, in body coordinates. */
  private dragAnchor: Point | undefined;
  private selection: SelectionRange | undefined;
  /**
   * Absolute origin supplied by the editor-overlay mount wrapper or a legacy
   * layout host. The structural method keeps direct component users compatible.
   */
  private screenOrigin: { row: number; column: number } | undefined;
  private readonly base: ScrollOverlayOptions;

  constructor(options: ScrollOverlayOptions) {
    this.base = options;
    // A centered/top view knows its absolute placement immediately. An
    // editor-position view waits for its mount wrapper or a legacy layout host
    // to supply the composited origin.
  }

  /** Shown in the frame's title bar, after the overlay's own name. */
  protected abstract title(): string;

  /** Drawn before the title, in the accent colour. */
  protected titleGlyph(): string | undefined {
    return undefined;
  }

  /**
   * The right-hand end of the title row: how much there is and where in it you
   * are. It belongs up here rather than in the footer, which is the one row a
   * narrow card cannot afford to fill — losing "Escape to close" off the end
   * of it is worse than losing anything else.
   */
  protected titleNote(totalLines: number): string | undefined {
    return totalLines > this.bodyHeight
      ? this.scrollRange(totalLines)
      : `${totalLines} line${totalLines === 1 ? "" : "s"}`;
  }

  /** The hint row under the body. */
  protected abstract footer(totalLines: number): string;

  protected abstract buildBody(width: number): BodyLayout;

  /** Called when a heading row is clicked or Enter/Space is pressed on it. */
  protected toggleHeading(_index: number): void {}

  protected get theme(): Theme {
    return this.base.theme;
  }

  protected get tui(): TUI {
    return this.base.tui;
  }

  protected get config(): OverlayConfig {
    return this.base.overlay;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  /** Whether a focused, still-mounted overlay may consume an input event. */
  protected get acceptsInput(): boolean {
    return this._focused && !this.closed;
  }

  /** Limit layout to the rows above the editor slot's unchanged bottom edge. */
  setAvailableHeight(rows: number): void {
    if (!Number.isFinite(rows) || rows < 1) return;
    this.availableHeight = Math.max(1, Math.floor(rows));
  }

  /** Tell this component where its first rendered cell landed on screen. */
  setScreenOrigin(row: number, column: number): void {
    if (!Number.isFinite(row) || !Number.isFinite(column)) return;
    this.screenOrigin = { row: Math.floor(row), column: Math.floor(column) };
  }

  render(width: number): string[] {
    const safeWidth = Math.max(8, width);
    const innerWidth = Math.max(1, safeWidth - 4);
    const layout = this.buildBody(innerWidth);
    this.headings = layout.headings;
    const frame = this.frameLayout(layout.lines.length);
    // Kept for click mapping: a report gives a screen row, and the body starts
    // under however many rows this overlay's chrome puts above it.
    this.bodyTop = frame.topRows;
    this.bodyHeight = frame.bodyRows;
    this.prepareViewport(layout.lines.length);
    const maxOffset = Math.max(0, layout.lines.length - frame.bodyRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const visible = this.highlighted(
      layout.lines.slice(this.scrollOffset, this.scrollOffset + frame.bodyRows),
      innerWidth,
    );
    this.lastTotalLines = layout.lines.length;
    this.lastBody = layout.lines;
    this.lastInnerWidth = innerWidth;
    const lines = this.chrome(visible, layout.lines.length, innerWidth, safeWidth);
    this.lastWidth = safeWidth;
    this.lastHeight = lines.length;
    return lines;
  }

  /**
   * How many body rows fit, and how many chrome rows sit above them.
   *
   * The card grows with its content between the floor and the ceiling: a short
   * thinking run gets the floor with blank rows under it, a tool transcript
   * hits the ceiling and scrolls.
   */
  /** Adjust the viewport after body headings and frame height are known. */
  protected prepareViewport(_totalLines: number): void {}

  protected frameLayout(totalLines: number): { bodyRows: number; topRows: number } {
    const terminalRows = this.tui.terminal.rows;
    const availableRows = Math.max(
      1,
      Math.min(terminalRows, this.availableHeight ?? terminalRows),
    );
    const desiredFloor = Math.max(
      CHROME_ROWS + 1,
      Math.floor(terminalRows * POPUP_MIN_HEIGHT_RATIO),
    );
    const floor = Math.min(availableRows, desiredFloor);
    const ceiling = Math.min(
      availableRows,
      Math.max(floor, Math.floor(terminalRows * POPUP_MAX_HEIGHT_RATIO)),
    );
    const height = Math.min(ceiling, Math.max(floor, totalLines + CHROME_ROWS));
    return { bodyRows: Math.max(1, height - CHROME_ROWS), topRows: 3 };
  }

  /**
   * The frame every rich text view wears: a muted hairline border,
   * the title on the first row *inside* it with a note on the right, an inset
   * rule under it, the body, and a second rule above a muted hint row.
   *
   * One drawing for all of them. What differs between a thinking run and a
   * tool transcript is what goes in the title, the note and the hints — not
   * the shape around them — and two shapes was one too many to keep in step.
   */
  protected chrome(
    visible: readonly string[],
    totalLines: number,
    innerWidth: number,
    safeWidth: number,
  ): string[] {
    const border = (text: string) => this.theme.fg("borderMuted", text);
    const lines: string[] = [];

    lines.push(border(`╭${"─".repeat(safeWidth - 2)}╮`));
    lines.push(this.frameRow(this.titleRow(totalLines, innerWidth), innerWidth));
    lines.push(this.ruleRow(innerWidth));

    const bar = this.scrollbar("borderMuted");
    visible.forEach((line, index) => {
      lines.push(this.frameRow(line, innerWidth, "borderMuted", bar?.(index)));
    });
    // A panel keeps its height while calls fold, so the body is padded out to
    // the rows it claimed rather than letting the frame breathe in and out.
    for (let index = visible.length; index < this.bodyHeight; index++) {
      lines.push(this.frameRow("", innerWidth));
    }

    lines.push(this.ruleRow(innerWidth));
    const copyNotice = this.copyStatus;
    const footer = copyNotice
      ? (() => {
        const notice = truncateToWidth(copyNotice, innerWidth, "…", true);
        return `${" ".repeat(Math.max(0, innerWidth - visibleWidth(notice)))}${notice}`;
      })()
      : this.footer(totalLines);
    lines.push(this.frameRow(this.theme.fg("muted", footer), innerWidth));
    lines.push(border(`╰${"─".repeat(safeWidth - 2)}╯`));
    return lines;
  }

  /** `✻ Thinking` on the left, what the note says on the right. */
  private titleRow(totalLines: number, innerWidth: number): string {
    const glyph = this.titleGlyph();
    const left = this.theme.fg(
      "accent",
      this.theme.bold(glyph ? `${glyph} ${this.title()}` : this.title()),
    );
    const note = this.titleNote(totalLines);
    if (!note) return truncateToWidth(left, innerWidth, "…");

    const right = this.theme.fg("muted", note);
    const gap = innerWidth - visibleWidth(left) - visibleWidth(right);
    if (gap < 1) return truncateToWidth(left, innerWidth, "…");
    return `${left}${" ".repeat(gap)}${right}`;
  }

  /** True while the body is taller than the rows on screen. */
  protected get scrolled(): boolean {
    return this.scrollOffset > 0;
  }

  protected scrollRange(totalLines: number): string {
    return `${this.scrollOffset + 1}-${
      Math.min(totalLines, this.scrollOffset + this.bodyHeight)
    }/${totalLines}`;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this._focused || this.closed) return undefined;
    const mouse = panelMouseEvent(event);
    if (mouse) this.handleRawMouse(mouse);
    return { handled: true, capture: event.type === "press" && event.button === "left" && !this.closed, render: true };
  }

  handleInput(data: string): void {
    if (!this._focused || this.closed) return;
    this.copyNotice = undefined;
    this.selection = undefined;
    const page = this.inputPageSize();
    const half = Math.max(1, Math.floor(page / 2));
    // Vi motions alongside the arrows: these popups are for reading, and
    // reading is where the muscle memory is.
    if (matchesKey(data, "j")) {
      this.scrollOffset++;
      this.activeHeading = undefined;
    } else if (matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.activeHeading = undefined;
    } else if (matchesKey(data, "ctrl+d")) {
      this.scrollOffset += half;
      this.activeHeading = undefined;
    } else if (matchesKey(data, "ctrl+u")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - half);
      this.activeHeading = undefined;
    } else if (matchesKey(data, "ctrl+f")) {
      this.scrollOffset += page;
      this.activeHeading = undefined;
    } else if (matchesKey(data, "ctrl+b")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - page);
      this.activeHeading = undefined;
    } else if (matchesKey(data, "g")) {
      // `g` rather than `gg`: there is nothing else `g` could start here, and
      // waiting for a second key would only add a way to get it wrong.
      this.scrollOffset = 0;
      this.activeHeading = undefined;
    } else if (matchesKey(data, "shift+g")) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.activeHeading = undefined;
    } else if (matchesKey(data, "y") || matchesKey(data, "c")) {
      this.copyBody();
      this.base.tui.requestRender();
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.close();
    } else if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.activeHeading = undefined;
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset++;
      this.activeHeading = undefined;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - page);
      this.activeHeading = undefined;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += page;
      this.activeHeading = undefined;
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.activeHeading = undefined;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.activeHeading = undefined;
    } else if (matchesKey(data, Key.left)) {
      this.jumpToHeading(-1);
    } else if (matchesKey(data, Key.right)) {
      this.jumpToHeading(1);
    } else if (matchesKey(data, Key.enter)) {
      if (this.headings.length > 0) this.toggleHeading(this.currentHeadingIndex());
      else this.close();
    } else if (matchesKey(data, Key.space)) {
      if (this.headings.length > 0) this.toggleHeading(this.currentHeadingIndex());
    }
    this.base.tui.requestRender();
  }

  invalidate(): void {}

  /** Page size before and after the first render; subclasses can make it stable. */
  protected inputPageSize(): number {
    return Math.max(1, this.bodyHeight || this.base.tui.terminal.rows - 8);
  }

  dispose(): void {
  }

  /** Lets hosts and tests await an asynchronous clipboard adapter. */
  async waitForPending(): Promise<void> {
    await this.pendingCopy;
  }

  /**
   * Reverse-video the selected span of each visible row. Highlighting the
   * windowed copy leaves the body itself untouched, so nothing has to be
   * rebuilt when the selection changes or goes away.
   */
  private highlighted(
    visible: readonly string[],
    innerWidth: number,
  ): string[] {
    const selection = this.selection;
    if (!selection) return [...visible];
    return visible.map((line, index) => {
      const span = spanForRow(selection, this.scrollOffset + index, innerWidth);
      return span ? highlightSpan(line, span.from, span.to, innerWidth) : line;
    });
  }

  /** Body coordinates for a screen position, or undefined when it is chrome. */
  private bodyPoint(row: number, column: number): Point | undefined {
    const bodyRow = row - this.screenRow() - this.bodyTop;
    if (bodyRow < 0 || bodyRow >= this.bodyHeight) return undefined;
    // Both silhouettes reserve two columns before content: border + space in
    // the shared frame, or two spaces in TextPanel's open frame.
    const col = column - this.screenColumn() - 2;
    return {
      row: this.scrollOffset + bodyRow,
      col: Math.max(0, Math.min(col, this.lastInnerWidth)),
    };
  }

  private copySelection(): void {
    const selection = this.selection;
    if (!selection) return;
    const text = extractText(this.lastBody, selection, this.lastInnerWidth);
    if (text.trim().length === 0) {
      this.selection = undefined;
      return;
    }
    this.startCopy(text);
  }

  private handleRawMouse(event: MouseEvent): void {
    if (event.kind === "wheel") {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset + event.wheel * this.base.overlay.mouseScrollLines,
      );
      this.activeHeading = undefined;
      return;
    }
    if (event.kind === "release") {
      if (this.dragAnchor === undefined) return;
      const anchor = this.dragAnchor;
      this.dragAnchor = undefined;
      if (this.selection && !isEmptyRange(this.selection)) {
        this.copySelection();
        return;
      }
      // Pressed and released without dragging: that is a click, and folding is
      // decided here rather than on the press so a drag that starts on a
      // header bar still selects instead of folding.
      this.selection = undefined;
      const heading = this.headingAtBodyRow(anchor.row);
      if (heading !== undefined) this.toggleHeading(heading);
      return;
    }

    if (event.button !== 0) return; // only the left button drives selection

    if (event.kind === "press") {
      if (this.outside(event.row, event.col)) {
        this.close();
        return;
      }
      this.copyNotice = undefined;
      this.selection = undefined;
      this.dragAnchor = this.bodyPoint(event.row, event.col);
      return;
    }

    // kind === "drag"
    const anchor = this.dragAnchor;
    if (anchor === undefined) return;
    // Dragging past an edge keeps the body moving, so a selection can run
    // beyond a screenful.
    const top = this.screenRow() + this.bodyTop;
    if (event.row < top) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (event.row >= top + this.bodyHeight) this.scrollOffset++;
    const focus = this.bodyPoint(
      Math.max(top, Math.min(event.row, top + this.bodyHeight - 1)),
      event.col,
    );
    if (focus) this.selection = normalizeRange(anchor, focus);
  }

  /** The section whose heading is on a body row, if that row is one. */
  private headingAtBodyRow(row: number): number | undefined {
    const heading = this.headings.indexOf(row);
    return heading === -1 ? undefined : heading;
  }

  /**
   * Screen row this overlay's first line lands on. pi-tui centres an overlay
   * against the terminal, so it depends on how tall the overlay turned out —
   * which is only known once it has been drawn.
   */
  private screenRow(): number {
    if (this.screenOrigin) return this.screenOrigin.row;
    if (this.base.placement.anchor === "top") return 0;
    const rows = this.base.tui.terminal.rows;
    if (!Number.isFinite(rows) || this.lastHeight === 0) return 0;
    // Editor-position mounts supply their actual composited origin.
    if (this.base.placement.anchor === "editor") return 0;
    return Math.max(0, Math.floor((rows - this.lastHeight) / 2));
  }

  private screenColumn(): number {
    if (this.screenOrigin) return this.screenOrigin.column;
    if (this.base.placement.anchor === "editor") return 0;
    const columns = this.base.tui.terminal.columns;
    if (!Number.isFinite(columns) || this.lastWidth === 0) return 0;
    const margin = this.base.placement.marginX;
    return margin +
      Math.max(0, Math.floor((columns - margin * 2 - this.lastWidth) / 2));
  }

  /**
   * Whether a click landed off the overlay entirely. Every report reaches the
   * focused overlay, wherever it was aimed, so this is what makes clicking the
   * screen around a popup dismiss it.
   */
  private outside(row: number, column: number): boolean {
    if (this.lastHeight === 0 || this.lastWidth === 0) return false;
    const top = this.screenRow();
    if (row < top || row >= top + this.lastHeight) return true;
    const left = this.screenColumn();
    // A terminal that does not report its width leaves only the rows to go on;
    // closing on a horizontal miss would then be a guess.
    if (!Number.isFinite(this.base.tui.terminal.columns)) return false;
    return column < left || column >= left + this.lastWidth;
  }

  /**
   * Body rows the scrollbar thumb covers. The thumb is at least one row, and
   * reaches the last row only when the body is scrolled to its end, so "nearly
   * at the bottom" never reads as "at the bottom".
   */
  protected thumbRows(): { from: number; to: number } | undefined {
    const total = this.lastTotalLines;
    const rows = this.bodyHeight;
    if (total <= rows || rows <= 0) return undefined;
    const size = Math.max(1, Math.round((rows * rows) / total));
    const span = rows - size;
    const maxOffset = total - rows;
    const from = maxOffset <= 0
      ? 0
      : Math.round((this.scrollOffset / maxOffset) * span);
    return { from, to: from + size - 1 };
  }

  /** Index of the section whose heading is at or above the viewport top. */
  private scrolledHeadingIndex(): number {
    let index = 0;
    for (let position = 0; position < this.headings.length; position++) {
      if (this.headings[position]! <= this.scrollOffset) index = position;
      else break;
    }
    return index;
  }

  protected currentHeadingIndex(): number {
    return this.activeHeading ?? this.scrolledHeadingIndex();
  }

  private jumpToHeading(direction: -1 | 1): void {
    if (this.headings.length === 0) return;
    const current = this.currentHeadingIndex();
    // Stepping back from mid-section returns to the top of that section first,
    // which is what re-reading a long result wants.
    //
    // "At the top" has to mean the row the scroll can actually reach: the last
    // sections of a body barely taller than the viewport all clamp to the same
    // offset, and comparing against their raw rows would never register as
    // arrival — so stepping back would re-land on the section it started from,
    // and the left arrow would do nothing at all.
    const maxOffset = Math.max(0, this.lastTotalLines - this.bodyHeight);
    const reachable = Math.min(this.headings[current] ?? 0, maxOffset);
    const atHeading = this.scrollOffset <= reachable;
    const target = direction === 1
      ? current + 1
      : atHeading
        ? current - 1
        : current;
    const clamped = Math.max(0, Math.min(this.headings.length - 1, target));
    this.activeHeading = clamped;
    this.scrollOffset = this.headings[clamped]!;
  }

  protected frameRow(
    line: string,
    width: number,
    color: "border" | "borderMuted" = "borderMuted",
    rightEdge?: string,
  ): string {
    const content = truncateToWidth(line, width, "…", true);
    const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
    const side = (text: string) => this.base.theme.fg(color, text);
    return `${side("│ ")}${content}${padding} ${rightEdge ?? side("│")}`;
  }

  /**
   * The text this view would put on the clipboard. Subclasses that show
   * something other than plain prose override it; returning nothing disables
   * copying for that view.
   */
  protected copyText(): string | undefined {
    return undefined;
  }

  /** Footer note about the last copy, for a chrome that wants to show it. */
  protected get copyStatus(): string | undefined {
    return this.copyNotice;
  }

  /**
   * Copy the whole body. Selecting part of it would mean owning a selection
   * model on top of the mouse we already hold, and a thinking run or a tool
   * result is nearly always wanted whole.
   */
  private copyBody(): void {
    const text = this.copyText();
    if (text === undefined || text.trim().length === 0) {
      this.copyNotice = "Nothing to copy";
      return;
    }
    this.startCopy(text);
  }

  private startCopy(text: string): void {
    this.copyNotice = `Copied ${Array.from(text).length} chars to clipboard`;
    this.pendingCopy = Promise.resolve()
      .then(() => (this.base.copy ?? copyToClipboard)(text))
      .catch(() => {
        if (!this.closed) this.copyNotice = "Copy failed";
      })
      .finally(() => {
        if (!this.closed) this.base.tui.requestRender();
      });
  }

  /**
   * A divider between a popup's bars and its body, stopping short of the frame
   * on both sides: a rule that runs into the border reads as another edge,
   * while an inset one reads as a separation.
   *
   * It is drawn in `borderMuted`, which is the faintest tone themes give a
   * border — fainter than `border`, and fainter than `dim`, which despite the
   * name is a *text* tone and lands brighter than either. A separator that
   * outshines the frame around it reads as structure rather than as a seam.
   */
  protected ruleRow(
    innerWidth: number,
    color: "border" | "borderMuted" = "borderMuted",
  ): string {
    // frameRow already lays one column of padding inside the border, so the
    // rule only has to inset by the rest of the margin.
    const inset = Math.max(0, RULE_MARGIN - 1);
    const span = Math.max(0, innerWidth - inset * 2);
    const rule = `${" ".repeat(inset)}${"─".repeat(span)}${" ".repeat(inset)}`;
    return this.frameRow(this.base.theme.fg("borderMuted", rule), innerWidth, color);
  }

  /**
   * The scrollbar rides the right border column rather than taking one of its
   * own, so turning it on costs no width and a body that fits shows nothing at
   * all. Returns undefined when there is nothing to scroll.
   */
  protected scrollbar(
    color: "border" | "borderMuted",
  ): ((bodyRow: number) => string) | undefined {
    const thumb = this.thumbRows();
    if (!thumb) return undefined;
    const track = this.base.theme.fg(color, "│");
    const grip = this.base.theme.fg("muted", "█");
    return (bodyRow: number) =>
      bodyRow >= thumb.from && bodyRow <= thumb.to ? grip : track;
  }

  protected close(): void {
    if (this.closed) return;
    this.closed = true;
    this.base.onClose();
  }
}

export interface TextPanelUpdate {
  heading: string;
  body: string;
  /** Optional right-hand title metadata; omit to keep the default line-count note. */
  note?: string;
  glyph?: string;
  tone?: "muted" | "thinkingText" | "text";
  format?: "markdown" | "plain";
  maxVisible?: number;
  renderBody?: (width: number, theme: Theme) => string[];
}

export interface TextPanelOptions extends ScrollOverlayOptions, TextPanelUpdate {
  /** Runs once after the first frame has been laid out. */
  onFirstRender?: () => void;
  body: string;
  /** Drawn before the heading, in the accent colour. */
  glyph?: string;
  /** Colour the body is drawn in; defaults to Pi's normal conversation text. */
  tone?: "muted" | "thinkingText" | "text";
  /**
   * `markdown` (default) renders the body the way expanded thinking is
   * rendered. `plain` keeps it verbatim — command output has fences, hashes,
   * and asterisks in it that are output, not formatting, and a log rendered as
   * Markdown loses its shape.
   */
  format?: "markdown" | "plain";
  /** Optional body-row cap; otherwise the view uses its proportional height policy. */
  maxVisible?: number;
  /**
   * Draw the body with a component instead of from `body`.
   *
   * A row that summarises something Pi already knows how to draw — a tool
   * result, with the tool's own layout and colours — has no reason to hand
   * the popup a flattened string and lose all of that. It renders itself at
   * the width the view offers, and `body` stays behind as the text to copy.
   */
  renderBody?: (width: number, theme: Theme) => string[];
}

/** The single read-only document viewer used by every editor-position panel. */
export class TextPanel extends ScrollOverlay {
  private heading: string;
  private body: string;
  private note: string | undefined;
  private glyph: string;
  private tone: "muted" | "thinkingText" | "text";
  private format: "markdown" | "plain";
  private maxVisible: number | undefined;
  private renderBody:
    | ((width: number, theme: Theme) => string[])
    | undefined;
  private cache: { width: number; lines: string[] } | undefined;
  private onFirstRender: (() => void) | undefined;

  constructor(options: TextPanelOptions) {
    super(options);
    this.heading = options.heading;
    this.body = options.body;
    this.note = options.note;
    this.glyph = options.glyph ?? "✻";
    this.tone = options.tone ?? "text";
    this.format = options.format ?? "markdown";
    this.maxVisible = options.maxVisible;
    this.renderBody = options.renderBody;
    this.onFirstRender = options.onFirstRender;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const onFirstRender = this.onFirstRender;
    this.onFirstRender = undefined;
    if (onFirstRender) queueMicrotask(onFirstRender);
    return lines;
  }

  /** Replace a mounted panel's document while preserving its UI lifecycle. */
  update(content: TextPanelUpdate): void {
    this.heading = content.heading;
    this.body = content.body;
    this.note = content.note;
    this.glyph = content.glyph ?? "✻";
    this.tone = content.tone ?? "text";
    this.format = content.format ?? "markdown";
    this.maxVisible = content.maxVisible;
    this.renderBody = content.renderBody;
    this.cache = undefined;
    this.tui.requestRender();
  }

  protected title(): string {
    return this.heading;
  }

  protected override titleNote(totalLines: number): string | undefined {
    return this.note ?? super.titleNote(totalLines);
  }

  /**
   * TextPanel uses the same open editor-position silhouette as the other UIKit
   * panels: a titled rule, breathing room, body, and a footer rule. The richer
   * ScrollOverlay frame remains available to transcript subclasses.
   */
  protected override frameLayout(totalLines: number): { bodyRows: number; topRows: number } {
    const terminalRows = this.tui.terminal.rows;
    const availableRows = Math.max(
      1,
      Math.min(terminalRows, this.availableHeight ?? terminalRows),
    );
    const maximumRows = Math.max(
      1,
      Math.min(availableRows, Math.floor(terminalRows * TEXT_PANEL_MAX_HEIGHT_RATIO)),
    );
    const maximumBodyRows = Math.max(1, maximumRows - TEXT_OVERLAY_CHROME_ROWS);
    const requestedBodyRows = this.maxVisible === undefined
      ? Math.max(TEXT_PANEL_MIN_BODY_ROWS, totalLines)
      : Math.max(
        TEXT_PANEL_MIN_BODY_ROWS,
        Math.min(totalLines, Math.max(TEXT_PANEL_MIN_BODY_ROWS, this.maxVisible)),
      );
    return {
      bodyRows: Math.min(maximumBodyRows, requestedBodyRows),
      topRows: 2,
    };
  }

  protected override inputPageSize(): number {
    return this.bodyHeight > 0
      ? this.bodyHeight
      : this.maxVisible === undefined
        ? super.inputPageSize()
        : Math.max(1, this.maxVisible);
  }

  protected override chrome(
    visible: readonly string[],
    totalLines: number,
    innerWidth: number,
    safeWidth: number,
  ): string[] {
    const lines = [
      this.titleRule(totalLines, safeWidth),
      " ".repeat(safeWidth),
    ];
    const thumb = this.thumbRows();
    visible.forEach((line, index) => {
      const grip = thumb && index >= thumb.from && index <= thumb.to
        ? this.theme.fg("muted", "█")
        : undefined;
      lines.push(this.openBodyRow(line, innerWidth, grip));
    });
    // Keep the editor replacement at a stable height while content changes.
    for (let index = visible.length; index < this.bodyHeight; index++) {
      lines.push(this.openBodyRow("", innerWidth));
    }
    lines.push(" ".repeat(safeWidth));
    lines.push(this.footerRule(totalLines, safeWidth));
    return lines;
  }

  /** The source text, not the rendered lines: wrapping is this popup's, not the reader's. */
  protected copyText(): string {
    return stripAnsi(this.body);
  }

  protected buildBody(width: number): BodyLayout {
    const cached = this.cache;
    if (cached && cached.width === width) {
      return { lines: cached.lines, headings: [] };
    }
    const lines = this.renderWithComponent(width) ??
      (this.body.length === 0
        ? ["(empty)"]
        : this.format === "plain"
          ? this.renderPlain(width)
          : renderPanelMarkdown(this.body, width, this.theme, this.tone) ?? this.renderPlain(width));
    this.cache = { width, lines };
    return { lines, headings: [] };
  }

  /**
   * The body drawn by the component the caller supplied, or undefined when
   * there is none - or when it fails, which must not cost the popup its
   * content: the text is still there to fall back on.
   */
  private renderWithComponent(width: number): string[] | undefined {
    if (!this.renderBody) return undefined;
    try {
      const lines = this.renderBody(Math.max(1, width), this.theme);
      return lines.length > 0 ? lines : undefined;
    } catch {
      return undefined;
    }
  }

  /** Paragraph-at-a-time wrapping, so blank lines survive as blank lines. */
  private renderPlain(width: number): string[] {
    return this.body.split("\n").flatMap((paragraph) =>
      paragraph.trim().length === 0
        ? [""]
        : wrapTextWithAnsi(this.style(paragraph), Math.max(1, width))
    );
  }

  protected titleGlyph(): string {
    return this.glyph;
  }

  protected footer(_totalLines: number): string {
    return `${this.copyStatus ?? "y copy"} · Enter/Esc close`;
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
      this.tui.requestRender();
      return;
    }
    super.handleInput(data);
  }

  /** Theme-coloured `── title ───── note` with the title inside the rule. */
  private titleRule(totalLines: number, width: number): string {
    const accent = (text: string) => this.theme.fg("accent", text);
    const glyph = this.titleGlyph();
    const title = glyph ? `${glyph} ${this.title()}` : this.title();
    let note = this.titleNote(totalLines);
    let noteLabel = note ? ` ${note}` : "";
    const prefixWidth = 2;
    const minimumFill = 2;
    if (width - prefixWidth - visibleWidth(noteLabel) - minimumFill < 1) {
      note = undefined;
      noteLabel = "";
    }
    const titleBudget = Math.max(
      1,
      width - prefixWidth - visibleWidth(noteLabel) - minimumFill,
    );
    const titleLabel = truncateToWidth(` ${title} `, titleBudget, "…");
    const fill = "─".repeat(Math.max(
      0,
      width - prefixWidth - visibleWidth(titleLabel) - visibleWidth(noteLabel),
    ));
    return `${accent("──")}${accent(this.theme.bold(titleLabel))}${accent(fill)}${
      note ? this.theme.fg("muted", noteLabel) : ""
    }`;
  }

  /** Footer text is woven into its separator, matching editor-position panels. */
  private footerRule(totalLines: number, width: number): string {
    const primary = this.footer(totalLines);
    const hints = [
      `↑↓/jk scroll · PgUp/PgDn page · g/G top/bottom · ${primary}`,
      `↑↓/jk scroll · g/G top/bottom · ${primary}`,
      `g/G top/bottom · ${primary}`,
      primary,
      ...(this.copyStatus ? [this.copyStatus] : []),
      "Esc close",
    ];
    return panelFooterRule(this.theme, width, hints);
  }

  /** Preserve the old two-column body inset while dropping both vertical bars. */
  private openBodyRow(line: string, width: number, rightEdge?: string): string {
    const content = truncateToWidth(line, width, "…", true);
    const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
    return `  ${content}${padding} ${rightEdge ?? " "}`;
  }

  /**
   * Prose is italicised the way inline thinking is. Verbatim text is not:
   * italics on a log make it harder to read, and the text may already carry
   * colour of its own.
   */
  private style(text: string): string {
    try {
      const coloured = this.theme.fg(this.tone, text);
      return this.format === "plain" ? coloured : this.theme.italic(coloured);
    } catch {
      return text;
    }
  }
}

/** @deprecated Use `TextPanelOptions`; retained for source compatibility. */
export type TextOverlayOptions = TextPanelOptions;

/** @deprecated Use `TextPanel`; retained for source compatibility. */
export class TextOverlay extends TextPanel {}

/**
 * A Markdown theme that renders every element in one tone.
 *
 * `bold` and `underline` are the renderer's own hooks for heading emphasis —
 * a level-1 heading is drawn as `heading(bold(underline(text)))` — so
 * overriding them here is what keeps an accidental heading from being
 * underlined at all.
 */
function thinkingMarkdownTheme(
  theme: Theme,
  tone: "muted" | "thinkingText" | "text",
): ConstructorParameters<typeof Markdown>[3] {
  const toned = (text: string) => {
    try {
      return theme.fg(tone, text);
    } catch {
      return text;
    }
  };
  const emphasised = (text: string) => {
    try {
      return theme.bold(toned(text));
    } catch {
      return toned(text);
    }
  };
  const plain = (text: string) => text;
  return {
    // The renderer already wraps a heading's text in `bold`, so this only has
    // to carry the tone — emphasising here too would double the escape codes.
    heading: toned,
    bold: emphasised,
    // Italic is left to the renderer's default text style, which already
    // italicises the whole body; re-applying it per span would nest codes.
    italic: plain,
    underline: plain,
    strikethrough: plain,
    link: toned,
    linkUrl: toned,
    code: toned,
    codeBlock: toned,
    codeBlockBorder: toned,
    quote: toned,
    quoteBorder: toned,
    hr: toned,
    listBullet: toned,
  };
}

/** Render Markdown with the same toned grammar used by TextPanel. */
export function renderPanelMarkdown(
  body: string,
  width: number,
  theme: Theme,
  tone: "muted" | "thinkingText" | "text" = "text",
): string[] | undefined {
  try {
    const markdown = new Markdown(
      body,
      0,
      0,
      thinkingMarkdownTheme(theme, tone),
      { color: (text) => theme.fg(tone, text), italic: true },
    );
    const lines = markdown.render(Math.max(1, width));
    return lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

export interface TextPanelContent {
  title: string;
  body: string;
  format?: "markdown" | "plain";
  tone?: "muted" | "thinkingText" | "text";
  glyph?: string;
  maxVisible?: number;
  renderBody?: (width: number, theme: Theme) => string[];
}

export interface ShowTextPanelOptions {
  onCreate?: (panel: TextPanel) => void;
  onFirstRender?: () => void;
}

/** The public helper needs only this UI surface, not Pi's nominal session types. */
export interface TextPanelContext {
  mode?: string;
  hasUI: boolean;
  ui: {
    custom<T>(factory: (...args: any[]) => any, options?: unknown): Promise<T>;
  };
}

export interface TextPanelComponentHost {
  tui: TUI;
  theme: Theme;
  placement: { anchor: "editor"; marginX: 0 };
  onClose: () => void;
}

/**
 * Float a TextPanel-family component over Pi's editor position.
 *
 * The editor and transcript stay mounted underneath. The overlay keeps the
 * editor slot's full width and bottom edge, then grows upward over the message
 * flow instead of reserving layout rows.
 */
export async function showTextPanelComponent(
  ctx: Pick<TextPanelContext, "ui">,
  create: (host: TextPanelComponentHost) => Component,
): Promise<void> {
  const overlay = createEditorOverlayMount();
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
    overlay.mount(tui, create({
      tui,
      theme,
      placement: { anchor: "editor", marginX: 0 },
      onClose: done,
    })), overlay.customOptions
  );
}

function panelUpdate(content: TextPanelContent): TextPanelUpdate {
  return {
    heading: content.title,
    body: content.body,
    tone: content.tone ?? "text",
    format: content.format ?? "plain",
    glyph: content.glyph,
    maxVisible: content.maxVisible,
    renderBody: content.renderBody,
  };
}

export async function showTextPanel(
  ctx: TextPanelContext,
  content: TextPanelContent,
  options: ShowTextPanelOptions = {},
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  await showTextPanelComponent(ctx, (host) => {
    const panel = new TextPanel({
      ...host,
      ...panelUpdate(content),
      overlay: { mouseScrollLines: 3 },
      onFirstRender: options.onFirstRender,
    });
    options.onCreate?.(panel);
    return panel;
  });
}
