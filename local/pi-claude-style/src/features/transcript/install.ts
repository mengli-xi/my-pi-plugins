import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { installClaudeAssistantMessages } from "../../assistant-message.ts";
import { historyProjectionEntries, subscribeHistoryProjection } from "../../history-window.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  ActivityTimelineStore,
  rebuildActivityTimelineFromSession,
} from "../../activity-timeline.ts";
import { ActivityTracker } from "../../working-activity.ts";
import { captureResult } from "../../capture-result.ts";
import { installCustomEntryPresentationProviders } from "../../custom-entry-presentations.ts";
import { PROVIDER_ACTIVITY_CHANNEL } from "pi-runtime-contracts/provider-activity-v1";
import { ProviderStatusTracker } from "../../provider-status.ts";
import type { ConfigService } from "../../config/service.ts";
import type { LoadingConfig } from "../../config/defaults.ts";
import { DisposableStack, type FeatureHealth, type LifecycleManager } from "../../lifecycle.ts";
import { GoalStatusController } from "../../goal-status.ts";
import { registerCompactMessageRenderers } from "../../command-output.ts";
import { installSessionInfoPopup } from "../../session-info.ts";
import { installFoldedNativeOutput } from "../../native-output.ts";
import { installFinalNoticeAbsorption, RepeatedErrorCollapser } from "../../repeated-errors.ts";
import { assistantContentItems, assistantEndsGroup, assistantItemsShape } from "../../group-boundaries.ts";
import { GroupStore } from "../../grouping.ts";
import {
  rebuildGroupsFromSession,
  type SessionProjection,
} from "../../history.ts";
import { RunMetrics } from "../../metrics.ts";
import { RuntimeOverlayOpeners } from "../../openers.ts";
import { resolveToolPresentation } from "../../presentation-policy.ts";
import { installToolPresentationBoundary } from "../../presentation-boundary.ts";
import { createDefaultToolPresentationRegistry } from "../../presentation-adapters.ts";
import { classifyTool } from "../../semantics.ts";
import { finalRunStatus, latestAssistantMessage, type TranscriptRunRecording } from "../../run-recording.ts";
import { registerTranscriptSeparators, registerTranscriptSeparatorRenderers } from "../../separators.ts";
import type { RunStatus, TranscriptConfig } from "../../types.ts";
import { installCompactUserMessages } from "../../user-message.ts";
import { snapshotExtensionContext } from "../../extension-context.ts";
import type { CcStyleObservability } from "../../observability.ts";
import {
  loadRuntimeModuleOnFirstUse,
  type RuntimeScope,
} from "../../runtime-scope.ts";
import type { UiScheduler } from "../../ui-scheduler.ts";
import { TranscriptOverlayActions } from "./overlay-actions.ts";
import { registerTranscriptCommands } from "./commands.ts";
import {
  readTasksFromSession,
  readTodoSnapshotV1,
  renderTodoStatusLine,
  TodoWidget,
  seedIfEmpty,
  TodoSnapshot,
  toggleTodoView,
} from "../../todo-state.ts";
import {
  STATUS_LINE_ROW_CHANNEL,
  STATUS_LINE_TODO_SLOT_KEY,
  TODO_SNAPSHOT_CHANNEL,
  TODO_SNAPSHOT_REQUEST_CHANNEL,
} from "../../integration-contracts.ts";
import { installRetryRecording, type RetryRecording } from "../../compat/retry-session.ts";
import { installWorkingRetry } from "../../compat/working-retry.ts";
import { WorkingController } from "../../working.ts";

type TextPanelModule = typeof import("pi-li-uikit/text-panel");

/** Our own todo row, drawn between runs in the same style as the working one. */
const TODO_WIDGET_KEY = "pi-claude-transcript:todos";

function groupStatusForRun(
  status: Exclude<RunStatus, "running">,
): "completed" | "failed" | "cancelled" {
  return status === "done" ? "completed" : status;
}

function isPromptDecision(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const resolution = (raw as { resolution?: unknown }).resolution;
  return resolution === "user_approved" ||
    resolution === "user_approved_for_session" ||
    resolution === "user_denied";
}

export interface InstallTranscriptFeatureOptions {
  pi: ExtensionAPI;
  config: TranscriptConfig;
  configService?: ConfigService;
  observability: CcStyleObservability;
  lifecycle: LifecycleManager;
  runtime: RuntimeScope;
  scheduler: UiScheduler;
  loading: LoadingConfig;
  legacyConfigError?: string;
  registerCommands?: boolean;
  presentationOnly?: boolean;
  /** A managed child keeps recording while its view is detached. Main keeps its existing event order. */
  runRecording?: TranscriptRunRecording;
  retryRecording?: RetryRecording;
}

/** Own the complete transcript/runtime event surface for one factory invocation. */
export function installTranscriptFeature(options: InstallTranscriptFeatureOptions): void {
  const { pi, config, configService, observability, lifecycle, runtime, scheduler, loading, legacyConfigError } = options;
  const presentationOnly = options.presentationOnly === true;

  // Pi constructs historical tool components before session_start. Keep
  // invalidation dormant until that synchronous restore has finished, otherwise
  // every grouped historical call can request another full TUI render.
  const store = new GroupStore({
    maxGroups: config.maxGroups,
    maxCapturedBytes: config.maxCapturedBytes,
    batchInvalidations: true,
    invalidationsEnabled: false,
  });
  const openers = new RuntimeOverlayOpeners();
  const overlayActions = new TranscriptOverlayActions(runtime, observability);
  lifecycle.install({
    id: "custom-entry-presentations",
    install: () => installCustomEntryPresentationProviders(openers.openTextFor, pi),
    health: () => ({ status: "ok" as const }),
  }, undefined);
  let overlayPreloadTimer: ReturnType<typeof setTimeout> | undefined;
  let overlayPreloadStarted = false;
  const shouldPreloadOverlays = loading.mode === "eager" ||
    (loading.mode === "balanced" && loading.preloadOverlays);
  const scheduleOverlayPreload = (): void => {
    if (!shouldPreloadOverlays || overlayPreloadStarted || overlayPreloadTimer || runtime.isDisposed) return;
    overlayPreloadTimer = scheduler.setTimer(() => {
      overlayPreloadTimer = undefined;
      if (runtime.isDisposed) return;
      overlayPreloadStarted = true;
      void overlayActions.preload().catch(() => {
        // Failure is retained by RuntimeModule and reported through telemetry;
        // idle warm-up remains non-blocking.
      });
    }, loading.idleDelayMs);
  };
  const recordsRun = options.runRecording === undefined;
  const retryRecording = options.retryRecording ?? (config.working.enabled ? installRetryRecording(pi) : undefined);
  const metrics = options.runRecording?.metrics ?? new RunMetrics();
  const providerStatus = new ProviderStatusTracker();
  const todos = new TodoSnapshot();
  todos.setCollapsed(config.todoCollapsed);
  let todoOwnerSeen = false;
  let pendingTodoPayload: unknown;
  let activeTodoContext: ExtensionContext | undefined;
  let activeTheme: Theme | undefined;
  let cleanupContext: ExtensionContext | undefined;
  /** Same vocabulary the grouping uses, so a provider named `todowrite` counts. */
  const isTodoTool = (toolName: string): boolean =>
    classifyTool(toolName) === "todo";
  const activity = new ActivityTracker();
  const repeatedErrors = new RepeatedErrorCollapser(
    () => activeTheme,
    openers.openTextFor,
  );
  const presentationRegistry = createDefaultToolPresentationRegistry(
    (toolName, args) => resolveToolPresentation(toolName, args, config),
    observability,
  );
  const resolvePresentation = (toolName: string, args: unknown) =>
    presentationRegistry.resolve(toolName, args);
  const activityTimeline = new ActivityTimelineStore({
    clock: scheduler,
    isManagedTool: (toolName, args) =>
      resolvePresentation(toolName, args).kind !== "native",
    isTranscriptAnchor: (toolName, args) =>
      resolvePresentation(toolName, args).kind === "grouped",
    maxPhases: config.maxGroups,
    maxCapturedBytes: config.maxCapturedBytes,
  });
  const thinkingElapsedForToolCalls = (toolCallIds: readonly string[]) =>
    activityTimeline.thinkingElapsedForToolCalls(toolCallIds);
  const working = new WorkingController(
    metrics,
    config.working,
    providerStatus,
    (name, action) => observability.measure(name, action),
    Date.now,
    (toolActivity) => presentationRegistry.formatActivity(toolActivity),
    scheduler,
    openers.openTextFor,
  );
  // `??` guards a stored config snapshot from before this section existed.
  const stopProviderStatusListener = pi.events.on(
    PROVIDER_ACTIVITY_CHANNEL,
    (event) => providerStatus.handle(event),
  );
  const sessionIdOf = (ctx: ExtensionContext): string | undefined => {
    const manager = ctx.sessionManager as { getSessionId?: () => unknown };
    const value = manager.getSessionId?.();
    return typeof value === "string" && value ? value : undefined;
  };
  const acceptTodoOwnerPayload = (event: unknown): void => {
    pendingTodoPayload = event;
    const ctx = activeTodoContext;
    if (!ctx) return;
    observability.measure("cc-style.todo.snapshot.apply", () => {
      const tasks = readTodoSnapshotV1(event, sessionIdOf(ctx));
      if (!tasks) return;
      todoOwnerSeen = true;
      todos.replace(tasks);
      drawTodos(ctx);
    });
  };
  const requestTodoOwnerSnapshot = (ctx: ExtensionContext): void => {
    observability.measure("cc-style.todo.snapshot.request", () =>
      pi.events.emit(TODO_SNAPSHOT_REQUEST_CHANNEL, {
        sessionId: sessionIdOf(ctx),
        reply: acceptTodoOwnerPayload,
      }));
  };
  const stopTodoSnapshotListener = presentationOnly ? () => {} : pi.events.on(
    TODO_SNAPSHOT_CHANNEL,
    acceptTodoOwnerPayload,
  );
  /** Compatibility only for pi-todo versions predating semantic snapshots. */
  const stopTodoChangedListener = presentationOnly ? () => {} : pi.events.on("todo:changed", (event) => {
    if (todoOwnerSeen) return;
    observability.measure("cc-style.todo.legacy-update", () => {
      if (!todos.update(event)) return;
      if (cleanupContext) drawTodos(cleanupContext);
    });
  });
  const goalStatus = new GoalStatusController(
    config.goal,
    presentationOnly ? undefined : pi.events,
    (name, action) => observability.measure(name, action),
    scheduler,
  );
  const stopPermissionPromptListener = pi.events.on(
    "permissions:ui_prompt",
    () => working.pauseForModal(),
  );
  const stopPermissionDecisionListener = pi.events.on(
    "permissions:decision",
    (event) => {
      if (isPromptDecision(event)) working.resumeAfterModal();
    },
  );
  lifecycle.install({
    id: "working",
    install: () => {
      const resources = new DisposableStack();
      if (config.working.enabled) resources.defer(installWorkingRetry(pi,
        event => cleanupContext ? working.startRetry(cleanupContext, retryRecording?.snapshot() ?? event) : undefined,
        () => working.endRetry(),
        retryRecording?.available ? () => {
          const snapshot = retryRecording.snapshot();
          return snapshot && cleanupContext ? working.startRetry(cleanupContext, snapshot) : undefined;
        } : undefined));
      if (!options.retryRecording) resources.defer(() => retryRecording?.dispose());
      resources.defer(stopProviderStatusListener);
      resources.defer(stopTodoChangedListener);
      resources.defer(stopTodoSnapshotListener);
      resources.defer(stopPermissionDecisionListener);
      resources.defer(stopPermissionPromptListener);
      resources.defer(() => {
        let ui: ExtensionContext["ui"] | undefined;
        try {
          ui = cleanupContext?.hasUI ? cleanupContext.ui : undefined;
        } catch {
          ui = undefined;
        }
        working.clear(ui);
        goalStatus.dispose(ui);
        providerStatus.reset();
      });
      return resources;
    },
    health: () => ({
      status: config.working.enabled ? "ok" as const : "inactive" as const,
    }),
  }, undefined);
  if (options.runRecording) registerTranscriptSeparatorRenderers(pi, config.separators, config.working);
  const separators = options.runRecording?.separators ?? registerTranscriptSeparators(
    pi,
    config.separators,
    config.working,
  );
  const getExpandMode = () => config.expandMode;
  const restorePresentationBoundary = installToolPresentationBoundary(pi, {
    store,
    getExpandMode,
    resolvePresentation,
    maxResultChars: config.maxResultChars,
    presenter: presentationRegistry,
    thinkingElapsedForToolCalls,
    openGroup: openers.openGroupFor,
    openImages: openers.openImagesFor,
    diffColors: config.diff,
  });

  /**
   * The tasks stay in one component below the status row during and between
   * runs. `setWorkingMessage()` only accepts opaque text, so putting the list
   * there would discard its mouse target.
   *
   * Read the list back and draw it, however this instance came to be running.
   *
   * `/reload` rebuilds the extension but never replays `session_start`, so the
   * seed and the first draw have to hang off whatever event does arrive next —
   * the same reason the popup openers are re-armed from several of them. The
   * session is only re-read while the snapshot is empty, which is once per
   * instance rather than once per event.
   */
  const ensureTodos = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    if (presentationOnly) { working.mount(ctx); return; }
    if (!todoOwnerSeen) {
      observability.measure("cc-style.todo.legacy-seed", () =>
        seedIfEmpty(todos, () => ctx.sessionManager.buildContextEntries(), isTodoTool));
    }
    drawTodos(ctx);
  };

  const toggleTodos = (ctx: ExtensionContext): boolean =>
    !!snapshotExtensionContext(ctx) && toggleTodoView(todos, () => drawTodos(ctx));

  const drawTodos = (
    ctx: ExtensionContext,
    workingToolsMounted = working.mount(ctx),
  ): void => {
    if (!ctx.hasUI || presentationOnly) return;
    const visible = todos.visible();
    const statusLine = renderTodoStatusLine(visible);
    pi.events.emit(STATUS_LINE_ROW_CHANNEL, {
      key: STATUS_LINE_TODO_SLOT_KEY,
      placement: "slot",
      line: statusLine,
      ...(statusLine
        ? {
          onClick: () => toggleTodos(ctx),
        }
        : {}),
    });
    const wanted = visible.length > 0 && !todos.isStatuslineOnly();
    try {
      // A newly mounted tool component may have landed after a Todo retained
      // across reload/session replacement. Reinsert Todo once to restore the
      // stable spinner → tools → Todo order; ordinary redraws keep its instance.
      if (workingToolsMounted) ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
      ctx.ui.setWidget(
        TODO_WIDGET_KEY,
        // A factory, not a string array: the component is what a click on the
        // bottom bar can find, and it reads the snapshot on every frame so
        // shortcut-driven folding repaints without re-mounting.
        wanted
          ? (_tui) => new TodoWidget(
            todos,
            () => toggleTodos(ctx),
            () => working.isWorkingVisible(),
          )
          : undefined,
        { placement: "aboveEditor" },
      );
    } catch {
      // A row that will not mount is not worth failing a turn over.
    }
  };

  const restoreUserMessages = installCompactUserMessages(
    pi,
    config.userMessages,
    openers.openTextFor,
  );
  const restoreCommandOutput = registerCompactMessageRenderers(
    pi,
    config.customMessages,
    openers.openTextFor,
  );
  const restoreSessionInfo = installSessionInfoPopup((report) => {
    const ctx = cleanupContext;
    const snapshot = ctx ? snapshotExtensionContext(ctx) : undefined;
    if (!ctx || snapshot?.mode !== "tui" || !snapshot.hasUI) return false;
    const generation = runtime.generation;
    return loadRuntimeModuleOnFirstUse<TextPanelModule>(
		runtime,
		"shared-text-panel-ui",
		() => import("pi-li-uikit/text-panel"),
      observability,
    ).then((ui) => {
      const current = runtime.accepts(generation) && cleanupContext === ctx;
      if (!ui) return !current;
      if (!current) return true;
		void ui.showTextPanel(ctx, {
			title: report.title,
			body: report.body,
			renderBody: (width) => report.renderBody(width),
			format: "plain",
			glyph: "",
			maxVisible: 12,
		}).catch(() => {
        // The context retired after the generation check. There is no longer a
        // live TUI on which to show the captured report.
      });
      return true;
    });
  }, pi);
  /**
   * The theme the rows built outside an event handler paint with. Pi hands one
   * to every renderer it calls, but a row that draws its own chrome — the fold
   * hint — is built before that call and needs the live theme at render time.
   */
  const restoreNativeOutput = installFoldedNativeOutput(
    pi,
    config.nativeToolOutput,
    () => activeTheme,
    openers.openTextFor,
  );
  const restoreNotifications = installFinalNoticeAbsorption(pi, repeatedErrors);
  const restoreAssistantMessages = installClaudeAssistantMessages(
    pi,
    config.assistantMessages,
    observability,
    openers.openTextFor,
    scheduler,
    activityTimeline,
    repeatedErrors,
  );

  /**
   * Clicking a row opens its popup. The rows are built several factory layers
   * down from here, so they reach the session through these openers rather
   * than by having a context threaded into them.
   *
   * Re-armed from every event that carries a context, not just once at
   * session start: `/reload` builds a fresh module instance but never replays
   * `session_start`, so registering only there leaves every row inert for the
   * rest of the session. Re-arming also keeps the captured context current.
   */
  const armOpeners = (ctx: ExtensionContext): boolean => {
    const snapshot = snapshotExtensionContext(ctx);
    if (!snapshot) return false;
    cleanupContext = ctx;
    activeTheme = snapshot.ui?.theme;
    openers.set({
      group: (toolCallId) => {
        const group = store.getByToolCallId(toolCallId);
        if (!group) return false;
        const activitySource = group.presentation === "grouped"
          ? (() => {
            const phase = activityTimeline.phaseForToolCall(toolCallId);
            return phase
              ? {
                phase,
                resolveActivity: (id: string) => store.getActivity(id),
                resolveNestedActivities: (id: string) => store.getByToolCallId(id)?.activities.filter((child) => child.parentToolCallId === id) ?? [],
                subscribe: (listener: Parameters<typeof activityTimeline.subscribe>[1]) =>
                  activityTimeline.subscribe(phase.id, listener),
                hideCodeFenceMarkers: config.assistantMessages.hideCodeFenceMarkers,
              }
              : undefined;
          })()
          : undefined;
        // Pruning drops full tool payloads, but a grouped row can still open
        // its Activity phase so archived Thinking remains reachable. A
        // standalone pruned row has no alternate content and stays inert.
        if (group.pruned && !activitySource) return false;
        void overlayActions.openGroup(
          ctx,
          group,
          config.maxResultChars,
          config.overlay,
          config.diff,
          (activity) => presentationRegistry.formatActivity(activity),
          (listener) => store.subscribe(group.id, listener),
          activitySource,
        );
        return true;
      },
      text: (heading, body, options) => {
        void overlayActions.openText(ctx, heading, body, config.overlay, options);
        return true;
      },
      images: (images) => {
        void overlayActions.openImages(ctx, images);
        return true;
      },
    });
    scheduleOverlayPreload();
    return true;
  };

  pi.on("resources_discover", (_event, ctx) => {
    if (runtime.observeContext(ctx) && armOpeners(ctx)) {
      activeTodoContext = ctx;
      if (pendingTodoPayload !== undefined) acceptTodoOwnerPayload(pendingTodoPayload);
      if (!presentationOnly && !todoOwnerSeen) requestTodoOwnerSnapshot(ctx);
      ensureTodos(ctx);
    }
    return {};
  });
  pi.on("session_info_changed", (_event, ctx) => {
    if (runtime.observeContext(ctx) && armOpeners(ctx)) {
      activeTodoContext = ctx;
      if (pendingTodoPayload !== undefined) acceptTodoOwnerPayload(pendingTodoPayload);
      if (!presentationOnly && !todoOwnerSeen) requestTodoOwnerSnapshot(ctx);
      ensureTodos(ctx);
    }
  });

  const projectEntries = (entries: readonly SessionEntry[]): SessionProjection => {
    const projection = observability.measure(
      "cc-style.session.project",
      () => {
        const result = rebuildGroupsFromSession(entries, store, {
          maxResultChars: config.maxResultChars,
          resolvePresentation,
          isTodoTool,
        });
        rebuildActivityTimelineFromSession(entries, activityTimeline);
        const calls = new Set<string>();
        const assistants = [];
        for (const entry of entries) if (entry.type === "message") {
          if (entry.message.role === "assistant") {
            assistants.push(entry.message);
            for (const block of entry.message.content) if (block.type === "toolCall") calls.add(block.id);
          }
          if (entry.message.role === "toolResult") for (const call of entry.message.nestedCalls?.calls ?? []) calls.add(call.id);
        }
        store.retainRenderers(calls);
        activityTimeline.retainMessages(assistants);
        return result;
      },
    );
    observability.observe("cc-style.session.entries", entries.length, "entries");
    observability.observe("cc-style.session.groups", store.groupCount(), "groups");
    observability.gauge(
      "cc-style.session.captured-payload",
      store.capturedPayloadBytes(),
      "bytes",
    );
    store.setInvalidationsEnabled(true);
    return projection;
  };
  const stopHistoryProjection = subscribeHistoryProjection(pi, projectEntries);
  const projectSession = (ctx: ExtensionContext): SessionProjection => projectEntries(
    historyProjectionEntries(pi, ctx.sessionManager.getBranch(), () => ctx.sessionManager.buildContextEntries()),
  );

  pi.on("session_start", (_event, ctx) => {
    runtime.bindSession(ctx);
    for (const id of partialTimers.keys()) cancelPartial(id);
    lastPartialCapture.clear();
    repeatedErrors.reset();
    todoOwnerSeen = false;
    activeTodoContext = ctx;
    if (pendingTodoPayload !== undefined) acceptTodoOwnerPayload(pendingTodoPayload);
    if (!presentationOnly && !todoOwnerSeen) requestTodoOwnerSnapshot(ctx);
    if (recordsRun) separators.reset();
    if (!presentationOnly) goalStatus.start(ctx);
    armOpeners(ctx);
    if (!recordsRun && metrics.snapshot().status === "running") working.start(ctx);
    const projection = projectSession(ctx);
    // Compatibility fallback for todo providers that do not own the semantic
    // snapshot protocol. The owner path avoids parsing transcript internals.
    if (!presentationOnly && !todoOwnerSeen) todos.seed(projection.latestTasks);
    drawTodos(ctx);
    if (legacyConfigError && ctx.hasUI) ctx.ui.notify(legacyConfigError, "warning");
  });

  pi.on("session_tree", (_event, ctx) => {
    const projection = projectSession(ctx);
    if (!presentationOnly && !todoOwnerSeen) todos.seed(projection.latestTasks);
    drawTodos(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    runtime.markActive(ctx);
    repeatedErrors.startRun();
    armOpeners(ctx);
    if (recordsRun) separators.startRun();
    activity.reset();
    if (recordsRun) metrics.start();
    providerStatus.start(ctx.model?.provider, ctx.sessionManager.getSessionId());
    const workingToolsMounted = working.start(ctx);
    // Re-mount after the status row appears so the bar geometry and click
    // routing are current in the same frame.
    drawTodos(ctx, workingToolsMounted);
  });

  pi.on("turn_start", (event, ctx) => {
    if (recordsRun) separators.startTurn(event.turnIndex);
    if (recordsRun) metrics.startTurn(event.timestamp);
  });

  pi.on("turn_end", (event) => {
    if (event.message.role === "assistant") {
      if (recordsRun) metrics.reconcileTurnUsage(event.message.usage);
      activityTimeline.observeAssistant(event.message, false, scheduler.now());
    }
    if (recordsRun) separators.finishTurn();
  });

  // Live groups follow the same content-order rule as history replay; see
  // group-boundaries.ts. Run lifecycle and tool execution time are not
  // boundaries. Alignment reruns only when the message's shape changes.
  let liveContent: readonly unknown[] | undefined;
  let liveShape = "";
  const alignLive = (content: readonly unknown[] | undefined, force = false): void => {
    if (!content) return;
    const items = assistantContentItems(content, resolvePresentation);
    const shape = assistantItemsShape(items, (id) => store.has(id));
    if (!force && shape === liveShape) return;
    liveShape = shape;
    store.alignAssistantMessage(items);
  };

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      liveContent = event.message.content;
      liveShape = "";
      store.beginAssistantMessage();
      activityTimeline.observeAssistant(event.message, true, scheduler.now());
    } else {
      if (event.message.role === "user") store.closeBoundary();
      repeatedErrors.breakSequence();
    }
  });

  pi.on("message_update", (event) => {
    if (recordsRun) metrics.handleAssistantEvent(event.assistantMessageEvent);
    // Reasoning-summary headlines become the working row's label; the ~120ms
    // working tick paints the change, so no render is requested here.
    if (activity.handle(event.assistantMessageEvent)) {
      working.setActivity(activity.current());
    }
    if (event.message.role === "assistant") {
      activityTimeline.observeAssistant(event.message, true, scheduler.now());
      liveContent = event.message.content;
      alignLive(liveContent);
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      activityTimeline.observeAssistant(event.message, false, scheduler.now());
      liveContent = event.message.content;
      alignLive(liveContent, true);
      if (assistantEndsGroup(event.message)) store.closeBoundary();
    }
  });

  pi.on("session_compact", () => {
    store.closeBoundary();
  });

  pi.on("tool_execution_start", (event) => {
    repeatedErrors.breakSequence();
    if (recordsRun && !event.parentToolCallId) metrics.pauseForTool();
    if (!event.parentToolCallId) working.startTool(event.toolCallId, event.toolName, event.args);
    const presentation = resolvePresentation(event.toolName, event.args);
    if (event.parentToolCallId && !store.getByToolCallId(event.parentToolCallId)) return;
    if (!event.parentToolCallId && presentation.kind === "native") return;
    const presentationKind = presentation.kind === "native" ? "grouped" : presentation.kind;
    observability.measure("cc-style.transcript.index-update", () =>
      store.start(
        event.toolCallId,
        event.toolName,
        event.args,
        Date.now(),
        presentationKind,
        event.parentToolCallId,
      ));
    if (!event.parentToolCallId) alignLive(liveContent);
    activityTimeline.touchTool(store.getActivity(event.toolCallId)?.parentToolCallId ?? event.toolCallId, scheduler.now());
  });

  // A streaming tool can emit updates many times a second, and each capture
  // re-serialises everything produced so far. Only the final result has to be
  // complete, so partial captures are rate-limited per tool call.
  const PARTIAL_CAPTURE_INTERVAL_MS = 250;
  const lastPartialCapture = new Map<string, number>();
  const pendingPartials = new Map<string, () => void>();
  const partialTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelPartial = (id: string): void => {
    const timer = partialTimers.get(id);
    if (timer !== undefined) scheduler.clearTimer(timer);
    partialTimers.delete(id);
    pendingPartials.delete(id);
  };

  pi.on("tool_execution_update", (event) => {
    if (event.parentToolCallId && !store.getByToolCallId(event.toolCallId)) return;
    const native = !event.parentToolCallId && resolvePresentation(event.toolName, event.args).kind === "native";
    const now = scheduler.now();
    const previous = lastPartialCapture.get(event.toolCallId) ?? 0;
    const capture = (): void => {
      lastPartialCapture.set(event.toolCallId, scheduler.now());
      const captured = captureResult(event.partialResult, false, config.maxResultChars);
      if (!event.parentToolCallId) working.updateTool(event.toolCallId, event.args, captured);
      if (native) return;
      store.update(event.toolCallId, event.args, captured);
      activityTimeline.touchTool(store.getActivity(event.toolCallId)?.parentToolCallId ?? event.toolCallId, scheduler.now());
    };
    if (now - previous < PARTIAL_CAPTURE_INTERVAL_MS) {
      pendingPartials.set(event.toolCallId, capture);
      if (!partialTimers.has(event.toolCallId)) {
        partialTimers.set(event.toolCallId, scheduler.setTimer(() => {
          partialTimers.delete(event.toolCallId);
          const latest = pendingPartials.get(event.toolCallId);
          pendingPartials.delete(event.toolCallId);
          latest?.();
        }, PARTIAL_CAPTURE_INTERVAL_MS - (now - previous)));
      }
      if (!event.parentToolCallId) working.updateTool(event.toolCallId, event.args);
      if (native) return;
      store.update(event.toolCallId, event.args);
      activityTimeline.touchTool(store.getActivity(event.toolCallId)?.parentToolCallId ?? event.toolCallId, scheduler.now());
      return;
    }
    cancelPartial(event.toolCallId);
    capture();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (recordsRun && !event.parentToolCallId) metrics.resumeAfterTool();
    cancelPartial(event.toolCallId);
    const captured = captureResult(event.result, event.isError, config.maxResultChars);
    if (!event.parentToolCallId) working.finishTool(event.toolCallId, captured);
    // Every todo action echoes the whole list back, so the newest result is a
    // complete snapshot for the component below the spinner.
    if (!presentationOnly && !todoOwnerSeen && isTodoTool(event.toolName) && !event.isError) {
      observability.measure("cc-style.todo.legacy-update", () => {
        todos.update((event.result as { details?: unknown } | undefined)?.details);
        drawTodos(ctx);
      });
    }
    lastPartialCapture.delete(event.toolCallId);
    const storedArgs = store
      .getByToolCallId(event.toolCallId)
      ?.activities.find((activity) => activity.id === event.toolCallId)
      ?.args;
    if (event.parentToolCallId && !store.getByToolCallId(event.toolCallId)) return;
    if (!event.parentToolCallId && resolvePresentation(event.toolName, storedArgs ?? {}).kind === "native") {
      return;
    }
    observability.measure("cc-style.transcript.index-update", () =>
      store.end(
        event.toolCallId,
        captured,
        event.isError ? "failed" : "completed",
        Date.now(),
        event.durationMs,
      ));
    activityTimeline.touchTool(store.getActivity(event.toolCallId)?.parentToolCallId ?? event.toolCallId, scheduler.now());
  });

  pi.on("agent_end", (event, ctx) => {
    for (const id of partialTimers.keys()) cancelPartial(id);
    const assistant = latestAssistantMessage(event.messages);
    if (recordsRun && assistant) metrics.reconcileFinalUsage(assistant.usage);
    const status = finalRunStatus(event.messages);
    store.finish(groupStatusForRun(status));
    activityTimeline.finishActiveThinking(scheduler.now());
    const snapshot = recordsRun ? metrics.finish(status) : metrics.snapshot();
    if (recordsRun) separators.finishRun(snapshot);
    // Clearing the working row here and appending the run divider later would
    // shrink the transcript for one frame, and pi answers a shrink above the
    // fold with a full-screen redraw of the whole scrollback — the stall you
    // see when a run is interrupted. The row is held until the divider that
    // replaces it is appended in the same tick.
    working.finish(ctx, snapshot, !separators.replacesDoneWidget(), {
      hold: separators.replacesDoneWidget(),
      release: () => settle(ctx),
    });
    providerStatus.reset();
  });

  const settle = (ctx: ExtensionContext) => {
    separators.settleRun();
    working.releaseHeld(ctx.hasUI ? ctx.ui : undefined);
    drawTodos(ctx);
  };

  pi.on("agent_settled", (_event, ctx) => {
    repeatedErrors.settleRun();
    drawTodos(ctx);
    settle(ctx);
  });

  lifecycle.install({
    id: "transcript",
    install: () => {
      const resources = new DisposableStack();
      resources.defer(stopHistoryProjection);
      // Registered in installation order; disposal intentionally runs in the
      // reverse order so UI state is cleared before prototype patches vanish.
      resources.defer(restoreUserMessages);
      resources.defer(restorePresentationBoundary);
      resources.defer(restoreNativeOutput);
      resources.defer(restoreSessionInfo);
      resources.defer(restoreCommandOutput);
      resources.defer(restoreNotifications);
      resources.defer(restoreAssistantMessages);
      resources.defer(() => {
        openers.clear();
        overlayActions.dispose();
        if (overlayPreloadTimer) scheduler.clearTimer(overlayPreloadTimer);
        overlayPreloadTimer = undefined;
        if (recordsRun) separators.reset();
        store.clear();
        activityTimeline.clear();
        for (const id of partialTimers.keys()) cancelPartial(id);
        lastPartialCapture.clear();
        activeTodoContext = undefined;
        pendingTodoPayload = undefined;
        todoOwnerSeen = false;
        cleanupContext = undefined;
        repeatedErrors.reset();
      });
      return resources;
    },
    health: () => imageSettingHealth(pi),
  }, undefined);

  if(options.registerCommands!==false)registerTranscriptCommands({
    pi,
    config,
    configService,
    observability,
    lifecycle,
    store,
    activityTimeline,
    todos,
    drawTodos,
    overlayActions,
    formatActivity: (activity) => presentationRegistry.formatActivity(activity),
  });
}

/**
 * The one-line `View Image` row stands in for the images Pi leaves out while
 * `terminal.showImages` is off. With it on, Pi draws them inline as usual and
 * the row stays away, which doctor reports so the setting is easy to find.
 */
function imageSettingHealth(pi: ExtensionAPI): FeatureHealth {
  let showImages: boolean | undefined;
  try {
    showImages = pi.getSettings().terminal?.showImages;
  } catch {
    return { status: "ok" };
  }
  return showImages === false
    ? { status: "ok" }
    : {
      status: "degraded",
      detail: "terminal.showImages is on, so Pi draws tool images inline instead of one View Image row; turn off \"Show images\" in /settings",
    };
}
