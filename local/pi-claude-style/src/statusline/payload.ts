import {
  ensureClaudeTranscriptAdapter,
  getPiBranchEntries,
  getPiSessionFile,
  getPiSessionId,
  type StatuslineTranscriptCache,
} from "./transcript.ts";
import type { ClaudeLikeStatusLineInput } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getThinkingLevel(ctx: any): string | null {
  return asString(ctx?.thinkingLevel ?? null);
}

function buildTodoStatus(branchEntries: unknown[]) {
  let latestTasks: unknown[] | null = null;
  for (const entry of branchEntries) {
    const record = asRecord(entry);
    if (record.type !== "message") continue;
    const message = asRecord(record.message);
    if (message.role !== "toolResult" || message.toolName !== "todo") continue;
    const details = asRecord(message.details);
    // rpiv-todo reports `tasks`, pi-todo reports `todos` — same item shape.
    const tasks = Array.isArray(details.tasks)
      ? details.tasks
      : Array.isArray(details.todos)
        ? details.todos
        : null;
    if (!tasks) continue;
    latestTasks = tasks;
  }
  if (!latestTasks) return null;

  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const task of latestTasks) {
    const status = asRecord(task).status;
    if (status === "completed") completed++;
    else if (status === "in_progress") inProgress++;
    else if (status === "pending") pending++;
  }
  return {
    total: completed + inProgress + pending,
    completed,
    in_progress: inProgress,
    pending,
  };
}

function buildCurrentUsage(latestUsage: Record<string, unknown> | null) {
  // The branch analyzer retires usage at a later compaction. A null live
  // estimate alone must not discard valid branch usage (e.g. after /reload).
  if (!latestUsage) {
    return null;
  }

  return {
    input_tokens: asNumber(latestUsage.input),
    output_tokens: asNumber(latestUsage.output),
    cache_creation_input_tokens: asNumber(latestUsage.cacheWrite),
    cache_read_input_tokens: asNumber(latestUsage.cacheRead),
  };
}

function buildCacheMetrics(
  latest: Awaited<ReturnType<typeof ensureClaudeTranscriptAdapter>>["analysis"]["cacheHistory"]["latest"],
  latestUsage: Record<string, unknown> | null,
): ClaudeLikeStatusLineInput["context_window"]["cache"] {
  if (!latest || !latestUsage) return null;
  const promptTokens = (asNumber(latestUsage.input) ?? 0)
    + (asNumber(latestUsage.cacheRead) ?? 0)
    + (asNumber(latestUsage.cacheWrite) ?? 0);
  if (promptTokens <= 0) return null;
  return {
    hit_percent: latest.hitPercent,
    reuse_percent: latest.reusePercent ?? null,
    miss_tokens: latest.missTokens ?? null,
    prev_prompt_tokens: latest.previousPromptTokens ?? null,
    latest_prompt_tokens: latest.promptTokens,
  };
}

function computeUsedPercentage(
  currentUsage: ClaudeLikeStatusLineInput["context_window"]["current_usage"],
  contextWindowSize: number | null,
  fallbackPercent: number | null,
): number | null {
  if (currentUsage && contextWindowSize && contextWindowSize > 0) {
    const usedInputTokens =
      (currentUsage.input_tokens ?? 0) +
      (currentUsage.cache_creation_input_tokens ?? 0) +
      (currentUsage.cache_read_input_tokens ?? 0);
    return Math.round((usedInputTokens / contextWindowSize) * 100);
  }

  return fallbackPercent !== null ? Math.round(fallbackPercent) : null;
}

export async function buildStatusLinePayload(
  ctx: any,
  transcriptCache: StatuslineTranscriptCache,
): Promise<ClaudeLikeStatusLineInput> {
  const contextUsage = asRecord(ctx.getContextUsage?.() ?? null);
  const model = asRecord(ctx.model ?? null);
  const sessionId = getPiSessionId(ctx);
  const sessionFile = getPiSessionFile(ctx);
  const branchEntries = getPiBranchEntries(ctx);
  const todo = buildTodoStatus(branchEntries);
  const { transcriptPath, analysis } = await ensureClaudeTranscriptAdapter(
    ctx,
    transcriptCache,
    branchEntries,
  );
  const latestUsage = analysis.latestUsage;

  const contextWindowSize =
    asNumber(contextUsage.contextWindow) ??
    asNumber(model.contextWindow) ??
    asNumber(model.contextWindowSize);

  let currentUsage = buildCurrentUsage(latestUsage);
  let estimatedTokens: number | null = null;
  if (analysis.awaitingUsageAfterCompaction) {
    // Public Pi exports only; reconstruct the effective branch instead of
    // trusting usage on retained assistant messages from before compaction.
    // Keep this cold path out of ordinary statusline refreshes.
    try {
      const { buildSessionContext, estimateTokens } = await import("@earendil-works/pi-coding-agent");
      const { messages } = buildSessionContext(branchEntries);
      estimatedTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) estimatedTokens = null;
    } catch {
      // A clear pending state is preferable to stale usage if projection fails.
    }
    if (estimatedTokens !== null) {
      // Preserve the existing command payload: older scripts already sum these
      // input fields. Unknown cache/output counts must not masquerade as usage.
      currentUsage = {
        input_tokens: estimatedTokens,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      };
    }
  }
  const cacheMetrics = buildCacheMetrics(analysis.cacheHistory.latest, latestUsage);
  const usedPercentage = computeUsedPercentage(
    currentUsage,
    contextWindowSize,
    analysis.awaitingUsageAfterCompaction ? null : asNumber(contextUsage.percent),
  );
  const remainingPercentage =
    typeof usedPercentage === "number" ? Math.max(0, 100 - usedPercentage) : null;

  const latestUsageTotalTokens =
    asNumber(latestUsage?.totalTokens) ??
    (() => {
      if (!latestUsage) return null;
      const input = asNumber(latestUsage.input) ?? 0;
      const output = asNumber(latestUsage.output) ?? 0;
      const cacheRead = asNumber(latestUsage.cacheRead) ?? 0;
      const cacheWrite = asNumber(latestUsage.cacheWrite) ?? 0;
      return input + output + cacheRead + cacheWrite;
    })();

  const thinkingLevel = getThinkingLevel(ctx);

  return {
    cwd: ctx.cwd,
    session_id: sessionId ?? sessionFile ?? transcriptPath,
    transcript_path: transcriptPath,
    effort: thinkingLevel,
    effort_level: thinkingLevel,
    model: {
      id: asString(model.id),
      display_name:
        asString(model.displayName) ??
        asString(model.name) ??
        asString(model.id),
      provider: asString(model.provider),
    },
    workspace: {
      current_dir: ctx.cwd,
      project_dir: ctx.cwd,
    },
    terminal: {
      // Width of the terminal the statusline renders into, so the command can
      // budget adaptive segments (e.g. the path). Approximate: widget padding
      // is not subtracted, and a resize is only seen on the next refresh.
      width: asNumber(process.stdout.columns) ?? null,
    },
    version: null,
    output_style: {
      name: "default",
    },
    cost: {
      total_cost_usd: analysis.totalCostUsd,
      total_duration_ms: analysis.totalDurationMs,
      latest_request_duration_ms: analysis.latestRequestDurationMs,
      total_api_duration_ms: null,
      total_lines_added: null,
      total_lines_removed: null,
    },
    context_window: {
      total_input_tokens: analysis.totalInputTokens,
      total_output_tokens: analysis.totalOutputTokens,
      total_cache_read_tokens: analysis.totalCacheReadTokens,
      total_cache_write_tokens: analysis.totalCacheWriteTokens,
      context_window_size: contextWindowSize,
      used_percentage: usedPercentage,
      remaining_percentage: remainingPercentage,
      current_usage: currentUsage,
      usage_source: analysis.awaitingUsageAfterCompaction
        ? estimatedTokens === null ? "pending" : "estimate"
        : currentUsage ? "usage" : null,
      estimated_tokens: estimatedTokens,
      cache: cacheMetrics,
    },
    exceeds_200k_tokens: (estimatedTokens ?? latestUsageTotalTokens ?? 0) > 200000,
    rate_limits: null,
    vim: null,
    agent: null,
    worktree: null,
    pi: {
      session_file: sessionFile,
      session_started_at_ms: analysis.sessionStartedAtMs,
      refreshed_at_ms: Date.now(),
      todo,
    },
  };
}
