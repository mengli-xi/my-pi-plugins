import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, createEventBus, createWriteToolDefinition, convertToLlm, buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import sessionCompact from "../index.ts";
import { collectUserQuotations, renderUserQuotations } from "../src/quotations.ts";
import { validateOutput, generationInstruction, PROMPT_VERSION } from "../src/output.ts";
import { chunkUnits, sourceUnits, unitText, generateSmall } from "../src/small.ts";
import { collectMaterials } from "../src/materials.ts";
import { DEFAULT_CONFIG, readConfig } from "../src/config.ts";
import { acquireEffectiveCapture, contextFingerprint, getEffectiveContextStore, mapEffectiveTurns } from "pi-session-runtime/effective-context";
import { describeNativeContext } from "pi-session-runtime/native-child-context";
import { tokens, contextTokens } from "../src/budget.ts";
import { recoveryOwner, skillMaterial } from "./fixtures/recovery-owners.ts";
import { restoredContext, recoveryText } from "../src/recovery.ts";
import { requestOnlyTokens } from "../src/request-only.ts";

const root = mkdtempSync(join(tmpdir(), "compact-v2-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent/pi-session-compact"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const user = (id: string, text: any): any => ({ type: "message", id, parentId: null, timestamp: "2026-10-27", message: { role: "user", content: text, timestamp: 1 } });
const chain = (b: any[]): SessionEntry[] => b.map((e, i) => ({ ...e, parentId: b[i - 1]?.id ?? null }));
const compact = (b: SessionEntry[], id: string, kept: string, native = false): SessionEntry[] => chain([...b, { type: "compaction", id, timestamp: "2026-10-27", firstKeptEntryId: kept, summary: "old", tokensBefore: 1, details: native ? {} : { userQuotations: collectUserQuotations(b, kept) } }]);

test("three compactions preserve exact repeated, multipart and previously retained messages", () => {
  let b = chain([user("a", "继续\n\n不要发布🙂"), user("b", [{ type: "text", text: "first\n" }, { type: "text", text: "second" }]), user("c", "继续")]);
  b = compact(b, "c1", "b");
  assert.deepEqual(collectUserQuotations(b, "c").items.map(q => q.text), ["继续\n\n不要发布🙂", "first\n\nsecond"]);
  b = compact(b, "c2", "c");
  b = chain([...b, user("d", "继续"), user("e", "tail")]);
  b = compact(b, "c3", "e");
  assert.deepEqual((b.at(-1) as any).details.userQuotations.items.map((q: any) => q.text), ["继续\n\n不要发布🙂", "first\n\nsecond", "继续", "继续"]);
  assert.doesNotMatch(renderUserQuotations(collectUserQuotations(b, "e")), /tail/);
});
test("tree, fork, legacy native and custom-native-custom use only active ancestry", () => {
  const base = chain([user("a", "parent"), user("b", "old tail")]);
  const first = compact(base, "c1", "b");
  const left = chain([...first, user("left", "left"), user("tailL", "tail")]);
  const right = chain([...first, user("right", "right"), user("tailR", "tail")]);
  assert.deepEqual(collectUserQuotations(left, "tailL").items.map(q => q.text), ["parent", "old tail", "left"]);
  assert.deepEqual(collectUserQuotations(right, "tailR").items.map(q => q.text), ["parent", "old tail", "right"]);
  assert.deepEqual(collectUserQuotations(base, "b").items.map(q => q.text), ["parent"]);
  const native = compact(left, "native", "left", true);
  assert.deepEqual(collectUserQuotations(native, "tailL").items.map(q => q.text), ["parent", "old tail", "left"]);
  const third = compact(native, "c3", "tailL");
  assert.deepEqual(collectUserQuotations(third, "tailL"), collectUserQuotations(left, "tailL"));
  assert.throws(() => collectUserQuotations(chain([{ ...user("a", "a"), parentId: "missing" }]).map(e => ({ ...e, parentId: "missing" })), "a"), /history-incomplete/);
});
test("context_edit rebuilds compacted quotations without resurrecting deleted text", () => {
  let b = compact(chain([user("a", "DELETE_OLD"), user("b", "REPLACE_OLD"), user("c", "tail")]), "c1", "c");
  b = chain([...b, { type: "context_edit", id: "edit1", timestamp: "t", targetId: "a", replacement: null }, { type: "context_edit", id: "edit2", timestamp: "t", targetId: "b", replacement: { content: "NEW_TEXT" } }]);
  assert.deepEqual(collectUserQuotations(b, "c").items, [{ kind: "user", text: "NEW_TEXT" }]);
});
test("explicit Goal protocol and custom notifications are excluded; natural-language lookalikes stay", () => {
  const b = chain([user("a", "Continue the active /goal… I typed this"), user("g", "automatic\n<!-- pi-goal-continuation:goal-id:1 -->"), user("r", "resumed\n<!-- pi-goal-prompt:uuid -->"), { type: "custom_message", id: "p", customType: "process-notification-batch-v1", content: "<process_event>notice</process_event>", display: false, timestamp: "t" }, user("unknown", "<process_event>typed or unknown legacy</process_event>"), user("tail", "tail")]);
  assert.deepEqual(collectUserQuotations(b, "tail").items.map(q => q.text), ["Continue the active /goal… I typed this", "<process_event>typed or unknown legacy</process_event>"]);
});
test("QA preserves paired answers and notes, labels cancelled answers, ignores unpaired tools and respects edits", () => {
  const ask = { ...user("call", ""), message: { role: "assistant", content: [{ type: "toolCall", id: "ask", name: "ask_user_question", arguments: { questions: [{ question: "部署吗？" }] } }] } };
  const answer = { ...user("answer", ""), message: { role: "toolResult", toolName: "ask_user_question", toolCallId: "ask", content: [{ type: "text", text: "envelope" }], details: { cancelled: false, answers: [{ kind: "custom", questionIndex: 0, question: "部署吗？", answer: "不要\n部署", notes: "等确认🙂" }] } } };
  const b = chain([ask, answer, user("tail", "tail")]);
  assert.deepEqual(collectUserQuotations(b, "tail").items, [{ kind: "qa", text: "问题：部署吗？\n回答：不要\n部署\n补充：等确认🙂" }]);
  assert.equal(collectUserQuotations(chain([answer, user("tail", "tail")]), "tail").items.length, 0);
  const cancelled = structuredClone(b) as any[]; cancelled[1].message.details.cancelled = true;
  assert.match(collectUserQuotations(cancelled, "tail").items[0]!.text, /已取消问答.*不表示授权/);
  const edited = chain([...b, { type: "context_edit", id: "edit", timestamp: "t", targetId: "answer", replacement: { content: [{ type: "text", text: "新回答" }, { type: "text", text: "新补充" }] } }]);
  assert.equal(collectUserQuotations(edited, "tail").items[0]!.text, "新回答\n新补充");
});
test("large pasted text remains whole, and complete restoration fails without trimming in a small window", () => {
  const paste = "x".repeat(402330); // 134,110 estimated tokens before wrappers.
  const b = chain([user("a", paste), user("tail", "tail")]);
  const quotes = collectUserQuotations(b, "tail"), text = renderUserQuotations(quotes);
  assert.equal(tokens(paste), 134110); assert.equal(quotes.items[0]!.text, paste);
  const result = { summary: "handoff" + text, firstKeptEntryId: "tail", tokensBefore: 200000 };
  assert.ok(restoredContext(b, result, 200000, { quotations: text, reserveTokens: 16000 }).fits);
  assert.equal(restoredContext(b, result, 50000, { quotations: text, reserveTokens: 16000 }).fits, false);
  assert.equal(result.summary, "handoff" + text);
  assert.doesNotMatch(result.summary, /key_points|session_expand|Pasted content|截短/);
});
test("ordinary and legacy bodies accept incomplete fields without repair or citation machinery", () => {
  assert.equal(PROMPT_VERSION, 9);
  for (const raw of ["普通交接", "```md\n交接\n```", '{"missing":"goal"}', '{"goal": "quoted', "\nbody\n" + "long ".repeat(10000)]) assert.ok(validateOutput(raw).summary);
  assert.throws(() => validateOutput(" \n\t"), /empty-compaction-body/);
  const legacy = validateOutput(JSON.stringify({ goal: "任务", progress: [{ text: "完成", evidenceEntryIds: ["BAD"] }], memoryCandidates: [{ body: "HIDDEN" }], nextActions: [{ text: "下一步" }] }));
  assert.match(legacy.summary, /任务|完成|下一步/); assert.doesNotMatch(legacy.summary, /BAD|HIDDEN|sources|unverified/);
  assert.doesNotMatch(generationInstruction("small"), /Output schema|submit_compaction|source table/);
  assert.ok(recoveryText().length < 200);
});
test("chunking retains all Unicode pieces while hiding internal IDs and ranges from model text", () => {
  const text = "汉🙂abc\n".repeat(5000), unit = { entryId: "private-id", role: "user", partIndex: 0, start: 0, end: [...text].length, text, group: "private-group" };
  const pieces = chunkUnits([unit], items => [{ role: "user", content: "p".repeat(4000) + items.map(unitText).join("\n\n"), timestamp: 0 }], 400, 5000).flat();
  assert.ok(pieces.length > 1); assert.equal(pieces.map(p => p.text).join(""), text);
  assert.doesNotMatch(pieces.map(unitText).join(""), /private-id|private-group|chars=|part=/);
});
const model: any = { provider: "fake", id: "small", api: "fake", name: "small", contextWindow: 200000, maxTokens: 32000, reasoning: false, input: ["text"], cost: {}, baseUrl: "" };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Reply = { text?: string; calls?: any[]; stop?: string; error?: string; throws?: string; delay?: number; onReply?: () => void };
function harness(replies: Reply[], options: { window?: number; text?: string; timeout?: number } = {}) {
  writeFileSync(join(root, "agent/pi-session-compact/config.json"), JSON.stringify({ mode: "small", smallModel: { provider: "fake", id: "small", effort: "off" }, outputTokens: 1024, summaryTokens: 1, totalTimeoutMinutes: options.timeout ?? 10 }));
  const sm = SessionManager.inMemory(root); sm.appendMessage({ role: "user", content: options.text ?? "不要发布\n完整原话", timestamp: 1 }); sm.appendMessage({ role: "user", content: "tail", timestamp: 2 });
  const handlers = new Map<string, any>(), notices: string[] = [], sent: any[] = [];
  let count = 0, aborted = false;
  const controller = new AbortController();
  const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerCommand() {}, sendMessage: (m: any) => sent.push(m), events: createEventBus(), getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({ retry: { enabled: true, maxRetries: 9, baseDelayMs: 1, maxAgentDelayMs: 1 }, compaction: { reserveTokens: 1000 } }) };
  const ctx: any = { model: { ...model, contextWindow: options.window ?? 200000 }, cwd: root, sessionManager: sm, abort() { aborted = true; }, ui: { notify: (s: string) => notices.push(s) }, modelRegistry: { find: () => model, streamSimple(_m: any, context: any, opts: any) {
    const index = count++, reply = replies[index] ?? { text: "NATIVE" }, stream = createAssistantMessageEventStream();
    if (reply.throws) throw new Error(reply.throws);
    const finish = () => {
      reply.onReply?.();
      const message: any = { role: "assistant", content: [...(reply.text !== undefined ? [{ type: "text", text: reply.text }] : []), ...(reply.calls ?? [])], api: "fake", provider: "fake", model: "small", timestamp: 1, usage, stopReason: reply.stop ?? "stop", errorMessage: reply.error };
      stream.push(message.stopReason === "error" || message.stopReason === "aborted" ? { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: message.stopReason, message });
    };
    if (reply.delay) { const t = setTimeout(finish, reply.delay); opts.signal?.addEventListener("abort", () => { clearTimeout(t); stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted", usage, api: "fake", provider: "fake", model: "small", timestamp: 1 } as any }); }, { once: true }); } else finish();
    return stream;
  } } };
  sessionCompact(pi);
  const branch = sm.getBranch();
  const event = { reason: "manual", branchEntries: branch, signal: controller.signal, preparation: { firstKeptEntryId: branch[1]!.id, messagesToSummarize: [branch[0]!.type === "message" && branch[0]!.message], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 20000, settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() } } };
  return { pi, event, run: () => handlers.get("session_before_compact")(event, ctx), get count() { return count; }, get aborted() { return aborted; }, notices, controller, handlers, ctx, sm, sent };
}

test("a failed builtin write with an invalid file URI does not cancel compaction after normal messages", async () => {
  const h = harness([{ text: "HANDOFF" }]), path = "file:///tmp/bad%escape";
  let writes = 0;
  const write = createWriteToolDefinition(root, { operations: { mkdir: async () => {}, writeFile: async () => { writes++; } } });
  let failure: unknown;
  try { await write.execute("invalid-write", { path, content: "x" }, undefined, undefined, {} as any); } catch (error) { failure = error; }
  assert.ok(failure instanceof URIError); assert.equal(writes, 0);
  h.sm.appendMessage(fauxAssistantMessage([{ type: "toolCall", id: "invalid-write", name: "write", arguments: { path, content: "x" } }], { stopReason: "toolUse" }));
  h.sm.appendMessage({ role: "toolResult", toolCallId: "invalid-write", toolName: "write", content: [{ type: "text", text: String(failure) }], isError: true, timestamp: 3 });
  h.sm.appendMessage(fauxAssistantMessage("Continue with other work."));
  const kept = h.sm.appendMessage({ role: "user", content: "KEEP_NORMAL_MESSAGE", timestamp: 4 });
  h.event.branchEntries = h.sm.getBranch();
  h.event.preparation.firstKeptEntryId = kept;
  h.event.preparation.messagesToSummarize = h.sm.buildSessionProjection().messages;
  const result = await h.run();
  assert.ok(result.compaction, h.notices.join("\n"));
  assert.equal(h.aborted, false); assert.equal(h.count, 1);
  assert.equal(result.compaction.details.generator, "pi-session-compact");
  assert.deepEqual(result.compaction.details.fileTracking.modifiedFiles, [path]);
  assert.ok(result.compaction.summary.includes(path));
  assert.equal(h.notices.some(notice => notice.includes("取消压缩")), false);
});

const businessTool = { type: "toolCall", id: "danger", name: "bash", arguments: { command: "NEVER_EXECUTE" } };
for (const [label, replies, expected, native] of [
  ["normal", [{ text: "交接" }], 1, false],
  ["body plus tools", [{ text: "交接", calls: [businessTool], stop: "toolUse" }], 1, false],
  ["blank then body", [{ text: " \n" }, { text: "交接" }], 2, false],
  ["tool only then body", [{ calls: [businessTool], stop: "toolUse" }, { text: "交接" }], 2, false],
  ["length then body", [{ text: "partial", stop: "length" }, { text: "交接" }], 2, false],
  ["interrupted then body", [{ throws: "stream interrupted unexpectedly" }, { text: "交接" }], 2, false],
  ["temporary network then body", [{ throws: "fetch failed: ECONNRESET" }, { text: "交接" }], 2, false],
  ["shared allowance exhausted", [{ text: " " }, { throws: "fetch failed: ECONNRESET" }, { text: "NATIVE" }], 3, true],
  ["nonretryable", [{ stop: "error", error: "invalid API key" }, { text: "NATIVE" }], 2, true],
] as Array<[string, Reply[], number, boolean]>) test(`faux ${label}: exact request count and inert tools`, async () => {
  const h = harness(replies), result = await h.run();
  assert.ok(result.compaction, h.notices.join("\n")); assert.equal(h.count, expected);
  assert.equal(result.compaction.details.generator, native ? "pi-native" : "pi-session-compact");
  assert.deepEqual(result.compaction.details.userQuotations.items, [{ kind: "user", text: "不要发布\n完整原话" }]);
  assert.doesNotMatch(result.compaction.summary, /NEVER_EXECUTE/);
});
test("cancel and stale session never retry or fall back", async () => {
  for (const stale of [false, true]) {
    const h = harness([{ text: "late", delay: 50 }]); const promise = h.run();
    while (h.count === 0) await new Promise(r => setTimeout(r, 1));
    if (stale) h.handlers.get("session_tree")({}, h.ctx); else h.controller.abort(new Error("user-cancelled"));
    assert.equal((await promise).cancel, true); assert.equal(h.count, 1);
  }
});
test("total deadline uses native once outside the custom deadline", async () => {
  const h = harness([{ text: "late", delay: 500 }, { text: "NATIVE" }], { timeout: 0.001 });
  const result = await h.run(); assert.ok(result.compaction); assert.equal(h.count, 2); assert.equal(result.compaction.details.generator, "pi-native");
});
test("fixed material overflow stops before generation; native overflow cancels commit", async () => {
  const fixed = harness([], { text: "x".repeat(402330), window: 50000 });
  assert.equal((await fixed.run()).cancel, true); assert.equal(fixed.count, 0); assert.ok(fixed.aborted); assert.match(fixed.notices.join("\n"), /原话.*保留原会话/);
  const h = harness([{ text: "long ".repeat(10000) }, { text: "long ".repeat(10000) }], { window: 8000 });
  assert.equal((await h.run()).cancel, true); assert.equal(h.count, 2); assert.equal(h.sm.getBranch().some(e => e.type === "compaction"), false);
});
test("final public context gate includes late owner injections and preserves committed entries", async () => {
  const h = harness([{ text: "handoff" }], { window: 8000 }); const result = await h.run(); assert.ok(result.compaction);
  h.sm.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, 1, result.compaction.details, true);
  h.handlers.get("context_with_system")({ messages: [{ role: "user", content: "LATE_OWNER".repeat(5000), timestamp: 1 }] }, h.ctx);
  assert.ok(h.aborted); assert.equal(h.count, 1); assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1);
});
test("old summaryTokens is explicit disabled compatibility configuration", async () => {
  harness([]); const config = await readConfig(join(root, "agent")); assert.match(config.deprecatedSettings!.join(), /summaryTokens 已停用/);
});
test("small uses the previous summary once and restores the latest actual skill version", async () => {
  const b = chain([user("old", "old user"), user("kept", "current user"), { type: "compaction", id: "prior", timestamp: "t", firstKeptEntryId: "kept", summary: "PREVIOUS_SUMMARY_ONCE", tokensBefore: 1 }]);
  const requests: any[] = [];
  const ctx: any = { model, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "small-test" }, ui: { notify() {} }, modelRegistry: { find: () => model, streamSimple(_m: any, context: any) { requests.push(context); const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "handoff" }], ...model, model: "small", timestamp: 1, usage, stopReason: "stop" } as any }); return stream; } } };
  await generateSmall(ctx, { ...DEFAULT_CONFIG, smallModel: { provider: "fake", id: "small", effort: "off" }, outputTokens: 1024 }, b, { mergedText: "", estimatedTokens: 0 } as any, { goal: null, memory: [], skills: [], known: [] }, new AbortController().signal, [], [], "small", {}, async () => true);
  assert.equal(requests.length, 1); assert.equal((JSON.stringify(requests[0]).match(/PREVIOUS_SUMMARY_ONCE/g) ?? []).length, 1);
  assert.equal(requests[0].tools, undefined); assert.doesNotMatch(JSON.stringify(requests[0]), /entry=|chars=|source table/);
  const versions: any[] = ["one", "two"].map((contents, i) => ({ type: "custom", id: `v${i}`, customType: "pi-skills:binding-v1", data: { version: 1, skills: [{ name: "skill", path: "/SKILL.md", contents }] } }));
  const pi: any = { events: createEventBus() };
  pi.events.on("pi-session-compact:collect-materials-v1", (r: any) => r.reply({ owner: "rules-owner", skills: [{ sourceEntryId: "v1", name: "skill", path: "/SKILL.md", contents: "two" }] }));
  assert.equal((await collectMaterials(pi, ctx, root, versions)).skills[0]!.contents, "two");
});

test("unreadable raw user content stops reconstruction rather than pretending it is empty", () => {
  assert.throws(() => collectUserQuotations(chain([user("bad", null), user("tail", "tail")]), "tail"), /unreadable user content/);
});

test("legacy conversion keeps business document paths while omitting citation fields", () => {
  const result = validateOutput(JSON.stringify({ goal: "continue", nextActions: [{ text: "verify", documentRefs: ["/workspace/spec.md"], sourceEntryIds: ["PRIVATE_SOURCE"] }], references: [{ kind: "document", pathOrEntryId: "/workspace/report.md", purpose: "actual evidence" }, { kind: "session", pathOrEntryId: "PRIVATE_REFERENCE", purpose: "citation" }] }));
  assert.match(result.summary, /\/workspace\/spec.md/); assert.match(result.summary, /\/workspace\/report.md/);
  assert.doesNotMatch(result.summary, /PRIVATE_SOURCE|PRIVATE_REFERENCE/);
});
test("a failed middle chunk retries once without rerunning successful chunks or adding repairs", async () => {
  const attempts: any[] = [], contexts: string[] = [];
  let failed = false, chunkCalls = 0;
  const small = { ...model, contextWindow: 8000 };
  const ctx: any = { model, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "chunk-test" }, ui: { notify() {} }, modelRegistry: { find: () => small, streamSimple(_m: any, context: any) {
    contexts.push(JSON.stringify(context.messages));
    const phase = attempts.at(-1)!.phase;
    const blank = phase === "chunk" && ++chunkCalls === 2 && !failed;
    if (blank) failed = true;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: blank ? " " : phase === "synthesis" ? "final handoff" : "temporary handoff" }], api: "fake", provider: "fake", model: "small", timestamp: 1, usage, stopReason: "stop" } });
    return stream;
  } } };
  const result = await generateSmall(ctx, { ...DEFAULT_CONFIG, smallModel: { provider: "fake", id: "small", effort: "off" }, outputTokens: 512 }, chain([user("big", Array.from({ length: 5000 }, (_, i) => `chunk ${i} material汉🙂\n`).join(""))]), { mergedText: "", estimatedTokens: 0 } as any, { goal: null, memory: [], skills: [], known: [] }, new AbortController().signal, attempts, [], "small", {}, async () => true, { enabled: true });
  assert.equal(result.validated.summary, "final handoff"); assert.ok(chunkCalls > 2);
  assert.equal(attempts.filter(a => a.retry).length, 1); assert.equal(attempts.filter(a => a.phase === "synthesis").length, 1);
  const frequencies = new Map<string, number>(); for (const c of contexts) frequencies.set(c, (frequencies.get(c) ?? 0) + 1);
  assert.equal([...frequencies.values()].filter(n => n === 2).length, 1); assert.ok([...frequencies.values()].every(n => n <= 2));
  assert.equal(attempts.length, frequencies.size + 1);
});
test("without measured request membership the actual hook cannot cap a raw retained tail", () => {
  const h = harness([], { text: "x".repeat(800000), window: 100000 });
  h.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "measured" }], api: "fake", provider: "fake", model: "small", timestamp: 3, usage: { ...usage, input: 30000, totalTokens: 30001 }, stopReason: "stop" });
  h.sm.appendCompaction("handoff", h.sm.getBranch()[0]!.id, 30001, {}, true);
  h.handlers.get("context_with_system")({ messages: h.sm.buildSessionProjection().messages }, h.ctx);
  assert.equal(h.aborted, true); assert.equal(h.count, 0);
});

test("a persisted carrier filtered out of the measured request is full cost at precommit and final hooks", async () => {
  const { acquireEffectiveCapture, contextFingerprint, getEffectiveContextStore, mapEffectiveTurns } = await import("pi-session-runtime/effective-context");
  const { describeNativeContext } = await import("pi-session-runtime/native-child-context");
  const { convertToLlm } = await import("@earendil-works/pi-coding-agent");
  for (const initialWindow of [100000, 1000000]) {
    const h = harness([], { window: initialWindow });
    h.sm.appendCustomMessageEntry("held-carrier", "x".repeat(1200000), false, {});
    const carrier = h.sm.getLeafId()!, before = h.sm.getBranch(), messages = convertToLlm(before.filter(e => e.id !== carrier).flatMap(e => e.type === "message" ? [e.message] : []));
    const sid = h.sm.getSessionId(), lease = acquireEffectiveCapture({ owner: "r2-test", sessionId: sid, binding: h.sm });
    const origins = describeNativeContext(before), store = getEffectiveContextStore(), ref = { provider: "fake", id: "small" };
    assert.ok(store.put({ sessionId: sid, generation: lease.generation, selectedModel: ref, physicalModel: ref, thinkingLevel: "off", toolLoadoutFingerprint: contextFingerprint([]), capabilityFingerprint: "test", requestOrdinal: 1, leafId: carrier, normalizedMessages: messages, contextCandidateHash: contextFingerprint(messages), normalizedRequestHash: contextFingerprint(messages), capturedAt: Date.now(), ...mapEffectiveTurns(messages, origins), wirePrefix: "unknown" }, store.revision(sid), origins));
    h.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "fake", provider: "fake", model: "small", timestamp: 3, stopReason: "stop", usage: { ...usage, input: 999, totalTokens: 1000 } });
    h.event.branchEntries = h.sm.getBranch(); h.event.preparation.firstKeptEntryId = carrier;
    try {
      const result = await h.run();
      if (initialWindow === 100000) { assert.equal(result.cancel, true); assert.equal(h.count, 0); }
      else {
        assert.ok(result.compaction, h.notices.join("\n"));
        h.sm.appendCompaction(result.compaction.summary, carrier, 1000, result.compaction.details, true);
        h.ctx.model.contextWindow = 100000;
        h.handlers.get("context_with_system")({ messages: h.sm.buildSessionProjection().messages }, h.ctx);
        assert.equal(h.aborted, true); assert.match(h.notices.at(-1)!, /完整准入失败/);
      }
    } finally { lease.retire(); }
  }
});
test("an already known oversized todo cancels before any summary request or commit", async () => {
  const h = harness([], { window: 10000 });
  h.sm.appendCustomMessageEntry("todo-state", "old todo", false, { todos: [{ content: "T".repeat(50000), status: "in_progress", activeForm: "working" }] });
  h.sm.appendMessage({ role: "user", content: "retained tail", timestamp: 4 });
  h.event.branchEntries = h.sm.getBranch(); h.event.preparation.firstKeptEntryId = h.sm.getLeafId()!;
  recoveryOwner(h.pi, { owner: "fixture-todo", customType: "todo-state", content: "T".repeat(50000), order: 20 });
  const result = await h.run(); assert.equal(result.cancel, true); assert.equal(h.count, 0);
  assert.equal(h.sm.getBranch().some(e => e.type === "compaction"), false);
});
test("non-ASCII single pass and multi-chunk synthesis use the same actual Pi message sizing", async () => {
  const small = { ...model, contextWindow: 10000, maxTokens: 1024 };
  for (const length of [25000, 60000]) {
    const calls: any[] = [], attempts: any[] = [];
    const ctx: any = { model: small, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "unicode-plan" }, ui: { notify() {} }, modelRegistry: { find: () => small, streamSimple(_m: any, context: any) { calls.push(context); const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "汉".repeat(3000) }], api: "fake", provider: "fake", model: "small", timestamp: 1, usage, stopReason: "stop" } }); return stream; } } };
    const result = await generateSmall(ctx, { ...DEFAULT_CONFIG, outputTokens: 1024, smallModel: { provider: "fake", id: "small", effort: "off" } }, chain([user("large", "汉".repeat(length))]), { mergedText: "", estimatedTokens: 0 } as any, { memory: [], skills: [], known: [], goal: null }, new AbortController().signal, attempts, [], "small", {}, async () => true);
    assert.equal(result.validated.summary.length, 3000);
    if (length === 25000) assert.equal(calls.length, 1);
    else { assert.ok(attempts.some(a => a.phase === "chunk")); assert.equal(attempts.at(-1).phase, "synthesis"); }
  }
});

test("missing skill owner never cancels compression or leaves a request latch", async () => {
  const h = harness([{ text: "HANDOFF" }]);
  h.sm.appendCustomEntry("pi-skills:binding-v1", { version: 1, skills: [{ name: "required", contents: "PRIVATE_RULES" }] });
  h.event.branchEntries = h.sm.getBranch();
  const result = await h.run();
  assert.ok(result.compaction, h.notices.join("\n"));
  assert.equal(h.count, 1); assert.equal(h.aborted, false);
  assert.match(result.compaction.summary, /pi-skills:binding-v1 未恢复/);
  assert.doesNotMatch(result.compaction.summary, /PRIVATE_RULES/);
  h.sm.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, 1, result.compaction.details);
  h.handlers.get("context_with_system")({ messages: h.sm.buildSessionProjection().messages }, h.ctx);
  assert.equal(h.aborted, false);
});

test("legacy before_agent_start still repairs recovery with nextTurn", () => {
  const h = harness([]);
  h.sm.appendCompaction("old", h.sm.getBranch()[1]!.id, 100, { version: 2, operationId: "legacy", recoveryText: "ORIGINAL_RECOVERY", restoreSkills: [{ sourceEntryId: "s", name: "n", path: "/s", contentHash: "hash" }] });
  const requests: any[] = [], sent: any[] = [];
  h.pi.events.on("pi-skills:compact-restore-request-v1", (request: any) => requests.push(request));
  h.pi.sendMessage = (message: any, options: any) => sent.push({ message, options });
  h.handlers.get("before_agent_start")({}, h.ctx);
  assert.equal(requests.length, 0, "legacy references do not require a missing owner");
  h.handlers.get("context_with_system")({ messages: h.sm.buildSessionProjection().messages }, h.ctx);
  assert.equal(h.aborted, false);
  assert.equal(sent[0].message.content, "ORIGINAL_RECOVERY");
  assert.deepEqual(sent[0].options, { deliverAs: "nextTurn", triggerTurn: false });
});


test("admission refreshes process recovery after summary generation", async () => {
  for (const nativeFallback of [false, true]) {
    let live = true, collections = 0;
    const response = { text: "H".repeat(18000), onReply: () => { live = false; } };
    const h = harness(nativeFallback ? [{ stop: "error", error: "invalid API key" }, response] : [response], { window: 14000 });
    h.pi.events.on("pi-session-compact:collect-recovery-v1", (request: any) => {
      collections++;
      if (live) request.reply({ owner: "pi-processes", customType: "process-compact-state-v1", identity: { processIds: ["ended"] }, content: "LIVE_PROCESS " + "x".repeat(36000) });
    });
    const result = await h.run();
    assert.ok(result.compaction, h.notices.join("\n"));
    assert.equal(result.compaction.details.generator, nativeFallback ? "pi-native" : "pi-session-compact");
    assert.equal(h.count, nativeFallback ? 2 : 1, "fresh recovery fits without another fallback request");
    assert.equal(h.aborted, false);
    assert.equal(collections, 2);
    assert.doesNotMatch(result.compaction.summary, /LIVE_PROCESS/);
    assert.equal(result.compaction.details.recovery.items.some((item: any) => item.owner === "pi-processes"), false);
  }
});

test("request-only mixed-content skill envelope stays fully charged when its source is cut", async () => {
  const h = harness([], { window: 14000, text: "$work" });
  h.sm.appendMessage({ role: "system", content: "SYSTEM", tools: [], timestamp: 0 } as any);
  const source = h.sm.getBranch()[0]!;
  assert.ok(source.type === "message");
  const skill = { name: "work", path: "/work/SKILL.md", contents: "RULES ".repeat(6600) };
  const injection = "REQUEST_ONLY_RULES " + skill.contents;
  h.sm.appendCustomEntry("fixture-rule-source", { publicLabel: true });
  const branch = h.sm.getBranch();
  h.event.branchEntries = branch;
  skillMaterial(h.pi, { ...skill, sourceEntryId: source.id });
  recoveryOwner(h.pi, { owner: "fixture-rules", customType: "fixture-rules-restored", content: skill.contents, order: 10 });
  const prefix = convertToLlm(h.sm.buildSessionProjection().messages);
  prefix.push({ role: "user", timestamp: source.message.timestamp, content: [{ type: "text", text: injection }] });
  const pureTokens = requestOnlyTokens(branch, prefix, h.event.preparation.firstKeptEntryId); assert.ok(pureTokens > 0);
  const unknown = { role: "user" as const, timestamp: source.message.timestamp, content: [{ type: "text" as const, text: injection }, { type: "image" as const, mimeType: "image/png", data: "AAAA" }] };
  prefix.splice(2, 0, unknown);
  const unknownTokens = contextTokens([unknown]);
  assert.equal(requestOnlyTokens(branch, prefix, h.event.preparation.firstKeptEntryId), unknownTokens + pureTokens, "the entire unknown injection, including its image, must stay charged");
  const sessionId = h.sm.getSessionId(), lease = acquireEffectiveCapture({ owner: "request-only-multimodal", sessionId, binding: h.sm });
  try {
    const store = getEffectiveContextStore(), origins = describeNativeContext(branch), selectedModel = { provider: h.ctx.model.provider, id: h.ctx.model.id };
    assert.ok(store.put({ sessionId, generation: lease.generation, selectedModel, physicalModel: selectedModel, thinkingLevel: "off", toolLoadoutFingerprint: contextFingerprint([]), capabilityFingerprint: "test", requestOrdinal: 1, leafId: h.sm.getLeafId(), normalizedMessages: prefix, contextCandidateHash: contextFingerprint(prefix), normalizedRequestHash: contextFingerprint(prefix), capturedAt: Date.now(), ...mapEffectiveTurns(prefix, origins), wirePrefix: "unknown" }, store.revision(sessionId), origins));
    const original = structuredClone(h.sm.getEntries());
    assert.equal((await h.run()).cancel, true, "known mixed-content overflow must cancel before commit");
    assert.equal(h.count, 0);
    assert.match(h.notices.join("\n"), new RegExp(`其他注入 ${unknownTokens + pureTokens}`));
    assert.deepEqual(h.sm.getEntries(), original);
  } finally { lease.retire(); }
});

test("request-only skill admission follows its retained source user", async () => {
  for (const retainSource of [false, true]) {
    const h = harness([{ text: "HANDOFF" }], { window: 14000, text: "$work" });
    h.sm.appendMessage({ role: "system", content: "SYSTEM", tools: [], timestamp: 0 } as any);
    const source = h.sm.getBranch()[0]!;
    assert.ok(source.type === "message");
    const skill = { name: "work", path: "/work/SKILL.md", contents: "RULES ".repeat(6600) };
    const injection = "REQUEST_ONLY_RULES " + skill.contents;
    h.sm.appendCustomEntry("fixture-rule-source", { publicLabel: true });
    const branch = h.sm.getBranch();
    h.event.branchEntries = branch;
    h.event.preparation.firstKeptEntryId = retainSource ? source.id : branch[1]!.id;
    skillMaterial(h.pi, { ...skill, sourceEntryId: source.id });
    recoveryOwner(h.pi, { owner: "fixture-rules", customType: "fixture-rules-restored", content: skill.contents, order: 10 });
    const prefix = convertToLlm(h.sm.buildSessionProjection().messages);
    prefix.push({ role: "user", timestamp: source.message.timestamp, content: [{ type: "text", text: injection }] });
    const injectionTokens = contextTokens([{ role: "user", content: [{ type: "text", text: injection }], timestamp: 1 }]);
    assert.ok(prefix.some(message => message.role === "user" && Array.isArray(message.content) && message.content.some(part => part.type === "text" && part.text === injection)));
    const sessionId = h.sm.getSessionId(), lease = acquireEffectiveCapture({ owner: "request-only-admission", sessionId, binding: h.sm });
    try {
      const store = getEffectiveContextStore(), origins = describeNativeContext(branch), selectedModel = { provider: h.ctx.model.provider, id: h.ctx.model.id };
      assert.ok(store.put({ sessionId, generation: lease.generation, selectedModel, physicalModel: selectedModel, thinkingLevel: "off", toolLoadoutFingerprint: contextFingerprint([]), capabilityFingerprint: "test", requestOrdinal: 1, leafId: h.sm.getLeafId(), normalizedMessages: prefix, contextCandidateHash: contextFingerprint(prefix), normalizedRequestHash: contextFingerprint(prefix), capturedAt: Date.now(), ...mapEffectiveTurns(prefix, origins), wirePrefix: "unknown" }, store.revision(sessionId), origins));
      const result = await h.run();
      assert.equal(result.cancel, true, "unproven request-only injections remain charged regardless of cut");
      assert.equal(h.count, 0);
      assert.match(h.notices.join("\n"), new RegExp(`其他注入 ${injectionTokens}`));
    } finally { lease.retire(); }
  }
});


test("compaction cancellation reaches material collection before deadline creation", async () => {
  const h = harness([{ text: "MUST_NOT_REQUEST" }]);
  let collecting!: () => void;
  const entered = new Promise<void>(resolve => { collecting = resolve; });
  h.pi.events.on("cc-memory:request:materials-v1", (r: any) => { r.reply(new Promise(() => {})); collecting(); });
  const pending = h.run(); await entered;
  h.controller.abort(new Error("cancel materials"));
  assert.deepEqual(await pending, { cancel: true }); assert.equal(h.count, 0);
  assert.equal(h.sm.getBranch().some(entry => entry.type === "compaction"), false);
});


test("optional material timeout continues normal compaction rather than cancellation", { timeout: 15000 }, async () => {
  const h = harness([{ text: "HANDOFF_AFTER_MATERIAL_TIMEOUT" }]);
  h.pi.events.on("cc-memory:request:materials-v1", (r: any) => r.reply(new Promise(() => {})));
  const result = await h.run();
  assert.ok(result.compaction, h.notices.join("\n"));
  assert.match(result.compaction.summary, /HANDOFF_AFTER_MATERIAL_TIMEOUT/);
  assert.equal(h.count, 1); assert.equal(h.aborted, false);
});
