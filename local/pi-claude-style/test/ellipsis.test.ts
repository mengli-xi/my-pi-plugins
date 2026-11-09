import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  colorWithMutedEllipses,
  fitTextRows,
  truncateWithMutedEllipsis,
} from "../src/ellipsis.ts";

function recordingTheme(colors: string[]): Theme {
  return {
    fg: (color: string, text: string) => {
      colors.push(color);
      return text;
    },
  } as unknown as Theme;
}

test("all semantic and truncation ellipses use the shared dim tone", () => {
  const colors: string[] = [];
  const theme = recordingTheme(colors);

  assert.equal(
    colorWithMutedEllipses(theme, "text", "Waiting... then more…"),
    "Waiting... then more…",
  );
  assert.equal(
    truncateWithMutedEllipsis("abcdefgh", 5, theme)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
    "abcd…",
  );
  assert.deepEqual(colors, ["text", "dim", "text", "dim", "dim"]);
});

test("bounded wrapping keeps at most two rows and reserves a suffix", () => {
  const rows = fitTextRows(
    "a command with enough detail to continue beyond the row budget",
    24,
    2,
    7,
  );

  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.length <= 24);
  assert.ok(rows[1]!.length <= 17);
  assert.match(rows[1]!, /…$/);
});

test("suffix reserve applies when text fits only the unreserved first row", () => {
  const text = "x".repeat(20);
  const rows = fitTextRows(text, 20, 2, 7);

  assert.equal(rows.length, 2);
  assert.equal(rows.join(""), text);
  assert.ok(rows[1]!.length <= 13);
});
