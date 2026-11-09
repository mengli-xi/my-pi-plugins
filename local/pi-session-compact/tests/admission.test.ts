import { test } from "node:test";
import assert from "node:assert/strict";
import { convertToLlm, buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { mainAdmission, routesToSmall } from "../src/main.ts";
import { generate, type Attempt, type RequestRecord } from "../src/generate.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { contextTokens, textTokens } from "../src/budget.ts";

const W = 128000, usage = (total: number) => ({ input: total - 4, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
// Pi estimates about 125k tokens; the provider measured 115.3k.
const large = "word ".repeat(100000);
function branch(withUsage: boolean, editAfter = false): SessionEntry[] {
  const entries: any[] = [
    { type: "message", id: "s", parentId: null, timestamp: "t", message: { role: "system", content: "system", timestamp: 1 } },
    { type: "message", id: "u", parentId: "s", timestamp: "t", message: { role: "user", content: large, timestamp: 2 } },
    { type: "message", id: "a", parentId: "u", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "p", model: "m", stopReason: "stop", timestamp: 3, usage: usage(withUsage ? 115300 : 0) } },
  ];
  if (editAfter) entries.push({ type: "context_edit", id: "e", parentId: "a", timestamp: "t", targetId: "u", replacement: { content: large } });
  return entries;
}
const prefixOf = (b: SessionEntry[]) => convertToLlm(buildSessionProjection(b, b.at(-1)!.id).messages);
const append = "Summarize the paused session. ".repeat(150);

test("90% filled context with provider usage admits main without estimate bias", () => {
  const b = branch(true), prefix = prefixOf(b);
  assert.ok(contextTokens(prefix) > W - 4096 - 256, "conservative whole-prefix estimate alone would overflow");
  const a = mainAdmission(b, prefix, append, 4096, W, { provider: "p", id: "m" });
  assert.equal(a.contextSource, "provider-usage");
  assert.equal(a.providerUsageTokens, 115300);
  assert.equal(a.usageEntryId, "a");
  assert.equal(a.estimatedTrailing, 0);
  assert.equal(a.total, 115300 + textTokens(append) + 4096 + 256);
  assert.equal(a.passed, true);
});
test("missing or invalidated provider usage falls back to whole estimate and labels it", () => {
  for (const [b, reason] of [[branch(false), "no-provider-usage"], [branch(true, true), "usage-before-context-edit-or-compaction"]] as const) {
    const prefix = prefixOf(b), a = mainAdmission(b, prefix, append, 4096, W, { provider: "p", id: "m" });
    assert.equal(a.contextSource, "estimate"); assert.equal(a.reason, reason);
    assert.equal(a.providerUsageTokens, null); assert.equal(a.estimatedTrailing, contextTokens(prefix));
    assert.equal(a.passed, false);
  }
});
test("native keeps its output policy but rejects physically oversized input before sending", async () => {
  let sent = 0;
  const ctx: any = {
    sessionManager: { getSessionId: () => "s" }, ui: { notify() {} },
    modelRegistry: { streamSimple() { sent++; const s = createAssistantMessageEventStream(); const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "NATIVE" }], api: "x", provider: "p", model: "m", usage: usage(10), stopReason: "stop", timestamp: Date.now() }; queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: "stop", message }); }); return s; } },
  };
  const model: any = { provider: "p", id: "m", api: "x", contextWindow: 1000, maxTokens: 100 };
  const attempts: Attempt[] = [], records: RequestRecord[] = [];
  const context = { messages: [{ role: "user" as const, content: large, timestamp: 1 }] };
  await assert.rejects(generate(ctx, { ...DEFAULT_CONFIG, outputTokens: 50 }, model, context, undefined, new AbortController().signal, attempts, records, "main", "chunk", {}, async () => true), /request-context-window-overflow/);
  assert.equal(sent, 0);
  await assert.rejects(generate(ctx, { ...DEFAULT_CONFIG, outputTokens: 5000 }, model, context, undefined, new AbortController().signal, attempts, records, "native", "native", {}, async () => true, "none"), /native-request-context-window-overflow/);
  assert.equal(sent, 0);
  const response = await generate(ctx, { ...DEFAULT_CONFIG, outputTokens: 5000 }, model, { messages: [{ role: "user", content: "small native input", timestamp: 1 }] }, undefined, new AbortController().signal, attempts, records, "native", "native", {}, async () => true, "none", undefined, undefined, null);
  assert.equal(sent, 1); assert.equal(response.content[0]!.type, "text");
  assert.equal(attempts.at(-1)!.windowAdmission, "none"); assert.equal(attempts.at(-1)!.sent, true);
});
test("admission reserves the whole default output budget", () => {
  const b = branch(true), prefix = prefixOf(b);
  const narrow = mainAdmission(b, prefix, append, DEFAULT_CONFIG.outputTokens, W, { provider: "p", id: "m" });
  assert.equal(narrow.total, 115300 + textTokens(append) + DEFAULT_CONFIG.outputTokens + 256);
  assert.equal(narrow.passed, false, "W=128k cannot hold a 90% context plus the real output budget; main routes to small");
  assert.equal(mainAdmission(b, prefix, append, DEFAULT_CONFIG.outputTokens, 600000, { provider: "p", id: "m" }).passed, true);
});
test("length is incomplete output eligible for one retry; only prefix/window errors route to small", async () => {
  const ctx: any = {
    sessionManager: { getSessionId: () => "s" }, ui: { notify() {} },
    modelRegistry: { streamSimple() { const s = createAssistantMessageEventStream(); const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: '{"version":1,"goal":' }], api: "x", provider: "p", model: "m", usage: usage(10), stopReason: "length", timestamp: Date.now() }; queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: "length", message }); }); return s; } },
  };
  const model: any = { provider: "p", id: "m", api: "x", contextWindow: 200000, maxTokens: 65536 };
  const attempts: Attempt[] = [];
  const error = await generate(ctx, DEFAULT_CONFIG, model, { messages: [{ role: "user", content: "summarize", timestamp: 1 }] }, "high", new AbortController().signal, attempts, [], "main", "main", {}, async () => true, "caller").then(() => undefined, (e: unknown) => e);
  assert.match(String(error), /Invalid summarization stop: length/);
  assert.equal(attempts[0]!.stopReason, "length");
  assert.equal(attempts[0]!.outputTokenBudget, DEFAULT_CONFIG.outputTokens);
  assert.equal(routesToSmall(error), false);
  assert.equal(routesToSmall(new Error("request-context-window-overflow")), true);
  for (const other of [new SyntaxError("Unexpected end of JSON input"), new Error("Invalid compaction JSON: /goal: Expected required property"), new Error("Invalid summarization stop: error"), new Error("provider-output-limit-exceeded")]) assert.equal(routesToSmall(other), false, String(other));
});
test("a previous model's usage cannot admit the current target or survive a model switch", () => {
  const b = branch(true), prefix = prefixOf(b);
  const switched = [...b, { type: "model_change", id: "switch", parentId: b.at(-1)!.id, timestamp: "t", provider: "other", modelId: "different" }] as SessionEntry[];
  const a = mainAdmission(switched, prefix, "instruction", 1024, 100000, { provider: "other", id: "different" });
  assert.equal(a.contextSource, "estimate"); assert.equal(a.providerUsageTokens, null);
  assert.equal(a.estimatedPrefix, contextTokens(prefix)); assert.equal(a.passed, false);
  assert.equal(a.reason, "usage-model-mismatch");
});
