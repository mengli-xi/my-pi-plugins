import { cancelTaskInputEvents } from "./mailbox-authority.js";
import { createHash } from "node:crypto";
import { generateDomainId } from "../domain/ids.js";
import { canonicalJsonV1, sha256CanonicalV1, trimToByteBudgetV1, utf8PrefixLengthV1 } from "./canonical.js";
import { rootHeaderV1 } from "./codecs.js";
import type { TransactionMutationV1 } from "./journal.js";
import type {
  AgentCheckpointV1,
  AgentRecordV1,
  ConversationRefV1,
  BarrierRecordV1,
  CompletionCardProjectionV1,
  CompletionRecordV1,
  InboxRecordV1,
  NormalizedStoreStateV1,
  OutboxRecordV1,
  TaskOutcomeV1,
  TaskReasonV1,
  TaskRecordV1,
} from "./types.js";

export interface TaskSettlementInputV1 {
  readonly transactionId: `txn_${string}`;
  readonly taskId: `tsk_${string}`;
  readonly completedAt: string;
  readonly outcome: TaskOutcomeV1;
  readonly reason: TaskReasonV1;
  readonly finalText: string;
  readonly summary: string;
  readonly usage?: CompletionRecordV1["usage"];
  readonly ids?: { completion: `cmp_${string}`; inbox: `inb_${string}`; outbox: `out_${string}` };
}
export interface TaskSettlementPlanV1 { readonly mutations: readonly TransactionMutationV1[]; readonly completion: CompletionRecordV1; readonly inbox: InboxRecordV1; readonly outbox?: OutboxRecordV1; readonly barrier?: BarrierRecordV1 }

function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function xml(value: string): string { return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character); }
function oneLine(value:string):string{let result=value.replace(/[\r\n\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu," ").trim();return trimToByteBudgetV1(result,512);}
function put(transactionId: string, entityType: TransactionMutationV1 extends infer _ ? string : never, entityId: string, value: unknown): TransactionMutationV1 { return { version: 1, type: "put", transaction_id: transactionId, entity_type: entityType as never, entity_id: entityId, value }; }
function parentPartition(state: NormalizedStoreStateV1, owner: ConversationRefV1) { return owner.kind === "main" ? state.root : state.agents.find(partition => partition.agent.agent_id === owner.agent_id); }

export function freezeCompletionProjectionV1(input: { completion: CompletionRecordV1; taskPath: string; barrier?: { barrierId: string; index: number; total: number } }): CompletionCardProjectionV1 {
  const original = Buffer.from(input.completion.final_text, "utf8");
  let rendered = original;
  const prefix = `<subagent_completion version="1" completion_id="${input.completion.completion_id}" task_path="${xml(input.taskPath)}" outcome="${input.completion.outcome}" reason="${input.completion.reason}"`;
  const suffix = `>\n  <summary>${xml(input.completion.summary)}</summary>\n  <result>`;
  const close = `</result>\n</subagent_completion>`;
  let truncated = false;
  while (true) {
    const marker = truncated ? ` result_truncated="true" original_result_bytes="${original.length}"` : "";
    const content = `${prefix}${marker}${suffix}${xml(rendered.toString("utf8"))}${close}`;
    if (Buffer.byteLength(content) <= 71_680) {
      const details = {
        version: 1,
        completion: { completion_id: input.completion.completion_id, task_id: input.completion.task_id, agent_id: input.completion.agent_id, outcome: input.completion.outcome, reason: input.completion.reason, summary: input.completion.summary },
        task_path: input.taskPath,
        usage: input.completion.usage,
        task_admitted_at: input.completion.task_admitted_at,
        ...(input.completion.task_started_at ? { task_started_at: input.completion.task_started_at } : {}),
        completed_at: input.completion.completed_at,
        result_truncated: truncated,
        original_result_bytes: original.length,
        rendered_result_bytes: rendered.length,
        ...(input.barrier ? { barrier: { barrier_id: input.barrier.barrierId, index: input.barrier.index, total: input.barrier.total } } : {}),
      };
      const detailsJson = canonicalJsonV1(details);
      const proof = { content, content_sha256: sha(content), details_json: detailsJson, details_sha256: sha(detailsJson), result_truncated: truncated, original_result_bytes: original.length, rendered_result_bytes: rendered.length };
      return Object.freeze({ ...proof, projection_sha256: sha256CanonicalV1(proof) });
    }
    truncated = true;
    if (rendered.length === 0) throw new Error("completion card cannot fit the frozen projection bound without result bytes");
    // 截断点必须退回合法 UTF-8 边界。原来只剥 continuation byte，正好切在完整多字节字符后面时会剥掉它的
    // 尾字节、留下悬空 lead byte，冻结出来的卡片就是非法 UTF-8。
    const nextLength = Math.max(0, rendered.length - Math.max(256, Buffer.byteLength(content) - 71_680));
    rendered = original.subarray(0, utf8PrefixLengthV1(original, nextLength));
  }
}

export function planTaskSettlementV1(state: NormalizedStoreStateV1, input: TaskSettlementInputV1): TaskSettlementPlanV1 {
  const partition = state.agents.find((candidate) => candidate.tasks.some((task) => task.task_id === input.taskId));
  if (!partition) throw new Error("settlement Task is missing");
  const task = partition.tasks.find((candidate) => candidate.task_id === input.taskId)!;
  if (task.phase === "settled") throw new Error("Task already settled");
  if (task.phase !== "admitted" && partition.agent.current_task_id !== task.task_id) throw new Error("settlement Task is not current");
  if (input.finalText.normalize("NFC") !== input.finalText || Buffer.byteLength(input.finalText) > 65_536) throw new Error("settlement final text is invalid");
  const summary = oneLine(input.summary);
  if (!summary || Buffer.byteLength(summary) > 512) throw new Error("settlement summary is invalid");
  const revision = state.root.host_revision + 1;
  const ids = input.ids ?? { completion: generateDomainId("cmp"), inbox: generateDomainId("inb"), outbox: generateDomainId("out") };
  const completion: CompletionRecordV1 = { version: 1, record_revision: revision, completion_id: ids.completion, task_id: task.task_id, agent_id: task.agent_id, recipient: task.owner_conversation, outcome: input.outcome, reason: input.reason, final_text: input.finalText, summary, usage: input.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 }, task_admitted_at: task.admitted_at, ...(task.started_at ? { task_started_at: task.started_at } : {}), completed_at: input.completedAt };
  const parent = parentPartition(state, task.owner_conversation);
  if (!parent) throw new Error("settlement parent partition is missing");
  const barrier = parent.barrier?.state === "armed" && parent.barrier.task_ids.includes(task.task_id) ? parent.barrier : undefined;
  const taskById = new Map(state.agents.flatMap((candidate) => candidate.tasks).map((candidate) => [candidate.task_id, candidate]));
  const orderedCompletionIds = barrier
    ? barrier.task_ids.flatMap((taskId) => {
        if (taskId === task.task_id) return [completion.completion_id];
        const covered = taskById.get(taskId);
        return covered?.completion_id ? [covered.completion_id] : [];
      })
    : [completion.completion_id];
  const finalBarrierTask = barrier !== undefined && orderedCompletionIds.length === barrier.task_ids.length;
  const projection = freezeCompletionProjectionV1({ completion, taskPath: partition.agent.task_path, ...(barrier ? { barrier: { barrierId: barrier.barrier_id, index: barrier.task_ids.indexOf(task.task_id) + 1, total: barrier.task_ids.length } } : {}) });
  const inbox: InboxRecordV1 = { version: 1, record_revision: revision, inbox_id: ids.inbox, completion_id: completion.completion_id, recipient: completion.recipient, projection, state: "pending-append", created_at: input.completedAt, append_attempts: 0 };
  const {
    activation_order: _activationOrder,
    waiting_on: _waitingOn,
    interrupt_requested_at: _interruptRequestedAt,
    interrupt_generation: _interruptGeneration,
    finish_declaration: _finishDeclaration,
    interaction_block: _interactionBlock,
    ...taskBase
  } = task;
  const settledTask: TaskRecordV1 = { ...taskBase, record_revision: revision, phase: "settled", settled_at: input.completedAt, outcome: input.outcome, reason: input.reason, completion_id: completion.completion_id, lease_disposition: "release-pending" };
  const { current_task_id: _currentTaskId, ...agentBase } = partition.agent;
  const inputEvents = cancelTaskInputEvents(partition, new Set([task.task_id]), revision, input.completedAt);
  const nextAgent: AgentRecordV1 = { ...agentBase, ...(task.phase === "admitted" && partition.agent.current_task_id ? { current_task_id: partition.agent.current_task_id } : {}), last_owner_event_acked_sequence: inputEvents.ack, queued_task_ids: agentBase.queued_task_ids.filter(id => id !== task.task_id), record_revision: revision };
  const nextRoot = { ...rootHeaderV1(state.root), host_revision: revision };
  const mutations: TransactionMutationV1[] = [put(input.transactionId, "root", "root", nextRoot), put(input.transactionId, "task", task.task_id, settledTask), put(input.transactionId, "agent", partition.agent.agent_id, nextAgent), put(input.transactionId, "completion", completion.completion_id, completion), put(input.transactionId, "inbox", inbox.inbox_id, inbox)];
  let nextBarrier: BarrierRecordV1 | undefined; let outbox: OutboxRecordV1 | undefined;
  if (barrier) {
    nextBarrier = { ...barrier, record_revision: revision, completion_ids: orderedCompletionIds, ...(finalBarrierTask ? { state: "satisfied" as const, settled_at: input.completedAt, wake_outbox_id: ids.outbox } : {}) };
    mutations.push(put(input.transactionId, "barrier", barrier.barrier_id, nextBarrier));
  }
  if (!barrier || finalBarrierTask) {
    outbox = { version: 1, record_revision: revision, outbox_id: ids.outbox, kind: barrier ? "barrier-wake" : "completion-wake", source: barrier ? barrier.owner : { kind: "agent", session_id: partition.agent.conversation.session_id, agent_id: partition.agent.agent_id }, recipient: completion.recipient, completion_ids: barrier ? orderedCompletionIds : [completion.completion_id], state: "pending", wake_state: "not-offered", delivery_attempts: 0, wake_epoch: 0, created_at: input.completedAt, updated_at: input.completedAt };
    mutations.push(put(input.transactionId, "outbox", outbox.outbox_id, outbox));
  }
  for (const mail of partition.mailbox.filter(mail => mail.task_id === task.task_id && mail.state === "pending")) mutations.push(put(input.transactionId, "mailbox", mail.message_id, { ...mail, record_revision: revision, state: "cancelled", cancelled_at: input.completedAt }));
  for (const event of inputEvents.events) if (event !== partition.owner_events.find(old=>old.event_id===event.event_id)) mutations.push(put(input.transactionId, "owner-event", event.event_id, event));
  const ownedWait = partition.barrier;
  if (ownedWait?.state === "armed") {
    const catchupId = ownedWait.completion_ids.length ? generateDomainId("out") : undefined;
    mutations.push(put(input.transactionId, "barrier", ownedWait.barrier_id, { ...ownedWait, record_revision: revision, state: "cancelled", cancelled_at: input.completedAt, ...(catchupId ? { wake_outbox_id: catchupId } : {}) }));
    if (catchupId) mutations.push(put(input.transactionId, "outbox", catchupId, { version: 1, record_revision: revision, outbox_id: catchupId, kind: "barrier-catch-up", source: ownedWait.owner, recipient: ownedWait.owner, completion_ids: ownedWait.completion_ids, state: "pending", wake_state: "not-offered", delivery_attempts: 0, wake_epoch: 0, created_at: input.completedAt, updated_at: input.completedAt }));
  }
  return Object.freeze({ mutations: Object.freeze(mutations), completion, inbox, ...(outbox ? { outbox } : {}), ...(nextBarrier ? { barrier: nextBarrier } : {}) });
}
