/**
 * The timing model: everything is a span, and spans are summarised as they are
 * recorded rather than kept.
 *
 * A session that runs all day would otherwise accumulate one sample per event,
 * and the thing anyone actually asks — "is sending a message slower than it
 * used to be" — is answered by a distribution, not by the samples. Percentiles
 * need the samples though, so a bounded ring of the most recent ones is kept
 * per span and everything older survives only in the running aggregate.
 */

/** Samples kept per span for percentiles; older ones live on in count/total/max. */
const WINDOW = 200;

export interface SpanStats {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
}

export class SpanRecorder {
  private readonly recent = new Map<string, number[]>();
  private readonly totals = new Map<string, { count: number; total: number; max: number; last: number }>();
  private readonly open = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Start (or restart) a span. Restarting discards the earlier start. */
  begin(name: string): void {
    this.open.set(name, this.now());
  }

  /**
   * Close a span and record it. Returns the duration, or undefined when the
   * span was never opened — a turn that began before this extension loaded, or
   * an event pi emitted out of the order we expected.
   */
  end(name: string): number | undefined {
    const started = this.open.get(name);
    if (started === undefined) return undefined;
    this.open.delete(name);
    const ms = Math.max(0, this.now() - started);
    this.record(name, ms);
    return ms;
  }

  /** Record a duration measured elsewhere. */
  record(name: string, ms: number): void {
    const samples = this.recent.get(name) ?? [];
    samples.push(ms);
    if (samples.length > WINDOW) samples.shift();
    this.recent.set(name, samples);

    const total = this.totals.get(name) ?? { count: 0, total: 0, max: 0, last: 0 };
    total.count += 1;
    total.total += ms;
    total.max = Math.max(total.max, ms);
    total.last = ms;
    this.totals.set(name, total);
  }

  /** True while a span is open — used to tell a fresh turn from a resumed one. */
  isOpen(name: string): boolean {
    return this.open.has(name);
  }

  stats(): SpanStats[] {
    const rows: SpanStats[] = [];
    for (const [name, total] of this.totals) {
      const samples = [...(this.recent.get(name) ?? [])].sort((a, b) => a - b);
      rows.push({
        name,
        count: total.count,
        totalMs: total.total,
        maxMs: total.max,
        lastMs: total.last,
        p50Ms: percentile(samples, 50),
        p95Ms: percentile(samples, 95),
      });
    }
    return rows.sort((left, right) => right.totalMs - left.totalMs);
  }

  reset(): void {
    this.recent.clear();
    this.totals.clear();
    this.open.clear();
  }
}

/** Nearest-rank percentile: with few samples it names a real one, not a blend. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}
