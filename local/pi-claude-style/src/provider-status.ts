import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  readProviderActivityV1,
  type ProviderLoadV1,
} from "pi-runtime-contracts/provider-activity-v1";
import { paintWorkingStatusValue } from "./cyber-style.ts";
import { formatDuration } from "./format.ts";

export interface ProviderStatusSnapshot {
  enabled: boolean;
  load?: ProviderLoadV1;
  queueActive: boolean;
  localPosition?: number;
  upstreamPosition?: number;
  queueMs: number;
  retryAttempt?: number;
}

interface ProviderQueue {
  source: "local" | "upstream";
  position?: number;
  startedAt: number;
  timing?: { queuedMs: number; receivedAt: number };
}

function queueStart(queue: ProviderQueue): number {
  return queue.timing
    ? queue.timing.receivedAt - queue.timing.queuedMs
    : queue.startedAt;
}

interface StatusClock {
  now(): number;
}

const DEFAULT_CLOCK: StatusClock = { now: Date.now };

export class ProviderStatusTracker {
  private readonly clock: StatusClock;
  private provider: string | undefined;
  private sessionId: string | undefined;
  private load: ProviderLoadV1 | undefined;
  private retryAttempt: number | undefined;
  private queueMs = 0;
  private queueStartedAt: number | undefined;
  private readonly openQueues = new Map<string, ProviderQueue>();

  constructor(clock: StatusClock = DEFAULT_CLOCK) {
    this.clock = clock;
  }

  start(provider: string | undefined, sessionId: string | undefined): void {
    this.reset();
    if (!provider || !sessionId) return;
    this.provider = provider;
    this.sessionId = sessionId;
  }

  reset(): void {
    this.provider = undefined;
    this.sessionId = undefined;
    this.load = undefined;
    this.retryAttempt = undefined;
    this.queueMs = 0;
    this.queueStartedAt = undefined;
    this.openQueues.clear();
  }

  handle(raw: unknown): void {
    const payload = readProviderActivityV1(raw);
    if (!this.provider || !payload || payload.provider !== this.provider ||
      payload.sessionId !== this.sessionId) return;
    const now = this.clock.now();
    if (payload.kind === "turn.end") {
      this.closeAll(now);
      this.retryAttempt = undefined;
      return;
    }
    const event = payload.event;
    if (!event) return;
    if (event.load) this.load = { ...event.load };
    if (event.type === "attempt.start") {
      this.retryAttempt = event.attempt !== undefined && event.attempt > 1
        ? event.attempt
        : undefined;
      return;
    }
    const source = event.source;
    if (!source) return;
    const attempt = event.attempt ?? 0;
    const key = `${source}:${attempt}`;
    const queuedMs = event.queuedMs;
    const queue = this.openQueues.get(key);
    if (event.type === "queue.enter" || event.type === "queue.update") {
      this.openQueues.set(key, {
        source,
        position: event.position && event.position > 0 ? event.position : undefined,
        startedAt: event.queueEnteredAt === undefined
          ? queue?.startedAt ?? now
          : Math.min(now, event.queueEnteredAt),
        timing: queuedMs === undefined
          ? queue?.timing
          : { queuedMs, receivedAt: now },
      });
      return;
    }
    if (event.type === "queue.leave") {
      if (queue) {
        if (queuedMs !== undefined) queue.timing = { queuedMs, receivedAt: now };
        else if (event.queueEnteredAt !== undefined && !queue.timing) {
          queue.startedAt = Math.min(now, event.queueEnteredAt);
        }
        this.queueStartedAt = Math.min(this.queueStartedAt ?? Infinity, queueStart(queue));
        this.openQueues.delete(key);
      }
      if (this.openQueues.size === 0) this.closeInterval(now);
    }
  }

  snapshot(): ProviderStatusSnapshot {
    const startedAt = this.intervalStart();
    const openMs = startedAt === undefined
      ? 0
      : Math.max(0, this.clock.now() - startedAt);
    let localPosition: number | undefined;
    let upstreamPosition: number | undefined;
    for (const queue of this.openQueues.values()) {
      if (queue.source === "local") localPosition = queue.position;
      else upstreamPosition = queue.position;
    }
    return {
      enabled: this.provider !== undefined,
      load: this.load,
      queueActive: this.openQueues.size > 0,
      localPosition,
      upstreamPosition,
      queueMs: this.queueMs + openMs,
      retryAttempt: this.retryAttempt,
    };
  }

  private intervalStart(): number | undefined {
    let startedAt = this.queueStartedAt;
    for (const queue of this.openQueues.values()) {
      startedAt = Math.min(startedAt ?? Infinity, queueStart(queue));
    }
    return startedAt;
  }

  private closeAll(now: number): void {
    this.queueStartedAt = this.intervalStart();
    this.openQueues.clear();
    this.closeInterval(now);
  }

  private closeInterval(now: number): void {
    if (this.queueStartedAt === undefined) return;
    this.queueMs += Math.max(0, now - this.queueStartedAt);
    this.queueStartedAt = undefined;
  }
}

export function formatProviderStatus(
  snapshot: ProviderStatusSnapshot,
  theme?: Pick<Theme, "fg">,
): string {
  if (!snapshot.enabled) return "";
  const muted = (text: string) => theme?.fg("muted", text) ?? text;
  const value = (text: string) => theme
    ? paintWorkingStatusValue(text, "provider")
    : text;
  const parts: string[] = [];
  if (snapshot.load) {
    const capacity = snapshot.load.maxActive === undefined
      ? String(snapshot.load.active)
      : `${snapshot.load.active}/${snapshot.load.maxActive}`;
    parts.push(`${muted("G ")}${value(capacity)}`);
    if (snapshot.load.backgroundActive > 0) {
      parts.push(`${muted("BG ")}${value(String(snapshot.load.backgroundActive))}`);
    }
  }
  if (snapshot.retryAttempt !== undefined) {
    parts.push(`${muted("Retry ")}${value(String(snapshot.retryAttempt))}`);
  }
  if (snapshot.queueActive) {
    let queuePart = muted("Queue");
    if (snapshot.localPosition !== undefined) {
      queuePart += value(`#${snapshot.localPosition}`);
    }
    if (snapshot.upstreamPosition !== undefined) {
      queuePart += `${muted(" ")}${value(`#${snapshot.upstreamPosition}`)}`;
    }
    parts.push(
      `${queuePart}${muted(" ")}${value(formatDuration(snapshot.queueMs))}`,
    );
  }
  return parts.length > 0
    ? `${muted("[")}${parts.join(muted(" · "))}${muted("]")}`
    : "";
}

export function providerActiveElapsedMs(
  elapsedMs: number,
  snapshot: ProviderStatusSnapshot,
): number {
  if (!snapshot.enabled) return elapsedMs;
  return Math.max(0, elapsedMs - snapshot.queueMs);
}
