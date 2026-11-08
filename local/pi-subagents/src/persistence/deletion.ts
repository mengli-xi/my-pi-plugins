import { generateDomainId } from "../domain/ids.js";
import { sha256CanonicalV1 } from "./canonical.js";
import { rootHeaderV1 } from "./codecs.js";
import type { TransactionMutationV1 } from "./journal.js";
import type { CleanupRecordV1, NormalizedStoreStateV1, SubtreeTombstoneV1 } from "./types.js";

export interface DeleteSubtreeInputV1 { readonly rootAgentId: `agt_${string}`; readonly transactionId?: `txn_${string}`; readonly cleanupId?: `cln_${string}`; readonly deletedAt: string; readonly allowUnread: boolean; readonly preparedTransactionCount: number }
export interface DeleteSubtreePlanV1 { readonly transactionId: `txn_${string}`; readonly cleanupId: `cln_${string}`; readonly agentIds: readonly `agt_${string}`[]; readonly unreadCount: number; readonly mutations: readonly TransactionMutationV1[] }

function del(transactionId: string, entityType: string, entityId: string, revision: number): TransactionMutationV1 { return { version: 1, type: "delete", transaction_id: transactionId, entity_type: entityType as never, entity_id: entityId, expected_record_revision: revision }; }
function put(transactionId: string, entityType: string, entityId: string, value: unknown): TransactionMutationV1 { return { version: 1, type: "put", transaction_id: transactionId, entity_type: entityType as never, entity_id: entityId, value }; }
function refAgent(value: { kind: "main" | "agent"; agent_id?: string }, ids: Set<string>): boolean { return value.kind === "agent" && value.agent_id !== undefined && ids.has(value.agent_id); }

export function planDeleteSettledSubtreeV1(state: NormalizedStoreStateV1, input: DeleteSubtreeInputV1): DeleteSubtreePlanV1 {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.deletedAt) || new Date(input.deletedAt).toISOString() !== input.deletedAt) throw new Error("deletion timestamp invalid");
  const root = state.agents.find((partition) => partition.agent.agent_id === input.rootAgentId);
  if (!root) throw new Error("delete subtree root not found");
  const agentIds = state.agents.filter((partition) => partition.agent.agent_id === root.agent.agent_id || partition.agent.parent_agent_id === root.agent.agent_id).map((partition) => partition.agent.agent_id).sort() as `agt_${string}`[];
  const idSet = new Set<string>(agentIds);
  const partitions = state.agents.filter((partition) => idSet.has(partition.agent.agent_id));
  if (partitions.some((partition) => partition.agent.lifecycle !== "closed")) throw new Error("agent-busy: delete subtree requires every Agent to be closed");
  if (partitions.some((partition) => partition.tasks.some((task) => task.phase !== "settled"))) throw new Error("delete subtree contains non-settled Task");
  if (partitions.some((partition) => partition.barrier?.state === "armed")) throw new Error("delete subtree contains armed Barrier");
  if (input.preparedTransactionCount !== 0) throw new Error("delete subtree is blocked by prepared operations");
  if (state.root.cleanup.some((cleanup) => cleanup.state !== "complete")) throw new Error("delete subtree is blocked by nonterminal cleanup");
  const completionIds = new Set(partitions.flatMap((partition) => partition.completions.map((completion) => completion.completion_id)));
  const allPartitions = [state.root, ...state.agents];
  const relatedMailboxes = allPartitions.flatMap((partition) => partition.mailbox).filter((mailbox) => refAgent(mailbox.sender, idSet) || refAgent(mailbox.recipient, idSet));
  const relatedInboxes = allPartitions.flatMap((partition) => partition.inbox).filter((inbox) => completionIds.has(inbox.completion_id) || refAgent(inbox.recipient, idSet));
  const relatedOutboxes = [state.root, ...state.agents].flatMap((partition) => partition.outbox).filter((outbox) => outbox.completion_ids.some((id) => completionIds.has(id)) || refAgent(outbox.source, idSet) || refAgent(outbox.recipient, idSet));
  // §7.10 只按引用关系判定：外部分区自己的 OwnerEvent/receipt 与本子树无关，不能拿来拦删除。
  // 之前「外部分区非空即拒绝」的写法在有两个以上 Agent 时，任何一个兄弟的 wake receipt 都会让 settled 子树永远删不掉。
  const relatedEvents = allPartitions.flatMap((partition) => partition.owner_events).filter((event) => refAgent(event.target, idSet));
  const relatedOutboxIds = new Set(relatedOutboxes.map((outbox) => outbox.outbox_id));
  const relatedWakeReceipts = allPartitions.flatMap((partition) => partition.wake_receipts).filter((receipt) => relatedOutboxIds.has(receipt.outbox_id));
  const relatedOperationReceipts = allPartitions.flatMap((partition) => partition.operation_receipts).filter((receipt) => refAgent(receipt.caller, idSet));
  const subtreeTaskIds = new Set(partitions.flatMap((partition) => partition.tasks.map((task) => task.task_id)));
  for (const partition of allPartitions) if (!partitions.includes(partition as any) && partition.barrier?.task_ids.some((taskId) => subtreeTaskIds.has(taskId))) throw new Error("delete subtree is referenced by an external Barrier");
  if (relatedEvents.some((event) => !idSet.has(event.target.agent_id ?? ""))) throw new Error("delete subtree has opaque external OwnerEvent reference");
  if (relatedInboxes.some((inbox) => inbox.state !== "appended")) throw new Error("delete subtree has undelivered Inbox");
  if (relatedOutboxes.some((outbox) => (outbox.state !== "delivered" && outbox.state !== "handled") || outbox.wake_state !== "settled")) throw new Error("delete subtree has nonterminal Outbox");
  if (relatedEvents.some((event) => !["acked","cancelled"].includes(event.state))) throw new Error("delete subtree has unacknowledged OwnerEvent");
  const unreadCount = relatedInboxes.filter((inbox) => inbox.ui_read_at === undefined).length;
  if (unreadCount > 0 && !input.allowUnread) throw new Error("delete subtree has unread completion");
  const transactionId = input.transactionId ?? generateDomainId("txn"); const cleanupId = input.cleanupId ?? generateDomainId("cln"); const revision = state.root.host_revision + 1;
  const identity = { root_agent_id: input.rootAgentId, agent_ids: agentIds, task_count: partitions.reduce((sum, partition) => sum + partition.tasks.length, 0), mailbox_count: partitions.reduce((sum, partition) => sum + partition.mailbox.length, 0), completion_count: completionIds.size, unread_completion_count: unreadCount };
  const tombstone: SubtreeTombstoneV1 = { version: 1, record_revision: revision, ...identity, identity_sha256: sha256CanonicalV1(identity), deleted_at: input.deletedAt, cleanup_id: cleanupId };
  const cleanup: CleanupRecordV1 = { version: 1, record_revision: revision, cleanup_id: cleanupId, kind: "subtree-delete", state: "pending", relative_paths: agentIds.map((agentId) => `conversations/${agentId}`), created_at: input.deletedAt, updated_at: input.deletedAt };
  const mutations: TransactionMutationV1[] = [put(transactionId, "root", "root", { ...rootHeaderV1(state.root), host_revision: revision, agent_ids: state.root.agent_ids.filter((agentId) => !idSet.has(agentId)) }), put(transactionId, "cleanup", cleanupId, cleanup)];
  for (const partition of partitions) {
    for (const record of partition.tasks) mutations.push(del(transactionId, "task", record.task_id, record.record_revision));
    for (const record of partition.mailbox) mutations.push(del(transactionId, "mailbox", record.message_id, record.record_revision));
    if (partition.barrier) mutations.push(del(transactionId, "barrier", partition.barrier.barrier_id, partition.barrier.record_revision));
    for (const record of partition.completions) mutations.push(del(transactionId, "completion", record.completion_id, record.record_revision));
    for (const record of partition.inbox) mutations.push(del(transactionId, "inbox", record.inbox_id, record.record_revision));
    for (const record of partition.outbox) mutations.push(del(transactionId, "outbox", record.outbox_id, record.record_revision));
    for (const record of partition.owner_events) mutations.push(del(transactionId, "owner-event", record.event_id, record.record_revision));
    for (const record of partition.operation_receipts) mutations.push(del(transactionId, "operation-receipt", record.receipt_id, record.record_revision));
    for (const record of partition.wake_receipts) mutations.push(del(transactionId, "wake-receipt", record.receipt_id, record.record_revision));
  }
  for (const partition of [state.root, ...state.agents.filter((item) => !idSet.has(item.agent.agent_id))]) {
    for (const record of partition.mailbox) if (relatedMailboxes.some((item) => item.message_id === record.message_id)) mutations.push(del(transactionId, "mailbox", record.message_id, record.record_revision));
    for (const record of partition.inbox) if (relatedInboxes.some((item) => item.inbox_id === record.inbox_id)) mutations.push(del(transactionId, "inbox", record.inbox_id, record.record_revision));
    for (const record of partition.outbox) if (relatedOutboxes.some((item) => item.outbox_id === record.outbox_id)) mutations.push(del(transactionId, "outbox", record.outbox_id, record.record_revision));
    for (const record of partition.owner_events) if (relatedEvents.some((item) => item.event_id === record.event_id)) mutations.push(del(transactionId, "owner-event", record.event_id, record.record_revision));
    // 被删 Outbox 的 wake receipt 若留在外部分区，会变成悬空引用。
    for (const record of partition.wake_receipts) if (relatedWakeReceipts.some((item) => item.receipt_id === record.receipt_id)) mutations.push(del(transactionId, "wake-receipt", record.receipt_id, record.record_revision));
    for (const record of partition.operation_receipts) if (relatedOperationReceipts.some((item) => item.receipt_id === record.receipt_id)) mutations.push(del(transactionId, "operation-receipt", record.receipt_id, record.record_revision));
  }
  for (const partition of partitions.slice().reverse()) mutations.push(del(transactionId, "agent", partition.agent.agent_id, partition.agent.record_revision));
  mutations.push({ version: 1, type: "delete-subtree", transaction_id: transactionId, tombstone });
  return Object.freeze({ transactionId, cleanupId, agentIds: Object.freeze(agentIds), unreadCount, mutations: Object.freeze(mutations) });
}
