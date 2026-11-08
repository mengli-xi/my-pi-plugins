export const HOST_ERROR_CODES = [
  "invalid-arguments",
  "invalid-target",
  "target-not-child",
  "target-root",
  "config-invalid",
  "not-found",
  "name-conflict",
  "depth-limit",
  "open-agent-capacity",
  "agent-closed",
  "agent-closing",
  "agent-busy",
  "input-pending",
  "task-capacity",
  "active-barrier",
  "no-current-task",
  "model-unavailable",
  "effort-unsupported",
  "tier-unsupported",
  "role-unavailable",
  "capability-unavailable",
  "context-unavailable",
  "effective-context-unavailable",
  "storage-unavailable",
  "storage-capacity",
  "runtime-capacity",
  "protocol-error",
  "delivery-failed",
  "unavailable",
  "stale-binding",
  "stale-runtime",
  "stale-revision",
  "stale-task",
  "stale-cursor",
  "stale-confirmation",
  "operation-expired",
  "permission-denied",
  "cancelled",
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

const HOST_ERROR_CODE_SET: ReadonlySet<string> = new Set(HOST_ERROR_CODES);

export function isHostErrorCode(value: unknown): value is HostErrorCode {
  return typeof value === "string" && HOST_ERROR_CODE_SET.has(value);
}
