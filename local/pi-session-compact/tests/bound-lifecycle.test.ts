import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, createEventBus, convertToLlm } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { acquireEffectiveCapture, contextFingerprint, getEffectiveContextStore, mapEffectiveTurns } from "pi-session-runtime/effective-context";
import { describeNativeContext } from "pi-session-runtime/native-child-context";
import sessionCompact from "../index.ts";

const root = mkdtempSync(join(tmpdir(), "compact-proof-life-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent/pi-session-compact"), { recursive: true });
writeFileSync(join(root, "agent/pi-session-compact/config.json"), JSON.stringify({ mode: "small", outputTokens: 1024, smallModel: { provider: "fake", id: "small", effort: "off" } }));
after(() => rmSync(root, { recursive: true, force: true }));
const usage = { input: 99999, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 100000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model: any = { provider: "p", id: "m", api: "fake", contextWindow: 200000, maxTokens: 24000, reasoning: false, input: ["text"], cost: {}, baseUrl: "" };
const reply: any = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2, provider: "p", model: "m", api: "fake", stopReason: "stop", usage };

for (const boundary of ["second business request", "tree leave and return"] as const) test(`measured capacity proof survives ${boundary}`, async () => {
  const sm = SessionManager.inMemory(root);
  sm.appendMessage({ role: "user", content: "short old input", timestamp: 1 });
  sm.appendMessage({ role: "user", content: "x".repeat(1200000), timestamp: 2 });
  const kept = sm.getLeafId()!, branch = sm.getBranch(), sid = sm.getSessionId();
  const lease = acquireEffectiveCapture({ owner: "proof-lifecycle-test", sessionId: sid, binding: sm });
  try {
    const origins = describeNativeContext(branch), captured = convertToLlm(sm.buildSessionProjection().messages);
    const store = getEffectiveContextStore(), ref = { provider: "p", id: "m" };
    assert.ok(store.put({ sessionId: sid, generation: lease.generation, selectedModel: ref, physicalModel: ref, thinkingLevel: "off", toolLoadoutFingerprint: contextFingerprint([]), capabilityFingerprint: "test", requestOrdinal: 1, leafId: kept, normalizedMessages: captured, contextCandidateHash: contextFingerprint(captured), normalizedRequestHash: contextFingerprint(captured), capturedAt: Date.now(), ...mapEffectiveTurns(captured, origins), wirePrefix: "unknown" }, store.revision(sid), origins));
    sm.appendMessage(reply);
    const handlers = new Map<string, any>(), notices: string[] = [];
    let aborted = false, requests = 0;
    const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerCommand() {}, sendMessage() {}, events: createEventBus(), getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { reserveTokens: 20000 } }) };
    const ctx: any = { model, thinkingLevel: "off", cwd: root, sessionManager: sm, abort() { aborted = true; }, ui: { notify(s: string) { notices.push(s); }, theme: { fg: (_c: string, s: string) => s } }, modelRegistry: { find: () => ({ ...model, provider: "fake", id: "small", contextWindow: 1000000 }), streamSimple() {
      requests++;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: { ...reply, provider: "fake", model: "small", content: [{ type: "text", text: "handoff" }] } });
      return stream;
    } } };
    sessionCompact(pi);
    const current = sm.getBranch();
    const result = await handlers.get("session_before_compact")({ reason: "manual", branchEntries: current, signal: new AbortController().signal, preparation: { firstKeptEntryId: kept, messagesToSummarize: [current[0]!.type === "message" ? current[0]!.message : reply], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100000, settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() } } }, ctx);
    assert.ok(result.compaction, notices.join("\n"));
    const c = result.compaction;
    sm.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
    await handlers.get("session_compact")({}, ctx);
    const request = () => handlers.get("context_with_system")({ messages: sm.buildSessionProjection().messages }, ctx);
    request();
    assert.equal(aborted, false, notices.join("\n"));
    if (boundary === "second business request") {
      sm.appendMessage({ ...reply, timestamp: 3 });
      await handlers.get("turn_end")({ message: reply, messageEntryId: sm.getLeafId() }, ctx);
      sm.appendMessage({ role: "user", content: "continue", timestamp: 4 });
    } else {
      const restoredLeaf = sm.getLeafId()!;
      sm.branch(branch[0]!.id);
      handlers.get("session_tree")({}, ctx);
      request(); // The branch without a compaction must not borrow its proof or accounting.
      assert.equal(aborted, false);
      sm.branch(restoredLeaf);
      handlers.get("session_tree")({}, ctx);
    }
    request();
    assert.equal(aborted, false, notices.join("\n"));
    assert.equal(requests, 1, "only the faux summary is generated");
    // New material still costs its full estimate after the lifecycle boundary.
    sm.appendMessage({ role: "user", content: "NEW".repeat(200000), timestamp: 5 });
    request();
    assert.equal(aborted, true, "the proof does not cap newly appended material");
    await handlers.get("session_shutdown")({}, ctx);
  } finally { lease.retire(); }
});
