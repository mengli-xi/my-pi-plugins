export type StatusLinePlacement = "footer" | "widget";

export interface StatusLineCommandConfig {
  type: "command";
  command: string;
  placement?: StatusLinePlacement;
  padding?: number;
  widgetPlacement?: "aboveEditor" | "belowEditor";
  debounceMs?: number;
  timeoutMs?: number;
}

export interface StatusLineSettings {
  statusLine?: Partial<StatusLineCommandConfig>;
}

export interface ClaudeLikeStatusLineInput {
  cwd: string;
  session_id: string | null;
  transcript_path: string;
  effort: string | null;
  effort_level: string | null;
  model: {
    id: string | null;
    display_name: string | null;
    provider: string | null;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
  };
  terminal: {
    /** Terminal width at payload time; null when stdout is not a tty. */
    width: number | null;
  };
  version: string | null;
  output_style: {
    name: string | null;
  };
  cost: {
    total_cost_usd: number | null;
    total_duration_ms: number | null;
    latest_request_duration_ms: number | null;
    total_api_duration_ms: number | null;
    total_lines_added: number | null;
    total_lines_removed: number | null;
  };
  context_window: {
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_cache_read_tokens: number | null;
    total_cache_write_tokens: number | null;
    context_window_size: number | null;
    used_percentage: number | null;
    remaining_percentage: number | null;
    /** Estimate covers Pi's projected conversation, not provider prompt overhead. */
    usage_source?: "usage" | "estimate" | "pending" | null;
    estimated_tokens?: number | null;
    current_usage: {
      input_tokens: number | null;
      output_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
    } | null;
    /**
     * Prompt-cache metrics derived from the current branch.
     * Survives /reload because they come from session branch analysis, not live context estimate.
     * Null after compaction until a new measured request is available.
     */
    cache: {
      /** CH: cacheRead / (input + cacheRead + cacheWrite) */
      hit_percent: number | null;
      /** Previous-prompt reuse: cacheRead / min(prev_prompt, curr_prompt) */
      reuse_percent: number | null;
      /** Tokens from the previous prompt that were not cache-read this turn */
      miss_tokens: number | null;
      prev_prompt_tokens: number | null;
      latest_prompt_tokens: number | null;
    } | null;
  };
  exceeds_200k_tokens: boolean;
  rate_limits: unknown | null;
  vim: { mode: string | null } | null;
  agent: { name: string | null } | null;
  worktree: {
    name: string | null;
    path: string | null;
    branch: string | null;
    original_cwd: string | null;
    original_branch: string | null;
  } | null;
  pi: {
    session_file: string | null;
    /** Timestamp of the first entry on the active session path. */
    session_started_at_ms: number | null;
    refreshed_at_ms: number;
    todo: {
      total: number;
      completed: number;
      in_progress: number;
      pending: number;
    } | null;
  };
}
