import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ProcessMailboxSourceV1 } from "../../src/notifications/mailbox-source.ts";
import { MainTurnNotificationCoordinatorV1 } from "../../src/notifications/main-turn.ts";
import { processNotificationBatchMessageV1 } from "../../src/notifications/main-context.ts";
import { ProcessHost } from "../../src/host/process-host.ts";
import type { ProcessNotificationBatchV1 } from "../../src/notifications/types.ts";

for (const scenario of ["pending", "intent", "orphan", "settled", "missing-assistant", "foreign"] as const) test("real A1 imports legacy " + scenario + " without running its Process", async () => {
  const root = mkdtempSync(join(process.env.PI_PROCESSES_TEST_OUTPUT ?? tmpdir(), "process-legacy-" + scenario + "-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const manager = SessionManager.create(root, join(agentDir, "sessions")), sessionId = manager.getSessionId();
  const faux = fauxProvider({ provider: "legacy-fixture", api: "legacy-fixture", models: [{ id: "fixture" }], tokensPerSecond: 1000000 });
  faux.setResponses([fauxAssistantMessage("handled")]);
  manager.appendMessage({ role: "user", content: "old run", timestamp: 1 });
  manager.appendMessage({ ...fauxAssistantMessage("old seed"), api: "legacy-fixture", provider: "legacy-fixture", model: "fixture" });
  const now = new Date().toISOString();
  const batch: ProcessNotificationBatchV1 = { version: 1, batchId: "legacy-fixture", sessionScopeId: scenario === "foreign" ? "another-session" : sessionId, epochId: "old-epoch", reason: "main-admission", mode: "aggregate", createdAt: now,
    items: [{ kind: "watch-match", processId: "proc_legacy000001", processName: "legacy", watchKey: "ready", watchGeneration: 1, count: 1, matchedCount: 1, suppressedCount: 0, firstFactId: "legacy:host:1", lastFactId: "legacy:host:1", hostIncarnationId: "host", firstNotificationSequence: 1, lastNotificationSequence: 1, firstObservedAt: now, lastObservedAt: now }] };
  const carrier = processNotificationBatchMessageV1(batch);
  if (scenario === "intent") manager.appendCustomEntry("process-notification-intent-v1", { version: 1, sessionScopeId: sessionId, mail: { producer: "pi-processes", key: "batch:" + batch.batchId, anchorEntryId: manager.getLeafId(), policy: "next-request", wake: true, messages: [carrier] } });
  else manager.appendCustomMessageEntry(carrier.customType, carrier.content, carrier.display, carrier.details);
  if (["pending", "settled", "missing-assistant"].includes(scenario)) manager.appendCustomEntry("process-notification-status-v1", { version: 1, sessionScopeId: sessionId, batchId: batch.batchId, state: "pending" });
  if (scenario === "settled") manager.appendMessage({ ...fauxAssistantMessage("old completion"), api: "legacy-fixture", provider: "legacy-fixture", model: "fixture" });
  if (scenario === "settled" || scenario === "missing-assistant") manager.appendCustomEntry("process-notification-status-v1", { version: 1, sessionScopeId: sessionId, batchId: batch.batchId, state: "turn-settled" });
  let ctx!: ExtensionContext, source!: ProcessMailboxSourceV1, coordinator!: MainTurnNotificationCoordinatorV1;
  const errors: string[] = [], reports: string[] = [];
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"], extensionFactories: [pi => {
        pi.registerProvider(faux.provider);
        source = new ProcessMailboxSourceV1({ pi, agentDir, getContext: () => ctx, callbacks: {
          checkCurrent: mail => coordinator?.checkCurrent(mail) ?? { kind: "hold", reason: "initializing" },
          onRecorded: notice => coordinator.recorded(notice), onTerminal: evidence => coordinator.terminal(evidence),
          beforeRun: start => coordinator.beforeRun(start), afterRun: end => coordinator.afterRun(end), settled: event => coordinator.agentSettled(event.aborted),
        } });
        pi.on("session_start", async (_event, current) => {
          ctx = current;
          const host = new ProcessHost({ sessionScopeId: sessionId, launch: async () => { throw new Error("legacy import must not reexecute its process"); } });
          coordinator = new MainTurnNotificationCoordinatorV1({ sessionScopeId: sessionId, host, pi, mailbox: source, getContext: () => ctx, report: report => reports.push(report) });
          coordinator.activate(ctx); await coordinator.importLegacy(ctx, source);
        });
      }],
    } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("legacy-fixture", "fixture"), tools: [] });
    await created.session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error) });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: manager });
  const snapshot = () => { try { return JSON.parse(readFileSync(join(agentDir, "mailbox/v1", sessionId, "pending.json"), "utf8")); } catch(error) { if((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], terminal: [] }; throw error; } };
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(errors, []);
    assert.equal(faux.state.callCount, 0);
    const unknown = manager.getEntries().some(e => e.type === "custom" && e.customType === "process-notification-migration-v1" && (e.data as any).classification === "visible-unknown");
    assert.equal(unknown, scenario === "orphan" || scenario === "missing-assistant");
    if (["pending", "intent", "orphan"].includes(scenario)) {
      assert.equal(snapshot().pending.length, 1);
      assert.equal(snapshot().pending[0].policy, scenario === "orphan" ? "next-user" : "next-request");
      assert.equal(snapshot().pending[0].wake, scenario !== "orphan");
    }
    if (scenario === "settled") {
      assert.equal(snapshot().pending.length, 0);
      assert.equal(manager.getEntries().some(e => e.type === "custom" && e.customType === "agent-mailbox-delivery-v1"), true);
      assert.deepEqual(coordinator.pendingBatchIds(), []);
    }
    const nativeBodies = () => manager.getEntries().filter(e => e.type === "custom_message" && e.customType === "process-notification-batch-v1").length;
    assert.equal(nativeBodies(), scenario === "intent" ? 0 : 1);
    const coldCalls = faux.state.callCount;
    if (scenario === "pending" || scenario === "intent") {
      await runtime.session.prompt("/mailbox resume", { source: "rpc" });
      const deadline = Date.now() + 5000;
      while (snapshot().pending.length || snapshot().terminal.length) {
        assert.ok(Date.now() < deadline, "resume must fulfill and ACK/GC its original key");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(faux.state.callCount, 1);
      assert.equal(nativeBodies(), 1);
    }
    const summary = { root, scenario, coldCalls, providerCalls: faux.state.callCount, nativeBodies: nativeBodies(), visibleUnknown: unknown, reports };
    writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2)); process.stdout.write(JSON.stringify(summary) + "\n");
  } finally { await runtime.dispose(); coordinator?.dispose(); source?.close(); if (!process.env.PI_PROCESSES_TEST_OUTPUT) rmSync(root, { recursive: true, force: true }); }
});
