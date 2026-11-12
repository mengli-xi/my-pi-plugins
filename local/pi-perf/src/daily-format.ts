import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { setImmediate as yieldToUi } from "node:timers/promises";
import { addValue, emptyHistogram, histogramDistribution, mergeHistogram, parseHistogram, type Distribution, type Histogram } from "./histogram.ts";

export const DAY_MS = 86_400_000;
export type RunMode = "tui" | "rpc" | "print" | "json" | "unknown";
export interface Identity { pid: number; piVersion: string; packagesHash: string; packages: string[]; mode: RunMode; packageResolveMs?: number }
export function packageHash(packages: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(packages)].sort())).digest("hex").slice(0, 16);
}
export interface RuntimeSample {
  rss: number; heapUsed: number; heapTotal: number; external: number;
  cpuPercent: number; loopP50Ms: number; loopP99Ms: number; loopMaxMs: number;
  entries?: number; contextTokens?: number;
}
export interface StartupSample { readyMs: number; extensionReachedMs: number; extensionToReadyMs: number; firstObservedFrameMs?: number; launcherFirstObservedFrameMs?: number }
export type HistoryRecord = Identity & { at: number; run: string; kind: "sample" | "startup" | "session"; values: Record<string, number> };
export interface DailySummary {
  day: string; piVersion: string; packagesHash: string; packages: string[]; mode: RunMode; sessions: number; startups: number;
  metrics: Record<string, Distribution>;
}
export interface TrendResult { rows: DailySummary[]; skippedFiles: number; limited: boolean; combinedGroups?: boolean; busyDays?: number }
export interface DailyShard {
  version: 2; day: string; identity: Identity; sessions: number; startups: number;
  histograms: Record<string, Histogram>;
}
const METRICS = new Set(["rss", "heapUsed", "heapTotal", "external", "cpuPercent", "loopP50Ms", "loopP99Ms", "loopMaxMs",
  "entries", "contextTokens", "readyMs", "extensionReachedMs", "extensionToReadyMs", "firstObservedFrameMs", "launcherFirstObservedFrameMs"]);
export function mergeShard(groups: Map<string, DailyShard>, shard: DailyShard): void {
  const key = `${shard.day}/${shard.identity.piVersion}/${shard.identity.packagesHash}/${shard.identity.mode}`;
  let group = groups.get(key);
  if (!group) { group = { ...shard, sessions: 0, startups: 0, histograms: {} }; groups.set(key, group); }
  group.sessions += shard.sessions; group.startups += shard.startups;
  for (const [metric, histogram] of Object.entries(shard.histograms)) mergeHistogram(group.histograms[metric] ??= emptyHistogram(), histogram);
}
export function summaries(groups: Map<string, DailyShard>): DailySummary[] {
  return [...groups.values()].map(group => ({ day: group.day, piVersion: group.identity.piVersion,
    packagesHash: group.identity.packagesHash, packages: group.identity.packages, mode: group.identity.mode,
    sessions: group.sessions, startups: group.startups,
    metrics: Object.fromEntries(Object.entries(group.histograms).map(([key, histogram]) => [key, histogramDistribution(histogram)]))
  })).sort((a, b) => a.day.localeCompare(b.day) || a.piVersion.localeCompare(b.piVersion) || a.mode.localeCompare(b.mode) || a.packagesHash.localeCompare(b.packagesHash));
}
// A legacy file may contain arrays. Read one bounded file at a time and yield
// while converting it; never JSON.parse all thirty days in a single callback.
export async function parseShard(raw: string, day: string): Promise<DailyShard> {
  if (new Date(day).toISOString().slice(0, 10) !== day) throw new Error("invalid daily date");
  const value = JSON.parse(raw);
  // Compatibility is read-only: new producers no longer emit misleading paint names.
  const aliases: Record<string, string> = { firstPaintMs: "firstObservedFrameMs", launcherFirstPaintMs: "launcherFirstObservedFrameMs" };
  const id = value?.identity;
  if (![1, 2].includes(value?.version) || value.day !== day || !id || !Number.isSafeInteger(id.pid) || id.pid <= 0 ||
    typeof id.piVersion !== "string" || !id.piVersion || id.piVersion.length > 80 || /[/\\]/.test(id.piVersion) ||
    typeof id.packagesHash !== "string" || !/^[\w-]{1,64}$/.test(id.packagesHash) ||
    !Number.isSafeInteger(value.sessions) || value.sessions < 0 || !Number.isSafeInteger(value.startups) || value.startups < 0) throw new Error("invalid daily summary");
  const mode: RunMode = value.version === 1 ? "unknown" : id.mode;
  const packages = value.version === 1 ? [] : id.packages;
  if (!["tui", "rpc", "print", "json", "unknown"].includes(mode) || !Array.isArray(packages) || packages.length > 256 ||
    packages.some(name => typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || name.length > 214)) throw new Error("invalid daily identity");
  const source = value.version === 1 ? value.values : value.histograms;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid daily metrics");
  const histograms: Record<string, Histogram> = {};
  for (const [rawKey, data] of Object.entries(source)) {
    const key = aliases[rawKey] ?? rawKey;
    if (!METRICS.has(key)) continue;
    if (value.version === 2) histograms[key] = parseHistogram(data);
    else {
      if (!Array.isArray(data)) throw new Error("invalid legacy samples");
      const histogram = emptyHistogram();
      for (let i = 0; i < data.length; i++) {
        const sample = data[i];
        if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0) throw new Error("invalid legacy sample");
        // v1 stored whole 20ms timer intervals; v2 stores excess delay.
        addValue(histogram, key.startsWith("loop") ? Math.max(0, sample - 20) : sample);
        if (i % 256 === 255) await yieldToUi();
      }
      histograms[key] = histogram;
    }
  }
  return { version: 2, day, identity: { ...id, mode, packages }, sessions: value.sessions, startups: value.startups, histograms };
}
export class InvalidDailyFile extends Error {}
export async function readShard(path: string, day: string): Promise<DailyShard> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > 1024 * 1024) throw new InvalidDailyFile("daily file exceeds 1MiB read limit");
    const raw = await file.readFile("utf8");
    try { return await parseShard(raw, day); } catch (error) {
      throw new InvalidDailyFile("invalid daily file", { cause: error });
    }
  } finally { await file.close(); }
}
