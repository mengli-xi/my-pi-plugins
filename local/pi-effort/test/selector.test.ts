import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import type { EffortLevel } from "../levels.ts";
import { EffortSelector, layoutSlider, levelPainter } from "../selector.ts";

/**
 * Styling is pi's job; most tests only care about layout and behaviour, so
 * this theme paints nothing — but it does report a distinct colour per level,
 * which is what keeps the slider on `theme.fg` instead of its own ramp.
 */
const THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (color: string) => color,
  getColorMode: () => "truecolor",
} as unknown as Theme;

/** A theme that paints every thinking level the same, as some real ones do. */
const FLAT_THEME = {
  ...THEME,
  getFgAnsi: () => "\x1b[38;5;242m",
} as unknown as Theme;

/** The commoner case: "off" is set apart and everything above it is one colour. */
const NEARLY_FLAT_THEME = {
  ...THEME,
  getFgAnsi: (color: string) => (color === "thinkingOff" ? "\x1b[38;5;238m" : "\x1b[38;5;242m"),
} as unknown as Theme;

const TUI_STUB = { requestRender() {} } as unknown as TUI;

const LEVELS: EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESCAPE = "\x1b";

function build(current: EffortLevel = "high", levels: EffortLevel[] = LEVELS, theme: Theme = THEME) {
  const selected: EffortLevel[] = [];
  let cancelled = false;
  const selector = new EffortSelector(TUI_STUB, theme, {
    levels,
    current,
    onSelect: (level) => selected.push(level),
    onCancel: () => {
      cancelled = true;
    },
  });
  return {
    selector,
    selected,
    cancelled: () => cancelled,
    lines: (width = 100) => selector.render(width),
    /** The column the caret sits on, and the level whose label starts there. */
    caret: (width = 100) => {
      const lines = selector.render(width);
      const track = lines.find((line) => line.includes("▲")) ?? "";
      const labels = lines[lines.indexOf(track) + 1] ?? "";
      const column = track.indexOf("▲");
      const words = labels.matchAll(/\S+/g);
      const under = [...words].find(
        (word) => column >= (word.index ?? 0) && column < (word.index ?? 0) + word[0].length,
      );
      return { column, label: under?.[0] };
    },
  };
}

test("labels are spread evenly and the block is centred", () => {
  const layout = layoutSlider(["low", "max", "off"], 60);
  assert.ok(layout);

  const [first, second, third] = layout.labelStarts;
  assert.equal((second as number) - (first as number), (third as number) - (second as number));
  // Equal margins either side, up to the odd column.
  const rightMargin = 60 - (layout.trackEnd + 1);
  assert.ok(Math.abs((first as number) - rightMargin) <= 1, `${first} vs ${rightMargin}`);
});

test("labels of different widths keep their order and never overlap", () => {
  const labels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const layout = layoutSlider(labels, 100);
  assert.ok(layout);

  for (let index = 1; index < labels.length; index++) {
    const previousEnd = (layout.labelStarts[index - 1] as number) + (labels[index - 1] as string).length;
    assert.ok((layout.labelStarts[index] as number) > previousEnd);
  }
});

test("the track spans the labels and each caret sits inside its own label", () => {
  const labels = ["off", "minimal", "max"];
  const layout = layoutSlider(labels, 60);
  assert.ok(layout);

  assert.equal(layout.trackStart, layout.labelStarts[0]);
  assert.equal(layout.trackEnd, (layout.labelStarts[2] as number) + 2);
  for (const [index, label] of labels.entries()) {
    const start = layout.labelStarts[index] as number;
    const tick = layout.ticks[index] as number;
    assert.ok(tick >= start && tick < start + label.length);
  }
});

test("a panel too narrow for the shortest gap has no layout", () => {
  assert.equal(layoutSlider(LEVELS, 40), undefined);
  assert.ok(layoutSlider(LEVELS, 60));
});

test("the panel names the setting, both ends, and every level in order", () => {
  const panel = build().lines().join("\n");

  assert.match(panel, /Effort/);
  assert.match(panel, /Faster {2,}Smarter/);
  assert.match(panel, /off {2,}minimal {2,}low {2,}medium {2,}high {2,}xhigh {2,}max/);
  assert.match(panel, /←\/→ adjust · Enter confirm · Esc cancel/);
});

test("the caret starts on the level in effect, over its label", () => {
  assert.equal(build("high").caret().label, "high");
  assert.equal(build("off").caret().label, "off");
  assert.equal(build("max").caret().label, "max");
});

test("the caption describes the level under the caret", () => {
  const panel = build("xhigh");
  assert.match(panel.lines().join("\n"), /Extra-deep reasoning \(~32k tokens\)/);

  panel.selector.handleInput(RIGHT);
  assert.match(panel.lines().join("\n"), /Maximum reasoning the model allows/);
});

test("arrows move the caret and clamp at both ends instead of wrapping", () => {
  const panel = build("high");
  panel.selector.handleInput(RIGHT);
  assert.equal(panel.caret().label, "xhigh");

  panel.selector.handleInput(RIGHT);
  panel.selector.handleInput(RIGHT);
  assert.equal(panel.caret().label, "max");

  for (let index = 0; index < LEVELS.length + 2; index++) panel.selector.handleInput(LEFT);
  assert.equal(panel.caret().label, "off");
});

test("a number key moves the caret without confirming", () => {
  const panel = build("off");
  panel.selector.handleInput("5");

  assert.equal(panel.caret().label, "high");
  assert.deepEqual(panel.selected, []);
});

test("enter confirms the level under the caret", () => {
  const panel = build("medium");
  panel.selector.handleInput(RIGHT);
  panel.selector.handleInput(ENTER);

  assert.deepEqual(panel.selected, ["high"]);
});

test("a theme with a colour per level is used as-is", () => {
  const painted: string[] = [];
  const theme = { ...THEME, fg: (color: string, text: string) => `<${color}>${text}` } as unknown as Theme;
  const paint = levelPainter(theme, LEVELS);

  for (const level of LEVELS) painted.push(paint(level, level));
  assert.deepEqual(painted.slice(0, 3), ["<thinkingOff>off", "<thinkingMinimal>minimal", "<thinkingLow>low"]);
});

test("a theme that paints every level alike falls back to the package's ramp", () => {
  const paint = levelPainter(FLAT_THEME, LEVELS);
  const codes = LEVELS.map((level) => paint(level, level).match(/\x1b\[[\d;]+m/)?.[0]);

  assert.equal(new Set(codes).size, LEVELS.length, `not all distinct: ${codes.join(" ")}`);
  for (const code of codes) assert.match(code ?? "", /^\x1b\[38;2;\d+;\d+;\d+m$/);
  assert.match(paint("max", "max"), /max\x1b\[39m$/);
});

test("a theme that only sets 'off' apart still falls back — half a gradient is none", () => {
  const paint = levelPainter(NEARLY_FLAT_THEME, LEVELS);
  const codes = LEVELS.map((level) => paint(level, level).match(/\x1b\[[\d;]+m/)?.[0]);

  assert.equal(new Set(codes).size, LEVELS.length);
});

test("a 256-colour terminal gets 256-colour codes", () => {
  const theme = { ...FLAT_THEME, getColorMode: () => "256color" } as unknown as Theme;
  const paint = levelPainter(theme, LEVELS);

  assert.match(paint("high", "high"), /^\x1b\[38;5;\d+mhigh\x1b\[39m$/);
});

test("the caret and its label change colour with the level", () => {
  const panel = build("low", LEVELS, FLAT_THEME);
  const before = panel.lines().join("\n").match(/\x1b\[[\d;]+m/)?.[0];

  panel.selector.handleInput(RIGHT);
  const after = panel.lines().join("\n").match(/\x1b\[[\d;]+m/)?.[0];

  assert.notEqual(before, after);
});

test("escape cancels without selecting", () => {
  const panel = build();
  panel.selector.handleInput(ESCAPE);

  assert.equal(panel.cancelled(), true);
  assert.deepEqual(panel.selected, []);
});

test("no row is wider than the panel it is drawn in", () => {
  for (const width of [120, 96, 80, 60, 44, 30, 20]) {
    for (const line of build("xhigh").lines(width)) {
      const visible = line.replace(/\x1b\[[\d;]*m/g, "").length;
      assert.ok(visible <= width, `width ${width}: row of ${visible} columns`);
    }
  }
});

test("a narrow panel keeps the level and the direction it can still move", () => {
  const panel = build("medium");
  const narrow = panel.lines(30).join("\n");

  assert.match(narrow, /◀ medium ▶/);
  // The caption is clipped to the panel rather than dropped.
  assert.match(narrow, /Moderate reasoning/);
  // And the key hints shrink rather than running off the edge.
  assert.match(narrow, /←\/→ adjust · Enter · Esc/);

  for (let index = 0; index < LEVELS.length; index++) panel.selector.handleInput(LEFT);
  assert.match(panel.lines(30).join("\n"), / {2}off ▶/);
});
