/**
 * Pi's Loader renders its indicator at screen column 1: one Text margin, then
 * the spinner glyph. Child glyphs sit two columns later, at column 3.
 *
 * Active tools and Todo are custom pinned components, so they do not inherit
 * Loader's margin and use the full three-column source indent directly.
 */
export const WORKING_INDICATOR_COLUMN = 1;
export const WORKING_CHILD_COLUMN = WORKING_INDICATOR_COLUMN + 2;
const LOADER_TEXT_MARGIN = 1;

export const PINNED_WORKING_CHILD_INDENT = " ".repeat(WORKING_CHILD_COLUMN);
export const LOADER_WORKING_CONTINUATION_INDENT = " ".repeat(
  WORKING_CHILD_COLUMN - LOADER_TEXT_MARGIN,
);

const LOADER_STATUS_CHROME_WIDTH = LOADER_TEXT_MARGIN * 2 + 2;

/** Fit each Loader message row beside its margins and indicator column. */
export function workingMessageWidth(
  configuredWidth: number,
  terminalColumns: number | undefined = process.stdout.columns,
): number {
  const configured = Math.max(1, Math.floor(configuredWidth));
  if (terminalColumns === undefined || !Number.isFinite(terminalColumns)) {
    return configured;
  }
  const terminal = Math.floor(terminalColumns);
  if (terminal <= LOADER_STATUS_CHROME_WIDTH) return 1;
  return Math.min(configured, terminal - LOADER_STATUS_CHROME_WIDTH);
}
