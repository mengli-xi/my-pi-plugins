import type { InjectionMarker, InjectionTerminalReceipt, LegacyInjectionTerminalReceipt } from "./store.ts";

/** Receipt presence never substitutes for the active source's frozen identity.
 * Phase, lease/holder, start and failure-intent changes are normal progression. */
export function assertInjectionReceiptMatchesMarker(
  marker: InjectionMarker,
  receipt: InjectionTerminalReceipt | LegacyInjectionTerminalReceipt,
): void {
  if ("legacy" in receipt) throw new Error("receipt-marker-conflict: legacy receipt cannot prove active frozen identity; unknown");
  const original = receipt.marker;
  const fields = ["taskId", "injectionId", "sessionId", "scheduledTime", "prompt", "title", "staleAt"] as const;
  for (const field of fields) {
    if (marker[field] !== original[field]) throw new Error(`receipt-marker-conflict: ${field}; unknown`);
  }
  if (marker.mailbox) {
    for (const field of ["anchorEntryId", "entryId", "recordedToken"] as const) {
      if (marker.mailbox[field] !== undefined && marker.mailbox[field] !== original.mailbox?.[field]) {
        throw new Error(`receipt-marker-conflict: ${field}; unknown`);
      }
    }
  }
}
