import type { Theme } from "@earendil-works/pi-coding-agent";

export type RGB = readonly [number, number, number];

export const RESET_FG = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function visibleWidth(text: string): number {
  const plain = text
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "");
  let width = 0;
  for (const character of plain) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    ) {
      continue;
    }
    const wide =
      (codePoint >= 0x1100 && codePoint <= 0x115f) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Tokyo Night-derived palette used by the local cyber-ui package. */
export const cyberPalette = {
  fgMuted: [169, 177, 214] as RGB,
  fgSecondary: [126, 134, 171] as RGB,
  fgDim: [86, 95, 137] as RGB,
  silverHi: [230, 236, 250] as RGB,
} as const;

export function rgb(color: RGB): string {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
}

export function ansi256(index: number): string {
  return `\x1b[38;5;${index}m`;
}

export function paint(color: RGB, text: string, bold = false): string {
  const open = bold ? `${BOLD}${rgb(color)}` : rgb(color);
  const close = bold ? `${RESET_FG}${UNBOLD}` : RESET_FG;
  return `${open}${text}${close}`;
}

export function mix(left: RGB, right: RGB, ratio: number): RGB {
  const amount = Math.max(0, Math.min(1, ratio));
  return [
    Math.round(left[0] + (right[0] - left[0]) * amount),
    Math.round(left[1] + (right[1] - left[1]) * amount),
    Math.round(left[2] + (right[2] - left[2]) * amount),
  ];
}

const LETTER_WAVE_PERIOD_MS = 1_800;
const LETTER_WAVE_DELAY_MS = 120;
const LETTER_WAVE_PEAK = 0.32;
const LETTER_WAVE_HALF = 0.25;

/** Slowly moves a silver highlight across the working verb, character by character. */
export function paintLetterWave(text: string, now = Date.now()): string {
  const characters = [...text];
  return `${characters
    .map((character, index) => {
      const characterTime = now - index * LETTER_WAVE_DELAY_MS;
      const phase =
        (((characterTime % LETTER_WAVE_PERIOD_MS) + LETTER_WAVE_PERIOD_MS) %
          LETTER_WAVE_PERIOD_MS) /
        LETTER_WAVE_PERIOD_MS;
      const distance = Math.abs(phase - LETTER_WAVE_PEAK);
      const wrapped = Math.min(distance, 1 - distance);
      const intensity =
        wrapped > LETTER_WAVE_HALF
          ? 0
          : 0.5 *
            (1 + Math.cos((Math.PI * wrapped) / LETTER_WAVE_HALF));
      return `${rgb(
        mix(cyberPalette.fgMuted, cyberPalette.silverHi, intensity),
      )}${character}`;
    })
    .join("")}${RESET_FG}`;
}

export const CLAUDE_SPINNER_GLYPHS = ["·", "✻", "✽", "✶", "✳", "✢"];

export interface SpinnerTheme {
  fg(color: "accent" | "muted" | "dim", text: string): string;
}

export interface WorkingTextTheme {
  fg(color: "accent" | "text" | "muted", text: string): string;
}

/**
 * Builds the breathing spinner from semantic theme colors. Pi renders custom
 * indicator frames verbatim, so frames must already contain the active
 * theme's ANSI sequences.
 */
export function buildThemedPulseFrames(theme: SpinnerTheme): string[] {
  const frameCount = 24;
  return Array.from({ length: frameCount }, (_, index) => {
    const phase = index / frameCount;
    const intensity = 0.5 * (1 - Math.cos(Math.PI * 2 * phase));
    const color =
      intensity >= 0.72 ? "accent" : intensity >= 0.24 ? "muted" : "dim";
    const glyph =
      CLAUDE_SPINNER_GLYPHS[index % CLAUDE_SPINNER_GLYPHS.length]!;
    return theme.fg(color, glyph);
  });
}

/** Moves a semantic-theme highlight across the working label. */
export function paintThemedLetterWave(
  text: string,
  theme: WorkingTextTheme,
  now = Date.now(),
): string {
  return [...text]
    .map((character, index) => {
      const characterTime = now - index * LETTER_WAVE_DELAY_MS;
      const phase =
        (((characterTime % LETTER_WAVE_PERIOD_MS) + LETTER_WAVE_PERIOD_MS) %
          LETTER_WAVE_PERIOD_MS) /
        LETTER_WAVE_PERIOD_MS;
      const distance = Math.abs(phase - LETTER_WAVE_PEAK);
      const wrapped = Math.min(distance, 1 - distance);
      const intensity =
        wrapped > LETTER_WAVE_HALF
          ? 0
          : 0.5 *
            (1 + Math.cos((Math.PI * wrapped) / LETTER_WAVE_HALF));
      const color =
        intensity >= 0.68 ? "accent" : intensity >= 0.18 ? "text" : "muted";
      return theme.fg(color, character);
    })
    .join("");
}

/**
 * Claude Code's own working-indicator colours, owned by this extension rather
 * than read from the pi theme.
 *
 * pi routes the spinner and every select-list highlight through the single
 * `accent` slot, but Claude Code splits them: selections are `suggestion`
 * blue while the working row is the `claude` terracotta. Taking these two
 * values out of the theme lets `accent` stay blue for selections without
 * dragging the working row along with it.
 *
 * The indices are Claude Code's dark-theme values reduced to the 256-colour
 * cube, matching what the CLI actually emits under TERM=*-256color:
 *
 *   claude        rgb(215,119,87)  -> 174
 *   claudeShimmer rgb(235,159,127) -> 216
 *
 * 138 has no counterpart in Claude Code; it is a darker stop from the same
 * terracotta column, used only as the trough of the spinner's breath.
 */
export const claudeIndicatorPalette = {
  trough: ansi256(138),
  base: ansi256(174),
  shimmer: ansi256(216),
} as const;

/**
 * A deliberately dark, low-chroma palette for the metrics beneath the
 * spinner. These colours are independent of the animated Claude terracotta:
 * categories stay distinguishable without turning the status row into a set
 * of bright semantic highlights.
 *
 * The first six stops use the dark half of the xterm 6x6x6 cube (95/135 RGB
 * levels). TPS reuses the dark red/ochre/green family so its grade is readable
 * without changing weight.
 */
export const workingStatusPalette = {
  elapsed: ansi256(67),
  input: ansi256(65),
  output: ansi256(66),
  ttft: ansi256(101),
  thinking: ansi256(96),
  turns: ansi256(97),
  clock: ansi256(102),
  provider: ansi256(61),
  tpsSlow: ansi256(95),
  tpsSteady: ansi256(101),
  tpsFast: ansi256(65),
} as const;

/** Dark blue reserved for user-provided questionnaire answer values. */
const QUESTION_ANSWER_DARK_BLUE = ansi256(66);

export function paintQuestionAnswer(text: string): string {
  return `${QUESTION_ANSWER_DARK_BLUE}${text}${RESET_FG}`;
}

export type WorkingStatusTone = keyof typeof workingStatusPalette;

export function paintWorkingStatusValue(
  text: string,
  tone: WorkingStatusTone,
): string {
  return `${workingStatusPalette[tone]}${text}${RESET_FG}`;
}

/** Characters either side of the sweep centre that also get the highlight. */
const SHIMMER_BAND_RADIUS = 1;
/** How far past each end the sweep travels before wrapping. */
const SHIMMER_SWEEP_MARGIN = 10;
/** Milliseconds the highlight spends on each character. */
const SHIMMER_STEP_MS = 100;

/**
 * Paints text the way Claude Code paints its spinner label: the whole string
 * sits in the terracotta base while a three-character highlight sweeps across
 * it, restarting a margin's width off the left edge.
 *
 * Claude Code advances the sweep once per render tick; driving it from the
 * clock instead keeps the speed identical no matter what `working.refreshMs`
 * is set to.
 */
export function shimmerFrame(now = Date.now()): number {
  return Math.floor(now / SHIMMER_STEP_MS);
}

export function paintClaudeShimmer(text: string, now = Date.now()): string {
  const characters = [...text];
  if (characters.length === 0) return "";
  const cycle = characters.length + SHIMMER_SWEEP_MARGIN * 2;
  const step = shimmerFrame(now);
  const centre = (((step % cycle) + cycle) % cycle) - SHIMMER_SWEEP_MARGIN;
  let painted = "";
  let open: string | undefined;
  for (const [index, character] of characters.entries()) {
    const colour =
      Math.abs(index - centre) <= SHIMMER_BAND_RADIUS
        ? claudeIndicatorPalette.shimmer
        : claudeIndicatorPalette.base;
    // Only re-emit on change: one escape per run of characters, not per glyph.
    if (colour !== open) {
      painted += colour;
      open = colour;
    }
    painted += character;
  }
  return `${painted}${RESET_FG}`;
}

/** A neutral version of the same sweep for active tool rows. */
export function paintMutedShimmer(
  text: string,
  theme: Theme,
  now = Date.now(),
): string {
  const characters = [...text];
  if (characters.length === 0) return "";
  const cycle = characters.length + SHIMMER_SWEEP_MARGIN * 2;
  const centre = (((shimmerFrame(now) % cycle) + cycle) % cycle) -
    SHIMMER_SWEEP_MARGIN;
  let painted = "";
  let start = 0;
  let open: "text" | "muted" =
    Math.abs(centre) <= SHIMMER_BAND_RADIUS ? "text" : "muted";

  for (let index = 1; index <= characters.length; index++) {
    const color = index < characters.length &&
        Math.abs(index - centre) <= SHIMMER_BAND_RADIUS
      ? "text"
      : "muted";
    if (index < characters.length && color === open) continue;
    painted += theme.fg(open, characters.slice(start, index).join(""));
    start = index;
    open = color;
  }
  return painted;
}

/**
 * The breathing spinner in Claude Code's terracotta. Same cosine envelope as
 * {@link buildThemedPulseFrames}, but the three stops come from
 * {@link claudeIndicatorPalette} instead of the theme, so the frames never
 * need rebuilding when the theme changes.
 */
export function buildClaudeSpinnerFrames(): string[] {
  const frameCount = 24;
  return Array.from({ length: frameCount }, (_, index) => {
    const phase = index / frameCount;
    const intensity = 0.5 * (1 - Math.cos(Math.PI * 2 * phase));
    const colour =
      intensity >= 0.72
        ? claudeIndicatorPalette.shimmer
        : intensity >= 0.24
          ? claudeIndicatorPalette.base
          : claudeIndicatorPalette.trough;
    const glyph =
      CLAUDE_SPINNER_GLYPHS[index % CLAUDE_SPINNER_GLYPHS.length]!;
    return `${colour}${glyph}${RESET_FG}`;
  });
}

export interface CyberSegment {
  text: string;
  importance: number;
  width: number;
  budgetWidth: number;
}

export function segment(
  text: string,
  importance: number,
  reservedWidth = 0,
): CyberSegment {
  const width = visibleWidth(text);
  return {
    text,
    importance,
    width,
    budgetWidth: Math.max(width, reservedWidth),
  };
}

/** Pads a segment out to its reserved width so the next separator holds its column. */
function padSegment(item: CyberSegment): string {
  const missing = item.budgetWidth - item.width;
  return missing > 0 ? `${item.text}${" ".repeat(missing)}` : item.text;
}

export function joinCyber(parts: string[], separator?: string): string {
  return parts
    .filter(Boolean)
    .join(separator ?? paint(cyberPalette.fgSecondary, " · "));
}

export interface CyberFitStyle {
  separator: string;
  open: string;
  close: string;
}

/**
 * Keeps the animated label and drops lower-priority metrics first when the
 * configured width budget is exceeded.
 */
export function fitCyberSegments(
  segments: readonly CyberSegment[],
  budget: number,
  style?: CyberFitStyle,
): string {
  if (!segments.length) return "";
  const separator =
    style?.separator ?? paint(cyberPalette.fgSecondary, " · ");
  const separatorWidth = visibleWidth(separator);
  const survivors = new Set(segments.map((_, index) => index));
  const open = style?.open ?? paint(cyberPalette.fgSecondary, "(");
  const close = style?.close ?? paint(cyberPalette.fgSecondary, ")");
  const envelopeWidth = visibleWidth(` ${open}${close}`);

  const totalWidth = () => {
    let width = segments[0]?.budgetWidth ?? 0;
    let tailCount = 0;
    for (let index = 1; index < segments.length; index++) {
      if (!survivors.has(index)) continue;
      if (tailCount > 0) width += separatorWidth;
      width += segments[index]?.budgetWidth ?? 0;
      tailCount++;
    }
    return width + (tailCount > 0 ? envelopeWidth : 0);
  };

  const byImportance = segments
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.importance - right.item.importance);
  for (const { item, index } of byImportance) {
    if (totalWidth() <= budget) break;
    if (index === 0 || item.importance >= 100) continue;
    survivors.delete(index);
  }

  const first = segments[0];
  const label = first ? padSegment(first) : "";
  const surviving = segments
    .slice(1)
    .filter((_, index) => survivors.has(index + 1));
  // Reserved widths still hold the layout budget so a growing value never
  // toggles a segment in and out, but they are not padded into the output:
  // filler against a separator reads as a second space beside the dot.
  const tail = surviving.map((item) => item.text).join(separator);
  if (!tail) return label;
  return `${label} ${open}${tail}${close}`;
}
