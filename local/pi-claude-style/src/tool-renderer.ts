import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  renderDiff,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { captureResult } from "./capture-result.ts";
import {
  paintMutedShimmer,
  paintQuestionAnswer,
  shimmerFrame,
} from "./cyber-style.ts";
import {
  colorWithMutedEllipses,
  fitTextRows,
  mutedEllipsis,
  paintWithMutedEllipses,
  truncateWithMutedEllipsis,
} from "./ellipsis.ts";
import { GroupStore } from "./grouping.ts";
import { formatQuestionDisplay } from "./question-format.ts";
import { statusGlyph, summarizeGroup } from "./semantics.ts";
import type {
  CapturedResult,
  ExpandMode,
  ToolActivity,
  ToolGroupSnapshot,
  ToolGroupTone,
  ToolPresentation,
} from "./types.ts";
import { clickable, onLeftClick } from "./clickable.ts";
import {
  formatWrappedDiffLines,
  paintDiffLine,
  wrappedDiffLineKind,
  type DiffColors,
} from "./diff-colors.ts";
import { displayEditPath } from "./edit-path.ts";
import { getCapturedEditDiff } from "./edit-details.ts";
import {
  imageActionLabel,
  isImageReadToolName,
  toolResultImagePreviews,
  type ToolImagePreview,
} from "./image-preview.ts";
import { formatThinkingElapsed } from "./thinking-document.ts";
import type { GroupOpener, ImageOpener } from "./openers.ts";
import {
  formatWebHeader,
  formatWebStatus,
  type WebPresentationKind,
} from "./web-format.ts";

class EmptyComponent implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

/**
 * One row in place of the images Pi leaves out when `terminal.showImages` is
 * off. The images come from the result Pi hands the renderer, the same blocks
 * the model was given, so a restored session opens what the live one did.
 */
export class ImageResultComponent implements Component {
  private readonly images: readonly ToolImagePreview[];
  private readonly theme: Theme;
  private readonly openImages: ImageOpener;

  constructor(
    images: readonly ToolImagePreview[],
    theme: Theme,
    openImages: ImageOpener,
  ) {
    this.images = images;
    this.theme = theme;
    this.openImages = openImages;
  }

  render(width: number): string[] {
    const prefix = this.theme.fg("muted", "  ⎿");
    const label = this.theme.fg("accent", imageActionLabel({
      count: this.images.length,
      totalBytes: this.images.reduce((total, image) => total + image.sizeBytes, 0),
    }));
    return [truncateWithMutedEllipsis(
      `${prefix} ${label}`,
      Math.max(0, Math.floor(width)),
      this.theme,
    )];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return onLeftClick(event, () => this.openImages(this.images));
  }
}

/** Only the first image tool occupies a native self-render shell. Keeping the
 * other shells empty lets Pi omit their leading gaps using its public API. */
export class GroupedImageResultComponent extends Container {
  private readonly store: GroupStore;
  private readonly toolCallId: string;
  // Every native result container retains its own row, even when it renders
  // nothing. GroupStore's WeakRefs therefore stay live while Pi owns results.
  private readonly ownRow: ImageResultComponent;

  constructor(store: GroupStore, toolCallId: string, ownRow: ImageResultComponent) {
    super();
    this.store = store;
    this.toolCallId = toolCallId;
    this.ownRow = ownRow;
  }

  render(width: number): string[] {
    const rows = this.store.imageRowsFor(this.toolCallId);
    this.clear();
    if (rows.length === 0) this.addChild(this.ownRow);
    else if (rows[0]!.toolCallId === this.toolCallId) {
      for (const { row } of rows) this.addChild(row);
    }
    // Container owns row geometry and dispatches each click to its own image.
    return super.render(width);
  }
}

class DynamicTextComponent implements Component {
  private readonly renderText: () => string;
  private readonly text = new Text("", 0, 0);
  private last = "";

  constructor(renderText: () => string) {
    this.renderText = renderText;
  }

  render(width: number): string[] {
    // Reusing one Text keeps its wrap cache, so a settled row costs a string
    // compare per frame instead of a fresh wrap.
    const next = this.renderText();
    if (!next) return [];
    if (next !== this.last) {
      this.last = next;
      this.text.setText(next);
    }
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

const ANSI_CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_BACKGROUND_SEQUENCE = /\u001b\[(?:48(?:;[0-9]+)*|49)m/g;
const ANSI_BACKGROUND_OPEN_SEQUENCE = /\u001b\[48(?:;[0-9]+)*m/g;
const ANSI_BACKGROUND_RESET_AT_END =
  /\u001b\[49m((?:\u001b\[[0-?]*[ -/]*[@-~])*)$/;
const ANSI_STYLE_OR_BACKGROUND_RESET = /\u001b\[(?:0|49)m/g;
const TRAILING_BOX_PADDING =
  / +((?:\u001b\[[0-?]*[ -/]*[@-~])*)$/;

/** Identity compare: pi hands back the same strings while nothing changed. */
function sameLines(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isVisuallyBlank(line: string): boolean {
  return line.replace(ANSI_CONTROL_SEQUENCE, "").trim().length === 0;
}

/**
 * Pi renders `edit ...` until the path finishes streaming. The placeholder
 * reads as a stalled row, so it is replaced by the file being edited as soon as
 * that argument is known, and dropped entirely while it is not.
 */
const EDIT_PATH_PLACEHOLDER = new RegExp(
  `\\.\\.\\.(?=(?:${ANSI_CONTROL_SEQUENCE.source}|\\s)*$)`,
);
const TRAILING_SPACE_BEFORE_ANSI = new RegExp(
  `\\s+(?=(?:${ANSI_CONTROL_SEQUENCE.source})*$)`,
);
const EDIT_LEADING_MARKER = new RegExp(
  `^((?:${ANSI_CONTROL_SEQUENCE.source})*)[●⏺]((?:${ANSI_CONTROL_SEQUENCE.source})*)[ \\t]*`,
);

function editArgsPath(args: unknown): string | undefined {
  const record = typeof args === "object" && args !== null
    ? args as Record<string, unknown>
    : undefined;
  const raw = record?.path ?? record?.file_path;
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || undefined;
}

function formatEditHeader(header: string, path?: string): string {
  const cleaned = header
    .replace(ANSI_BACKGROUND_SEQUENCE, "")
    .trim()
    .replace(EDIT_LEADING_MARKER, "$1$2")
    .replace(/edit/i, "Edit");
  if (path) {
    if (EDIT_PATH_PLACEHOLDER.test(cleaned)) {
      return cleaned.replace(EDIT_PATH_PLACEHOLDER, path);
    }
    const paren = cleaned.match(/^(.*?Edit)\([^)]*\)((?:\s|$).*)?$/);
    if (paren) return `${paren[1]} ${path}${paren[2] ?? ""}`;
    const match = cleaned.match(/^(.*?Edit)(?:\s+|$)/);
    return match ? `${match[1]} ${path}` : cleaned;
  }
  if (!EDIT_PATH_PLACEHOLDER.test(cleaned)) return cleaned;
  return cleaned.replace(EDIT_PATH_PLACEHOLDER, "").replace(TRAILING_SPACE_BEFORE_ANSI, "");
}

function stripEditShellPadding(line: string): string {
  const withoutLeftPadding = line.startsWith(" ") ? line.slice(1) : line;
  return withoutLeftPadding.replace(TRAILING_BOX_PADDING, "$1");
}



export class PrefixedComponent implements Component {
  private readonly child: Component;
  private readonly prefix: string | (() => string);

  constructor(child: Component, prefix: string | (() => string)) {
    this.child = child;
    this.prefix = prefix;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const prefix =
      typeof this.prefix === "function" ? this.prefix() : this.prefix;
    const prefixWidth = visibleWidth(prefix);
    if (prefixWidth < 1 || safeWidth <= prefixWidth) {
      return this.child.render(safeWidth);
    }
    const lines = this.child.render(safeWidth - prefixWidth);
    const continuation = " ".repeat(prefixWidth);
    return lines.map((line, index) =>
      `${index === 0 ? prefix : continuation}${line}`
    );
  }

  invalidate(): void {
    this.child.invalidate?.();
  }
}

interface BodyLineSource {
  /** Stable while the raw body payload is unchanged. */
  identity: unknown;
  render(width: number): readonly string[] | undefined;
}

export class HeaderPrefixedComponent implements Component {
  private readonly child: Component;
  private readonly prefix: string | (() => string);
  private readonly formatHeader: (header: string) => string;
  private readonly bodyIndentWidth:
    | number
    | ((resolvedPrefix: string) => number);
  private readonly formatBodyLines: (
    lines: readonly string[],
    width: number,
  ) => string[];
  private readonly getBodySource?: () => BodyLineSource | undefined;
  private readonly ellipsis: string;
  private cache:
    | {
      width: number;
      prefix: string;
      indent: number;
      source: readonly string[];
      bodyIdentity: unknown;
      lines: string[];
    }
    | undefined;

  constructor(
    child: Component,
    prefix: string | (() => string),
    formatHeader: (header: string) => string = (header) => header,
    bodyIndentWidth: number | ((resolvedPrefix: string) => number) = 0,
    formatBodyLines: (
      lines: readonly string[],
      width: number,
    ) => string[] = (lines) => [...lines],
    ellipsis = "…",
    getBodySource?: () => BodyLineSource | undefined,
  ) {
    this.child = child;
    this.prefix = prefix;
    this.formatHeader = formatHeader;
    this.bodyIndentWidth = bodyIndentWidth;
    this.formatBodyLines = formatBodyLines;
    this.ellipsis = ellipsis;
    this.getBodySource = getBodySource;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const prefix =
      typeof this.prefix === "function" ? this.prefix() : this.prefix;
    const prefixWidth = visibleWidth(prefix);
    if (prefixWidth < 1 || safeWidth <= prefixWidth) {
      return this.child.render(safeWidth);
    }
    // A settled diff is expensive to rebuild and repaint. Compare the stable
    // captured-result identity before asking its source to render any lines.
    const cached = this.cache;
    const bodySource = this.getBodySource?.();
    const requestedIndent =
      typeof this.bodyIndentWidth === "function"
        ? this.bodyIndentWidth(prefix)
        : this.bodyIndentWidth;
    const indentWidth = Math.min(
      Math.max(0, Math.floor(requestedIndent)),
      Math.max(0, safeWidth - 1),
    );
    const bodyWidth = Math.max(1, safeWidth - indentWidth);
    if (bodySource && bodyWidth < 2) {
      return this.child.render(safeWidth);
    }
    if (cached && cached.width === safeWidth && cached.prefix === prefix) {
      const source = this.child.render(bodyWidth);
      if (
        sameLines(source, cached.source) &&
        bodySource?.identity === cached.bodyIdentity
      ) return cached.lines;
    }
    const lines = this.child.render(bodyWidth);
    const suppliedBody = bodySource?.render(bodyWidth);
    if (bodySource && !suppliedBody) {
      return this.child.render(safeWidth);
    }
    const remember = (rendered: string[]): string[] => {
      this.cache = {
        width: safeWidth,
        prefix,
        indent: indentWidth,
        source: lines,
        bodyIdentity: suppliedBody ? bodySource?.identity : undefined,
        lines: rendered,
      };
      return rendered;
    };
    if (lines.length === 0) return remember([]);
    const headerIndex = lines.findIndex((line) => !isVisuallyBlank(line));
    if (headerIndex < 0) return remember([...lines]);

    // Pi's native edit renderer wraps the entire call in a Box whose
    // toolSuccessBg escape is repeated on every rendered line. Remove only
    // that exact outer background so inline diff highlights remain intact.
    const shellBackground = lines
      .slice(0, headerIndex + 1)
      .flatMap(
        (line) => line.match(ANSI_BACKGROUND_OPEN_SEQUENCE) ?? [],
      )[0];
    const body = lines.slice(headerIndex + 1);
    while (body.length > 0 && isVisuallyBlank(body[0] ?? "")) {
      body.shift();
    }
    const transparentBody = shellBackground
      ? body.map((line) =>
          stripEditShellPadding(line.replaceAll(shellBackground, ""))
        )
      : body;
    const indent = " ".repeat(indentWidth);
    const formattedBody = suppliedBody
      ? [...suppliedBody]
      : this.formatBodyLines(transparentBody, bodyWidth);
    return remember([
      `${prefix}${truncateToWidth(
        this.formatHeader(
          shellBackground
            ? (lines[headerIndex] ?? "").replaceAll(shellBackground, "")
            : (lines[headerIndex] ?? ""),
        ),
        safeWidth - prefixWidth,
        this.ellipsis,
      )}`,
      ...formattedBody.map((line) => `${indent}${line}`),
    ]);
  }

  invalidate(): void {
    this.cache = undefined;
    this.child.invalidate?.();
  }
}

class GroupSummaryComponent implements Component {
  private readonly store: GroupStore;
  private readonly toolCallId: string;
  private readonly theme: Theme;
  private readonly presenter?: ToolPresentationFormatter;
  private readonly thinkingElapsedForToolCalls?: (
    toolCallIds: readonly string[],
  ) => number | undefined;
  private readonly hideImageOnlySummary: boolean;
  private cache:
    | {
      width: number;
      version: number;
      running: boolean;
      shimmer: number;
      thinkingElapsedMs: number | undefined;
      lines: string[];
    }
    | undefined;

  constructor(
    store: GroupStore,
    toolCallId: string,
    theme: Theme,
    presenter?: ToolPresentationFormatter,
    thinkingElapsedForToolCalls?: (
      toolCallIds: readonly string[],
    ) => number | undefined,
    hideImageOnlySummary = true,
  ) {
    this.store = store;
    this.toolCallId = toolCallId;
    this.theme = theme;
    this.presenter = presenter;
    this.thinkingElapsedForToolCalls = thinkingElapsedForToolCalls;
    this.hideImageOnlySummary = hideImageOnlySummary;
  }

  render(width: number): string[] {
    // Historical rows stay cached. Only a live group follows the working
    // controller's render clock so its neutral highlight can sweep.
    const now = Date.now();
    const version = this.store.version();
    const group = this.store.getByToolCallId(this.toolCallId);
    if (!group || group.anchorToolCallId !== this.toolCallId) return [];
    const thinkingElapsedMs = this.thinkingElapsedForToolCalls?.(
      group.activities.map((activity) => activity.id),
    );
    const cached = this.cache;
    if (
      cached && cached.width === width && cached.version === version &&
      cached.thinkingElapsedMs === thinkingElapsedMs
    ) {
      const shimmer = cached.running ? shimmerFrame(now) : -1;
      if (cached.shimmer === shimmer) return cached.lines;
    }

    const running = group.status === "collecting";
    const shimmer = running ? shimmerFrame(now) : -1;
    const summarize = this.presenter
      ? (candidate: ToolGroupSnapshot) => this.presenter!.summarizeGroup(candidate)
      : summarizeGroup;
    const tone = this.presenter?.groupTone?.(group);
    const onlyImageReads = this.hideImageOnlySummary && group.activities.length > 0 &&
      group.activities.every((activity) =>
        isImageReadToolName(activity.toolName) &&
        activity.result?.imageSummary !== undefined
      );
    const lines = onlyImageReads
      ? []
      : fitGroupSummary(
        group,
        this.theme,
        width,
        summarize,
        now,
        tone,
        thinkingElapsedMs,
      );
    this.cache = { width, version, running, shimmer, thinkingElapsedMs, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

function groupSummaryPrefix(group: ToolGroupSnapshot, theme: Theme): string {
  return group.status === "completed"
    ? "  "
    : `${theme.fg("muted", statusGlyph(group.status))} `;
}

const ANSI_DIM = "\x1b[2m";
const ANSI_NORMAL_INTENSITY = "\x1b[22m";
const SEMANTIC_SHIMMER_MARGIN = 3;
const SEMANTIC_SHIMMER_RADIUS = 2;

function paintDimSemantic(
  theme: Theme,
  tone: ToolGroupTone,
  text: string,
): string {
  return `${ANSI_DIM}${theme.fg(tone, text)}${ANSI_NORMAL_INTENSITY}`;
}

function paintSemanticShimmer(
  text: string,
  theme: Theme,
  tone: ToolGroupTone,
  now: number,
): string {
  const characters = [...text];
  if (characters.length === 0) return "";
  const cycle = characters.length + SEMANTIC_SHIMMER_MARGIN * 2;
  const centre = (((shimmerFrame(now) % cycle) + cycle) % cycle) -
    SEMANTIC_SHIMMER_MARGIN;
  let painted = "";
  let start = 0;
  let bright = Math.abs(centre) <= SEMANTIC_SHIMMER_RADIUS;
  for (let index = 1; index <= characters.length; index += 1) {
    const nextBright = index < characters.length &&
      Math.abs(index - centre) <= SEMANTIC_SHIMMER_RADIUS;
    if (index < characters.length && nextBright === bright) continue;
    const part = characters.slice(start, index).join("");
    painted += bright
      ? theme.fg(tone, part)
      : paintDimSemantic(theme, tone, part);
    start = index;
    bright = nextBright;
  }
  return painted;
}

function paintGroupSummary(
  text: string,
  running: boolean,
  theme: Theme,
  now: number,
  tone?: ToolGroupTone,
): string {
  if (tone) {
    return paintWithMutedEllipses(
      text,
      theme,
      (part) => running
        ? paintSemanticShimmer(part, theme, tone, now)
        : paintDimSemantic(theme, tone, part),
    );
  }
  return running
    ? paintWithMutedEllipses(
      text,
      theme,
      (part) => paintMutedShimmer(part, theme, now),
    )
    : colorWithMutedEllipses(theme, "muted", text);
}

export function renderGroupSummary(
  group: ToolGroupSnapshot,
  theme: Theme,
  summarize: (group: ToolGroupSnapshot) => string = summarizeGroup,
  now = Date.now(),
  tone?: ToolGroupTone,
  thinkingElapsedMs?: number,
): string {
  const running = group.status === "collecting";
  const suffix = running ? mutedEllipsis(theme) : "";
  const thinking = thinkingElapsedMs === undefined
    ? ""
    : ` · Thinking ${formatThinkingElapsed(thinkingElapsedMs)}`;
  return `${groupSummaryPrefix(group, theme)}${paintGroupSummary(
    `${summarize(group)}${thinking}`,
    running,
    theme,
    now,
    tone,
  )}${suffix}`;
}

export function fitGroupSummary(
  group: ToolGroupSnapshot,
  theme: Theme,
  width: number,
  summarize: (group: ToolGroupSnapshot) => string = summarizeGroup,
  now = Date.now(),
  tone?: ToolGroupTone,
  thinkingElapsedMs?: number,
): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth < 1) return [];
  const prefix = groupSummaryPrefix(group, theme);
  const prefixWidth = visibleWidth(prefix);
  if (safeWidth <= prefixWidth) {
    return [truncateWithMutedEllipsis(prefix, safeWidth, theme)];
  }

  const running = group.status === "collecting";
  const thinking = thinkingElapsedMs === undefined
    ? ""
    : ` · Thinking ${formatThinkingElapsed(thinkingElapsedMs)}`;
  const source = `${summarize(group)}${thinking}${running ? "…" : ""}`;
  return fitTextRows(source, safeWidth - prefixWidth, 2).map((row, index) =>
    `${index === 0 ? prefix : " ".repeat(prefixWidth)}${paintGroupSummary(
      row,
      running,
      theme,
      now,
      tone,
    )}`
  );
}

const PRESENTATION_DECORATION = Symbol.for(
  "pi-claude-style.tool-presentation.v1",
);

interface PresentationDecoration {
  toolName: string;
  store: GroupStore;
  original: ToolRenderers;
  presenter?: ToolPresentationFormatter;
}

type MarkedToolRenderers = ToolRenderers & {
  [PRESENTATION_DECORATION]?: PresentationDecoration;
};

export interface DecorateToolOptions {
  store: GroupStore;
  getExpandMode: () => ExpandMode;
  resolvePresentation: (toolName: string, args: unknown) => ToolPresentation;
  maxResultChars: number;
  presenter?: ToolPresentationFormatter;
  thinkingElapsedForToolCalls?(toolCallIds: readonly string[]): number | undefined;
  openGroup?: GroupOpener;
  openImages?: ImageOpener;
  diffColors?: DiffColors;
}

export interface ToolPresentationFormatter {
  summarizeGroup(group: ToolGroupSnapshot): string;
  formatActivity(activity: ToolActivity): string;
  groupTone?(group: ToolGroupSnapshot): ToolGroupTone | undefined;
}

function activityFor(
  store: GroupStore,
  toolCallId: string,
): ToolActivity | undefined {
  return store
    .getByToolCallId(toolCallId)
    ?.activities.find((activity) => activity.id === toolCallId);
}

function activityColor(
  activity: ToolActivity | undefined,
): "success" | "error" | "warning" | "accent" {
  if (activity?.status === "completed") return "success";
  if (activity?.status === "failed") return "error";
  if (activity?.status === "cancelled") return "warning";
  return "accent";
}

function renderImportantCall(
  presentation: Exclude<ToolPresentation["kind"], "grouped" | "native">,
  args: unknown,
  store: GroupStore,
  toolCallId: string,
  theme: Theme,
): Component {
  return new DynamicTextComponent(() => {
    const activity = activityFor(store, toolCallId);
    if (presentation === "question") {
      const display = formatQuestionDisplay(
        activity?.args ?? args,
        activity?.result,
      );
      const markerColor =
        display.state === "answered"
          ? "muted"
          : display.state === "failed"
            ? "error"
            : display.state === "declined" || display.state === "cancelled"
              ? "warning"
              : "accent";
      const marker = theme.fg(markerColor, "⏺");
      return `${marker} ${colorWithMutedEllipses(
        theme,
        display.state === "running"
          ? "text"
          : display.state === "answered"
            ? "text"
            : display.state === "failed"
              ? "error"
              : "muted",
        display.title,
      )}`;
    }
    if (presentation === "web-search" || presentation === "web-fetch") {
      const marker = theme.fg(activityColor(activity), "⏺");
      return `${marker} ${colorWithMutedEllipses(
        theme,
        activity?.status === "running" ? "text" : "muted",
        formatWebHeader(presentation, activity?.args ?? args),
      )}`;
    }
    return "";
  });
}

function renderImportantResult(
  presentation: Exclude<
    ToolPresentation["kind"],
    "grouped" | "native" | "single-file-edit"
  >,
  args: unknown,
  fallback: CapturedResult,
  store: GroupStore,
  toolCallId: string,
  theme: Theme,
): Component {
  return new DynamicTextComponent(() => {
    const activity = activityFor(store, toolCallId);
    const result = activity?.result ?? fallback;
    if (presentation === "question") {
      const display = formatQuestionDisplay(activity?.args ?? args, result);
      return display.rows
        .map((row) => {
          if (row.kind === "answer") {
            return `${theme.fg("muted", "  ⎿")} ${theme.fg("text", row.title)} ${
              theme.fg("muted", "->")
            } ${paintQuestionAnswer(row.answer)}`;
          }
          if (row.kind === "note") {
            return `${theme.fg("muted", "    Notes:")} ${theme.fg("muted", row.text)}`;
          }
          return theme.fg(display.state === "failed" ? "error" : "text", row.text);
        })
        .join("\n");
    }
    const webActivity: ToolActivity = activity ?? {
      id: toolCallId,
      groupId: "",
      toolName: presentation === "web-search" ? "web_search" : "web_fetch",
      args,
      result,
      status: result.isError ? "failed" : "completed",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    const color =
      webActivity.status === "failed"
        ? "error"
        : webActivity.status === "cancelled"
          ? "warning"
          : webActivity.status === "running"
            ? "text"
            : "muted";
    return `  ${colorWithMutedEllipses(
      theme,
      color,
      formatWebStatus(presentation as WebPresentationKind, webActivity),
    )}`;
  });
}

function editResultHasDiff(result: { details?: unknown }, isError: boolean): boolean {
  if (isError) return false;
  const details = typeof result.details === "object" && result.details !== null
    ? result.details as Record<string, unknown>
    : undefined;
  return typeof details?.diff === "string" && details.diff.length > 0;
}

// Only the live visual projection is bounded. GroupStore and execution keep the
// original arguments, and argsComplete always hands the native renderer all bytes.
const STREAMING_WRITE_PREVIEW_CHARS = 4_096;
function writePreviewArgs(toolName: string, args: unknown, complete: boolean): unknown {
  if (complete || (toolName !== "write" && toolName !== "write_file")) return args;
  if (!args || typeof args !== "object") return args;
  const record = args as Record<string, unknown>;
  if (typeof record.content !== "string" || record.content.length <= STREAMING_WRITE_PREVIEW_CHARS) return args;
  const last = record.content.charCodeAt(STREAMING_WRITE_PREVIEW_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff
    ? STREAMING_WRITE_PREVIEW_CHARS - 1
    : STREAMING_WRITE_PREVIEW_CHARS;
  return { ...record, content: `${record.content.slice(0, end)}\n…` };
}

function samePreviewArgs(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]
  );
}

export function decorateToolRenderers(
  toolName: string,
  definition: ToolRenderers,
  options: DecorateToolOptions,
): ToolRenderers {
  const previous = (definition as MarkedToolRenderers)[PRESENTATION_DECORATION];
  if (
    previous?.toolName === toolName &&
    previous.store === options.store &&
    previous.presenter === options.presenter
  ) return definition;
  // A definition can survive `/reload` in Pi's runner. Unwrap our previous
  // renderer rather than stacking another closure over a dead GroupStore.
  const original = (previous?.original ?? definition);
  const originalRenderCall = original.renderCall;
  const originalRenderResult = original.renderResult;
  const managed =
    options.resolvePresentation(toolName, {}).kind !== "native";
  // Pi's public renderer state belongs to this row. Weak keys keep sessions and
  // detached SDK views collectible; neither payload serialization nor timers are
  // needed to reuse a folded row or a saturated write preview.
  const calls = new WeakMap<object, {
    theme: Theme;
    kind: ToolPresentation["kind"];
    inline: boolean;
    expanded: boolean;
    showImages: boolean;
    args: unknown;
    complete: boolean;
    component: Component;
  }>();
  // Native renderers own their child identity (write, for example, calls
  // lastComponent.setText). Pi only sees our outer clickable/prefix component,
  // so keep call and result children separately from that presentation cache.
  const nativeCalls = new WeakMap<object, Component>();
  const nativeResults = new WeakMap<object, Component>();
  const decorated: ToolRenderers = {
    ...original,
    renderShell: managed ? "self" : original.renderShell,
    renderCall(args, theme, context) {
      const presentation = options.resolvePresentation(toolName, args);
      const complete = context.argsComplete || context.executionStarted;
      const inline = options.getExpandMode() === "inline" && context.expanded;
      const folded = presentation.kind === "grouped" && !inline;
      const previewArgs = folded ? args : writePreviewArgs(toolName, args, complete);
      const boundedWrite = previewArgs !== args;
      // Keep store lifecycle independent from the component cache (a history
      // rebuild may have reset its groups while retaining a live tool row).
      if (presentation.kind !== "native") {
        // An incomplete edit path may still resolve to project memory.
        if (presentation.kind !== "single-file-edit" || complete) {
          options.store.ensure(context.toolCallId, toolName, args, Date.now(), presentation.kind);
        }
        options.store.registerRenderer(context.toolCallId, context.invalidate);
      }
      const key = context.state && typeof context.state === "object" ? context.state : undefined;
      const cached = key ? calls.get(key) : undefined;
      if (cached && cached.theme === theme && cached.kind === presentation.kind &&
        cached.inline === inline && cached.expanded === context.expanded &&
        cached.showImages === context.showImages && cached.complete === complete &&
        (folded || (boundedWrite && samePreviewArgs(cached.args, previewArgs)))) {
        return cached.component;
      }
      const remember = (component: Component): Component => {
        if (key && (folded || boundedWrite)) calls.set(key, {
          theme, kind: presentation.kind, inline, expanded: context.expanded, showImages: context.showImages,
          args: boundedWrite ? previewArgs : undefined, complete, component,
        });
        else if (key) calls.delete(key);
        return component;
      };
      const renderOriginalCall = (): Component => {
        if (!originalRenderCall) return new Text(theme.fg("toolTitle", toolName), 0, 0);
        try {
          const child = originalRenderCall(previewArgs, theme, {
            ...context, args: previewArgs, lastComponent: key ? nativeCalls.get(key) : undefined,
          });
          if (key) nativeCalls.set(key, child);
          return child;
        } catch (error) {
          if (key) nativeCalls.delete(key);
          throw error;
        }
      };
      if (presentation.kind === "native") {
        return remember(renderOriginalCall());
      }
      // Every managed summary row is a doorway to its Activity transcript.
      return remember(clickable(buildCall(), () => options.openGroup?.(context.toolCallId) ?? false));

      function buildCall(): Component {
      if (presentation.kind === "question" ||
        presentation.kind === "web-search" ||
        presentation.kind === "web-fetch") {
        return renderImportantCall(
          presentation.kind,
          args,
          options.store,
          context.toolCallId,
          theme,
        );
      }
      if (presentation.kind === "single-file-edit") {
        const call = renderOriginalCall();
        return new HeaderPrefixedComponent(
          call,
          () =>
            `${theme.fg(
              activityColor(activityFor(options.store, context.toolCallId)),
              "⏺",
            )} `,
          (header) => {
            const rawPath = editArgsPath(args) ??
              editArgsPath(activityFor(options.store, context.toolCallId)?.args);
            return formatEditHeader(
              header,
              rawPath ? displayEditPath(rawPath, context.cwd) || undefined : undefined,
            );
          },
          (prefix) => visibleWidth(prefix),
          (lines, width) => lines.map((line, index) =>
            options.diffColors
              ? paintDiffLine(
                  line,
                  options.diffColors,
                  width,
                  wrappedDiffLineKind(lines, index),
                )
              : line
          ),
          mutedEllipsis(theme),
          () => {
            const activity = activityFor(options.store, context.toolCallId);
            if (
              activity?.status !== "completed" ||
              activity.result?.truncated
            ) return undefined;
            const captured = getCapturedEditDiff(activity);
            if (!captured) return undefined;
            return {
              identity: activity.result,
              render: (width: number) =>
                formatWrappedDiffLines(
                  renderDiff(captured.diff, { filePath: captured.filePath })
                    .split("\n"),
                  width,
                  options.diffColors,
                ),
            };
          },
        );
      }
      if (
        options.getExpandMode() === "inline" &&
        context.expanded
      ) {
        const call = renderOriginalCall();
        return new PrefixedComponent(
          call,
          () => {
            const activity = options.store
              .getByToolCallId(context.toolCallId)
              ?.activities.find(
                (candidate) => candidate.id === context.toolCallId,
              );
            const color =
              activity?.status === "completed"
                ? "success"
                : activity?.status === "failed"
                  ? "error"
                  : activity?.status === "cancelled"
                    ? "warning"
                    : "accent";
            return `${theme.fg(color, "●")} `;
          },
        );
      }
      return new GroupSummaryComponent(
        options.store,
        context.toolCallId,
        theme,
        options.presenter,
        options.thinkingElapsedForToolCalls,
        !context.showImages && options.openImages !== undefined,
      );
      }
    },
    renderResult(result, renderOptions, theme, context) {
      const key = context.state && typeof context.state === "object" ? context.state : undefined;
      const renderOriginalResult = (): Component => {
        try {
          const child = originalRenderResult!(result, renderOptions, theme, {
            ...context, lastComponent: key ? nativeResults.get(key) : undefined,
          });
          if (key) nativeResults.set(key, child);
          return child;
        } catch (error) {
          if (key) nativeResults.delete(key);
          throw error;
        }
      };
      const presentation = options.resolvePresentation(
        toolName,
        context.args,
      );
      if (presentation.kind === "native") {
        if (originalRenderResult) {
          return renderOriginalResult();
        }
        const text = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return new Text(theme.fg("toolOutput", text), 0, 0);
      }
      options.store.registerRenderer(context.toolCallId, context.invalidate);
      options.store.unregisterImageRow(context.toolCallId);
      const component = buildResult();
      return component instanceof GroupedImageResultComponent
        ? component
        : clickable(component, () => options.openGroup?.(context.toolCallId) ?? false);

      function buildResult(): Component {
      if (presentation.kind === "question" ||
        presentation.kind === "web-search" ||
        presentation.kind === "web-fetch") {
        const fallback = captureResult(
          result,
          context.isError,
          options.maxResultChars,
        );
        return renderImportantResult(
          presentation.kind,
          context.args,
          fallback,
          options.store,
          context.toolCallId,
          theme,
        );
      }
      if (presentation.kind === "single-file-edit") {
        if (editResultHasDiff(result, context.isError)) {
          return new EmptyComponent();
        }
        if (originalRenderResult) {
          return renderOriginalResult();
        }
        const text = result.content
          .filter((block): block is { type: "text"; text: string } =>
            block.type === "text"
          )
          .map((block) => block.text)
          .join("\n");
        return new Text(
          theme.fg(context.isError ? "error" : "toolOutput", text),
          0,
          0,
        );
      }
      if (
        options.getExpandMode() === "inline" &&
        context.expanded
      ) {
        const rendered = originalRenderResult
          ? renderOriginalResult()
          : new Text(
              theme.fg(
                "toolOutput",
                result.content
                  .filter(
                    (block): block is { type: "text"; text: string } =>
                      block.type === "text",
                  )
                  .map((block) => block.text)
                  .join("\n"),
              ),
              0,
              0,
            );
        return new PrefixedComponent(
          rendered,
          `  ${theme.fg("dim", "⎿")} `,
        );
      }
      // Pi draws no images while `terminal.showImages` is off; one row
      // stands in for them and opens them in a panel.
      if (!context.showImages && options.openImages) {
        const images = toolResultImagePreviews(toolName, context.args, result.content);
        if (images.length > 0) {
          const row = new ImageResultComponent(images, theme, options.openImages);
          options.store.registerImageRow(context.toolCallId, row);
          return new GroupedImageResultComponent(options.store, context.toolCallId, row);
        }
      }
      return new EmptyComponent();
      }
    },
  };
  Object.defineProperty(decorated, PRESENTATION_DECORATION, {
    value: {
      toolName,
      store: options.store,
      original,
      presenter: options.presenter,
    },
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return decorated;
}
