import type { ProcessMainBindingV1 } from "../host/process-service.js";

/** Unknown legacy evidence holds only its original Outbox (all epochs/carriers). */
export function mainOutboxImportHold(binding: ProcessMainBindingV1, outboxId: string): string | undefined {
  for (const [key, reason] of binding.mailboxImportHolds ?? []) {
    if (key.startsWith(`outbox:${outboxId}:`)) return `${key}: ${reason}`;
  }
}
export function mainMailImportHold(binding: ProcessMainBindingV1, key: string): string | undefined {
  const exact = binding.mailboxImportHolds?.get(key);
  if (exact !== undefined) return `${key}: ${exact}`;
  if (!binding.mailboxImportHolds?.size) return;
  const state = binding.host.snapshot();
  const inbox = key.startsWith("card:") ? state.root.inbox.find(item => `card:${item.inbox_id}` === key) : undefined;
  for (const outbox of [state.root, ...state.agents].flatMap(partition => partition.outbox)) {
    if (key.startsWith(`outbox:${outbox.outbox_id}:`) || inbox && outbox.completion_ids.includes(inbox.completion_id)) {
      const reason = mainOutboxImportHold(binding, outbox.outbox_id);
      if (reason) return reason;
    }
  }
}
/** A read-only selection view for the unchanged delivery driver. The real Host
 * remains the sole writer; excluded legacy sources retain their original debt. */
export function mainImportDeliverySnapshot(binding: ProcessMainBindingV1): ReturnType<ProcessMainBindingV1["host"]["snapshot"]> {
  const state = binding.host.snapshot();
  if (!binding.mailboxImportHolds?.size) return state;
  const visible = <T extends typeof state.root | typeof state.agents[number]>(partition: T): T => ({ ...partition,
    outbox: partition.outbox.filter(outbox => !mainOutboxImportHold(binding, outbox.outbox_id)) });
  return { root: visible(state.root), agents: state.agents.map(visible) };
}
