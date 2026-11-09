import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ProcessMailboxSourceV1, readProcessMailIntentsV1 } from "../../src/notifications/mailbox-source.ts";
import type { ProcessNotificationBatchV1 } from "../../src/notifications/types.ts";

test("A1 rejects pre-tree async put and source retries the frozen intent only on its origin branch", async () => {
  const root = mkdtempSync(join(process.env.PI_PROCESSES_TEST_OUTPUT ?? tmpdir(), "process-mailbox-tree-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const manager = SessionManager.create(root, join(agentDir, "sessions"));
  const faux = fauxProvider({ provider: "tree-fixture", api: "tree-fixture", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage("seed")]);
  let ctx!: ExtensionContext, source!: ProcessMailboxSourceV1;
  const errors: string[] = [];
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
      extensionFactories: [pi => {
        pi.registerProvider(faux.provider);
        source = new ProcessMailboxSourceV1({ pi, agentDir, getContext: () => ctx, callbacks: { checkCurrent: () => ({ kind: "hold", reason: "tree test business hold" }) } });
        pi.on("session_start", (_event, current) => { ctx = current; });
      }],
    } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("tree-fixture", "fixture"), tools: [] });
    await created.session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error) });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: manager });
  try {
    await runtime.session.prompt("seed", { source: "rpc" });
    const now = new Date().toISOString();
    const batch: ProcessNotificationBatchV1 = { version: 1, batchId: "tree-async", sessionScopeId: manager.getSessionId(), epochId: "tree-epoch", reason: "main-admission", mode: "aggregate", createdAt: now,
      items: [{ kind: "watch-match", processId: "proc_tree00000001", processName: "fixture", watchKey: "ready", watchGeneration: 1, count: 1, matchedCount: 1, suppressedCount: 0, firstFactId: "tree:host:1", lastFactId: "tree:host:1", hostIncarnationId: "host", firstNotificationSequence: 1, lastNotificationSequence: 1, firstObservedAt: now, lastObservedAt: now }] };
    const captured = source.prepare(batch, "next-request", false);
    const originLeaf = manager.getLeafId()!;
    let release!: () => void;
    const delayed = (async () => { await new Promise<void>(resolve => { release = resolve; }); return source.endpoint.put(captured.mail, captured.target); })();
    await runtime.session.navigateTree(captured.mail.anchorEntryId!, { summarize: false });
    manager.appendCustomEntry("fixture-sibling", {});
    release();
    await assert.rejects(delayed, { code: "stale-binding" });
    assert.throws(() => source.prepare(batch, "next-request", false), /another branch/);
    assert.deepEqual(readProcessMailIntentsV1(manager.getEntries(), batch.sessionScopeId).get(captured.mail.key), captured.mail);
    assert.equal(manager.getEntries().filter(e => e.type === "custom_message" && e.customType === "process-notification-batch-v1").length, 0);
    await runtime.session.navigateTree(originLeaf, { summarize: false });
    const rebuilt = source.prepare(batch, "next-request", false);
    assert.equal(rebuilt.target.bindingGeneration, captured.target.bindingGeneration + 2);
    assert.deepEqual(rebuilt.mail, captured.mail);
    assert.equal((await source.endpoint.put(rebuilt.mail, rebuilt.target)).kind, "accepted");
    const cancelled = await source.endpoint.cancel(rebuilt.mail.key, "fixture cancelled on original scope", rebuilt.target);
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(faux.state.callCount, 1, "tree/reconcile/cancel cannot start a provider request");
    assert.deepEqual(errors, []);
    const summary = { root, providerCalls: faux.state.callCount, generationBefore: captured.target.bindingGeneration, generationAfter: rebuilt.target.bindingGeneration, outcome: cancelled.outcome };
    writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
    process.stdout.write(JSON.stringify(summary) + "\n");
  } finally { await runtime.dispose(); source?.close(); if (!process.env.PI_PROCESSES_TEST_OUTPUT) rmSync(root, { recursive: true, force: true }); }
});
