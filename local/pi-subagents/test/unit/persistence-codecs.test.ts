import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJsonV1, parseStrictJsonV1, sha256CanonicalV1 } from "../../src/persistence/canonical.ts";
import { decodeAgentCheckpointV1, decodeAgentRecordV1, decodeOperationReceiptV1, decodeOutboxRecordV1, decodeRootCheckpointV1, decodeTaskRecordV1, encodeDurableRecordV1 } from "../../src/persistence/codecs.ts";
import { validateNormalizedStoreStateV1 } from "../../src/persistence/invariants.ts";
import { decodePrepareRecordV1 } from "../../src/persistence/prepared.ts";
import type { AgentCheckpointV1, NormalizedStoreStateV1, RootCheckpointV1, WakeSettlementReceiptV1 } from "../../src/persistence/types.ts";

const TIME = "2026-08-17T12:00:00.000Z";
const ID = {
  agent: "agt_AAAAAAAAAAAAAAAAAAAAAA",
  task: "tsk_BBBBBBBBBBBBBBBBBBBBBB",
  completion: "cmp_CCCCCCCCCCCCCCCCCCCCCC",
  inbox: "inb_DDDDDDDDDDDDDDDDDDDDDD",
  outbox: "out_EEEEEEEEEEEEEEEEEEEEEE",
  receipt: "rcp_FFFFFFFFFFFFFFFFFFFFFF",
  transaction: "txn_GGGGGGGGGGGGGGGGGGGGGG",
} as const;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const mainRef = { kind: "main" as const, session_id: "main-session" };

function fixture(): NormalizedStoreStateV1 {
  const projectionBase = {
    content: "result",
    content_sha256: sha("result"),
    details_json: "{}",
    details_sha256: sha("{}"),
    result_truncated: false,
    original_result_bytes: 6,
    rendered_result_bytes: 6,
  };
  const receipt: WakeSettlementReceiptV1 = {
    version: 1, record_revision: 1, receipt_id: ID.receipt, outbox_id: ID.outbox, wake_epoch: 1,
    kind: "producer-fallback", runtime_delivery: "delivered", continuation_identity: "entry-1",
    continuation_sha256: sha("entry-1"), committed_at: TIME,
  };
  const { record_revision: _rr, ...receiptProof } = receipt;
  const profile = {settings_snapshot: {}, delegation_max_depth: 2 as const,
    version: 1 as const,
    role: { name: "default", source: "built-in" as const, provenance: "builtin:default:v1", body: "role", sha256: sha("role") },
    provider: "anthropic", model: "claude", model_scope: ["anthropic/claude"], reasoning_effort: "high" as const, task_timeout_ms: 1_800_000,
    cwd: "/repo", project_trusted: true, system_prompt_options_sha256: sha("options"), prompt_assembler_version: 1 as const,
    system_prompt_relative_path: `conversations/${ID.agent}/system-prompt.txt`, system_prompt_bytes: 7,
    system_prompt_sha256: sha("prompt\n"), capabilities: { version: 1 as const, fingerprint: sha("caps"), active_tools: ["read"], tool_definitions: [{ name: "read", definition_sha256: sha("read") }], entries: [] }, created_at: TIME,
  };
  const agent = {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,
    version: 1 as const, record_revision: 1, agent_id: ID.agent, parent_conversation: mainRef, task_name: "review",
    task_path: "/root/review", depth: 1 as const, created_at: TIME, created_revision: 1, profile,
    conversation: { session_id: "child-session", relative_path: `conversations/${ID.agent}/session.jsonl`, initial_bytes: 10, initial_sha256: sha("session"), last_validated_bytes: 10, last_validated_mtime_ms: 1 },
    availability: "available" as const, queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0,
  };
  const task = {initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main-session"}}, owner_conversation: {kind: "main" as const, session_id: "main-session"},
    version: 1 as const, record_revision: 1, task_id: ID.task, agent_id: ID.agent, origin: "initial" as const,
    admission_order: 1, message: "do it", phase: "settled" as const, admitted_at: TIME, settled_at: TIME,
    outcome: "completed" as const, reason: "normal-final" as const, completion_id: ID.completion,
    lease_intent: { api_version: 1 as const, session_id: "main-session", owner_id: "pi-subagents" as const, logical_key: ID.task, reason: "task" }, lease_disposition: "released" as const,
  };
  const completion = { version: 1 as const, record_revision: 1, completion_id: ID.completion, task_id: ID.task, agent_id: ID.agent, recipient: mainRef, outcome: "completed" as const, reason: "normal-final" as const, final_text: "result", summary: "result", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 2 }, task_admitted_at: TIME, completed_at: TIME };
  const inbox = { version: 1 as const, record_revision: 1, inbox_id: ID.inbox, completion_id: ID.completion, recipient: mainRef, projection: { ...projectionBase, projection_sha256: sha256CanonicalV1(projectionBase) }, state: "appended" as const, created_at: TIME, append_attempts: 1, model_entry_id: "entry-card", model_appended_at: TIME };
  const outbox = { version: 1 as const, record_revision: 1, outbox_id: ID.outbox, kind: "completion-wake" as const, source: { kind: "agent" as const, session_id: "child-session", agent_id: ID.agent }, recipient: mainRef, completion_ids: [ID.completion], state: "delivered" as const, wake_state: "settled" as const, delivery_attempts: 1, wake_epoch: 1, settlement_kind: "producer-fallback" as const, settlement_proof_id: ID.receipt, settlement_proof_sha256: sha256CanonicalV1(receiptProof), created_at: TIME, updated_at: TIME, delivered_at: TIME };
  const root: RootCheckpointV1 = { version: 1, main_key: "main_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", host_revision: 1, next_admission_order: 2, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [ID.agent], mailbox: [], inbox: [inbox], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] };
  const partition: AgentCheckpointV1 = { version: 1, host_revision: 1, agent, tasks: [task], mailbox: [], completions: [completion], inbox: [], outbox: [outbox], owner_events: [], operation_receipts: [], wake_receipts: [receipt] };
  return { root, agents: [partition] };
}

test("canonical JSON is UTF-8-key stable and strict parser rejects duplicate keys", () => {
  assert.equal(canonicalJsonV1({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  assert.equal(canonicalJsonV1({ a: 1, b: 2 }), canonicalJsonV1({ b: 2, a: 1 }));
  assert.throws(() => canonicalJsonV1({ value: 1.5 }), /safe integer/);
  assert.throws(() => parseStrictJsonV1(Buffer.from('{"a":1,"a":2}')), /duplicate JSON key/);
  assert.throws(() => parseStrictJsonV1(Buffer.from([0xff])), /encoded data/);
});

test("agent, task, outbox and checkpoint codecs round-trip exact closed records", () => {
  const state = fixture();
  const agent = decodeAgentRecordV1(structuredClone(state.agents[0]!.agent));
  const task = decodeTaskRecordV1(structuredClone(state.agents[0]!.tasks[0]));
  const outbox = decodeOutboxRecordV1(structuredClone(state.agents[0]!.outbox[0]));
  assert.equal(agent.agent_id, ID.agent); assert.equal(task.task_id, ID.task); assert.equal(outbox.state, "delivered");
  assert.deepEqual(decodeRootCheckpointV1(structuredClone(state.root)), state.root);
  assert.deepEqual(decodeAgentCheckpointV1(structuredClone(state.agents[0])), state.agents[0]);
  assert.equal(new TextDecoder().decode(encodeDurableRecordV1(agent)), `${canonicalJsonV1(agent)}\n`);
});

test("execution factory proof is additive for old profiles and round-trips as frozen capability data", () => {
  const agent = fixture().agents[0]!.agent;
  assert.deepEqual(decodeAgentRecordV1(structuredClone(agent)), agent, "legacy data without execution proof remains readable");
  const entry = { owner: "pi-native-search", main_entrypoint: "/search/extensions/index.ts", child_entrypoint: "/search/extensions/child.ts", tools: ["web_search"], providers: [], hooks: [], sha256: sha("wrapper"), execution_factory: { version: 1 as const, canonical_path: "/search/extensions/index.ts", sha256: sha("factory"), exports: ["createSearchChildFactory", "loadSearchConfig"] } };
  agent.profile.capabilities.entries.push(entry);
  assert.deepEqual(decodeAgentRecordV1(structuredClone(agent)).profile.capabilities.entries[0], entry);
  for (const proof of [{ ...entry.execution_factory, version: 2 }, { ...entry.execution_factory, sha256: "invalid" }, { ...entry.execution_factory, exports: [] }, { ...entry.execution_factory, exports: ["same", "same"] }, { ...entry.execution_factory, loader: "arbitrary" }]) {
    const changed = structuredClone(agent);
    changed.profile.capabilities.entries[0]!.execution_factory = proof as never;
    assert.throws(() => decodeAgentRecordV1(changed), /execution factory|unknown record key/);
  }
});

test("builtin proof remains structured, optional legacy data and closed V1 schema", () => {
  const agent = fixture().agents[0]!.agent;
  const entry = { owner: "builtin:codemode", main_entrypoint: "builtin:codemode", child_entrypoint: "builtin:codemode", tools: ["codemode"], providers: [], hooks: [], sha256: sha("codemode"), builtin_proof: { version: 1 as const, pi_version: "1.5.0" } };
  agent.profile.capabilities.entries.push(entry);
  assert.deepEqual(decodeAgentRecordV1(structuredClone(agent)).profile.capabilities.entries[0], entry);
  for (const proof of [{ ...entry.builtin_proof, version: 2 }, { ...entry.builtin_proof, pi_version: "" }, { ...entry.builtin_proof, pi_version: 7 }, { ...entry.builtin_proof, loader: "arbitrary" }]) {
    const changed = structuredClone(agent); changed.profile.capabilities.entries[0]!.builtin_proof = proof as never;
    assert.throws(() => decodeAgentRecordV1(changed), /builtin|unknown record key/);
  }
});

test("exact-key, phase and state matrices fail closed", () => {
  const state = fixture();
  assert.throws(() => decodeAgentRecordV1({ ...state.agents[0]!.agent, extra: true }), /unknown record key/);
  assert.throws(() => decodeTaskRecordV1({ ...state.agents[0]!.tasks[0], phase: "running" }), /active fields mismatch/);
  assert.throws(() => decodeOutboxRecordV1({ ...state.agents[0]!.outbox[0], wake_state: "claimed" }), /delivered mismatch/);
  assert.throws(() => decodeAgentRecordV1({ ...state.agents[0]!.agent, availability: "available", unavailable_reason: "storage-corrupt" }), /availability fields mismatch/);
});

test("normalized invariants accept complete state and reject queue/card/outbox/receipt drift", () => {
  const state = fixture(); validateNormalizedStoreStateV1(state);
  // 投递彻底结束（delivered、wake settled、无待结算 turn）的 Completion 可以没有 Inbox：那是保留策略回收掉的已读卡片。
  const retiredInbox = structuredClone(state); retiredInbox.root.inbox = []; validateNormalizedStoreStateV1(retiredInbox);
  const pendingTurn = structuredClone(retiredInbox); pendingTurn.agents[0]!.outbox[0]!.turn_settlement = { version: 1, wake_epoch: pendingTurn.agents[0]!.outbox[0]!.wake_epoch, continuation_identity: "turn", state: "pending", pending_at: "2026-08-17T12:00:00.000Z" }; assert.throws(() => validateNormalizedStoreStateV1(pendingTurn), /exactly one recipient inbox/);
  const doubleInbox = structuredClone(state); doubleInbox.root.inbox.push({ ...doubleInbox.root.inbox[0]!, inbox_id: "inb_ZZZZZZZZZZZZZZZZZZZZZZ" as never }); assert.throws(() => validateNormalizedStoreStateV1(doubleInbox), /completion inbox contains duplicates|exactly one recipient inbox/);
  const wrongQueue = structuredClone(state); wrongQueue.agents[0]!.agent.queued_task_ids = [ID.task]; assert.throws(() => validateNormalizedStoreStateV1(wrongQueue), /queued task ids/);
  const badProof = structuredClone(state); badProof.agents[0]!.outbox[0]!.settlement_proof_sha256 = sha("bad"); assert.throws(() => validateNormalizedStoreStateV1(badProof), /settlement receipt mismatch/);
  const missingOrdinary = structuredClone(state); missingOrdinary.agents[0]!.outbox = []; missingOrdinary.agents[0]!.wake_receipts = []; assert.throws(() => validateNormalizedStoreStateV1(missingOrdinary), /ordinary completion outbox cardinality/);
});

test("operation receipt persists the request digest and rejects contradictory identity", () => {
  const receipt = { version: 1, record_revision: 1, receipt_id: ID.receipt, request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operation_digest: sha("operation"), caller: mainRef, runtime_generation: 1, operation: "send-message", state: "committed", transaction_id: ID.transaction, result_sha256: sha("{}"), result_json: "{}", created_at: TIME, settled_at: TIME } as const;
  assert.deepEqual(decodeOperationReceiptV1(receipt), receipt);
  const { operation_digest: _digest, ...missing } = receipt;
  assert.throws(() => decodeOperationReceiptV1(missing), /missing/);
  assert.throws(() => decodeOperationReceiptV1({ ...receipt, operation_digest: "0" }), /operation digest/);
});

test("prepared artifact ownership is derived from the reserved Agent and operation kind", () => {
  const tx = "txn_GGGGGGGGGGGGGGGGGGGGGG"; const agent = ID.agent; const task = ID.task;
  const base = { version: 1, transaction_id: tx, operation: "spawn", base_revision: 0, proposed_revision: 1, created_at: TIME, prepared_operation: {lease_owner: mainRef,  kind: "local-admission", request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", caller: mainRef, operation_digest: sha("op"), reserved_agent_id: agent, reserved_task_id: task, reserved_task_path: "/root/a", structural_parent: mainRef, logical_lease_key: task, public_result_json: "{}", public_result_sha256: sha("{}"), phase: "prepared" }, lease_intents: [{ api_version: 1, session_id: "main-session", owner_id: "pi-subagents", logical_key: task, reason: "spawn" }], artifacts: [{ temporary_path: `prepared/${tx}/artifacts/session.jsonl`, final_path: `conversations/${agent}/session.jsonl`, bytes: 1, sha256: sha("s"), kind: "conversation" }, { temporary_path: `prepared/${tx}/artifacts/system-prompt.txt`, final_path: `conversations/${agent}/system-prompt.txt`, bytes: 1, sha256: sha("p"), kind: "system-prompt" }] };
  assert.doesNotThrow(() => decodePrepareRecordV1(base));
  const malicious = structuredClone(base); malicious.artifacts[0]!.final_path = "CURRENT"; assert.throws(() => decodePrepareRecordV1(malicious), /path\/owner mismatch/);
  const followup = structuredClone(base); followup.prepared_operation.reserved_agent_id = undefined as never; followup.prepared_operation.kind = "local-admission"; assert.throws(() => decodePrepareRecordV1(followup), /non-spawn.*artifacts/);
});

test("OwnerEvent cursors and tree ownership fail closed", () => {
  const state = fixture();
  const broken = structuredClone(state); broken.agents[0]!.agent.task_path = "/root/wrong"; assert.throws(() => validateNormalizedStoreStateV1(broken), /task path mismatch/);
  const eventGap = structuredClone(state); eventGap.root.next_owner_event_sequence = 3; assert.throws(() => validateNormalizedStoreStateV1(eventGap), /next owner event sequence mismatch/);
});

test("an Outbox turn settlement decodes only on delivered records with a matching epoch", () => {
  const delivered = { version: 1, record_revision: 3, outbox_id: ID.outbox, kind: "completion-wake", source: { kind: "agent", session_id: "child-session", agent_id: ID.agent }, recipient: mainRef, completion_ids: [ID.completion], state: "delivered", wake_state: "settled", delivery_attempts: 1, wake_epoch: 1, settlement_kind: "producer-fallback", settlement_proof_id: ID.receipt, settlement_proof_sha256: sha("proof"), created_at: TIME, updated_at: TIME, delivered_at: TIME };
  const turn = { version: 1, wake_epoch: 1, continuation_identity: "entry-1", state: "pending", pending_at: TIME };
  assert.deepEqual(decodeOutboxRecordV1({ ...delivered, turn_settlement: turn }).turn_settlement, turn);
  assert.equal(decodeOutboxRecordV1({ ...delivered, turn_settlement: { ...turn, state: "settled", settled_at: TIME } }).turn_settlement?.state, "settled");
  assert.equal(decodeOutboxRecordV1(delivered).turn_settlement, undefined, "records written before the field stay unknown, never guessed");
  assert.throws(() => decodeOutboxRecordV1({ ...delivered, turn_settlement: { ...turn, wake_epoch: 2 } }), /turn settlement mismatch/);
  assert.throws(() => decodeOutboxRecordV1({ ...delivered, turn_settlement: { ...turn, state: "settled" } }), /settled_at/);
  const { settlement_kind: _kind, settlement_proof_id: _proof, settlement_proof_sha256: _sha, delivered_at: _at, ...transient } = delivered;
  assert.throws(() => decodeOutboxRecordV1({ ...transient, state: "cards-appended", wake_state: "not-offered", turn_settlement: turn }), /turn settlement mismatch/);
});
