import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { validateNormalizedStoreStateV1 } from "../../src/persistence/invariants.ts";
import { planRecoveryV1 } from "../../src/persistence/recovery.ts";
import { planTaskSettlementV1 } from "../../src/persistence/settlement.ts";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.ts";
import { sha256CanonicalV1 } from "../../src/persistence/canonical.ts";
import type { AgentCheckpointV1, NormalizedStoreStateV1, RootCheckpointV1 } from "../../src/persistence/types.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ids = { agent: encodeDomainId("agt", Buffer.alloc(16, 21)), task: encodeDomainId("tsk", Buffer.alloc(16, 23)), tx: encodeDomainId("txn", Buffer.alloc(16, 29)), tx2: encodeDomainId("txn", Buffer.alloc(16, 30)), receipt: encodeDomainId("rcp", Buffer.alloc(16, 31)) };
const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 } as const;

function profile(agentId: string) { return {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin", body: "role", sha256: sha("role") }, provider: "p", model: "m", model_scope: ["p/m"], reasoning_effort: "high" as const, task_timeout_ms: 60_000, cwd: "/repo", project_trusted: true, system_prompt_options_sha256: sha("o"), prompt_assembler_version: 1 as const, system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: sha("x"), capabilities: { version: 1 as const, fingerprint: sha("c"), active_tools: [], tool_definitions: [], entries: [] }, created_at: NOW }; }
function state(): NormalizedStoreStateV1 {
  const partition: AgentCheckpointV1 = { version: 1, host_revision: 1, agent: {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: 1, agent_id: ids.agent, parent_conversation: { kind: "main", session_id: "main" }, task_name: "a", task_path: "/root/a", depth: 1, created_at: NOW, created_revision: 1, profile: profile(ids.agent), conversation: { session_id: "a-session", relative_path: `conversations/${ids.agent}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", current_task_id: ids.task, queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 }, tasks: [{initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main"}}, owner_conversation: {kind: "main" as const, session_id: "main"},  version: 1, record_revision: 1, task_id: ids.task, agent_id: ids.agent, origin: "initial", admission_order: 1, message: "work", phase: "running", admitted_at: NOW, started_at: NOW, deadline_at_ms: Date.parse(NOW) + 60_000, runtime_generation: 1, lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: ids.task, reason: "work" }, lease_disposition: "required" }], mailbox: [], completions: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [] };
  const root: RootCheckpointV1 = { version: 1, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 2, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [ids.agent], mailbox: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] };
  return { root, agents: [partition] };
}
function settled(): NormalizedStoreStateV1 {
  const current = state();
  const plan = planTaskSettlementV1(current, { transactionId: ids.tx, taskId: ids.task, completedAt: NOW, outcome: "completed", reason: "normal-final", finalText: "done", summary: "done" });
  return applyJournalMutationsV1(current, 2, plan.mutations);
}

test("an Inbox reset to pending-append also downgrades the Outbox that requires it appended", () => {
  const current = settled();
  current.root.inbox[0] = { ...current.root.inbox[0]!, state: "appended", model_entry_id: "entry-1", model_appended_at: NOW };
  current.agents[0]!.outbox[0] = { ...current.agents[0]!.outbox[0]!, state: "cards-appended" };
  validateNormalizedStoreStateV1(current);
  const plan = planRecoveryV1(current, { now: () => new Date(NOW), appendedInboxProofs: new Map() }, ids.tx2)!;
  assert.ok(plan);
  assert.deepEqual([...plan.resetOutboxIds], [current.agents[0]!.outbox[0]!.outbox_id]);
  // 没有 recovery 降级，这条 mutation 会被 invariants 判成「Outbox cards state requires every referenced Inbox appended」。
  const next = applyJournalMutationsV1(current, 3, plan.mutations, "recover-runtime-state");
  assert.equal(next.root.inbox[0]!.state, "pending-append");
  assert.equal(next.agents[0]!.outbox[0]!.state, "pending");
  assert.equal(next.agents[0]!.outbox[0]!.wake_state, "not-offered");
});

test("a delivered Outbox keeps its Inbox appended because the settlement receipt is the durable proof", () => {
  const current = settled();
  const outbox = current.agents[0]!.outbox[0]!;
  const receipt = { version: 1 as const, record_revision: 2, receipt_id: ids.receipt, outbox_id: outbox.outbox_id, wake_epoch: 0, kind: "producer-fallback" as const, runtime_delivery: "delivered" as const, continuation_identity: "cont", continuation_sha256: sha("cont"), committed_at: NOW };
  const { record_revision: _revision, ...proof } = receipt;
  current.root.inbox[0] = { ...current.root.inbox[0]!, state: "appended", model_entry_id: "entry-1", model_appended_at: NOW };
  current.agents[0]!.wake_receipts.push(receipt);
  current.agents[0]!.outbox[0] = { ...outbox, state: "delivered", wake_state: "settled", settlement_kind: "producer-fallback", settlement_proof_id: ids.receipt, settlement_proof_sha256: sha256CanonicalV1(proof), delivered_at: NOW };
  validateNormalizedStoreStateV1(current);
  assert.equal(planRecoveryV1(current, { now: () => new Date(NOW), appendedInboxProofs: new Map() }, ids.tx2), undefined);
});

test("a wake-settlement-pending Outbox with a persisted receipt recovers into delivered instead of a re-offer", () => {
  const current = settled();
  const outbox = current.agents[0]!.outbox[0]!;
  const receipt = { version: 1 as const, record_revision: 2, receipt_id: ids.receipt, outbox_id: outbox.outbox_id, wake_epoch: 1, kind: "goal-claimed" as const, claimant_owner_id: "pi-goal-local", claimant_generation: 3, runtime_delivery: "delivered" as const, continuation_identity: "goal-continuation", continuation_sha256: sha("goal"), committed_at: NOW };
  const { record_revision: _revision, ...proof } = receipt;
  current.root.inbox[0] = { ...current.root.inbox[0]!, state: "appended", model_entry_id: "entry-1", model_appended_at: NOW };
  current.agents[0]!.wake_receipts.push(receipt);
  current.agents[0]!.outbox[0] = { ...outbox, state: "wake-settlement-pending", wake_state: "claimed", settlement_kind: "goal-claimed", wake_epoch: 1 };
  // pending 事务落盘的 receipt 与还没链接它的 Outbox 是合法组合。
  validateNormalizedStoreStateV1(current);
  const plan = planRecoveryV1(current, { now: () => new Date(NOW), appendedInboxProofs: new Map() }, ids.tx2)!;
  const next = applyJournalMutationsV1(current, 3, plan.mutations, "recover-runtime-state");
  assert.equal(next.agents[0]!.outbox[0]!.state, "delivered");
  assert.equal(next.agents[0]!.outbox[0]!.wake_state, "settled");
  assert.equal(next.agents[0]!.outbox[0]!.wake_epoch, 1, "已经定了 owner 的 epoch 不再烧新 epoch");
  assert.equal(next.agents[0]!.outbox[0]!.settlement_proof_id, ids.receipt);
  assert.equal(next.agents[0]!.outbox[0]!.settlement_proof_sha256, sha256CanonicalV1(proof));
  assert.equal(next.agents[0]!.wake_receipts.length, 1, "不写第二份 receipt");
  assert.deepEqual(next.agents[0]!.outbox[0]!.turn_settlement, { version: 1, wake_epoch: 1, continuation_identity: "goal-continuation", state: "pending", pending_at: NOW }, "重开补链接成 delivered 时同样记下待处理的 turn，不猜模型处理过");
  // receipt 本身就是 card append 的证明：transcript 证据缺失也不把 Inbox 退回 pending-append。
  assert.equal(next.root.inbox[0]!.state, "appended");
});

test("an old wake-settlement-pending record without a receipt still normalises back to a re-offer", () => {
  const current = settled();
  const outbox = current.agents[0]!.outbox[0]!;
  current.root.inbox[0] = { ...current.root.inbox[0]!, state: "appended", model_entry_id: "entry-1", model_appended_at: NOW };
  current.agents[0]!.outbox[0] = { ...outbox, state: "wake-settlement-pending", wake_state: "fallback-appended", settlement_kind: "producer-fallback", wake_epoch: 1 };
  validateNormalizedStoreStateV1(current);
  const plan = planRecoveryV1(current, { now: () => new Date(NOW), appendedInboxProofs: new Map([[current.root.inbox[0]!.inbox_id, current.root.inbox[0]!.projection.projection_sha256]]) }, ids.tx2)!;
  const next = applyJournalMutationsV1(current, 3, plan.mutations, "recover-runtime-state");
  assert.equal(next.agents[0]!.outbox[0]!.state, "cards-appended", "老数据没有 receipt，仍按既有规则归一重投");
  assert.equal(next.agents[0]!.outbox[0]!.wake_state, "not-offered");
  assert.equal(next.agents[0]!.outbox[0]!.settlement_kind, undefined);
  assert.equal(next.agents[0]!.wake_receipts.length, 0);
});
