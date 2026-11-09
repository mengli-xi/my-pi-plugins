import assert from "node:assert/strict";
import test from "node:test";
import { ContributedRows } from "../src/statusline/extra-lines.ts";

// 直接发送 statusline:row 公开 DTO；不执行任何外部 producer/fallback 实现。
test("independent protocol contributors compose on row three and withdraw separately", () => {
  const rows = new ContributedRows();
  const first = { key: "fixture-side", line: "Side pending", placement: "inline", row: 3 };
  const second = { key: "fixture-btw", line: "BTW pending", placement: "inline", row: 3 };
  rows.handle(first);
  rows.handle(second);
  assert.deepEqual(rows.spliceInline(["project", "model", "todo"]).lines,
    ["project", "model", "todo │ Side pending │ BTW pending"]);
  rows.handle({ key: second.key, line: undefined });
  assert.deepEqual(rows.spliceInline(["project", "model", "todo"]).lines,
    ["project", "model", "todo │ Side pending"]);
  rows.handle({ key: first.key, line: undefined });
  assert.deepEqual(rows.spliceInline(["project", "model", "todo"]).lines,
    ["project", "model", "todo"]);
});
