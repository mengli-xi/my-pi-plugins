import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MailboxRunEnd } from "pi-session-inject/mailbox-v1";
import { ProcessMailboxSourceV1 } from "./notifications/mailbox-source.js";
import { scanLegacyProcessBatchesV1 } from "./notifications/mailbox-proof.js";
import type { ProcessWaitBridgeV2 } from "pi-runtime-contracts/process-wait-bridge-v2";
import { defaultProcessesConfig, loadProcessesConfig, type ProcessesConfig } from "./config.js";
import type { ProcessHost } from "./host/process-host.js";
import { lifecycleMessage, registerNotificationReceiptRenderer, registerNotificationStatusRenderer } from "./integrations/lifecycle-entry.js";
import { createProcessHost } from "./process-runtime.js";
import { createChildNotificationStrategyV1 } from "./notifications/runtime-strategy.js";
import { ChildTurnNotificationCoordinatorV1 } from "./notifications/child-turn.js";
import { appendNotificationEntryV1 } from "./notifications/tui-projection.js";
import { registerProcessTool } from "./tool/register.js";

interface State {
  context?: ExtensionContext;
  runEnd?: MailboxRunEnd;
  config: ProcessesConfig;
  degraded?: string;
  host?: ProcessHost;
  binding?: ReturnType<ProcessHost["bind"]>;
  recovery?: Promise<ProcessHost | undefined>;
  notifications?: ChildTurnNotificationCoordinatorV1;
}

export interface ProcessesChildOptions {
  readonly sessionScopeId: string | ((ctx: ExtensionContext) => string);
  readonly agentDir: string;
  readonly getBridge: (sessionScopeId: string) => ProcessWaitBridgeV2 | undefined;
}

/** Install one scope per SDK session, without ambient child identity or host lookup. */
export function createProcessesChildFactory(options: ProcessesChildOptions) {
  const snapshot = { ...options };
  let controller: ReturnType<typeof installProcessesChild> | undefined;
  const factory = (pi: ExtensionAPI): void => { controller = installProcessesChild(pi, snapshot); };
  return Object.assign(factory, { cancelPending: (ctx?: ExtensionContext): Promise<void> => controller?.cancelPending(ctx) ?? Promise.resolve() });
}

function installProcessesChild(pi: ExtensionAPI, options: ProcessesChildOptions) {
  const scopeId = (ctx: ExtensionContext): string => {
    const actual = ctx.sessionManager.getSessionId();
    const expected = typeof options.sessionScopeId === "function" ? options.sessionScopeId(ctx) : options.sessionScopeId;
    if (actual !== expected) {
      throw new Error("[process/scope-mismatch] child factory belongs to another session");
    }
    return actual;
  };
  const notificationStrategy = (sessionScopeId: string) => createChildNotificationStrategyV1(sessionScopeId, options.getBridge);
  const state: State = { config: defaultProcessesConfig() };
  const mailbox = new ProcessMailboxSourceV1({
    pi, agentDir: options.agentDir, getContext: () => state.context,
    callbacks: {
      checkCurrent: mail => state.notifications?.checkCurrent(mail) ?? { kind: "hold", reason: "Child Process source is initializing" },
      onRecorded: notice => { mailbox.recorded(notice); if (!state.notifications) throw new Error("Child Process source is initializing"); state.notifications.recorded(notice); },
      onTerminal: evidence => { if (!state.notifications) throw new Error("Child Process source is initializing"); state.notifications.terminal(evidence); },
      beforeRun: async () => {
        state.runEnd = undefined;
        const ctx = state.context;
        if (ctx) await mailbox.reconcileRecoveredChildOwners(ctx, () => options.getBridge(scopeId(ctx))?.captureOwnerToken(),
          message => console.warn(`[pi-processes child] ${message}`));
        state.notifications?.recoverPrepared();
      },
      afterRun: end => { state.runEnd = end; },
      settled: event => {
        if (!event.aborted && state.runEnd?.outcome === "completed") for (const member of state.runEnd.members) mailbox.mark(member.mail.key, "turn-settled");
        state.runEnd = undefined;
        state.notifications?.retryPendingTriggers();
      },
    },
  });
  registerNotificationReceiptRenderer(pi);
  registerNotificationStatusRenderer(pi);
  const runtime = () => state.host ? {
    host: state.host,
    config: state.config,
    ...(state.degraded ? { configError: new Error(`[process/config-invalid] ${state.degraded}`) } : {}),
    cwd: state.context?.cwd ?? process.cwd(),
  } : undefined;

  const bindHost = async (host: ProcessHost, ctx: ExtensionContext): Promise<void> => {
    const sessionScopeId = scopeId(ctx);
    state.notifications?.dispose();
    state.host = host;
    refreshToolSchema();
    const notifications = new ChildTurnNotificationCoordinatorV1({
      sessionScopeId,
      host,
      mailbox,
      getContext: () => state.context,
      getBridge: () => options.getBridge(sessionScopeId),
      report: (message) => console.warn(`[pi-processes child] ${message}`),
    });
    state.notifications = notifications;
    const binding = host.bind({
      deliver: async (event, delivery) => {
        if (event.type === "logCursorAdvanced" || event.type === "capacityChanged") return;
        const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
        if (!id) return;
        const process = host.summary(id);
        if (!process) return;
        const message = lifecycleMessage(event, process);
        const attention = host.lifecycleAttention(event);
        if (!message || !attention) return;
        const target = host.notificationTarget(id);
        if (!target) return;
        if (attention === "turn" || delivery?.wakeTransactionId !== undefined) {
          notifications.accept({
            target,
            processId: id,
            lane: delivery?.modelLane ?? "turn",
          });
          if (delivery?.wakeTransactionId) return { deferWake: true as const };
          // The coordinator owns this prepared window until its receipt commits.
          return;
        }
        if (delivery?.modelOwned && delivery.modelLane) host.discardNotificationWindow(id, delivery.modelLane);
      },
      appendNotificationEntry: (entry) => { appendNotificationEntryV1(pi, ctx, entry); },
      notificationEntriesPersisted: () => notifications.notificationEntriesPersisted(),
      requestRender: () => {},
      report: (message) => console.warn(`[pi-processes child] ${message}`),
    });
    state.binding = binding;
    host.initializeStripPreference(state.config.presentation.stripInitiallyCollapsed);
    const intents = await mailbox.restoreChildIntents(ctx, () => options.getBridge(sessionScopeId)?.captureOwnerToken(),
      message => console.warn(`[pi-processes child] ${message}`));
    for (const legacy of scanLegacyProcessBatchesV1(ctx.sessionManager.getBranch(), sessionScopeId)) {
      if (!intents.has(`batch:${legacy.batch.batchId}`) && legacy.state !== "turn-settled") {
        mailbox.recordMigration(legacy.batch.batchId, "visible-unknown", "Child batch requires surviving Task/grant evidence");
        console.warn(`[pi-processes child] migration visible-unknown: ${legacy.batch.batchId} requires surviving Task/grant evidence`);
      }
    }
    await binding.markReady();
    notifications.recoverPrepared();
  };

  const recoverRuntime = async () => {
    const current = state.host;
    if (current && !current.disposed) return runtime();
    const ctx = state.context;
    if (!ctx) return undefined;
    if (!state.recovery) {
      state.recovery = (async () => {
        if (current) {
          await current.dispose("protocol-failure");
          if (current.cleanupError) throw current.cleanupError;
        }
        if (state.context !== ctx) return undefined;
        const sessionScopeId = scopeId(ctx);
        const replacement = createProcessHost(sessionScopeId, () => state.config, import.meta.dirname, notificationStrategy(sessionScopeId));
        if (replacement.disposed) throw replacement.cleanupError ?? new Error("[process/supervisor-unavailable] disposed host is still awaiting containment");
        await bindHost(replacement, ctx);
        return replacement;
      })().finally(() => { state.recovery = undefined; });
    }
    await state.recovery;
    return runtime();
  };

  const refreshToolSchema = registerProcessTool(pi, runtime, recoverRuntime);

  pi.on("session_start", async (_event, ctx) => {
    state.context = ctx;
    const loaded = await loadProcessesConfig({ agentDir: options.agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    if (loaded.ok) {
      state.config = loaded.config;
      state.degraded = undefined;
    } else {
      state.degraded = `${loaded.diagnostic.path}: ${loaded.diagnostic.message}`;
    }
    const sessionScopeId = scopeId(ctx);
    await bindHost(createProcessHost(sessionScopeId, () => state.config, import.meta.dirname, notificationStrategy(sessionScopeId)), ctx);
  });

  pi.on("context", (event, ctx) => ({ messages: (state.notifications?.filterContext(event.messages, ctx.sessionManager.getBranch()) ?? event.messages) as typeof event.messages }));
  pi.on("turn_end", () => { state.notifications?.retryPendingTriggers(); });

  pi.on("session_shutdown", async (event, ctx) => {
    const binding = state.binding;
    state.notifications?.dispose();
    if (event.reason === "reload" || event.reason === "quit") mailbox.close();
    state.notifications = undefined;
    state.binding = undefined;
    state.recovery = undefined;
    state.context = undefined;
    state.host = undefined;
    if (binding) await binding.retire(event.reason === "reload" && !state.config.managed && !state.config.execution.isolation ? "reload" : event.reason === "quit" ? "pi-exit" : "scope-ended");
  });
  return {
    cancelPending: async (ctx = state.context): Promise<void> => {
      if (!ctx || !state.notifications) return;
      await state.notifications.cancelPending(ctx, mailbox);
    },
  };
}
