import { AGENT_COLLECTION_BOUNDS, ROOT_COLLECTION_BOUNDS } from "./codecs.js";
import { compareCanonicalV1 } from "./canonical.js";
import { retiredOutbox } from "./invariants.js";
import type { AgentCheckpointV1, InboxRecordV1, MailboxRecordV1, NormalizedStoreStateV1, OperationReceiptV1, OutboxRecordV1, OwnerEventRecordV1, RootCheckpointV1, WakeSettlementReceiptV1 } from "./types.js";

/** 每个分区保留最近多少条 operation receipt：同一请求的重试只会发生在最近的调用上。 */
export const RETAINED_OPERATION_RECEIPTS = 1024;
/** 每个分区保留最近多少条已消费/已取消的 Mailbox：刚提交的输入还要能查到自己的记录。 */
export const RETAINED_SETTLED_MAILBOX = 256;
const DOMAIN_ID = /(?:tsk|evt|msg)_[A-Za-z0-9_-]{22}/gu;

export interface RetentionInputV1 { readonly preparedTransactionIds: ReadonlySet<string>; readonly retiredMainOutboxIds?: ReadonlySet<string> }
export interface RetentionResultV1 { readonly state: NormalizedStoreStateV1; readonly removed: number }

type Partition = RootCheckpointV1 | AgentCheckpointV1;

function mentions(json: string | undefined, live: ReadonlySet<string>): boolean {
  if (!json) return false;
  for (const match of json.matchAll(DOMAIN_ID)) if (live.has(match[0])) return true;
  return false;
}

/**
 * checkpoint 时丢掉信息已在别处落盘、幂等/恢复/未读都不再需要的记录。规则逐条见 PERSISTENCE_FORMAT §11.1：
 * - operation receipt：保留最近 1,024 条，以及仍和未结算 Task、未 ACK 的 OwnerEvent 相关的、prepared 目录还引用的；
 * - OwnerEvent：ACK 游标以内、已 acked/cancelled 的；
 * - Inbox：已追加、已读、业务已退休；Main 还必须有本次 fresh A snapshot/磁盘 receipt 的完整 ACK/GC 证明；
 * - Wake receipt：所属 Outbox 已 delivered、又不是它结算证明的那几条（被后续 epoch 取代的）；
 * - Mailbox：已消费/已取消、不在最近 256 条里、也没被未结束的 OwnerEvent 引用的（正文已注入接收方会话）。
 * 单独的业务成功、已读、onTerminal 返回或热态 handoff 都不证明 A 完整退休。
 * 未附着/unknown/仍有相关 pending 或 terminal 时保留；升级 checkpoint 使用同一规则。
 * Outbox、Completion、Task、Agent、tombstone、cleanup 不在这里删：前四者靠删子树回收，后两者是 Agent ID 不复用的证据。
 */
export function pruneForCheckpointV1(state: NormalizedStoreStateV1, input: RetentionInputV1): RetentionResultV1 {
  const partitions: Partition[] = [state.root, ...state.agents];
  const live = new Set<string>();
  for (const partition of state.agents) for (const task of partition.tasks) if (task.phase !== "settled") live.add(task.task_id);
  const liveEvents = partitions.flatMap((partition) => partition.owner_events).filter((event) => event.state === "pending" || event.state === "sent");
  for (const event of liveEvents) live.add(event.event_id);
  const eventMentioned = new Set<string>();
  for (const event of liveEvents) for (const match of event.payload_json.matchAll(DOMAIN_ID)) eventMentioned.add(match[0]);
  const vehicles = new Map<string, OutboxRecordV1>();
  for (const outbox of partitions.flatMap((partition) => partition.outbox)) for (const completionId of outbox.completion_ids) vehicles.set(completionId, outbox);
  let removed = 0;
  const keep = <T>(items: readonly T[], predicate: (item: T) => boolean): T[] => { const kept = items.filter(predicate); removed += items.length - kept.length; return kept; };

  const prune = <P extends Partition>(partition: P, ackCursor: number): P => {
    const recentReceipts = new Set([...partition.operation_receipts].sort((left, right) => right.record_revision - left.record_revision || compareCanonicalV1(right.receipt_id, left.receipt_id)).slice(0, RETAINED_OPERATION_RECEIPTS).map((receipt) => receipt.receipt_id));
    const settledMail = partition.mailbox.filter((mail) => mail.state === "consumed" || mail.state === "cancelled").sort((left, right) => right.sequence - left.sequence);
    const recentMail = new Set(settledMail.slice(0, RETAINED_SETTLED_MAILBOX).map((mail) => mail.message_id));
    const outboxes = new Map(partition.outbox.map((outbox) => [outbox.outbox_id, outbox]));
    return {
      ...partition,
      operation_receipts: keep<OperationReceiptV1>(partition.operation_receipts, (receipt) => recentReceipts.has(receipt.receipt_id) || input.preparedTransactionIds.has(receipt.transaction_id) || mentions(receipt.result_json, live)),
      owner_events: keep<OwnerEventRecordV1>(partition.owner_events, (event) => !(event.event_sequence <= ackCursor && (event.state === "acked" || event.state === "cancelled"))),
      inbox: keep<InboxRecordV1>(partition.inbox, (inbox) => { const vehicle = vehicles.get(inbox.completion_id); return !((inbox.recipient.kind === "agent" || vehicle && input.retiredMainOutboxIds?.has(vehicle.outbox_id)) && inbox.state === "appended" && inbox.ui_read_at !== undefined && vehicle !== undefined && retiredOutbox(vehicle)); }),
      wake_receipts: keep<WakeSettlementReceiptV1>(partition.wake_receipts, (receipt) => { const outbox = outboxes.get(receipt.outbox_id); return !(outbox?.state === "delivered" && outbox.settlement_proof_id !== receipt.receipt_id); }),
      mailbox: keep<MailboxRecordV1>(partition.mailbox, (mail) => !((mail.state === "consumed" || mail.state === "cancelled") && !recentMail.has(mail.message_id) && !eventMentioned.has(mail.message_id))),
    };
  };
  const root = prune(state.root, state.root.last_owner_event_acked_sequence);
  const agents = state.agents.map((partition) => prune(partition, partition.agent.last_owner_event_acked_sequence));
  return { state: removed ? { root, agents } : state, removed };
}

const PRUNABLE = ["mailbox", "inbox", "owner_events", "operation_receipts", "wake_receipts"] as const;
/** 可回收集合的压力：过了解码上限的一半是 "high"，离上限不到 256 条是 "critical"。 */
export function retentionPressureV1(state: NormalizedStoreStateV1): "none" | "high" | "critical" {
  let pressure: "none" | "high" | "critical" = "none";
  const check = (partition: Partition, bounds: Record<(typeof PRUNABLE)[number], number>) => { for (const key of PRUNABLE) { const count = partition[key].length; if (count >= bounds[key] - 256) pressure = "critical"; else if (count > bounds[key] / 2 && pressure === "none") pressure = "high"; } };
  check(state.root, ROOT_COLLECTION_BOUNDS); for (const partition of state.agents) check(partition, AGENT_COLLECTION_BOUNDS);
  return pressure;
}
/**
 * 提交后要不要专门做一次带回收的 checkpoint：压力 high 时能回收至少 512 条才做，critical 时能回收就做。
 * 回收不了的记录留给写路径的条数预检去拒绝。
 */
export function retentionWorthwhileV1(state: NormalizedStoreStateV1, input: RetentionInputV1, pressure: "high" | "critical"): boolean {
  const { removed } = pruneForCheckpointV1(state, input);
  return pressure === "critical" ? removed > 0 : removed >= 512;
}

/** 写路径预检：任一集合超过 checkpoint 解码上限就拒绝，返回中文诊断。 */
export function collectionBoundViolationV1(state: NormalizedStoreStateV1): string | undefined {
  const over = (label: string, count: number, max: number) => count > max ? `${label} 有 ${count} 条，超过 ${max} 条上限` : undefined;
  for (const [key, max] of Object.entries(ROOT_COLLECTION_BOUNDS)) { const found = over(`Main 的 ${key}`, (state.root as unknown as Record<string, unknown[]>)[key]!.length, max); if (found) return found; }
  for (const partition of state.agents) for (const [key, max] of Object.entries(AGENT_COLLECTION_BOUNDS)) { const found = over(`Agent ${partition.agent.agent_id} 的 ${key}`, (partition as unknown as Record<string, unknown[]>)[key]!.length, max); if (found) return found; }
  return undefined;
}
