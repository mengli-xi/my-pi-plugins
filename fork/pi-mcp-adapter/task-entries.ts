import type { SerializedTaskReference } from "@modelcontextprotocol/ext-tasks/client";
import type { NativeMailMessage } from "pi-session-inject/mailbox-v1/light";
// Type-only, so index.ts can scan a session without loading the task runtime.
import type { HandedOffTask } from "./task-jobs.ts";

export const MCP_TASK_CUSTOM_TYPE = "mcp-task-v1";
export const MCP_TASK_RESULT_TYPE = "mcp-task-result";

export interface TaskDeliveryOrigin {
  deliveryId: string;
  anchorEntryId: string | null;
  /** A stale tree cannot use a shared ancestor to adopt an unaccepted result/reference. */
  scope?: "branch" | "origin-leaf";
}

/** A rendered outcome, frozen before transport acceptance. Recovery only puts these bytes. */
export interface FrozenTaskResult extends TaskDeliveryOrigin {
  key: string;
  server: string;
  tool: string;
  message: NativeMailMessage;
}

export type McpTaskEntryV1 = {
  version: 1;
  kind: "pending";
  sessionId: string;
  key: string;
  server: string;
  tool: string;
  reference: {
    endpointId: string;
    generation: "v2";
    taskId: string;
    originalOperation: string;
  };
  deliveryId?: string;
  anchorEntryId?: string | null;
  scope?: "branch" | "origin-leaf";
};

type ResultEntry = FrozenTaskResult & { version: 1; kind: "result"; sessionId: string };
type AcceptedEntry = TaskDeliveryOrigin & { version: 1; kind: "accepted"; sessionId: string; key: string };
export interface TaskCheckpoint {
  pending: readonly HandedOffTask[];
  results: readonly FrozenTaskResult[];
}
type CheckpointEntry = { version: 1; kind: "checkpoint"; sessionId: string; items: Array<McpTaskEntryV1 | ResultEntry> };
const PENDING_KEYS = ["version", "kind", "sessionId", "key", "server", "tool", "reference"] as const;
const REFERENCE_KEYS = ["endpointId", "generation", "taskId", "originalOperation"] as const;
const RESULT_KEYS = ["version", "kind", "sessionId", "key", "server", "tool", "deliveryId", "anchorEntryId", "message"] as const;
const ACCEPTED_KEYS = ["version", "kind", "sessionId", "key", "deliveryId", "anchorEntryId"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOrigin(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.deliveryId) && (value.anchorEntryId === null || isNonEmptyString(value.anchorEntryId));
}

function hasScope(value: Record<string, unknown>): boolean {
  return value.scope === "branch" || value.scope === "origin-leaf";
}

function isTaskEntry(value: unknown): value is McpTaskEntryV1 {
  if (!isRecord(value) || value.version !== 1 || value.kind !== "pending"
    || !(hasExactKeys(value, PENDING_KEYS)
      || hasExactKeys(value, [...PENDING_KEYS, "deliveryId", "anchorEntryId"]) && hasOrigin(value)
      || hasExactKeys(value, [...PENDING_KEYS, "deliveryId", "anchorEntryId", "scope"]) && hasOrigin(value) && hasScope(value))) return false;
  const reference = value.reference;
  return isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.server)
    && isNonEmptyString(value.tool)
    && isRecord(reference)
    && hasExactKeys(reference, REFERENCE_KEYS)
    && reference.generation === "v2"
    && isNonEmptyString(reference.endpointId)
    && isNonEmptyString(reference.taskId)
    && isNonEmptyString(reference.originalOperation)
    && value.key === `${value.server}/${reference.taskId}`;
}

function isResultEntry(value: unknown): value is ResultEntry {
  if (!isRecord(value) || !(hasExactKeys(value, RESULT_KEYS) || hasExactKeys(value, [...RESULT_KEYS, "scope"]) && hasScope(value)) || value.version !== 1 || value.kind !== "result"
    || !isNonEmptyString(value.sessionId) || !isNonEmptyString(value.server) || !isNonEmptyString(value.tool) || !hasOrigin(value)) return false;
  const message = value.message;
  if (!isRecord(message) || message.customType !== MCP_TASK_RESULT_TYPE || message.display !== true || !Array.isArray(message.content)) return false;
  if (!message.content.every(part => isRecord(part) && (part.type === "text" && typeof part.text === "string"
    || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"))) return false;
  const details = message.details;
  if (!isRecord(details) || details.deliveryId !== value.deliveryId || details.server !== value.server || !isRecord(details.task)) return false;
  return details.task.server === value.server && details.task.tool === value.tool && isNonEmptyString(details.task.id)
    && value.key === `${value.server}/${details.task.id}`;
}

function isCheckpointEntry(value: unknown): value is CheckpointEntry {
  return isRecord(value) && hasExactKeys(value, ["version", "kind", "sessionId", "items"]) && value.version === 1 && value.kind === "checkpoint"
    && isNonEmptyString(value.sessionId) && Array.isArray(value.items) && value.items.length > 0
    && value.items.every(item => (isTaskEntry(item) || isResultEntry(item)) && item.sessionId === value.sessionId);
}

function isAcceptedEntry(value: unknown): value is AcceptedEntry {
  return isRecord(value) && hasExactKeys(value, ACCEPTED_KEYS) && value.version === 1 && value.kind === "accepted"
    && isNonEmptyString(value.sessionId) && isNonEmptyString(value.key) && hasOrigin(value);
}

/** Legacy native outcomes are historical proof, not permission to repeat a task. */
function deliveredTaskKey(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== MCP_TASK_RESULT_TYPE || !isRecord(entry.details)) return undefined;
  const task = entry.details.task;
  return isRecord(task) && isNonEmptyString(task.server) && isNonEmptyString(task.id) ? `${task.server}/${task.id}` : undefined;
}

export function pendingTaskEntry(sessionId: string, task: HandedOffTask): McpTaskEntryV1 {
  if (task.reference.generation !== "v2") throw new Error(`MCP task ${task.key} has a ${task.reference.generation} reference`);
  const { endpointId, generation, taskId, originalOperation } = task.reference;
  return {
    version: 1, kind: "pending", sessionId, key: task.key, server: task.server, tool: task.tool,
    reference: { endpointId, generation, taskId, originalOperation },
    ...(task.deliveryId !== undefined ? { deliveryId: task.deliveryId, anchorEntryId: task.anchorEntryId ?? null,
      ...(task.scope !== undefined ? { scope: task.scope } : {}) } : {}),
  };
}

export function frozenTaskResultEntry(sessionId: string, result: FrozenTaskResult): ResultEntry {
  return structuredClone({ version: 1, kind: "result", sessionId, ...result });
}

export function taskCheckpointEntry(sessionId: string, checkpoint: TaskCheckpoint): CheckpointEntry {
  return { version: 1, kind: "checkpoint", sessionId, items: [
    ...checkpoint.pending.map(task => pendingTaskEntry(sessionId, task)),
    ...checkpoint.results.map(result => frozenTaskResultEntry(sessionId, result)),
  ] };
}

export function acceptedTaskResultEntry(sessionId: string, result: FrozenTaskResult): AcceptedEntry {
  return { version: 1, kind: "accepted", sessionId, key: result.key, deliveryId: result.deliveryId, anchorEntryId: result.anchorEntryId };
}

/** Read only this producer's records from the public session tree. A held result
 * may be stored off the active branch; it is retained, not adopted by that branch.
 * Legacy captures without a scope proof can renew only at their exact origin. */
export function taskRecoveryFromSession(branchEntries: readonly unknown[], sessionId: string, allEntries: readonly unknown[] = branchEntries) {
  const branch = new Set(branchEntries);
  const ids = new Set(branchEntries.filter(isRecord).map(entry => entry.id).filter(isNonEmptyString));
  const onBranch = (entry: unknown) => branch.has(entry) || isRecord(entry) && isNonEmptyString(entry.id) && ids.has(entry.id);
  const last = branchEntries.at(-1);
  const leaf = isRecord(last) ? last.id : null;
  const atCheckpoint = (entry: unknown) => entry === last || isRecord(entry) && isNonEmptyString(entry.id) && entry.id === leaf;
  const claimedKeys = new Set<string>();
  const allowed = (entry: unknown, origin: Partial<TaskDeliveryOrigin> & { key: string }) => origin.deliveryId === undefined
    ? atCheckpoint(entry) && !claimedKeys.has(origin.key) : leaf === origin.anchorEntryId || origin.scope === "branch" && atCheckpoint(entry);
  const accepted = new Set<string>();
  const pending = new Map<string, { entry: unknown; data: McpTaskEntryV1 }>();
  const results = new Map<string, { entry: unknown; data: ResultEntry }>();
  for (const entry of allEntries) {
    if (!isRecord(entry)) continue;
    const delivered = deliveredTaskKey(entry);
    if (delivered !== undefined) {
      const details = entry.details;
      if (isRecord(details) && isNonEmptyString(details.deliveryId)) pending.delete(details.deliveryId);
      if (onBranch(entry)) pending.delete(`legacy:${delivered}`);
    }
    if (entry.type !== "custom" || entry.customType !== MCP_TASK_CUSTOM_TYPE) continue;
    const records = isCheckpointEntry(entry.data) ? entry.data.items : [entry.data];
    for (const data of records) {
      if (isTaskEntry(data) && data.sessionId === sessionId) {
        const id = data.deliveryId ?? `legacy:${data.key}`;
        if (data.deliveryId) claimedKeys.add(data.key);
        if (accepted.has(id)) continue;
        if (data.deliveryId && onBranch(entry)) pending.delete(`legacy:${data.key}`);
        pending.delete(id);
        pending.set(id, { entry, data });
      } else if ((isResultEntry(data) || isAcceptedEntry(data)) && data.sessionId === sessionId) {
        claimedKeys.add(data.key);
        pending.delete(data.deliveryId);
        if (onBranch(entry)) pending.delete(`legacy:${data.key}`);
        if (data.kind === "accepted") { accepted.add(data.deliveryId); results.delete(data.deliveryId); }
        else if (!accepted.has(data.deliveryId)) results.set(data.deliveryId, { entry, data });
      }
    }
  }
  const held = [...pending.values(), ...results.values()].filter(item => !allowed(item.entry, item.data)).map(item => ({ key: item.data.key, anchorEntryId: item.data.anchorEntryId ?? null }));
  return {
    pending: [...pending.values()].filter(item => allowed(item.entry, item.data)).map(({ data }) => ({
      key: data.key, server: data.server, tool: data.tool, reference: data.reference as SerializedTaskReference,
      ...(data.deliveryId !== undefined ? { deliveryId: data.deliveryId, anchorEntryId: data.anchorEntryId ?? null,
        ...(data.scope !== undefined ? { scope: data.scope } : {}) } : {}),
    })),
    results: [...results.values()].filter(item => allowed(item.entry, item.data)).map(({ data: { version: _version, kind: _kind, sessionId: _sessionId, ...result } }) => structuredClone(result)),
    held,
  };
}

export function pendingTasksFromBranch(branchEntries: readonly unknown[], sessionId: string, allEntries: readonly unknown[] = branchEntries): HandedOffTask[] {
  return taskRecoveryFromSession(branchEntries, sessionId, allEntries).pending;
}

export function frozenTaskResultsFromBranch(branchEntries: readonly unknown[], sessionId: string, allEntries: readonly unknown[] = branchEntries): FrozenTaskResult[] {
  return taskRecoveryFromSession(branchEntries, sessionId, allEntries).results;
}
