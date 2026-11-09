import type {
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  CLAUDE_SPINNER_GLYPHS,
  buildClaudeSpinnerFrames,
  joinCyber,
  paintClaudeShimmer,
  segment,
} from "./cyber-style.ts";
import { formatCompletionTime, formatDuration, formatRunSegments } from "./format.ts";
import { formatCurrentActivity } from "./semantics.ts";
import type { RunMetrics } from "./metrics.ts";
import type {
  RunMetricsSnapshot,
  CapturedResult,
  ToolActivity,
  WorkingConfig,
} from "./types.ts";
import { pickVerb, TURN_ICON, workingLabel } from "./working-label.ts";
import {
  buildCyberWorkingLine,
  cyberTokenSegment,
  fitTwoLineWorkingMessage,
  cyberTps,
  paintStatusValue,
  WorkingLineSlots,
} from "./working-line.ts";
import {
  providerActiveElapsedMs,
  ProviderStatusTracker,
  formatProviderStatus,
} from "./provider-status.ts";
import { workingMessageWidth } from "./working-layout.ts";
import {
  renderWorkingToolDetail,
  WorkingToolsWidget,
} from "./working-tools.ts";
import type { TextOpener } from "./openers.ts";

import { RetryWorkingIndicator, WorkingRetryState, type RetrySnapshot } from "./working-retry.ts";
import type { RetryStart } from "./compat/working-retry.ts";

const DONE_WIDGET_KEY = "pi-claude-transcript:done";
export const WORKING_TOOLS_WIDGET_KEY = "pi-claude-transcript:working-tools";
/** How long a held working row waits for the divider that replaces it. */
const HELD_ROW_TIMEOUT_MS = 2_000;
interface WorkingTimerClock {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_TIMERS: WorkingTimerClock = {
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};
function plainMetricImportance(text: string): number {
  if (text === "esc to cancel") return 20;
  if (text.startsWith("thought ")) return 40;
  if (text.startsWith("first ")) return 45;
  if (/ turns?$/.test(text)) return 50;
  if (text.endsWith("t/s")) return 70;
  if (text.startsWith("↑") || text.startsWith("↓")) return 90;
  return 60;
}

export function buildCyberDoneLine(
  snapshot: RunMetricsSnapshot,
  config: WorkingConfig,
  theme: Theme,
  now = Date.now(),
): string {
  const label =
    snapshot.status === "cancelled"
      ? "cancelled"
      : snapshot.status === "failed"
        ? "failed"
        : "done";
  const glyph =
    snapshot.status === "done" ? "✓" : snapshot.status === "failed" ? "✗" : "○";
  const glyphColor =
    snapshot.status === "done"
      ? "success"
      : snapshot.status === "failed"
        ? "error"
        : "warning";
  const completedAt = config.showFinishedAt && snapshot.endedAt !== undefined
    ? `${theme.fg("muted", " at ")}${paintStatusValue(formatCompletionTime(snapshot.endedAt, now), "clock")}`
    : "";
  const parts = [
    `${theme.bold(theme.fg(glyphColor, glyph))} ${theme.fg("muted", label)}${completedAt}`,
    paintStatusValue(formatDuration(snapshot.elapsedMs), "elapsed"),
  ];
  const tokens = cyberTokenSegment(
    {
      input: snapshot.inputTokens,
      output: snapshot.outputTokens,
      outputEstimated: snapshot.outputEstimated,
    },
    config,
    theme,
    false,
  );
  if (tokens) {
    parts.push(tokens);
  }
  if (config.showTps && snapshot.tps !== undefined) {
    parts.push(cyberTps(snapshot.tps, snapshot.tpsEstimated, theme, false));
  }
  if (config.showTtft && snapshot.ttftMs !== undefined) {
    parts.push(
      `${theme.fg("muted", "first ")}${paintStatusValue(
        formatDuration(snapshot.ttftMs),
        "ttft",
      )}`,
    );
  }
  if (config.showThinkingTime && snapshot.thinkingMs !== undefined) {
    parts.push(
      `${theme.fg("muted", "thought ")}${paintStatusValue(
        formatDuration(snapshot.thinkingMs),
        "thinking",
      )}`,
    );
  }
  if (config.showTurns && snapshot.turnCount > 0) {
    parts.push(
      `${theme.fg("muted", TURN_ICON)}${paintStatusValue(
        String(snapshot.turnCount),
        "turns",
      )}`,
    );
  }
  return joinCyber(parts, theme.fg("muted", " · "));
}

export class WorkingController {
  private readonly retry = new WorkingRetryState();
  private tui: TUI | undefined;
  private lastMessage = "";
  private normalMessage = "";
  private retryHeadline = "";
  private lastRetryText = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeContext: ExtensionContext | undefined;
  private modalPauseDepth = 0;
  private spinnerFrameIndex = -1;
  private nextMessageRefreshAt = 0;
  private verb = pickVerb();
  private nextVerbAt = 0;
  /** The model's own current-activity headline; overrides the rotating verb. */
  private activity: string | undefined;
  private heldUi: ExtensionUIContext | undefined;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly activeTools = new Map<string, ToolActivity>();
  private readonly toolDetailListeners = new Map<string, Set<(activity: ToolActivity) => void>>();
  private toolsCollapsed = false;
  private toolsUi: ExtensionUIContext | undefined;
  private readonly slots = new WorkingLineSlots();
  private readonly clock: () => number;
  private readonly formatToolActivity: (activity: ToolActivity) => string;
  private readonly timerClock: WorkingTimerClock;
  private readonly openText: TextOpener;

  private readonly metrics: RunMetrics;
  private readonly config: WorkingConfig;
  private readonly providerStatus: ProviderStatusTracker;
  private readonly spinnerFrames: readonly string[];
  private readonly measure: (<T>(name: string, action: () => T) => T) | undefined;

  constructor(
    metrics: RunMetrics,
    config: WorkingConfig,
    providerStatus: ProviderStatusTracker,
    measure?: <T>(name: string, action: () => T) => T,
    clock: () => number = Date.now,
    formatToolActivity: (activity: ToolActivity) => string = formatCurrentActivity,
    timerClock: WorkingTimerClock = SYSTEM_TIMERS,
    openText: TextOpener = () => false,
  ) {
    this.metrics = metrics;
    this.config = config;
    this.providerStatus = providerStatus;
    this.measure = measure;
    this.clock = clock;
    this.formatToolActivity = formatToolActivity;
    this.timerClock = timerClock;
    this.openText = openText;
    this.spinnerFrames = config.style === "cyber"
      ? buildClaudeSpinnerFrames()
      : CLAUDE_SPINNER_GLYPHS;
  }

  /** Whether the working row is currently visible beside pinned widgets. */
  isWorkingVisible(): boolean {
    return this.config.enabled && this.modalPauseDepth === 0 &&
      (this.activeContext !== undefined || this.heldUi !== undefined);
  }

  /**
   * The model's own description of what it is doing (a reasoning-summary
   * headline). Shown in place of the rotating verb until replaced or the run
   * ends; undefined falls back to the verb. Painted by the regular ~120ms
   * tick, so no extra render is requested here.
   */
  setActivity(text: string | undefined): void {
    this.activity = text;
  }

  /** What the row calls the work in progress. */
  private label(): string {
    return this.activity ?? this.verb;
  }

  /** Mount before Todo so every joined child keeps a deterministic order. */
  mount(ctx: ExtensionContext): boolean {
    if (!this.config.enabled || !ctx.hasUI || this.toolsUi === ctx.ui) {
      return false;
    }
    try {
      ctx.ui.setWidget(
        WORKING_TOOLS_WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return new WorkingToolsWidget(
            () => [...this.activeTools.values()],
            () => this.toolsCollapsed,
            (activity) => this.openToolDetail(activity),
            () => this.isWorkingVisible(),
            theme,
            this.clock,
            this.formatToolActivity,
          );
        },
        { placement: "aboveEditor" },
      );
      this.toolsUi = ctx.ui;
      return true;
    } catch {
      return false;
    }
  }

  startRetry(ctx: ExtensionContext, event: RetryStart | RetrySnapshot): RetryWorkingIndicator | undefined {
    if (!this.config.enabled || !ctx.hasUI || this.tui?.mode !== "fullscreen") return undefined;
    this.releaseHeld();
    this.start(ctx);
    if ("startedAt" in event) this.retry.restore(event);
    else this.retry.start(event, this.clock());
    this.stopTimer();
    this.tick(true);
    this.startTimer();
    return new RetryWorkingIndicator(this.tui, this.lastMessage,
      this.spinnerFrames[this.spinnerFrameIndex] ?? "");
  }

  endRetry(): void {
    if (!this.retry.active()) return;
    this.retry.clear();
    this.tick(true);
    const ctx = this.activeContext;
    this.stopTimer();
    this.activeContext = undefined;
    if (ctx?.hasUI) this.safeUi(ctx.ui, () => ctx.ui.setWorkingVisible(false));
  }

  start(ctx: ExtensionContext): boolean {
    if (!this.config.enabled || !ctx.hasUI) return false;
    this.retry.clear();
    this.stopTimer();
    this.activeContext = ctx;
    this.modalPauseDepth = 0;
    this.spinnerFrameIndex = -1;
    this.nextMessageRefreshAt = 0;
    this.clearActiveTools();
    this.slots.reset();
    this.verb = pickVerb();
    this.activity = undefined;
    this.nextVerbAt = this.clock() + this.config.verbRotateMs;
    const toolsMounted = this.mount(ctx);
    this.safeUi(ctx.ui, () => {
      ctx.ui.setWidget(DONE_WIDGET_KEY, undefined);
      this.updateWorkingIndicator(ctx.ui, this.clock(), true);
      ctx.ui.setWorkingVisible(true);
    });
    this.tick(true);
    this.startTimer();
    return toolsMounted;
  }

  finish(
    ctx: ExtensionContext,
    snapshot: RunMetricsSnapshot,
    showDoneWidget = true,
    hold?: { hold: boolean; release: () => void },
  ): void {
    this.retry.clear();
    this.stopTimer();
    this.activeContext = undefined;
    this.modalPauseDepth = 0;
    this.spinnerFrameIndex = -1;
    this.nextMessageRefreshAt = 0;
    this.clearActiveTools();
    const displaySnapshot = this.withProviderActiveElapsed(snapshot);
    if (!ctx.hasUI) return;
    // The caller is about to append a row that takes this one's place. Leaving
    // the working row up until then keeps the transcript the same height across
    // the swap, which is what stops pi from repainting the whole scrollback.
    if (hold?.hold) {
      this.heldUi = ctx.ui;
      this.releaseTimer = this.timerClock.setTimer(() => {
        this.releaseTimer = undefined;
        hold.release();
      }, HELD_ROW_TIMEOUT_MS);
      return;
    }
    this.safeUi(ctx.ui, () => {
      ctx.ui.setWorkingMessage();
      ctx.ui.setWorkingIndicator();
      if (
        !showDoneWidget ||
        !this.config.enabled ||
        !this.config.showDoneSummary
      ) {
        ctx.ui.setWidget(DONE_WIDGET_KEY, undefined);
        return;
      }
      ctx.ui.setWidget(
        DONE_WIDGET_KEY,
        (_tui, theme) =>
          new Text(
            this.config.style === "cyber"
              ? buildCyberDoneLine(displaySnapshot, this.config, theme)
              : this.buildPlainDoneLine(displaySnapshot),
            0,
            0,
          ),
        { placement: "aboveEditor" },
      );
    });
  }

  /**
   * Takes the held working row down, called in the same tick as the append
   * that replaces it so the two never land in separate frames.
   */
  releaseHeld(ui?: ExtensionUIContext): void {
    if (this.releaseTimer) {
      this.timerClock.clearTimer(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    const target = ui ?? this.heldUi;
    this.heldUi = undefined;
    if (!target) return;
    this.safeUi(target, () => {
      target.setWorkingMessage();
      target.setWorkingIndicator();
      target.setWidget(DONE_WIDGET_KEY, undefined);
    });
  }

  clear(ui?: ExtensionUIContext): void {
    this.retry.clear();
    this.stopTimer();
    this.activeContext = undefined;
    this.modalPauseDepth = 0;
    this.spinnerFrameIndex = -1;
    this.nextMessageRefreshAt = 0;
    this.clearActiveTools();
    if (this.releaseTimer) {
      this.timerClock.clearTimer(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    this.heldUi = undefined;
    const target = ui ?? this.toolsUi;
    this.toolsUi = undefined;
    this.tui = undefined;
    if (!target) return;
    this.safeUi(target, () => {
      target.setWorkingMessage();
      target.setWorkingIndicator();
      target.setWidget(DONE_WIDGET_KEY, undefined);
      target.setWidget(WORKING_TOOLS_WIDGET_KEY, undefined);
    });
  }

  startTool(
    toolCallId: string,
    toolName: string,
    args: unknown,
    startedAt = this.clock(),
  ): void {
    this.activeTools.set(toolCallId, {
      id: toolCallId,
      groupId: "working",
      toolName,
      args,
      status: "running",
      startedAt,
    });
    this.tick(true);
  }

  updateTool(toolCallId: string, args: unknown, result?: CapturedResult): void {
    const activity = this.activeTools.get(toolCallId);
    if (!activity) return;
    const next = { ...activity, args, ...(result ? { result } : {}) };
    this.activeTools.set(toolCallId, next);
    this.publishToolDetail(next);
    this.tick(true);
  }

  finishTool(toolCallId: string, result?: CapturedResult): void {
    const activity = this.activeTools.get(toolCallId);
    if (!activity) return;
    this.publishToolDetail({ ...activity, result, status: result?.isError ? "failed" : "completed", endedAt: this.clock() });
    this.activeTools.delete(toolCallId);
    this.toolDetailListeners.delete(toolCallId);
    this.tick(true);
  }

  private publishToolDetail(activity: ToolActivity): void {
    for (const listener of this.toolDetailListeners.get(activity.id) ?? []) listener(activity);
  }

  private clearActiveTools(): void {
    for (const activity of this.activeTools.values()) {
      this.publishToolDetail({ ...activity, status: "cancelled", endedAt: this.clock() });
    }
    this.activeTools.clear();
    this.toolDetailListeners.clear();
  }

  private openToolDetail(activity: ToolActivity): boolean {
    let current = activity;
    const listeners = new Set<(body: string) => void>();
    const update = (next: ToolActivity) => {
      current = next;
      const body = renderWorkingToolDetail(next);
      for (const listener of listeners) listener(body);
    };
    let observers = this.toolDetailListeners.get(activity.id);
    if (!observers) this.toolDetailListeners.set(activity.id, observers = new Set());
    observers.add(update);
    const release = () => {
      observers.delete(update);
      if (observers.size === 0 && this.toolDetailListeners.get(activity.id) === observers) {
        this.toolDetailListeners.delete(activity.id);
      }
    };
    const opened = this.openText(activity.toolName, renderWorkingToolDetail(current), {
      format: "plain", glyph: "", onClose: release,
      live: {
        snapshot: () => renderWorkingToolDetail(current),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); release(); };
        },
      },
    });
    if (!opened) release();
    return opened;
  }

  pauseForModal(): void {
    const ctx = this.activeContext;
    if (!ctx?.hasUI) return;
    this.modalPauseDepth += 1;
    if (this.modalPauseDepth > 1) return;
    this.stopTimer();
    this.safeUi(ctx.ui, () => ctx.ui.setWorkingVisible(false));
  }

  resumeAfterModal(): void {
    const ctx = this.activeContext;
    if (this.modalPauseDepth <= 0) return;
    this.modalPauseDepth -= 1;
    if (this.modalPauseDepth > 0) return;
    if (!ctx?.hasUI) return;
    if (!this.safeUi(ctx.ui, () => {
      this.spinnerFrameIndex = -1;
      this.nextMessageRefreshAt = 0;
      this.updateWorkingIndicator(ctx.ui, this.clock(), true);
      ctx.ui.setWorkingVisible(true);
    })) {
      this.activeContext = undefined;
      return;
    }
    this.tick(true);
    if (!this.activeContext || this.modalPauseDepth > 0) return;
    this.startTimer();
  }

  /**
   * One clock owns both animations. Spinner and message updates in the same
   * tick each call requestRender(), but TUI coalesces those synchronous calls
   * into one frame. This avoids the old interleaved pair of intervals.
   */
  private tick(forceMessage = false, animationDue = true): void {
    const ctx = this.activeContext;
    if (this.modalPauseDepth > 0 || !ctx?.hasUI) return;
    const now = this.clock();
    if ((animationDue || forceMessage) && !this.safeUi(ctx.ui, () => this.updateWorkingIndicator(ctx.ui, now))) {
      this.stopTimer();
      this.activeContext = undefined;
      return;
    }
    const refreshNormal = forceMessage || (animationDue && now >= this.nextMessageRefreshAt);
    if (!refreshNormal && this.retry.format(now) === this.lastRetryText) return;
    if (refreshNormal) this.nextMessageRefreshAt = now + this.config.refreshMs;
    if (this.measure) this.measure("cc-style.working.render", () => this.refreshMessage(ctx, now, refreshNormal));
    else this.refreshMessage(ctx, now, refreshNormal);
  }

  private refreshMessage(ctx: ExtensionContext, now: number, refreshNormal: boolean): void {
    const retry = this.retry.format(now);
    if (refreshNormal) {
      if (now >= this.nextVerbAt) {
        this.verb = pickVerb(this.verb);
        this.nextVerbAt = now + this.config.verbRotateMs;
      }
      const snapshot = this.metrics.snapshot();
      const providerSnapshot = this.providerStatus.snapshot();
      const displaySnapshot = {
        ...snapshot,
        elapsedMs: providerActiveElapsedMs(snapshot.elapsedMs, providerSnapshot),
      };
      this.slots.update(displaySnapshot);
      const providerStatus = formatProviderStatus(providerSnapshot, ctx.ui.theme);
      this.normalMessage = this.config.style === "cyber"
          ? buildCyberWorkingLine(
            this.label(),
            displaySnapshot,
            this.slots,
            this.config,
            ctx.ui.theme,
            providerStatus,
            workingMessageWidth(this.config.messageWidth),
            now,
          )
          : this.buildPlainWorkingLine(
            displaySnapshot,
            providerStatus,
            ctx.ui.theme,
          );
      // Only normal visual ticks repaint shimmer/metrics; retry-only wakes
      // replace the suffix without advancing either animation's cadence.
      const label = truncateToWidth(workingLabel(this.label()).replace(/\.\.\.$/u, "…"),
        Math.max(1, workingMessageWidth(this.config.messageWidth) - visibleWidth(` · ${retry}`)), "…");
      this.retryHeadline = this.config.style === "cyber" ? paintClaudeShimmer(label, now) : label;
    }
    const [, ...details] = this.normalMessage.split("\n");
    const message = retry
      ? [this.retryHeadline + ctx.ui.theme.fg("warning", ` · ${retry}`), ...details].join("\n")
      : this.normalMessage;
    this.lastRetryText = retry;
    this.lastMessage = message;
    if (!this.safeUi(ctx.ui, () => ctx.ui.setWorkingMessage(message))) {
      this.stopTimer();
      this.activeContext = undefined;
    }
  }

  private buildPlainWorkingLine(
    snapshot: RunMetricsSnapshot,
    providerStatus: string,
    theme: Theme,
  ): string {
    const [elapsed = "0.0s", ...statistics] = formatRunSegments(
      snapshot,
      this.config,
    );
    if (snapshot.elapsedMs >= this.config.showCancelHintAfterMs) {
      statistics.push("esc to cancel");
    }
    return fitTwoLineWorkingMessage(
      workingLabel(this.label()),
      providerStatus,
      elapsed,
      statistics.map((text) => segment(text, plainMetricImportance(text))),
      workingMessageWidth(this.config.messageWidth),
      " · ",
      theme,
    );
  }

  private buildPlainDoneLine(snapshot: RunMetricsSnapshot): string {
    const label =
      snapshot.status === "cancelled"
        ? "cancelled"
        : snapshot.status === "failed"
          ? "failed"
          : "done";
    const glyph =
      snapshot.status === "done" ? "✓" : snapshot.status === "failed" ? "✗" : "○";
    return `${glyph} ${label} (${formatRunSegments(snapshot, this.config).join(" · ")})`;
  }

  private withProviderActiveElapsed(
    snapshot: RunMetricsSnapshot,
  ): RunMetricsSnapshot {
    const providerSnapshot = this.providerStatus.snapshot();
    return {
      ...snapshot,
      elapsedMs: providerActiveElapsedMs(snapshot.elapsedMs, providerSnapshot),
    };
  }

  private safeUi(ui: ExtensionUIContext, action: () => void): boolean {
    try {
      action();
      return true;
    } catch {
      return false;
    }
  }

  private updateWorkingIndicator(
    ui: ExtensionUIContext,
    now: number,
    force = false,
  ): void {
    const index = spinnerFrameIndex(
      this.spinnerFrames.length,
      this.config.spinnerIntervalMs,
      now,
    );
    if (!force && index === this.spinnerFrameIndex) return;
    this.spinnerFrameIndex = index;
    const frame = this.spinnerFrames[index] ?? "";
    // A single frame keeps pi's Loader timer stopped. The controller's one
    // clock advances this frame and the shimmer/metrics together.
    ui.setWorkingIndicator({
      frames: [frame],
      intervalMs: this.config.spinnerIntervalMs,
    });
  }

  private startTimer(): void {
    const intervalMs = workingTickMs(this.config);
    let nextAnimationAt = this.clock() + intervalMs;
    const schedule = () => {
      const now = this.clock();
      const dueAt = Math.min(nextAnimationAt, this.retry.nextRefreshAt(now));
      this.timer = this.timerClock.setTimer(() => {
        this.timer = undefined;
        const now = this.clock();
        const animationDue = now >= nextAnimationAt;
        if (animationDue) nextAnimationAt = now + intervalMs;
        this.tick(false, animationDue);
        if (this.activeContext && this.modalPauseDepth === 0) schedule();
      }, Math.max(0, dueAt - now));
    };
    schedule();
  }

  private stopTimer(): void {
    if (this.timer) this.timerClock.clearTimer(this.timer);
    this.timer = undefined;
  }
}

/** Shared clock cadence: fast enough for whichever visual changes first. */
export function workingTickMs(config: Pick<WorkingConfig, "refreshMs" | "spinnerIntervalMs">): number {
  return Math.min(config.refreshMs, config.spinnerIntervalMs);
}

/** Clock-derived so a delayed tick skips ahead instead of slowing the animation. */
export function spinnerFrameIndex(frameCount: number, intervalMs: number, now: number): number {
  if (frameCount <= 1) return 0;
  return Math.floor(now / Math.max(1, intervalMs)) % frameCount;
}
