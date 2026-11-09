import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { harness, clearMailboxes, until } from "../../pi-session-inject/test/mailbox-harness.ts";
import { MAILBOX_HOLDER_KEY } from "pi-session-inject/mailbox-v1/light";
import { rebuildMainPrefix } from "../src/main.ts";
import { generateSmall } from "../src/small.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import sessionCompact from "../index.ts";

const slot = (h: Awaited<ReturnType<typeof harness>>) => [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()].find((s: any) => s.sessionManager === h.manager) as any;

async function verify(h: Awaited<ReturnType<typeof harness>>, hidden: string, visible?: string) {
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = h.agentDir;
  try {
    const requests: any[] = [];
    const model = { provider: "fixture", id: "main", api: "fixture", contextWindow: 200000, maxTokens: 32000, reasoning: false, input: ["text"], cost: {}, baseUrl: "" };
    let failMain = false;
    const ctx: any = Object.assign(h.ctx, { model, thinkingLevel: "off", getSystemPrompt: () => "SYSTEM", abort() {}, modelRegistry: { find: () => model, streamSimple(_model: any, context: any) {
      requests.push(context);
      const response = fauxAssistantMessage(failMain && requests.length === 1 ? "" : "HANDOFF", failMain && requests.length === 1 ? { stopReason: "error", errorMessage: "invalid API key" } : {});
      const stream = createAssistantMessageEventStream();
      stream.push(response.stopReason === "error" ? { type: "error", reason: "error", error: response } : { type: "done", reason: "stop", message: response });
      return stream;
    } } });
    const pi: any = Object.assign(h.piFor("compact"), { getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({ retry: { enabled: false } }), registerTool() {}, events: createEventBus() });
    const before = JSON.stringify(slot(h).snapshot), sends = h.sends.length;
    const rebuilt = await rebuildMainPrefix(pi, ctx, h.manager.getBranch());
    assert.equal(JSON.stringify(rebuilt).includes(hidden), false);
    if (visible) assert.ok(JSON.stringify(rebuilt).includes(visible));
    await generateSmall(ctx, { ...DEFAULT_CONFIG, outputTokens: 1024, smallModel: { provider: "fixture", id: "main", effort: "off" } }, h.manager.getBranch(),
      { mergedText: "", estimatedTokens: 0 } as any, { goal: null, memory: [], skills: [], known: [] }, new AbortController().signal, [], [], "small", {}, async () => true);
    assert.equal(requests.length, 1); assert.equal(JSON.stringify(requests).includes(hidden), false);
    if (visible) assert.ok(JSON.stringify(requests).includes(visible));
    assert.equal(JSON.stringify(slot(h).snapshot), before); assert.equal(h.sends.length, sends, "projection sends or releases nothing");

    // A nonretryable custom failure exercises the real handler's native fallback material too.
    requests.length = 0; failMain = true;
    await writeFile(join(h.agentDir, "pi-session-compact", "config.json"), JSON.stringify({ mode: "main", outputTokens: 1024 })).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises"); await mkdir(join(h.agentDir, "pi-session-compact"), { recursive: true });
      await writeFile(join(h.agentDir, "pi-session-compact", "config.json"), JSON.stringify({ mode: "main", outputTokens: 1024 }));
    });
    sessionCompact(pi);
    const kept = h.manager.appendMessage({ role: "user", content: "KEEP", timestamp: 1 });
    const branch = h.manager.getBranch(), projection = h.manager.buildSessionProjection();
    const result = await h.emit("session_before_compact", { reason: "manual", signal: new AbortController().signal, branchEntries: branch, preparation: {
      firstKeptEntryId: kept, messagesToSummarize: projection.messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
      settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 1 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    } });
    const compaction = result.results.find(value => value?.compaction)?.compaction;
    assert.ok(compaction, h.notices.join("\n")); assert.equal(compaction.details.generator, "pi-native");
    assert.equal(requests.length, 2); assert.equal(JSON.stringify(requests).includes(hidden), false);
    if (visible) assert.ok(JSON.stringify(requests[1]).includes(visible));
    await h.emit("session_shutdown", { reason: "quit" });
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
}

test("cancelled receipt-GC body is excluded from rebuilt, small and native fallback", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish(); const p = h.producer("pi-subagents"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-subagents", "CANCELLED_REVIEW_BODY", { wake: false });
    await p.endpoint.put(mail); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await p.endpoint.cancel(mail.key, "cancelled before request"); await until(() => slot(h).snapshot.terminal.length === 0);
    await verify(h, "mail:CANCELLED_REVIEW_BODY");
  } finally { await h.cleanup(); }
});

test("reopened recovery-held body stays excluded while fulfilled history remains in rebuilt, small and native", async () => {
  const h = await harness({ persist: true }); let reader: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await h.finish(); const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const fulfilled = h.mail("pi-processes", "FULFILLED_ALLOWED", { wake: false });
    await p.endpoint.put(fulfilled); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await h.startUser(); await h.context(); await h.finish(); await until(() => slot(h).snapshot.pending.length === 0 && slot(h).snapshot.terminal.length === 0);
    const held = h.mail("pi-processes", "HELD_REVIEW_BODY", { wake: false });
    await p.endpoint.put(held); await until(() => slot(h).snapshot.pending[0]?.nativeEntries.length === 1);
    await h.emit("session_shutdown", { reason: "quit" }); await clearMailboxes();
    reader = await harness({ directory: h.directory, manager: SessionManager.open(h.manager.getSessionFile()!) });
    reader.producer("pi-processes"); await reader.emit("session_start", { reason: "resume" }); assert.equal(slot(reader).recoveryHeld, true);
    await verify(reader, "mail:HELD_REVIEW_BODY", "mail:FULFILLED_ALLOWED");
  } finally { await reader?.cleanup(); await h.cleanup(); }
});
