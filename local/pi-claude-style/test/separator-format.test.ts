import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKING } from "../src/config.ts";
import {
  formatRunDividerText,
  formatTurnDividerText,
} from "../src/separator-format.ts";

test("formats Codex-style run divider with duration and statistics", () => {
  const text = formatRunDividerText(
    {
      status: "done",
      phase: "idle",
      elapsedMs: 28_000,
      inputTokens: 8_300,
      outputTokens: 450,
      outputEstimated: false,
      tps: 68,
      tpsEstimated: false,
      ttftMs: 1_200,
      thinkingMs: 9_000,
      turnCount: 4,
      endedAt: new Date(2026, 7, 7, 9, 5, 3).getTime(),
    },
    DEFAULT_WORKING,
    new Date(2026, 7, 7, 12).getTime(),
  );
  assert.equal(
    text,
    "✓ done at 09:05:03 · took 28.0s · ↑8.3k ↓450 · 68.0t/s · first 1.2s · thought 9.0s · 4 turns",
  );
});

test("run dividers include the date after local midnight", () => {
  const endedAt = new Date(2026, 7, 7, 23, 59, 59).getTime();
  const text = formatRunDividerText(
    {
      status: "done",
      phase: "idle",
      elapsedMs: 1_000,
      outputEstimated: false,
      tpsEstimated: false,
      turnCount: 1,
      endedAt,
    },
    DEFAULT_WORKING,
    new Date(2026, 7, 8, 0, 0, 1).getTime(),
  );
  assert.match(text, /^✓ done at 2026-08-07 23:59:59 · took 1\.0s/u);
});

test("formats optional turn number", () => {
  assert.equal(formatTurnDividerText(2, true), "Turn 2");
  assert.equal(formatTurnDividerText(2, false), "");
});
