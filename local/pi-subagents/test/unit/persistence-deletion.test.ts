import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { planDeleteSettledSubtreeV1 } from "../../src/persistence/deletion.ts";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.ts";
import { compareCanonicalV1, sha256CanonicalV1 } from "../../src/persistence/canonical.ts";
import { validateNormalizedStoreStateV1 } from "../../src/persistence/invariants.ts";
import type { AgentCheckpointV1, NormalizedStoreStateV1 } from "../../src/persistence/types.ts";

const T = "2026-08-17T12:00:00.000Z"; const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const A = encodeDomainId("agt", Buffer.alloc(16, 51)); const TASK = encodeDomainId("tsk", Buffer.alloc(16, 52)); const CMP = encodeDomainId("cmp", Buffer.alloc(16, 53)); const INB = encodeDomainId("inb", Buffer.alloc(16, 54)); const OUT = encodeDomainId("out", Buffer.alloc(16, 55)); const RCP = encodeDomainId("rcp", Buffer.alloc(16, 56)); const CLN = encodeDomainId("cln", Buffer.alloc(16, 57)); const TX = encodeDomainId("txn", Buffer.alloc(16, 58));
function state(read = true): NormalizedStoreStateV1 { const receipt = { version: 1 as const, record_revision: 1, receipt_id: RCP, outbox_id: OUT, wake_epoch: 1, kind: "producer-fallback" as const, runtime_delivery: "delivered" as const, continuation_identity: "e", continuation_sha256: sha("e"), committed_at: T }; const { record_revision: _r, ...proof } = receipt; const projectionBase = { content: "x", content_sha256: sha("x"), details_json: "{}", details_sha256: sha("{}"), result_truncated: false, original_result_bytes: 1, rendered_result_bytes: 1 }; const root = { version: 1 as const, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 2, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [A], mailbox: [], inbox: [{ version: 1 as const, record_revision: 1, inbox_id: INB, completion_id: CMP, recipient: { kind: "main" as const, session_id: "main" }, projection: { ...projectionBase, projection_sha256: sha256(projectionBase) }, state: "appended" as const, created_at: T, append_attempts: 1, model_entry_id: "card", model_appended_at: T, ...(read ? { ui_read_at: T, ui_read_revision: 1 } : {}) }], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] }; const partition: AgentCheckpointV1 = { version: 1, host_revision: 1, agent: {lifecycle: "closed" as const, closed_at: T, close_reason: "agent-closed-force", lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: 1, agent_id: A, parent_conversation: { kind: "main", session_id: "main" }, task_name: "a", task_path: "/root/a", depth: 1, created_at: T, created_revision: 1, profile: {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1, role: { name: "d", source: "built-in", provenance: "b", body: "r", sha256: sha("r") }, provider: "p", model: "m", model_scope: ["p/m"], reasoning_effort: "high", task_timeout_ms: 60000, cwd: "/r", project_trusted: true, system_prompt_options_sha256: sha("o"), prompt_assembler_version: 1, system_prompt_relative_path: `conversations/${A}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: sha("x"), capabilities: { version: 1, fingerprint: sha("c"), active_tools: [], tool_definitions: [], entries: [] }, created_at: T }, conversation: { session_id: "child", relative_path: `conversations/${A}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 }, tasks: [{initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main"}}, owner_conversation: {kind: "main" as const, session_id: "main"},  version: 1, record_revision: 1, task_id: TASK, agent_id: A, origin: "initial", admission_order: 1, message: "x", phase: "settled", admitted_at: T, settled_at: T, outcome: "completed", reason: "normal-final", completion_id: CMP, lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: TASK, reason: "x" }, lease_disposition: "released" }], mailbox: [], completions: [{ version: 1, record_revision: 1, completion_id: CMP, task_id: TASK, agent_id: A, recipient: { kind: "main", session_id: "main" }, outcome: "completed", reason: "normal-final", final_text: "x", summary: "x", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 }, task_admitted_at: T, completed_at: T }], inbox: [], outbox: [{ version: 1, record_revision: 1, outbox_id: OUT, kind: "completion-wake", source: { kind: "agent", session_id: "child", agent_id: A }, recipient: { kind: "main", session_id: "main" }, completion_ids: [CMP], state: "delivered", wake_state: "settled", delivery_attempts: 1, wake_epoch: 1, settlement_kind: "producer-fallback", settlement_proof_id: RCP, settlement_proof_sha256: sha256(proof), created_at: T, updated_at: T, delivered_at: T }], owner_events: [], operation_receipts: [], wake_receipts: [receipt] }; return { root, agents: [partition] }; }
function sha256(value: unknown) { return createHash("sha256").update(JSON.stringify(value, Object.keys(value as object).sort())).digest("hex"); }

test("settled subtree deletion atomically removes authority and retains tombstone/cleanup", () => { const current = state(); const plan = planDeleteSettledSubtreeV1(current, { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: false, preparedTransactionCount: 0 }); const next = applyJournalMutationsV1(current, 2, plan.mutations); assert.equal(next.agents.length, 0); assert.equal(next.root.agent_ids.length, 0); assert.equal(next.root.inbox.length, 0); assert.equal(next.root.tombstones[0]!.root_agent_id, A); assert.equal(next.root.cleanup[0]!.cleanup_id, CLN); });
test("cross-partition Mailbox is deleted and external Barrier/prepared authority blocks deletion", () => { const current = state(); const msg = encodeDomainId("msg", Buffer.alloc(16, 59)); current.root.mailbox.push({ version: 1, record_revision: 1, message_id: msg, sender: { kind: "agent", session_id: "child", agent_id: A }, recipient: { kind: "main", session_id: "main" }, sequence: 1, body: "x", body_bytes: 1, body_sha256: sha("x"), state: "pending", created_at: T }); current.root.next_mailbox_sequence = 2; const plan = planDeleteSettledSubtreeV1(current, { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: false, preparedTransactionCount: 0 }); const next = applyJournalMutationsV1(current, 2, plan.mutations); assert.equal(next.root.mailbox.length, 0);
  assert.throws(() => planDeleteSettledSubtreeV1(state(), { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: false, preparedTransactionCount: 1 }), /prepared/);
  const barrier = state(); barrier.root.barrier = { version: 1, record_revision: 1, barrier_id: encodeDomainId("bar", Buffer.alloc(16, 60)) as `bar_${string}`, owner: { kind: "main", session_id: "main" }, target_agent_ids: [A], task_ids: [TASK], completion_ids: [CMP], state: "armed", created_at: T, snapshot_sha256: sha("s") }; assert.throws(() => planDeleteSettledSubtreeV1(barrier, { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: false, preparedTransactionCount: 0 }), /external Barrier/);
});

test("unread completion and nonterminal delivery block deletion unless explicitly allowed/read", () => { assert.throws(() => planDeleteSettledSubtreeV1(state(false), { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: false, preparedTransactionCount: 0 }), /unread/); const nonterminal = state(); nonterminal.agents[0]!.outbox[0]!.state = "cards-appended"; nonterminal.agents[0]!.outbox[0]!.wake_state = "not-offered"; delete nonterminal.agents[0]!.outbox[0]!.settlement_kind; delete nonterminal.agents[0]!.outbox[0]!.settlement_proof_id; delete nonterminal.agents[0]!.outbox[0]!.settlement_proof_sha256; delete nonterminal.agents[0]!.outbox[0]!.delivered_at; assert.throws(() => planDeleteSettledSubtreeV1(nonterminal, { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: true, preparedTransactionCount: 0 }), /nonterminal Outbox/); });

const B = encodeDomainId("agt", Buffer.alloc(16, 71)); const TASK_B = encodeDomainId("tsk", Buffer.alloc(16, 72)); const CMP_B = encodeDomainId("cmp", Buffer.alloc(16, 73)); const INB_B = encodeDomainId("inb", Buffer.alloc(16, 74)); const OUT_B = encodeDomainId("out", Buffer.alloc(16, 75)); const RCP_B = encodeDomainId("rcp", Buffer.alloc(16, 76));
// 把单 Agent fixture 复制成一个兄弟分区：ID 全换、名字/顺序改掉，再按新 ID 重算 settlement 证明。
function twoAgents(): NormalizedStoreStateV1 {
  const current = state();
  let text = JSON.stringify({ inbox: current.root.inbox, partition: current.agents[0] });
  for (const [from, to] of [[A, B], [TASK, TASK_B], [CMP, CMP_B], [INB, INB_B], [OUT, OUT_B], [RCP, RCP_B]] as const) text = text.split(from).join(to);
  const copy = JSON.parse(text) as { inbox: NormalizedStoreStateV1["root"]["inbox"]; partition: AgentCheckpointV1 };
  copy.partition.agent.task_name = "b"; copy.partition.agent.task_path = "/root/b"; copy.partition.tasks[0]!.admission_order = 2;
  const { record_revision: _revision, ...proof } = copy.partition.wake_receipts[0]!;
  copy.partition.outbox[0]!.settlement_proof_sha256 = sha256CanonicalV1(proof);
  current.root.inbox.push(...copy.inbox);
  current.root.agent_ids = [A, B].sort();
  current.root.next_admission_order = 3;
  current.agents = [current.agents[0]!, copy.partition].sort((left, right) => compareCanonicalV1(left.agent.agent_id, right.agent.agent_id));
  validateNormalizedStoreStateV1(current);
  return current;
}

test("open or closing Agents anywhere in the subtree block deletion even after every Task settles", () => {
  for (const lifecycle of ["open", "closing"] as const) {
    const current = state(); current.agents[0]!.agent.lifecycle = lifecycle;
    assert.throws(() => planDeleteSettledSubtreeV1(current, { rootAgentId: A, deletedAt: T, allowUnread: true, preparedTransactionCount: 0 }), /every Agent to be closed/);
    const nested = twoAgents(), child = nested.agents.find(partition => partition.agent.agent_id === B)!;
    child.agent.parent_agent_id = A; child.agent.parent_conversation = { kind: "agent", session_id: nested.agents.find(partition => partition.agent.agent_id === A)!.agent.conversation.session_id, agent_id: A };
    child.agent.depth = 2; child.agent.task_path = "/root/a/b"; child.agent.lifecycle = lifecycle;
    assert.throws(() => planDeleteSettledSubtreeV1(nested, { rootAgentId: A, deletedAt: T, allowUnread: true, preparedTransactionCount: 0 }), /every Agent to be closed/);
  }
});

test("a sibling Agent's own delivery receipts never block deleting a settled subtree", () => {
  const current = twoAgents();
  const plan = planDeleteSettledSubtreeV1(current, { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: false, preparedTransactionCount: 0 });
  assert.deepEqual([...plan.agentIds], [A]);
  const next = applyJournalMutationsV1(current, 2, plan.mutations, "delete-subtree");
  assert.deepEqual(next.root.agent_ids, [B]);
  assert.deepEqual(next.agents.map((partition) => partition.agent.agent_id), [B]);
  // 兄弟自己的 Outbox/receipt/Inbox 必须原封不动留下。
  assert.equal(next.agents[0]!.wake_receipts.length, 1);
  assert.equal(next.agents[0]!.outbox.length, 1);
  assert.deepEqual(next.root.inbox.map((inbox) => inbox.inbox_id), [INB_B]);
  assert.equal(next.root.tombstones.length, 1);
});

test("a wake receipt colocated outside the subtree is deleted with the Outbox it proves", () => {
  const current = twoAgents();
  const receipt = current.agents.find((partition) => partition.agent.agent_id === A)!.wake_receipts.pop()!;
  current.agents.find((partition) => partition.agent.agent_id === B)!.wake_receipts.push(receipt);
  validateNormalizedStoreStateV1(current);
  const plan = planDeleteSettledSubtreeV1(current, { rootAgentId: A, transactionId: TX, cleanupId: CLN, deletedAt: T, allowUnread: false, preparedTransactionCount: 0 });
  const next = applyJournalMutationsV1(current, 2, plan.mutations, "delete-subtree");
  assert.deepEqual(next.agents[0]!.wake_receipts.map((item) => item.receipt_id), [RCP_B]);
});
