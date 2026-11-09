import type {
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { truncateWithMutedEllipsis } from "./ellipsis.ts";
import { formatTokenCount } from "./format.ts";
import type { GoalConfig } from "./types.ts";
import { LegacyGoalSnapshotReader } from "./goal-status-legacy.ts";
import {
  GOAL_SNAPSHOT_CHANNEL,
  GOAL_SNAPSHOT_REQUEST_CHANNEL,
  STATUS_LINE_GOAL_ROW_KEY as STATUS_LINE_ROW_KEY,
  STATUS_LINE_ROW_CHANNEL,
} from "./integration-contracts.ts";

const GOAL_WIDGET_KEY = "pi-claude-transcript:goal";
const GOAL_STATUS_KEY = "pi-claude-transcript:goal";

/**
 * The channel `pi-statusline` takes finished rows on, and the key this row
 * claims there. A leading tab is what that renderer right-aligns after, and it
 * is the only one who knows the real width, so the row is handed over whole
 * and unpadded.
 */
/** Goal domain statuses carried by the semantic owner contract. */
export type GoalPhase =
  | "active"
  | "queued"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export interface GoalSnapshot {
  id: string;
  text: string;
  phase: GoalPhase;
  /** Seconds the goal has actually been running, including the current stretch. */
  runtimeSeconds: number;
  /** Tokens billed since the goal started, including the current stretch. */
  tokensUsed: number;
  tokenBudget: number | undefined;
  queued: number;
  /** Owner observation time; only an explicitly running clock advances locally. */
  observedAt?: number;
  clockRunning?: boolean;
  /** Explicit owner queue freeze; absence is not evidence that the queue is off. */
  queueFrozen?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function phaseOf(value: unknown): GoalPhase | undefined {
  return value === "active" ||
    value === "queued" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usage_limited" ||
    value === "budget_limited" ||
    value === "complete"
    ? value
    : undefined;
}

export function readGoalSnapshotV1(
  value: unknown,
  sessionId?: string,
): GoalSnapshot | null | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (sessionId && value.sessionId !== sessionId) return undefined;
  if (value.goal === null) return null;
  if (!isRecord(value.goal)) return undefined;
  const phase = phaseOf(value.goal.phase);
  const id = value.goal.id;
  const text = value.goal.text;
  const runtimeSeconds = value.goal.runtimeSeconds;
  const tokensUsed = value.goal.tokensUsed;
  const queued = value.goal.queued;
  const observedAt = value.goal.observedAt;
  const clockRunning = value.goal.clockRunning;
  const queueFrozen = value.goal.queueFrozen;
  if (
    !phase ||
    typeof id !== "string" ||
    typeof text !== "string" ||
    typeof runtimeSeconds !== "number" ||
    !Number.isFinite(runtimeSeconds) ||
    runtimeSeconds < 0 ||
    typeof tokensUsed !== "number" ||
    !Number.isFinite(tokensUsed) ||
    tokensUsed < 0 ||
    typeof queued !== "number" ||
    !Number.isSafeInteger(queued) ||
    queued < 0 ||
    typeof observedAt !== "number" ||
    !Number.isFinite(observedAt) ||
    (clockRunning !== undefined && typeof clockRunning !== "boolean") ||
    (queueFrozen !== undefined && typeof queueFrozen !== "boolean")
  ) return undefined;
  const budget = value.goal.tokenBudget;
  if (
    budget !== undefined &&
    (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0)
  ) return undefined;
  const normalizedText = text.trim();
  if (!normalizedText) return undefined;
  return {
    id,
    text: normalizedText,
    phase,
    runtimeSeconds,
    tokensUsed,
    tokenBudget: budget as number | undefined,
    queued,
    observedAt,
    ...(clockRunning === undefined ? {} : { clockRunning }),
    ...(queueFrozen === undefined ? {} : { queueFrozen }),
  };
}

export { cumulativeAssistantTokens, readGoalSnapshot } from "./goal-status-legacy.ts";

/** `12.4k`, or `12.4k/50k` when the goal runs under a token budget. */
export function formatGoalTokens(snapshot: GoalSnapshot): string {
  const used = formatTokenCount(snapshot.tokensUsed);
  return snapshot.tokenBudget === undefined
    ? used
    : `${used}/${formatTokenCount(snapshot.tokenBudget)}`;
}

/**
 * Elapsed run time, whatever the goal is currently doing. Same hour/minute
 * compact form as the spinner, but integer seconds only — a fractional second
 * only makes sense for a single request.
 */
export function formatGoalRuntime(snapshot: GoalSnapshot): string {
  const total = Math.max(0, Math.floor(snapshot.runtimeSeconds));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  const pad = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) return `${hours}h${pad(minutes)}m${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`;
  return `${seconds}s`;
}

function phaseColor(
  phase: GoalPhase,
): "accent" | "success" | "warning" | "muted" {
  if (phase === "active") return "accent";
  if (phase === "complete") return "success";
  if (phase === "blocked") return "warning";
  return "muted";
}

/** Just enough of `pi.events` to hand a row over. */
export interface EventBusLike {
  emit(channel: string, payload: unknown): void;
  on?(channel: string, handler: (payload: unknown) => void): () => void;
}

type Measure = <T>(name: string, action: () => T) => T;

export function buildGoalLine(
  snapshot: GoalSnapshot,
  config: GoalConfig,
  theme: Theme | undefined,
  width: number,
): string {
  const paint = (color: string, text: string) => {
    if (!theme) return text;
    try {
      return theme.fg(color as never, text);
    } catch {
      return text;
    }
  };
  const color = phaseColor(snapshot.phase);
  const queued = snapshot.queued > 0 ? ` +${snapshot.queued}` : "";

  let line = `${paint(color, `${config.label} ${snapshot.phase}${queued}`)}`;
  if (snapshot.queueFrozen === true) line += paint("warning", " · queue off");
  line += ` ${paint("dim", formatGoalRuntime(snapshot))}`;
  if (config.showTokens) {
    line += ` ${paint("text", formatGoalTokens(snapshot))}`;
  }
  if (config.showText && snapshot.text) {
    // A multi-line objective has to read as one row, so its breaks collapse.
    line += paint("dim", `: ${snapshot.text.replace(/\s+/g, " ")}`);
  }

  // Left-aligned and hard-clipped to one row. The objective is not cut to a
  // fixed character count — it simply uses whatever the terminal has left —
  // and the row can never wrap, which would change the transcript height and
  // cost a full redraw every time the counters tick.
  return theme
    ? truncateWithMutedEllipsis(line, Math.max(1, Math.floor(width)), theme)
    : truncateToWidth(line, Math.max(1, Math.floor(width)), "…");
}

class GoalLineComponent {
  private readonly getSnapshot: () => GoalSnapshot | undefined;
  private readonly config: GoalConfig;
  private readonly theme: Theme;

  constructor(
    getSnapshot: () => GoalSnapshot | undefined,
    config: GoalConfig,
    theme: Theme,
  ) {
    this.getSnapshot = getSnapshot;
    this.config = config;
    this.theme = theme;
  }

  render(width: number): string[] {
    const snapshot = this.getSnapshot();
    if (!snapshot) return [];
    // Returned as one pre-clipped row rather than through Text: this widget
    // redraws once a second, and a wrapped second row would resize the
    // transcript under the editor on every tick.
    return [buildGoalLine(snapshot, this.config, this.theme, Math.max(8, width))];
  }

  invalidate(): void {}
}

/**
 * Surfaces pi-goal's semantic snapshot next to the transcript. A compatibility
 * adapter reads old session entries only when no owner answers the protocol.
 */
export class GoalStatusController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: GoalSnapshot | undefined;
  private lastKey = "";
  private widgetInstalled = false;
  private completedAt: number | undefined;
  private completedSnapshot: GoalSnapshot | undefined;
  private readonly legacy = new LegacyGoalSnapshotReader();
  private ownerSeen = false;
  private ownerSnapshot: GoalSnapshot | undefined;
  private pendingOwnerPayload: unknown;
  private currentContext: ExtensionContext | undefined;
  private stopOwnerListener: (() => void) | undefined;
  private readonly config: GoalConfig;
  private readonly events: EventBusLike | undefined;
  private readonly measure: Measure;
  private readonly timerClock: {
    setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimer(timer: ReturnType<typeof setTimeout>): void;
  };
  /** True once the statusline has answered for this row at least once. */
  private rowTaken = false;

  constructor(
    config: GoalConfig,
    events?: EventBusLike,
    measure: Measure = (_name, action) => action(),
    timerClock = {
      setTimer(callback: () => void, delayMs: number) {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      },
      clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    },
  ) {
    this.config = config;
    this.events = events;
    this.measure = measure;
    this.timerClock = timerClock;
    this.stopOwnerListener = events?.on?.(
      GOAL_SNAPSHOT_CHANNEL,
      (payload) => this.acceptOwnerPayload(payload),
    );
  }

  start(ctx: ExtensionContext): void {
    if (!this.config.enabled || !ctx.hasUI) return;
    this.stop();
    this.currentContext = ctx;
    if (this.pendingOwnerPayload !== undefined) {
      this.acceptOwnerPayload(this.pendingOwnerPayload);
    }
    this.requestOwnerSnapshot(ctx);
    this.refresh(ctx);
    this.scheduleRefresh(ctx);
  }

  stop(): void {
    if (this.timer) this.timerClock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private scheduleRefresh(ctx: ExtensionContext): void {
    this.timer = this.timerClock.setTimer(() => {
      this.timer = undefined;
      if (this.currentContext !== ctx) return;
      this.refresh(ctx);
      if (this.currentContext === ctx) this.scheduleRefresh(ctx);
    }, this.config.refreshMs);
  }

  clear(ui?: ExtensionUIContext): void {
    this.stop();
    this.snapshot = undefined;
    this.completedAt = undefined;
    this.completedSnapshot = undefined;
    this.legacy.clear();
    this.ownerSeen = false;
    this.ownerSnapshot = undefined;
    this.pendingOwnerPayload = undefined;
    this.currentContext = undefined;
    this.lastKey = "";
    this.widgetInstalled = false;
    this.withdrawRow();
    if (!ui) return;
    try {
      ui.setWidget(GOAL_WIDGET_KEY, undefined);
      ui.setStatus(GOAL_STATUS_KEY, undefined);
    } catch {
      // The UI may already be gone during teardown.
    }
  }

  dispose(ui?: ExtensionUIContext): void {
    this.clear(ui);
    this.stopOwnerListener?.();
    this.stopOwnerListener = undefined;
  }

  private refresh(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const now = Date.now();
    let snapshot = this.liveOwnerSnapshot(now);
    if (!this.ownerSeen) {
      try {
        snapshot = this.measure(
          "cc-style.goal.legacy-fallback",
          () => this.legacy.read(ctx.sessionManager.getBranch(), now),
        );
      } catch {
        return;
      }
    }

    // pi-goal clears the entry shortly after a goal completes. Hold the "Done"
    // line briefly so a finished goal is actually seen.
    if (snapshot?.phase === "complete") {
      this.completedAt = now;
      this.completedSnapshot = snapshot;
    } else if (
      !snapshot &&
      this.completedSnapshot &&
      this.completedAt !== undefined &&
      now - this.completedAt < this.config.completedLingerMs
    ) {
      snapshot = this.completedSnapshot;
    } else if (snapshot) {
      this.completedAt = undefined;
      this.completedSnapshot = undefined;
    }

    this.snapshot = snapshot;
    const key = snapshot
      ? `${snapshot.id}|${snapshot.phase}|${formatGoalRuntime(snapshot)}|${
        formatGoalTokens(snapshot)
      }|${snapshot.queued}|${snapshot.queueFrozen === true}`
      : "";
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.publish(ctx, snapshot);
  }

  private acceptOwnerPayload(payload: unknown): void {
    this.pendingOwnerPayload = payload;
    const ctx = this.currentContext;
    if (!ctx) return;
    this.measure("cc-style.goal.snapshot.apply", () => {
      const parsed = readGoalSnapshotV1(payload, this.sessionId(ctx));
      if (parsed === undefined) return;
      this.ownerSeen = true;
      this.ownerSnapshot = parsed ?? undefined;
      if (ctx.hasUI) this.refresh(ctx);
    });
  }

  private requestOwnerSnapshot(ctx: ExtensionContext): void {
    if (!this.events) return;
    this.measure("cc-style.goal.snapshot.request", () =>
      this.safe(() => this.events?.emit(GOAL_SNAPSHOT_REQUEST_CHANNEL, {
        sessionId: this.sessionId(ctx),
        reply: (payload: unknown) => this.acceptOwnerPayload(payload),
      })));
  }

  private liveOwnerSnapshot(now: number): GoalSnapshot | undefined {
    const snapshot = this.ownerSnapshot;
    if (!snapshot) return undefined;
    if (snapshot.clockRunning !== true || snapshot.observedAt === undefined) return snapshot;
    return {
      ...snapshot,
      runtimeSeconds: snapshot.runtimeSeconds +
        Math.max(0, now - snapshot.observedAt) / 1_000,
    };
  }

  private sessionId(ctx: ExtensionContext): string | undefined {
    const sessionManager = ctx.sessionManager as { getSessionId?: () => unknown };
    const value = this.safeValue(() => sessionManager.getSessionId?.());
    return typeof value === "string" && value ? value : undefined;
  }

  private publish(
    ctx: ExtensionContext,
    snapshot: GoalSnapshot | undefined,
  ): void {
    if (!ctx.hasUI) return;
    if (!snapshot) {
      this.withdrawRow();
      this.safe(() => ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined));
      this.safe(() => ctx.ui.setStatus(GOAL_STATUS_KEY, undefined));
      this.widgetInstalled = false;
      return;
    }

    // Handed to the statusline, which draws it as a row of its own under the
    // command's. It answers synchronously, so a statusline that is not loaded
    // is known immediately and the row falls back to a widget of its own
    // rather than disappearing.
    if (this.config.placement === "statusline" && this.offerRow(ctx, snapshot)) {
      if (this.widgetInstalled) {
        this.safe(() => ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined));
        this.widgetInstalled = false;
      }
      this.safe(() => ctx.ui.setStatus(GOAL_STATUS_KEY, undefined));
      return;
    }
    const placed = this.widgetInstalled ||
      this.safe(() =>
        ctx.ui.setWidget(
          GOAL_WIDGET_KEY,
          (_tui, theme) =>
            new GoalLineComponent(() => this.snapshot, this.config, theme),
          {
            // "statusline" only reaches here as a fallback, when no statusline
            // took the row; a widget above the editor is the nearest home.
            placement: this.config.placement === "statusline"
              ? "aboveEditor"
              : this.config.placement,
          },
        )
      );
    if (placed) {
      this.widgetInstalled = true;
      // The widget re-reads the snapshot on every render, so nothing else is
      // needed to keep the runtime ticking.
      return;
    }
    this.safe(() =>
      ctx.ui.setStatus(
        GOAL_STATUS_KEY,
        `${this.config.label} ${snapshot.phase} ${formatGoalRuntime(snapshot)}${
          this.config.showTokens ? ` ${formatGoalTokens(snapshot)}` : ""
        }`,
      )
    );
  }

  /**
   * Hand the row to the statusline. Returns whether anyone took it.
   *
   * The tab is the statusline's own right-alignment marker: it knows the width
   * after a resize, this does not, so the row goes over unpadded.
   */
  private offerRow(ctx: ExtensionContext, snapshot: GoalSnapshot): boolean {
    if (!this.events) return false;
    const theme = this.safeValue(() => ctx.ui.theme);
    // Width is the statusline's business; build the row whole and let it clip.
    const line = buildGoalLine(snapshot, this.config, theme, Number.MAX_SAFE_INTEGER);
    let accepted = false;
    this.safe(() =>
      this.events?.emit(STATUS_LINE_ROW_CHANNEL, {
        key: STATUS_LINE_ROW_KEY,
        line,
        // Right side of the statusline's third row (todo/processes on its
        // left), falling back to the last row of a shorter command.
        placement: "inline",
        row: 3,
        align: "right",
        reply: () => {
          accepted = true;
        },
      })
    );
    this.rowTaken ||= accepted;
    return accepted;
  }

  private withdrawRow(): void {
    if (!this.events || !this.rowTaken) return;
    this.rowTaken = false;
    this.safe(() =>
      this.events?.emit(STATUS_LINE_ROW_CHANNEL, { key: STATUS_LINE_ROW_KEY })
    );
  }

  private safe(action: () => void): boolean {
    try {
      action();
      return true;
    } catch {
      return false;
    }
  }

  private safeValue<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      return undefined;
    }
  }
}
