import type { CapacityBalance, CapacityWindow, ModelCapacitySnapshotV2, ProviderCapacitySnapshot } from "./src/contracts.ts";

/** Legacy-compatible one-line Codex burn sample. */
export interface UsageSample {
  ts: number;
  usedPercent: number;
  resetAt: number | null;
  windowSeconds: number | null;
  planType: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  maxContextTokens: number;
  requests: number;
}

export const LARGE_CONTEXT_TOKENS = 272_000;

export interface BurnBucket {
  deltaPercent: number;
  inputTokens: number;
  cacheReadTokens: number;
  requests: number;
  intervals: number;
}

export interface BurnStats {
  last24hPercent: number;
  last7dPercent: number;
  small: BurnBucket;
  large: BurnBucket;
  samples: number;
}

const emptyBucket = (): BurnBucket => ({
  deltaPercent: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  requests: 0,
  intervals: 0,
});

export function computeBurn(samples: UsageSample[], nowSec: number): BurnStats {
  const stats: BurnStats = {
    last24hPercent: 0,
    last7dPercent: 0,
    small: emptyBucket(),
    large: emptyBucket(),
    samples: samples.length,
  };
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const sameWindow = previous.windowSeconds === current.windowSeconds;
    const delta = current.usedPercent - previous.usedPercent;
    if (!sameWindow || delta < 0) continue;
    if (current.ts >= nowSec - 86_400) stats.last24hPercent += delta;
    if (current.ts >= nowSec - 7 * 86_400) stats.last7dPercent += delta;
    const bucket = current.maxContextTokens > LARGE_CONTEXT_TOKENS ? stats.large : stats.small;
    bucket.deltaPercent += delta;
    bucket.inputTokens += current.inputTokens;
    bucket.cacheReadTokens += current.cacheReadTokens;
    bucket.requests += current.requests;
    bucket.intervals += 1;
  }
  return stats;
}

export function percentPerMTok(bucket: BurnBucket): number | undefined {
  if (bucket.inputTokens <= 0 || bucket.deltaPercent <= 0) return undefined;
  return bucket.deltaPercent / bucket.inputTokens * 1_000_000;
}

export function parseJsonl(text: string): UsageSample[] {
  const samples: UsageSample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as UsageSample;
      if (typeof parsed.ts === "number" && typeof parsed.usedPercent === "number") samples.push(parsed);
    } catch {
      // A torn append does not invalidate older or later samples.
    }
  }
  return samples;
}

export function codexHistoryWindow(snapshot: ProviderCapacitySnapshot): CapacityWindow | undefined {
  const base = (snapshot.windows ?? []).filter((window) => !window.label);
  return base.find((window) => window.kind === "seven_day")
    ?? base.find((window) => window.kind === "five_hour")
    ?? base[0];
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatCapacityReport(
  snapshot: ModelCapacitySnapshotV2,
  burn: BurnStats,
  nowSec: number,
): string {
  const lines: string[] = [];
  for (const provider of snapshot.providers) {
    lines.push(formatProvider(provider, nowSec));
  }
  const codex = snapshot.providers.find((provider) => provider.provider === "openai-codex");
  if (codex?.state === "ready" || codex?.state === "stale") {
    if (burn.samples < 2) {
      lines.push("  Codex burn: no history yet");
    } else {
      lines.push(`  Codex burn: ${burn.last24hPercent}% in 24h · ${burn.last7dPercent}% in 7d`);
      const small = percentPerMTok(burn.small);
      const large = percentPerMTok(burn.large);
      lines.push(`    ≤272k: ${formatEfficiency(small, burn.small)}`);
      lines.push(`    >272k: ${formatEfficiency(large, burn.large)}`);
      if (small !== undefined && large !== undefined) {
        lines.push(`    large-context ratio: ${(large / small).toFixed(2)}×`);
      }
    }
  }
  return lines.join("\n");
}

function formatProvider(provider: ProviderCapacitySnapshot, nowSec: number): string {
  const name = provider.provider;
  const suffix = provider.state === "stale" ? " (stale)" : "";
  if (provider.state === "unavailable") return `${name}: unavailable`;
  if (provider.state === "error") return `${name}: ${provider.error ?? "error"}`;
  if (provider.state === "refreshing" && provider.observedAt === undefined) return `${name}: refreshing…`;
  const parts: string[] = [];
  if (provider.gateway) {
    parts.push(`gateway ${provider.gateway.active}/${provider.gateway.maxActive ?? "?"}`);
    if (provider.gateway.queued > 0) parts.push(`queue ${provider.gateway.queued}`);
  }
  const models = Object.values(provider.models ?? {});
  const loaded = models.filter((model) => model.loadPercent !== undefined).length;
  const quotaModels = models.filter((model) => model.quota !== undefined).length;
  if (loaded > 0) parts.push(`${loaded} model loads`);
  if (quotaModels > 0) parts.push(`${quotaModels} model quotas`);
  for (const balance of provider.balances ?? []) {
    parts.push(formatBalance(balance));
  }
  for (const window of provider.windows ?? []) {
    const label = window.label ?? windowLabel(window);
    const reset = window.resetsAt ? ` · resets ${formatDuration(window.resetsAt - nowSec)}` : "";
    parts.push(`${label} ${formatPercent(window.remainingPercent)} left${reset}`);
  }
  if (provider.plan) parts.unshift(provider.plan);
  if (parts.length === 0) parts.push(provider.state);
  return `${name}${suffix}: ${parts.join(" · ")}`;
}

function windowLabel(window: CapacityWindow): string {
  if (window.kind === "five_hour") return "5h";
  if (window.kind === "seven_day") return "7d";
  if (window.kind === "weekly") return "weekly";
  return window.windowSeconds ? formatDuration(window.windowSeconds) : "limit";
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatBalance(balance: CapacityBalance): string {
  const amount = balance.remaining.toFixed(2);
  const remaining = balance.currency === "CNY"
    ? `¥${amount}`
    : balance.currency === "USD"
      ? `$${amount}`
      : `${balance.currency} ${amount}`;
  const details: string[] = [];
  if (balance.toppedUp !== undefined) details.push(`top-up ${balance.toppedUp.toFixed(2)}`);
  if (balance.granted !== undefined) details.push(`grant ${balance.granted.toFixed(2)}`);
  return details.length > 0 ? `${remaining} (${details.join(", ")})` : remaining;
}

function formatEfficiency(value: number | undefined, bucket: BurnBucket): string {
  return value === undefined
    ? `no signal (${(bucket.inputTokens / 1_000).toFixed(0)}k fresh input)`
    : `${value.toFixed(2)}%/MTok over ${(bucket.inputTokens / 1_000_000).toFixed(2)}M fresh input`;
}
