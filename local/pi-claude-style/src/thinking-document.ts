import type { LiveTextPanelSnapshot, LiveTextSource } from "./openers.ts";
import type { TypewriterClock } from "./streaming-typewriter.ts";

const DEFAULT_CLOCK: TypewriterClock = {
  now: Date.now,
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};

export function formatThinkingElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** One reasoning document shared by chat projection and every open panel. */
export class ThinkingDocument implements LiveTextSource {
  private body: string;
  private readonly clock: TypewriterClock;
  private readonly listeners = new Set<(body: string) => void>();
  private readonly panelListeners = new Set<(snapshot: LiveTextPanelSnapshot) => void>();
  private startedAt: number | undefined;
  private endedAt: number | undefined;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(body: string, clock: TypewriterClock = DEFAULT_CLOCK) {
    this.body = body;
    this.clock = clock;
  }

  snapshot(): string {
    return this.body;
  }

  panelSnapshot(): LiveTextPanelSnapshot {
    return {
      body: this.body,
      note: this.startedAt === undefined
        ? undefined
        : formatThinkingElapsed((this.endedAt ?? this.clock.now()) - this.startedAt),
    };
  }

  update(body: string): void {
    if (body === this.body) return;
    this.body = body;
    for (const listener of [...this.listeners]) {
      try {
        listener(body);
      } catch {
        // A stale panel is observational and cannot interrupt message deltas.
      }
    }
    this.notifyPanels();
  }

  updateTiming(startedAt: number | undefined, endedAt: number | undefined, active: boolean): void {
    const changed = this.startedAt !== startedAt || this.endedAt !== endedAt || this.active !== active;
    this.startedAt = startedAt;
    this.endedAt = endedAt;
    this.active = active;
    this.syncTimer();
    if (changed) this.notifyPanels();
  }

  subscribe(listener: (body: string) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.body);
    } catch {
      // The caller still receives a disposer for a panel that failed to paint.
    }
    return () => this.listeners.delete(listener);
  }

  subscribePanel(listener: (snapshot: LiveTextPanelSnapshot) => void): () => void {
    this.panelListeners.add(listener);
    try {
      listener(this.panelSnapshot());
    } catch {
      // A stale panel is observational and cannot interrupt message deltas.
    }
    this.syncTimer();
    return () => {
      this.panelListeners.delete(listener);
      this.syncTimer();
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.panelListeners.clear();
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private notifyPanels(): void {
    const snapshot = this.panelSnapshot();
    for (const listener of [...this.panelListeners]) {
      try {
        listener(snapshot);
      } catch {
        // A stale panel is observational and cannot interrupt message deltas.
      }
    }
  }

  private syncTimer(): void {
    if (!this.active || this.startedAt === undefined || this.panelListeners.size === 0) {
      if (this.timer !== undefined) this.clock.clearTimer(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined;
      this.notifyPanels();
      this.syncTimer();
    }, 1_000);
  }
}
