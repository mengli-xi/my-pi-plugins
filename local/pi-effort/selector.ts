/**
 * The picker: Claude Code's effort slider. The track/caret/label rendering
 * lives in pi-li-uikit's generic `level-slider` (extracted from here); this
 * file binds it to the effort ladder — descriptions, theme colours, and the
 * fallback ramp from `levels.ts` — and keeps the original export surface.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  LevelSlider,
  layoutSlider,
  levelPainter as genericLevelPainter,
  type LevelChoice,
  type SliderLayout,
} from "pi-li-uikit/level-slider";

import {
  layoutSlider as sliderLayout,
} from "pi-li-uikit/level-slider";

import { paintRipple, RIPPLE_FRAME_MS } from "./ripple.js";
import {
  EFFORT_COLORS,
  EFFORT_DESCRIPTIONS,
  EFFORT_PALETTE,
  type EffortLevel,
} from "./levels.js";

export { layoutSlider, type SliderLayout };

export type LevelPainter = (level: EffortLevel, text: string) => string;

function toChoice(level: EffortLevel): LevelChoice<EffortLevel> {
  return {
    value: level,
    description: EFFORT_DESCRIPTIONS[level],
    themeColor: EFFORT_COLORS[level],
    rgb: EFFORT_PALETTE[level].rgb,
    ansi256: EFFORT_PALETTE[level].ansi256,
  };
}

/** Original signature, delegating to the generic painter. */
export function levelPainter(theme: Theme, levels: readonly EffortLevel[]): LevelPainter {
  return genericLevelPainter(theme, levels.map(toChoice));
}

export interface EffortSelectorOptions {
  /** Levels this model offers, cheapest first. */
  levels: readonly EffortLevel[];
  /** The level in effect right now — where the caret starts. */
  current: EffortLevel;
  onSelect: (level: EffortLevel) => void;
  onCancel: () => void;
}

/**
 * The effort slider, plus one flourish the generic component has no business
 * knowing about: while the caret rests on `ultra` — this package's own rung,
 * not one of pi's — a violet ripple spreads across the panel from that rung's
 * caret. The geometry and timing are Claude Code's, read out of its bundle
 * rather than guessed; see ripple.ts.
 *
 * The animation is the panel's, so it lives and dies with the panel: it starts
 * when the caret arrives, restarts from zero each time it comes back, and
 * stops when the caret leaves or the panel closes.
 */
export class EffortSelector extends LevelSlider<EffortLevel> {
  private readonly panelTui: TUI;
  private readonly levels: readonly EffortLevel[];
  private highlighted: EffortLevel | undefined;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(tui: TUI, theme: Theme, options: EffortSelectorOptions) {
    // `onHighlight` fires once from inside super(), where `this` is still in
    // the temporal dead zone — so the callback must not touch `this` until the
    // constructor says it may. The first highlight is parked in a local and
    // replayed below.
    let started = false;
    let parked: EffortLevel | undefined;

    super(tui, theme, {
      title: "Effort",
      choices: options.levels.map(toChoice),
      current: options.current,
      onSelect: (level) => {
        if (started) this.stop();
        options.onSelect(level);
      },
      onCancel: () => {
        if (started) this.stop();
        options.onCancel();
      },
      onHighlight: (level) => {
        if (!started) {
          parked = level;
          return;
        }
        this.setHighlight(level);
      },
    });

    this.panelTui = tui;
    this.levels = options.levels;
    started = true;
    this.setHighlight(parked ?? options.current);
  }

  private setHighlight(level: EffortLevel): void {
    if (this.highlighted === level) return;
    this.highlighted = level;
    if (level === "ultra") this.start();
    else this.stop();
  }

  private start(): void {
    this.stop();
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.panelTui.requestRender(), RIPPLE_FRAME_MS);
    // Node keeps the process alive for pending timers; a decorative one must
    // never be the reason pi refuses to exit.
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Called by hosts that dispose components; harmless if never invoked. */
  override dispose(): void {
    this.stop();
    super.dispose();
  }

  override setScreenOrigin(row: number, column: number): void {
    // The two blank rows above the title are outside the panel boundary.
    super.setScreenOrigin(row + 2, column);
  }

  /** Two blank rows above and below, so the panel is not crowded by the
   *  conversation above it or the editor below. They sit outside the rules,
   *  so the ripple never touches them. */
  private static pad(lines: string[]): string[] {
    return ["", "", ...lines, "", ""];
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (this.highlighted !== "ultra") return EffortSelector.pad(lines);

    // The ripple starts at the highlighted rung's caret. Row 3 is the track —
    // the middle of the three slider rows the panel renders between its title
    // and its caption — which is where that caret sits.
    const layout = sliderLayout([...this.levels], Math.max(1, width));
    const index = this.levels.indexOf("ultra");
    const column = layout?.ticks[index] ?? Math.max(0, Math.floor(width / 2));
    // The first and last rows are the panel's accent rules — its frame. Only
    // the rows between them are padded and painted to the same width, giving
    // the rightmost ultra origin a complete right half without colouring or
    // crossing the rules themselves.
    const interior = paintRipple(
      lines.slice(1, -1),
      Math.max(1, width),
      { column, row: 2 },
      Date.now() - this.startedAt,
    );
    return EffortSelector.pad([
      lines[0] as string,
      ...interior,
      lines.at(-1) as string,
    ]);
  }
}
