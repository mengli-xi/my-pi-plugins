import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSticky, summarise } from "../src/host/fullscreen/sticky.ts";
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

test("the header fills the width with a rule and says it can be clicked", () => {
  const line = strip(renderSticky("再看看主题", 60));
  assert.match(line, /^▲ 再看看主题 ─+ click to jump ─$/);
});

test("a narrow frame drops the hint rather than truncating it", () => {
  // "click to ju…" would read as part of the message instead of a control.
  const line = strip(renderSticky("再看看主题", 24));
  assert.match(line, /^▲ 再看看主题 ─+$/);
  assert.equal(line.includes("click"), false);
});

test("a message too long for the row is truncated, not wrapped", () => {
  const line = strip(renderSticky("很".repeat(200), 30));
  assert.equal(line.includes("\n"), false);
  assert.ok(line.startsWith("▲ "));
  // Full-width characters count as two columns, so the budget is in columns.
  assert.ok(line.length <= 30, `渲染出 ${line.length} 个字符`);
});

test("a zero-width frame renders nothing rather than throwing", () => {
  assert.equal(renderSticky("任何内容", 0), "");
});

test("sticky summary flattens Markdown and skips code-only questions", () => {
  assert.equal(summarise("## Title\n- One\n```ts\nconst x = 1;\n```"), "Title One");
  assert.equal(summarise("```sh\nnpm test\n```"), "");
});
