/** Mergeable, bounded log histogram. Quantiles use geometric bucket midpoints:
 * <=2.5% relative error in 0.001..LIMIT, absolute <=0.001 below that range.
 * count/sum/min/max are exact; overflow quantiles are explicitly saturated. */
export const BUCKET_RATIO = 1.05;
export const BUCKET_COUNT = 1026;
export const BUCKET_MIN = .001;
export const BUCKET_LIMIT = BUCKET_MIN * BUCKET_RATIO ** (BUCKET_COUNT - 2);
export interface Histogram { count: number; sum: number; min: number; max: number; bins: Record<string, number> }
export interface Distribution { count: number; p50: number; p95: number; max: number; mean: number }
export function emptyHistogram(): Histogram { return { count: 0, sum: 0, min: 0, max: 0, bins: {} }; }
export function addValue(histogram: Histogram, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  const bucket = value < BUCKET_MIN ? 0 : Math.min(BUCKET_COUNT - 1,
    1 + Math.floor(Math.log(value / BUCKET_MIN) / Math.log(BUCKET_RATIO)));
  histogram.bins[bucket] = (histogram.bins[bucket] ?? 0) + 1;
  histogram.min = histogram.count ? Math.min(histogram.min, value) : value;
  histogram.max = Math.max(histogram.max, value);
  histogram.count++; histogram.sum += value;
}
export function mergeHistogram(target: Histogram, source: Histogram): void {
  if (!source.count) return;
  target.min = target.count ? Math.min(target.min, source.min) : source.min;
  target.count += source.count; target.sum += source.sum; target.max = Math.max(target.max, source.max);
  for (const [bucket, count] of Object.entries(source.bins)) target.bins[bucket] = (target.bins[bucket] ?? 0) + count;
}
export function histogramDistribution(histogram: Histogram): Distribution {
  const bins = Object.entries(histogram.bins).map(([bucket, count]) => [Number(bucket), count]).sort((a, b) => a[0] - b[0]);
  const quantile = (p: number) => {
    if (!histogram.count) return 0;
    let count = 0;
    for (const [bucket, n] of bins) {
      count += n;
      if (count >= Math.ceil(histogram.count * p)) {
        const midpoint = bucket === 0 ? 0 : BUCKET_MIN * BUCKET_RATIO ** (bucket - .5);
        return Math.max(histogram.min, Math.min(histogram.max, midpoint));
      }
    }
    throw new Error("invalid histogram counts");
  };
  return { count: histogram.count, p50: quantile(.5), p95: quantile(.95), max: histogram.max,
    mean: histogram.count ? histogram.sum / histogram.count : 0 };
}
export function parseHistogram(value: unknown): Histogram {
  const h = value as Histogram;
  if (!h || !Number.isSafeInteger(h.count) || h.count < 0 || !Number.isFinite(h.sum) || h.sum < 0 ||
    !Number.isFinite(h.min) || h.min < 0 || !Number.isFinite(h.max) || h.max < h.min ||
    !h.bins || typeof h.bins !== "object" || Array.isArray(h.bins) ||
    Object.keys(h.bins).length > BUCKET_COUNT) throw new Error("invalid histogram");
  let total = 0;
  for (const [bucket, count] of Object.entries(h.bins)) {
    if (!/^\d+$/.test(bucket) || String(Number(bucket)) !== bucket || Number(bucket) >= BUCKET_COUNT || !Number.isSafeInteger(count) || count < 1) throw new Error("invalid bucket");
    total += count;
  }
  if (total !== h.count || (h.count === 0 && (h.min !== 0 || h.max !== 0 || h.sum !== 0))) throw new Error("invalid histogram counts");
  return h;
}
