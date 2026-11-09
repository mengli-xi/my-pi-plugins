import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  cacheHistoryPanelContent,
  formatCacheQualitySegment,
  renderCacheHistory,
} from "../../src/statusline/cache-panel.ts";
import { analyzeCacheHistory } from "../../src/statusline/cache-history.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const theme = {
  fg: (color: string, text: string) => `\x1b[3${color.length % 8}m${text}\x1b[39m`,
} as unknown as Theme;
const gradedTheme = {
  fg: (color: string, text: string) => {
    const code = { error: 31, warning: 33, accent: 36, success: 32, muted: 90, dim: 90 }[color] ?? 37;
    return `\x1b[${code}m${text}\x1b[0m`;
  },
} as unknown as Theme;

function assistant(
  id: string,
  timestamp: number,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  model = "model-a",
) {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      stopReason: "stop",
      timestamp,
      provider: "provider-a",
      model,
      usage: { input, cacheRead, cacheWrite, output: 1, totalTokens: 1, cost: {} },
    },
  };
}

test("renders active-branch summary, fixed-scale trends, and wide request rows", () => {
  const snapshot = analyzeCacheHistory([
    assistant("a", 1_000, 2_000, 8_000, 0),
    assistant("b", 400_000, 1_000, 9_000, 0, "model-b"),
  ]);
  const plain = renderCacheHistory(snapshot, 110, theme)
    .map((line) => line.replace(ANSI, ""));
  assert.equal(plain[0], "Active branch · 2 requests");
  assert.ok(plain.some((line) => line.startsWith("CH  ")));
  assert.ok(plain.some((line) => line.startsWith("RU  ")));
  const requestRows = plain.filter((line) => /^#\d/.test(line));
  assert.match(requestRows[0] ?? "", /#2\s+model-b\(provider-a\)/);
  assert.ok(plain.some((line) => /model changed, idle 6m/.test(line)));
  assert.ok(plain.every((line) => line.length <= 110));
});

test("grades reuse percentages in wide and narrow request rows", () => {
  const snapshot = analyzeCacheHistory([
    assistant("a", 1_000, 2_000, 8_000, 0),
    assistant("b", 2_000, 1_500, 8_500, 0),
    assistant("c", 3_000, 800, 9_200, 0),
    assistant("d", 4_000, 300, 9_700, 0),
    assistant("e", 5_000, 50, 9_950, 0),
  ]);

  const wide = renderCacheHistory(snapshot, 120, gradedTheme).join("\n");
  assert.match(wide, /\x1b\[90m\s+—\x1b\[0m/);
  assert.match(wide, /\x1b\[31m\s+85\.0%\x1b\[0m/);
  assert.match(wide, /\x1b\[33m\s+92\.0%\x1b\[0m/);
  assert.match(wide, /\x1b\[36m\s+97\.0%\x1b\[0m/);
  assert.match(wide, /\x1b\[32m\s+99\.5%\x1b\[0m/);

  const narrow = renderCacheHistory(snapshot, 70, gradedTheme).join("\n");
  assert.match(narrow, /RU \x1b\[31m85\.0%\x1b\[0m/);
  assert.match(narrow, /RU \x1b\[32m99\.5%\x1b\[0m/);
});

test("keeps every summary and detail line inside a narrow panel", () => {
  const snapshot = analyzeCacheHistory([
    assistant("a", 1_000, 2_000, 8_000, 0, "an-extremely-long-model-name-that-must-be-clipped"),
    assistant("b", 2_000, 1_000, 9_000, 0),
  ]);
  const width = 32;
  const plain = renderCacheHistory(snapshot, width, theme)
    .map((line) => line.replace(ANSI, ""));
  assert.ok(plain.every((line) => [...line].length <= width));
});

test("uses two-line request rows when the panel is narrow", () => {
  const snapshot = analyzeCacheHistory([
    assistant("a", 1_000, 2_000, 8_000, 0),
    assistant("b", 2_000, 1_000, 9_000, 0),
  ]);
  const plain = renderCacheHistory(snapshot, 55, theme)
    .map((line) => line.replace(ANSI, ""));
  assert.ok(plain.some((line) => line.startsWith("#2 model-a(provider-a)")));
  assert.ok(plain.some((line) => line.startsWith("  P 10.0k · I 1.0k · R 9.0k")));
  assert.ok(plain.every((line) => line.length <= 55));
});

test("panel keeps a plain copy source and a width-aware renderer", () => {
  const snapshot = analyzeCacheHistory([assistant("a", 1_000, 2_000, 8_000, 0)]);
  const panel = cacheHistoryPanelContent(snapshot);
  assert.equal(panel.title, "Prompt cache");
  assert.match(panel.body, /Active branch · 1 request/);
  assert.equal(typeof panel.renderBody, "function");
  assert.match(panel.renderBody?.(80, theme).map((line) => line.replace(ANSI, "")).join("\n") ?? "", /CH 80.0%/);
});

test("cache quality segment preserves established CH, RU, and miss tones", () => {
  const segment = formatCacheQualitySegment({
    hit_percent: 19,
    reuse_percent: 94,
    miss_tokens: 12_345,
    prev_prompt_tokens: 20_000,
    latest_prompt_tokens: 21_000,
  });
  assert.equal(segment?.replace(ANSI, ""), "CH:19.0%·RU:94.0%·M:12.3k");
  assert.match(segment ?? "", /\x1b\[31mCH:/);
  assert.match(segment ?? "", /\x1b\[33mRU:/);
  assert.match(segment ?? "", /\x1b\[31mM:/);
});
