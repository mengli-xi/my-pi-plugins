import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadProcessesConfig, type ProcessesConfig } from "./config.js";
import type { ProcessHost } from "./host/process-host.js";
import { lifecycleMessage, registerLifecycleRenderer, registerNotificationStatusRenderer } from "./integrations/lifecycle-entry.js";
import { installProcessesStatusProtocol } from "./integrations/status-protocol.js";
import { registerProcessTool } from "./tool/register.js";
import { installProcessUi } from "./ui/install.js";
import { installProcessChildCapability } from "./subagent-capability.js";
import { createProcessHost } from "./process-runtime.js";
import { scheduleStaleRootCleanup } from "./host/stale-root-cleanup.js";
import { createMainNotificationStrategyV1 } from "./notifications/runtime-strategy.js";
import { appendNotificationEntryV1 } from "./notifications/tui-projection.js";
import { MainTurnNotificationCoordinatorV1 } from "./notifications/main-turn.js";
import { ProcessMailboxSourceV1 } from "./notifications/mailbox-source.js";
import { createCompactReinjection } from "./compact-reinject.js";

const DEFAULT_CONFIG: ProcessesConfig = {
  schemaVersion: 1,
  execution: { shell: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash", helperRuntime: "auto", stopGraceMs: 3000 },
  limits: { maxLiveProcesses: 32, maxTerminalRecords: 500, perProcessLogBytes: 67_108_864, sessionLogBytes: 536_870_912 },
  notifications: { onSuccess: "turn", onFailure: "turn", onKilled: "context", onCrash: "turn" },
  presentation: { stripInitiallyCollapsed: false },
};

interface RuntimeState {
  runActive?: boolean;
  compactDrain?: ReturnType<typeof setTimeout>;
  context?: ExtensionContext;
  config: ProcessesConfig;
  degraded?: string;
  binding?: ReturnType<ProcessHost["bind"]>;
  host?: ProcessHost;
  recovery?: Promise<ProcessHost | undefined>;
  turnNotifications?: MainTurnNotificationCoordinatorV1;
}

function cloneDefaults(): ProcessesConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export default function processesExtension(pi: ExtensionAPI): void {
  installProcesses(pi);
}

/** Side owns a normal conversation scope, never a Subagent Task bridge. */
export function createProcessesSideFactory(options: { readonly sessionScopeId: string; readonly agentDir: string }) {
  const frozen = { ...options };
  let controller: ReturnType<typeof installProcesses> | undefined;
  const factory = (pi: ExtensionAPI): void => { controller = installProcesses(pi, frozen); };
  return Object.assign(factory, { cancelPending: (ctx?: ExtensionContext): Promise<void> => controller?.cancelPending(ctx) ?? Promise.resolve() });
}

function installProcesses(pi: ExtensionAPI, side?: { sessionScopeId: string; agentDir: string }) {
  const childCapability = side ? undefined : installProcessChildCapability(import.meta.dirname);
  const state: RuntimeState = { config: cloneDefaults() };
  const mailbox = new ProcessMailboxSourceV1({
    pi, agentDir: side?.agentDir ?? getAgentDir(), getContext: () => state.context,
    callbacks: {
      checkCurrent: mail => state.turnNotifications?.checkCurrent(mail) ?? { kind: "hold", reason: "Process source is initializing" },
      onRecorded: notice => { if (!state.turnNotifications) throw new Error("Process source is initializing"); state.turnNotifications.recorded(notice); },
      onTerminal: evidence => { if (!state.turnNotifications) throw new Error("Process source is initializing"); state.turnNotifications.terminal(evidence); },
      beforeRun: start => state.turnNotifications?.beforeRun(start),
      afterRun: end => state.turnNotifications?.afterRun(end),
      settled: async (event) => { state.runActive = false; await state.turnNotifications?.agentSettled(event.aborted); },
    },
  });
  registerLifecycleRenderer(pi);
  registerNotificationStatusRenderer(pi);
  const processUi = side ? { open: (_id?: string) => {}, requestRender: () => {}, mount: (_input: unknown) => {}, unmount: (_ctx?: ExtensionContext) => {} } : installProcessUi(pi, () => state.host && state.context ? { host: state.host, context: state.context } : undefined);
  const statusProtocol = side ? { publish: () => {}, attach: (_input: unknown) => {}, detach: () => {} } : installProcessesStatusProtocol(pi, () => {
    if (!state.host || !state.context) return undefined;
    return {
      sessionScopeId: state.context.sessionManager.getSessionId(),
      host: state.host,
      managed: state.config.managed !== undefined,
      hasUI: state.context.hasUI && state.context.mode === "tui",
      open: (processId) => processUi.open(processId),
      report: (message) => state.context?.ui.notify(message, "warning"),
    };
  });
  const runtime = () => state.host ? {
    host: state.host,
    config: state.config,
    ...(state.degraded ? { configError: new Error(`[process/config-invalid] ${state.degraded}`) } : {}),
    cwd: state.context?.cwd ?? process.cwd(),
  } : undefined;

  const bindHost = async (host: ProcessHost, ctx: ExtensionContext): Promise<void> => {
    const sessionScopeId = ctx.sessionManager.getSessionId();
    state.host = host;
    refreshToolSchema();
    statusProtocol.attach({
      sessionScopeId,
      host,
      managed: state.config.managed !== undefined,
      hasUI: ctx.hasUI && ctx.mode === "tui",
      open: (processId) => processUi.open(processId),
      report: (message) => ctx.ui.notify(message, "warning"),
    });
    state.turnNotifications?.dispose();
    const turnCoordinator = new MainTurnNotificationCoordinatorV1({
      sessionScopeId,
      host,
      pi,
      mailbox,
      getContext: () => state.context,
      report: (message) => ctx.ui.notify(message, "warning"),
    });
    state.turnNotifications = turnCoordinator;
    turnCoordinator.activate(ctx);
    const binding = host.bind({
      deliver: async (event, delivery) => {
        if (event.type === "logCursorAdvanced" || event.type === "capacityChanged") return;
        const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
        if (!id) return;
        const process = host.summary(id);
        if (!process) return;
        const message = lifecycleMessage(event, process);
        if (!message) return;
        const attention = host.lifecycleAttention(event);
        if (!attention) return;
        if (ctx.signal?.aborted === true) host.setNotificationRunAbortFence();
        if (attention === "turn" && host.notificationRunAbortFence()) {
          try { host.demoteNotificationTurnToContext(id); }
          catch (error) { ctx.ui.notify(`Process notification abort handling failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
          return;
        }
        if (delivery?.modelLane === "context") return;
        if (delivery?.modelOwned === true && delivery.modelLane === "turn") return state.turnNotifications?.accept();
        // Notification Broker is the only model-delivery owner after cutover.
        // Shadow/projection failure remains TUI/diagnostic-only and fails closed;
        // it must never restore the legacy per-event process-event-v2 carrier.
        return;
      },
      appendNotificationEntry: (entry) => { appendNotificationEntryV1(pi, ctx, entry); },
      currentRunAborted: () => ctx.signal?.aborted === true,
      requestRender: () => {
        processUi.requestRender();
        statusProtocol.publish();
      },
      report: (message) => ctx.ui.notify(message, "warning"),
    });
    state.binding = binding;
    host.initializeStripPreference(state.config.presentation.stripInitiallyCollapsed);
    if (ctx.hasUI) processUi.mount({ host, context: ctx });
    await turnCoordinator.importLegacy(ctx, mailbox);
    await binding.markReady();
    statusProtocol.publish();
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
        processUi.unmount(ctx);
        const sessionScopeId = ctx.sessionManager.getSessionId();
        const replacement = createProcessHost(sessionScopeId, () => state.config, import.meta.dirname, createMainNotificationStrategyV1(sessionScopeId));
        if (replacement.disposed) throw replacement.cleanupError ?? new Error("[process/supervisor-unavailable] disposed host is still awaiting containment");
        await bindHost(replacement, ctx);
        state.turnNotifications?.activate(ctx);
        return replacement;
      })().finally(() => { state.recovery = undefined; });
    }
    await state.recovery;
    return runtime();
  };

  const refreshToolSchema = registerProcessTool(pi, runtime, recoverRuntime);

  const activateTurnNotifications = (ctx: ExtensionContext) => { state.turnNotifications?.activate(ctx); };
  const reinjectCompactState = createCompactReinjection(pi, ctx => state.context?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId() ? state.host : undefined);
  const drainAfterCompact = (ctx: ExtensionContext): void => {
    const owner = state.context, coordinator = state.turnNotifications;
    if (!owner || !coordinator || owner.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return;
    clearTimeout(state.compactDrain);
    const drain = (): void => {
      state.compactDrain = undefined;
      if (state.context !== owner || state.turnNotifications !== coordinator) return;
      if (ctx.isIdle()) { coordinator.activate(ctx); void coordinator.turnEnded(ctx).catch(error => ctx.ui.notify(String(error), "warning")); }
      else if (!state.runActive) state.compactDrain = setTimeout(drain, 10);
    };
    state.compactDrain = setTimeout(drain, 0);
  };
  pi.on("session_compact", (event, ctx) => { reinjectCompactState(event, ctx); drainAfterCompact(ctx); });
  pi.on("session_compact_failed", (_event, ctx) => { drainAfterCompact(ctx); });

  pi.on("input", (event, ctx) => {
    activateTurnNotifications(ctx);
    state.turnNotifications?.captureInput({
      source: event.source,
      ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
    });
  });
  pi.on("agent_start", (_event, ctx) => { state.runActive = true; activateTurnNotifications(ctx);  });
  pi.on("turn_start", (_event, ctx) => { activateTurnNotifications(ctx); });
  pi.on("context", (event) => ({ messages: (state.turnNotifications?.filterContext(event.messages) ?? event.messages) as typeof event.messages }));
  pi.on("turn_end", async (_event, ctx) => {
    activateTurnNotifications(ctx);
    await state.turnNotifications?.turnEnded(ctx);
  });
  // Tree navigation changes the active branch under the live runtime: pending
  // state is branch state, so rebuild it from the branch Pi just switched to.
  // Before leaving a branch, finish what it still owes (owed marker, unsettled wake) so no
  // authority dangles across the move and no sibling has to wait for it.
  pi.on("session_before_tree", (_event, ctx) => state.turnNotifications?.beforeTree(ctx, state.runActive === true));
  pi.on("session_tree", async (_event, ctx) => { state.turnNotifications?.rebranch(ctx.sessionManager.getBranch()); await state.turnNotifications?.importLegacy(ctx, mailbox); });

  pi.on("session_start", async (_event, ctx) => {
    if (side && ctx.sessionManager.getSessionId() !== side.sessionScopeId) throw new Error("[process/scope-mismatch] Side factory belongs to another session");
    childCapability?.bind(ctx);
    state.context = ctx;

    const loaded = await loadProcessesConfig({ agentDir: side?.agentDir ?? getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    if (loaded.ok) {
      state.config = loaded.config;
      state.degraded = undefined;
    } else {
      state.degraded = `${loaded.diagnostic.path}: ${loaded.diagnostic.message}`;
      ctx.ui.notify(`pi-processes config invalid; existing processes remain manageable. ${state.degraded}`, "warning");
    }
    const sessionScopeId = ctx.sessionManager.getSessionId();
    const host = createProcessHost(sessionScopeId, () => state.config, import.meta.dirname, createMainNotificationStrategyV1(sessionScopeId));
    try {
      await bindHost(host, ctx);
    } finally {
      // 有界、异步：一次启动只安排一次，回收 owner 已确认死亡的遗留 log root。
      if (!side) scheduleStaleRootCleanup();
    }
  });

  pi.on("session_shutdown", async (event,ctx) => {
    clearTimeout(state.compactDrain);
    state.compactDrain = undefined;
    state.runActive = false;
    childCapability?.release(ctx); childCapability?.dispose();
    const binding = state.binding;
    const turnCoordinator = state.turnNotifications;
    state.binding = undefined;
    state.recovery = undefined;
    state.turnNotifications = undefined;
    turnCoordinator?.dispose();
    if (event.reason === "reload" || event.reason === "quit") mailbox.close();
    processUi.unmount(state.context);
    try {
      if (!binding) return;
      if (side) await binding.retire("scope-ended");
      // Managed/isolated runs do not reclaim a Host across reload: consumers bind
      // a frozen execution authority and generation for the lifetime of the Run.
      else if (event.reason === "reload" && !state.config.managed && !state.config.execution.isolation) await binding.retire("reload");
      else await binding.retire(event.reason === "quit" ? "pi-exit" : "scope-ended");
    } finally {
      statusProtocol.detach();
      state.context = undefined;
    }
  });
  return {
    cancelPending: async (ctx = state.context): Promise<void> => {
      if (!ctx || !state.turnNotifications) return;
      await state.turnNotifications.cancelPending(ctx, mailbox);
    },
  };
}
