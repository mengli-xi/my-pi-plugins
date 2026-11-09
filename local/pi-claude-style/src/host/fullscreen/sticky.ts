import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * The header row naming the user question that owns the top of the
 * transcript, once that question has scrolled out of view. One row, always: a
 * header that grew with the message would eat the viewport it exists to make
 * navigable.
 */
const MARKER = "▲ ";
/** Says the row is a control, not a caption. */
const HINT = "click to jump";
const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

/**
 * Collapse a message to the one line a header can hold. Markdown is flattened
 * rather than rendered: what identifies a turn is its opening words.
 */
export function summarise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[>#*\-+]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Marker, text, and a rule filling out the line; the hint only when it fits whole. */
export function renderSticky(summary: string, width: number): string {
  if (width <= 0) return "";
  const label = `${MARKER}${summary} `;
  const labelWidth = visibleWidth(label);
  if (labelWidth >= width) {
    return `${DIM}${truncateToWidth(`${MARKER}${summary}`, width, "…")}${DIM_OFF}`;
  }
  const hint = ` ${HINT} `;
  const rule = width - labelWidth;
  if (rule > visibleWidth(hint) + 2) {
    const left = rule - visibleWidth(hint) - 1;
    return `${DIM}${label}${"─".repeat(left)}${hint}─${DIM_OFF}`;
  }
  return `${DIM}${label}${"─".repeat(rule)}${DIM_OFF}`;
}
