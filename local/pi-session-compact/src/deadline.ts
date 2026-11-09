import { readProviderActivityV1 } from "pi-runtime-contracts/provider-activity-v1";
export const TOTAL_DEADLINE_REASON = "compaction-total-deadline-exceeded";
export const DEFAULT_QUEUE_PAUSE_CAP_MINUTES = 30;
export interface QueueDiagnostic { kind: "generation-progress" | "queue-pause-cap"; atMs: number; queueKeys: string[] }
export interface DeadlineSnapshot {
  limitMinutes: number; limitMs: number; wallElapsedMs: number; activeElapsedMs: number; queuePausedMs: number;
  queuePauseCapMinutes: number; queuePauseCapMs: number; queueDiagnostics: QueueDiagnostic[];
  expired: boolean; reason?: string;
}
export interface DeadlineClock { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }
const CLOCK: DeadlineClock = { now: () => performance.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
interface Interval { start: number; end: number; provider: string }
interface ClosedQueue { interval: Interval; windowStart: number }
interface RequestWindow { requests: number; start: number; progressAt?: number; closedQueues: Map<string, ClosedQueue> }
interface OpenQueue { start: number; provider: string }

/** Queue ranges are unioned, never summed across sources/slots. The v1 channel has no
 * request ID, so overlapping requests of one provider share their first generation cutoff.
 * Events without a validated matching provider/session/live window cannot pause clocks.
 */
export class CompactionDeadline {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private clock: DeadlineClock;
  private sessionId: string;
  private minutes: number;
  private started: number;
  private ended?: number;
  private limit: number;
  private pauseCapMinutes: number;
  private pauseCap: number;
  private capReachedAt?: number;
  private capTimer: unknown;
  private unsubscribe: () => void;
  private listeners = new Set<() => void>();
  private stops = new Set<() => void>();
  private intervals: Interval[] = [];
  private queues = new Map<string, OpenQueue>();
  private windows = new Map<string, RequestWindow>();
  private diagnostics: QueueDiagnostic[] = [];

  constructor(options: { sessionId: string; minutes: number; queuePauseCapMinutes?: number; startedAt?: number; subscribe: (handle: (event: unknown) => void) => () => void; clock?: DeadlineClock }) {
    this.clock = options.clock ?? CLOCK;
    this.sessionId = options.sessionId;
    this.minutes = options.minutes;
    this.started = options.startedAt ?? this.clock.now();
    this.limit = options.minutes === 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, options.minutes * 60000);
    this.pauseCapMinutes = options.queuePauseCapMinutes ?? DEFAULT_QUEUE_PAUSE_CAP_MINUTES;
    this.pauseCap = Math.min(Number.MAX_SAFE_INTEGER, this.pauseCapMinutes * 60000);
    this.signal = this.controller.signal;
    this.unsubscribe = options.subscribe(event => this.handle(event));
    if (this.limit) this.timer(this.limit, this.started, true, () => this.expireTotal());
  }
  private now() { return this.ended ?? this.clock.now(); }
  /** Allocate the operation's allowance over the global union first, then intersect a
   * single attempt with only its provider's ranges. Other providers cannot stop its clock. */
  private excluded(start: number, end: number, provider?: string): number {
    const ranges = [...this.intervals, ...[...this.queues.values()].map(queue => ({ ...queue, end: this.now() }))].sort((a, b) => a.start - b.start);
    const allowed: { start: number; end: number }[] = [];
    let last = this.started, allowance = this.pauseCap;
    for (const range of ranges) {
      const from = Math.max(this.started, last, range.start), to = Math.min(this.now(), range.end);
      if (to <= from) continue;
      const allowedEnd = from + Math.min(allowance, to - from);
      allowed.push({ start: from, end: allowedEnd });
      allowance -= allowedEnd - from; last = to;
      if (allowance <= 0) break;
    }
    if (provider === undefined) return allowed.reduce((sum, range) => sum + Math.max(0, Math.min(end, range.end) - Math.max(start, range.start)), 0);
    let sum = 0, providerEnd = start;
    for (const range of ranges) {
      if (range.provider !== provider) continue;
      const from = Math.max(start, providerEnd, range.start), to = Math.min(end, range.end);
      if (to <= from) continue;
      for (const cap of allowed) sum += Math.max(0, Math.min(to, cap.end) - Math.max(from, cap.start));
      providerEnd = to;
    }
    return sum;
  }
  private elapsed(start: number, pause: true | string, cutoff?: number) {
    const now = this.now();
    return Math.max(0, now - start - this.excluded(start, Math.min(now, cutoff ?? now), pause === true ? undefined : pause));
  }
  snapshot(): DeadlineSnapshot {
    const wallElapsedMs = Math.max(0, this.now() - this.started), queuePausedMs = this.excluded(this.started, this.now());
    return { limitMinutes: this.minutes, limitMs: this.limit, wallElapsedMs, activeElapsedMs: Math.max(0, wallElapsedMs - queuePausedMs), queuePausedMs,
      queuePauseCapMinutes: this.pauseCapMinutes, queuePauseCapMs: this.pauseCap, queueDiagnostics: this.diagnostics.map(d => ({ ...d, queueKeys: [...d.queueKeys] })),
      expired: this.signal.aborted, ...(this.signal.aborted ? { reason: TOTAL_DEADLINE_REASON } : {}) };
  }
  private expireTotal() { this.controller.abort(new Error(TOTAL_DEADLINE_REASON)); this.finish(); }
  throwIfExpired() {
    if (this.limit && this.remainingMs() <= 0 && !this.signal.aborted) this.expireTotal();
    this.signal.throwIfAborted();
  }
  remainingMs(): number { return this.limit ? Math.max(0, this.limit - this.elapsed(this.started, true)) : Infinity; }
  private changed() {
    this.refreshPauseCap();
    for (const listener of [...this.listeners]) listener();
  }
  /** This watchdog is wall-time based and remains armed while the normal clocks are paused. */
  private refreshPauseCap() {
    if (this.capTimer !== undefined) this.clock.clearTimeout(this.capTimer);
    this.capTimer = undefined;
    if (this.ended !== undefined || this.capReachedAt !== undefined) return;
    const remaining = this.pauseCap - this.excluded(this.started, this.now());
    if (remaining <= 0.000001) {
      this.capReachedAt = this.now();
      this.diagnostics.push({ kind: "queue-pause-cap", atMs: this.capReachedAt - this.started, queueKeys: [...this.queues.keys()] });
      for (const provider of this.windows.keys()) this.closeQueues(provider, this.capReachedAt);
    } else if (this.queues.size) {
      this.capTimer = this.clock.setTimeout(() => this.changed(), Math.min(remaining, 2147483647));
    }
  }
  private timer(limit: number, start: number, pause: true | string, expire: () => void, cutoff?: () => number | undefined) {
    let handle: unknown, stopped = false;
    const stop = () => {
      stopped = true;
      if (handle !== undefined) this.clock.clearTimeout(handle);
      this.listeners.delete(rearm); this.stops.delete(stop);
    };
    const rearm = () => {
      if (handle !== undefined) this.clock.clearTimeout(handle);
      if (stopped || this.ended !== undefined) return;
      const remaining = limit - this.elapsed(start, pause, cutoff?.());
      if (remaining <= 0) { stop(); expire(); }
      else if (cutoff?.() !== undefined || ![...this.queues.values()].some(queue => pause === true || queue.provider === pause)) handle = this.clock.setTimeout(rearm, Math.min(remaining, 2147483647));
    };
    this.listeners.add(rearm); this.stops.add(stop); rearm();
    return stop;
  }
  /** Retries/backoff never inherit open queues from an earlier live-request window. */
  attempt(provider: string, limitMs: number, expire: () => void) {
    this.throwIfExpired();
    if (this.ended !== undefined) throw new Error("compaction-deadline-scope-finished");
    const start = this.now();
    let window = this.windows.get(provider);
    if (!window) { window = { requests: 0, start, closedQueues: new Map() }; this.windows.set(provider, window); }
    window.requests++;
    const currentWindow = window;
    let stopped = false, progressAt: number | undefined;
    const stopTimer = this.timer(limitMs, start, provider, expire, () => progressAt);
    return {
      snapshot: () => ({ activeElapsedMs: this.elapsed(start, provider, progressAt), queueMs: this.excluded(start, Math.min(this.now(), progressAt ?? this.now()), provider) }),
      progress: () => {
        if (stopped || this.ended !== undefined || progressAt !== undefined) return;
        progressAt = this.now();
        if (currentWindow.progressAt === undefined) {
          currentWindow.progressAt = progressAt;
          const keys = [...this.queues].filter(([, queue]) => queue.provider === provider).map(([key]) => key);
          if (keys.length) this.diagnostics.push({ kind: "generation-progress", atMs: progressAt - this.started, queueKeys: keys });
          this.closeQueues(provider, progressAt);
        }
        this.changed();
      },
      stop: () => {
        if (stopped) return;
        stopped = true; stopTimer();
        if (--currentWindow.requests === 0 && this.ended === undefined) {
          this.closeQueues(provider, this.now()); this.windows.delete(provider); this.changed();
        }
      },
    };
  }
  private closeQueues(provider: string, end: number) {
    const window = this.windows.get(provider)!;
    for (const [key, queue] of this.queues) {
      if (queue.provider !== provider) continue;
      window.closedQueues.set(key, { interval: this.addInterval(provider, queue.start, end), windowStart: window.start });
      this.queues.delete(key);
    }
  }
  /** Keep interval identity so a delayed queuedMs can shorten an already closed span. */
  private addInterval(provider: string, start: number, end: number): Interval {
    const interval = { provider, start, end };
    this.intervals.push(interval);
    return interval;
  }
  private handle(payload: unknown) {
    if (this.ended !== undefined) return;
    const activity = readProviderActivityV1(payload);
    if (!activity || activity.sessionId !== this.sessionId || activity.kind !== "lifecycle") return;
    const window = this.windows.get(activity.provider), event = activity.event!;
    if (!window || (event.type !== "queue.enter" && event.type !== "queue.update" && event.type !== "queue.leave")) return;
    const provider = activity.provider, key = JSON.stringify([provider, event.source, event.attempt ?? 0]), now = this.now();
    const cutoff = Math.min(window.progressAt ?? Infinity, this.capReachedAt ?? Infinity);
    if (cutoff !== Infinity) {
      // Late observations can correct the confirmed past, never reopen a pause after generation/cap.
      if (event.queuedMs !== undefined) {
        const closed = window.closedQueues.get(key);
        const end = Math.min(cutoff, closed?.interval.end ?? cutoff);
        const start = Math.max(closed?.windowStart ?? window.start, end - event.queuedMs);
        if (closed) { closed.interval.start = start; closed.interval.end = end; }
        else window.closedQueues.set(key, { interval: this.addInterval(provider, start, end), windowStart: window.start });
      }
    } else {
      const start = event.queuedMs === undefined ? this.queues.get(key)?.start ?? now : Math.max(window.start, now - event.queuedMs);
      if (event.type === "queue.leave") {
        if (this.queues.has(key) || event.queuedMs !== undefined) window.closedQueues.set(key, { interval: this.addInterval(provider, start, now), windowStart: window.start });
        this.queues.delete(key);
      } else { window.closedQueues.delete(key); this.queues.set(key, { provider, start }); }
    }
    this.changed();
  }
  finish() {
    if (this.ended !== undefined) return;
    this.ended = this.clock.now();
    if (this.capTimer !== undefined) this.clock.clearTimeout(this.capTimer);
    for (const stop of [...this.stops]) stop();
    this.unsubscribe();
  }
}
