import { posix } from "node:path";
import type {
  GroupingConfig,
  GroupStatus,
  ToolActivity,
  ToolGroupSnapshot,
} from "./types.ts";

export type SemanticKind =
  | "read"
  | "search"
  | "list"
  | "bash"
  | "edit"
  | "write"
  | "mcp"
  | "subagent"
  | "process"
  | "memory"
  | "note"
  | "context"
  | "todo"
  | "unknown";

const SEARCH_NAMES = new Set([
  "grep",
  "find",
  "search",
  "rg",
  "multi_grep",
]);
const READ_NAMES = new Set(["read", "read_file"]);
const LIST_NAMES = new Set(["ls", "list", "list_files"]);
const BASH_NAMES = new Set([
  "bash",
  "exec",
  "exec_command",
  "run",
  "shell",
  "shell_command",
]);
const EDIT_NAMES = new Set(["edit", "apply_patch"]);
const WRITE_NAMES = new Set(["write", "write_file"]);
const AGENT_NAMES = new Set([
  "subagent",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agents",
  "interrupt_agent",
  "list_agents",
  "list_subagent_models",
  "list_subagent_roles",
]);

/**
 * Legacy Magic Context session records retain their memory/note/context names.
 * This is presentation-only: the retired package is neither installed nor
 * imported. Without these names `ctx_search` reads as a code grep.
 */
const MEMORY_NAMES = new Set(["ctx_search", "ctx_memory"]);
const NOTE_NAMES = new Set(["ctx_note"]);
const CONTEXT_NAMES = new Set(["ctx_expand", "ctx_reduce"]);
const TODO_NAMES = new Set([
  // `@juicesharp/rpiv-todo` registers it under the bare name.
  "todo",
  "todowrite",
  "todo_write",
  "todos",
  "todoread",
  "todo_read",
]);

export function classifyTool(toolName: string): SemanticKind {
  const name = toolName.toLowerCase();
  if (
    name === "mcp" ||
    // pi-mcp-adapter's script gateway; no separator, so the patterns miss it.
    name === "mcpscript" ||
    name.startsWith("mcp__") ||
    name.includes("_mcp_") ||
    name.includes("mcp_")
  ) {
    return "mcp";
  }
  if (MEMORY_NAMES.has(name)) return "memory";
  if (NOTE_NAMES.has(name)) return "note";
  if (CONTEXT_NAMES.has(name)) return "context";
  if (TODO_NAMES.has(name)) return "todo";
  if (READ_NAMES.has(name)) return "read";
  if (SEARCH_NAMES.has(name) || name.includes("search")) return "search";
  if (LIST_NAMES.has(name)) return "list";
  if (BASH_NAMES.has(name)) return "bash";
  if (EDIT_NAMES.has(name)) return "edit";
  if (WRITE_NAMES.has(name)) return "write";
  if (name === "process" || name.startsWith("process_")) return "process";
  if (AGENT_NAMES.has(name) || name.startsWith("subagent_")) return "subagent";
  return "unknown";
}

export function isCollapsibleTool(
  toolName: string,
  config: GroupingConfig,
): boolean {
  return config[classifyTool(toolName)];
}

type MagicContextSummaryKind =
  | "context-search"
  | "memory-write"
  | "memory-list"
  | "memory-get"
  | "memory-update"
  | "memory-archive"
  | "memory-merge"
  | "note-write"
  | "smart-note-write"
  | "note-read"
  | "note-update"
  | "note-dismiss"
  | "context-expand"
  | "context-reduce";

type SummaryKind = SemanticKind | MagicContextSummaryKind
  | "memory-index-get" | "memory-index-update"
  | "subagent-model-search" | "subagent-role-search" | "agent-list";

/** pi-cc-memory owns this on-disk path grammar; no import or filesystem probe. */
function ccMemoryOperation(toolName: string, argsValue: unknown) {
  const name = toolName.toLowerCase();
  if (name !== "read" && name !== "write" && name !== "edit") return undefined;
  const rawPath = record(argsValue).path;
  if (typeof rawPath !== "string" || rawPath.includes("\0")) return undefined;
  const path = posix.normalize(rawPath.replaceAll("\\", "/"));
  const match = /(?:^|\/)pi-cc-memory\/projects\/[a-fA-F0-9]{64}\/memory\/([^/]+\.md)$/.exec(path);
  if (!match) return undefined;
  const file = match[1]!;
  const index = file === "MEMORY.md";
  const kind: SummaryKind = index
    ? name === "read" ? "memory-index-get" : "memory-index-update"
    : name === "read" ? "memory-get"
    : name === "edit" ? "memory-update" : "memory-write";
  return { kind, index, directory: path.slice(0, -file.length), topic: file.slice(0, -3) };
}

export function ccMemoryActivityPrefix(toolName: string, args: unknown): string | undefined {
  switch (ccMemoryOperation(toolName, args)?.kind) {
    case "memory-get": return "Read memory";
    case "memory-write": return "Save memory";
    case "memory-update": return "Update memory";
    case "memory-index-get": return "Read memory index";
    case "memory-index-update": return "Update memory index";
    default: return undefined;
  }
}

interface CountBucket {
  kind: SummaryKind;
  count: number;
}

function subagentWeight(activity: ToolActivity): number {
  if (activity.toolName !== "subagent") return 1;
  const args = activity.args as Record<string, unknown> | undefined;
  if (Array.isArray(args?.tasks)) return Math.max(1, args.tasks.length);
  if (Array.isArray(args?.chain)) return Math.max(1, args.chain.length);
  return 1;
}

function numericIdWeight(args: Record<string, unknown>): number {
  if (!Array.isArray(args.ids)) return 1;
  const ids = new Set(
    args.ids.filter((value): value is number =>
      typeof value === "number" && Number.isFinite(value)
    ),
  );
  return Math.max(1, ids.size);
}

function magicContextSummaryKind(
  activity: ToolActivity,
): MagicContextSummaryKind | undefined {
  const toolName = activity.toolName.toLowerCase();
  const args = record(activity.args);
  const action = firstString(args, ["action"]);
  switch (toolName) {
    case "ctx_search":
      return "context-search";
    case "ctx_memory":
      switch (action) {
        case "write": return "memory-write";
        case "list": return "memory-list";
        case "get": return "memory-get";
        case "update": return "memory-update";
        case "archive": return "memory-archive";
        case "merge": return "memory-merge";
        default: return undefined;
      }
    case "ctx_note": {
      const resolved = action ?? (firstString(args, ["content"]) ? "write" : "read");
      if (resolved === "write") {
        return firstString(args, ["surface_condition"])
          ? "smart-note-write"
          : "note-write";
      }
      if (resolved === "read") return "note-read";
      if (resolved === "update") return "note-update";
      if (resolved === "dismiss") return "note-dismiss";
      return undefined;
    }
    case "ctx_expand":
      return "context-expand";
    case "ctx_reduce":
      return "context-reduce";
    default:
      return undefined;
  }
}

function summaryKind(activity: ToolActivity): SummaryKind {
  // Discovery still uses the subagent renderer/grouping policy, but is not delegation.
  switch (activity.toolName.toLowerCase()) {
    case "list_subagent_models": return "subagent-model-search";
    case "list_subagent_roles": return "subagent-role-search";
    case "list_agents": return "agent-list";
  }
  return ccMemoryOperation(activity.toolName, activity.args)?.kind
    ?? magicContextSummaryKind(activity) ?? classifyTool(activity.toolName);
}

function summaryWeight(activity: ToolActivity, kind: SummaryKind): number {
  if (kind === "subagent") return subagentWeight(activity);
  if (
    kind === "memory-get" ||
    kind === "memory-archive" ||
    kind === "memory-merge"
  ) {
    return numericIdWeight(record(activity.args));
  }
  return 1;
}

function countKinds(activities: readonly ToolActivity[]): CountBucket[] {
  const counts = new Map<SummaryKind, number>();
  const memoryOperations = activities.map((activity) =>
    ccMemoryOperation(activity.toolName, activity.args));
  const topicDirectories = new Set(memoryOperations
    .filter((operation) => operation && !operation.index)
    .map((operation) => operation!.directory));
  for (const [index, activity] of activities.entries()) {
    const operation = memoryOperations[index];
    // Index maintenance belongs to the topics in this batch, not another memory.
    if (operation?.index && topicDirectories.has(operation.directory)) continue;
    const kind = summaryKind(activity);
    const weight = summaryWeight(activity, kind);
    counts.set(kind, (counts.get(kind) ?? 0) + weight);
  }

  const order: SummaryKind[] = [
    "search",
    "read",
    "list",
    "bash",
    "edit",
    "write",
    "subagent",
    "subagent-model-search",
    "subagent-role-search",
    "agent-list",
    "process",
    "context-search",
    "memory-write",
    "memory-list",
    "memory-get",
    "memory-update",
    "memory-archive",
    "memory-merge",
    "memory-index-get",
    "memory-index-update",
    "memory",
    "note-write",
    "smart-note-write",
    "note-read",
    "note-update",
    "note-dismiss",
    "note",
    "context-expand",
    "context-reduce",
    "context",
    "todo",
    "mcp",
    "unknown",
  ];
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

function noun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function phrase(kind: SummaryKind, count: number, running: boolean): string {
  switch (kind) {
    case "search":
      return `${running ? "searching for" : "searched for"} ${noun(count, "pattern")}`;
    case "read":
      return `${running ? "reading" : "read"} ${noun(count, "file")}`;
    case "list":
      return `${running ? "listing" : "listed"} ${noun(count, "path")}`;
    case "bash":
      return `${running ? "running" : "ran"} ${noun(count, "shell command")}`;
    case "edit":
      return `${running ? "editing" : "edited"} ${noun(count, "file")}`;
    case "write":
      return `${running ? "writing" : "wrote"} ${noun(count, "file")}`;
    case "subagent":
      return `${running ? "delegating" : "delegated"} ${noun(count, "task")}`;
    case "subagent-model-search":
      return count === 1
        ? running ? "searching subagent models" : "searched subagent models"
        : `${running ? "running" : "ran"} ${noun(count, "subagent model search", "subagent model searches")}`;
    case "subagent-role-search":
      return count === 1
        ? running ? "searching subagent roles" : "searched subagent roles"
        : `${running ? "running" : "ran"} ${noun(count, "subagent role search", "subagent role searches")}`;
    case "agent-list":
      return count === 1
        ? running ? "listing agents" : "listed agents"
        : `${running ? "running" : "ran"} ${noun(count, "agent listing")}`;
    case "process":
      return `${running ? "managing" : "managed"} ${noun(count, "process", "processes")}`;
    case "context-search":
      return count === 1
        ? running ? "searching context" : "searched context"
        : `${running ? "running" : "ran"} ${noun(count, "context search")}`;
    case "memory-write":
      return `${running ? "saving" : "saved"} ${noun(count, "memory", "memories")}`;
    case "memory-list":
      return count === 1
        ? running ? "listing memories" : "listed memories"
        : `${running ? "running" : "ran"} ${noun(count, "memory listing")}`;
    case "memory-get":
      return `${running ? "reading" : "read"} ${noun(count, "memory", "memories")}`;
    case "memory-update":
      return `${running ? "updating" : "updated"} ${noun(count, "memory", "memories")}`;
    case "memory-archive":
      return `${running ? "archiving" : "archived"} ${noun(count, "memory", "memories")}`;
    case "memory-merge":
      return `${running ? "merging" : "merged"} ${noun(count, "memory", "memories")}`;
    case "memory-index-get":
      return `${running ? "reading" : "read"} ${count === 1 ? "memory index" : noun(count, "memory index", "memory indexes")}`;
    case "memory-index-update":
      return `${running ? "updating" : "updated"} ${count === 1 ? "memory index" : noun(count, "memory index", "memory indexes")}`;
    case "memory":
      return `${running ? "working with" : "handled"} ${noun(count, "memory", "memories")}`;
    case "note-write":
      return `${running ? "saving" : "saved"} ${noun(count, "note")}`;
    case "smart-note-write":
      return `${running ? "saving" : "saved"} ${noun(count, "smart note")}`;
    case "note-read":
      return count === 1
        ? running ? "reading notes" : "read notes"
        : `${running ? "running" : "ran"} ${noun(count, "note read")}`;
    case "note-update":
      return `${running ? "updating" : "updated"} ${noun(count, "note")}`;
    case "note-dismiss":
      return `${running ? "dismissing" : "dismissed"} ${noun(count, "note")}`;
    case "note":
      return `${running ? "working with" : "handled"} ${noun(count, "note")}`;
    case "context-expand":
      return `${running ? "expanding" : "expanded"} ${noun(count, "context range")}`;
    case "context-reduce":
      return `${running ? "queueing" : "queued"} ${noun(count, "context drop")}`;
    case "context":
      return `${running ? "working with" : "handled"} ${noun(count, "context operation")}`;
    case "todo":
      return `${running ? "updating" : "updated"} ${noun(count, "todo list")}`;
    case "mcp":
      return `${running ? "calling" : "called"} ${noun(count, "MCP tool")}`;
    case "unknown":
      return `${running ? "running" : "ran"} ${noun(count, "tool")}`;
  }
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

export function summarizeGroup(group: ToolGroupSnapshot): string {
  const running = group.status === "collecting";
  const parts = countKinds(group.activities).map(({ kind, count }) =>
    phrase(kind, count, running),
  );
  let summary = capitalize(parts.join(", "));
  if (group.failureCount > 0) {
    summary += ` · ${group.failureCount} failed`;
  }
  if (group.status === "cancelled") {
    summary += " · cancelled";
  }
  return summary || (running ? "Working" : "Finished tools");
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

function quoted(value: string): string {
  return JSON.stringify(value);
}

function friendlyMcpName(toolName: string): string {
  return toolName
    .replace(/^mcp__/, "")
    .replace(/^mcp_/, "")
    .replace(/__/g, ".");
}

/**
 * The MCP activity line, argument-aware.
 *
 * pi-mcp-adapter's gateway tools carry the real target in their arguments —
 * `mcp` takes `tool`/`search`/`describe`/`connect`/`instructions`, `mcpScript`
 * takes `code` — so the tool name alone reads as a useless `Call mcp`. Named
 * `mcp__server__tool` registrations still fall through to the friendly name.
 */
export function formatMcpActivity(toolName: string, rawArgs: unknown): string {
  const args = record(rawArgs);
  const target = firstString(args, ["tool"]);
  if (target) return `Call ${target}`;
  const search = firstString(args, ["search"]);
  if (search) return `MCP search ${quoted(ellipsize(search))}`;
  const describe = firstString(args, ["describe"]);
  if (describe) return `MCP describe ${describe}`;
  const connect = firstString(args, ["connect"]);
  if (connect) return `MCP connect ${connect}`;
  const instructions = firstString(args, ["instructions"]);
  if (instructions) return `MCP instructions ${instructions}`;
  const code = firstString(args, ["code"]);
  if (code) return `MCP script ${quoted(ellipsize(code.replace(/\s+/g, " ").trim()))}`;
  return `Call ${friendlyMcpName(toolName)}`;
}

/** Workflow tools that report an outcome rather than doing work. */
const WORKFLOW_LABELS: Readonly<Record<string, string>> = {
  goal_complete: "Goal complete",
  goal_blocked: "Goal blocked",
  plan_mode_question: "Plan question",
  plan_mode_complete: "Plan ready",
};

function ellipsize(value: string, maxChars = 60): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function numericIds(args: Record<string, unknown>): number[] {
  if (!Array.isArray(args.ids)) return [];
  return [...new Set(args.ids.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value)
  ))];
}

function formatMemoryIds(args: Record<string, unknown>): string | undefined {
  const ids = numericIds(args);
  return ids.length > 0
    ? ellipsize(ids.map((id) => `#${id}`).join(", "), 60)
    : undefined;
}

const SEARCH_SOURCE_LABELS: Readonly<Record<string, string>> = {
  memory: "memories",
  message: "messages",
  git_commit: "commits",
  primer: "primers",
  note: "notes",
};

function formatSearchScope(args: Record<string, unknown>): string {
  if (!Array.isArray(args.sources)) return "context";
  const labels = args.sources
    .filter((source): source is string => typeof source === "string")
    .map((source) => SEARCH_SOURCE_LABELS[source] ?? source);
  return labels.length > 0 ? labels.join(" + ") : "context";
}

function formatDropRanges(value: string): string {
  const segments = value.replaceAll("§", "").split(",").map((part) => part.trim())
    .filter(Boolean);
  const formatted = segments.map((segment) => {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(segment);
    if (range) return `§${range[1]}§–§${range[2]}§`;
    return /^\d+$/.test(segment) ? `§${segment}§` : segment;
  });
  return ellipsize(formatted.join(", "), 60);
}

export function magicContextActivityPrefix(
  toolName: string,
  argsValue: unknown,
): string | undefined {
  const args = record(argsValue);
  const action = firstString(args, ["action"]);
  switch (toolName.toLowerCase()) {
    case "ctx_search":
      return `Search ${formatSearchScope(args)}`;
    case "ctx_memory":
      switch (action) {
        case "write": return "Save memory";
        case "list": return "List memories";
        case "get": return "Read memory";
        case "update": return "Update memory";
        case "archive": return "Archive memory";
        case "merge": return "Merge memories";
        default: return "Memory";
      }
    case "ctx_note": {
      const content = firstString(args, ["content"]);
      const resolved = action ?? (content ? "write" : "read");
      if (resolved === "write") {
        return firstString(args, ["surface_condition"])
          ? "Save smart note"
          : "Save note";
      }
      if (resolved === "read") return "Read notes";
      if (resolved === "update") return "Update note";
      if (resolved === "dismiss") return "Dismiss note";
      return "Note";
    }
    case "ctx_expand":
      return "Expand context";
    case "ctx_reduce":
      return "Queue drop";
    default:
      return undefined;
  }
}

/** Magic Context routes several operations through each tool name. */
function formatMagicContextActivity(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const action = firstString(args, ["action"]);
  switch (toolName) {
    case "ctx_search": {
      const query = firstString(args, ["query"]);
      const scope = formatSearchScope(args);
      return query
        ? `Search ${scope} ${quoted(ellipsize(query))}`
        : `Search ${scope}`;
    }
    case "ctx_memory": {
      const content = firstString(args, ["content"]);
      const ids = formatMemoryIds(args);
      switch (action) {
        case "write":
          return content ? `Save memory ${quoted(ellipsize(content))}` : "Save memory";
        case "list": {
          const category = firstString(args, ["category"]);
          return category ? `List ${category} memories` : "List memories";
        }
        case "get":
          return ids ? `Read memories ${ids}` : "Read memories";
        case "update":
          return ["Update memory", ids, content ? quoted(ellipsize(content)) : undefined]
            .filter(Boolean).join(" ");
        case "archive":
          return ids ? `Archive memories ${ids}` : "Archive memories";
        case "merge":
          return ids ? `Merge memories ${ids}` : "Merge memories";
        default:
          return action ? `Memory ${action}` : "Memory operation";
      }
    }
    case "ctx_note": {
      const content = firstString(args, ["content"]);
      const resolved = action ?? (content ? "write" : "read");
      const noteId = typeof args.note_id === "number" ? `#${args.note_id}` : undefined;
      if (resolved === "write") {
        const label = firstString(args, ["surface_condition"])
          ? "Save smart note"
          : "Save note";
        return content ? `${label} ${quoted(ellipsize(content))}` : label;
      }
      if (resolved === "read") {
        const filter = firstString(args, ["filter"]);
        return filter && filter !== "all" ? `Read ${filter} notes` : "Read notes";
      }
      if (resolved === "update") {
        return ["Update note", noteId, content ? quoted(ellipsize(content)) : undefined]
          .filter(Boolean).join(" ");
      }
      if (resolved === "dismiss") {
        return noteId ? `Dismiss note ${noteId}` : "Dismiss note";
      }
      return `Note ${resolved}`;
    }
    case "ctx_expand": {
      const message = args.message;
      if (typeof message === "number") return `Expand message §${message}§`;
      const start = args.start;
      const end = args.end;
      if (typeof start === "number" && typeof end === "number") {
        const mode = args.verbose === true ? " · verbose" : "";
        return `Expand messages §${start}§–§${end}§${mode}`;
      }
      return "Expand context";
    }
    case "ctx_reduce": {
      const drop = firstString(args, ["drop"]);
      if (!drop) return "Queue context drop";
      const ranges = formatDropRanges(drop);
      return ranges.includes(",")
        ? `Queue context drops ${ranges}`
        : `Queue context drop ${ranges}`;
    }
    default:
      return undefined;
  }
}

export function formatCurrentActivity(activity: ToolActivity): string {
  const args = record(activity.args);
  const memory = ccMemoryOperation(activity.toolName, args);
  if (memory) {
    const prefix = ccMemoryActivityPrefix(activity.toolName, args)!;
    return memory.index ? prefix : `${prefix} ${quoted(ellipsize(memory.topic))}`;
  }
  const kind = classifyTool(activity.toolName);
  const path = firstString(args, [
    "path",
    "file_path",
    "filePath",
    "directory",
    "dir",
    "cwd",
  ]);

  const magicContext = formatMagicContextActivity(
    activity.toolName.toLowerCase(),
    args,
  );
  if (magicContext) return magicContext;

  const workflow = WORKFLOW_LABELS[activity.toolName.toLowerCase()];
  if (workflow) {
    const detail = firstString(args, [
      "summary",
      "reason",
      "question",
      "plan",
      "text",
    ]);
    return detail ? `${workflow} ${quoted(ellipsize(detail))}` : workflow;
  }

  switch (kind) {
    case "bash": {
      const command = firstString(args, ["command", "cmd", "script"]);
      return command
        ? `$ ${ellipsize(command.replace(/\s+/g, " ").trim(), 100)}`
        : `Run ${activity.toolName}`;
    }
    case "read":
      return path ? `Read ${path}` : `Read with ${activity.toolName}`;
    case "search": {
      const pattern = firstString(args, [
        "pattern",
        "query",
        "search",
        "text",
      ]);
      if (pattern && path) return `Search ${quoted(pattern)} in ${path}`;
      if (pattern) return `Search ${quoted(pattern)}`;
      return path ? `Search in ${path}` : `Search with ${activity.toolName}`;
    }
    case "list":
      return `List ${path ?? "."}`;
    case "edit":
      return path ? `Edit ${path}` : `Edit with ${activity.toolName}`;
    case "write":
      return path ? `Write ${path}` : `Write with ${activity.toolName}`;
    case "mcp":
      return formatMcpActivity(activity.toolName, activity.args);
    case "subagent": {
      const task = firstString(args, [
        "task",
        "name",
        "task_name",
        "description",
        "prompt",
      ]);
      return task ? `Subagent ${task}` : `Run ${activity.toolName}`;
    }
    case "process": {
      const action = firstString(args, ["action", "operation", "command"]);
      return action ? `Process ${action}` : `Run ${activity.toolName}`;
    }
    case "todo": {
      const todos = args.todos;
      if (Array.isArray(todos)) {
        return `Update ${todos.length} todo${todos.length === 1 ? "" : "s"}`;
      }
      // rpiv-todo drives one task at a time through an `action` argument.
      const action = firstString(args, ["action"]);
      const title = firstString(args, ["title", "description", "id"]);
      if (action) return title ? `Todo ${action} ${quoted(ellipsize(title))}` : `Todo ${action}`;
      return "Update todos";
    }
    case "memory":
    case "note":
    case "context":
    case "unknown":
      return `Run ${activity.toolName}`;
  }
}

export function currentGroupActivity(
  group: ToolGroupSnapshot,
): ToolActivity | undefined {
  for (let index = group.activities.length - 1; index >= 0; index--) {
    const activity = group.activities[index];
    if (activity?.status === "running") return activity;
  }
  return undefined;
}

export function statusGlyph(status: GroupStatus): string {
  switch (status) {
    case "collecting":
      return "✳";
    case "completed":
      return "●";
    case "failed":
      return "●";
    case "cancelled":
      return "○";
  }
}
