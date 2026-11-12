export function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  return { n: values.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1], mean,
    variance: values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length,
    min: sorted[0], max: sorted.at(-1) };
}
