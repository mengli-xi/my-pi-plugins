/**
 * Backgrounds for diff lines, and for the changed words inside them.
 *
 * Pi's `renderDiff` paints foregrounds only — `toolDiffAdded` / `toolDiffRemoved`
 * for the lines, and reverse video for the words that actually changed. Reverse
 * video reads as "some colour, whichever the terminal picks", which is why the
 * changed run and the line it sits in never look like they belong together.
 *
 * There is no theme token to fix this with: pi's palette has `toolSuccessBg` and
 * `toolErrorBg`, but those are the *tool box* backgrounds — pi repeats them over
 * every line of an edit call — so borrowing them for diff rows would paint the
 * whole box. Hence the backgrounds live here, as 256-colour indices, while the
 * foregrounds stay in the theme where pi already applies them.
 */

import {
  sliceByColumn,
  visibleWidth,
} from "@earendil-works/pi-tui";

const ANSI_CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_BACKGROUND_RESET_AT_END =
  /\u001b\[49m((?:\u001b\[[0-?]*[ -/]*[@-~])*)$/;
const ANSI_STYLE_OR_BACKGROUND_RESET = /\u001b\[(?:0|49)m/g;
/** What `theme.inverse()` emits around a changed run. */
const ANSI_INVERSE_ON = /\u001b\[7m/g;
const ANSI_INVERSE_OFF = /\u001b\[27m/g;

export interface DiffColors {
  enabled: boolean;
  /** 256-colour index behind a `+` line. */
  addedBg: number;
  /** 256-colour index behind a `-` line. */
  removedBg: number;
  /** 256-colour index behind changed words in a `+` line. */
  addedHighlightBg: number;
  /** 256-colour index behind changed words in a `-` line. */
  removedHighlightBg: number;
}

export type DiffLineKind = "added" | "removed";

function bgAnsi(color: number): string {
  return `\u001b[48;5;${color}m`;
}

/**
 * Keep a background lit for the whole row.
 *
 * Every reset in the middle of the line would otherwise drop back to the
 * terminal's own background and leave the row striped, so the background is
 * re-armed after each one — but not after a reset that ends the line, which
 * would leak the colour past it.
 */
function holdBackground(
  line: string,
  background: string,
  rowWidth?: number,
): string {
  // Pi's edit shell leaves its own background close at the end of each body
  // line. Remove it before adding fill cells so the row stays continuous.
  const withoutTerminalReset = line.replace(ANSI_BACKGROUND_RESET_AT_END, "$1");
  const targetWidth = rowWidth === undefined
    ? visibleWidth(withoutTerminalReset)
    : Math.max(0, Math.floor(rowWidth));
  // Append the fill before processing resets. A style reset at the old text
  // boundary then sees visible cells after it and re-arms the row background.
  const padded = `${withoutTerminalReset}${" ".repeat(
    Math.max(0, targetWidth - visibleWidth(withoutTerminalReset)),
  )}`;
  const persistent = padded.replace(
    ANSI_STYLE_OR_BACKGROUND_RESET,
    (reset, offset: number) => {
      const remainder = padded.slice(offset + reset.length);
      return remainder.replace(ANSI_CONTROL_SEQUENCE, "").length > 0
        ? `${reset}${background}`
        : reset;
    },
  );
  return `${background}${persistent}\u001b[49m`;
}

/** Determine a row's semantic colour before ANSI-aware wrapping splits it. */
export function diffLineKind(line: string): DiffLineKind | undefined {
  const plain = line.replace(ANSI_CONTROL_SEQUENCE, "");
  if (plain.startsWith("+")) return "added";
  if (plain.startsWith("-")) return "removed";
  return undefined;
}

/**
 * Resolve the source operation for a line Pi already wrapped. A continuation
 * no longer has +/- at column zero, so walk back to the nearest diff row;
 * native context/header rows terminate that inheritance.
 */
export function wrappedDiffLineKind(
  lines: readonly string[],
  index: number,
): DiffLineKind | undefined {
  for (let cursor = index; cursor >= 0; cursor--) {
    const line = lines[cursor] ?? "";
    const kind = diffLineKind(line);
    if (kind) return kind;
    const plain = line.replace(ANSI_CONTROL_SEQUENCE, "");
    if (plain.length === 0 || plain.startsWith(" ") || plain.startsWith("@@")) {
      return undefined;
    }
  }
  return undefined;
}

interface NumberedDiffLine {
  /** Diff marker, padded line-number field, and the separator before content. */
  gutterWidth: number;
  kind: DiffLineKind | undefined;
}

function numberedDiffLine(line: string): NumberedDiffLine | undefined {
  const plain = line.replace(ANSI_CONTROL_SEQUENCE, "");
  const match = plain.match(/^[+\- ](\s*\d+)(?:\s|$)/);
  if (!match?.[1]) return undefined;
  return {
    // Pi renders `<marker><padded number><space><content>`. Continuations must
    // clear that complete gutter, not only the digits, or their text begins in
    // the line-number field and visually touches it.
    gutterWidth: 1 + match[1].length + 1,
    kind: diffLineKind(line),
  };
}

const ANSI_RESET = "\u001b[0m";
const OSC_8 = /\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
const OSC_8_CLOSE = "\u001b]8;;\u0007";

function closesPhysicalLine(slice: string): string {
  let hyperlinkOpen = false;
  for (const match of slice.matchAll(OSC_8)) {
    hyperlinkOpen = (match[1]?.length ?? 0) > 0;
  }
  return `${slice}${hyperlinkOpen ? OSC_8_CLOSE : ""}${ANSI_RESET}`;
}

interface WrappedLogicalLine {
  line: string;
  kind: DiffLineKind | undefined;
}

/**
 * Hard-wrap one logical row by terminal columns without normalizing code
 * whitespace. `sliceByColumn` carries active ANSI state into each slice and
 * respects grapheme boundaries; the reset keeps that state inside one physical
 * row. Returning undefined asks the caller to fail open when an indivisible
 * wide grapheme cannot fit the requested column budget.
 */
function hardWrapLogicalLine(
  line: string,
  firstWidth: number,
  continuationWidth: number,
  indent: string,
  kind: DiffLineKind | undefined,
): WrappedLogicalLine[] | undefined {
  const totalWidth = visibleWidth(line);
  if (totalWidth <= firstWidth) return [{ line, kind }];

  const wrapped: WrappedLogicalLine[] = [];
  let offset = 0;
  let available = firstWidth;
  while (offset < totalWidth) {
    const slice = sliceByColumn(line, offset, available, true);
    const sliceWidth = visibleWidth(slice);
    if (sliceWidth < 1) return undefined;
    const prefix = offset === 0 ? "" : indent;
    wrapped.push({
      line: `${prefix}${line.includes("\u001b") ? closesPhysicalLine(slice) : slice}`,
      kind,
    });
    offset += sliceWidth;
    available = continuationWidth;
  }
  return wrapped;
}

/**
 * Wrap logical rows from Pi's `renderDiff()` with a hanging indent.
 *
 * The input must still preserve one array entry per logical diff row. Parsing
 * already-wrapped physical rows is ambiguous (`-123` may be code, not another
 * diff row), so callers with only native physical output must keep Pi's native
 * wrapping. Continuations reserve the complete widest gutter (diff marker,
 * padded line-number field, and separator) and subtract it from their content
 * budget.
 */
export function formatWrappedDiffLines(
  logicalLines: readonly string[],
  rowWidth: number,
  colors?: DiffColors,
): string[] | undefined {
  const width = Math.max(0, Math.floor(rowWidth));
  const requestedIndent = logicalLines.reduce(
    (maximum, line) =>
      Math.max(maximum, numberedDiffLine(line)?.gutterWidth ?? 0),
    0,
  );
  if (width < 1 || (requestedIndent > 0 && width <= requestedIndent)) {
    return undefined;
  }

  const wrapAll = (indentWidth: number): WrappedLogicalLine[] | undefined => {
    const continuationWidth = Math.max(1, width - indentWidth);
    const indent = " ".repeat(indentWidth);
    const formatted: WrappedLogicalLine[] = [];
    for (const line of logicalLines) {
      const numbered = numberedDiffLine(line);
      const wrapped = hardWrapLogicalLine(
        line,
        width,
        numbered ? continuationWidth : width,
        numbered ? indent : "",
        numbered?.kind,
      );
      if (!wrapped) return undefined;
      formatted.push(...wrapped);
    }
    return formatted;
  };

  // Refuse partial semantics: if the exact gutter leaves no room for a whole
  // grapheme, the caller must retain its native presentation.
  const formatted = wrapAll(requestedIndent);
  if (!formatted) return undefined;

  return formatted.map(({ line, kind }) =>
    colors ? paintDiffLine(line, colors, width, kind) : line
  );
}

/**
 * Paint one rendered diff line. Lines that are neither an addition nor a
 * removal — context, headers, anything pi did not prefix — are returned
 * untouched, so this is safe to map over a whole diff.
 */
export function paintDiffLine(
  line: string,
  colors: DiffColors,
  rowWidth?: number,
  kind: DiffLineKind | undefined = diffLineKind(line),
): string {
  if (!colors.enabled) return line;
  if (!kind) return line;
  const background = bgAnsi(
    kind === "added" ? colors.addedBg : colors.removedBg,
  );
  const highlight = bgAnsi(
    kind === "added"
      ? colors.addedHighlightBg
      : colors.removedHighlightBg,
  );

  // Reverse video hands the changed run whatever the terminal inverts to.
  // Swapping it for an explicit background keeps the line's foreground legible
  // and makes the highlight the same colour in every terminal.
  const highlighted = line
    .replace(ANSI_INVERSE_ON, highlight)
    .replace(ANSI_INVERSE_OFF, background);

  return holdBackground(highlighted, background, rowWidth);
}
