import { decodeEntityV1, decodeRootHeaderV1, type EntityTypeV1 } from "./codecs.js";
import { canonicalJsonV1, compareCanonicalV1 } from "./canonical.js";
import { validateNormalizedStoreStateV1 } from "./invariants.js";
import type { TransactionMutationV1 } from "./journal.js";
import type {
  AgentCheckpointV1,
  AgentRecordV1,
  BarrierRecordV1,
  CleanupRecordV1,
  CompletionRecordV1,
  DurableEntityV1,
  InboxRecordV1,
  MailboxRecordV1,
  NormalizedStoreStateV1,
  OperationReceiptV1,
  OutboxRecordV1,
  OwnerEventRecordV1,
  RootCheckpointV1,
  SubtreeTombstoneV1,
  TaskRecordV1,
  WakeSettlementReceiptV1,
} from "./types.js";

function entityId(type: EntityTypeV1, value: DurableEntityV1): string {
  switch (type) {
    case "agent": return (value as AgentRecordV1).agent_id;
    case "task": return (value as TaskRecordV1).task_id;
    case "mailbox": return (value as MailboxRecordV1).message_id;
    case "barrier": return (value as BarrierRecordV1).barrier_id;
    case "completion": return (value as CompletionRecordV1).completion_id;
    case "inbox": return (value as InboxRecordV1).inbox_id;
    case "outbox": return (value as OutboxRecordV1).outbox_id;
    case "owner-event": return (value as OwnerEventRecordV1).event_id;
    case "operation-receipt": return (value as OperationReceiptV1).receipt_id;
    case "wake-receipt": return (value as WakeSettlementReceiptV1).receipt_id;
    case "cleanup": return (value as CleanupRecordV1).cleanup_id;
    case "tombstone": return (value as SubtreeTombstoneV1).root_agent_id;
    case "root": return "root";
  }
}

function comparisonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparisonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).map(([key, item]) => [key, comparisonValue(item)]));
}
function equal(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJsonV1(comparisonValue(left)) === canonicalJsonV1(comparisonValue(right));
}
function immutableProjection(type: EntityTypeV1, value: any): unknown {
  switch (type) {
    case "agent": return { agent_id: value.agent_id, parent_agent_id: value.parent_agent_id, parent_conversation: value.parent_conversation, task_name: value.task_name, task_path: value.task_path, depth: value.depth, created_at: value.created_at, created_revision: value.created_revision, profile: value.profile, conversation_identity: { session_id: value.conversation.session_id, relative_path: value.conversation.relative_path, initial_bytes: value.conversation.initial_bytes, initial_sha256: value.conversation.initial_sha256 } };
    case "task": return { task_id: value.task_id, agent_id: value.agent_id, origin: value.origin, admission_order: value.admission_order, message: value.message, initiator: value.initiator, owner_conversation: value.owner_conversation, admitted_at: value.admitted_at, lease_intent: value.lease_intent };
    case "mailbox": return { message_id: value.message_id, source: value.source, task_id: value.task_id, sender: value.sender, recipient: value.recipient, sequence: value.sequence, body_bytes: value.body_bytes, body_sha256: value.body_sha256, created_at: value.created_at };
    case "barrier": return { barrier_id: value.barrier_id, owner: value.owner, target_agent_ids: value.target_agent_ids, task_ids: value.task_ids, snapshot_sha256: value.snapshot_sha256, created_at: value.created_at };
    case "completion": case "operation-receipt": case "wake-receipt": case "tombstone": return value;
    case "inbox": return { inbox_id: value.inbox_id, completion_id: value.completion_id, recipient: value.recipient, projection: value.projection, created_at: value.created_at };
    case "outbox": return { outbox_id: value.outbox_id, kind: value.kind, source: value.source, recipient: value.recipient, completion_ids: value.completion_ids, created_at: value.created_at };
    case "owner-event": return { event_id: value.event_id, target: value.target, event_sequence: value.event_sequence, kind: value.kind, payload_json: value.payload_json, payload_sha256: value.payload_sha256, created_at: value.created_at };
    case "cleanup": return { cleanup_id: value.cleanup_id, kind: value.kind, relative_paths: value.relative_paths, created_at: value.created_at };
    case "root": return undefined;
  }
}
function existingEntity(state: NormalizedStoreStateV1, type: EntityTypeV1, id: string): any | undefined {
  const partitions = [state.root, ...state.agents];
  switch (type) {
    case "agent": return state.agents.find((item) => item.agent.agent_id === id)?.agent;
    case "task": return state.agents.flatMap((item) => item.tasks).find((item) => item.task_id === id);
    case "mailbox": return partitions.flatMap((item) => item.mailbox).find((item) => item.message_id === id);
    case "barrier": return partitions.map((item) => item.barrier).find((item) => item?.barrier_id === id);
    case "completion": return state.agents.flatMap((item) => item.completions).find((item) => item.completion_id === id);
    case "inbox": return partitions.flatMap((item) => item.inbox).find((item) => item.inbox_id === id);
    case "outbox": return partitions.flatMap((item) => item.outbox).find((item) => item.outbox_id === id);
    case "owner-event": return partitions.flatMap((item) => item.owner_events).find((item) => item.event_id === id);
    case "operation-receipt": return partitions.flatMap((item) => item.operation_receipts).find((item) => item.receipt_id === id);
    case "wake-receipt": return partitions.flatMap((item) => item.wake_receipts).find((item) => item.receipt_id === id);
    case "cleanup": return state.root.cleanup.find((item) => item.cleanup_id === id);
    case "tombstone": return state.root.tombstones.find((item) => item.root_agent_id === id);
    case "root": return state.root;
  }
}
function withoutRevision<T extends { record_revision: number }>(value: T): Omit<T, "record_revision"> { const { record_revision: _revision, ...rest } = value; return rest; }
function transition(current: any, next: any, type: EntityTypeV1, operation: string): void {
  const recovery = operation === "recover-runtime-state";
  if (type === "agent") {
    const allowed: Record<string, readonly string[]> = { open: ["open", "closing", "closed"], closing: ["closing", "closed"], closed: ["closed", "open"] };
    if (!allowed[current.lifecycle]?.includes(next.lifecycle) || next.lifecycle_revision < current.lifecycle_revision || next.runtime_generation < current.runtime_generation) throw new Error("Agent lifecycle/generation regressed");
  } else   if (type === "task") {
    const allowed: Record<string, readonly string[]> = { admitted: ["admitted", "starting", "settled"], starting: ["starting", "running", "settled"], running: ["running", "waiting", "settled"], waiting: ["waiting", "running", "settled"], settled: ["settled"] };
    if (!allowed[current.phase]?.includes(next.phase)) throw new Error("Task phase transition is not allowed");
    if (current.phase === "settled") {
      for (const key of ["settled_at", "outcome", "reason", "completion_id"] as const) if (current[key] !== next[key]) throw new Error("Task settlement is first-commit-wins");
      if (!(current.lease_disposition === next.lease_disposition || (current.lease_disposition === "release-pending" && next.lease_disposition === "released"))) throw new Error("Task lease disposition regressed");
    }
  } else if (type === "mailbox") {
    const rank = { pending: 0, injected: 1, consumed: 2, cancelled: 3 } as const; if (rank[next.state as keyof typeof rank] < rank[current.state as keyof typeof rank]) throw new Error("Mailbox state regressed");
  } else if (type === "barrier") {
    if (current.state !== "armed" && next.state !== current.state) throw new Error("Barrier terminal state is immutable");
  } else if (type === "inbox") {
    if (current.ui_read_at !== undefined && (next.ui_read_at !== current.ui_read_at || next.ui_read_revision !== current.ui_read_revision)) throw new Error("Inbox read acknowledgement is immutable");
    if (current.state === "appended" && next.state === "pending-append" && !recovery) throw new Error("Inbox append may reset only during recovery");
  } else if (type === "outbox") {
    if (current.state === "delivered") {
      // §7.9：delivered 之后唯一允许变化的是 turn_settlement，且只能同一 (epoch, continuation) 从 pending 翻成 settled。
      const { turn_settlement: currentTurn, continuation_native: _currentNative, ...currentRest } = withoutRevision(current); const { turn_settlement: nextTurn, continuation_native: _nextNative, ...nextRest } = withoutRevision(next);
      if (!equal(currentRest, nextRest)) throw new Error("delivered Outbox is immutable");
      if (!equal(currentTurn, nextTurn) && !(currentTurn?.state === "pending" && nextTurn?.state === "settled" && currentTurn.wake_epoch === nextTurn.wake_epoch && currentTurn.continuation_identity === nextTurn.continuation_identity && currentTurn.pending_at === nextTurn.pending_at)) throw new Error("delivered Outbox turn settlement may only move from pending to settled");
    }
    if (current.state === "handled") {
      const { continuation_native: _currentNative, ...currentRest } = withoutRevision(current);
      const { continuation_native: _nextNative, ...nextRest } = withoutRevision(next);
      if (!equal(currentRest, nextRest)) throw new Error("handled Outbox is immutable");
    }
    if (!equal(current.continuation_native, next.continuation_native)) {
      const observed = !current.continuation_native && next.continuation_native && operation === "record-outbox-native";
      const consumed = current.continuation_native && !next.continuation_native && ["mark-outbox-wake-settled", "terminalize-outbox", "recover-runtime-state"].includes(operation);
      if (!observed && !consumed) throw new Error("Outbox continuation native observation is immutable");
    }
    const rank: Record<string, number> = { pending: 0, delivering: 1, "cards-appended": 2, "wake-settlement-pending": 3, delivered: 4, handled: 4, "delivery-failed": 5 };
    if (rank[next.state] < rank[current.state] && !recovery && !(current.state === "delivery-failed" && next.state === "pending" && operation.includes("retry"))) throw new Error("Outbox state regressed without recovery authority");
  } else if (type === "owner-event") {
    const rank = { pending: 0, sent: 1, acked: 2, cancelled: 2 } as const; const replay = current.state === "sent" && next.state === "pending" && operation === "reset-owner-events"; if (rank[next.state as keyof typeof rank] < rank[current.state as keyof typeof rank] && !recovery && !replay) throw new Error("OwnerEvent state regressed without recovery authority"); if (["acked","cancelled"].includes(current.state) && next.state !== current.state) throw new Error("ACKed OwnerEvent is terminal");
  } else if (type === "cleanup") {
    const allowed: Record<string, readonly string[]> = { pending: ["pending", "running"], running: ["running", "complete", "failed"], complete: ["complete"], failed: ["failed", "running"] }; if (!allowed[current.state]?.includes(next.state)) throw new Error("Cleanup state transition is not allowed");
  }
}
function validateTransactionAuthority(current: NormalizedStoreStateV1, revision: number, mutations: readonly TransactionMutationV1[], operation: string): void {
  // journal 格式 2：Root put 只带 Root 头，Root 集合只随各自实体的 put/delete 变化，所以不再比对内嵌集合。
  const rootPuts = mutations.filter((item) => item.type === "put" && item.entity_type === "root");
  if (rootPuts.length !== 1) throw new Error("transaction must contain exactly one Root header put");
  for (const mutation of mutations) {
    if (mutation.type === "put") {
      const decoded = decodeEntityV1(mutation.entity_type, mutation.value) as any;
      if (mutation.entity_type === "root") { if (decoded.host_revision !== revision) throw new Error("Root revision does not match transaction revision"); if (decoded.main_key !== current.root.main_key) throw new Error("Root main key changed"); continue; }
      if (decoded.record_revision !== revision) throw new Error("put record revision does not match transaction revision");
      const prior = existingEntity(current, mutation.entity_type, mutation.entity_id);
      if (prior && !equal(immutableProjection(mutation.entity_type, prior), immutableProjection(mutation.entity_type, decoded))) throw new Error(`${mutation.entity_type} immutable fields changed`);
      if (prior) transition(prior, decoded, mutation.entity_type, operation);
    } else if (mutation.type === "delete-subtree") {
      const tombstone = decodeEntityV1("tombstone", mutation.tombstone) as any;
      if (tombstone.record_revision !== revision) throw new Error("tombstone revision does not match transaction revision");
    }
  }
}

function partitionForAgent(state: NormalizedStoreStateV1, agentId: string): AgentCheckpointV1 {
  const partition = state.agents.find((candidate) => candidate.agent.agent_id === agentId);
  if (!partition) throw new Error(`missing Agent partition: ${agentId}`);
  return partition;
}

function partitionForConversation(state: NormalizedStoreStateV1, reference: { kind: "main" | "agent"; agent_id?: string }): RootCheckpointV1 | AgentCheckpointV1 {
  return reference.kind === "main" ? state.root : partitionForAgent(state, reference.agent_id ?? "");
}

function replaceBy<T>(items: T[], predicate: (item: T) => boolean, value: T): void {
  const index = items.findIndex(predicate);
  if (index >= 0) items[index] = value;
  else items.push(value);
}

function deleteBy<T extends { record_revision: number }>(items: T[], predicate: (item: T) => boolean, expectedRevision: number): void {
  const index = items.findIndex(predicate);
  if (index < 0) throw new Error("delete target is missing");
  if (items[index]!.record_revision !== expectedRevision) throw new Error("delete revision mismatch");
  items.splice(index, 1);
}

function putEntity(state: NormalizedStoreStateV1, type: EntityTypeV1, raw: unknown, expectedId: string): void {
  if (type === "root") {
    if (expectedId !== "root") throw new Error("root entity id must be root");
    state.root = { ...state.root, ...decodeRootHeaderV1(raw) };
    return;
  }
  const value = decodeEntityV1(type, raw) as DurableEntityV1;
  if (entityId(type, value) !== expectedId) throw new Error("journal entity id does not match record id");
  switch (type) {
    case "agent": {
      const agent = value as AgentRecordV1;
      const existing = state.agents.find((item) => item.agent.agent_id === agent.agent_id);
      if (existing) existing.agent = agent;
      else state.agents.push({ version: 1, host_revision: state.root.host_revision, agent, tasks: [], mailbox: [], completions: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [] });
      break;
    }
    case "task": { const task = value as TaskRecordV1; replaceBy(partitionForAgent(state, task.agent_id).tasks, (item) => item.task_id === task.task_id, task); break; }
    case "mailbox": { const item = value as MailboxRecordV1; replaceBy(partitionForConversation(state, item.recipient).mailbox, (candidate) => candidate.message_id === item.message_id, item); break; }
    case "barrier": { const item = value as BarrierRecordV1; partitionForConversation(state, item.owner).barrier = item; break; }
    case "completion": { const item = value as CompletionRecordV1; replaceBy(partitionForAgent(state, item.agent_id).completions, (candidate) => candidate.completion_id === item.completion_id, item); break; }
    case "inbox": { const item = value as InboxRecordV1; replaceBy(partitionForConversation(state, item.recipient).inbox, (candidate) => candidate.inbox_id === item.inbox_id, item); break; }
    case "outbox": { const item = value as OutboxRecordV1; replaceBy(partitionForConversation(state, item.source).outbox, (candidate) => candidate.outbox_id === item.outbox_id, item); break; }
    case "owner-event": { const item = value as OwnerEventRecordV1; replaceBy(partitionForConversation(state, item.target).owner_events, (candidate) => candidate.event_id === item.event_id, item); break; }
    case "operation-receipt": { const item = value as OperationReceiptV1; replaceBy(partitionForConversation(state, item.caller).operation_receipts, (candidate) => candidate.receipt_id === item.receipt_id, item); break; }
    case "wake-receipt": {
      const item = value as WakeSettlementReceiptV1;
      const partition = state.root.outbox.some((outbox) => outbox.outbox_id === item.outbox_id)
        ? state.root
        : state.agents.find((candidate) => candidate.outbox.some((outbox) => outbox.outbox_id === item.outbox_id));
      if (!partition) throw new Error("wake receipt Outbox is missing");
      replaceBy(partition.wake_receipts, (candidate) => candidate.receipt_id === item.receipt_id, item);
      break;
    }
    case "cleanup": { const item = value as CleanupRecordV1; replaceBy(state.root.cleanup, (candidate) => candidate.cleanup_id === item.cleanup_id, item); break; }
    case "tombstone": { const item = value as SubtreeTombstoneV1; replaceBy(state.root.tombstones, (candidate) => candidate.root_agent_id === item.root_agent_id, item); break; }
  }
}

function findAndDelete(state: NormalizedStoreStateV1, type: EntityTypeV1, entityIdValue: string, expectedRevision: number): void {
  switch (type) {
    case "root": throw new Error("root cannot be deleted");
    case "agent": {
      const index = state.agents.findIndex((item) => item.agent.agent_id === entityIdValue);
      if (index < 0 || state.agents[index]!.agent.record_revision !== expectedRevision) throw new Error("Agent delete revision mismatch");
      state.agents.splice(index, 1);
      break;
    }
    case "task": for (const partition of state.agents) { const found = partition.tasks.some((item) => item.task_id === entityIdValue); if (found) return deleteBy(partition.tasks, (item) => item.task_id === entityIdValue, expectedRevision); } throw new Error("Task delete target missing");
    case "mailbox": for (const partition of [state.root, ...state.agents]) { if (partition.mailbox.some((item) => item.message_id === entityIdValue)) return deleteBy(partition.mailbox, (item) => item.message_id === entityIdValue, expectedRevision); } throw new Error("Mailbox delete target missing");
    case "barrier": for (const partition of [state.root, ...state.agents]) { if (partition.barrier?.barrier_id === entityIdValue) { if (partition.barrier.record_revision !== expectedRevision) throw new Error("Barrier delete revision mismatch"); delete partition.barrier; return; } } throw new Error("Barrier delete target missing");
    case "completion": for (const partition of state.agents) { if (partition.completions.some((item) => item.completion_id === entityIdValue)) return deleteBy(partition.completions, (item) => item.completion_id === entityIdValue, expectedRevision); } throw new Error("Completion delete target missing");
    case "inbox": for (const partition of [state.root, ...state.agents]) { if (partition.inbox.some((item) => item.inbox_id === entityIdValue)) return deleteBy(partition.inbox, (item) => item.inbox_id === entityIdValue, expectedRevision); } throw new Error("Inbox delete target missing");
    case "outbox": for (const partition of [state.root, ...state.agents]) { if (partition.outbox.some((item) => item.outbox_id === entityIdValue)) return deleteBy(partition.outbox, (item) => item.outbox_id === entityIdValue, expectedRevision); } throw new Error("Outbox delete target missing");
    case "owner-event": for (const partition of [state.root, ...state.agents]) { if (partition.owner_events.some((item) => item.event_id === entityIdValue)) return deleteBy(partition.owner_events, (item) => item.event_id === entityIdValue, expectedRevision); } throw new Error("Owner event delete target missing");
    case "operation-receipt": for (const partition of [state.root, ...state.agents]) { if (partition.operation_receipts.some((item) => item.receipt_id === entityIdValue)) return deleteBy(partition.operation_receipts, (item) => item.receipt_id === entityIdValue, expectedRevision); } throw new Error("Operation receipt delete target missing");
    case "wake-receipt": for (const partition of [state.root, ...state.agents]) { if (partition.wake_receipts.some((item) => item.receipt_id === entityIdValue)) return deleteBy(partition.wake_receipts, (item) => item.receipt_id === entityIdValue, expectedRevision); } throw new Error("Wake receipt delete target missing");
    case "cleanup": return deleteBy(state.root.cleanup, (item) => item.cleanup_id === entityIdValue, expectedRevision);
    case "tombstone": throw new Error("Agent tombstones cannot be deleted in V1");
  }
}

export function applyJournalMutationsV1(current: NormalizedStoreStateV1, revision: number, mutations: readonly TransactionMutationV1[], operation = "domain-mutation"): NormalizedStoreStateV1 {
  if (!Number.isSafeInteger(revision) || revision !== current.root.host_revision + 1) throw new Error("journal revision does not advance state by one");
  validateTransactionAuthority(current, revision, mutations, operation);
  const state = structuredClone(current) as NormalizedStoreStateV1;
  for (const mutation of mutations) {
    if (mutation.type === "put") putEntity(state, mutation.entity_type, mutation.value, mutation.entity_id);
    else if (mutation.type === "delete") findAndDelete(state, mutation.entity_type, mutation.entity_id, mutation.expected_record_revision);
    else if (mutation.type === "delete-subtree") {
      const tombstone = decodeEntityV1("tombstone", mutation.tombstone) as SubtreeTombstoneV1;
      replaceBy(state.root.tombstones, (item) => item.root_agent_id === tombstone.root_agent_id, tombstone);
    }
  }
  if (state.root.host_revision !== revision) throw new Error("transaction must put a Root record at the new revision");
  for (const partition of state.agents) partition.host_revision = revision;
  state.agents.sort((left, right) => compareCanonicalV1(left.agent.agent_id, right.agent.agent_id));
  validateNormalizedStoreStateV1(state);
  return state;
}
