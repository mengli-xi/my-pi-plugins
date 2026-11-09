import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../config/agent-dir.ts";
import {
  applyCacheHistoryEntry,
  cacheHistorySnapshot,
  cloneCacheHistoryState,
  createCacheHistoryState,
  type CacheHistorySnapshot,
  type CacheHistoryState,
} from "./cache-history.ts";

export interface AssistantUsageAnalysis {
  sessionStartedAtMs: number | null;
  latestUsage: Record<string, unknown> | null;
  awaitingUsageAfterCompaction: boolean;
  latestRequestDurationMs: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCacheReadTokens: number | null;
  totalCacheWriteTokens: number | null;
  totalCostUsd: number | null;
  totalDurationMs: number | null;
  cacheHistory: CacheHistorySnapshot;
}

interface AssistantUsageAggregate {
  latestUsage: Record<string, unknown> | null;
  awaitingUsageAfterCompaction: boolean;
  latestRequestDurationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  hasCacheReadTokens: boolean;
  hasCacheWriteTokens: boolean;
  hasCost: boolean;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  cacheHistory: CacheHistoryState;
}

interface BranchCacheState {
  entryCount: number;
  lastEntryId: string | null;
  analysis: AssistantUsageAggregate;
  transcriptReady: boolean;
}

/** Invocation-local cache and write serialization for statusline projection. */
export class StatuslineTranscriptCache {
  readonly branches = new Map<string, BranchCacheState>();
  readonly locks = new Map<string, Promise<unknown>>();

  clear(path?: string): void {
    if (path) this.branches.delete(path);
    else this.branches.clear();
  }

  cacheHistory(ctx: any): CacheHistorySnapshot | undefined {
    const path = join(getStatusLineTranscriptDir(), getTranscriptFileName(ctx));
    const state = this.branches.get(path);
    return state ? cacheHistorySnapshot(state.analysis.cacheHistory) : undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getSessionManager(ctx: any): Record<string, unknown> {
  return asRecord(ctx.sessionManager ?? null);
}

export function getPiSessionId(ctx: any): string | null {
  const sessionManager = getSessionManager(ctx);
  if (typeof sessionManager.getSessionId !== "function") return null;
  return asString(sessionManager.getSessionId());
}

export function getPiSessionFile(ctx: any): string | null {
  const sessionManager = getSessionManager(ctx);
  if (typeof sessionManager.getSessionFile !== "function") return null;
  return asString(sessionManager.getSessionFile());
}

export function getPiBranchEntries(ctx: any): any[] {
  const sessionManager = getSessionManager(ctx);
  if (typeof sessionManager.getBranch !== "function") return [];
  return asArray(sessionManager.getBranch());
}

export function getStatusLineTranscriptDir(): string {
  return join(getAgentDir(), "statusline-transcripts");
}

function getTranscriptFileName(ctx: any): string {
  const sessionId = getPiSessionId(ctx);
  if (sessionId) {
    return `${sessionId}.jsonl`;
  }

  const cwd = asString(ctx.cwd) ?? process.cwd();
  const digest = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  return `ephemeral-${digest}.jsonl`;
}

function createEmptyAnalysis(): AssistantUsageAggregate {
  return {
    latestUsage: null,
    awaitingUsageAfterCompaction: false,
    latestRequestDurationMs: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCostUsd: 0,
    hasInputTokens: false,
    hasOutputTokens: false,
    hasCacheReadTokens: false,
    hasCacheWriteTokens: false,
    hasCost: false,
    firstTimestamp: null,
    lastTimestamp: null,
    cacheHistory: createCacheHistoryState(),
  };
}

function cloneAnalysis(analysis: AssistantUsageAggregate): AssistantUsageAggregate {
  return {
    latestUsage: analysis.latestUsage,
    awaitingUsageAfterCompaction: analysis.awaitingUsageAfterCompaction,
    latestRequestDurationMs: analysis.latestRequestDurationMs,
    totalInputTokens: analysis.totalInputTokens,
    totalOutputTokens: analysis.totalOutputTokens,
    totalCacheReadTokens: analysis.totalCacheReadTokens,
    totalCacheWriteTokens: analysis.totalCacheWriteTokens,
    totalCostUsd: analysis.totalCostUsd,
    hasInputTokens: analysis.hasInputTokens,
    hasOutputTokens: analysis.hasOutputTokens,
    hasCacheReadTokens: analysis.hasCacheReadTokens,
    hasCacheWriteTokens: analysis.hasCacheWriteTokens,
    hasCost: analysis.hasCost,
    firstTimestamp: analysis.firstTimestamp,
    lastTimestamp: analysis.lastTimestamp,
    cacheHistory: cloneCacheHistoryState(analysis.cacheHistory),
  };
}

function toPublicAnalysis(analysis: AssistantUsageAggregate): AssistantUsageAnalysis {
  return {
    sessionStartedAtMs: analysis.firstTimestamp,
    latestUsage: analysis.latestUsage,
    awaitingUsageAfterCompaction: analysis.awaitingUsageAfterCompaction,
    latestRequestDurationMs: analysis.latestRequestDurationMs,
    totalInputTokens: analysis.hasInputTokens ? analysis.totalInputTokens : null,
    totalOutputTokens: analysis.hasOutputTokens ? analysis.totalOutputTokens : null,
    totalCacheReadTokens: analysis.hasCacheReadTokens ? analysis.totalCacheReadTokens : null,
    totalCacheWriteTokens: analysis.hasCacheWriteTokens ? analysis.totalCacheWriteTokens : null,
    totalCostUsd: analysis.hasCost ? analysis.totalCostUsd : null,
    totalDurationMs:
      analysis.firstTimestamp !== null && analysis.lastTimestamp !== null
        ? Math.max(0, analysis.lastTimestamp - analysis.firstTimestamp)
        : null,
    cacheHistory: cacheHistorySnapshot(analysis.cacheHistory),
  };
}

function getEntryTimestamp(entry: any): number | null {
  const numericTimestamp = asNumber(entry?.timestamp) ?? asNumber(entry?.message?.timestamp);
  if (numericTimestamp !== null) return numericTimestamp;

  const stringTimestamp = asString(entry?.timestamp);
  if (!stringTimestamp) return null;

  const parsed = Date.parse(stringTimestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAssistantUsage(entry: any): Record<string, unknown> | null {
  const message = asRecord(entry?.message ?? null);
  if (message.role !== "assistant") return null;
  if (message.stopReason === "aborted" || message.stopReason === "error") return null;

  const usage = asRecord(message.usage ?? null);
  // Like Pi's public compaction accounting, zero-only usage is not a new
  // measured baseline (some providers persist it on unsuccessful responses).
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
    .some((value) => (asNumber(value) ?? 0) > 0) ? usage : null;
}

function applyEntryToAnalysis(analysis: AssistantUsageAggregate, entry: any): void {
  applyCacheHistoryEntry(analysis.cacheHistory, entry);
  const entryType = asString(entry?.type);
  if (entryType === "compaction" || entryType === "branch_summary") {
    if (entryType === "compaction") {
      // Branch order, rather than timestamps, defines which usage is current.
      // Keep cumulative totals and cache history, but retire the old request.
      analysis.latestUsage = null;
      analysis.latestRequestDurationMs = null;
      analysis.awaitingUsageAfterCompaction = true;
    }
    // Still count summary usage toward session totals when present.
    const summaryUsage = asRecord(entry?.usage ?? null);
    if (Object.keys(summaryUsage).length > 0) {
      const input = asNumber(summaryUsage.input);
      const output = asNumber(summaryUsage.output);
      const cacheRead = asNumber(summaryUsage.cacheRead);
      const cacheWrite = asNumber(summaryUsage.cacheWrite);
      const totalCost = asNumber(asRecord(summaryUsage.cost).total);
      if (input !== null) {
        analysis.totalInputTokens += input;
        analysis.hasInputTokens = true;
      }
      if (output !== null) {
        analysis.totalOutputTokens += output;
        analysis.hasOutputTokens = true;
      }
      if (cacheRead !== null) {
        analysis.totalCacheReadTokens += cacheRead;
        analysis.hasCacheReadTokens = true;
      }
      if (cacheWrite !== null) {
        analysis.totalCacheWriteTokens += cacheWrite;
        analysis.hasCacheWriteTokens = true;
      }
      if (totalCost !== null) {
        analysis.totalCostUsd += totalCost;
        analysis.hasCost = true;
      }
    }
    return;
  }

  const timestamp = getEntryTimestamp(entry);
  if (timestamp !== null) {
    analysis.firstTimestamp = analysis.firstTimestamp === null ? timestamp : Math.min(analysis.firstTimestamp, timestamp);
    analysis.lastTimestamp = analysis.lastTimestamp === null ? timestamp : Math.max(analysis.lastTimestamp, timestamp);
  }

  const message = asRecord(entry?.message ?? null);
  const requestStartedAt = asNumber(message.timestamp);
  if (
    message.role === "assistant" &&
    timestamp !== null &&
    requestStartedAt !== null &&
    timestamp >= requestStartedAt
  ) {
    analysis.latestRequestDurationMs = timestamp - requestStartedAt;
  }

  // toolResult usage (e.g. summaries) counts toward totals but not prompt baseline.
  if (message.role === "toolResult" && message.usage != null) {
    const toolUsage = asRecord(message.usage);
    const input = asNumber(toolUsage.input);
    const output = asNumber(toolUsage.output);
    const cacheRead = asNumber(toolUsage.cacheRead);
    const cacheWrite = asNumber(toolUsage.cacheWrite);
    const totalCost = asNumber(asRecord(toolUsage.cost).total);
    if (input !== null) {
      analysis.totalInputTokens += input;
      analysis.hasInputTokens = true;
    }
    if (output !== null) {
      analysis.totalOutputTokens += output;
      analysis.hasOutputTokens = true;
    }
    if (cacheRead !== null) {
      analysis.totalCacheReadTokens += cacheRead;
      analysis.hasCacheReadTokens = true;
    }
    if (cacheWrite !== null) {
      analysis.totalCacheWriteTokens += cacheWrite;
      analysis.hasCacheWriteTokens = true;
    }
    if (totalCost !== null) {
      analysis.totalCostUsd += totalCost;
      analysis.hasCost = true;
    }
    return;
  }

  const usage = getAssistantUsage(entry);
  if (!usage) return;

  analysis.latestUsage = usage;
  analysis.awaitingUsageAfterCompaction = false;

  const input = asNumber(usage.input);
  const output = asNumber(usage.output);
  const cacheRead = asNumber(usage.cacheRead);
  const cacheWrite = asNumber(usage.cacheWrite);
  const totalCost = asNumber(asRecord(usage.cost).total);

  if (input !== null) {
    analysis.totalInputTokens += input;
    analysis.hasInputTokens = true;
  }

  if (output !== null) {
    analysis.totalOutputTokens += output;
    analysis.hasOutputTokens = true;
  }

  if (cacheRead !== null) {
    analysis.totalCacheReadTokens += cacheRead;
    analysis.hasCacheReadTokens = true;
  }

  if (cacheWrite !== null) {
    analysis.totalCacheWriteTokens += cacheWrite;
    analysis.hasCacheWriteTokens = true;
  }

  if (totalCost !== null) {
    analysis.totalCostUsd += totalCost;
    analysis.hasCost = true;
  }
}

function buildAssistantUsage(message: Record<string, unknown>): Record<string, number> | null {
  const usage = asRecord(message.usage ?? null);
  const input = asNumber(usage.input);
  const output = asNumber(usage.output);
  const cacheRead = asNumber(usage.cacheRead);
  const cacheWrite = asNumber(usage.cacheWrite);
  const totalTokens = asNumber(usage.totalTokens);

  if (
    input === null &&
    output === null &&
    cacheRead === null &&
    cacheWrite === null &&
    totalTokens === null
  ) {
    return null;
  }

  const normalizedInput = input ?? 0;
  const normalizedOutput = output ?? 0;
  const normalizedCacheRead = cacheRead ?? 0;
  const normalizedCacheWrite = cacheWrite ?? 0;

  return {
    input_tokens: normalizedInput,
    output_tokens: normalizedOutput,
    cache_creation_input_tokens: normalizedCacheWrite,
    cache_read_input_tokens: normalizedCacheRead,
    total_tokens:
      totalTokens ??
      normalizedInput + normalizedOutput + normalizedCacheRead + normalizedCacheWrite,
  };
}

function mapTranscriptEntry(entry: any): Record<string, unknown> | null {
  if (entry?.type !== "message") return null;

  const message = asRecord(entry.message ?? null);
  const role = asString(message.role);
  const uuid = asString(entry.id);
  const parentUuid = asString(entry.parentId);

  if (role === "assistant") {
    if (message.stopReason === "aborted" || message.stopReason === "error") {
      return null;
    }

    const usage = buildAssistantUsage(message);
    if (!usage) return null;

    return {
      type: "assistant",
      uuid,
      parentUuid,
      message: {
        usage,
      },
    };
  }

  if (role === "user") {
    return {
      type: "user",
      uuid,
      parentUuid,
    };
  }

  return null;
}

function getQuickBranchKey(branchEntries: any[]): { count: number; lastId: string | null } {
  const count = branchEntries.length;
  const lastId = count > 0 ? asString(branchEntries[count - 1]?.id) : null;
  return { count, lastId };
}

function canAppendToCache(cached: BranchCacheState | undefined, branchEntries: any[]): boolean {
  if (!cached || !cached.transcriptReady) return false;
  if (branchEntries.length < cached.entryCount) return false;
  if (cached.entryCount === 0) return true;
  return cached.lastEntryId === asString(branchEntries[cached.entryCount - 1]?.id);
}

async function persistTranscript(path: string, lines: string[], mode: "rewrite" | "append"): Promise<boolean> {
  try {
    await mkdir(getStatusLineTranscriptDir(), { recursive: true });
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";

    if (mode === "append") {
      if (!content) return true;
      await appendFile(path, content, "utf8");
    } else {
      await writeFile(path, content, "utf8");
    }

    return true;
  } catch {
    return false;
  }
}

async function withTranscriptLock<T>(
  cache: StatuslineTranscriptCache,
  transcriptPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = cache.locks.get(transcriptPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  cache.locks.set(transcriptPath, current);

  try {
    return await current;
  } finally {
    if (cache.locks.get(transcriptPath) === current) {
      cache.locks.delete(transcriptPath);
    }
  }
}

export async function ensureClaudeTranscriptAdapter(
  ctx: any,
  cache: StatuslineTranscriptCache,
  branchEntriesArg?: any[],
): Promise<{ transcriptPath: string; analysis: AssistantUsageAnalysis }> {
  const transcriptPath = join(getStatusLineTranscriptDir(), getTranscriptFileName(ctx));
  const branchEntries = branchEntriesArg ?? getPiBranchEntries(ctx);

  return await withTranscriptLock(cache, transcriptPath, async () => {
    const quickKey = getQuickBranchKey(branchEntries);
    const cached = cache.branches.get(transcriptPath);
    const fallbackTranscriptPath = getPiSessionFile(ctx) ?? transcriptPath;

    if (cached && cached.entryCount === quickKey.count && cached.lastEntryId === quickKey.lastId) {
      return {
        transcriptPath: cached.transcriptReady ? transcriptPath : fallbackTranscriptPath,
        analysis: toPublicAnalysis(cached.analysis),
      };
    }

    if (canAppendToCache(cached, branchEntries) && cached) {
      const analysis = cloneAnalysis(cached.analysis);
      const appendedLines: string[] = [];

      // 普通 turn_end 场景只处理新增消息，避免每次全量扫描和重写 transcript。
      for (const entry of branchEntries.slice(cached.entryCount)) {
        applyEntryToAnalysis(analysis, entry);
        const mapped = mapTranscriptEntry(entry);
        if (mapped) appendedLines.push(JSON.stringify(mapped));
      }

      const transcriptReady = await persistTranscript(transcriptPath, appendedLines, "append");
      cache.branches.set(transcriptPath, {
        entryCount: quickKey.count,
        lastEntryId: quickKey.lastId,
        analysis,
        transcriptReady,
      });

      return {
        transcriptPath: transcriptReady ? transcriptPath : fallbackTranscriptPath,
        analysis: toPublicAnalysis(analysis),
      };
    }

    const analysis = createEmptyAnalysis();
    const lines: string[] = [];

    // 分叉、compact 或 cache 失效后退回一次全量重建，保证 transcript 正确性。
    for (const entry of branchEntries) {
      applyEntryToAnalysis(analysis, entry);
      const mapped = mapTranscriptEntry(entry);
      if (mapped) lines.push(JSON.stringify(mapped));
    }

    const transcriptReady = await persistTranscript(transcriptPath, lines, "rewrite");
    cache.branches.set(transcriptPath, {
      entryCount: quickKey.count,
      lastEntryId: quickKey.lastId,
      analysis,
      transcriptReady,
    });

    return {
      transcriptPath: transcriptReady ? transcriptPath : fallbackTranscriptPath,
      analysis: toPublicAnalysis(analysis),
    };
  });
}
