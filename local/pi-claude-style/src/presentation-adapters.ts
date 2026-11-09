import type {
  ToolActivity,
  ToolGroupSnapshot,
  ToolGroupTone,
  ToolPresentation,
} from "./types.ts";
import {
  classifyTool,
  formatCurrentActivity as fallbackActivity,
  formatMcpActivity,
  summarizeGroup as fallbackGroup,
} from "./semantics.ts";

export interface ToolPresentationInput {
  toolName: string;
  args: unknown;
}

/**
 * One independently testable presentation policy.
 *
 * Returning undefined declines that part of presentation and lets the next
 * adapter or the generic fallback handle it. Adapters never mutate args,
 * results, ToolDefinitions or session history.
 */
export interface ToolPresentationAdapter {
  id: string;
  priority?: number;
  match(input: ToolPresentationInput): boolean;
  presentation?(input: ToolPresentationInput): ToolPresentation | undefined;
  formatActivity?(activity: ToolActivity): string | undefined;
  summarizeGroup?(group: ToolGroupSnapshot): string | undefined;
  groupTone?(group: ToolGroupSnapshot): ToolGroupTone | undefined;
}

export interface PresentationInstrumentation {
  measure<T>(name: string, action: () => T, detail?: string): T;
  increment(name: string, delta?: number): void;
}

export interface ToolPresentationFallbacks {
  resolve(toolName: string, args: unknown): ToolPresentation;
  formatActivity(activity: ToolActivity): string;
  summarizeGroup(group: ToolGroupSnapshot): string;
  groupTone?(group: ToolGroupSnapshot): ToolGroupTone | undefined;
}

function objectKey(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * Ordered adapter registry with identity caches suited to GroupStore snapshots.
 * Cache entries disappear with their args/activity/group objects; no session-
 * length name or payload index is retained.
 */
export class ToolPresentationRegistry {
  private adapters: ToolPresentationAdapter[] = [];
  private presentationCache = new WeakMap<object, Map<string, ToolPresentation>>();
  private activityCache = new WeakMap<ToolActivity, string>();
  private groupCache = new WeakMap<ToolGroupSnapshot, string>();
  private groupToneCache = new WeakMap<ToolGroupSnapshot, ToolGroupTone | null>();
  private readonly fallbacks: ToolPresentationFallbacks;
  private readonly instrumentation?: PresentationInstrumentation;

  constructor(
    fallbacks: ToolPresentationFallbacks,
    instrumentation?: PresentationInstrumentation,
  ) {
    this.fallbacks = fallbacks;
    this.instrumentation = instrumentation;
  }

  register(adapter: ToolPresentationAdapter): () => void {
    if (!adapter.id.trim()) throw new Error("presentation adapter id is required");
    if (this.adapters.some((candidate) => candidate.id === adapter.id)) {
      throw new Error(`duplicate presentation adapter: ${adapter.id}`);
    }
    this.adapters.push(adapter);
    this.adapters.sort((left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0)
    );
    this.clearCaches();
    return () => {
      const index = this.adapters.indexOf(adapter);
      if (index < 0) return;
      this.adapters.splice(index, 1);
      this.clearCaches();
    };
  }

  resolve(toolName: string, args: unknown): ToolPresentation {
    const key = objectKey(args);
    const cached = key ? this.presentationCache.get(key)?.get(toolName) : undefined;
    if (cached) {
      this.count("resolve.cache-hit");
      return cached;
    }
    this.count("resolve.cache-miss");
    const resolved = this.measure("resolve", () => {
      const input = { toolName, args };
      for (const adapter of this.adapters) {
        if (!adapter.presentation || !this.matches(adapter, input)) continue;
        const value = this.call(adapter, "resolve", () => adapter.presentation?.(input));
        if (!value) continue;
        this.hit(adapter, "resolve");
        return value;
      }
      this.count("resolve.fallback");
      return this.fallbacks.resolve(toolName, args);
    });
    if (key) {
      let byName = this.presentationCache.get(key);
      if (!byName) {
        byName = new Map();
        this.presentationCache.set(key, byName);
      }
      byName.set(toolName, resolved);
    }
    return resolved;
  }

  formatActivity(activity: ToolActivity): string {
    const cached = this.activityCache.get(activity);
    if (cached !== undefined) {
      this.count("activity.cache-hit");
      return cached;
    }
    this.count("activity.cache-miss");
    const formatted = this.measure("activity", () => {
      const input = { toolName: activity.toolName, args: activity.args };
      for (const adapter of this.adapters) {
        if (!adapter.formatActivity || !this.matches(adapter, input)) continue;
        const value = this.call(
          adapter,
          "activity",
          () => adapter.formatActivity?.(activity),
        );
        if (!value) continue;
        this.hit(adapter, "activity");
        return value;
      }
      this.count("activity.fallback");
      return this.fallbacks.formatActivity(activity);
    });
    this.activityCache.set(activity, formatted);
    return formatted;
  }

  summarizeGroup(group: ToolGroupSnapshot): string {
    const cached = this.groupCache.get(group);
    if (cached !== undefined) {
      this.count("group.cache-hit");
      return cached;
    }
    this.count("group.cache-miss");
    const summary = this.measure("group", () => {
      for (const adapter of this.adapters) {
        if (!adapter.summarizeGroup) continue;
        const value = this.call(
          adapter,
          "group",
          () => adapter.summarizeGroup?.(group),
        );
        if (!value) continue;
        this.hit(adapter, "group");
        return value;
      }
      this.count("group.fallback");
      return this.fallbacks.summarizeGroup(group);
    });
    this.groupCache.set(group, summary);
    return summary;
  }

  groupTone(group: ToolGroupSnapshot): ToolGroupTone | undefined {
    const cached = this.groupToneCache.get(group);
    if (cached !== undefined) {
      this.count("tone.cache-hit");
      return cached ?? undefined;
    }
    this.count("tone.cache-miss");
    const tone = this.measure("tone", () => {
      for (const adapter of this.adapters) {
        if (!adapter.groupTone) continue;
        const value = this.call(
          adapter,
          "tone",
          () => adapter.groupTone?.(group),
        );
        if (!value) continue;
        this.hit(adapter, "tone");
        return value;
      }
      this.count("tone.fallback");
      return this.fallbacks.groupTone?.(group);
    });
    this.groupToneCache.set(group, tone ?? null);
    return tone;
  }

  private matches(
    adapter: ToolPresentationAdapter,
    input: ToolPresentationInput,
  ): boolean {
    return this.call(adapter, "match", () => adapter.match(input)) === true;
  }

  private call<T>(
    adapter: ToolPresentationAdapter,
    operation: string,
    action: () => T,
  ): T | undefined {
    try {
      return action();
    } catch {
      this.count(`adapter.${adapter.id}.${operation}.error`);
      return undefined;
    }
  }

  private hit(adapter: ToolPresentationAdapter, operation: string): void {
    this.count(`adapter.${adapter.id}.${operation}.hit`);
  }

  private count(suffix: string): void {
    this.instrumentation?.increment(`cc-style.presentation.${suffix}`);
  }

  private measure<T>(operation: string, action: () => T): T {
    return this.instrumentation
      ? this.instrumentation.measure(
        `cc-style.presentation.${operation}`,
        action,
      )
      : action();
  }

  private clearCaches(): void {
    this.presentationCache = new WeakMap();
    this.activityCache = new WeakMap();
    this.groupCache = new WeakMap();
    this.groupToneCache = new WeakMap();
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const inline = value.replace(/\s+/g, " ").trim();
    if (inline) return inline;
  }
  return undefined;
}

function ellipsize(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function finishSummary(
  group: ToolGroupSnapshot,
  running: string,
  completed: string,
): string {
  let summary = group.status === "collecting" ? running : completed;
  if (group.failureCount > 0) summary += ` · ${group.failureCount} failed`;
  if (group.status === "cancelled") summary += " · cancelled";
  return summary;
}

function allKind(group: ToolGroupSnapshot, kind: ReturnType<typeof classifyTool>): boolean {
  return group.activities.length > 0 &&
    group.activities.every((activity) => classifyTool(activity.toolName) === kind);
}

function noun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function processGroupAction(group: ToolGroupSnapshot): string | undefined {
  if (!allKind(group, "process")) return undefined;
  const actions = new Set(
    group.activities.map((activity) =>
      firstString(record(activity.args), ["action", "operation", "command"])
        ?.toLowerCase()
    ),
  );
  if (actions.size !== 1) return undefined;
  return [...actions][0];
}

function processActivityName(activity: ToolActivity): string | undefined {
  const details = record(activity.result?.details);
  const process = record(details.process);
  const data = record(details.data);
  const dataProcess = record(data.process);
  const result = record(details.result);
  const resultInfo = record(result.info);
  const args = record(activity.args);
  const target = record(args.target);
  return firstString(process, ["name"])
    ?? firstString(dataProcess, ["name"])
    ?? firstString(resultInfo, ["name"])
    ?? firstString(details, ["processName"])
    ?? firstString(args, ["name"])
    ?? (typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined)
    ?? firstString(target, ["name", "id"])
    ?? firstString(args, ["id", "processId", "process_id"]);
}

function quotedProcessName(name: string): string {
  return `'${ellipsize(name, 48).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function processSubject(group: ToolGroupSnapshot): string {
  const names = [...new Set(
    group.activities
      .map(processActivityName)
      .filter((name): name is string => Boolean(name)),
  )];
  if (names.length === 1) return `Process ${quotedProcessName(names[0]!)}`;
  if (names.length === 2) {
    return `Processes ${names.map(quotedProcessName).join(", ")}`;
  }
  return noun(group.activities.length, "process", "processes");
}

function finishProcessState(
  group: ToolGroupSnapshot,
  running: string,
  completed: string,
  failed: string,
  cancelled: string,
): string {
  if (group.status === "collecting") {
    return group.failureCount > 0
      ? `${running} · ${group.failureCount} failed`
      : running;
  }
  if (group.status === "cancelled") return cancelled;
  if (group.failureCount === group.activities.length) return failed;
  return group.failureCount > 0
    ? `${completed} · ${group.failureCount} failed`
    : completed;
}

function processGroupSummary(group: ToolGroupSnapshot): string {
  const count = group.activities.length;
  const subject = processSubject(group);
  switch (processGroupAction(group)) {
    case "start":
      return finishProcessState(
        group,
        `${subject} starting`,
        `${subject} started`,
        `${subject} failed to start`,
        `${subject} start cancelled`,
      );
    case "stop":
      return finishProcessState(
        group,
        `${subject} stopping`,
        `${subject} stopped`,
        `${subject} failed to stop`,
        `${subject} stop cancelled`,
      );
    case "list":
      return finishSummary(group, "Listing processes", "Listed processes");
    case "output":
      return finishProcessState(
        group,
        `${subject} output loading`,
        `${subject} output read`,
        `${subject} output failed`,
        `${subject} output cancelled`,
      );
    case "logs":
      return finishProcessState(
        group,
        `${subject} logs loading`,
        `${subject} logs read`,
        `${subject} logs failed`,
        `${subject} logs cancelled`,
      );
    case "write":
    case "input":
      return finishProcessState(
        group,
        `${subject} receiving input`,
        `${subject} received input`,
        `${subject} input failed`,
        `${subject} input cancelled`,
      );
    case "update":
    case "configure":
      return finishProcessState(
        group,
        `${subject} updating`,
        `${subject} updated`,
        `${subject} update failed`,
        `${subject} update cancelled`,
      );
    case "clear":
      return finishSummary(
        group,
        "Clearing finished processes",
        "Cleared finished processes",
      );
    default:
      return finishSummary(
        group,
        `Managing ${noun(count, "process operation", "process operations")}`,
        `Managed ${noun(count, "process operation", "process operations")}`,
      );
  }
}

export const processPresentationAdapter: ToolPresentationAdapter = {
  id: "process",
  priority: 100,
  match: ({ toolName }) => classifyTool(toolName) === "process",
  formatActivity(activity) {
    const args = record(activity.args);
    const action = firstString(args, ["action", "operation", "command"])
      ?.toLowerCase();
    const target = processActivityName(activity);
    const subject = target ? `Process ${quotedProcessName(target)}` : "Process";
    const running = activity.status === "running";
    const failed = activity.status === "failed";
    const cancelled = activity.status === "cancelled";
    switch (action) {
      case "start":
        return running ? `${subject} starting` : failed
          ? `${subject} failed to start`
          : cancelled ? `${subject} start cancelled` : `${subject} started`;
      case "stop":
        return running ? `${subject} stopping` : failed
          ? `${subject} failed to stop`
          : cancelled ? `${subject} stop cancelled` : `${subject} stopped`;
      case "list": return running ? "Listing processes" : "Listed processes";
      case "output":
        return running ? `${subject} output loading` : failed
          ? `${subject} output failed`
          : cancelled ? `${subject} output cancelled` : `${subject} output read`;
      case "logs":
        return running ? `${subject} logs loading` : failed
          ? `${subject} logs failed`
          : cancelled ? `${subject} logs cancelled` : `${subject} logs read`;
      case "write":
      case "input":
        return running ? `${subject} receiving input` : failed
          ? `${subject} input failed`
          : cancelled ? `${subject} input cancelled` : `${subject} received input`;
      case "update":
      case "configure":
        return running ? `${subject} updating` : failed
          ? `${subject} update failed`
          : cancelled ? `${subject} update cancelled` : `${subject} updated`;
      case "clear": return running ? "Clearing finished processes" : "Cleared finished processes";
      default: return action ? `${subject} ${action}` : `Run ${activity.toolName}`;
    }
  },
  summarizeGroup(group) {
    if (!allKind(group, "process")) return undefined;
    return processGroupSummary(group);
  },
  groupTone(group) {
    switch (processGroupAction(group)) {
      case "start":
        return group.failureCount > 0 ? "error" : "customMessageLabel";
      case "stop":
        return group.failureCount > 0 ? "error" : undefined;
      default: return undefined;
    }
  },
};

function subagentWeight(activity: ToolActivity): number {
  const args = record(activity.args);
  if (Array.isArray(args.targets)) return Math.max(1, args.targets.length);
  if (Array.isArray(args.tasks)) return Math.max(1, args.tasks.length);
  if (Array.isArray(args.chain)) return Math.max(1, args.chain.length);
  return 1;
}

function quotedAgent(value: string): string {
  return `'${ellipsize(value, 80).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function agentTargets(args: Record<string, unknown>): string[] {
  return Array.isArray(args.targets)
    ? args.targets.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function targetList(targets: readonly string[]): string {
  if (targets.length === 0) return "unknown agent";
  const visible = targets.slice(0, 3).map(quotedAgent).join(", ");
  return targets.length <= 3 ? visible : `${visible}, +${targets.length - 3}`;
}

function activityFailed(activity: ToolActivity): boolean {
  if (activity.status === "failed" || activity.result?.isError) return true;
  const details = record(activity.result?.details);
  const text = activity.result?.text.trim() ?? "";
  return details.outcome === "rejected" || details.error !== undefined ||
    /^(?:goal completion rejected|goal_blocked rejected|failed:|invalid task:|scheduler error:)/iu.test(text);
}

function activityState(
  activity: ToolActivity,
  forms: { running: string; completed: string; failed: string; cancelled: string },
): string {
  if (activity.status === "running") return forms.running;
  if (activity.status === "cancelled") return forms.cancelled;
  if (activityFailed(activity)) return forms.failed;
  return forms.completed;
}

function detail(value: string | undefined): string {
  return value ? ` — ${quotedAgent(value)}` : "";
}

function spawnedModel(activity: ToolActivity): string | undefined {
  // Subagents register.ts returns ToolResultV1 in details; host/core.ts fills
  // data.model and data.reasoning_effort from the frozen profile. Only this
  // versioned spawn success proves identity; drift/missing data stays Spawning/
  // Spawned, never inferred from requested args or the current Main model.
  const details = record(activity.result?.details);
  if (details.version !== 1 || details.tool !== "spawn_agent" || details.outcome !== "ok") return undefined;
  const data = record(details.data);
  const model = data.model;
  if (typeof model !== "string" || !/^[^\s/]+\/[^\s]+$/u.test(model)) return undefined;
  const effort = data.reasoning_effort;
  return typeof effort === "string" && /^(?:off|minimal|low|medium|high|xhigh|max)$/u.test(effort)
    ? `${model}@${effort}`
    : model;
}

function agentActivity(activity: ToolActivity, includeDetail = true): string {
  const args = record(activity.args);
  const name = activity.toolName.toLowerCase();
  const target = firstString(args, ["target", "task_path", "agent_id"]);
  const taskName = firstString(args, ["task_name", "name"]);
  const task = firstString(args, ["message", "task", "description", "prompt"]);
  const query = firstString(args, ["query"]);
  const suffix = includeDetail ? detail(task) : "";
  switch (name) {
    case "spawn_agent": {
      const subject = `agent ${quotedAgent(taskName ?? "unnamed")}`;
      const model = spawnedModel(activity);
      const delegate = model ? `Delegate to ${model} · ` : "";
      return activityState(activity, {
        running: `${delegate}${model ? "spawning" : "Spawning"} ${subject}${suffix}`,
        completed: `${delegate}${model ? "spawned" : "Spawned"} ${subject}${suffix}`,
        failed: `Failed to spawn ${subject}${suffix}`,
        cancelled: `Agent spawn cancelled for ${quotedAgent(taskName ?? "unnamed")}${suffix}`,
      });
    }
    case "send_message": {
      const subject = `mailbox message to ${quotedAgent(target ?? "unknown")}`;
      return activityState(activity, {
        running: `Sending ${subject}${suffix}`,
        completed: `Sent ${subject}${suffix}`,
        failed: `Failed to send ${subject}${suffix}`,
        cancelled: `Mailbox message cancelled for ${quotedAgent(target ?? "unknown")}${suffix}`,
      });
    }
    case "followup_task": {
      const subject = `follow-up task for ${quotedAgent(target ?? "unknown")}`;
      return activityState(activity, {
        running: `Queueing ${subject}${suffix}`,
        completed: `Queued ${subject}${suffix}`,
        failed: `Failed to queue ${subject}${suffix}`,
        cancelled: `Follow-up task cancelled for ${quotedAgent(target ?? "unknown")}${suffix}`,
      });
    }
    case "wait_agents": {
      const targets = agentTargets(args);
      const subject = targets.length === 1
        ? `agent ${targetList(targets)}`
        : `agents ${targetList(targets)}`;
      return activityState(activity, {
        running: `Waiting for ${subject}`,
        completed: `Waited for ${subject}`,
        failed: `Wait failed for ${subject}`,
        cancelled: `Wait cancelled for ${subject}`,
      });
    }
    case "interrupt_agent": {
      const subject = `agent ${quotedAgent(target ?? "unknown")}`;
      return activityState(activity, {
        running: `Interrupting ${subject}`,
        completed: `Interrupted ${subject}`,
        failed: `Failed to interrupt ${subject}`,
        cancelled: `Agent interrupt cancelled for ${quotedAgent(target ?? "unknown")}`,
      });
    }
    case "list_agents": {
      const prefix = firstString(args, ["path_prefix"]);
      const scope = prefix ? ` under ${quotedAgent(prefix)}` : "";
      return activityState(activity, {
        running: `Listing agents${scope}`,
        completed: `Listed agents${scope}`,
        failed: `Failed to list agents${scope}`,
        cancelled: `Agent listing cancelled${scope}`,
      });
    }
    case "list_subagent_models": {
      const scope = query ? ` for ${quotedAgent(query)}` : "";
      return activityState(activity, {
        running: `Searching subagent models${scope}`,
        completed: `Searched subagent models${scope}`,
        failed: `Failed to search subagent models${scope}`,
        cancelled: `Subagent model search cancelled${scope}`,
      });
    }
    case "list_subagent_roles": {
      const scope = query ? ` for ${quotedAgent(query)}` : "";
      return activityState(activity, {
        running: `Searching subagent roles${scope}`,
        completed: `Searched subagent roles${scope}`,
        failed: `Failed to search subagent roles${scope}`,
        cancelled: `Subagent role search cancelled${scope}`,
      });
    }
    default: {
      const count = subagentWeight(activity);
      const subject = count > 1
        ? noun(count, "agent")
        : task ? `agent ${quotedAgent(task)}` : "1 agent";
      const taskSuffix = count > 1 && includeDetail ? detail(task) : "";
      return activityState(activity, {
        running: `Delegating ${subject}${taskSuffix}`,
        completed: `Delegated ${subject}${taskSuffix}`,
        failed: `Failed to delegate ${subject}${taskSuffix}`,
        cancelled: `Agent delegation cancelled for ${subject}${taskSuffix}`,
      });
    }
  }
}

function lowerInitial(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function agentSummary(group: ToolGroupSnapshot): string | undefined {
  if (!allKind(group, "subagent")) return undefined;
  return group.activities
    .map((activity, index) => {
      const value = agentActivity(activity, true);
      return index === 0 ? value : lowerInitial(value);
    })
    .join(", ");
}

export const subagentPresentationAdapter: ToolPresentationAdapter = {
  id: "subagent",
  priority: 90,
  match: ({ toolName }) => classifyTool(toolName) === "subagent",
  formatActivity: agentActivity,
  summarizeGroup: agentSummary,
};

const WORKFLOW_TOOL_NAMES = new Set([
  "goal_complete",
  "goal_blocked",
  "plan_mode_question",
  "plan_mode_complete",
  "finish_task",
  "schedule_task",
]);

function workflowActivity(activity: ToolActivity): string {
  const args = record(activity.args);
  const name = activity.toolName.toLowerCase();
  const summary = firstString(args, ["summary", "reason", "question", "plan", "text"]);
  const suffix = detail(summary);
  switch (name) {
    case "goal_complete":
      return activityState(activity, {
        running: `Completing goal${suffix}`,
        completed: `Completed goal${suffix}`,
        failed: `Goal completion rejected${suffix}`,
        cancelled: `Goal completion cancelled${suffix}`,
      });
    case "goal_blocked":
      return activityState(activity, {
        running: `Blocking goal${suffix}`,
        completed: `Blocked goal${suffix}`,
        failed: `Goal block rejected${suffix}`,
        cancelled: `Goal block cancelled${suffix}`,
      });
    case "plan_mode_question":
      return activityState(activity, {
        running: `Asking plan question${suffix}`,
        completed: `Asked plan question${suffix}`,
        failed: `Plan question failed${suffix}`,
        cancelled: `Plan question cancelled${suffix}`,
      });
    case "plan_mode_complete":
      return activityState(activity, {
        running: `Finalizing plan${suffix}`,
        completed: `Plan ready${suffix}`,
        failed: `Plan finalization failed${suffix}`,
        cancelled: `Plan finalization cancelled${suffix}`,
      });
    case "finish_task": {
      const outcome = firstString(args, ["outcome"]);
      const reason = firstString(args, ["reason"]);
      const subject = outcome === "blocked" ? "blocked task" : "partial task result";
      const reasonSuffix = reason ? ` — ${reason}` : "";
      return activityState(activity, {
        running: `Reporting ${subject}${reasonSuffix}`,
        completed: `Reported ${subject}${reasonSuffix}`,
        failed: `Failed to report ${subject}`,
        cancelled: "Task report cancelled",
      });
    }
    case "schedule_task": {
      const action = firstString(args, ["action"]) ?? "manage";
      const identity = firstString(args, action === "create" ? ["title"] : ["id"]);
      const subject = identity ? ` ${quotedAgent(identity)}` : "";
      const forms: Record<string, { running: string; completed: string; failed: string; cancelled: string }> = {
        create: { running: `Scheduling task${subject}`, completed: `Scheduled task${subject}`, failed: `Failed to schedule task${subject}`, cancelled: `Task scheduling cancelled${subject}` },
        list: { running: "Listing scheduled tasks", completed: "Listed scheduled tasks", failed: "Failed to list scheduled tasks", cancelled: "Scheduled-task listing cancelled" },
        cancel: { running: `Cancelling scheduled task${subject}`, completed: `Cancelled scheduled task${subject}`, failed: `Failed to cancel scheduled task${subject}`, cancelled: `Scheduled-task cancellation interrupted${subject}` },
        pause: { running: `Pausing scheduled task${subject}`, completed: `Paused scheduled task${subject}`, failed: `Failed to pause scheduled task${subject}`, cancelled: `Scheduled-task pause cancelled${subject}` },
        resume: { running: `Resuming scheduled task${subject}`, completed: `Resumed scheduled task${subject}`, failed: `Failed to resume scheduled task${subject}`, cancelled: `Scheduled-task resume cancelled${subject}` },
        runNow: { running: `Running scheduled task${subject} now`, completed: `Ran scheduled task${subject}`, failed: `Failed to run scheduled task${subject}`, cancelled: `Scheduled-task run cancelled${subject}` },
      };
      return activityState(activity, forms[action] ?? {
        running: "Managing scheduled task",
        completed: "Managed scheduled task",
        failed: "Scheduled-task operation failed",
        cancelled: "Scheduled-task operation cancelled",
      });
    }
    default:
      return activity.toolName;
  }
}

export const workflowPresentationAdapter: ToolPresentationAdapter = {
  id: "workflow",
  priority: 95,
  match: ({ toolName }) => WORKFLOW_TOOL_NAMES.has(toolName.toLowerCase()),
  formatActivity: workflowActivity,
  summarizeGroup(group) {
    if (!group.activities.every((activity) => WORKFLOW_TOOL_NAMES.has(activity.toolName.toLowerCase()))) return undefined;
    return group.activities.map(workflowActivity).join(", ");
  },
};

function friendlyMcpName(toolName: string): string {
  return toolName
    .replace(/^mcp__/, "")
    .replace(/^mcp_/, "")
    .replace(/__/g, ".");
}

export const directToolPresentationAdapter: ToolPresentationAdapter = {
  id: "direct-tools",
  priority: 110,
  match: ({ toolName }) => ["ask_user_question", "web_fetch"].includes(toolName.toLowerCase()),
  formatActivity(activity) {
    const name = activity.toolName.toLowerCase();
    const args = record(activity.args);
    const terminal = activity.status !== "running";
    if (name === "ask_user_question") {
      const count = Array.isArray(args.questions) ? args.questions.length : 1;
      return `${terminal ? "Asked" : "Ask"} ${noun(count, "question")}`;
    }
    if (name === "web_fetch") {
      const url = firstString(args, ["url"]);
      return `${terminal ? "Fetched" : "Fetch"}${url ? ` ${ellipsize(url, 100)}` : " web page"}`;
    }
    return undefined;
  },
  summarizeGroup(group) {
    if (group.activities.length !== 1) return undefined;
    const activity = group.activities[0]!;
    const name = activity.toolName.toLowerCase();
    if (!["ask_user_question", "web_fetch"].includes(name)) return undefined;
    return directToolPresentationAdapter.formatActivity?.(activity);
  },
};

function mcpActivity(activity: ToolActivity): string {
  const args = record(activity.args);
  const details = record(activity.result?.details);
  // Namespace proxy and deferred direct results carry the same canonical identity.
  const identity = firstString(details, ["canonicalTool", "tool"]);
  const formatted = formatMcpActivity(activity.toolName,
    !firstString(args, ["tool"]) && identity &&
      (details.mode === "call" || activity.toolName.startsWith("mcp__"))
      ? { ...args, tool: identity } : args);
  if (activity.status === "running") {
    return formatted
      .replace(/^Call\b/u, "Calling")
      .replace(/^MCP search\b/u, "Searching MCP tools for")
      .replace(/^MCP describe\b/u, "Describing MCP tool")
      .replace(/^MCP connect\b/u, "Connecting MCP server")
      .replace(/^MCP instructions\b/u, "Reading MCP instructions for")
      .replace(/^MCP script\b/u, "Running MCP script");
  }
  const completed = formatted
    .replace(/^Call\b/u, "Called")
    .replace(/^MCP search\b/u, "Searched MCP tools for")
    .replace(/^MCP describe\b/u, "Described MCP tool")
    .replace(/^MCP connect\b/u, "Connected MCP server")
    .replace(/^MCP instructions\b/u, "Read MCP instructions for")
    .replace(/^MCP script\b/u, "Ran MCP script");
  if (activity.status === "cancelled") return `${completed} · cancelled`;
  if (activityFailed(activity)) return `${completed} · failed`;
  return completed;
}

export const mcpPresentationAdapter: ToolPresentationAdapter = {
  id: "mcp",
  priority: 80,
  match: ({ toolName }) => classifyTool(toolName) === "mcp",
  formatActivity: mcpActivity,
  summarizeGroup(group) {
    if (!allKind(group, "mcp")) return undefined;
    if (group.activities.length === 1) {
      return mcpActivity(group.activities[0]!);
    }
    const count = group.activities.length;
    return finishSummary(
      group,
      `Calling ${noun(count, "MCP tool")}`,
      `Called ${noun(count, "MCP tool")}`,
    );
  },
};

export function createDefaultToolPresentationRegistry(
  resolve: (toolName: string, args: unknown) => ToolPresentation,
  instrumentation?: PresentationInstrumentation,
): ToolPresentationRegistry {
  const registry = new ToolPresentationRegistry(
    {
      resolve,
      formatActivity: fallbackActivity,
      summarizeGroup: fallbackGroup,
    },
    instrumentation,
  );
  registry.register(directToolPresentationAdapter);
  registry.register(processPresentationAdapter);
  registry.register(workflowPresentationAdapter);
  registry.register(subagentPresentationAdapter);
  registry.register(mcpPresentationAdapter);
  return registry;
}
