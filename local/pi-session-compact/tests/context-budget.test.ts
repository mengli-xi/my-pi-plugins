import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionProjection, convertToLlm, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextTokens } from "../src/budget.ts";
import { boundedContextTokens, measuredRecoveryBound, retainedMessages } from "../src/preflight.ts";
import { restoredContext } from "../src/recovery.ts";
import { renderUserQuotations } from "../src/quotations.ts";
const user = (id: string, content: any): any => ({ type: "message", id, timestamp: "2026-10-27", message: { role: "user", content, timestamp: 1 } });
const chain = (entries: any[]): SessionEntry[] => entries.map((e, i) => ({ ...e, parentId: entries[i - 1]?.id ?? null }));
const usage = (totalTokens: number) => ({ input: totalTokens - 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (id: string, total: number): any => ({ type: "message", id, timestamp: "2026-10-27", message: { role: "assistant", content: [{ type: "text", text: "observed" }], timestamp: 2, api: "fake", provider: "p", model: "m", stopReason: "stop", usage: usage(total) } });

test("large base64 images in user/tool tail use Pi's fixed image estimate, not encoded bytes or details", () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "A".repeat(12_000_000) };
  const b = chain([user("gone", "old"), user("tail", [image]), { type: "message", id: "tool", timestamp: "t", message: { role: "toolResult", toolName: "read", toolCallId: "read", content: [{ type: "text", text: "tool text" }, image], details: { raw: "A".repeat(6_000_000) }, timestamp: 3 } }]);
  assert.equal(estimateTokens({ role: "user", content: [image], timestamp: 1 }), 1200);
  const result = restoredContext(b, { summary: "handoff", firstKeptEntryId: "tail", tokensBefore: 0 }, 20000, { reserveTokens: 2000 });
  assert.ok(result.fits); assert.ok(result.estimated.total < 3000, JSON.stringify(result.estimated));
  assert.equal(result.estimated.retainedRecent, 2403);
  assert.equal(contextTokens(convertToLlm(buildSessionProjection(b).messages)), 2404);
});
test("unchanged retained text can use a whole measured context upper bound without moving the cut", () => {
  const b = chain([user("tail", "x".repeat(1_200_000)), assistant("usage", 100000)]);
  const bound = measuredRecoveryBound(b, { provider: "p", id: "m" }, undefined, { leafId: "tail", messages: convertToLlm(buildSessionProjection(b).messages).slice(0, 1) });
  assert.equal(bound?.tokens, 100000);
  const result = { summary: "handoff", firstKeptEntryId: "tail", tokensBefore: 0 };
  assert.equal(restoredContext(b, result, 200000, { reserveTokens: 20000 }).fits, false);
  const gated = restoredContext(b, result, 200000, { reserveTokens: 20000, bound });
  assert.ok(gated.fits); assert.equal(result.firstKeptEntryId, "tail");
  assert.equal(gated.estimated.retainedRecent, 100002);
  assert.match(gated.estimated.method, /provider-upper-bound/);
});
test("reported usage accepts an ancestor plus Pi-estimated trailing input and rejects edits, models and other branches", () => {
  const b = chain([user("tail", "original"), assistant("usage", 0), user("new", "new text")]);
  const report = { leaf: "usage", usage: usage(100000) };
  const capture = { leafId: "tail", messages: convertToLlm(buildSessionProjection(b).messages).slice(0, 1) };
  const bound = measuredRecoveryBound(b, { provider: "p", id: "m" }, report, capture);
  assert.equal(bound?.tokens, 100000); assert.equal(bound?.evidence, "reported");
  assert.equal(measuredRecoveryBound(b, { provider: "p", id: "other" }, report, capture), undefined);
  assert.equal(measuredRecoveryBound(b, { provider: "p", id: "m" }, { ...report, leaf: "other-branch" }, capture), undefined);
  const edited = chain([...b, { type: "context_edit", id: "edit", timestamp: "t", targetId: "tail", replacement: { content: "replacement" } }]);
  assert.equal(measuredRecoveryBound(edited, { provider: "p", id: "m" }, report, capture), undefined);
  assert.equal(measuredRecoveryBound(b, { provider: "p", id: "m" }, { ...report, usage: usage(0) }, capture), undefined);
});
test("a capture extends the measured bound using only its trailing actual messages", () => {
  const b = chain([user("tail", "original"), assistant("usage", 100000)]);
  const prefix = convertToLlm(buildSessionProjection(b).messages).slice(0, 1);
  const bound = measuredRecoveryBound(b, { provider: "p", id: "m" }, undefined, { leafId: "tail", messages: prefix });
  assert.equal(bound?.tokens, 100000); assert.equal(bound?.evidence, "capture");
});
test("request-stage upper bound covers only identical retained messages; new/edited/duplicate owner material remains charged", () => {
  const b = chain([user("tail", "x".repeat(1_200_000)), assistant("usage", 100000)]);
  const tail = retainedMessages(b, "tail"), bound = measuredRecoveryBound(b, { provider: "p", id: "m" }, undefined, { leafId: "tail", messages: retainedMessages(b, "tail").slice(0, 1) });
  const summary = { role: "user" as const, content: "new handoff", timestamp: 4 };
  const actual = [summary, ...tail];
  assert.equal(boundedContextTokens(actual, tail, bound).total, 100005);
  const extra = { role: "user" as const, content: "LATE".repeat(300000), timestamp: 5 };
  assert.equal(boundedContextTokens([...actual, extra], tail, bound).total, 400005);
  assert.ok(boundedContextTokens([summary, { ...tail[0]!, content: extra.content } as any, tail[1]!], tail, bound).total > 300000);
  assert.equal(boundedContextTokens([...actual, tail[0]!], tail, bound).total, 400005);
});
test("user appendix has a single heading and separator-only message boundaries, with QA question/answer intact", () => {
  const rendered = renderUserQuotations({ version: 1, items: [{ kind: "user", text: "first\n\nraw" }, { kind: "user", text: "second" }, { kind: "qa", text: "问题：发布吗？\n回答：不发布" }] });
  assert.equal(rendered, "\n\n## 所有用户消息\n\nfirst\n\nraw\n\n---\n\nsecond\n\n---\n\n问题：发布吗？\n回答：不发布");
  assert.doesNotMatch(rendered, /用户消息：|结构化问答：/);
});


test("embedded recovery is counted exactly once by the actual summary projection", () => {
  const b = chain([user("gone", "old"), user("tail", "tail")]);
  const appendix = "\n\n## 压缩恢复内容\n\n### pi-skills (pi-skills:compact-restored-v1)\n\n" + "FULL_RULES ".repeat(2000);
  const result = { summary: "handoff" + appendix, firstKeptEntryId: "tail", tokensBefore: 0 };
  const checkpoint: any = { type: "compaction", id: "c", parentId: "tail", timestamp: "t", ...result };
  const expected = contextTokens(convertToLlm(buildSessionProjection([...b, checkpoint], "c").messages));
  const actual = restoredContext(b, result, 200000, { recoveryAppendix: appendix });
  assert.equal(actual.estimated.total, expected);
  assert.equal(actual.estimated.retainedRecent, 1);
  assert.ok(actual.estimated.recoveryPackage > 4000);
});
