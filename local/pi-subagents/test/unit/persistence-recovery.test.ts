import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.ts";
import { rootHeaderV1 } from "../../src/persistence/codecs.ts";
import { planTaskSettlementV1 } from "../../src/persistence/settlement.ts";
import { planRecoveryV1 } from "../../src/persistence/recovery.ts";
import type { AgentCheckpointV1, NormalizedStoreStateV1, RootCheckpointV1, TaskRecordV1 } from "../../src/persistence/types.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ids = {
  agent: encodeDomainId("agt", Buffer.alloc(16, 21)), agent2: encodeDomainId("agt", Buffer.alloc(16, 22)),
  task: encodeDomainId("tsk", Buffer.alloc(16, 23)), task2: encodeDomainId("tsk", Buffer.alloc(16, 24)),
  barrier: encodeDomainId("bar", Buffer.alloc(16, 25)) as `bar_${string}`, completion1: encodeDomainId("cmp", Buffer.alloc(16, 26)),
  inbox1: encodeDomainId("inb", Buffer.alloc(16, 27)), outbox1: encodeDomainId("out", Buffer.alloc(16, 28)),
  tx: encodeDomainId("txn", Buffer.alloc(16, 29)), tx2: encodeDomainId("txn", Buffer.alloc(16, 30)),
};
function profile(agentId: string) { return {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin", body: "role", sha256: sha("role") }, provider: "p", model: "m", model_scope: ["p/m"], reasoning_effort: "high" as const, task_timeout_ms: 60_000, cwd: "/repo", project_trusted: true, system_prompt_options_sha256: sha("o"), prompt_assembler_version: 1 as const, system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: sha("x"), capabilities: { version: 1 as const, fingerprint: sha("c"), active_tools: [], tool_definitions: [], entries: [] }, created_at: NOW }; }
function task(taskId: typeof ids.task | typeof ids.task2, agentId: typeof ids.agent | typeof ids.agent2, order: number): TaskRecordV1 { return {initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main"}}, owner_conversation: {kind: "main" as const, session_id: "main"},  version: 1, record_revision: 1, task_id: taskId, agent_id: agentId, origin: "initial", admission_order: order, message: "work", phase: "running", admitted_at: NOW, started_at: NOW, deadline_at_ms: Date.parse(NOW) + 60_000, runtime_generation: 1, lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: taskId, reason: "work" }, lease_disposition: "required" }; }
function partition(agentId: typeof ids.agent | typeof ids.agent2, taskValue: TaskRecordV1, name: string): AgentCheckpointV1 { return { version: 1, host_revision: 1, agent: {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: 1, agent_id: agentId, parent_conversation: { kind: "main", session_id: "main" }, task_name: name, task_path: `/root/${name}`, depth: 1, created_at: NOW, created_revision: 1, profile: profile(agentId), conversation: { session_id: `${name}-session`, relative_path: `conversations/${agentId}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", current_task_id: taskValue.task_id, queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 }, tasks: [taskValue], mailbox: [], completions: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [] }; }
function state(two = false): NormalizedStoreStateV1 { const first = partition(ids.agent, task(ids.task, ids.agent, 1), "a"); const second = partition(ids.agent2, task(ids.task2, ids.agent2, 2), "b"); const root: RootCheckpointV1 = { version: 1, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 3, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: two ? [ids.agent, ids.agent2].sort() : [ids.agent], mailbox: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] }; return { root, agents: two ? [first, second].sort((a, b) => a.agent.agent_id.localeCompare(b.agent.agent_id)) : [first] }; }

test("settlement summary truncates long CJK text by UTF-8 bytes",()=>{const current=state();const plan=planTaskSettlementV1(current,{transactionId:ids.tx,taskId:ids.task,completedAt:NOW,outcome:"completed",reason:"normal-final",finalText:"结果".repeat(400),summary:"结果".repeat(400)});const next=applyJournalMutationsV1(current,2,plan.mutations);assert.ok(Buffer.byteLength(next.agents[0]!.completions[0]!.summary,"utf8")<=512);assert.ok(next.agents[0]!.completions[0]!.summary.length>0);});

test("ordinary settlement atomically creates Task, Completion, Inbox and one Outbox", () => {
  const current = state(); const plan = planTaskSettlementV1(current, { transactionId: ids.tx, taskId: ids.task, completedAt: NOW, outcome: "completed", reason: "normal-final", finalText: "done", summary: "done", ids: { completion: ids.completion1, inbox: ids.inbox1, outbox: ids.outbox1 } });
  const next = applyJournalMutationsV1(current, 2, plan.mutations);
  assert.equal(next.agents[0]!.tasks[0]!.phase, "settled"); assert.equal(next.agents[0]!.completions.length, 1); assert.equal(next.root.inbox.length, 1); assert.equal(next.agents[0]!.outbox.length, 1); assert.equal(next.agents[0]!.outbox[0]!.kind, "completion-wake");
});

test("armed Barrier suppresses intermediate Outbox and final Task creates exactly one aggregate Outbox", () => {
  let current = state(true); current.root.barrier = { version: 1, record_revision: 1, barrier_id: ids.barrier, owner: { kind: "main", session_id: "main" }, target_agent_ids: [ids.agent, ids.agent2].sort(), task_ids: [ids.task, ids.task2], completion_ids: [], state: "armed", created_at: NOW, snapshot_sha256: sha("snapshot") };
  const first = planTaskSettlementV1(current, { transactionId: ids.tx, taskId: ids.task, completedAt: NOW, outcome: "completed", reason: "normal-final", finalText: "one", summary: "one" }); current = applyJournalMutationsV1(current, 2, first.mutations); assert.equal(current.root.barrier!.state, "armed"); assert.equal(current.agents.flatMap((item) => item.outbox).length, 0); assert.equal(current.root.outbox.length, 0);
  const second = planTaskSettlementV1(current, { transactionId: ids.tx2, taskId: ids.task2, completedAt: NOW, outcome: "completed", reason: "normal-final", finalText: "two", summary: "two" }); current = applyJournalMutationsV1(current, 3, second.mutations); assert.equal(current.root.barrier!.state, "satisfied"); assert.equal(current.root.outbox.length, 1); assert.equal(current.root.outbox[0]!.kind, "barrier-wake"); assert.deepEqual(current.root.outbox[0]!.completion_ids, current.root.barrier!.completion_ids);
});

test("recovery uses settlement builder for host-lost and resets transient delivery and OwnerEvent", () => {
  const current = state();
  current.agents[0]!.owner_events.push({ version: 1, record_revision: 1, event_id: encodeDomainId("evt", Buffer.alloc(16, 31)), target: { kind: "agent", session_id: "a-session", agent_id: ids.agent }, target_runtime_generation: 1, event_sequence: 1, kind: "mailbox_delivery", payload_json: "{}", payload_sha256: sha("{}"), state: "sent", attempts: 1, created_at: NOW, sent_at: NOW }); current.agents[0]!.agent.next_owner_event_sequence = 2;
  const plan = planRecoveryV1(current, { now: () => new Date(NOW), liveRuntimeGenerations: new Map() }, ids.tx)!;
  assert.deepEqual(plan.hostLostTaskIds, [ids.task]); assert.equal(plan.resetOwnerEventIds.length, 1);
  const next = applyJournalMutationsV1(current, 2, plan.mutations, "recover-runtime-state");
  assert.equal(next.agents[0]!.tasks[0]!.reason, "host-lost"); assert.equal(next.agents[0]!.completions.length, 1); assert.equal(next.root.inbox.length, 1); assert.equal(next.agents[0]!.outbox.length, 1); assert.equal(next.agents[0]!.owner_events[0]!.state, "pending");
});

test("recovery preserves exact Inbox transcript proof and rejects conflicting projection proof", () => {
  const current = state(); const settled = planTaskSettlementV1(current, { transactionId: ids.tx, taskId: ids.task, completedAt: NOW, outcome: "completed", reason: "normal-final", finalText: "done", summary: "done" }); const next = applyJournalMutationsV1(current, 2, settled.mutations); const inbox = next.root.inbox[0]!; inbox.state = "appended"; inbox.model_entry_id = "entry"; inbox.model_appended_at = NOW;
  assert.equal(planRecoveryV1(next, { now: () => new Date(NOW), appendedInboxProofs: new Map([[inbox.inbox_id, inbox.projection.projection_sha256]]) }, ids.tx2), undefined);
  assert.throws(() => planRecoveryV1(next, { now: () => new Date(NOW), appendedInboxProofs: new Map([[inbox.inbox_id, "0".repeat(64)]]) }, ids.tx2), /conflicts/);
});

test("journal reducer enforces committing revision and immutable/entity mutation authority", () => {
  const current = state();
  const root = { ...rootHeaderV1(current.root), host_revision: 2 };
  const staleTask = { ...current.agents[0]!.tasks[0]!, record_revision: 1 };
  assert.throws(() => applyJournalMutationsV1(current, 2, [{ version: 1, type: "put", transaction_id: ids.tx, entity_type: "root", entity_id: "root", value: root }, { version: 1, type: "put", transaction_id: ids.tx, entity_type: "task", entity_id: staleTask.task_id, value: staleTask }]), /record revision/);
  const settled = planTaskSettlementV1(current, { transactionId: ids.tx, taskId: ids.task, completedAt: NOW, outcome: "completed", reason: "normal-final", finalText: "done", summary: "done" });
  const next = applyJournalMutationsV1(current, 2, settled.mutations);
  const completion = next.agents[0]!.completions[0]!;
  assert.throws(() => applyJournalMutationsV1(next, 3, [{ version: 1, type: "put", transaction_id: ids.tx2, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(next.root), host_revision: 3 } }, { version: 1, type: "put", transaction_id: ids.tx2, entity_type: "completion", entity_id: completion.completion_id, value: { ...completion, record_revision: 3, final_text: "changed" } }]), /immutable/);
  // journal 格式 2：Root put 只带 Root 头，带集合的整份 Root 按未知字段拒绝；只换 Root 头不会动 Root 的集合。
  assert.throws(() => applyJournalMutationsV1(next, 3, [{ version: 1, type: "put", transaction_id: ids.tx2, entity_type: "root", entity_id: "root", value: { ...next.root, host_revision: 3, inbox: [] } }]), /unknown record key/);
  const headerOnly = applyJournalMutationsV1(next, 3, [{ version: 1, type: "put", transaction_id: ids.tx2, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(next.root), host_revision: 3 } }]);
  assert.equal(headerOnly.root.host_revision, 3); assert.deepEqual(headerOnly.root.inbox, next.root.inbox); assert.deepEqual(headerOnly.root.outbox, next.root.outbox);
});

test("terminal durable states and first read ACK cannot regress through stale mutations", () => {
  const current = state(); const settledPlan = planTaskSettlementV1(current, { transactionId: ids.tx, taskId: ids.task, completedAt: NOW, outcome: "completed", reason: "normal-final", finalText: "done", summary: "done" }); const settled = applyJournalMutationsV1(current, 2, settledPlan.mutations); const task = settled.agents[0]!.tasks[0]!;
  const { outcome: _outcome, reason: _reason, completion_id: _completionId, settled_at: _settledAt, ...unsettledFields } = task;
  assert.throws(() => applyJournalMutationsV1(settled, 3, [{ version: 1, type: "put", transaction_id: ids.tx2, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(settled.root), host_revision: 3 } }, { version: 1, type: "put", transaction_id: ids.tx2, entity_type: "task", entity_id: task.task_id, value: { ...unsettledFields, record_revision: 3, phase: "running", lease_disposition: "required" } }]), /phase transition|first-commit/);
  const inbox = settled.root.inbox[0]!; const readState = structuredClone(settled); readState.root.host_revision = 3; readState.root.inbox[0] = { ...inbox, record_revision: 3, ui_read_at: NOW, ui_read_revision: 3 }; const readMutations = [{ version: 1, type: "put", transaction_id: ids.tx2, entity_type: "root", entity_id: "root", value: rootHeaderV1(readState.root) }, { version: 1, type: "put", transaction_id: ids.tx2, entity_type: "inbox", entity_id: inbox.inbox_id, value: readState.root.inbox[0] }] as const; const acknowledged = applyJournalMutationsV1(settled, 3, readMutations); assert.throws(() => applyJournalMutationsV1(acknowledged, 4, [{ version: 1, type: "put", transaction_id: ids.tx, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(acknowledged.root), host_revision: 4 } }, { version: 1, type: "put", transaction_id: ids.tx, entity_type: "inbox", entity_id: inbox.inbox_id, value: { ...acknowledged.root.inbox[0]!, record_revision: 4, ui_read_at: "2026-08-17T12:00:01.000Z", ui_read_revision: 4 } }]), /read acknowledgement/);
});

test("recovery preserves a matching authenticated live runtime and unknown liveness", () => {
  const current = state();
  assert.equal(planRecoveryV1(current, { now: () => new Date(NOW) }, ids.tx), undefined);
  assert.equal(planRecoveryV1(current, { now: () => new Date(NOW), liveRuntimeGenerations: new Map([[ids.agent, { runtimeGeneration: 1, preparedTokenDigests: new Set<string>() }]]), }, ids.tx), undefined);
});
