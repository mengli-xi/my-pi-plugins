import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export const ELLIPSIS = "…";
const ELLIPSIS_PATTERN = /(…|\.{3})/g;

type ThemeColor = Parameters<Theme["fg"]>[0];

/** Every shortened or in-progress label uses the same quiet ellipsis tone. */
export function mutedEllipsis(theme: Theme, value = ELLIPSIS): string {
  return theme.fg("dim", value);
}

/** Paint text normally while keeping every ellipsis in the shared dim tone. */
export function paintWithMutedEllipses(
  text: string,
  theme: Theme,
  paint: (part: string) => string,
): string {
  return text
    .split(ELLIPSIS_PATTERN)
    .map((part) =>
      part === ELLIPSIS || part === "..."
        ? mutedEllipsis(theme, part)
        : part
          ? paint(part)
          : ""
    )
    .join("");
}

export function colorWithMutedEllipses(
  theme: Theme,
  color: ThemeColor,
  text: string,
): string {
  return paintWithMutedEllipses(
    text,
    theme,
    (part) => theme.fg(color, part),
  );
}

export function truncateWithMutedEllipsis(
  text: string,
  width: number,
  theme: Theme,
  pad = false,
): string {
  return truncateToWidth(
    text,
    Math.max(0, Math.floor(width)),
    mutedEllipsis(theme),
    pad,
  );
}

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

function takeRow(text: string, width: number): { line: string; rest: string } {
  const cut = charsWithin(text, width);
  const candidate = text.slice(0, cut);
  const space = candidate.lastIndexOf(" ");
  const at = space > cut / 2 ? space : cut;
  return {
    line: text.slice(0, at).trimEnd(),
    rest: text.slice(at).trimStart(),
  };
}

/** Wrap plain inline text to a fixed row budget and mark omitted text. */
export function fitTextRows(
  text: string,
  width: number,
  maxRows: number,
  lastRowReserve = 0,
): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeRows = Math.max(0, Math.floor(maxRows));
  if (safeWidth < 1 || safeRows < 1) return [];
  let rest = text.replace(/\s+/g, " ").trim();
  if (!rest) return [];

  const reservedWidth = Math.max(0, Math.floor(lastRowReserve));
  const finalRowWidth = Math.max(0, safeWidth - reservedWidth);
  if (finalRowWidth < 1) return [];
  const rows: string[] = [];
  for (let row = 0; row < safeRows && rest; row++) {
    const restWidth = visibleWidth(rest);
    // Any row can become the final rendered row. Account for a suffix before
    // taking the early return, rather than only reserving it on maxRows.
    if (restWidth <= finalRowWidth) {
      rows.push(rest);
      return rows;
    }
    if (row === safeRows - 1) {
      const contentWidth = Math.max(
        0,
        finalRowWidth - visibleWidth(ELLIPSIS),
      );
      rows.push(
        contentWidth < 1
          ? ELLIPSIS
          : `${rest.slice(0, charsWithin(rest, contentWidth)).trimEnd()}${ELLIPSIS}`,
      );
      return rows;
    }

    let taken = takeRow(rest, safeWidth);
    if (!taken.rest) {
      // The text fits the unreserved row but not the same row plus its suffix.
      // Force a useful split so the suffix gets a bounded continuation row.
      const splitWidth = Math.max(
        1,
        Math.min(safeWidth - 1, Math.ceil(restWidth / 2)),
      );
      const cut = charsWithin(rest, splitWidth);
      taken = {
        line: rest.slice(0, cut).trimEnd(),
        rest: rest.slice(cut).trimStart(),
      };
    }
    rows.push(taken.line);
    rest = taken.rest;
  }
  return rows;
}
