import type { AgentCheckpointV1, OwnerEventRecordV1 } from "./types.js";
import type { MailboxDeliveryItemV1 } from "../child/mailbox-injection.js";

export function mailboxEventTaskIds(partition: AgentCheckpointV1, event: OwnerEventRecordV1): string[] {
  if (event.kind !== "mailbox_delivery") return [];
  const payload = JSON.parse(event.payload_json) as { items: MailboxDeliveryItemV1[] };
  return (payload.items ?? []).flatMap(item => {
    const taskId = item.injectedInto.kind === "task" ? item.injectedInto.taskId : partition.mailbox.find(mail=>mail.message_id===item.messageId)?.task_id;
    return taskId ? [taskId] : [];
  });
}
/** Cancel delivery as a terminal event, retaining the contiguous owner sequence. */
export function cancelTaskInputEvents(partition: AgentCheckpointV1, taskIds: ReadonlySet<string>, revision: number, at: string) {
  const events = partition.owner_events.map(event => !["acked","cancelled"].includes(event.state) && mailboxEventTaskIds(partition,event).some(id=>taskIds.has(id))
    ? { ...event, record_revision:revision, state:"cancelled" as const, cancelled_at:at } : event);
  let ack = partition.agent.last_owner_event_acked_sequence;
  for (const event of events) { if (event.event_sequence <= ack) continue; if (event.event_sequence !== ack+1 || !["acked","cancelled"].includes(event.state)) break; ack++; }
  return { events, ack };
}
/** Checked immediately before native injection and before accepting its durable proof. */
export function assertMailboxInputAuthority(partition: AgentCheckpointV1, items: readonly MailboxDeliveryItemV1[], generation: number): void {
  if (partition.agent.lifecycle !== "open") throw new Error("stale-task: mailbox execution authority ended");
  for (const item of items) {
    const mail = partition.mailbox.find(mail=>mail.message_id===item.messageId);
    if (!mail || mail.state === "cancelled" || mail.body_sha256 !== item.bodySha256) throw new Error("stale-task: mailbox input was cancelled");
    if (item.injectedInto.kind !== "task") { if (mail.task_id) throw new Error("stale-task: Task input cannot become idle input"); continue; }
    const taskId = item.injectedInto.taskId, task = partition.tasks.find(task=>task.task_id===taskId);
    if (mail.task_id !== taskId || partition.agent.current_task_id !== taskId || !task || task.runtime_generation !== generation || task.phase === "settled" || task.interrupt_requested_at)
      throw new Error("stale-task: mailbox input belongs to an ended Task");
  }
}
