import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionStatus, compactionStatusLine, compactionStatusPayload, shortTokens } from "../src/status.ts";
import { WINDOW_ENTRY } from "../src/window.ts";

const paint = (tone: string, text: string) => `<${tone}>${text}</${tone}>`;

test("CP shows completed compactions only, CT only with a session window, and a native fallback paints CP:N! in warning", () => {
  assert.equal(compactionStatusLine({ count: 0, native: false }, paint), undefined);
  assert.equal(compactionStatusLine({ count: 3, native: false }, paint), "<dim>CP:3</dim>");
  assert.equal(compactionStatusLine({ count: 3, native: true }, paint), "<warning>CP:3!</warning>");
  assert.equal(compactionStatusLine({ count: 0, native: false, threshold: 235800 }, paint), "<dim>CT:236k</dim>");
  assert.equal(compactionStatusLine({ count: 2, native: true, threshold: 235800 }, paint), "<warning>CP:2!</warning><dim>·</dim><dim>CT:236k</dim>");
  for (const [value, text] of [[900, "900"], [18000, "18k"], [235800, "236k"], [999_499, "999k"], [999_500, "1m"], [1_350_000, "1.4m"]] as const) assert.equal(shortTokens(value), text, String(value));
});

test("status reads the active branch: every compaction counts, the latest decides the native mark, CT is 90% of the clamped window", () => {
  const compaction = (id: string, generator?: string, fromHook = true) => ({ type: "compaction", id, fromHook, details: generator ? { generator } : undefined });
  const window = (id: string, tokens: number | null) => ({ type: "custom", id, customType: WINDOW_ENTRY, data: { version: 1, tokens } });
  assert.deepEqual(compactionStatus([] as never, 200000), { count: 0, native: false });
  assert.deepEqual(compactionStatus([compaction("a", "pi-native"), compaction("b", "pi-session-compact")] as never, 200000), { count: 2, native: false });
  assert.deepEqual(compactionStatus([compaction("a"), compaction("b", "pi-native")] as never, 200000), { count: 2, native: true });
  // The hook threw before answering, so Pi summarized by itself: no generator, fromHook false.
  assert.deepEqual(compactionStatus([compaction("a", "pi-session-compact"), compaction("b", undefined, false)] as never, 200000), { count: 2, native: true });
  assert.deepEqual(compactionStatus([window("w", 262000)] as never, 400000), { count: 0, native: false, threshold: 235800 });
  assert.equal(compactionStatus([window("w", 262000)] as never, 128000).threshold, 115200, "a smaller model window clamps the effective window");
  assert.equal(compactionStatus([window("w", 262000), window("x", null)] as never, 400000).threshold, undefined, "off removes CT");
});

test("the segment is inline on row 2, left-aligned", () => {
  const onClick = () => true;
  assert.deepEqual(compactionStatusPayload("CP:1", onClick), { key: "compaction", line: "CP:1", placement: "inline", row: 2, align: "left", order: 10, onClick });
});
