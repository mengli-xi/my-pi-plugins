export const CACHE_MISS_NOISE_FLOOR = 1_024;
export const CACHE_HISTORY_SAMPLE_LIMIT = 120;

export type CacheBaselineReset = "compaction" | "branch-summary";

export interface CacheRequestSample {
  ordinal: number;
  entryId?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens: number;
  hitPercent: number;
  reusePercent?: number;
  previousPromptTokens?: number;
  reusableTokens?: number;
  missTokens?: number;
  significantMiss: boolean;
  modelChanged: boolean;
  idleMs?: number;
  baselineReset?: CacheBaselineReset;
}

export interface CacheHistorySummary {
  requestCount: number;
  retainedCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  weightedHitPercent?: number;
  weightedReusePercent?: number;
  significantMissCount: number;
  significantMissTokens: number;
}

export interface CacheHistorySnapshot {
  samples: CacheRequestSample[];
  latest: CacheRequestSample | null;
  summary: CacheHistorySummary;
}

interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp?: number;
  reportedCache: boolean;
}

export interface CacheHistoryState {
  samples: CacheRequestSample[];
  latest: CacheRequestSample | null;
  requestCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  reusableTokens: number;
  reusedTokens: number;
  significantMissCount: number;
  significantMissTokens: number;
  previous?: PreviousRequest;
  pendingReset?: CacheBaselineReset;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(entry: Record<string, unknown>, message: Record<string, unknown>): number | undefined {
  const direct = number(message.timestamp) ?? number(entry.timestamp);
  if (direct !== undefined) return direct;
  const raw = string(entry.timestamp);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assistantUsage(entry: unknown): {
  entry: Record<string, unknown>;
  message: Record<string, unknown>;
  usage: Record<string, unknown>;
} | undefined {
  const item = record(entry);
  if (item.type !== "message") return undefined;
  const message = record(item.message);
  if (
    message.role !== "assistant"
    || message.stopReason === "aborted"
    || message.stopReason === "error"
  ) return undefined;
  const usage = record(message.usage);
  return Object.keys(usage).length > 0 ? { entry: item, message, usage } : undefined;
}

export function createCacheHistoryState(): CacheHistoryState {
  return {
    samples: [],
    latest: null,
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    reusableTokens: 0,
    reusedTokens: 0,
    significantMissCount: 0,
    significantMissTokens: 0,
  };
}

export function cloneCacheHistoryState(state: CacheHistoryState): CacheHistoryState {
  return {
    ...state,
    samples: state.samples.map((sample) => ({ ...sample })),
    latest: state.latest ? { ...state.latest } : null,
    previous: state.previous ? { ...state.previous } : undefined,
  };
}

export function applyCacheHistoryEntry(state: CacheHistoryState, value: unknown): void {
  const entry = record(value);
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    state.previous = undefined;
    state.pendingReset = entry.type === "compaction" ? "compaction" : "branch-summary";
    return;
  }

  const assistant = assistantUsage(entry);
  if (!assistant) return;
  const inputTokens = number(assistant.usage.input) ?? 0;
  const cacheReadTokens = number(assistant.usage.cacheRead) ?? 0;
  const cacheWriteTokens = number(assistant.usage.cacheWrite) ?? 0;
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (promptTokens <= 0) return;

  const provider = string(assistant.message.provider);
  const model = string(assistant.message.model);
  const modelKey = `${provider ?? "unknown"}/${model ?? "unknown"}`;
  const at = timestamp(assistant.entry, assistant.message);
  const previous = state.previous;
  const reportsCache = cacheReadTokens + cacheWriteTokens > 0;
  // A zero-cache request is only measurable after this provider/model history
  // has reported cache activity. Otherwise 0 means "not observable", not a
  // proven full miss (the same distinction Pi's cache-stats uses).
  const cacheObservable = previous !== undefined
    && (reportsCache || previous.reportedCache);
  const reusableTokens = cacheObservable
    ? Math.min(previous.promptTokens, promptTokens)
    : undefined;
  const reusedTokens = reusableTokens === undefined
    ? undefined
    : Math.min(cacheReadTokens, reusableTokens);
  const missTokens = reusableTokens === undefined
    ? undefined
    : Math.max(0, reusableTokens - cacheReadTokens);
  const significantMiss = missTokens !== undefined
    && missTokens > CACHE_MISS_NOISE_FLOOR
    && (reportsCache || previous?.reportedCache === true);

  state.requestCount++;
  const sample: CacheRequestSample = {
    ordinal: state.requestCount,
    ...(string(assistant.entry.id) ? { entryId: string(assistant.entry.id) } : {}),
    ...(at === undefined ? {} : { timestamp: at }),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    promptTokens,
    hitPercent: (cacheReadTokens / promptTokens) * 100,
    ...(reusableTokens === undefined ? {} : {
      reusePercent: reusableTokens > 0 ? (reusedTokens! / reusableTokens) * 100 : 0,
      previousPromptTokens: previous!.promptTokens,
      reusableTokens,
      missTokens,
    }),
    significantMiss,
    modelChanged: previous !== undefined && previous.modelKey !== modelKey,
    ...(previous?.timestamp === undefined || at === undefined
      ? {}
      : { idleMs: Math.max(0, at - previous.timestamp) }),
    ...(state.pendingReset ? { baselineReset: state.pendingReset } : {}),
  };

  state.totalInputTokens += inputTokens;
  state.totalCacheReadTokens += cacheReadTokens;
  state.totalCacheWriteTokens += cacheWriteTokens;
  if (reusableTokens !== undefined) {
    state.reusableTokens += reusableTokens;
    state.reusedTokens += reusedTokens!;
  }
  if (significantMiss) {
    state.significantMissCount++;
    state.significantMissTokens += missTokens!;
  }
  state.samples.push(sample);
  if (state.samples.length > CACHE_HISTORY_SAMPLE_LIMIT) state.samples.shift();
  state.latest = sample;
  state.pendingReset = undefined;
  state.previous = {
    promptTokens,
    modelKey,
    ...(at === undefined ? {} : { timestamp: at }),
    reportedCache: reportsCache || previous?.reportedCache === true,
  };
}

export function cacheHistorySnapshot(state: CacheHistoryState): CacheHistorySnapshot {
  const totalPromptTokens = state.totalInputTokens
    + state.totalCacheReadTokens
    + state.totalCacheWriteTokens;
  return {
    samples: state.samples.map((sample) => ({ ...sample })),
    latest: state.latest ? { ...state.latest } : null,
    summary: {
      requestCount: state.requestCount,
      retainedCount: state.samples.length,
      totalInputTokens: state.totalInputTokens,
      totalCacheReadTokens: state.totalCacheReadTokens,
      totalCacheWriteTokens: state.totalCacheWriteTokens,
      ...(totalPromptTokens > 0
        ? { weightedHitPercent: (state.totalCacheReadTokens / totalPromptTokens) * 100 }
        : {}),
      ...(state.reusableTokens > 0
        ? { weightedReusePercent: (state.reusedTokens / state.reusableTokens) * 100 }
        : {}),
      significantMissCount: state.significantMissCount,
      significantMissTokens: state.significantMissTokens,
    },
  };
}

export function analyzeCacheHistory(entries: readonly unknown[]): CacheHistorySnapshot {
  const state = createCacheHistoryState();
  for (const entry of entries) applyCacheHistoryEntry(state, entry);
  return cacheHistorySnapshot(state);
}
