export const PROVIDER_ACTIVITY_CHANNEL = "provider:activity-v1";

export interface ProviderLoadV1 {
  active: number;
  queued: number;
  backgroundActive: number;
  maxActive?: number;
}

export interface ProviderLifecycleV1 {
  channel: "lifecycle";
  type: "attempt.start" | "queue.enter" | "queue.update" | "queue.leave" | "load.update";
  source?: "local" | "upstream";
  attempt?: number;
  position?: number;
  queuedMs?: number;
  queueEnteredAt?: number;
  load?: ProviderLoadV1;
}

/** Optional observations, not authority to execute, retry or extend a model scope. */
export interface ProviderActivityV1 {
  version: 1;
  provider: string;
  sessionId: string;
  kind: "lifecycle" | "turn.end";
  event?: ProviderLifecycleV1;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const TYPES = new Set(["attempt.start", "queue.enter", "queue.update", "queue.leave", "load.update"]);

export function readProviderActivityV1(value: unknown): ProviderActivityV1 | undefined {
  if (!record(value) || value.version !== 1 || typeof value.provider !== "string" || !value.provider ||
    typeof value.sessionId !== "string" || !value.sessionId) return undefined;
  if (value.kind === "turn.end") return value as unknown as ProviderActivityV1;
  if (value.kind !== "lifecycle" || !record(value.event)) return undefined;
  const event = value.event;
  if (event.channel !== "lifecycle" || !TYPES.has(event.type as string)) return undefined;
  if (event.source !== undefined && event.source !== "local" && event.source !== "upstream") return undefined;
  if (typeof event.type === "string" && event.type.startsWith("queue.") && event.source === undefined) return undefined;
  for (const field of ["attempt", "position", "queuedMs", "queueEnteredAt"] as const) {
    if (event[field] !== undefined && !nonnegative(event[field])) return undefined;
  }
  if (event.load !== undefined) {
    if (!record(event.load) || !nonnegative(event.load.active) || !nonnegative(event.load.queued) ||
      !nonnegative(event.load.backgroundActive)) return undefined;
    if (event.load.maxActive !== undefined && (!nonnegative(event.load.maxActive) || event.load.maxActive === 0)) return undefined;
  }
  return value as unknown as ProviderActivityV1;
}
