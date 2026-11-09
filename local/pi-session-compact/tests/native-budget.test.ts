import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager, createEventBus, type CompactionEntry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import sessionCompact from "../index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { deadlinePlan } from "../src/budget.ts";
import { generate, type Attempt } from "../src/generate.ts";
import { describeCompaction } from "../src/show.ts";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "fake", id: "native", api: "fake", name: "native", contextWindow: 200000, maxTokens: 32000, reasoning: false, input: ["text"], cost: usage.cost, baseUrl: "" };
function reply(text: string) {
  const stream = createAssistantMessageEventStream();
  const message = { role: "assistant", content: [{ type: "text", text }], api: "fake", provider: "fake", model: "native", usage, stopReason: "stop", timestamp: Date.now() } as AssistantMessage;
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

test("native omits an absent request limit, preserves explicit limits, and logs independent deadline estimates", async () => {
  for (const [requestLimit, metadata, estimate, source] of [
    [null, 32000, 32000, "model"], [1234, 32000, 1234, "request"],
    [null, undefined, 65536, "fallback"], [null, 0, 65536, "fallback"], [null, Infinity, 65536, "fallback"],
  ] as const) {
    const attempts: Attempt[] = [];
    let sentOptions: Record<string, unknown> = {};
    const ctx: any = { sessionManager: { getSessionId: () => "native-budget" }, ui: { notify() {} }, modelRegistry: { streamSimple(_m: unknown, _c: unknown, options: Record<string, unknown>) { sentOptions = options; return reply("NATIVE"); } } };
    await generate(ctx, DEFAULT_CONFIG, { ...model, maxTokens: metadata } as any, { messages: [] }, "off", new AbortController().signal, attempts, [], "native", "native", {}, async () => true, "none", undefined, undefined, requestLimit);
    assert.equal(Object.hasOwn(sentOptions, "maxTokens"), requestLimit !== null);
    if (requestLimit !== null) assert.equal(sentOptions.maxTokens, requestLimit);
    const attempt = JSON.parse(JSON.stringify(attempts[0])) as Attempt;
    assert.equal(attempt.outputTokenBudget, requestLimit);
    assert.equal(attempt.deadlineOutputTokens, estimate);
    assert.equal(attempt.deadlineOutputTokenSource, source);
    assert.equal(attempt.predictedDeadlineMs, deadlinePlan(attempt.inputTokens, estimate, undefined, "single").milliseconds);
    assert.ok(Number.isFinite(attempt.effectiveDeadlineMs));
    const entry = { type: "compaction", id: "c", timestamp: "2026-10-22", summary: "summary", firstKeptEntryId: "u", tokensBefore: 1 } as CompactionEntry;
    const shown = describeCompaction(entry, [entry], { adopted: { slot: "native" }, degraded: { attempts: [attempt] } });
    assert.ok(shown.includes(requestLimit === null ? "跟随模型（无请求级上限）" : "1,234 tokens"));
    assert.ok(shown.includes(source === "model" ? "模型元数据" : source === "fallback" ? "保守固定估计" : "请求上限"));
  }
});

const root = mkdtempSync(join(tmpdir(), "compact-native-budget-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent/pi-session-compact"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

test("Pi 1.5 native fallback leaves both split-turn limits unset and focuses history and turn prefix", async () => {
  writeFileSync(join(root, "agent/pi-session-compact/config.json"), JSON.stringify({ mode: "small", smallModel: { provider: "fake", id: "missing", effort: "off" }, outputTokens: 2048, summaryTokens: 8000 }));
  const sm = SessionManager.inMemory(root);
  sm.appendMessage({ role: "user", content: "history", timestamp: 1 });
  sm.appendMessage({ role: "user", content: "turn prefix", timestamp: 2 });
  const branch = sm.getBranch(), calls: Array<{ context: unknown; options: Record<string, unknown> }> = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerCommand() {}, events: createEventBus(), getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({ retry: { enabled: false } }) };
  const ctx: any = { model, cwd: root, thinkingLevel: "off", sessionManager: sm, abort() { assert.fail("native should succeed"); }, ui: { notify() {} }, modelRegistry: { find: () => undefined, streamSimple(_model: unknown, context: unknown, options: Record<string, unknown>) { calls.push({ context, options }); return reply("NATIVE"); } } };
  sessionCompact(pi);
  const result = await handlers.get("session_before_compact")!({ reason: "manual", branchEntries: branch, customInstructions: "FOCUS_BOTH_PARTS", signal: new AbortController().signal, preparation: { firstKeptEntryId: branch[1]!.id, messagesToSummarize: [branch[0]!.type === "message" && branch[0]!.message], turnPrefixMessages: [branch[1]!.type === "message" && branch[1]!.message], isSplitTurn: true, tokensBefore: 100, settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 1 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() } } }, ctx);
  assert.ok(result.compaction);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.options, "maxTokens"), false);
    assert.match(JSON.stringify(call.context), /Additional focus: .*FOCUS_BOTH_PARTS/);
  }
  const run = JSON.parse(readFileSync(join(root, "agent", result.compaction.details.runLog), "utf8"));
  assert.equal(run.adopted.slot, "native");
  assert.equal(run.degraded.nativeFocusScope, "history-and-turn-prefix");
  assert.equal(run.degraded.attempts.length, 2);
  assert.ok(run.degraded.attempts.every((a: Attempt) => a.outputTokenBudget === null && a.deadlineOutputTokens === model.maxTokens && a.deadlineOutputTokenSource === "model"));
  const entry = { type: "compaction", id: "c", timestamp: "2026-10-22", ...result.compaction } as CompactionEntry;
  assert.match(describeCompaction(entry, [entry], run), /原生重点范围：history-and-turn-prefix/);
});
