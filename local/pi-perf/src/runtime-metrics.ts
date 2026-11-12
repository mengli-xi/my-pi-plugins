export interface MemoryPoint {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface MemorySummary {
  start: MemoryPoint;
  current: MemoryPoint;
  peak: MemoryPoint;
}

function point(usage: NodeJS.MemoryUsage, at: number): MemoryPoint {
  return {
    at,
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

export class MemoryTracker {
  private startPoint: MemoryPoint;
  private currentPoint: MemoryPoint;
  private peakPoint: MemoryPoint;
  private readonly read: () => NodeJS.MemoryUsage;
  private readonly now: () => number;

  constructor(read: () => NodeJS.MemoryUsage = () => process.memoryUsage(), now: () => number = () => Date.now()) {
    this.read = read;
    this.now = now;
    const initial = point(this.read(), this.now());
    this.startPoint = initial;
    this.currentPoint = initial;
    this.peakPoint = initial;
  }

  sample(): MemoryPoint {
    const next = point(this.read(), this.now());
    this.currentPoint = next;
    this.peakPoint = {
      at: next.rss >= this.peakPoint.rss ? next.at : this.peakPoint.at,
      rss: Math.max(this.peakPoint.rss, next.rss),
      heapUsed: Math.max(this.peakPoint.heapUsed, next.heapUsed),
      heapTotal: Math.max(this.peakPoint.heapTotal, next.heapTotal),
      external: Math.max(this.peakPoint.external, next.external),
      arrayBuffers: Math.max(this.peakPoint.arrayBuffers, next.arrayBuffers),
    };
    return next;
  }

  summary(): MemorySummary {
    this.sample();
    return this.snapshot();
  }

  snapshot(): MemorySummary {
    return { start: this.startPoint, current: this.currentPoint, peak: this.peakPoint };
  }

  reset(): void {
    const next = point(this.read(), this.now());
    this.startPoint = next;
    this.currentPoint = next;
    this.peakPoint = next;
  }
}

export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  const absolute = Math.abs(bytes);
  if (absolute < 1024) return `${sign}${absolute}B`;
  if (absolute < 1024 ** 2) return `${sign}${(absolute / 1024).toFixed(1)}KB`;
  if (absolute < 1024 ** 3) return `${sign}${(absolute / 1024 ** 2).toFixed(1)}MB`;
  return `${sign}${(absolute / 1024 ** 3).toFixed(2)}GB`;
}

export function formatDelta(bytes: number): string {
  return `${bytes >= 0 ? "+" : ""}${formatBytes(bytes)}`;
}
