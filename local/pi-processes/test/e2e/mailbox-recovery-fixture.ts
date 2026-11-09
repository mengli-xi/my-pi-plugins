import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProcessMailboxSourceV1 } from "../../src/notifications/mailbox-source.js";
import { MainTurnNotificationCoordinatorV1 } from "../../src/notifications/main-turn.js";
import { ProcessHost } from "../../src/host/process-host.js";
import type { ProcessNotificationBatchV1 } from "../../src/notifications/types.js";

export default function (pi: ExtensionAPI) {
  const root = process.env.PI_PROCESS_RECOVERY_ROOT!, phase = Number(process.env.PI_PROCESS_RECOVERY_PHASE), compacted = process.env.PI_PROCESS_RECOVERY_SCENARIO === "compacted";
  const log = (value: unknown) => appendFileSync(join(root, "phase" + phase + ".jsonl"), JSON.stringify(value) + "\n");
  let ctx: ExtensionContext, coordinator: MainTurnNotificationCoordinatorV1, seeded = false, markerFaultLogged = false;
  const businessPi = { ...pi, appendEntry: (type: string, data?: unknown) => {
    if (process.env.PI_PROCESS_RECOVERY_SCENARIO === "marker-fault" && phase === 2 && type === "process-notification-status-v1" && (data as { state?: string })?.state === "pending" && !existsSync(join(root, "allow-marker"))) {
      if (!markerFaultLogged) { markerFaultLogged = true; log({ stage: "marker-fault" }); }
      throw new Error("FAULT process pending marker");
    }
    pi.appendEntry(type, data);
  } };
  const source = new ProcessMailboxSourceV1({ pi, agentDir: process.env.PI_CODING_AGENT_DIR!, getContext: () => ctx, callbacks: {
    checkCurrent: mail => phase === 1 ? compacted ? { kind: "allow", project: true, wake: false } : { kind: "hold", reason: "fixture crash window after durable acceptance" } : coordinator?.checkCurrent(mail) ?? { kind: "hold", reason: "initializing" },
    onRecorded: notice => { coordinator.recorded(notice); log({ stage: "recorded", key: notice.key }); },
    onTerminal: evidence => { log({ stage: "terminal", evidence }); if (phase === 2) throw new Error("FAULT source final ACK lost"); coordinator.terminal(evidence); },
    beforeRun: start => coordinator.beforeRun(start), afterRun: end => coordinator.afterRun(end), settled: event => coordinator.agentSettled(event.aborted),
  } });
  const faux = fauxProvider({ provider: "recovery-faux", api: "recovery-faux", models: [{ id: "fixture" }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 5 }, () => context => { log({ stage: "request", call: faux.state.callCount, messages: context.messages }); return fauxAssistantMessage(compacted && phase === 1 && faux.state.callCount === 1 ? "seed detail ".repeat(3000) : "HANDLED"); }));
  pi.registerProvider(faux.provider);
  pi.on("session_compact", () => log({ stage: "compacted" }));
  pi.registerCommand("process-recovery-cancel", { description: "Cancel this fixture source", handler: async (_args, commandCtx) => { await coordinator.cancelPending(commandCtx, source); log({ stage: "cancelled" }); } });
  pi.on("session_start", async (_event, current) => {
    ctx = current;
    const host = new ProcessHost({ sessionScopeId: ctx.sessionManager.getSessionId(), launch: async () => { throw new Error("recovery fixture must not execute a process"); } });
    coordinator = new MainTurnNotificationCoordinatorV1({ sessionScopeId: ctx.sessionManager.getSessionId(), host, pi: businessPi, mailbox: source, getContext: () => ctx });
    coordinator.activate(ctx);
    await coordinator.importLegacy(ctx, source);
    log({ stage: "ready", sessionId: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), businessPending: coordinator.pendingBatchIds() });
  });
  pi.on("input", event => coordinator?.captureInput({ source: event.source, streamingBehavior: event.streamingBehavior }));
  pi.on("agent_settled", async () => {
    log({ stage: "settled", calls: faux.state.callCount });
    if (phase !== 1 || seeded) return;
    seeded = true;
    const now = new Date().toISOString(), sessionScopeId = ctx.sessionManager.getSessionId();
    const batch: ProcessNotificationBatchV1 = { version: 1, batchId: "crash-recovery", sessionScopeId, epochId: "fixture-epoch", reason: "main-admission", mode: "aggregate", createdAt: now,
      items: [{ kind: "watch-match", processId: "proc_recover00001", processName: "recovery-source", watchKey: "ready", watchGeneration: 1, count: 1, matchedCount: 1, suppressedCount: 0, firstFactId: "recover:host:1", lastFactId: "recover:host:1", hostIncarnationId: "host", firstNotificationSequence: 1, lastNotificationSequence: 1, firstObservedAt: now, lastObservedAt: now }] };
    await source.submit(batch, "next-request", true);
    log({ stage: "accepted", file: ctx.sessionManager.getSessionFile(), sessionId: sessionScopeId });
  });
}
