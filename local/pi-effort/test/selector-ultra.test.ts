import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

import { EffortSelector } from "../selector.ts";
import { supportedLevels } from "../levels.ts";
import {
  paintRippleLine,
  rippleDistance,
  rippleStep,
  RIPPLE_WAVELENGTH,
  VIOLET_STEPS,
} from "../ripple.ts";

const THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (color: string) => color,
  getColorMode: () => "truecolor",
} as unknown as Theme;

function tuiStub() {
  let renders = 0;
  return {
    tui: { requestRender: () => renders++ } as unknown as TUI,
    renders: () => renders,
  };
}

const LEVELS = supportedLevels({
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
});

function make(
  current = "medium" as const,
  onSelect: (level: string) => void = () => {},
  onCancel: () => void = () => {},
) {
  const host = tuiStub();
  const selector = new EffortSelector(host.tui, THEME, {
    levels: LEVELS,
    current,
    onSelect,
    onCancel,
  });
  return { selector, host };
}

/** Count cells carrying a background escape — i.e. cells the wave has reached. */
function litCells(line: string): number {
  return (line.match(/\x1b\[48;2;/g) ?? []).length;
}

function litColumns(line: string): number[] {
  const columns: number[] = [];
  let column = 0;
  let index = 0;
  let lit = false;
  while (index < line.length) {
    if (line[index] === "\x1b") {
      const end = line.indexOf("m", index);
      if (end < 0) break;
      const code = line.slice(index, end + 1);
      if (code.startsWith("\x1b[48;2;")) lit = true;
      else if (code === "\x1b[49m") lit = false;
      index = end + 1;
      continue;
    }
    const character = String.fromCodePoint(line.codePointAt(index)!);
    if (lit) columns.push(column);
    column += visibleWidth(character);
    index += character.length;
  }
  return columns;
}

test("the gradient runs dark violet to bright violet in eight steps", () => {
  assert.equal(VIOLET_STEPS.length, 8);
  assert.deepEqual(VIOLET_STEPS[0], [62, 22, 118]);
  assert.deepEqual(VIOLET_STEPS[7], [140, 80, 240]);
});

test("rows count double, so the rings are circles on a terminal grid", () => {
  // Two rows away must read as four columns away.
  assert.equal(rippleDistance(0, 2, 0, 0), 4);
  assert.equal(rippleDistance(4, 0, 0, 0), 4);
  assert.equal(rippleDistance(3, 2, 0, 0), 5);
});

test("cells ahead of the wavefront are left alone, and rings repeat", () => {
  assert.equal(rippleStep(30, 10), null, "beyond the front: untouched");
  assert.equal(rippleStep(10, 10), VIOLET_STEPS.length - 1, "at the front: brightest");
  // One wavelength back is the same point in the cycle.
  assert.equal(rippleStep(10 - RIPPLE_WAVELENGTH, 10), rippleStep(10, 10));
  assert.equal(rippleStep(10 - RIPPLE_WAVELENGTH / 2, 10), 0, "half a wave back: darkest");
});

test("painting fills the framed interior width without changing foreground", () => {
  const line = `\x1b[31mred\x1b[39m`;
  const painted = paintRippleLine(line, 6, () => 3);
  assert.ok(painted.includes("\x1b[31m"), "the original foreground survives");
  assert.ok(painted.includes("\x1b[39m"), "and so does its reset");
  assert.equal(visibleWidth(painted), 6, "the short row reaches the frame edge");
  assert.equal(litCells(painted), 6, "text and padded cells both carry the wave");
  assert.ok(!painted.includes("\x1b[39m\x1b[39m"), "no foreground was reset by the painter");

  const blank = paintRippleLine("", 6, () => 3);
  assert.equal(visibleWidth(blank), 6, "an empty interior row still spans the frame");
  assert.equal(litCells(blank), 6);
  assert.equal(
    paintRippleLine(line, 6, () => null),
    `${line}   `,
    "unreached padding stays visually blank",
  );
});

test("the panel is padded with two blank rows at each end", () => {
  const { selector } = make();
  const lines = selector.render(60);
  assert.deepEqual(lines.slice(0, 2), ["", ""]);
  assert.deepEqual(lines.slice(-2), ["", ""]);
  assert.ok((lines[2] ?? "").includes("Effort"), "the title rule follows the padding");
  selector.dispose();
});

test("the panel ripples only while ultra is highlighted", () => {
  const { selector } = make();
  const plain = selector.render(60);
  assert.equal(plain.reduce((sum, line) => sum + litCells(line), 0), 0);

  selector.handleInput("\x1b[F"); // end → ultra, the last rung
  const lit = selector.render(60);
  assert.equal(lit.length, plain.length, "the ripple paints rows, it does not add any");
  assert.ok(lit.some((line) => litCells(line) > 0), "and something is lit");

  selector.handleInput("\x1b[H"); // home → back to the cheapest rung
  assert.equal(selector.render(60).reduce((sum, line) => sum + litCells(line), 0), 0);
  selector.dispose();
});

test("the ripple stays inside the panel's rules", async () => {
  const { selector } = make("ultra" as never);
  // Long enough for the wavefront to have swept well past every row.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const painted = selector.render(80);
  // Two blank rows pad each end; the rules sit just inside them.
  assert.deepEqual(painted.slice(0, 2), ["", ""], "blank rows above");
  assert.deepEqual(painted.slice(-2), ["", ""], "and below");
  assert.equal(litCells(painted[2] as string), 0, "the title rule keeps its own colour");
  assert.equal(litCells(painted.at(-3) as string), 0, "and so does the footer rule");
  assert.ok(
    painted.slice(3, -3).some((line) => litCells(line) > 0),
    "while the interior is washed",
  );
  const frame = visibleWidth(painted[2] as string);
  assert.ok(
    painted.slice(3, -3).every((line) => visibleWidth(line) === frame),
    "every row between the rules reaches both frame edges",
  );
  assert.ok(
    painted.every((line) => visibleWidth(line) <= frame),
    `no row is wider than the frame (${frame}): ${painted.map(visibleWidth).join(",")}`,
  );
  const track = painted[5] as string;
  const origin = 71;
  const lit = litColumns(track);
  assert.ok(lit.some((column) => column < origin), "the left half is visible");
  assert.ok(lit.some((column) => column > origin), "the right half is visible");
  selector.dispose();
});

test("the wave spreads over time and asks for renders", async () => {
  const { selector, host } = make("ultra" as never);
  const early = selector.render(60).reduce((sum, line) => sum + litCells(line), 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const later = selector.render(60).reduce((sum, line) => sum + litCells(line), 0);
  assert.ok(later > early, `the lit area grows (${early} → ${later})`);
  assert.ok(host.renders() > 0, "the timer drives the panel");
  selector.dispose();
});

test("leaving the panel stops the timer", async () => {
  let selected: string | undefined;
  const { selector, host } = make("ultra" as never, (level) => {
    selected = level;
  });
  selector.handleInput("\r");
  assert.equal(selected, "ultra");

  const settled = host.renders();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(host.renders(), settled, "no renders requested after the panel closed");
});

test("re-entering ultra restarts the ripple from the origin", async () => {
  const { selector } = make("ultra" as never);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const grown = selector.render(60).reduce((sum, line) => sum + litCells(line), 0);

  selector.handleInput("\x1b[H"); // leave
  selector.handleInput("\x1b[F"); // and come back
  const restarted = selector.render(60).reduce((sum, line) => sum + litCells(line), 0);
  assert.ok(restarted < grown, `the wave starts over (${grown} → ${restarted})`);
  selector.dispose();
});
