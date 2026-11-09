import type { Mail, NativeProofResult } from "pi-session-inject/mailbox-v1";
import type { ProcessNotificationBatchV1 } from "./types.js";
import {
  canonicalProcessNotificationValueV1,
  PROCESS_NOTIFICATION_BATCH_TYPE,
  validProcessNotificationBatchCarrierV1,
} from "./main-context.js";

export const PROCESS_NOTIFICATION_STATUS_TYPE = "process-notification-status-v1" as const;
export const PROCESS_NOTIFICATION_TRIGGER_TYPE = "process-notification-trigger-v1" as const;
export type ProcessNotificationStatusStateV1 = "pending" | "turn-settled";
export interface ProcessNotificationStatusV1 {
  readonly version: 1;
  readonly sessionScopeId: string;
  readonly batchId: string;
  readonly state: ProcessNotificationStatusStateV1;
}

export function processNotificationStatusV1(value: unknown, sessionId: string): ProcessNotificationStatusV1 | undefined {
  if (!value || typeof value !== "object") return;
  const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
  if (entry.type !== "custom" || entry.customType !== PROCESS_NOTIFICATION_STATUS_TYPE || !entry.data || typeof entry.data !== "object") return;
  const data = entry.data as Record<string, unknown>;
  if (data.version !== 1 || data.sessionScopeId !== sessionId || typeof data.batchId !== "string" || !data.batchId || Buffer.byteLength(data.batchId) > 256
    || (data.state !== "pending" && data.state !== "turn-settled")) return;
  return { version: 1, sessionScopeId: sessionId, batchId: data.batchId, state: data.state };
}

/** Original strict carrier equality, without adding transport metadata to details. */
export function proveProcessMailV1(mail: Mail, entries: readonly unknown[], sessionId: string): NativeProofResult {
  const proof: Array<{ messageIndex: number; entryId: string }> = [];
  for (const [messageIndex, message] of mail.messages.entries()) {
    if (message.customType !== PROCESS_NOTIFICATION_BATCH_TYPE || !validProcessNotificationBatchCarrierV1(message, sessionId)
      || mail.key !== `batch:${message.details.batchId}`) return { kind: "conflict", reason: "Invalid process batch mail" };
    const identity = canonicalProcessNotificationValueV1(message);
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.type !== "custom_message" || entry.customType !== PROCESS_NOTIFICATION_BATCH_TYPE) continue;
      const details = entry.details as { batchId?: unknown; sessionScopeId?: unknown } | undefined;
      if (details?.batchId !== message.details.batchId || details.sessionScopeId !== sessionId) continue;
      const carrier = { customType: entry.customType, content: entry.content, display: entry.display, details: entry.details };
      if (!validProcessNotificationBatchCarrierV1(carrier, sessionId) || canonicalProcessNotificationValueV1(carrier) !== identity
        || typeof entry.id !== "string" || !entry.id) return { kind: "conflict", reason: "Process batch native identity/content conflict" };
      if (proof.some(ref => ref.messageIndex === messageIndex)) return { kind: "conflict", reason: "Duplicate process batch carrier" };
      proof.push({ messageIndex, entryId: entry.id });
    }
  }
  return { kind: "observed", entries: proof };
}

export interface LegacyProcessBatchV1 {
  readonly batch: ProcessNotificationBatchV1;
  readonly entryId: string;
  readonly state: "pending" | "turn-settled" | "orphan";
}

/** Active branch only: never use a sibling's status or a malformed carrier as proof. */
export function scanLegacyProcessBatchesV1(entries: readonly unknown[], sessionId: string): readonly LegacyProcessBatchV1[] {
  const batches = new Map<string, LegacyProcessBatchV1>();
  const statuses = new Map<string, ProcessNotificationStatusStateV1>();
  for (const raw of entries) {
    const status = processNotificationStatusV1(raw, sessionId);
    if (status) statuses.set(status.batchId, status.state);
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type !== "custom_message" || entry.customType !== PROCESS_NOTIFICATION_BATCH_TYPE || typeof entry.id !== "string" || !entry.id) continue;
    const scope = (entry.details as { sessionScopeId?: unknown } | undefined)?.sessionScopeId;
    if (typeof scope === "string" && scope !== sessionId) continue;
    const carrier = { content: entry.content, display: entry.display, details: entry.details };
    if (!validProcessNotificationBatchCarrierV1(carrier, sessionId)) throw new Error("Invalid legacy process notification carrier");
    if (batches.has(carrier.details.batchId)) throw new Error("Duplicate legacy process notification batch identity");
    batches.set(carrier.details.batchId, { batch: carrier.details, entryId: entry.id, state: "orphan" });
  }
  return [...batches.values()].map(value => ({ ...value, state: statuses.get(value.batch.batchId) ?? "orphan" }));
}
