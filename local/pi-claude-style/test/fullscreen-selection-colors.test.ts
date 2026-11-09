import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { highlightSelectionColors } from "../src/host/fullscreen/selection-colors.ts";

const palette = "\x1b[48;5;237m\x1b[38;5;252m";

test("selection exit restores color switches within the selected text", () => {
  const selected = "\x1b[31;44mred\x1b[38;2;10;20;30;48;5;42mgreen";
  assert.ok(highlightSelectionColors(selected, palette).endsWith(
    "green\x1b[0m\x1b[31;44m\x1b[38;2;10;20;30;48;5;42m",
  ));
});

test("selection exit retains full reset followed by a new background", () => {
  const selected = "\x1b[31;44mred\x1b[0mplain\x1b[45mend";
  assert.ok(highlightSelectionColors(selected, palette).endsWith(
    "end\x1b[0m\x1b[31;44m\x1b[0m\x1b[45m",
  ));
  assert.ok(highlightSelectionColors("\x1b[31mred\x1b[0mplain", palette)
    .endsWith("plain\x1b[0m\x1b[31m\x1b[0m"));
});

test("native slices carry colors from before the selection into exit restoration", () => {
  const line = "\x1b[93;104mprefix selected suffix";
  const selected = sliceByColumn(line, 7, 8, true);
  const after = sliceByColumn(line, 15, 7, true);
  assert.equal(selected, "\x1b[93;104mselected");
  assert.ok((highlightSelectionColors(selected, palette) + after)
    .endsWith("selected\x1b[0m\x1b[93;104m\x1b[93;104m suffix"));
});

test("wide character boundaries preserve the native slice and its exit colors", () => {
  const line = "\x1b[31;44m中\x1b[32;45m文AB";
  for (const [start, length, glyph, restored] of [
    [0, 2, "中", "\x1b[31;44m"],
    [2, 2, "文", "\x1b[31;44m\x1b[32;45m"],
    [1, 3, "文", "\x1b[31;44m\x1b[32;45m"],
  ] as const) {
    const selected = sliceByColumn(line, start, length, true);
    const highlighted = highlightSelectionColors(selected, palette);
    assert.equal(visibleWidth(highlighted), 2);
    assert.ok(highlighted.endsWith(`${glyph}\x1b[0m${restored}`));
  }
});
