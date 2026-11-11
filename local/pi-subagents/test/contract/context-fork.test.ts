import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import { acquireEffectiveCapture, getEffectiveContextStore } from "pi-session-runtime/effective-context";
import { describeNativeContext, writeNativeChildSnapshot } from "pi-session-runtime/native-child-context";
import { describeMainEffectiveContext } from "../../src/context/effective.ts";
import { prepareEffectiveChildSession } from "../../src/context/prepare.ts";

test("Subagent preparation uses shared effective selection for none/N/all and leaves Main bytes unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-effective-fork-"));
  const manager = SessionManager.create(dir, join(dir, "main"));
  manager.appendMessage({ role: "user", content: "RAW_BEFORE_COMPRESSION_ONLY", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("old answer"));
  const anchor = manager.appendMessage({ role: "user", content: "retained turn", timestamp: 2 });
  manager.appendCompaction("headings only", anchor, 100, { source: "fixture-compaction-producer" }, true);
  manager.appendMessage(fauxAssistantMessage("retained answer"));
  const provider: any = { streamSimple(_model: unknown, _context: unknown, options: any) { options?.onResponse?.(); return {}; } };
  const model = { provider: "faux", id: "model", api: "faux", input: ["text"], contextWindow: 64000, maxTokens: 512, reasoning: false };
  const pi: any = { getActiveTools: () => [], getAllTools: () => [], getCommands: () => [] };
  const ctx: any = { sessionManager: manager, model, thinkingLevel: "off", cwd: dir,
    modelRegistry: { getRegisteredProviderIds: () => ["faux"], getAll: () => [model], getProvider: () => provider } };
  const lease = acquireEffectiveCapture({ owner: "contract", sessionId: manager.getSessionId(), binding: manager });
  const frozen = { provider: "faux", modelId: "model", thinkingLevel: "off" };
  try {
    for (const forkTurns of ["1", "all"] as const) await assert.rejects(prepareEffectiveChildSession(pi, ctx, { forkTurns, model: frozen }), /effective-context-unavailable/);
    const none = await prepareEffectiveChildSession(pi, ctx, { forkTurns: "none", model: frozen });
    assert.equal(none.inheritedEntryIds.length, 0);
    const identity = await describeMainEffectiveContext(pi, ctx);
    const origins = describeNativeContext(manager.getBranch());
    const messages = [{ role: "system" as const, content: "COMPRESSED_EFFECTIVE_ONLY", timestamp: 0 }, ...origins.filter((origin) => origin.turnId || origin.message.role === "assistant").map((origin) => origin.message)];
    const signal = new AbortController().signal;
    lease.observe({ ...identity, leafId: manager.getLeafId(), signal, auxiliaryMessages: messages, nativeOrigins: origins, knownPreamble: [] });
    lease.refreshProviders(ctx.modelRegistry);
    provider.streamSimple(model, normalizeContext({ messages }), { sessionId: identity.sessionId, signal, onResponse: () => lease.confirmRequest(signal) });
    const before = await readFile(manager.getSessionFile()!);
    for (const forkTurns of ["1", "all"] as const) {
      const snapshot = await prepareEffectiveChildSession(pi, ctx, { forkTurns, model: frozen });
      assert.deepEqual(snapshot.entries.filter((entry) => snapshot.inheritedEntryIds.includes(entry.id)).map((entry) => entry.type === "message" && entry.message), messages);
      assert.doesNotMatch(snapshot.jsonl, /RAW_BEFORE_COMPRESSION_ONLY|headings only/);
      const file = join(dir, forkTurns, "session.jsonl"); await writeNativeChildSnapshot(file, snapshot);
      const child = SessionManager.open(file);
      assert.notEqual(child.getSessionId(), manager.getSessionId());
      assert.deepEqual(child.buildSessionProjection().model, { provider: "faux", modelId: "model" });
      assert.equal(child.buildSessionProjection().thinkingLevel, "off");
    }
    assert.deepEqual(await readFile(manager.getSessionFile()!), before);
    getEffectiveContextStore().invalidate(identity.sessionId, "native-compaction");
    assert.equal(getEffectiveContextStore().get(identity.sessionId, identity.generation), undefined);
    await assert.rejects(prepareEffectiveChildSession(pi, ctx, { forkTurns: "all", model: frozen }), /effective-context-unavailable/);
    assert.equal((await prepareEffectiveChildSession(pi, ctx, { forkTurns: "none", model: frozen })).inheritedEntryIds.length, 0);
  } finally { lease.release(); await rm(dir, { recursive: true, force: true }); }
});
