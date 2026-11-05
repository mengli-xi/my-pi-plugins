import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * The violet ripple that runs under the `ultra` rung of the picker.
 *
 * Ported from Claude Code's own `/effort` slider, whose numbers were read out
 * of the shipped bundle rather than guessed: concentric rings of background
 * colour spreading from the highlighted rung's caret, 8-step violet gradient,
 * 20-column wavelength, 0.03 columns per millisecond, repainted every 80ms.
 * Cells the wavefront has not reached yet are left alone, so the panel keeps
 * its normal colours ahead of the wave.
 *
 * Two details are worth keeping if this is ever tuned. Distance weights rows
 * twice as heavily as columns, because a terminal cell is about twice as tall
 * as it is wide — without it the rings render as tall ovals instead of circles.
 * And the ring shape is a raised cosine of the distance, not a hard edge, which
 * is what makes the wave read as rolling rather than as a moving stripe.
 */

/** Milliseconds per repaint. */
export const RIPPLE_FRAME_MS = 80;
/** Columns per millisecond the wavefront travels. */
export const RIPPLE_SPEED = 0.03;
/** Distance between successive rings, in columns. */
export const RIPPLE_WAVELENGTH = 20;
/** Rows count double: terminal cells are roughly twice as tall as wide. */
const ROW_WEIGHT = 2;

/** Dark to bright, the ring gradient. */
export const VIOLET_STEPS: ReadonlyArray<readonly [number, number, number]> = Array.from(
  { length: 8 },
  (_unused, index) => {
    const t = index / 7;
    return [
      Math.round(62 + (140 - 62) * t),
      Math.round(22 + (80 - 22) * t),
      Math.round(118 + (240 - 118) * t),
    ] as const;
  },
);

/** Elliptical distance from the ripple origin, in column units. */
export function rippleDistance(
  column: number,
  row: number,
  originColumn: number,
  originRow: number,
): number {
  const dx = column - originColumn;
  const dy = (row - originRow) * ROW_WEIGHT;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Which gradient step a cell shows, or null when the wavefront has not
 * reached it. `travel` is how far the front has moved since the ripple began.
 */
export function rippleStep(distance: number, travel: number): number | null {
  if (distance > travel) return null;
  const phase = (((distance - travel) % RIPPLE_WAVELENGTH) + RIPPLE_WAVELENGTH) % RIPPLE_WAVELENGTH;
  const wave = (1 + Math.cos((2 * Math.PI * phase) / RIPPLE_WAVELENGTH)) / 2;
  return Math.min(VIOLET_STEPS.length - 1, Math.round(wave * (VIOLET_STEPS.length - 1)));
}

/** How far the wavefront has travelled after `elapsedMs`. */
export function rippleTravel(elapsedMs: number): number {
  return Math.max(0, elapsedMs) * RIPPLE_SPEED;
}

const RESET_BG = "\x1b[49m";

function bgCode(step: number): string {
  const [r, g, b] = VIOLET_STEPS[step] ?? VIOLET_STEPS[VIOLET_STEPS.length - 1]!;
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Paint a background behind an already-coloured line, cell by cell.
 *
 * The panel's lines arrive carrying the theme's own foreground escapes, so the
 * painter walks the string, passes every escape sequence through untouched,
 * and wraps only printable cells — setting the background and resetting just
 * the background afterwards, never the foreground.
 *
 * Short interior rows are padded to `width` before painting. The panel's rules
 * already define that exact width; filling the cells between them gives a
 * right-edge origin room to draw both halves of a ripple without widening the
 * panel or touching either rule.
 */
export function paintRippleLine(
  line: string,
  width: number,
  stepAt: (column: number) => number | null,
): string {
  const visible = visibleWidth(line);
  const source = `${line}${" ".repeat(Math.max(0, width - visible))}`;
  let out = "";
  let column = 0;
  let index = 0;

  const cell = (character: string): string => {
    const step = column < width ? stepAt(column) : null;
    return step === null ? character : `${bgCode(step)}${character}${RESET_BG}`;
  };

  while (index < source.length) {
    if (source[index] === "\x1b") {
      const end = source.indexOf("m", index);
      if (end === -1) {
        out += source.slice(index);
        break;
      }
      out += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    out += cell(source[index] as string);
    column += 1;
    index += 1;
  }
  return out;
}

/** Paint a whole panel: every row rippling out from one origin cell. */
export function paintRipple(
  lines: readonly string[],
  width: number,
  origin: { column: number; row: number },
  elapsedMs: number,
): string[] {
  const travel = rippleTravel(elapsedMs);
  return lines.map((line, row) =>
    paintRippleLine(line, width, (column) =>
      rippleStep(rippleDistance(column, row, origin.column, origin.row), travel),
    ),
  );
}
