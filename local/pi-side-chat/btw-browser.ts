import type { Usage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  InformationPanel,
  renderKeyValue,
  showInformationPanelComponent,
  type InformationPanelContext,
  type InformationPanelController,
  type InformationPanelMouseEvent,
  type InformationPanelView,
} from "pi-li-uikit/information-panel";
import { renderPanelMarkdown } from "pi-li-uikit/text-panel";
import {
  btwAnswerKey, btwIsPending, displayText,
  type BtwBrowserUpdates, type BtwEntry, type BtwReadState,
} from "./btw.ts";
import { observeCache } from "./cache-observation.ts";

/**
 * At or above this render width the browser shows the question list and the
 * selected answer side by side. Below it the two become separate pages, so a
 * narrow terminal keeps one readable column instead of two cramped ones.
 *
 * The width measured is the one the panel was actually given, not the process
 * stdout width: a pinned layout or a shell split can hand the editor slot far
 * less than the terminal has.
 */
export const BTW_BROWSER_WIDE_MIN_WIDTH = 96;
/** The question column never gets narrower than this. */
export const BTW_BROWSER_LIST_MIN_WIDTH = 24;
/** Nor wider: past this the answer needs the space more than the titles do. */
export const BTW_BROWSER_LIST_MAX_WIDTH = 36;
/** The ` │ ` rule between the two columns. */
export const BTW_BROWSER_SEPARATOR_WIDTH = 3;
/** The unread mark, shown until the answer's body has actually been drawn. */
export const BTW_UNREAD_MARK = "●";
/** `→ ` plus `● `: both list columns keep their width whatever they hold. */
export const BTW_LIST_PREFIX_WIDTH = 4;
/** How far one wheel notch moves a list or an answer. */
const WHEEL_LINES = 3;
/** The question stays readable in a breadcrumb without pushing the path out. */
const BREADCRUMB_QUESTION_WIDTH = 40;

export { btwAnswerKey };

export type BtwBrowserLayout = "wide" | "narrow";
type Region = "list" | "detail";

export function btwBrowserLayout(width: number): BtwBrowserLayout {
  return width >= BTW_BROWSER_WIDE_MIN_WIDTH ? "wide" : "narrow";
}

export function btwListColumnWidth(width: number): number {
  const proportional = Math.floor(Math.max(0, width) * 0.3);
  return Math.min(BTW_BROWSER_LIST_MAX_WIDTH, Math.max(BTW_BROWSER_LIST_MIN_WIDTH, proportional));
}

export function btwAnswerColumnWidth(width: number): number {
  return Math.max(1, width - btwListColumnWidth(width) - BTW_BROWSER_SEPARATOR_WIDTH);
}

function tokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function cacheLabel(usage: Usage): string {
  const observed = observeCache(usage);
  if (observed.status === "unknown") return "cache unknown";
  return observed.status === "hit"
    ? `cache hit ${tokens(observed.cacheRead)}/${tokens(observed.promptTokens)}`
    : `cache miss 0/${tokens(observed.promptTokens)}`;
}

/** One line of question text for the list column and the breadcrumb. */
export function btwQuestionLabel(question: string): string {
  return displayText(question).replace(/\s+/gu, " ").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(Math.floor(value), maximum));
}

/** Pad or truncate one already-themed line to an exact column width. */
function fitColumn(line: string, width: number): string {
  const visible = visibleWidth(line);
  if (visible === width) return line;
  if (visible > width) return truncateToWidth(line, width, "…");
  return `${line}${" ".repeat(width - visible)}`;
}

/**
 * Wrap plain text to a width, preferring a space and otherwise breaking between
 * characters. Chinese questions have no spaces to break on, so a word-only wrap
 * would run a single long line past the column.
 */
export function wrapPlainText(text: string, width: number): string[] {
  const safe = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let lineWidth = 0;
    let breakAt = -1;
    for (const character of paragraph) {
      const characterWidth = Math.max(1, visibleWidth(character));
      if (line.length > 0 && lineWidth + characterWidth > safe) {
        if (breakAt > 0) {
          lines.push(line.slice(0, breakAt).trimEnd());
          line = line.slice(breakAt);
        } else {
          lines.push(line);
          line = "";
        }
        lineWidth = visibleWidth(line);
        breakAt = -1;
      }
      line += character;
      lineWidth += characterWidth;
      if (character === " ") breakAt = line.length;
    }
    lines.push(line);
  }
  return lines;
}

export interface BtwBrowserOptions {
  theme: Theme;
  /** Read live, so an answer that lands while the browser is open shows up. */
  history(): readonly BtwEntry[];
  /** Where the unread marks come from, and where a drawn answer is reported. */
  read: BtwReadState;
}

/**
 * The `/btw` answer browser's whole view and navigation state.
 *
 * It renders into the row budget the information-panel shell hands it, which is
 * what lets the wide layout put an independently scrolling answer beside the
 * question list: the shell scrolls one body, and a two-column body has two.
 */
export class BtwBrowser {
  private readonly theme: Theme;
  private readonly readHistory: () => readonly BtwEntry[];
  private readonly read: BtwReadState;
  private readonly offsets = new Map<string, number>();
  private readonly rendered = new Map<string, { entry: BtwEntry; width: number; lines: readonly string[] }>();
  private selectedKey: string | undefined;
  /** Which column has the keys in the wide layout. */
  private focus: Region = "list";
  /** Which page is showing in the narrow layout. */
  private page: Region = "list";
  private layout: BtwBrowserLayout = "wide";
  private layoutKnown = false;
  private listOffset = 0;
  private width = 0;
  private bodyRows = 1;
  private detailRows = 1;
  private detailLines = 0;

  constructor(options: BtwBrowserOptions) {
    this.theme = options.theme;
    this.readHistory = options.history;
    this.read = options.read;
  }

  /**
   * The shell reads `title` and `footerHints` after `renderBody`, so both are
   * getters: a resize settles the layout during the body pass and the frame
   * still describes the layout it just drew.
   */
  view(): InformationPanelView {
    const browser = this;
    return {
      get title() { return browser.title(); },
      get breadcrumbs() { return browser.breadcrumbs(); },
      contentKey: "btw-browser",
      fillsBody: true,
      renderBody: (width, bodyRows) => browser.renderBody(width, bodyRows),
      get footerHints() { return browser.footerHints(); },
    };
  }

  /** Newest first, so the freshest answer is the one already selected. */
  entries(): readonly BtwEntry[] {
    return [...this.readHistory()].reverse();
  }

  currentLayout(): BtwBrowserLayout {
    return this.layout;
  }

  currentPage(): Region {
    return this.page;
  }

  currentFocus(): Region {
    return this.focus;
  }

  selectedQuestion(): string | undefined {
    const entries = this.entries();
    return entries[this.selectedIndex(entries)]?.question;
  }

  /** The reading position of the selected answer, in body rows. */
  answerOffset(): number {
    const key = this.currentKey();
    return key ? this.offsets.get(key) ?? 0 : 0;
  }

  renderBody(width: number, bodyRows: number): readonly string[] {
    this.width = Math.max(1, Math.floor(width));
    this.bodyRows = Math.max(1, Math.floor(bodyRows));
    const layout = btwBrowserLayout(this.width);
    if (this.layoutKnown && layout !== this.layout) {
      // A resize keeps the selection and lands on the page matching the region
      // the user was already in, so the answer being read stays on screen.
      if (layout === "narrow") this.page = this.focus;
      else this.focus = this.page;
    }
    this.layout = layout;
    this.layoutKnown = true;

    const entries = this.entries();
    if (entries.length === 0) {
      this.detailLines = 0;
      this.detailRows = this.bodyRows;
      return [this.theme.fg("muted", "No BTW answers in this session")];
    }

    const index = this.selectedIndex(entries);
    const selected = entries[index]!;
    if (layout === "narrow") {
      // Selecting a question in the narrow list shows nothing of its answer, so
      // only the answer page counts as having read it.
      if (this.page !== "detail") return this.listWindow(entries, index, this.width, this.bodyRows);
      if (!btwIsPending(selected)) this.read.markRead(selected);
      return this.detailWindow(selected, this.width, this.bodyRows);
    }

    // The wide layout always draws the selected answer beside the list, so
    // reaching here is reading it, however the selection got here.
    if (!btwIsPending(selected)) this.read.markRead(selected);
    const listWidth = btwListColumnWidth(this.width);
    const answerWidth = btwAnswerColumnWidth(this.width);
    const list = this.listWindow(entries, index, listWidth, this.bodyRows);
    const detail = this.detailWindow(selected, answerWidth, this.bodyRows);
    const separator = this.theme.fg("borderMuted", " │ ");
    return list.map((line, row) => `${fitColumn(line, listWidth)}${separator}${detail[row] ?? ""}`);
  }

  /** Returns true when the browser consumed the key itself. */
  handleKey(data: string): boolean {
    const entries = this.entries();
    if (entries.length === 0) return false;

    if (this.layout === "narrow") {
      if (this.page === "detail") {
        // Esc steps back to the list here; the shell only closes from the list.
        if (matchesKey(data, Key.escape)) {
          this.page = "list";
          this.focus = "list";
          return true;
        }
        return this.scrollDetailKey(data);
      }
      if (matchesKey(data, Key.enter)) {
        this.page = "detail";
        this.focus = "detail";
        return true;
      }
      return this.selectKey(data, entries);
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.focus = this.focus === "list" ? "detail" : "list";
      return true;
    }
    if (matchesKey(data, Key.right)) {
      this.focus = "detail";
      return true;
    }
    if (matchesKey(data, Key.left)) {
      this.focus = "list";
      return true;
    }
    return this.focus === "detail" ? this.scrollDetailKey(data) : this.selectKey(data, entries);
  }

  /** Returns true when the browser consumed the mouse report itself. */
  handleMouse(event: InformationPanelMouseEvent, controller: InformationPanelController): boolean {
    const entries = this.entries();
    if (entries.length === 0) return false;
    const point = controller.bodyPointAt(event.row, event.col);
    if (!point) return false;
    const onList = this.layout === "narrow"
      ? this.page === "list"
      : point.column < btwListColumnWidth(this.width);

    if (event.kind === "wheel") {
      if (onList) {
        this.listOffset = clamp(
          this.listOffset + event.wheel * WHEEL_LINES,
          0,
          Math.max(0, entries.length - this.bodyRows),
        );
      } else {
        this.scrollDetail(event.wheel * WHEEL_LINES);
      }
      return true;
    }
    if (event.kind === "press" && event.button === 0 && onList) {
      const index = this.listOffset + point.row;
      if (index >= 0 && index < entries.length) {
        this.selectedKey = btwAnswerKey(entries[index]!);
        this.focus = "list";
      }
      // The list column belongs to the browser even where no row was hit.
      return true;
    }
    return false;
  }

  private selectedIndex(entries: readonly BtwEntry[]): number {
    if (this.selectedKey !== undefined) {
      const found = entries.findIndex((entry) => btwAnswerKey(entry) === this.selectedKey);
      if (found >= 0) return found;
    }
    this.selectedKey = entries[0] ? btwAnswerKey(entries[0]) : undefined;
    return 0;
  }

  private currentKey(): string | undefined {
    const entries = this.entries();
    const entry = entries[this.selectedIndex(entries)];
    return entry ? btwAnswerKey(entry) : undefined;
  }

  private selectKey(data: string, entries: readonly BtwEntry[]): boolean {
    const index = this.selectedIndex(entries);
    if (matchesKey(data, Key.up) || data === "k") return this.selectTo(index - 1, entries);
    if (matchesKey(data, Key.down) || data === "j") return this.selectTo(index + 1, entries);
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
      return this.selectTo(index - this.bodyRows, entries);
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
      return this.selectTo(index + this.bodyRows, entries);
    }
    if (matchesKey(data, Key.home) || data === "g") return this.selectTo(0, entries);
    if (matchesKey(data, Key.end) || data === "G") return this.selectTo(entries.length - 1, entries);
    return false;
  }

  private selectTo(index: number, entries: readonly BtwEntry[]): boolean {
    const target = clamp(index, 0, entries.length - 1);
    this.selectedKey = btwAnswerKey(entries[target]!);
    return true;
  }

  private scrollDetailKey(data: string): boolean {
    if (matchesKey(data, Key.up) || data === "k") return this.scrollDetail(-1);
    if (matchesKey(data, Key.down) || data === "j") return this.scrollDetail(1);
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
      return this.scrollDetail(-this.detailRows);
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
      return this.scrollDetail(this.detailRows);
    }
    if (matchesKey(data, Key.home) || data === "g") return this.scrollDetailTo(0);
    if (matchesKey(data, Key.end) || data === "G") return this.scrollDetailTo(this.maxDetailOffset());
    return false;
  }

  private maxDetailOffset(): number {
    return Math.max(0, this.detailLines - this.detailRows);
  }

  private scrollDetail(delta: number): boolean {
    return this.scrollDetailTo(this.answerOffset() + delta);
  }

  private scrollDetailTo(offset: number): boolean {
    const key = this.currentKey();
    if (!key) return false;
    this.offsets.set(key, clamp(offset, 0, this.maxDetailOffset()));
    return true;
  }

  private listWindow(
    entries: readonly BtwEntry[],
    selected: number,
    width: number,
    rows: number,
  ): string[] {
    const maxOffset = Math.max(0, entries.length - rows);
    let offset = Math.min(Math.max(0, this.listOffset), maxOffset);
    if (selected < offset) offset = selected;
    else if (selected >= offset + rows) offset = selected - rows + 1;
    this.listOffset = Math.max(0, Math.min(offset, maxOffset));

    const labelWidth = Math.max(1, width - BTW_LIST_PREFIX_WIDTH);
    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      const index = this.listOffset + row;
      const entry = entries[index];
      if (!entry) {
        lines.push("");
        continue;
      }
      const label = truncateToWidth(
        `${btwIsPending(entry) ? "pending · " : ""}${btwQuestionLabel(entry.question)}`, labelWidth, "…",
      );
      // Selection and unread are separate columns, each keeping its width when
      // empty: the marks read as two facts about the row, not one.
      const arrow = index === selected ? this.theme.fg("accent", "→ ") : "  ";
      const unread = btwIsPending(entry) || this.read.isRead(entry)
        ? "  "
        : `${this.theme.fg("warning", BTW_UNREAD_MARK)} `;
      const title = index === selected
        ? this.theme.fg("accent", label)
        : this.theme.fg("text", label);
      lines.push(`${arrow}${unread}${title}`);
    }
    return lines;
  }

  private detailWindow(answer: BtwEntry, width: number, rows: number): string[] {
    this.detailRows = rows;
    const lines = this.detailLinesFor(answer, width);
    this.detailLines = lines.length;
    const key = btwAnswerKey(answer);
    const offset = clamp(this.offsets.get(key) ?? 0, 0, Math.max(0, lines.length - rows));
    this.offsets.set(key, offset);
    const window = lines.slice(offset, offset + rows);
    while (window.length < rows) window.push("");
    return window;
  }

  private detailLinesFor(answer: BtwEntry, width: number): readonly string[] {
    const key = btwAnswerKey(answer);
    const cached = this.rendered.get(key);
    if (cached && cached.entry === answer && cached.width === width) return cached.lines;
    if (btwIsPending(answer)) {
      const lines = [
        ...wrapPlainText("pending · Waiting for BTW answer…", width),
        "",
        ...wrapPlainText(displayText(answer.question), width),
      ];
      this.rendered.set(key, { entry: answer, width, lines });
      return lines;
    }

    const question = wrapPlainText(displayText(answer.question), width)
      .map((line) => this.theme.bold(this.theme.fg("text", line)));
    const body = displayText(answer.answer);
    // A Markdown answer is rendered as Markdown; the question is the user's own
    // text and stays plain so nothing in it is read as markup.
    const rendered = renderPanelMarkdown(body, width, this.theme) ?? wrapPlainText(body, width);
    const lines = [
      renderKeyValue(this.theme, "Model", displayText(answer.model)),
      renderKeyValue(this.theme, "Cache", cacheLabel(answer.usage)),
      renderKeyValue(this.theme, "Context", answer.exactPrefix ? "live context" : "persisted context"),
      "",
      ...question,
      "",
      ...rendered,
    ].map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
    this.rendered.set(key, { entry: answer, width, lines });
    return lines;
  }

  private title(): string {
    if (this.layout === "narrow" && this.page === "detail") {
      const question = this.selectedQuestion();
      return question
        ? truncateToWidth(btwQuestionLabel(question), BREADCRUMB_QUESTION_WIDTH, "…")
        : "Answer";
    }
    return "Answers";
  }

  private breadcrumbs(): readonly string[] {
    return this.layout === "narrow" && this.page === "detail" ? ["BTW", "Answers"] : ["BTW"];
  }

  footerHints(): readonly string[] {
    if (this.layout === "narrow") {
      return this.page === "detail"
        ? [
          "↑↓ scroll · PgUp/PgDn page · Enter close · Esc back",
          "↑↓ scroll · Enter close · Esc back",
          "Enter close · Esc back",
        ]
        : ["↑↓ select · Enter open · Esc close", "↑↓ · Enter · Esc", "Esc close"];
    }
    return this.focus === "detail"
      ? [
        "↑↓ scroll · PgUp/PgDn page · Tab/← questions · Esc close",
        "↑↓ scroll · Tab questions · Esc close",
        "Esc close",
      ]
      : [
        "↑↓ question · Tab/→ answer · PgUp/PgDn page · Esc close",
        "↑↓ question · Tab answer · Esc close",
        "Esc close",
      ];
  }
}

/** Open the `/btw` browser over Pi's editor slot. */
export async function showBtwBrowser(
  ctx: Pick<InformationPanelContext, "ui">,
  history: () => readonly BtwEntry[],
  read: BtwReadState,
  updates?: BtwBrowserUpdates,
): Promise<void> {
  if (updates?.signal.aborted) return;
  let unsubscribe: (() => void) | undefined;
  let close: (() => void) | undefined;
  try {
    await showInformationPanelComponent(ctx, (host) => {
      const browser = new BtwBrowser({ theme: host.theme, history, read });
      close = host.onClose;
      updates?.signal.addEventListener("abort", close, { once: true });
      unsubscribe = updates?.subscribe(() => host.tui.requestRender());
      if (updates?.signal.aborted) queueMicrotask(close);
      return new InformationPanel({
        tui: host.tui,
        theme: host.theme,
        getView: () => browser.view(),
        onInput: (data) => browser.handleKey(data),
        onMouse: (event, controller) => browser.handleMouse(event, controller),
        onClose: host.onClose,
      });
    });
  } finally {
    unsubscribe?.();
    if (close) updates?.signal.removeEventListener("abort", close);
  }
}
