import { parseProcessNotificationBatchV1 } from "./broker.js";
import { formatProcessNotificationBatchV1 } from "./formatting.js";
import type { ProcessNotificationBatchV1 } from "./types.js";

export const PROCESS_NOTIFICATION_BATCH_TYPE = "process-notification-batch-v1";

export interface ProcessNotificationBatchMessageV1 {
  readonly customType: typeof PROCESS_NOTIFICATION_BATCH_TYPE;
  readonly content: string;
  readonly display: false;
  readonly details: ProcessNotificationBatchV1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) if (source[key] !== undefined) result[key] = canonicalize(source[key]);
    return result;
  }
  return value;
}

export function canonicalProcessNotificationValueV1(value: unknown): string { return JSON.stringify(canonicalize(value)); }

interface BatchCarrier {
  readonly content: unknown;
  readonly display: unknown;
  readonly details?: unknown;
}

function customBatch(value: unknown): BatchCarrier | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = value as { role?: unknown; customType?: unknown; content?: unknown; display?: unknown; details?: unknown };
  if (message.role !== "custom" || message.customType !== PROCESS_NOTIFICATION_BATCH_TYPE) return undefined;
  return { content: message.content, display: message.display, details: message.details };
}

function branchBatch(value: unknown): BatchCarrier | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as { type?: unknown; customType?: unknown; content?: unknown; display?: unknown; details?: unknown };
  if (entry.type !== "custom_message" || entry.customType !== PROCESS_NOTIFICATION_BATCH_TYPE) return undefined;
  return { content: entry.content, display: entry.display, details: entry.details };
}

function validBatch(value: unknown, sessionScopeId: string): value is ProcessNotificationBatchV1 {
  try {
    parseProcessNotificationBatchV1(value, sessionScopeId);
    return true;
  } catch {
    return false;
  }
}

export function validProcessNotificationBatchCarrierV1(carrier: BatchCarrier, sessionScopeId: string): carrier is BatchCarrier & { readonly details: ProcessNotificationBatchV1; readonly content: string; readonly display: false } {
  if (carrier.display !== false || typeof carrier.content !== "string" || !validBatch(carrier.details, sessionScopeId)) return false;
  return formatProcessNotificationBatchV1(carrier.details).text === carrier.content;
}

export function processNotificationBatchMessageV1(batch: ProcessNotificationBatchV1): ProcessNotificationBatchMessageV1 {
  return Object.freeze({ customType: PROCESS_NOTIFICATION_BATCH_TYPE, content: formatProcessNotificationBatchV1(batch).text, display: false, details: batch });
}

export function isProcessNotificationBatchMessageV1(value: unknown, sessionScopeId: string): value is Readonly<{ role: "custom"; customType: typeof PROCESS_NOTIFICATION_BATCH_TYPE; content: string; display: false; details: ProcessNotificationBatchV1 }> {
  const carrier = customBatch(value);
  return carrier !== undefined && validProcessNotificationBatchCarrierV1(carrier, sessionScopeId);
}

export function matchingProcessNotificationBatchEntryV1(entries: readonly unknown[], canonicalBatch: string, sessionScopeId: string): boolean {
  return entries.some((entry) => {
    const carrier = branchBatch(entry);
    return carrier !== undefined && validProcessNotificationBatchCarrierV1(carrier, sessionScopeId) && canonicalProcessNotificationValueV1(carrier.details) === canonicalBatch;
  });
}
