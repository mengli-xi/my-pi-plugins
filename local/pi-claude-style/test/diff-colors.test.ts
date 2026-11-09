import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_DIFF } from "../src/config.ts";
import {
  formatWrappedDiffLines,
  paintDiffLine,
  wrappedDiffLineKind,
} from "../src/diff-colors.ts";

const E = "\u001b";
const COLORS = {
  enabled: true,
  addedBg: 22,
  removedBg: 52,
  addedHighlightBg: 28,
  removedHighlightBg: 88,
};

const plain = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

test("a removed row is backed by the removed colour, an added row by the added one", () => {
  assert.equal(paintDiffLine("-250 old", COLORS), `${E}[48;5;52m-250 old${E}[49m`);
  assert.equal(paintDiffLine("+250 new", COLORS), `${E}[48;5;22m+250 new${E}[49m`);
});

test("changed runs use separate stronger colours, then hand their row back", () => {
  // Pi marks changed words with reverse video; that has to become a real
  // background or the run is whatever the terminal decides to invert to.
  const painted = paintDiffLine(`+250 ne${E}[7mw${E}[27m tail`, COLORS);
  assert.equal(painted, `${E}[48;5;22m+250 ne${E}[48;5;28mw${E}[48;5;22m tail${E}[49m`);
  assert.ok(!painted.includes(`${E}[7m`), "no reverse video survives");

  const removed = paintDiffLine(`-250 ol${E}[7md${E}[27m tail`, COLORS);
  assert.equal(removed, `${E}[48;5;52m-250 ol${E}[48;5;88md${E}[48;5;52m tail${E}[49m`);
});

test("a changed row fills the requested content width", () => {
  const painted = paintDiffLine("+1 new", COLORS, 12);
  assert.equal(painted, `${E}[48;5;22m+1 new      ${E}[49m`);
  assert.equal(visibleWidth(painted), 12);
});

test("wrapped continuations inherit their source row but not a context row", () => {
  const lines = ["+1 a long", "continuation", " 2 context", "ordinary"];
  assert.equal(wrappedDiffLineKind(lines, 1), "added");
  assert.equal(wrappedDiffLineKind(lines, 3), undefined);
});

test("logical rows indent continuations by the complete widest gutter", () => {
  assert.deepEqual(
    formatWrappedDiffLines(["+  7 abcdefghijk", "+250 z"], 8),
    ["+  7 abc", "     def", "     ghi", "     jk", "+250 z"],
  );
});

test("hard wrapping preserves code whitespace and ambiguous diff-like text", () => {
  const logical = "+250     nested  -123 @@ --- +456  ";
  const lines = formatWrappedDiffLines([logical], 12);
  assert.ok(lines);
  assert.ok(lines.slice(1).every((line) => line.startsWith("     ")));
  assert.equal(
    lines.map(plain).map((line, index) => index === 0 ? line : line.slice(5)).join(""),
    logical,
  );
});

test("hanging diff wraps preserve ANSI, graphemes, and row width", () => {
  const logical = `+250 ${E}[32m中🙂  abcdef${E}[39m`;
  const lines = formatWrappedDiffLines([logical], 9);
  assert.ok(lines);
  assert.ok(lines.every((line) => visibleWidth(line) <= 9));
  assert.equal(
    lines.map(plain).map((line, index) => index === 0 ? line : line.slice(5)).join(""),
    plain(logical),
  );
  assert.ok(lines.slice(1).every((line) => line.includes(`${E}[32m`)));
});

test("a terminal that cannot preserve the complete gutter declines formatting", () => {
  assert.equal(formatWrappedDiffLines(["+250 abc"], 5), undefined);
  assert.equal(formatWrappedDiffLines(["+250 中🙂"], 1), undefined);
  assert.equal(formatWrappedDiffLines(["+  7 中中"], 5), undefined);
});

test("OSC 8 hyperlinks close at every physical row boundary", () => {
  const open = `${E}]8;;https://example.com\u0007`;
  const close = `${E}]8;;\u0007`;
  const lines = formatWrappedDiffLines(
    [`+250 ${open}linked-text-long${close} tail`],
    10,
  );
  assert.ok(lines && lines.length > 1);
  for (const line of lines!) {
    let openState = false;
    for (const match of line.matchAll(/\u001b\]8;;([^\u0007]*)\u0007/g)) {
      openState = (match[1]?.length ?? 0) > 0;
    }
    assert.equal(openState, false, `hyperlink leaked from ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(line) <= 10);
  }
});

test("rows that are neither an addition nor a removal are returned untouched", () => {
  for (const line of [" 251 context", "", "@@ -1,4 +1,4 @@", `${E}[2mheader${E}[22m`]) {
    assert.equal(paintDiffLine(line, COLORS), line);
  }
});

test("painting changes no visible character", () => {
  for (const line of ["-250 old", `+250 ne${E}[7mw${E}[27m tail`, " 251 context"]) {
    const painted = paintDiffLine(line, COLORS);
    assert.equal(plain(painted), plain(line));
    assert.equal(visibleWidth(painted), visibleWidth(line));
  }
});

test("a reset mid-row re-arms the background, one at the end does not", () => {
  const painted = paintDiffLine(`-250 a${E}[0mb`, COLORS);
  assert.ok(
    painted.includes(`${E}[0m${E}[48;5;52m`),
    "a reset with text after it must not leave a gap in the background",
  );
  // The only \u001b[49m is the one closing the row.
  assert.equal(painted.match(/\u001b\[49m/g)?.length, 1);
  assert.ok(painted.endsWith(`${E}[49m`));
});

test("disabled leaves every row exactly as pi drew it", () => {
  const line = `+250 ne${E}[7mw${E}[27m`;
  assert.equal(paintDiffLine(line, { ...COLORS, enabled: false }), line);
});

test("the shipped defaults are the colours the theme was tuned for", () => {
  assert.deepEqual(DEFAULT_DIFF, {
    enabled: true,
    addedBg: 22,
    removedBg: 52,
    addedHighlightBg: 28,
    removedHighlightBg: 88,
  });
});
