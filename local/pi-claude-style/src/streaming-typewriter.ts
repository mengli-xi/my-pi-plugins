import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantTypewriterConfig } from "./types.ts";

export interface TypewriterObservability {
  record(name: string, ms: number, detail?: string): void;
  observe(name: string, value: number, unit: string): void;
  gauge(name: string, value: number, unit: string): void;
  increment(name: string, delta?: number): void;
}

export interface TypewriterClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: TypewriterClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};

type Present = (message: AssistantMessage, isStreaming: boolean) => void;

interface TextTarget {
  index: number;
  text: string;
}

interface TypewriterState {
  key: object;
  target: AssistantMessage;
  targetIndex: number;
  targetText: string;
  revealed: number;
  lastFrameAt: number;
  lastDeltaAt?: number;
  ended: boolean;
  endDeadline?: number;
  timer?: ReturnType<typeof setTimeout>;
  renderedMessage?: AssistantMessage;
  present: Present;
  lastRenderCostMs: number;
}

export interface TypewriterPressure {
  renderMs: number;
  eventLoopDelayMs: number;
}

/**
 * Coalesces bursty text snapshots and exposes them to Markdown on a bounded
 * cadence. It never mutates the protocol message: only the component receives
 * a shallow projection whose active text block is shortened.
 */
export class StreamingTypewriter {
  private readonly config: AssistantTypewriterConfig;
  private readonly metrics?: TypewriterObservability;
  private readonly clock: TypewriterClock;
  private readonly states = new WeakMap<object, TypewriterState>();
  private readonly active = new Set<TypewriterState>();
  private readonly pressure: (() => TypewriterPressure | undefined) | undefined;

  constructor(
    config: AssistantTypewriterConfig,
    metrics?: TypewriterObservability,
    clock: TypewriterClock = SYSTEM_CLOCK,
    pressure?: () => TypewriterPressure | undefined,
  ) {
    this.config = {
      ...config,
      maxCharsPerFrame: Math.max(
        config.minCharsPerFrame,
        config.maxCharsPerFrame,
      ),
    };
    this.metrics = metrics;
    this.clock = clock;
    this.pressure = pressure;
  }

  update(
    key: object,
    message: AssistantMessage,
    isStreaming: boolean,
    present: Present,
  ): void {
    if (!this.config.enabled) {
      present(message, isStreaming);
      return;
    }

    const existing = this.states.get(key);
    // Native invalidation methods call updateContent(lastMessage). Keep the
    // projected frame visible without mistaking it for a provider rollback.
    if (existing?.renderedMessage === message) {
      present(message, isStreaming);
      return;
    }

    const target = trailingText(message);
    if (!target || (!isStreaming && !existing)) {
      if (existing) this.drop(existing);
      present(message, isStreaming);
      this.publishBacklog();
      return;
    }

    if (
      !isStreaming &&
      (message.stopReason === "aborted" ||
        message.stopReason === "error" ||
        message.stopReason === "length")
    ) {
      if (existing) this.drop(existing);
      present(message, false);
      this.publishBacklog();
      return;
    }

    if (existing && (
      existing.targetIndex !== target.index ||
      target.text.length < existing.revealed
    )) {
      this.drop(existing);
      present(message, isStreaming);
      this.publishBacklog();
      return;
    }

    const now = this.clock.now();
    const state = existing ?? this.createState(
      key,
      message,
      target,
      present,
      now,
    );
    const grewBy = Math.max(0, target.text.length - state.targetText.length);
    state.target = message;
    state.targetText = target.text;
    state.present = present;

    if (grewBy > 0) {
      if (state.lastDeltaAt !== undefined) {
        this.metrics?.observe(
          "cc-style.typewriter.delta-interval",
          now - state.lastDeltaAt,
          "ms",
        );
      }
      state.lastDeltaAt = now;
      this.metrics?.increment("cc-style.typewriter.delta-chars", grewBy);
    }

    if (!isStreaming) {
      state.ended = true;
      state.endDeadline = now + this.config.finalDrainMs;
      if (this.config.finalDrainMs === 0) {
        this.emit(state, this.backlog(state), false);
        return;
      }
    }

    const backlog = this.backlog(state);
    if (backlog === 0) {
      // message_end still needs one native update so Markdown drops its
      // streaming transform and renders the completed syntax.
      if (state.ended) this.emit(state, 0, false);
      else this.ensureTimer(state);
      return;
    }

    if (state.revealed === 0 || now - state.lastFrameAt >= this.effectiveFrameMs(state)) {
      this.emit(state, this.config.minCharsPerFrame, !state.ended);
    } else {
      this.metrics?.increment("cc-style.typewriter.coalesced-updates");
    }
    this.ensureTimer(state);
    this.publishBacklog();
  }

  /** Flushes pending text and cancels all timers. */
  dispose(flush = true): void {
    for (const state of [...this.active]) {
      if (flush) {
        state.revealed = state.targetText.length;
        state.ended = true;
        this.emit(state, 0, false);
      } else {
        this.drop(state);
      }
    }
    this.publishBacklog();
  }

  private createState(
    key: object,
    message: AssistantMessage,
    target: TextTarget,
    present: Present,
    now: number,
  ): TypewriterState {
    const state: TypewriterState = {
      key,
      target: message,
      targetIndex: target.index,
      targetText: "",
      revealed: 0,
      lastFrameAt: now - this.config.frameMs,
      ended: false,
      present,
      lastRenderCostMs: 0,
    };
    this.states.set(key, state);
    this.active.add(state);
    this.metrics?.increment("cc-style.typewriter.streams");
    return state;
  }

  private ensureTimer(state: TypewriterState): void {
    if (state.timer || !this.active.has(state)) return;
    const frameMs = this.effectiveFrameMs(state);
    const elapsed = this.clock.now() - state.lastFrameAt;
    const delay = Math.max(0, frameMs - elapsed);
    state.timer = this.clock.setTimer(() => {
      state.timer = undefined;
      this.tick(state);
    }, delay);
  }

  private tick(state: TypewriterState): void {
    if (!this.active.has(state)) return;
    const backlog = this.backlog(state);
    if (backlog <= 0) {
      if (state.ended) this.emit(state, 0, false);
      return;
    }
    const now = this.clock.now();
    const frameMs = this.effectiveFrameMs(state);
    const batch = state.ended
      ? this.finalBatch(state, backlog, now, frameMs)
      : Math.min(
        this.config.maxCharsPerFrame,
        Math.max(
          this.config.minCharsPerFrame,
          Math.ceil(backlog * frameMs / this.config.targetLagMs),
        ),
      );
    this.emit(state, batch, !state.ended);
    if (this.active.has(state)) this.ensureTimer(state);
  }

  private finalBatch(
    state: TypewriterState,
    backlog: number,
    now: number,
    frameMs: number,
  ): number {
    const remainingMs = Math.max(0, (state.endDeadline ?? now) - now);
    if (remainingMs <= 0) {
      this.metrics?.increment("cc-style.typewriter.deadline-flushes");
      return backlog;
    }
    // Include the frame being rendered now as well as the ticks still fitting
    // before the deadline.
    const frames = Math.max(
      1,
      1 + Math.ceil(remainingMs / frameMs),
    );
    return Math.max(this.config.minCharsPerFrame, Math.ceil(backlog / frames));
  }

  private emit(
    state: TypewriterState,
    requestedChars: number,
    isStreaming: boolean,
  ): void {
    const before = state.revealed;
    state.revealed = safePrefixEnd(
      state.targetText,
      Math.min(state.targetText.length, state.revealed + requestedChars),
    );
    const completed = state.revealed >= state.targetText.length;
    const projected = completed
      ? state.target
      : projectText(state.target, state.targetIndex, state.targetText.slice(0, state.revealed));
    state.renderedMessage = projected;
    state.lastFrameAt = this.clock.now();

    const started = this.clock.now();
    state.present(projected, completed && state.ended ? false : isStreaming);
    state.lastRenderCostMs = Math.max(0, this.clock.now() - started);
    this.metrics?.record(
      "cc-style.typewriter.markdown-update",
      state.lastRenderCostMs,
      completed ? "complete" : "partial",
    );
    const batch = state.revealed - before;
    if (batch > 0) {
      this.metrics?.observe("cc-style.typewriter.batch", batch, "chars");
      this.metrics?.increment("cc-style.typewriter.rendered-chars", batch);
    }
    this.metrics?.increment("cc-style.typewriter.frames");
    this.metrics?.observe(
      "cc-style.typewriter.backlog",
      this.backlog(state),
      "chars",
    );

    if (completed && state.ended) this.drop(state);
    this.publishBacklog();
  }

  private backlog(state: TypewriterState): number {
    return Math.max(0, state.targetText.length - state.revealed);
  }

  private effectiveFrameMs(state: TypewriterState): number {
    if (!this.config.adaptive) return this.config.frameMs;
    const pressure = this.pressure?.();
    const cost = Math.max(
      state.lastRenderCostMs,
      pressure?.renderMs ?? 0,
      pressure?.eventLoopDelayMs ?? 0,
    );
    const ratio = cost / Math.max(1, this.config.renderBudgetMs);
    const frameMs = ratio <= 1
      ? this.config.frameMs
      : Math.min(
        Math.max(this.config.frameMs, this.config.maxFrameMs),
        Math.ceil(this.config.frameMs * Math.min(4, ratio)),
      );
    this.metrics?.observe("cc-style.typewriter.frame-delay", frameMs, "ms");
    this.metrics?.observe("cc-style.typewriter.render-pressure", cost, "ms");
    if (frameMs > this.config.frameMs) {
      this.metrics?.increment("cc-style.typewriter.adaptive-throttles");
    }
    return frameMs;
  }

  private drop(state: TypewriterState): void {
    if (state.timer) this.clock.clearTimer(state.timer);
    state.timer = undefined;
    this.states.delete(state.key);
    this.active.delete(state);
  }

  private publishBacklog(): void {
    let chars = 0;
    for (const state of this.active) chars += this.backlog(state);
    this.metrics?.gauge("cc-style.typewriter.backlog-current", chars, "chars");
    this.metrics?.gauge("cc-style.typewriter.active-streams", this.active.size, "streams");
  }
}

function trailingText(message: AssistantMessage): TextTarget | undefined {
  const index = message.content.length - 1;
  const content = message.content[index];
  return content?.type === "text" ? { index, text: content.text } : undefined;
}

function projectText(
  message: AssistantMessage,
  index: number,
  text: string,
): AssistantMessage {
  const content = [...message.content];
  const source = content[index];
  if (!source || source.type !== "text") return message;
  content[index] = { ...source, text };
  return { ...message, content };
}

/** Avoid ending a JavaScript slice between an emoji's surrogate pair. */
function safePrefixEnd(text: string, proposed: number): number {
  if (proposed <= 0 || proposed >= text.length) return proposed;
  const previous = text.charCodeAt(proposed - 1);
  const next = text.charCodeAt(proposed);
  return previous >= 0xd800 && previous <= 0xdbff &&
      next >= 0xdc00 && next <= 0xdfff
    ? proposed + 1
    : proposed;
}
