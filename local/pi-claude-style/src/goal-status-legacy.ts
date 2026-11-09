import type { GoalPhase, GoalSnapshot } from "./goal-status.ts";

const GOAL_STATE_ENTRY_TYPE = "goal-state";

interface SessionEntryLike {
  id?: string;
  type?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function phaseOf(value: unknown): GoalPhase | undefined {
  return value === "active" ||
    value === "queued" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usage_limited" ||
    value === "budget_limited" ||
    value === "complete"
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function messageTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const total = usage.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
    return total;
  }
  return finiteNumber(usage.input) +
    finiteNumber(usage.output) +
    finiteNumber(usage.cacheRead) +
    finiteNumber(usage.cacheWrite);
}

/** Compatibility accounting for sessions produced before goal:snapshot-v1. */
export function cumulativeAssistantTokens(
  entries: readonly SessionEntryLike[],
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    total += messageTokens(message.usage);
  }
  return total;
}

/** Parse the former persisted owner shape only when no semantic owner answers. */
export function readGoalSnapshot(
  entries: readonly SessionEntryLike[],
  now: number,
  tokens?: (entries: readonly SessionEntryLike[]) => number,
): GoalSnapshot | undefined {
  let data: unknown;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE) {
      data = entry.data;
      break;
    }
  }
  if (!isRecord(data) || !isRecord(data.goal)) return undefined;
  const goal = data.goal;
  const phase = phaseOf(goal.status);
  if (!phase) return undefined;
  const settled = finiteNumber(goal.timeUsedSeconds);
  const startedAt = goal.activeStartedAt;
  const running = typeof startedAt === "number" && Number.isFinite(startedAt)
    ? Math.max(0, now - startedAt) / 1_000
    : 0;
  const checkpointed = finiteNumber(goal.tokensUsed);
  const tokensUsed = phase === "active"
    ? Math.max(
      checkpointed,
      (tokens ?? cumulativeAssistantTokens)(entries) -
        finiteNumber(goal.baselineTokens),
    )
    : checkpointed;
  const budget = goal.tokenBudget;
  return {
    id: typeof goal.id === "string" ? goal.id : "",
    text: typeof goal.text === "string" ? goal.text.trim() : "",
    phase,
    runtimeSeconds: settled + running,
    tokensUsed,
    tokenBudget:
      typeof budget === "number" && Number.isFinite(budget) && budget > 0
        ? budget
        : undefined,
    queued: Array.isArray(data.queue) ? data.queue.length : 0,
  };
}

/** Keeps legacy branch accounting bounded while the semantic owner is absent. */
export class LegacyGoalSnapshotReader {
  private tokenCache: { length: number; leaf: unknown; total: number } | undefined;

  read(entries: readonly SessionEntryLike[], now: number): GoalSnapshot | undefined {
    return readGoalSnapshot(entries, now, (value) => this.tokensFor(value));
  }

  clear(): void {
    this.tokenCache = undefined;
  }

  private tokensFor(entries: readonly SessionEntryLike[]): number {
    const last = entries.at(-1);
    const leaf = typeof last?.id === "string" ? last.id : last;
    if (this.tokenCache?.length === entries.length && this.tokenCache.leaf === leaf) {
      return this.tokenCache.total;
    }
    const total = cumulativeAssistantTokens(entries);
    this.tokenCache = { length: entries.length, leaf, total };
    return total;
  }
}
