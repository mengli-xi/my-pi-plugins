import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { RuntimeSample } from "./history.ts";
import type { MemoryPoint } from "./runtime-metrics.ts";

export const LOOP_RESOLUTION_MS = 20;
export function excessLoopDelay(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? Math.max(0, nanoseconds / 1e6 - LOOP_RESOLUTION_MS) : 0;
}
export interface SessionSize { entries?: number; contextTokens?: number }
/** Both modes share one histogram, one memory read per tick and one timer.
 * Detailed UI bookkeeping consumes the same point, not another memory probe. */
export class LowFrequencySampler {
  error?: string;
  private histogram?: ReturnType<typeof monitorEventLoopDelay>;
  private timer?: NodeJS.Timeout;
  private cpu = process.cpuUsage();
  private at = performance.now();
  private detail?: { interval: number; record: (point: MemoryPoint) => void; at: number };
  private readonly record: (sample: RuntimeSample) => void;
  private readonly sessionSize: () => SessionSize;
  private readonly readMemory: () => MemoryPoint;
  readonly interval: number;
  constructor(record: (sample: RuntimeSample) => void, sessionSize: () => SessionSize, interval = 60_000,
    readMemory: () => MemoryPoint = () => ({ ...process.memoryUsage(), at: Date.now() })) {
    this.record = record; this.sessionSize = sessionSize; this.interval = interval; this.readMemory = readMemory;
  }
  start(): void {
    if (this.timer) return;
    this.cpu = process.cpuUsage(); this.at = performance.now();
    this.histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.histogram.enable(); this.arm();
  }
  setDetail(interval?: number, record?: (point: MemoryPoint) => void): void {
    this.detail = interval !== undefined && record ? { interval, record, at: performance.now() } : undefined;
    if (this.timer) { clearInterval(this.timer); this.arm(); }
  }
  private arm(): void {
    this.timer = setInterval(() => {
      try {
        const now = performance.now(), point = this.readMemory();
        if (now - this.at >= this.interval - 1) this.sample(point);
        if (this.detail && now - this.detail.at >= this.detail.interval - 1) {
          this.detail.at = now; this.detail.record(point);
        }
      } catch (error) { this.error = `sampling failed: ${error instanceof Error ? error.name : "unknown"}`; }
    }, Math.min(this.interval, this.detail?.interval ?? this.interval));
    this.timer.unref();
  }
  loopSnapshot(): { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number } {
    const delay = (p: number) => this.histogram?.count ? excessLoopDelay(this.histogram.percentile(p)) : 0;
    return { p50Ms: delay(50), p95Ms: delay(95), p99Ms: delay(99), maxMs: this.histogram?.count ? excessLoopDelay(this.histogram.max) : 0 };
  }
  resetLoop(): void { this.histogram?.reset(); }
  sample(point = this.readMemory()): RuntimeSample {
    const now = performance.now(), cpu = process.cpuUsage();
    let size: SessionSize = {};
    this.error = undefined;
    try { size = this.sessionSize(); } catch (error) {
      this.error = `session size unavailable: ${error instanceof Error ? error.name : "unknown"}`;
    }
    const loop = this.loopSnapshot();
    const sample: RuntimeSample = { rss: point.rss, heapUsed: point.heapUsed, heapTotal: point.heapTotal,
      external: point.external, cpuPercent: (cpu.user - this.cpu.user + cpu.system - this.cpu.system) / Math.max(1, now - this.at) / 10,
      loopP50Ms: loop.p50Ms, loopP99Ms: loop.p99Ms, loopMaxMs: loop.maxMs, ...size };
    this.cpu = cpu; this.at = now; this.resetLoop(); this.record(sample);
    return sample;
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.histogram?.disable(); this.histogram = undefined;
  }
}
