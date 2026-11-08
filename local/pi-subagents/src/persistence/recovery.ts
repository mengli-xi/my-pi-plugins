import { cancelTaskInputEvents } from "./mailbox-authority.js";
import { generateDomainId } from "../domain/ids.js";
import { canonicalJsonV1, sha256CanonicalV1 } from "./canonical.js";
import { rootHeaderV1 } from "./codecs.js";
import type { TransactionMutationV1 } from "./journal.js";
import { planTaskSettlementV1 } from "./settlement.js";
import { applyJournalMutationsV1 } from "./state-reducer.js";
import type {
  InboxRecordV1,
  NormalizedStoreStateV1,
  OutboxRecordV1,
  OwnerEventRecordV1,
  WakeSettlementReceiptV1,
} from "./types.js";

export interface RecoveryClockV1 {
  readonly now: () => Date;
  readonly mailboxImport?: boolean;
  /** Authenticated live Agent runtime generations. Undefined means liveness is unknown. */
  readonly liveRuntimeGenerations?: ReadonlyMap<string, { readonly runtimeGeneration: number }>;
  /** Native transcript proof keyed by Inbox ID. Missing means append proof absent. */
  readonly appendedInboxProofs?: ReadonlyMap<string, string>;
}
export interface RecoveryPlanV1 {
  readonly transactionId: string;
  readonly mutations: readonly TransactionMutationV1[];
  readonly hostLostTaskIds: readonly string[];
  readonly resetOutboxIds: readonly string[];
  readonly resetOwnerEventIds: readonly string[];
}

function iso(clock: RecoveryClockV1): string {
  const value = clock.now().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error("recovery clock is invalid");
  return value;
}
function put(transactionId: string, entityType: TransactionMutationV1 extends infer _ ? string : never, entityId: string, value: unknown): TransactionMutationV1 { return { version: 1, type: "put", transaction_id: transactionId, entity_type: entityType as never, entity_id: entityId, value }; }
function changed(left: unknown, right: unknown): boolean { return canonicalJsonV1(left) !== canonicalJsonV1(right); }

/** 这一 (Outbox, epoch) 的结算 receipt：pending 事务落盘的那一份，跨重启唯一能证明 owner 的东西。 */
function settlementReceipts(state: NormalizedStoreStateV1): ReadonlyMap<string, WakeSettlementReceiptV1> {
  return new Map([state.root, ...state.agents].flatMap((partition) => partition.wake_receipts).map((receipt) => [`${receipt.outbox_id}:${receipt.wake_epoch}`, receipt] as const));
}
function persistedSettlement(outbox: OutboxRecordV1, receipts: ReadonlyMap<string, WakeSettlementReceiptV1>): WakeSettlementReceiptV1 | undefined {
  if (outbox.state !== "wake-settlement-pending") return undefined;
  const receipt = receipts.get(`${outbox.outbox_id}:${outbox.wake_epoch}`);
  return receipt && receipt.kind === outbox.settlement_kind ? receipt : undefined;
}
function resetOutbox(outbox: OutboxRecordV1, revision: number, now: string, receipt?: WakeSettlementReceiptV1, mailboxImport?: boolean): OutboxRecordV1 | undefined {
  if (outbox.state === "delivered" || outbox.state === "handled" || outbox.state === "delivery-failed" || outbox.state === "pending") return undefined;
  // 兼容读：31b22bf 写过的 cards-appended/consumer-deferred 已按 D-007 撤销。它在这里和 open/claimed 一样
  // 回到 not-offered 并丢掉 wake_deferral（下面的解构负责剥字段），下一次 reconcile 按正常流程重投一次。
  const { settlement_kind: _kind, settlement_proof_id: _proofId, settlement_proof_sha256: _proofSha, delivered_at: _deliveredAt, wake_deferral: _deferral, ...base } = outbox;
  // pending 事务已经把这一 epoch 的 continuation owner 连同 receipt 落盘：重开只补最后那一笔链接，
  // 不再归一重投——重投会让 Goal 第二次被触发，或者 producer 追加第二条 continuation。
  // 老 store 的 pending 记录没有 receipt，继续走下面的归一。
  if (receipt) { delete base.continuation_native; const { record_revision: _receiptRevision, ...proof } = receipt; return { ...base, record_revision: revision, state: "delivered", wake_state: "settled", settlement_kind: receipt.kind, settlement_proof_id: receipt.receipt_id, settlement_proof_sha256: sha256CanonicalV1(proof), turn_settlement: { version: 1, wake_epoch: outbox.wake_epoch, continuation_identity: receipt.continuation_identity, state: "pending", pending_at: now }, delivered_at: now, updated_at: now }; }
  if (mailboxImport && outbox.wake_epoch > 0 && ["cards-appended", "wake-settlement-pending"].includes(outbox.state)) return undefined;
  if (outbox.state === "delivering") return { ...base, record_revision: revision, state: "pending", wake_state: "not-offered", updated_at: now };
  if (outbox.state === "cards-appended") return { ...base, record_revision: revision, wake_state: "not-offered", updated_at: now };
  return { ...base, record_revision: revision, state: "cards-appended", wake_state: "not-offered", updated_at: now };
}
// §7.7：只有 active-branch 证据与 projection_sha256 对得上时 appended 才可信，否则回到 pending-append。
// 已经 delivered 的 Outbox 自带持久的 settlement receipt，那条 receipt 本身就是 append 的证明；
// 此时不因 transcript 证据缺失回退 Inbox，否则会撞上「delivered Outbox is immutable」而让 store 打不开。
function resetInbox(inbox: InboxRecordV1, revision: number, proofs?: ReadonlyMap<string, string>, deliveredCompletionIds?: ReadonlySet<string>): InboxRecordV1 | undefined {
  if (inbox.state !== "appended") return undefined;
  if (deliveredCompletionIds?.has(inbox.completion_id)) return undefined;
  const proof = proofs?.get(inbox.inbox_id);
  if (proof !== undefined) {
    if (proof !== inbox.projection.projection_sha256) throw new Error("Inbox transcript proof conflicts with frozen projection");
    return undefined;
  }
  const { model_entry_id: _entry, model_appended_at: _appended, ...base } = inbox;
  return { ...base, record_revision: revision, state: "pending-append" };
}
// Inbox 退回 pending-append 后，引用它的 Outbox 不能停在要求「每条 Inbox 都已 appended」的状态上。
function downgradeOutbox(outbox: OutboxRecordV1, revision: number, now: string, resetCompletionIds: ReadonlySet<string>): OutboxRecordV1 | undefined {
  if (!["cards-appended", "wake-settlement-pending"].includes(outbox.state)) return undefined;
  if (!outbox.completion_ids.some((completionId) => resetCompletionIds.has(completionId))) return undefined;
  const { settlement_kind: _kind, settlement_proof_id: _proofId, settlement_proof_sha256: _proofSha, delivered_at: _deliveredAt, wake_deferral: _deferral, ...base } = outbox;
  return { ...base, record_revision: revision, state: "pending", wake_state: "not-offered", updated_at: now };
}
function resetOwnerEvent(event: OwnerEventRecordV1, revision: number, now: string): OwnerEventRecordV1 | undefined {
  if (event.state !== "sent") return undefined;
  if (event.kind === "prepare_shutdown" || event.kind === "owner_health") return { ...event, record_revision: revision, state: "acked", acked_at: now };
  const { target_runtime_generation: _generation, sent_at: _sent, acked_at: _acked, ...base } = event;
  return { ...base, record_revision: revision, state: "pending" };
}
function acknowledgedPrefix(events: readonly OwnerEventRecordV1[], current: number): number {
  const bySequence = new Map(events.map((event) => [event.event_sequence, event]));
  let cursor = current;
  while (["acked","cancelled"].includes(bySequence.get(cursor + 1)?.state ?? "")) cursor++;
  return cursor;
}
function resetDeliveryRecords<T extends { inbox: InboxRecordV1[]; outbox: OutboxRecordV1[]; owner_events: OwnerEventRecordV1[] }>(partition: T, revision: number, now: string, outboxIds: string[], eventIds: string[], receipts: ReadonlyMap<string, WakeSettlementReceiptV1>, inboxProofs?: ReadonlyMap<string, string>, deliveredCompletionIds?: ReadonlySet<string>, resetCompletionIds?: Set<string>, mailboxImport?: boolean): void {
  partition.inbox = partition.inbox.map((inbox) => { const reset = resetInbox(inbox, revision, inboxProofs, deliveredCompletionIds); if (reset) resetCompletionIds?.add(reset.completion_id); return reset ?? inbox; });
  partition.outbox = partition.outbox.map((outbox) => { const reset = resetOutbox(outbox, revision, now, persistedSettlement(outbox, receipts), mailboxImport); if (reset) outboxIds.push(outbox.outbox_id); return reset ?? outbox; });
  partition.owner_events = partition.owner_events.map((event) => { const reset = resetOwnerEvent(event, revision, now); if (reset) eventIds.push(event.event_id); return reset ?? event; });
}

function stateDiff(transactionId: string, before: NormalizedStoreStateV1, after: NormalizedStoreStateV1, revision: number): TransactionMutationV1[] {
  const mutations: TransactionMutationV1[] = [put(transactionId, "root", "root", { ...rootHeaderV1(after.root), host_revision: revision })];
  for (const current of after.agents) {
    const prior = before.agents.find((candidate) => candidate.agent.agent_id === current.agent.agent_id);
    if (!prior) throw new Error("recovery cannot introduce an Agent");
    if (changed(prior.agent, current.agent)) mutations.push(put(transactionId, "agent", current.agent.agent_id, { ...current.agent, record_revision: revision }));
    for (const task of current.tasks) { const old = prior.tasks.find((candidate) => candidate.task_id === task.task_id); if (!old || changed(old, task)) mutations.push(put(transactionId, "task", task.task_id, { ...task, record_revision: revision })); }
    for (const mail of current.mailbox) { const old = prior.mailbox.find(candidate=>candidate.message_id===mail.message_id); if (!old || changed(old,mail)) mutations.push(put(transactionId,"mailbox",mail.message_id,{...mail,record_revision:revision})); }
    for (const completion of current.completions) { const old = prior.completions.find((candidate) => candidate.completion_id === completion.completion_id); if (!old || changed(old, completion)) mutations.push(put(transactionId, "completion", completion.completion_id, { ...completion, record_revision: revision })); }
    for (const inbox of current.inbox) { const old = prior.inbox.find((candidate) => candidate.inbox_id === inbox.inbox_id); if (!old || changed(old, inbox)) mutations.push(put(transactionId, "inbox", inbox.inbox_id, { ...inbox, record_revision: revision })); }
    for (const outbox of current.outbox) { const old = prior.outbox.find((candidate) => candidate.outbox_id === outbox.outbox_id); if (!old || changed(old, outbox)) mutations.push(put(transactionId, "outbox", outbox.outbox_id, { ...outbox, record_revision: revision })); }
    for (const event of current.owner_events) { const old = prior.owner_events.find((candidate) => candidate.event_id === event.event_id); if (!old || changed(old, event)) mutations.push(put(transactionId, "owner-event", event.event_id, { ...event, record_revision: revision })); }
    if (current.barrier && changed(prior.barrier, current.barrier)) mutations.push(put(transactionId, "barrier", current.barrier.barrier_id, { ...current.barrier, record_revision: revision }));
  }
  for (const inbox of after.root.inbox) { const old = before.root.inbox.find((candidate) => candidate.inbox_id === inbox.inbox_id); if (!old || changed(old, inbox)) mutations.push(put(transactionId, "inbox", inbox.inbox_id, { ...inbox, record_revision: revision })); }
  for (const outbox of after.root.outbox) { const old = before.root.outbox.find((candidate) => candidate.outbox_id === outbox.outbox_id); if (!old || changed(old, outbox)) mutations.push(put(transactionId, "outbox", outbox.outbox_id, { ...outbox, record_revision: revision })); }
  for (const event of after.root.owner_events) { const old = before.root.owner_events.find((candidate) => candidate.event_id === event.event_id); if (!old || changed(old, event)) mutations.push(put(transactionId, "owner-event", event.event_id, { ...event, record_revision: revision })); }
  if (after.root.barrier && changed(before.root.barrier, after.root.barrier)) mutations.push(put(transactionId, "barrier", after.root.barrier.barrier_id, { ...after.root.barrier, record_revision: revision }));
  return mutations;
}

export function planRecoveryV1(state: NormalizedStoreStateV1, clock: RecoveryClockV1, transactionId = generateDomainId("txn")): RecoveryPlanV1 | undefined {
  const now = iso(clock);
  let working = structuredClone(state) as NormalizedStoreStateV1;
  const hostLostTaskIds: string[] = [];
  for (const agent of state.agents) {
    for (const task of agent.tasks) {
      if (task.phase === "settled") continue;
      if (clock.liveRuntimeGenerations === undefined) continue;
      const live = clock.liveRuntimeGenerations.get(agent.agent.agent_id);
      if (live && live.runtimeGeneration === task.runtime_generation) continue;
      const lost = { transactionId, taskId: task.task_id, completedAt: now, outcome: "interrupted" as const, reason: agent.agent.close_reason === "main-session-ended" ? "main-session-ended" as const : agent.agent.lifecycle === "closing" ? "agent-closed-force" as const : "host-lost" as const, finalText: "", summary: "Subagent runtime was lost before the task settled." };
      working = applyJournalMutationsV1(working, working.root.host_revision + 1, planTaskSettlementV1(working, lost).mutations, "recover-runtime-state");
      hostLostTaskIds.push(task.task_id);
    }
  }
  if (clock.liveRuntimeGenerations !== undefined) for (const partition of working.agents) {
    if (!clock.liveRuntimeGenerations.has(partition.agent.agent_id) && partition.agent.lifecycle !== "closed") {
      partition.agent = { ...partition.agent, lifecycle: "closed", lifecycle_revision: partition.agent.lifecycle_revision + 1, runtime_generation: partition.agent.runtime_generation + 1, closed_at: now, close_reason: partition.agent.close_reason ?? "host-lost" };
      partition.mailbox = partition.mailbox.map(mail => mail.state === "pending" ? { ...mail, state: "cancelled", cancelled_at: now } : mail);
    }
  }
  const revision = state.root.host_revision + 1;
  const resetOutboxIds: string[] = [];
  const resetOwnerEventIds: string[] = [];
  const receipts = settlementReceipts(working);
  // 带 receipt 的 wake-settlement-pending 这一轮就会被补成 delivered，它的 card 同样由 receipt 证明，
  // 不能因为 transcript 证据缺失把 Inbox 退回 pending-append。
  const deliveredCompletionIds = new Set([working.root, ...working.agents].flatMap((partition) => partition.outbox).filter((outbox) => outbox.state === "delivered" || outbox.state === "handled" || persistedSettlement(outbox, receipts) !== undefined).flatMap((outbox) => outbox.completion_ids));
  const resetCompletionIds = new Set<string>();
  for (const partition of working.agents) {
    const cancelled = cancelTaskInputEvents(partition, new Set(partition.tasks.filter(task=>task.phase==="settled"||partition.agent.lifecycle!=="open").map(task=>task.task_id)),revision,now);
    partition.owner_events = cancelled.events; partition.agent.last_owner_event_acked_sequence = cancelled.ack;
    resetDeliveryRecords(partition, revision, now, resetOutboxIds, resetOwnerEventIds, receipts, clock.appendedInboxProofs, deliveredCompletionIds, resetCompletionIds, clock.mailboxImport);
    partition.agent.last_owner_event_acked_sequence = acknowledgedPrefix(partition.owner_events, partition.agent.last_owner_event_acked_sequence);
  }
  resetDeliveryRecords(working.root, revision, now, resetOutboxIds, resetOwnerEventIds, receipts, clock.appendedInboxProofs, deliveredCompletionIds, resetCompletionIds, clock.mailboxImport);
  working.root.last_owner_event_acked_sequence = acknowledgedPrefix(working.root.owner_events, working.root.last_owner_event_acked_sequence);
  // Inbox 的 recipient 分区和 Outbox 的 source 分区不是同一个，退化必须在全部分区重置之后再跨分区扫一遍。
  for (const partition of [working.root, ...working.agents]) {
    partition.outbox = partition.outbox.map((outbox) => { const downgraded = downgradeOutbox(outbox, revision, now, resetCompletionIds); if (downgraded && !resetOutboxIds.includes(outbox.outbox_id)) resetOutboxIds.push(outbox.outbox_id); return downgraded ?? outbox; });
  }
  if (!changed(state, working)) return undefined;
  const mutations = stateDiff(transactionId, state, working, revision);
  return Object.freeze({ transactionId, mutations: Object.freeze(mutations), hostLostTaskIds: Object.freeze(hostLostTaskIds), resetOutboxIds: Object.freeze(resetOutboxIds), resetOwnerEventIds: Object.freeze(resetOwnerEventIds) });
}
