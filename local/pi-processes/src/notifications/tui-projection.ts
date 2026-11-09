import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createProcessNotificationReceiptEnvelopeV1, createProcessTuiEntryEnvelopeV1 } from "./broker.js";

export interface NotificationEntryDeliveryV1 {
  readonly deliveryId: string;
  readonly customType: "process-event-v2" | "process-notification-receipt-v1";
  readonly data: unknown;
  readonly dataSha256: string;
}

function isMatchingEntry(entry: unknown, delivery: NotificationEntryDeliveryV1): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (candidate.type !== "custom" || candidate.customType !== delivery.customType
    || !candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) return false;
  try {
    const envelope = delivery.customType === "process-event-v2"
      ? createProcessTuiEntryEnvelopeV1(candidate.data as Readonly<Record<string, unknown>>)
      : createProcessNotificationReceiptEnvelopeV1(candidate.data as Readonly<Record<string, unknown>>);
    return envelope.dataSha256 === delivery.dataSha256;
  } catch {
    return false;
  }
}

/**
 * Pi public-session adapter. appendEntry is synchronous, but reload may happen
 * after Pi persisted the entry and before the broker ack. The active branch is
 * therefore checked by immutable payload digest before every append. Missing
 * or foreign entries fail closed to a fresh append; malformed entries never
 * satisfy the proof.
 */
export function appendNotificationEntryV1(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: Pick<ExtensionContext, "sessionManager">,
  delivery: NotificationEntryDeliveryV1,
): void {
  if (ctx.sessionManager.getBranch().some((entry) => isMatchingEntry(entry, delivery))) return;
  if (!delivery.data || typeof delivery.data !== "object" || Array.isArray(delivery.data)) {
    throw new Error("Process TUI notification data is invalid");
  }
  const envelope = delivery.customType === "process-event-v2"
    ? createProcessTuiEntryEnvelopeV1(delivery.data as Readonly<Record<string, unknown>>)
    : createProcessNotificationReceiptEnvelopeV1(delivery.data as Readonly<Record<string, unknown>>);
  if (envelope.customType !== delivery.customType || envelope.dataSha256 !== delivery.dataSha256) {
    throw new Error("Process TUI notification envelope changed before append");
  }
  pi.appendEntry(delivery.customType, delivery.data);
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!isMatchingEntry(leaf, delivery)) throw new Error("Process TUI notification append proof failed");
}
