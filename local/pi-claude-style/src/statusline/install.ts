import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename } from "node:path";
import { runStatusLineCommand } from "./command.ts";
import { readStatusLineConfig, clearConfigCache } from "./config.ts";
import {
  ContributedRows,
  INLINE_SEPARATOR,
  type InlineSpan,
  STATUS_LINE_ROW_CHANNEL,
} from "./extra-lines.ts";
import { STATUS_LINE_REFRESH_CHANNEL } from "../integration-contracts.ts";
import {
  cacheHistoryPanelContent,
  formatCacheQualitySegment,
} from "./cache-panel.ts";
import { buildStatusLinePayload } from "./payload.ts";
import { StatuslineTranscriptCache } from "./transcript.ts";
import { applyStatusLineUi, clearStatusLineUi } from "./ui.ts";
import type { Disposable } from "../lifecycle.ts";

interface RenderState {
  command: string;
  placement: "footer" | "widget";
  padding: number;
  widgetPlacement: "aboveEditor" | "belowEditor";
  lines: string[];
}

const FRAME_HANDOFF_KEY = Symbol.for("pi-claude-style.statusline-frames.v2");

interface StatuslineFrameHandoff {
  version: 1;
  last: RenderState | null;
}

export function compactHome(cwd: string, home = homedir()): string {
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Explicit, versioned ownership handoff used only across `/reload`. */
function frameHandoff(sessionId: string): StatuslineFrameHandoff {
  const root = globalThis as typeof globalThis & {
    [FRAME_HANDOFF_KEY]?: Map<string, StatuslineFrameHandoff>;
  };
  const sessions = root[FRAME_HANDOFF_KEY] instanceof Map ? root[FRAME_HANDOFF_KEY]! : (root[FRAME_HANDOFF_KEY] = new Map());
  let frame = sessions.get(sessionId);
  if (!frame) sessions.set(sessionId, frame = { version: 1, last: null });
  return frame;
}

/**
 * Bounded retries after an empty/failed command. Main/Subagent keep their CC
 * fallback (or last successful output) while these attempts run; generic
 * consumers without an initial template can still recover their first frame.
 */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
/** Session age is minute-grained; refresh without turning the shell into a ticker. */
const SESSION_CLOCK_REFRESH_MS = 60_000;
const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD_MAGENTA = "\x1b[1m\x1b[35m";
const ANSI_BLUE = "\x1b[34m";

/**
 * Whether a context can still be touched.
 *
 * Reading any property off a context whose session has been replaced throws —
 * pi invalidates the runtime and `hasUI` is a getter over that check. This
 * extension holds contexts across timers and an event-bus listener, none of
 * which can know the session went away, so every use goes through here.
 */
function isUsable(ctx: any): boolean {
  try {
    return Boolean(ctx?.hasUI);
  } catch {
    return false;
  }
}

export interface StatusLineInstallOptions {
  readonly interactiveSlots?: boolean;
  /** Child views never adopt the Main reload frame. */
  readonly isolatedFrame?: boolean;
  /** View-local CC rows to mount before the first asynchronous command completes. */
  readonly initialLines?: readonly string[];
  readonly acceptContributions?: boolean;
  readonly acceptedContributionKeys?: readonly string[];
}

export default function (
  pi: ExtensionAPI,
  measure: <T>(name: string, action: () => T) => T = (_name, action) => action(),
  options: StatusLineInstallOptions = {},
  transcriptCache: StatuslineTranscriptCache = new StatuslineTranscriptCache(),
): Disposable {
  const interactiveSlots = options.interactiveSlots !== false;
  const acceptContributions = options.acceptContributions !== false;
  const acceptedContributionKeys = options.acceptedContributionKeys
    ? new Set(options.acceptedContributionKeys)
    : undefined;
  let frames: StatuslineFrameHandoff = { version: 1, last: null };
  let frameSessionId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  const commands = new Set<Promise<string[]>>();
  let refreshToken = 0;
  let activeCtx: any = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionClockTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  let pathOverlayOpen = false;
  let cachePanelOpen = false;
  let statuslineTui: TUI | undefined;
  const contributed = new ContributedRows();

  function directoryName(cwd: string): string {
    const leaf = basename(cwd);
    return leaf || cwd;
  }

  function paintPath(ctx: any, value: string): string {
    try {
      return ctx.ui.theme.fg("accent", value);
    } catch {
      return value;
    }
  }

  function openPathOverlay(ctx: any, cwd: string): void {
    if (pathOverlayOpen || !isUsable(ctx)) return;
    pathOverlayOpen = true;
    void import("pi-li-uikit/text-panel")
      .then(({ showTextPanel }) =>
        showTextPanel(ctx, { title: "Working directory", body: cwd, format: "plain" }))
      .catch((error: unknown) => {
        try {
          ctx.ui.notify(
            `Unable to show working directory: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        } catch {
          // The session may have been replaced while the lazy UI loaded.
        }
      })
      .finally(() => {
        pathOverlayOpen = false;
      });
  }

  function openCachePanel(ctx: any): boolean {
    if (cachePanelOpen || !isUsable(ctx)) return false;
    const snapshot = transcriptCache.cacheHistory(ctx);
    if (!snapshot) return false;
    cachePanelOpen = true;
    void import("pi-li-uikit/text-panel")
      .then(({ showTextPanel }) => showTextPanel(ctx, cacheHistoryPanelContent(snapshot)))
      .catch((error: unknown) => {
        try {
          ctx.ui.notify(
            `Unable to show prompt cache: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        } catch {
          // The session may have been replaced while the lazy UI loaded.
        }
      })
      .finally(() => {
        cachePanelOpen = false;
      });
    return true;
  }

  function installCacheQualitySlot(ctx: any, payload: Awaited<ReturnType<typeof buildStatusLinePayload>>): void {
    const line = formatCacheQualitySegment(payload.context_window.cache);
    contributed.handle({
      key: "cache-quality",
      placement: "slot",
      ...(line ? {
        line,
        ...(interactiveSlots ? { onClick: () => openCachePanel(ctx) } : {}),
      } : {}),
    });
  }

  function openModelSelector(): boolean {
    const tui = statuslineTui;
    if (!(tui instanceof TuiMainScreen || tui instanceof TuiAltScreen)) return false;
    const editor = tui.getFocusedComponent();
    if (!(editor instanceof CustomEditor)) return false;
    const open = editor.actionHandlers.get("app.model.select");
    if (!open) return false;
    open();
    return true;
  }

  function installEffortSlot(ctx: any): void {
    const effort = typeof ctx?.thinkingLevel === "string" && ctx.thinkingLevel
      ? ctx.thinkingLevel
      : undefined;
    contributed.handle({
      key: "effort",
      placement: "slot",
      ...(effort ? { line: `${ANSI_BLUE}${effort}${ANSI_RESET}` } : {}),
    });
  }

  function installModelSlot(ctx: any): void {
    const model = ctx?.model;
    const id = typeof model?.id === "string" && model.id
      ? model.id.replace(/^gpt-/, "")
      : typeof model?.displayName === "string" && model.displayName
        ? model.displayName
        : "no-model";
    const provider = typeof model?.provider === "string" && model.provider
      ? model.provider
        .replace(/^openai-codex$/, "codex")
        .replace(/-gateway$/, "")
      : "";
    const label = provider ? `${id}(${provider})` : id;
    contributed.handle({
      key: "model",
      placement: "slot",
      // Keep the shell statusline's established bold-magenta presentation.
      line: `${ANSI_BOLD_MAGENTA}${label}${ANSI_RESET}`,
      ...(interactiveSlots ? { onClick: openModelSelector } : {}),
    });
  }

  /**
   * The shell command knows the exact row budget, while this host owns click
   * routing. It therefore prints either slot marker; both carry the same
   * action and differ only in their width-aware label.
   */
  function installPathSlots(ctx: any): void {
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : "/";
    const onClick = () => {
      openPathOverlay(ctx, cwd);
      return true;
    };
    contributed.handle({
      key: "path-full",
      placement: "slot",
      line: paintPath(ctx, compactHome(cwd)),
      ...(interactiveSlots ? { onClick } : {}),
    });
    contributed.handle({
      key: "path-short",
      placement: "slot",
      line: paintPath(ctx, directoryName(cwd)),
      ...(interactiveSlots ? { onClick } : {}),
    });
  }

  /**
   * Every timer this extension arms, so shutdown can cancel all of them.
   *
   * The debounce used to be tracked on its own while the zero-delay reclaim was
   * not, so a reclaim armed by `agent_end` fired after the session had gone and
   * threw on a dead context — which is why every `pi -p` run exited 1.
   */
  const subscriptions: Array<() => void> = [];
  const pending = new Set<ReturnType<typeof setTimeout>>();

  function later(run: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      pending.delete(handle);
      run();
    }, delayMs);
    pending.add(handle);
    return handle;
  }

  function cancelPending(): void {
    for (const handle of pending) clearTimeout(handle);
    pending.clear();
  }

  function cancelRetry(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    pending.delete(retryTimer);
    retryTimer = null;
  }

  function armSessionClock(ctx: any): void {
    if (sessionClockTimer) {
      clearTimeout(sessionClockTimer);
      pending.delete(sessionClockTimer);
    }
    sessionClockTimer = later(() => {
      sessionClockTimer = null;
      if (isUsable(ctx)) scheduleRefresh(ctx);
      if (isUsable(ctx)) armSessionClock(ctx);
    }, SESSION_CLOCK_REFRESH_MS);
  }

  /** Re-run a refresh that produced nothing, a few times, then let it go. */
  function armRetry(ctx: any): void {
    if (!isUsable(ctx)) return;
    const delay = RETRY_DELAYS_MS[retryIndex];
    if (delay === undefined) return;
    retryIndex++;
    cancelRetry();
    retryTimer = later(() => {
      retryTimer = null;
      void refresh(ctx);
    }, delay);
  }

  /**
   * The command's rows with inline contributions spliced into the first, then
   * whole rows other extensions handed over appended under them.
   *
   * Interactive slot/inline spans come back out because a click on a command
   * row has to be matched by column, not just by row.
   */
  let interactionSpans: InlineSpan[][] = [];
  function compose(lines: string[], ctx: any): string[] {
    // Slots first: markers change column widths, and interaction spans must be
    // measured against what actually reaches the screen. The host owns the
    // separator, including its neutral tone; contributors own their content.
    const slotted = contributed.composeSlots(lines);
    const separator = ctx.ui?.theme?.fg
      ? ctx.ui.theme.fg("dim", INLINE_SEPARATOR)
      : INLINE_SEPARATOR;
    const spliced = contributed.spliceInline(slotted.lines, separator);
    interactionSpans = spliced.spans.map((spans, index) => [
      ...(slotted.spans[index] ?? []),
      ...spans,
    ]);
    return [...spliced.lines, ...contributed.lines()];
  }

  /**
   * How a click lands on a contributed row. The command's own rows come first
   * and answer to nobody, so the count of them is the offset a click index is
   * measured from.
   */
  function clickOptions(commandRowCount: number) {
    return {
      commandRowCount,
      onMount: (tui: TUI) => {
        statuslineTui = tui;
      },
      onClickRow: (index: number) => interactiveSlots && contributed.clickHandlerAt(index)?.() === true,
      // Command rows carry slot/inline segments, matched by row and column.
      onClickInline: (
        row: number,
        column: number,
        layout?: { rightStart?: number },
      ) => interactiveSlots && (interactionSpans[row] ?? []).some((span) => {
        const offset = span.align === "right" ? layout?.rightStart : 0;
        if (offset === undefined) return false;
        return column >= offset + span.from
          && column < offset + span.to
          && span.onClick?.() === true;
      }),
    };
  }

  /** Re-mount last good output immediately without rerunning the command. */
  function reclaimLastGood(ctx: any): void {
    const frame = frames.last;
    if (!isUsable(ctx) || !frame) return;
    const config = readStatusLineConfig(ctx.cwd);
    if (!config) return;
    if (
      config.command !== frame.command ||
      (config.placement ?? "footer") !== frame.placement
    ) {
      return;
    }
    measure("cc-style.statusline.render", () => applyStatusLineUi(
      ctx,
      config,
      compose(frame.lines, ctx),
      clickOptions(frame.lines.length),
    ));
  }

  async function refresh(ctx: any): Promise<void> {
    if (!isUsable(ctx)) return;

    const refreshId = ++refreshToken;

    try {
      const config = readStatusLineConfig(ctx.cwd);

      if (!config) {
        controller?.abort();
        controller = null;
        if (frames.last !== null) {
          clearStatusLineUi(ctx, frames.last.placement);
          frames.last = null;
        }
        return;
      }

      const payload = await buildStatusLinePayload(ctx, transcriptCache);
      if (refreshId !== refreshToken) return;
      installCacheQualitySlot(ctx, payload);
      // Host-owned slots must update even when the command never succeeds.
      reclaimLastGood(ctx);

      controller?.abort();
      const currentController = new AbortController();
      controller = currentController;

      const command = runStatusLineCommand(
        config.command,
        payload,
        ctx.cwd,
        currentController.signal,
        config.timeoutMs,
      );
      commands.add(command);
      const lines = await command.finally(() => commands.delete(command));

      if (
        refreshId !== refreshToken ||
        controller !== currentController ||
        currentController.signal.aborted
      ) {
        return;
      }

      // Command timeout / non-zero exit / spawn error all resolve to [].
      // Do not wipe a previously good statusline just because one refresh failed.
      if (lines.length === 0 || lines.every((line) => line.trim().length === 0)) {
        // Still try to reclaim ownership if we had a good frame.
        reclaimLastGood(ctx);
        armRetry(ctx);
        return;
      }

      // The session can be replaced across the two awaits above, and every read
      // off a replaced ctx throws. Checking only on the way in would turn that
      // into an unhandled rejection instead of one skipped frame.
      if (!isUsable(ctx)) return;

      const nextRenderState: RenderState = {
        command: config.command,
        placement: config.placement ?? "footer",
        padding: config.padding ?? 0,
        widgetPlacement: config.widgetPlacement ?? "belowEditor",
        lines,
      };

      if (frames.last && frames.last.placement !== nextRenderState.placement) {
        clearStatusLineUi(ctx, frames.last.placement);
      }
      frames.last = nextRenderState;
      // Always re-apply even if the text is unchanged.
      measure("cc-style.statusline.render", () =>
        applyStatusLineUi(ctx, config, compose(lines, ctx), clickOptions(lines.length)));
      retryIndex = 0;
    } catch {
      // Called from a timer, so a throw here is an unhandled rejection and a
      // lost frame that nothing else re-arms. A refresh that has already been
      // superseded is not this one's to retry.
      if (refreshId === refreshToken) armRetry(ctx);
    }
  }

  function scheduleRefresh(ctx: any): void {
    if (timer) {
      clearTimeout(timer);
      pending.delete(timer);
    }
    // An event-driven refresh is a new attempt, so it starts the backoff over
    // rather than inheriting an exhausted one from the frame before it.
    cancelRetry();
    retryIndex = 0;
    const debounceMs = readStatusLineConfig(ctx.cwd)?.debounceMs ?? 300;
    timer = later(() => {
      timer = null;
      void refresh(ctx);
    }, debounceMs);
  }

  function invalidateBranchCaches(): void {
    transcriptCache.clear();
  }

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!options.isolatedFrame && sessionId) {
      frameSessionId = sessionId;
      frames = frameHandoff(sessionId);
    }
    activeCtx = ctx;
    installPathSlots(ctx);
    installModelSlot(ctx);
    installEffortSlot(ctx);
    // Main and disposable Subagent views supply their own synchronous template.
    // It remains the frame until a command succeeds; contributions compose on
    // every reclaim, so failure never freezes the host-owned segments.
    if (!frames.last && options.initialLines?.length) {
      const config = readStatusLineConfig(ctx.cwd);
      if (config) frames.last = {
        command: config.command,
        placement: config.placement ?? "footer",
        padding: config.padding ?? 0,
        widgetPlacement: config.widgetPlacement ?? "belowEditor",
        lines: [...options.initialLines],
      };
    }
    // pi clears every extension widget before rebuilding this extension, and
    // the command needs a debounce plus a shell round trip to answer. Putting
    // the frame from before the reload back covers that gap — and covers it for
    // good if that first run happens to fail.
    reclaimLastGood(ctx);
    scheduleRefresh(ctx);
    armSessionClock(ctx);
  });

  /**
   * A row handed over by another extension. Redrawn immediately rather than on
   * the debounce: a contributor sends on its own clock (a goal ticks once a
   * second) and waiting would show a stale count, while re-running the command
   * for someone else's row would cost a shell round trip for nothing.
   */
  if (acceptContributions) {
    subscriptions.push(pi.events.on(STATUS_LINE_ROW_CHANNEL, (payload: unknown) => {
      const key = typeof payload === "object" && payload !== null
        ? (payload as { key?: unknown }).key
        : undefined;
      if (acceptedContributionKeys && (typeof key !== "string" || !acceptedContributionKeys.has(key))) return;
      if (!contributed.handle(payload)) return;
      if (activeCtx) reclaimLastGood(activeCtx);
    }));

  }

  // A scoped child only accepts explicit row keys. It must not let unrelated
  // contributors trigger its shell command through the unscoped refresh event.
  if (acceptContributions && !acceptedContributionKeys) {
    // A contributor whose state feeds the command itself (rather than a
    // contributed row) can ask for a re-run — debounced like any other
    // event-driven refresh. pi-fast does this when its toggle flips, because
    // the command reads pi-fast.json to place ⚡fast inside the model group.
    subscriptions.push(pi.events.on(STATUS_LINE_REFRESH_CHANNEL, () => {
      if (activeCtx) scheduleRefresh(activeCtx);
    }));
  }

  // Reclaim the last good frame immediately and once more on the next tick.
  const reclaimSoon = (ctx: any) => {
    reclaimLastGood(ctx);
    later(() => reclaimLastGood(ctx), 0);
  };

  pi.on("context", async (_event, ctx) => {
    reclaimSoon(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    reclaimSoon(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    reclaimSoon(ctx);
    scheduleRefresh(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    installModelSlot(ctx);
    reclaimLastGood(ctx);
    scheduleRefresh(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    installEffortSlot(ctx);
    reclaimLastGood(ctx);
    scheduleRefresh(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    invalidateBranchCaches();
    scheduleRefresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    invalidateBranchCaches();
    scheduleRefresh(ctx);
  });

  // Renamed from `session_switch` / `session_fork`, which pi does not emit —
  // these listeners never fired, so a switch carried its branch info over from
  // the session before it. Only the cache drop belongs here: the replacement
  // session's own `session_start` does the refresh, and refreshing a context
  // that is about to be replaced is exactly how the timer ends up holding a
  // stale ctx.
  pi.on("session_before_switch", async () => {
    invalidateBranchCaches();
  });

  pi.on("session_before_fork", async () => {
    invalidateBranchCaches();
  });

  const disposeInstanceResources = async () => {
    refreshToken++;
    for (const unsubscribe of subscriptions.splice(0)) { if (typeof unsubscribe === "function") unsubscribe(); }
    cancelPending();
    timer = null;
    retryTimer = null;
    sessionClockTimer = null;
    retryIndex = 0;
    pathOverlayOpen = false;
    cachePanelOpen = false;
    statuslineTui = undefined;
    controller?.abort();
    controller = null;
    activeCtx = null;
    // Contributors re-send on their own session_start; a row kept here would
    // outlive the session it described.
    contributed.clear();
    await Promise.allSettled([...commands]);
  };

  pi.on("session_shutdown", async (event, ctx) => {
    await disposeInstanceResources();
    clearConfigCache(ctx.cwd);
    transcriptCache.clear();

    // /reload tears down and re-binds extensions in-place. Keep the last good
    // frame — it lives in an explicit versioned handoff, so the replacement
    // runtime can adopt it without retaining the outgoing runtime's context.
    // session switch / exit still clears immediately.
    const reason = typeof event?.reason === "string" ? event.reason : "";
    if (reason === "reload") {
      return;
    }

    const placement =
      frames.last?.placement ??
      readStatusLineConfig(ctx.cwd)?.placement ??
      "footer";
    frames.last = null;
    if (frameSessionId) {
      const sessions = (globalThis as Record<PropertyKey, unknown>)[FRAME_HANDOFF_KEY];
      if (sessions instanceof Map) sessions.delete(frameSessionId);
    }
    clearStatusLineUi(ctx, placement);
  });

  return { dispose: disposeInstanceResources };
}
