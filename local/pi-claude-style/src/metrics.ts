import type { AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import {
  StreamingTokenEstimator,
  supportsExactStreamingUsage,
} from "./token-usage.ts";
import type { RunMetricsSnapshot, RunStatus } from "./types.ts";

interface MetricsClock {
  now(): number;
}

const DEFAULT_CLOCK: MetricsClock = { now: Date.now };

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export class RunMetrics {
  /**
   * Generation time the live rate is measured over. Long enough that a pause
   * between two deltas does not read as a stall, short enough to follow a
   * model that changes pace mid-answer.
   */
  private static readonly TPS_WINDOW_MS = 5_000;
  /** Buffered deltas are not a rate until a meaningful observation span exists. */
  private static readonly TPS_MIN_OBSERVATION_MS = 500;

  private status: RunStatus = "done";
  private phase: RunMetricsSnapshot["phase"] = "idle";
  private startedAt = 0;
  private endedAt: number | undefined;
  private ttftAt: number | undefined;
  private thinkingStartedAt: number | undefined;
  private thinkingMs = 0;
  private generationStartedAt: number | undefined;
  private generationMs = 0;
  private completedUsage = emptyUsage();
  private partialUsage = emptyUsage();
  private partialOutputExact = false;
  private currentTurnCommitted = true;
  private readonly outputEstimator = new StreamingTokenEstimator();
  private turnCount = 0;
  private toolDepth = 0;
  /** Measured (duration, tokens) intervals inside the window. */
  private rateWindow: Array<{ ms: number; tokens: number }> = [];
  /** When the last delta landed, or undefined between stretches of generation. */
  private lastRateAt: number | undefined;
  private lastRateTokens: number | undefined;
  /** Accumulate deltas until the minimum observation span has elapsed. */
  private rateStartedAt: number | undefined;
  private rateStartedTokens: number | undefined;
  private rateEstimated: boolean | undefined;
  private readonly clock: MetricsClock;

  constructor(clock: MetricsClock = DEFAULT_CLOCK) {
    this.clock = clock;
  }

  start(): void {
    this.status = "running";
    this.phase = "thinking";
    this.startedAt = this.clock.now();
    this.endedAt = undefined;
    this.ttftAt = undefined;
    this.thinkingStartedAt = undefined;
    this.thinkingMs = 0;
    this.generationStartedAt = undefined;
    this.generationMs = 0;
    this.completedUsage = emptyUsage();
    this.partialUsage = emptyUsage();
    this.partialOutputExact = false;
    this.currentTurnCommitted = true;
    this.outputEstimator.reset();
    this.turnCount = 0;
    this.toolDepth = 0;
    this.rateWindow = [];
    this.lastRateAt = undefined;
    this.lastRateTokens = undefined;
    this.rateStartedAt = undefined;
    this.rateStartedTokens = undefined;
    this.rateEstimated = undefined;
  }

  startTurn(timestamp?: number): void {
    if (this.status !== "running") return;
    this.turnCount++;
    if (this.toolDepth === 0) this.phase = "thinking";
    void timestamp;
    this.partialUsage = emptyUsage();
    this.partialOutputExact = false;
    this.outputEstimator.reset();
    this.currentTurnCommitted = false;
    this.rateWindow = [];
    this.lastRateAt = undefined;
    this.lastRateTokens = undefined;
    this.rateStartedAt = undefined;
    this.rateStartedTokens = undefined;
    this.rateEstimated = undefined;
  }

  handleAssistantEvent(event: AssistantMessageEvent): void {
    if (this.status !== "running") return;
    const now = this.clock.now();
    if ("partial" in event) {
      this.partialUsage = maxUsage(this.partialUsage, event.partial.usage);
      this.partialOutputExact =
        this.partialOutputExact ||
        supportsExactStreamingUsage(event.partial.api) ||
        event.partial.usage.output > 0;
    }
    switch (event.type) {
      case "thinking_start":
        this.phase = "thinking";
        if (this.thinkingStartedAt === undefined) this.thinkingStartedAt = now;
        break;
      case "thinking_delta":
        if (event.delta) {
          this.phase = "generating";
          this.markFirstToken(now);
          this.outputEstimator.add(event.delta);
          this.sampleRate(now);
        }
        break;
      case "thinking_end":
        this.stopThinking(now);
        if (this.toolDepth === 0) this.phase = "thinking";
        break;
      case "text_start":
        break;
      case "text_delta":
      case "toolcall_delta":
        if (event.delta) {
          this.phase = "generating";
          this.markFirstToken(now);
          this.outputEstimator.add(event.delta);
          this.sampleRate(now);
        }
        break;
      case "done":
        this.partialUsage = maxUsage(
          this.partialUsage,
          event.message.usage,
        );
        // Terminal usage reconciles totals; it has no observed generation interval.
        // Keep the live rate measured from deltas, including exact cumulative usage.
        this.partialOutputExact = true;
        this.commitPartialUsage();
        this.stopThinking(now);
        this.stopGeneration(now);
        if (this.toolDepth === 0) this.phase = "thinking";
        break;
      case "error":
        this.partialUsage = maxUsage(
          this.partialUsage,
          event.error.usage,
        );
        this.partialOutputExact = true;
        this.commitPartialUsage();
        this.stopThinking(now);
        this.stopGeneration(now);
        if (this.toolDepth === 0) this.phase = "thinking";
        break;
      default:
        break;
    }
  }

  pauseForTool(): void {
    const now = this.clock.now();
    this.toolDepth++;
    this.phase = "tool";
    this.stopThinking(now);
    this.stopGeneration(now);
  }

  resumeAfterTool(): void {
    this.toolDepth = Math.max(0, this.toolDepth - 1);
    if (this.toolDepth === 0 && this.status === "running") {
      this.phase = "thinking";
    }
  }

  reconcileFinalUsage(usage: Usage): void {
    if (this.status !== "running" || this.currentTurnCommitted) return;
    this.partialUsage = maxUsage(this.partialUsage, usage);
    this.partialOutputExact = true;
    this.commitPartialUsage();
  }

  reconcileTurnUsage(usage: Usage): void {
    this.reconcileFinalUsage(usage);
  }

  finish(status: Exclude<RunStatus, "running">): RunMetricsSnapshot {
    const now = this.clock.now();
    this.stopThinking(now);
    this.stopGeneration(now);
    this.status = status;
    this.phase = "idle";
    this.endedAt = now;
    return this.snapshot();
  }

  /** Output so far: exact where the provider reports it, estimated while it does not. */
  private outputTokensNow(): { tokens: number | undefined; estimated: boolean } {
    const exact =
      this.completedUsage.output +
      (this.partialOutputExact ? this.partialUsage.output : 0);
    const guessed = this.outputEstimator.value();
    const estimated =
      !this.currentTurnCommitted && !this.partialOutputExact && guessed > 0;
    const tokens = estimated
      ? this.completedUsage.output + guessed
      : exact > 0
        ? exact
        : undefined;
    return { tokens, estimated };
  }

  /** The generation clock: time spent producing, tool calls and idle gaps excluded. */
  private generationMsAt(now: number): number {
    return (
      this.generationMs +
      (this.generationStartedAt === undefined ? 0 : now - this.generationStartedAt)
    );
  }

  snapshot(): RunMetricsSnapshot {
    const now = this.endedAt ?? this.clock.now();
    const exactInput = this.completedUsage.input + this.partialUsage.input;
    const { tokens: outputTokens, estimated: outputEstimated } =
      this.outputTokensNow();
    const generationMs = this.generationMsAt(now);
    const thinkingMs =
      this.thinkingMs +
      (this.thinkingStartedAt === undefined ? 0 : now - this.thinkingStartedAt);
    // Two different questions, two different answers. A finished run wants the
    // average it managed overall; a running one is being watched, and what the
    // watcher reads "t/s" as is how fast it is going *now*.
    const runAverageTps =
      outputTokens !== undefined && generationMs >= RunMetrics.TPS_MIN_OBSERVATION_MS
        ? outputTokens / (generationMs / 1_000)
        : undefined;
    const tps = this.status === "running" ? this.recentTps() : runAverageTps;
    return {
      status: this.status,
      phase: this.phase,
      elapsedMs: Math.max(0, now - this.startedAt),
      inputTokens: exactInput > 0 ? exactInput : undefined,
      outputTokens,
      outputEstimated,
      tps,
      tpsEstimated: outputEstimated && tps !== undefined,
      ttftMs:
        this.ttftAt === undefined ? undefined : Math.max(0, this.ttftAt - this.startedAt),
      thinkingMs: thinkingMs > 0 ? thinkingMs : undefined,
      turnCount: this.turnCount,
      // Recorded by `finish()`, so the done row shows when the run actually
      // ended rather than when the row happened to be drawn — it is rebuilt on
      // a theme change, and `Date.now()` there would quietly move the clock.
      endedAt: this.endedAt,
    };
  }

  private markFirstToken(now: number): void {
    if (this.ttftAt === undefined) this.ttftAt = now;
    this.startGeneration(now);
  }

  /**
   * Sample the rate where the numbers actually move.
   *
   * Not from `snapshot()`: that is called by whoever happens to be drawing, so
   * the window would thin out whenever the row is hidden or its timer paused,
   * and `snapshot()` would be a getter that mutates.
   */
  private sampleRate(now: number): void {
    const output = this.outputTokensNow();
    // An observed usage counter can replace an estimate mid-stream. Never
    // measure the difference between two different token-counting sources.
    if (this.rateEstimated !== undefined && this.rateEstimated !== output.estimated) {
      this.lastRateAt = undefined;
      this.lastRateTokens = undefined;
      this.rateStartedAt = undefined;
      this.rateStartedTokens = undefined;
    }
    this.rateEstimated = output.estimated;
    this.recordInterval(now, output.tokens);
  }

  /**
   * Record the interval between this delta and the one before it.
   *
   * Intervals, not cumulative samples. A delta that *starts* a stretch of
   * generation has no measured time behind it — the clock begins when it
   * arrives, though the tokens took the preceding pause to produce — so
   * counting it against any elapsed time reads roughly double. That happens at
   * the first token of the run and again after every tool call. Measuring
   * between two deltas leaves those tokens out of the numerator and the
   * denominator both, which is the only pairing that is true.
   *
   * `stopGeneration` clears the mark, so the gap spanning a tool call is never
   * an interval, and the window keeps the last real intervals across it rather
   * than emptying and blanking the column.
   */
  private recordInterval(
    now: number,
    tokens: number | undefined,
  ): void {
    if (tokens === undefined) {
      this.lastRateAt = now;
      return;
    }
    const since = this.lastRateAt;
    const before = this.lastRateTokens;
    this.lastRateAt = now;
    this.lastRateTokens = tokens;
    if (since === undefined || before === undefined) {
      this.rateStartedAt = now;
      this.rateStartedTokens = tokens;
      return;
    }

    const ms = now - (this.rateStartedAt ?? since);
    const produced = tokens - (this.rateStartedTokens ?? before);
    if (ms < RunMetrics.TPS_MIN_OBSERVATION_MS || produced <= 0) return;
    this.recordRateInterval(ms, produced);
    this.rateStartedAt = now;
    this.rateStartedTokens = tokens;
  }

  private recordRateInterval(ms: number, tokens: number): void {
    this.rateWindow.push({ ms, tokens });
    let total = this.rateWindow.reduce((sum, entry) => sum + entry.ms, 0);
    while (this.rateWindow.length > 1 && total > RunMetrics.TPS_WINDOW_MS) {
      total -= this.rateWindow.shift()!.ms;
    }
  }

  /** Tokens per second across the intervals still inside the window. */
  private recentTps(): number | undefined {
    if (this.rateWindow.length === 0) return undefined;
    let ms = 0;
    let tokens = 0;
    for (const entry of this.rateWindow) {
      ms += entry.ms;
      tokens += entry.tokens;
    }
    return ms > 0 && tokens > 0 ? tokens / (ms / 1_000) : undefined;
  }

  private startGeneration(now: number): void {
    if (this.generationStartedAt === undefined) this.generationStartedAt = now;
  }

  private stopGeneration(now: number): void {
    // The next delta begins a new stretch, so it must not be paired with this
    // one across the gap.
    this.lastRateAt = undefined;
    this.lastRateTokens = undefined;
    this.rateStartedAt = undefined;
    this.rateStartedTokens = undefined;
    this.rateEstimated = undefined;
    if (this.generationStartedAt === undefined) return;
    this.generationMs += Math.max(0, now - this.generationStartedAt);
    this.generationStartedAt = undefined;
  }

  private stopThinking(now: number): void {
    if (this.thinkingStartedAt === undefined) return;
    this.thinkingMs += Math.max(0, now - this.thinkingStartedAt);
    this.thinkingStartedAt = undefined;
  }

  private commitPartialUsage(): void {
    this.completedUsage = addUsage(this.completedUsage, this.partialUsage);
    this.partialUsage = emptyUsage();
    this.partialOutputExact = false;
    this.currentTurnCommitted = true;
  }
}

function maxUsage(left: Usage, right: Usage): Usage {
  return {
    input: Math.max(left.input, right.input),
    output: Math.max(left.output, right.output),
    cacheRead: Math.max(left.cacheRead, right.cacheRead),
    cacheWrite: Math.max(left.cacheWrite, right.cacheWrite),
    reasoning: Math.max(left.reasoning ?? 0, right.reasoning ?? 0),
    totalTokens: Math.max(left.totalTokens, right.totalTokens),
    cost: {
      input: Math.max(left.cost.input, right.cost.input),
      output: Math.max(left.cost.output, right.cost.output),
      cacheRead: Math.max(left.cost.cacheRead, right.cost.cacheRead),
      cacheWrite: Math.max(left.cost.cacheWrite, right.cost.cacheWrite),
      total: Math.max(left.cost.total, right.cost.total),
    },
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}
