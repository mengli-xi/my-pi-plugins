import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager, createEventBus, convertToLlm } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import sessionCompact from "../index.ts";
import { acquireEffectiveCapture, contextFingerprint, getEffectiveContextStore, mapEffectiveTurns } from "pi-session-runtime/effective-context";
import { describeNativeContext } from "pi-session-runtime/native-child-context";

// The extension reads its agent directory per call, so the run logs land in this temporary one.
const root = mkdtempSync(join(tmpdir(), "compact-shadow-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent/pi-session-compact"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, api: "fake", provider: "fake", model: "small", usage, stopReason, timestamp: Date.now() });
// A valid summary that references every user source the request asks for.
const summaryFor = (request: string) => JSON.stringify({ version: 1, goal: { text: "Keep restrictions.", sourceEntryIds: [], phase: "active" }, progress: [], inFlight: [], openQuestions: [], nextActions: [], references: [], userMessages: { mode: request.includes("User-message mode: key_points") ? "key_points" : "verbatim", items: (request.split("Required user/QA sources: ")[1]?.split("\n")[0] ?? "").replace(/\.$/, "").split(", ").filter((id) => /^[UQ]\d+$/.test(id)).map((id) => ({ kind: id.startsWith("Q") ? "qa" : "user", sourceRefs: [id], text: "point" })) }, uncertainties: [], memoryCandidates: [], restoreSkills: [] });
const until = async <T>(get: () => T | undefined | false, label: string): Promise<T> => {
  for (const start = Date.now(); Date.now() - start < 5000; await new Promise((r) => setTimeout(r, 5))) { const value = get(); if (value) return value; }
  throw new Error(`timeout: ${label}`);
};
type Call = { slot: "adopt" | "shadow"; settled: boolean; release: () => void; model: string; outputAtSend: any };

function harness(options: { evidence?: string; outputTokens?: number; smallWindow?: number; invalidSmall?: boolean; shadow?: boolean; freezeCut?: boolean; failNative?: boolean; mode?: "main" | "small"; system?: boolean } = {}) {
  writeFileSync(join(root, "agent/pi-session-compact/config.json"), JSON.stringify({ mode: options.mode ?? "main", shadow: { enabled: options.shadow ?? true, adopt: "main" }, smallModel: { provider: "fake", id: "small", effort: "off" }, outputTokens: options.outputTokens ?? 2048, summaryTokens: 8000 }));
  const commands = new Map<string, any>();
  const sent: unknown[] = [], notices: string[] = [], calls: Call[] = [];
  const sm = SessionManager.inMemory(root);
  if (options.system) sm.appendMessage({ role: "system", content: "FIXED_RULES", tools: [], timestamp: 0 } as any);
  for (const [i, text] of ["USER_ONE Do not publish.", "USER_TWO Keep the public API."].entries()) {
    sm.appendMessage({ role: "user", content: text, timestamp: 2 * i + 1 });
    sm.appendMessage(message([{ type: "text", text: options.evidence ? `REPORT_${i} ${options.evidence}` : "ok" }], "stop"));
  }
  const model = { provider: "fake", id: "small", api: "fake", name: "small", contextWindow: options.smallWindow ?? 200000, maxTokens: 32000, reasoning: false, input: ["text"], cost: usage.cost, baseUrl: "" };
  // The adopted slot posts its progress notice right before each request; the silent shadow never does.
  let noticed = false;
  const ctx: any = {
    model: { ...model, id: "main", contextWindow: 200000 }, cwd: root, thinkingLevel: "off", sessionManager: sm, abort() {}, getSystemPrompt: () => "CURRENT_MAIN_RULES",
    ui: { notify(text: string) { notices.push(text); if (text.startsWith("正在压缩")) noticed = true; }, theme: { fg: (_tone: string, text: string) => text } },
    modelRegistry: {
      find: () => model,
      // Every request waits until the test releases it; an aborted request ends as aborted.
      streamSimple(requestModel: any, context: { messages: Array<{ content: unknown }>; tools?: unknown[] }, streamOptions: { signal?: AbortSignal }) {
        const runDir = join(root, "agent/pi-session-compact/runs", sm.getSessionId());
        const log = JSON.parse(readFileSync(join(runDir, readdirSync(runDir).find(f => f.endsWith(".json"))!), "utf8"));
        const stream = createAssistantMessageEventStream(), call: Call = { slot: noticed ? "adopt" : "shadow", settled: false, release: () => {}, model: `${requestModel.provider}/${requestModel.id}`, outputAtSend: log.outputs.main };
        noticed = false;
        const finish = (reply: AssistantMessage) => { if (call.settled) return; call.settled = true; stream.push({ type: "start", partial: reply }); stream.push(reply.stopReason === "aborted" ? { type: "error", reason: "aborted", error: reply } : { type: "done", reason: "stop", message: reply }); };
        call.release = () => {
          if (options.failNative && !JSON.stringify(context).includes("Summarize the paused session for a colleague")) { finish({ ...message([], "error"), errorMessage: "non-retryable faux failure" }); return; }
          const text = options.invalidSmall && JSON.stringify(context).includes("Summarize the paused session for a colleague") ? "  " : summaryFor(String(context.messages.at(-1)!.content));
          finish(context.tools?.length ? message([{ type: "toolCall", id: "submit", name: "submit_compaction", arguments: text as any }], "toolUse") : message([{ type: "text", text }], "stop"));
        };
        streamOptions.signal?.addEventListener("abort", () => finish(message([], "aborted")), { once: true });
        calls.push(call);
        return stream;
      },
    },
  };
  // One extension instance per process; load() again models a reload or the next process.
  const load = () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => any>();
    const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerCommand(name: string, options: any) { commands.set(name, options); }, events: createEventBus(), getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({ retry: { enabled: false } }), sendMessage: (m: unknown) => sent.push(m), appendEntry: (...a: unknown[]) => sent.push(a) };
    sessionCompact(pi);
    return (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
  };
  const emit = load();
  let frozenCut: string | undefined;
  const compact = (on = emit) => {
    const branch = sm.getBranch();
    // The native fallback can consume these same frozen public messages.
    const preparation = { fileOps: { read: new Set(), written: new Set(), edited: new Set() }, firstKeptEntryId: options.freezeCut ? frozenCut ??= branch.at(-1)!.id : branch.at(-1)!.id, messagesToSummarize: sm.buildSessionProjection().messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 1 } };
    return on("session_before_compact", { preparation, branchEntries: branch, reason: "manual", willRetry: false, signal: new AbortController().signal }) as Promise<{ compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: { operationId: string } } }>;
  };
  const next = (slot: Call["slot"]) => until(() => calls.find((c) => c.slot === slot && !c.settled), `${slot} request`);
  // Adopt as Pi does: release every adopted request, append the compaction entry, emit session_compact.
  const commit = async (on = emit) => {
    const pending = compact(on);
    let done = false; void pending.finally(() => { done = true; });
    while (!done) { const call = calls.find((c) => c.slot === "adopt" && !c.settled); if (call) call.release(); await new Promise((r) => setTimeout(r, 2)); }
    const { compaction } = await pending;
    sm.appendCompaction(compaction!.summary, compaction!.firstKeptEntryId, compaction!.tokensBefore, compaction!.details, true);
    await on("session_compact", { compactionEntry: sm.getBranch().at(-1), fromExtension: true });
    return compaction!.details.operationId;
  };
  const run = (operationId: string) => JSON.parse(readFileSync(join(root, "agent/pi-session-compact/runs", sm.getSessionId(), `${operationId}.json`), "utf8"));
  const runs = () => readdirSync(join(root, "agent/pi-session-compact/runs", sm.getSessionId())).filter((f) => f.endsWith(".json"));
  // A business turn after compaction: Pi assembles context, then the turn ends with provider usage.
  const businessTurn = async (on = emit) => {
    await on("context_with_system", { messages: [] });
    const id = sm.appendMessage(message([{ type: "text", text: "done" }], "stop"));
    await on("turn_end", { message: message([{ type: "text", text: "done" }], "stop"), messageEntryId: id, toolResults: [] });
  };
  return { ctx, command: (args: string) => commands.get("compaction").handler(args, ctx), emit, load, calls, sent, notices, sm, compact, next, commit, run, runs, businessTurn };
}

function seedPrefix(h: ReturnType<typeof harness>, inconsistentTools = false, staleFingerprint = false) {
  const sid = h.sm.getSessionId(), lease = acquireEffectiveCapture({ owner: "main-prefix-test", sessionId: sid, binding: h.sm });
  const origins = describeNativeContext(h.sm.getBranch()), prefix = convertToLlm(h.sm.buildSessionProjection().messages);
  if (inconsistentTools && prefix[0]?.role === "system") prefix[0].toolsAdded = [{ name: "stale", description: "old declaration", parameters: { type: "object" } }];
  const store = getEffectiveContextStore(), model = { provider: "fake", id: "main" };
  assert.ok(store.put({ sessionId: sid, generation: lease.generation, selectedModel: model, physicalModel: model, thinkingLevel: "off", toolLoadoutFingerprint: contextFingerprint(staleFingerprint ? ["old-tool"] : []), capabilityFingerprint: "test",
    requestOrdinal: 1, leafId: h.sm.getLeafId(), normalizedMessages: prefix, contextCandidateHash: contextFingerprint(prefix), normalizedRequestHash: contextFingerprint(prefix), capturedAt: Date.now(),
    ...mapEffectiveTurns(prefix, origins), wirePrefix: "unknown" }, store.revision(sid), origins));
  return lease;
}

test("resume without a Main request compacts once on the main model with a rebuilt prefix", async (t) => {
  const h = harness({ shadow: false });
  const lease = acquireEffectiveCapture({ owner: "resumed-source", sessionId: h.sm.getSessionId(), binding: h.sm });
  t.after(() => lease.retire());
  await h.emit("session_start", { reason: "resume" });
  const run = h.run(await h.commit());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.model, "fake/main");
  assert.equal(run.outputs.main.effectiveMode, "main");
  assert.equal(run.outputs.main.prefix.source, "rebuilt");
  assert.match(run.outputs.main.prefix.reason, /no-capture/);
  assert.deepEqual(run.outputs.main.prefixCapture, { generation: lease.generation, reason: "no-capture" });
  assert.equal(run.outputs.main.admission.contextSource, "estimate");
  assert.equal(run.outputs.main.fallbackReason, undefined);
});

test("an available capture stays exact and is never rebuilt", async (t) => {
  const h = harness({ shadow: false, system: true }), lease = seedPrefix(h);
  t.after(() => lease.retire());
  h.ctx.getSystemPrompt = () => { throw new Error("capture must not be rebuilt"); };
  const run = h.run(await h.commit());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.model, "fake/main");
  assert.deepEqual(run.outputs.main.prefix, { source: "capture", reason: "confirmed-effective-request" });
  assert.equal(run.outputs.main.effectiveMode, "main");
});

test("a rebuilt prefix exceeding the main window still routes to small", async () => {
  const h = harness({ shadow: false, evidence: "x".repeat(400000) });
  const run = h.run(await h.commit());
  assert.equal(run.outputs.main.prefix.source, "rebuilt");
  assert.equal(run.outputs.main.admission.passed, false);
  assert.equal(run.outputs.main.fallbackReason, "main-budget-overflow");
  assert.equal(run.outputs.main.effectiveMode, "small");
  assert.ok(h.calls.length > 0 && h.calls.every(call => call.model === "fake/small"));
  assert.ok(run.outputs.main.attempts.every((attempt: any) => attempt.phase !== "main"));
});

test("a captured tool mismatch retains its old failure path instead of rebuilding", async (t) => {
  const h = harness({ shadow: false, system: true }), lease = seedPrefix(h, true);
  t.after(() => lease.retire());
  h.ctx.getSystemPrompt = () => { throw new Error("inconsistent capture must not be rebuilt"); };
  const run = h.run(await h.commit());
  assert.match(run.outputs.main.fallbackReason, /effective-prefix-tool-loadout-changed/);
  assert.equal(run.outputs.main.prefix, undefined);
  assert.equal(h.calls[0]!.model, "fake/small");
});

test("Side invalidation of a real fingerprint mismatch cannot turn it into rebuildable absence", async (t) => {
  const h = harness({ shadow: false, system: true }), lease = seedPrefix(h, false, true);
  t.after(() => lease.retire());
  h.ctx.modelRegistry.getRegisteredProviderIds = () => [];
  // Stand-in for another consumer recording a structural selection failure.
  getEffectiveContextStore().invalidate(h.sm.getSessionId(), "fingerprint-changed");
  assert.equal(getEffectiveContextStore().reason(h.sm.getSessionId()), "fingerprint-changed");
  assert.equal(getEffectiveContextStore().get(h.sm.getSessionId(), lease.generation), undefined);
  let rebuilt = false;
  h.ctx.getSystemPrompt = () => { rebuilt = true; return "SHOULD_NOT_REBUILD"; };
  const run = h.run(await h.commit());
  assert.equal(rebuilt, false);
  assert.equal(run.outputs.main.prefix, undefined);
  assert.equal(run.outputs.main.prefixCapture.reason, "fingerprint-changed");
  assert.match(run.outputs.main.fallbackReason, /fingerprint-changed/);
  assert.equal(h.calls[0]!.model, "fake/small");
});

test("the adopted slot commits without waiting; the late shadow lands silently in the same run log", async () => {
  const h = harness(), entries = h.sm.getEntries().length;
  const pending = h.compact();
  (await h.next("adopt")).release();
  const result = await pending;
  const operationId = result.compaction!.details.operationId;
  let run = h.run(operationId);
  assert.equal(run.adopted.slot, "main");
  assert.equal(run.outputs.main.status, "generated");
  assert.equal(run.outputs.small.status, "generating");
  const shadowCall = await h.next("shadow");
  const noticesAtCommit = h.notices.length;
  shadowCall.release();
  run = await until(() => { const r = h.run(operationId); return r.outputs.small.status === "generated" && r; }, "shadow written");
  assert.equal(run.adopted.slot, "main");
  assert.ok(run.outputs.small.attempts.every((a: any) => a.status === "settled" && a.usageKnown && a.elapsedMs >= 0));
  assert.equal(run.totalUsage.rawAttempts.length, 2);
  assert.ok(run.timings.shadowSettledMs >= run.totalElapsedMs);
  assert.equal(h.runs().length, 1);
  assert.deepEqual(h.sent, [], "the shadow sends nothing to the session or model");
  assert.equal(h.sm.getEntries().length, entries);
  assert.equal(h.notices.length, noticesAtCommit, "the shadow posts no notice");
  assert.ok(h.notices.every((n) => !n.includes("影子")));
});

test("missing capture rebuilds the main request and records its diagnostic before sending and after failure", async (t) => {
  const h = harness({ invalidSmall: true });
  const lease = acquireEffectiveCapture({ owner: "diagnostic-test", sessionId: h.sm.getSessionId(), binding: h.sm });
  t.after(() => lease.retire());
  getEffectiveContextStore().invalidate(h.sm.getSessionId(), "awaiting-provider-capture");
  const pending = h.compact();
  const adopted = await h.next("adopt");
  assert.equal(adopted.model, "fake/main");
  assert.equal(adopted.outputAtSend.requestedModel, "fake/main");
  assert.equal(adopted.outputAtSend.effectiveModel, adopted.model);
  assert.equal(adopted.outputAtSend.attempts[0].promptVersion, 9);
  assert.equal(adopted.outputAtSend.attempts[0].promptVariant, "main");
  assert.equal(adopted.outputAtSend.fallbackReason, undefined);
  assert.equal(adopted.outputAtSend.prefix.source, "rebuilt");
  const diagnostic = { generation: lease.generation, reason: "awaiting-provider-capture" };
  assert.deepEqual(adopted.outputAtSend.prefixCapture, diagnostic);
  assert.match(adopted.outputAtSend.prefix.reason, /awaiting-provider-capture/);
  adopted.release();
  let settled = false;
  void pending.finally(() => { settled = true; });
  while (!settled) {
    for (const call of h.calls.filter(c => !c.settled)) call.release();
    await new Promise(r => setTimeout(r, 2));
  }
  await pending;
  const log = h.run(h.runs()[0].replace(/\.json$/, ""));
  assert.equal(log.outputs.main.status, "failed");
  assert.deepEqual(log.outputs.main.prefixCapture, diagnostic);
  assert.equal(log.outputs.main.effectiveModel, "fake/main");
  assert.equal(log.outputs.main.attempts[0].model, "fake/main");
  assert.equal(log.outputs.main.attempts[0].promptVariant, "main");
  assert.match(log.outputs.main.error, /empty-compaction-body/);
  await h.emit("session_shutdown");
});

test("a session shutdown cancels a running shadow, records it interrupted and never replays it", async () => {
  const h = harness();
  const operationId = await h.commit();
  const shadowCall = await h.next("shadow");
  await h.emit("session_shutdown");
  const run = h.run(operationId); // shutdown waits for the cancelled shadow's write
  assert.equal(run.outputs.small.status, "cancelled");
  assert.match(run.outputs.small.error, /session-boundary-changed/);
  assert.ok(run.outputs.small.attempts.length && run.outputs.small.attempts.every((a: any) => a.status === "interrupted" && !a.usageKnown && !a.usage));
  assert.equal(typeof run.timings.shadowSettledMs, "number");
  assert.equal(run.adopted.slot, "main");
  shadowCall.release();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.length, 2);
  assert.equal(h.run(operationId).outputs.small.status, "cancelled");
});

test("the next compaction cancels the previous operation's running shadow", async () => {
  const h = harness();
  const firstId = await h.commit();
  await h.next("shadow");
  const secondId = await h.commit();
  const cancelled = await until(() => { const r = h.run(firstId); return r.outputs.small.status === "cancelled" && r; }, "previous shadow cancelled");
  assert.match(cancelled.outputs.small.error, /next-compaction/);
  (await h.next("shadow")).release();
  await until(() => h.run(secondId).outputs.small.status === "generated", "second shadow written");
  assert.equal(h.run(firstId).outputs.small.status, "cancelled");
  assert.equal(h.calls.filter((c) => !c.settled).length, 0);
});

test("a same-session restart or reload keeps the cancelled shadow's record through the next business turn", async () => {
  for (const reload of [false, true]) {
    const h = harness();
    const operationId = await h.commit();
    await h.next("shadow");
    let on = h.emit;
    if (reload) { await h.emit("session_shutdown"); on = h.load(); }
    await on("session_start", { reason: reload ? "reload" : "resume" });
    await h.businessTurn(on);
    const run = h.run(operationId);
    assert.equal(run.status, "committed", `reload=${reload}`);
    assert.equal(run.outputs.small.status, "cancelled", `reload=${reload}`);
    assert.match(run.outputs.small.error, /session-boundary-changed/);
    assert.equal(typeof run.timings.shadowSettledMs, "number");
    assert.ok(run.outputs.small.attempts.every((a: any) => a.status === "interrupted" && !a.usageKnown));
    assert.ok(run.contextSizes.after.providerReported, "the business turn was recorded on the same run");
    await h.emit("session_shutdown");
  }
});

test("resume after a crash marks a committed run's unsettled shadow cancelled and never replays it", async () => {
  const h = harness();
  const operationId = await h.commit();
  await h.next("shadow");
  // The first process dies here: its shadow never writes again. The next process starts the same session.
  const nextProcess = h.load();
  await nextProcess("session_start", { reason: "resume" });
  const run = h.run(operationId);
  assert.equal(run.status, "committed");
  assert.equal(run.outputs.small.status, "cancelled");
  assert.match(run.outputs.small.error, /process ended or the session restarted/);
  assert.ok(run.outputs.small.attempts.every((a: any) => a.status === "interrupted" && !a.usageKnown));
  assert.match(run.warnings.at(-1), /not replayed/);
  assert.equal(h.calls.length, 2);
  await h.emit("session_shutdown"); // stop the stand-in for the dead process
});

test("cancelling a chunked shadow keeps the usage of requests that already settled", async () => {
  // A 12k small window splits the session into two chunks, so the shadow makes several requests.
  const h = harness({ evidence: "evidence ".repeat(5000), outputTokens: 1024, smallWindow: 12000 });
  const operationId = await h.commit();
  (await h.next("shadow")).release(); // first chunk settles with usage
  await h.next("shadow"); // second chunk is in flight
  await h.emit("session_shutdown");
  const attempts = h.run(operationId).outputs.small.attempts;
  assert.equal(attempts.length, 2);
  assert.deepEqual([attempts[0].phase, attempts[0].status, attempts[0].usageKnown, attempts[0].usage?.output], ["chunk", "settled", true, 5]);
  assert.deepEqual([attempts[1].phase, attempts[1].status, attempts[1].usageKnown, attempts[1].usage], ["chunk", "interrupted", false, undefined]);
  assert.equal(h.run(operationId).totalUsage.rawAttempts.filter((a: any) => a.phase === "chunk").length, h.run(operationId).outputs.main.attempts.filter((a: any) => a.phase === "chunk").length + 1, "adopted chunks and the settled shadow chunk");
});


test("unchanged input fails twice, then skips custom generation across a fresh extension instance", async () => {
  const h = harness({ invalidSmall: true, shadow: false, freezeCut: true });
  const runOnce = async (on = h.emit) => {
    const pending = h.compact(on); let done = false; void pending.finally(() => { done = true; });
    while (!done) { for (const call of h.calls.filter(c => !c.settled)) call.release(); await new Promise(r => setTimeout(r, 2)); }
    const result = await pending; assert.ok(result.compaction, h.notices.join("\n")); return h.run(result.compaction!.details.operationId);
  };
  const first = await runOnce(), second = await runOnce();
  assert.equal(first.customFailure.state.failures, 1); assert.equal(second.customFailure.state.failures, 2);
  assert.ok(second.outputs.main.attempts.some((a: any) => a.sent));
  const nextProcess = h.load(); await nextProcess("session_start");
  const third = await runOnce(nextProcess);
  assert.equal(third.customFailure.outcome, "backoff"); assert.equal(third.outputs.main.attempts.length, 0);
  assert.match(third.outputs.main.error, /same-input-failure-backoff/); assert.equal(third.adopted.slot, "native");
  assert.equal(third.degraded.attempts.filter((a: any) => a.sent).length, 1);
  h.sm.appendMessage(message([], "aborted"));
  const metadataOnly = await runOnce(nextProcess);
  assert.equal(metadataOnly.customFailure.outcome, "backoff"); assert.equal(metadataOnly.outputs.main.attempts.length, 0);
  // User/source-table intervals and cut stay identical, but a new assistant observation is new input.
  h.sm.appendMessage(message([{ type: "text", text: "NEW_VERIFIED_TOOL_FINDING" }], "stop"));
  const changed = await runOnce(nextProcess);
  assert.equal(changed.customFailure.outcome, "failure"); assert.equal(changed.customFailure.state.failures, 1);
  assert.ok(changed.outputs.main.attempts.some((a: any) => a.sent));
  await nextProcess("session_shutdown");
});

for (const change of ["mode", "effort"] as const) test(`same-input backoff permits a changed ${change} through the real handler`, async () => {
  const h = harness({ invalidSmall: true, shadow: false, freezeCut: true, failNative: true, mode: change === "mode" ? "small" : "main", system: change === "effort" });
  let lease: any;
  const seedCapture = async () => {
    const { acquireEffectiveCapture, contextFingerprint, getEffectiveContextStore, mapEffectiveTurns } = await import("pi-session-runtime/effective-context");
    const { describeNativeContext } = await import("pi-session-runtime/native-child-context");
    const sid = h.sm.getSessionId();
    lease ??= acquireEffectiveCapture({ owner: "backoff-test", sessionId: sid, binding: h.sm });
    const origins = describeNativeContext(h.sm.getBranch()), prefix = convertToLlm(h.sm.buildSessionProjection().messages), model = { provider: "fake", id: "main" };
    const store = getEffectiveContextStore();
    assert.ok(store.put({ sessionId: sid, generation: lease.generation, selectedModel: model, physicalModel: model, thinkingLevel: h.ctx.thinkingLevel, toolLoadoutFingerprint: contextFingerprint([]), capabilityFingerprint: "test", requestOrdinal: 1, leafId: h.sm.getLeafId(), normalizedMessages: prefix, contextCandidateHash: contextFingerprint(prefix), normalizedRequestHash: contextFingerprint(prefix), capturedAt: Date.now(), ...mapEffectiveTurns(prefix, origins), wirePrefix: "unknown" }, store.revision(sid), origins));
  };
  const runOnce = async () => {
    const dir = join(root, "agent/pi-session-compact/runs", h.sm.getSessionId()); mkdirSync(dir, { recursive: true });
    const existing = new Set(h.runs()), pending = h.compact(); let done = false; void pending.finally(() => { done = true; });
    while (!done) { for (const call of h.calls.filter(c => !c.settled)) call.release(); await new Promise(r => setTimeout(r, 2)); }
    await pending; return h.run(h.runs().find(name => !existing.has(name))!.replace(/\.json$/, ""));
  };
  try {
    if (change === "effort") await seedCapture();
    const entries = h.sm.getEntries().length;
    await runOnce(); const second = await runOnce(), blocked = await runOnce();
    assert.equal(second.customFailure.state.failures, 2); assert.equal(blocked.customFailure.outcome, "backoff");
    if (change === "effort") {
      h.sm.appendMessage(message([], "aborted")); await seedCapture();
      const metadata = await runOnce();
      assert.equal(metadata.customFailure.outcome, "backoff");
      assert.equal(metadata.customFailure.key, second.customFailure.key);
    }
    let callbacks: any;
    if (change === "mode") { h.ctx.compact = (options: any) => { callbacks = options; }; await h.command("now main"); }
    else { h.ctx.thinkingLevel = "low"; await seedCapture(); }
    const next = await runOnce(); callbacks?.onComplete();
    assert.notEqual(next.customFailure.key, second.customFailure.key);
    assert.equal(next.customFailure.outcome, "failure"); assert.equal(next.customFailure.state.failures, 1);
    assert.equal(next.modeSelection.selectedMode, "main"); assert.ok(next.outputs.main.attempts.some((a: any) => a.sent));
    if (change === "effort") {
      assert.equal(second.inputFingerprint.requestIdentity.shape, "main-prefix");
      assert.equal(next.inputFingerprint.requestIdentity.shape, "main-prefix");
      assert.equal(second.inputFingerprint.requestIdentity.prefixHash, next.inputFingerprint.requestIdentity.prefixHash);
      assert.equal(next.inputFingerprint.requestIdentity.effectiveEffort, "low");
      assert.equal(next.outputs.main.attempts[0].requestedEffort, "low");
    }
    assert.equal(h.sm.getEntries().length, entries + (change === "effort" ? 1 : 0), "only the explicit empty aborted fixture is added; compactions never commit");
  } finally { lease?.retire(); await h.emit("session_shutdown"); }
});
