import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SideRuntime } from "../local/pi-side-chat/sdk-runtime.ts";
import type { EffectiveContextSelection } from "pi-session-runtime/native-child-context";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
test("new ephemeral Side consumes one Process wait wake and cancels before destroying its directory", async () => {
  const root = await mkdtemp(join(process.env.PI_PROCESSES_TEST_OUTPUT ?? tmpdir(), "side-process-mailbox-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const gate = join(root, "ready");
  const { createProcessesSideFactory } = await import(new URL("../local/pi-processes/dist/index.js", import.meta.url).href);
  const faux = fauxProvider({ provider: "side-process-fixture", api: "side-process-fixture", models: [{ id: "fixture", contextWindow: 32000 }], tokensPerSecond: 1000000 });
  const requests: string[] = [];
  faux.setResponses(Array.from({ length: 10 }, () => context => {
    requests.push(JSON.stringify(context.messages));
    if (requests.length === 1) return fauxAssistantMessage(fauxToolCall("process", { action: "start", name: "side-watch", command: `while [ ! -f '${gate}' ]; do sleep 0.02; done; printf 'READY\\n'; sleep 300`, watches: [{ key: "ready", pattern: "READY", attention: "turn" }], continuation: { mode: "wait", until: { kind: "watch", key: "ready" } } }), { stopReason: "toolUse" });
    return fauxAssistantMessage(requests.length === 2 ? "waiting" : "handled");
  }));
  const selection: EffectiveContextSelection = { source: "request-capture", exactRequestPrefix: false, messages: [{ role: "user", content: "Main context", timestamp: 1 }], turnAnchors: [], preambleMessageIndices: [], attachedMessageIndices: [], turnMappingReliable: false };
  let factory: any, side: SideRuntime | undefined;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir, parentSettings: { retry: { enabled: false } }, projectTrusted: false, selection, provider: "side-process-fixture", model: "fixture", thinkingLevel: "off", modelScope: ["side-process-fixture/fixture"], tools: ["process"], systemPrompt: "Fixture",
      factories: async sessionScopeId => { factory = createProcessesSideFactory({ sessionScopeId, agentDir }); return [pi => pi.registerProvider(faux.provider), factory]; },
      beforeDispose: async () => { await factory?.cancelPending(); },
    });
    await side.prompt("Start a background wait");
    assert.equal(faux.state.callCount, 2);
    await writeFile(gate, "ready");
    const deadline = Date.now() + 5000;
    while (faux.state.callCount < 3 && Date.now() < deadline) await delay(20);
    const sessionId = side.session.sessionManager.getSessionId();
    const snapshot = JSON.parse(await readFile(join(agentDir, "mailbox", "v1", sessionId, "pending.json"), "utf8"));
    assert.equal(faux.state.callCount, 3, JSON.stringify({ root, pending: snapshot.pending.map((mail: any) => mail.key), suspended: snapshot.suspended }));
    await delay(100);
    assert.equal(faux.state.callCount, 3);
    assert.equal(requests.filter(body => body.includes("matched watch 'ready'")).length, 1);
    const directory = side.directory;
    await side.destroy("main-shutdown");
    await assert.rejects(stat(directory), { code: "ENOENT" });
    process.stdout.write(JSON.stringify({ root, providerCalls: faux.state.callCount, watchRequests: 1 }) + "\n");
  } finally { await side?.destroy(); if (!process.env.PI_PROCESSES_TEST_OUTPUT) await rm(root, { recursive: true, force: true }); }
});

test("large Side history retains its directory on real mailbox I/O failure and retries durable cancellation", async () => {
  const root = await mkdtemp(join(process.env.PI_PROCESSES_TEST_OUTPUT ?? tmpdir(), "side-process-cancel-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const { createProcessesSideFactory } = await import(new URL("../local/pi-processes/dist/index.js", import.meta.url).href);
  const faux = fauxProvider({ provider: "side-cancel-fixture", api: "side-cancel-fixture", models: [{ id: "fixture" }] });
  faux.setResponses([fauxAssistantMessage("seed")]);
  const selection: EffectiveContextSelection = { source: "request-capture", exactRequestPrefix: false, messages: [], turnAnchors: [], preambleMessageIndices: [], attachedMessageIndices: [], turnMappingReliable: false };
  let factory: any, side: SideRuntime | undefined, slot: string | undefined;
  const evidence: unknown[] = [];
  try {
    side = await SideRuntime.create({ cwd: root, agentDir, parentSettings: { retry: { enabled: false }, compaction: { enabled: false } }, projectTrusted: false, selection,
      provider: "side-cancel-fixture", model: "fixture", thinkingLevel: "off", modelScope: ["side-cancel-fixture/fixture"], tools: [], systemPrompt: "Fixture",
      factories: async sessionScopeId => { factory = createProcessesSideFactory({ sessionScopeId, agentDir }); return [pi => pi.registerProvider(faux.provider), factory]; },
      beforeDispose: async () => {
        await factory.cancelPending();
        evidence.push({ snapshot: JSON.parse(await readFile(join(slot!, "pending.json"), "utf8")), receipts: side!.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && ["agent-mailbox-delivery-v1", "process-notification-migration-v1"].includes(entry.customType)) });
      },
    });
    await side.prompt("seed");
    const manager = side.session.sessionManager, sessionId = manager.getSessionId();
    slot = join(agentDir, "mailbox", "v1", sessionId);
    // Public history records exercise source scanning without sending this history to a model.
    for (let i = 0; i < 10000; i++) manager.appendCustomEntry("side-history-fixture", { index: i, text: "history ".repeat(32) });
    const now = new Date().toISOString();
    const batch = { version: 1, batchId: "side-cancel", sessionScopeId: sessionId, epochId: "side-epoch", reason: "main-admission", mode: "aggregate", createdAt: now,
      items: [{ kind: "watch-match", processId: "proc_sidecancel1", processName: "cancel-source", watchKey: "ready", watchGeneration: 1, count: 1, matchedCount: 1, suppressedCount: 0, firstFactId: "side:host:1", lastFactId: "side:host:1", hostIncarnationId: "host", firstNotificationSequence: 1, lastNotificationSequence: 1, firstObservedAt: now, lastObservedAt: now }] };
    const { processNotificationBatchMessageV1 } = await import(new URL("../local/pi-processes/src/notifications/main-context.ts", import.meta.url).href);
    const key = "batch:side-cancel";
    manager.appendCustomEntry("process-notification-intent-v1", { version: 1, sessionScopeId: sessionId, mail: { producer: "pi-processes", key, anchorEntryId: manager.getLeafId(), policy: "next-request", wake: true, messages: [processNotificationBatchMessageV1(batch)] } });
    await mkdir(slot, { recursive: true });
    await chmod(slot, 0o500);
    const failedAt = performance.now();
    await assert.rejects(side.destroy("main-shutdown"), (error: any) => ["io-error", "EACCES"].includes(error?.code));
    const failureMs = performance.now() - failedAt;
    assert.ok(await stat(side.directory));
    assert.equal(faux.state.callCount, 1);
    await chmod(slot, 0o700);
    const closingAt = performance.now();
    await side.destroy("main-shutdown");
    const closeMs = performance.now() - closingAt;
    await assert.rejects(stat(side.directory), { code: "ENOENT" });
    const { snapshot, receipts } = evidence[0] as any;
    assert.equal(snapshot.pending.length, 0);
    const terminal = snapshot.terminal.find((record: any) => record.mail.key === key)
      ?? receipts.flatMap((entry: any) => entry.data.terminals ?? []).find((record: any) => record.mail.key === key);
    assert.equal(terminal.evidence.outcome, "cancelled");
    assert.equal(faux.state.callCount, 1);
    const summary = { root, historyEntries: 10000, providerCalls: 1, failureMs, closeMs, durableCancelled: true, cancellationReceipts: receipts, afterDestroy: JSON.parse(await readFile(join(slot, "pending.json"), "utf8")) };
    await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2));
    process.stdout.write(JSON.stringify({ ...summary, afterDestroy: undefined, cancellationReceipts: undefined }) + "\n");
  } finally { if (slot) await chmod(slot, 0o700).catch(() => {}); await side?.destroy(); if (!process.env.PI_PROCESSES_TEST_OUTPUT) await rm(root, { recursive: true, force: true }); }
});
