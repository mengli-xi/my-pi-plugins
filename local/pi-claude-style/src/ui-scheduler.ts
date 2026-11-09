import { performance } from "node:perf_hooks";

export interface SchedulerObservability {
  record(name: string, ms: number, detail?: string): void;
  observe(name: string, value: number, unit: string): void;
  gauge(name: string, value: number, unit: string): void;
  increment(name: string, delta?: number): void;
}

export interface SchedulerNativeClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: SchedulerNativeClock = {
  now: () => performance.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};

interface ScheduledTask {
  token: object;
  dueAt: number;
  callback: () => void;
}

/**
 * One runtime-owned timer queue for visual work. It wakes once for all tasks
 * due in the same small frame window, so working, goal and typewriter updates
 * request one coalescible TUI frame instead of racing independent intervals.
 */
export class UiScheduler {
  private readonly tasks = new Map<object, ScheduledTask>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private disposed = false;
  private readonly observability: SchedulerObservability | undefined;
  private readonly clock: SchedulerNativeClock;
  private readonly coalesceWindowMs: number;

  constructor(
    observability?: SchedulerObservability,
    clock: SchedulerNativeClock = SYSTEM_CLOCK,
    coalesceWindowMs = 4,
  ) {
    this.observability = observability;
    this.clock = clock;
    this.coalesceWindowMs = coalesceWindowMs;
  }

  now(): number {
    return this.clock.now();
  }

  setTimer(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    const token = {};
    if (this.disposed) return token as ReturnType<typeof setTimeout>;
    this.tasks.set(token, {
      token,
      dueAt: this.now() + Math.max(0, delayMs),
      callback,
    });
    this.observability?.increment("cc-style.scheduler.scheduled");
    this.publishDepth();
    if (!this.flushing) this.arm();
    return token as ReturnType<typeof setTimeout>;
  }

  clearTimer(handle: ReturnType<typeof setTimeout>): void {
    if (!this.tasks.delete(handle as unknown as object)) return;
    this.observability?.increment("cc-style.scheduler.cancelled");
    this.publishDepth();
    if (!this.flushing) this.arm();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.tasks.clear();
    this.publishDepth();
  }

  private arm(): void {
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    if (this.disposed || this.tasks.size === 0) return;
    const next = Math.min(...[...this.tasks.values()].map(({ dueAt }) => dueAt));
    this.timer = this.clock.setTimer(
      () => {
        this.timer = undefined;
        this.flush();
      },
      Math.max(0, next - this.now()),
    );
  }

  private flush(): void {
    if (this.disposed || this.flushing) return;
    this.flushing = true;
    const started = this.now();
    const due = [...this.tasks.values()]
      .filter(({ dueAt }) => dueAt <= started + this.coalesceWindowMs)
      .sort((left, right) => left.dueAt - right.dueAt);
    for (const task of due) this.tasks.delete(task.token);
    this.observability?.increment("cc-style.scheduler.wakeups");
    this.observability?.observe("cc-style.scheduler.batch", due.length, "tasks");
    if (due.length > 1) {
      this.observability?.increment("cc-style.scheduler.coalesced", due.length - 1);
    }
    for (const task of due) {
      this.observability?.observe(
        "cc-style.scheduler.lateness",
        Math.max(0, started - task.dueAt),
        "ms",
      );
      const callbackStarted = this.now();
      try {
        task.callback();
      } catch {
        this.observability?.increment("cc-style.scheduler.callback-errors");
      } finally {
        this.observability?.record(
          "cc-style.scheduler.callback",
          this.now() - callbackStarted,
        );
      }
    }
    this.observability?.record("cc-style.scheduler.flush", this.now() - started);
    this.flushing = false;
    this.publishDepth();
    this.arm();
  }

  private publishDepth(): void {
    this.observability?.gauge("cc-style.scheduler.queue-depth", this.tasks.size, "tasks");
  }
}
