import type { NormalizedStoreStateV1, OutboxRecordV1 } from "../persistence/types.js";
import { readMainMailboxRetirement, type MainMailboxReadContextV1 } from "./retirement-main.js";
export type { MainMailboxReadContextV1 } from "./retirement-main.js";

/** Deletion and checkpoint consume the same fresh, read-only A retirement facts. */
export async function assertMainOutboxMailRetired(input: { readonly state: NormalizedStoreStateV1; readonly outboxes: readonly OutboxRecordV1[]; readonly context?: MainMailboxReadContextV1 }): Promise<void> {
  const outboxes = input.outboxes.filter(outbox => outbox.recipient.kind === "main");
  if (!outboxes.length) return;
  const facts = await readMainMailboxRetirement(input.context, true);
  for (const outbox of outboxes) {
    const fact = facts.outbox(input.state, outbox);
    if (fact.kind !== "retired") throw new Error(`还有投递在收尾，稍后再删：${fact.reason ?? "原 key 尚有 handoff/ACK/GC 义务"}`);
  }
}
