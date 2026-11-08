import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { DeliveryEngineV1, driveOutboxDeliveryV1, reconcileMainDeliveryV1 } from "../../src/host/delivery-engine.ts";
import { AgentHostCoreV1 } from "../../src/host/core.ts";
import { createProducerProofRegistryV1 } from "../../src/host/producer-proof.ts";
import { canonicalJsonV1 } from "../../src/persistence/canonical.ts";
import { freezeCompletionProjectionV1, planTaskSettlementV1 } from "../../src/persistence/settlement.ts";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.ts";
import type { NormalizedStoreStateV1 } from "../../src/persistence/types.ts";
import type { MainStoreCommitInputV1 } from "../../src/persistence/store.ts";

const agent = encodeDomainId("agt", Buffer.alloc(16, 111)); const task = encodeDomainId("tsk", Buffer.alloc(16, 112)); const txn = encodeDomainId("txn", Buffer.alloc(16, 113)); const sha = (v: string) => createHash("sha256").update(v).digest("hex"); const at = "2027-01-01T00:00:00.000Z";
const profile = {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin", body: "role", sha256: sha("role") }, provider: "openai-codex", model: "gpt-5.4", model_scope: ["openai-codex/gpt-5.4"], reasoning_effort: "high" as const, task_timeout_ms: 60_000, cwd: "/tmp", project_trusted: true, system_prompt_options_sha256: sha("o"), prompt_assembler_version: 1 as const, system_prompt_relative_path: `conversations/${agent}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: sha("p"), capabilities: { version: 1 as const, fingerprint: sha("c"), active_tools: [], tool_definitions: [], entries: [] }, created_at: at };
function running(): NormalizedStoreStateV1 { return { root: { version: 1, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 2, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [agent], mailbox: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] }, agents: [{ version: 1, host_revision: 1, agent: {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: 1, agent_id: agent, parent_conversation: { kind: "main", session_id: "main" }, task_name: "worker", task_path: "/root/worker", depth: 1, created_at: at, created_revision: 1, profile, conversation: { session_id: "child", relative_path: `conversations/${agent}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", current_task_id: task, queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 }, tasks: [{initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main"}}, owner_conversation: {kind: "main" as const, session_id: "main"},  version: 1, record_revision: 1, task_id: task, agent_id: agent, origin: "initial", admission_order: 1, message: "work", phase: "running", admitted_at: at, started_at: at, deadline_at_ms: 1, runtime_generation: 1, lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: task, reason: "work" }, lease_disposition: "required" }], mailbox: [], completions: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [] }] }; }

test("claimed Goal Wake skips producer continuation and terminalizes from consumer receipt", async () => { const outboxId = encodeDomainId("out", Buffer.alloc(16, 120)); const completionId = encodeDomainId("cmp", Buffer.alloc(16, 121)); const calls: unknown[] = []; const host = { snapshot: () => ({ root: { inbox: [], outbox: [] }, agents: [{ completions: [{ completion_id: completionId, task_id: task, outcome: "completed" }], inbox: [], outbox: [{ outbox_id: outboxId, completion_ids: [completionId], recipient: { kind: "main", session_id: "main" }, state: "cards-appended", wake_state: "not-offered" }] }] }), async openOutboxWake(input: unknown) { calls.push(["open", input]); return { ok: true, host_revision: 1, value: { wake_epoch: 1 } }; }, async markOutboxWakeSettled(input: unknown) { calls.push(["pending", input]); return { ok: true, host_revision: 2, value: { pending: true } }; }, async terminalizeOutbox(input: unknown) { calls.push(["terminal", input]); return { ok: true, host_revision: 3, value: { delivered: true, receipt_id: "rcp" } }; } } as unknown as AgentHostCoreV1; let appended = false; const wake = { snapshot: () => ({ sessionId: "main", offerId: "offer-goal", offerGeneration: 1, ownerId: "pi-subagents", logicalKey: task, state: "claimed" }), hasClaim: () => true, commit: () => ({ ok: true as const, value: { state: "committed", delivery: "delivered", consumerReceipt: { version: 1, consumerId: "pi-goal-local", consumerGeneration: 7, continuationId: "goal-continuation", scheduling: "scheduled" } } }), abort: () => ({ ok: true as const, value: { state: "aborted" } }) }; const engine = new DeliveryEngineV1({ host, releaseWake: () => wake, resolveAppendPort: (recipient) => ({ conversation: recipient, async appendCompletion() {}, async proveCompletion() { throw new Error("unused"); }, async appendContinuation() { appended = true; }, async proveContinuation() { throw new Error("unused"); } }) }); const result = await engine.settleWake(outboxId); assert.deepEqual(result, { state: "delivered", kind: "goal-claimed" }); assert.equal(appended, false); const terminal = (calls.at(-1) as [string, Record<string, unknown>])[1]; assert.equal(terminal.claimantOwnerId, "pi-goal-local"); assert.equal(terminal.claimantGeneration, 7); assert.equal(terminal.continuationIdentity, "goal-continuation"); });

test("delivery engine persists append proof before cards-appended", async () => { let state = running(); const settlement = planTaskSettlementV1(state, { transactionId: txn, taskId: task, completedAt: at, outcome: "completed", reason: "normal-final", finalText: "done", summary: "done" }); state = applyJournalMutationsV1(state, 2, settlement.mutations, "settle-task"); const store = { mainRoot: "/tmp", snapshot: () => structuredClone(state), async commit(input: MainStoreCommitInputV1) { state = applyJournalMutationsV1(state, state.root.host_revision + 1, input.mutations, input.operation); return { revision: state.root.host_revision, proof: "sync" as const, transactionId: input.transactionId }; } }; const host = new AgentHostCoreV1({ mainSessionId: "main", instanceGeneration: 1, config: { maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 }, store, leases: { async acquire() { throw new Error("unused"); } }, runtime: { residency: () => undefined, async interrupt() {} }, scheduler: { taskAdmitted() {} }, now: () => new Date(at) }); const calls: string[] = []; let appended = false; const wake = { snapshot: () => ({ sessionId: "main", offerId: "offer-1", offerGeneration: 1, ownerId: "pi-subagents", logicalKey: task, state: "open" }), hasClaim: () => false, commit: () => ({ ok: true as const, value: { state: "committed", delivery: "delivered" } }), abort: () => ({ ok: true as const, value: { state: "aborted" } }) }; const engine = new DeliveryEngineV1({ host, now: () => new Date(at), releaseWake: () => wake, resolveAppendPort: (recipient) => ({ conversation: recipient, async appendCompletion(input) { calls.push(`append:${input.completionId}`); appended = true; }, async proveCompletion(input) { assert.equal(appended, true); calls.push(`prove:${input.completionId}`); return { entryId: "entry-1", completionId: input.completionId, projectionSha256: input.projectionSha256 }; }, async appendContinuation(input) { calls.push(`continue:${input.outboxId}`); }, async proveContinuation(input) { return { entryId: "continuation-1", continuationSha256: input.continuationSha256 }; } }) }); const result = await engine.deliverOutbox(settlement.outbox!.outbox_id); assert.equal(result.state, "cards-appended"); assert.deepEqual(calls, [`append:${settlement.completion.completion_id}`, `prove:${settlement.completion.completion_id}`]); const snapshot = host.snapshot(); assert.equal(snapshot.root.inbox[0]!.state, "appended"); assert.equal(snapshot.root.inbox[0]!.model_entry_id, "entry-1"); assert.equal(snapshot.agents[0]!.outbox[0]!.state, "cards-appended"); assert.equal(snapshot.agents[0]!.outbox[0]!.delivery_attempts, 1); const delivered = await engine.settleWake(settlement.outbox!.outbox_id); assert.deepEqual(delivered, { state: "delivered", kind: "producer-fallback" }); const terminal = host.snapshot(); assert.equal(terminal.agents[0]!.outbox[0]!.state, "delivered"); assert.equal(terminal.agents[0]!.outbox[0]!.wake_state, "settled"); assert.equal(terminal.agents[0]!.wake_receipts[0]!.kind, "producer-fallback"); assert.equal(terminal.agents[0]!.tasks[0]!.lease_disposition, "released"); });

test("a barrier armed beside an already delivered Task still offers one accumulated Wake", async (t) => {
  const A = encodeDomainId("agt", Buffer.alloc(16, 1)); const B = encodeDomainId("agt", Buffer.alloc(16, 2));
  const TA = encodeDomainId("tsk", Buffer.alloc(16, 3)); const TB = encodeDomainId("tsk", Buffer.alloc(16, 4));
  const CA = encodeDomainId("cmp", Buffer.alloc(16, 5)); const IA = encodeDomainId("inb", Buffer.alloc(16, 6)); const OA = encodeDomainId("out", Buffer.alloc(16, 7));
  const T = at;
  const barrierProfile: any = { ...profile, system_prompt_relative_path: "" };
  // A 走的是普通 settlement：它已经拥有自己的 completion-wake Outbox，barrier 不再把它收进聚合集合。
  const outboxA: any = { version: 1, record_revision: 1, outbox_id: OA, kind: "completion-wake", source: { kind: "agent", session_id: "session-a", agent_id: A }, recipient: { kind: "main", session_id: "main" }, completion_ids: [CA], state: "cards-appended", wake_state: "not-offered", delivery_attempts: 1, wake_epoch: 0, created_at: T, updated_at: T };
  const partition = (id: string, name: string, taskId: string, mode: "settled" | "running"): any => {
    const p = { ...barrierProfile, system_prompt_relative_path: `conversations/${id}/system-prompt.txt` };
    const record: any = {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: 1, agent_id: id, parent_conversation: { kind: "main", session_id: "main" }, task_name: name, task_path: `/root/${name}`, depth: 1, created_at: T, created_revision: 1, profile: p, conversation: { session_id: `session-${name}`, relative_path: `conversations/${id}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", ...(mode === "running" ? { current_task_id: taskId } : {}), queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 };
    const base: any = {initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main"}}, owner_conversation: {kind: "main" as const, session_id: "main"},  version: 1, record_revision: 1, task_id: taskId, agent_id: id, origin: "initial", admission_order: id === A ? 1 : 2, message: "work", admitted_at: T, started_at: T, deadline_at_ms: Date.parse(T) + 60_000, runtime_generation: 1, lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: taskId, reason: "work" } };
    const taskRecord = mode === "running" ? { ...base, phase: "running", lease_disposition: "required" } : { ...base, phase: "settled", settled_at: T, outcome: "completed", reason: "normal-final", completion_id: CA, lease_disposition: "released" };
    const completions = mode === "settled" ? [{ version: 1, record_revision: 1, completion_id: CA, task_id: taskId, agent_id: id, recipient: { kind: "main", session_id: "main" }, outcome: "completed", reason: "normal-final", final_text: "done", summary: "done", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 }, task_admitted_at: T, task_started_at: T, completed_at: T }] : [];
    return { version: 1, host_revision: 1, agent: record, tasks: [taskRecord], mailbox: [], completions, inbox: [], outbox: mode === "settled" ? [outboxA] : [], owner_events: [], operation_receipts: [], wake_receipts: [] };
  };
  const inboxA: any = { version: 1, record_revision: 1, inbox_id: IA, completion_id: CA, recipient: { kind: "main", session_id: "main" }, projection: freezeCompletionProjectionV1({ completion: partition(A, "a", TA, "settled").completions[0], taskPath: "/root/a" }), state: "appended", created_at: T, append_attempts: 1, model_entry_id: "e1", model_appended_at: T };
  let state: any = { root: { version: 1, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 3, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [A, B].sort(), mailbox: [], inbox: [inboxA], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] }, agents: [partition(A, "a", TA, "settled"), partition(B, "b", TB, "running")].sort((x: any, y: any) => Buffer.from(x.agent.agent_id).compare(Buffer.from(y.agent.agent_id))) };
  const mainRoot = await realpath(await mkdtemp(join(tmpdir(), "barrier-lease-"))); await chmod(mainRoot, 0o700);
  await mkdir(join(mainRoot, "prepared"), { recursive: true, mode: 0o700 }); await mkdir(join(mainRoot, "conversations"), { recursive: true, mode: 0o700 });
  t.after(() => rm(mainRoot, { recursive: true, force: true }));
  const store: any = { mainRoot, snapshot: () => structuredClone(state), commit: async (input: MainStoreCommitInputV1) => { state = applyJournalMutationsV1(state, state.root.host_revision + 1, input.mutations, input.operation); return { revision: state.root.host_revision, proof: "sync" as const, transactionId: input.transactionId }; } };
  const acquired: string[] = [];
  const host = new AgentHostCoreV1({ mainSessionId: "main", instanceGeneration: 1, config: { maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 }, store, leases: { acquire: async ({ taskId }: any) => { acquired.push(taskId); return { leaseId: `lease-${taskId}`, generation: 1, releaseWithoutWake: async () => {}, releaseAndOfferWake: () => ({ snapshot: () => ({ sessionId: "main", offerId: "offer-1", offerGeneration: 1, ownerId: "pi-subagents", logicalKey: taskId }), hasClaim: () => false, abort: () => {}, commit: () => ({ ok: true, value: { delivery: "delivered" } }) }) }; } }, runtime: { residency: () => undefined, interrupt: async () => {} }, scheduler: { taskAdmitted: () => {} }, now: () => new Date(T) } as any);
  await host.recoverRootTaskLeases();
  assert.deepEqual(acquired, [TB]);
  const caller = { kind: "main-model" as const, conversation: { kind: "main" as const, session_id: "main" }, binding_generation: 1 };
  const armed = await host.waitAgents({ request_id: "00000000-0000-4000-8000-000000000001", caller, input: { targets: ["/root/a", "/root/b"] } });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.deepEqual(state.root.barrier.task_ids, [TB], "barrier 只 snapshot 还要等的 Task");
  const settled = await host.settleTask({ agentId: B as any, taskId: TB as any, runtimeGeneration: 1, completedAt: T, outcome: "completed", reason: "normal-final", finalText: "ok", summary: "ok" });
  assert.equal(settled.ok, true); if (!settled.ok) return;
  const outboxId = settled.value.outbox_id!;
  const port: any = { conversation: { kind: "main", session_id: "main" }, appendCompletion: async () => {}, proveCompletion: async (i: any) => ({ entryId: "e2", completionId: i.completionId, projectionSha256: i.projectionSha256 }), appendContinuation: async () => {}, proveContinuation: async (i: any) => ({ entryId: "e3", continuationSha256: i.continuationSha256 }) };
  const engine = new DeliveryEngineV1({ host, resolveAppendPort: () => port });
  assert.equal((await engine.deliverOutbox(outboxId)).state, "cards-appended");
  const wake = await engine.settleWake(outboxId);
  assert.equal(wake.state, "delivered");
  const outbox = [state.root, ...state.agents].flatMap((item: any) => item.outbox).find((item: any) => item.outbox_id === outboxId);
  assert.equal(outbox.state, "delivered");
});

const continuationSha = (outboxId: string, completionId: string, wakeEpoch: number) => createHash("sha256").update(canonicalJsonV1({ custom_type: "subagent-continuation-v1", content: `Subagent results ${completionId} are ready. Continue from the delivered completion cards.`, details: { version: 1, outbox_id: outboxId, wake_epoch: wakeEpoch, completion_ids: [completionId] } })).digest("hex");

test("card delivery ownership survives engine replacement and releases after an append failure", async () => {
  const outboxId = encodeDomainId("out", Buffer.alloc(16, 140)), completionId = encodeDomainId("cmp", Buffer.alloc(16, 141));
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const beginEntered = gate(), beginRelease = gate(), appendEntered = gate(), appendRelease = gate();
  const recipient = { kind: "main" as const, session_id: "main" };
  const outbox = { outbox_id: outboxId, recipient, completion_ids: [completionId], state: "pending" };
  const inbox = { inbox_id: "inbox", completion_id: completionId, state: "pending-append", projection: { projection_sha256: sha("projection") } };
  let begins = 0, appends = 0, proofs = 0, cards = 0, failAppend = true;
  const host = {
    snapshot: () => structuredClone({ root: { outbox: [outbox], inbox: [inbox] }, agents: [] }),
    async beginOutboxDelivery() { begins++; beginEntered.resolve(); await beginRelease.promise; outbox.state = "delivering"; return { ok: true, value: {} }; },
    async proveInboxAppended() { proofs++; inbox.state = "appended"; return { ok: true, value: {} }; },
    async markOutboxCardsAppended() { cards++; outbox.state = "cards-appended"; return { ok: true, value: {} }; },
  } as unknown as AgentHostCoreV1;
  const port = { conversation: recipient,
    async appendCompletion() { appends++; appendEntered.resolve(); await appendRelease.promise; if (failAppend) throw new Error("controlled append failure"); },
    async proveCompletion(input: { completionId: string; projectionSha256: string }) { return { entryId: "entry", ...input }; },
  };
  const original = new DeliveryEngineV1({ host, resolveAppendPort: () => port }), replacement = new DeliveryEngineV1({ host, resolveAppendPort: () => port });
  const drive = (engine: DeliveryEngineV1) => driveOutboxDeliveryV1(outboxId, async () => { await engine.deliverOutbox(outboxId); });
  const failed = assert.rejects(drive(original), /controlled append failure/u);
  try {
    await beginEntered.promise;
    assert.deepEqual(await drive(replacement), { state: "skipped", reason: "delivering" });
    beginRelease.resolve(); await appendEntered.promise;
    original.dispose();
    assert.deepEqual(await drive(replacement), { state: "skipped", reason: "delivering" });
  } finally { beginRelease.resolve(); appendRelease.resolve(); await failed; }
  assert.equal(outbox.state, "delivering");
  failAppend = false;
  assert.deepEqual(await drive(replacement), { state: "completed" });
  assert.equal(outbox.state, "cards-appended");
  assert.deepEqual({ begins, appends, proofs, cards }, { begins: 1, appends: 2, proofs: 1, cards: 1 });
});

function openWakeHost(input: { readonly outboxId: string; readonly completionId: string; readonly state: string; readonly wakeState: string; readonly wakeEpoch: number; readonly nextEpoch: number; readonly calls: unknown[] }): AgentHostCoreV1 {
  const outbox = { outbox_id: input.outboxId, completion_ids: [input.completionId], recipient: { kind: "main", session_id: "main" }, state: input.state, wake_state: input.wakeState, wake_epoch: input.wakeEpoch, ...(input.state === "wake-settlement-pending" ? { settlement_kind: "producer-fallback" } : {}) };
  return {
    snapshot: () => ({ root: { inbox: [], outbox: [] }, agents: [{ completions: [{ completion_id: input.completionId, task_id: task, outcome: "completed" }], inbox: [], outbox: [outbox] }] }),
    hasRootTaskLease: () => false,
    async openOutboxWake(value: unknown) { input.calls.push(["open", value]); return { ok: true, host_revision: 1, value: { wake_epoch: input.nextEpoch } }; },
    async markOutboxWakeSettled(value: unknown) { input.calls.push(["pending", value]); return { ok: true, host_revision: 2, value: { pending: true } }; },
    async terminalizeOutbox(value: unknown) { input.calls.push(["terminal", value]); return { ok: true, host_revision: 3, value: { delivered: true, receipt_id: "rcp" } }; },
  } as unknown as AgentHostCoreV1;
}

test("a Wake exception releases driver ownership so the next reconcile can deliver", async () => {
  const outboxId = encodeDomainId("out", Buffer.alloc(16, 142)), completionId = encodeDomainId("cmp", Buffer.alloc(16, 143));
  const outbox = { outbox_id: outboxId, completion_ids: [completionId], recipient: { kind: "main", session_id: "main" }, state: "cards-appended", wake_state: "not-offered", wake_epoch: 0 };
  const host = {
    snapshot: () => structuredClone({ root: { inbox: [], outbox: [] }, agents: [{ completions: [{ completion_id: completionId, task_id: task, outcome: "completed" }], inbox: [], outbox: [outbox] }] }),
    async openOutboxWake() { outbox.wake_state = "open"; outbox.wake_epoch++; return { ok: true, value: { wake_epoch: outbox.wake_epoch } }; },
    async markOutboxWakeSettled() { outbox.state = "wake-settlement-pending"; return { ok: true, value: {} }; },
    async terminalizeOutbox() { outbox.state = "delivered"; return { ok: true, value: {} }; },
  } as unknown as AgentHostCoreV1;
  let attempts = 0, continuations = 0, commits = 0;
  const wake = { snapshot: () => ({ sessionId: "main", offerId: "offer-driver-retry", offerGeneration: 1, ownerId: "pi-subagents", logicalKey: task, state: "open" }), hasClaim: () => false,
    commit: () => { commits++; return { ok: true as const, value: { state: "committed", delivery: "delivered" } }; }, abort: () => ({ ok: true as const, value: { state: "aborted" } }) };
  const engine = new DeliveryEngineV1({ host, releaseWake: () => { if (++attempts === 1) throw new Error("controlled Wake failure"); return wake; },
    resolveAppendPort: recipient => ({ conversation: recipient, async appendCompletion() { throw new Error("cards must not be repeated"); }, async proveCompletion() { throw new Error("unused"); },
      async appendContinuation() { continuations++; }, async proveContinuation(input) { return { entryId: "continuation-driver-retry", continuationSha256: input.continuationSha256 }; } }) });
  await assert.rejects(driveOutboxDeliveryV1(outboxId, async () => { await engine.settleWake(outboxId); }), /controlled Wake failure/u);
  assert.equal(outbox.state, "cards-appended");
  const reports: unknown[] = [];
  assert.deepEqual(await reconcileMainDeliveryV1({ host, delivery: engine, mainSessionId: "main", report: value => reports.push(value) }),
    { delivered: [outboxId], deferred: [], failed: [] });
  assert.equal(outbox.state, "delivered");
  assert.deepEqual({ attempts, continuations, commits }, { attempts: 2, continuations: 1, commits: 1 });
  assert.deepEqual(reports, []);
});

test("an open Wake retry refuses a continuation entry from an older epoch", async () => {
  const outboxId = encodeDomainId("out", Buffer.alloc(16, 130)); const completionId = encodeDomainId("cmp", Buffer.alloc(16, 131));
  const calls: unknown[] = []; const asked: unknown[] = [];
  const host = openWakeHost({ outboxId, completionId, state: "cards-appended", wakeState: "open", wakeEpoch: 2, nextEpoch: 3, calls });
  // 旧 port 契约只按 outbox_id 找：它交出的是上一个 epoch 那条合法 entry。
  const engine = new DeliveryEngineV1({ host, offerWake: () => { throw new Error("must not re-offer before the evidence check"); }, resolveAppendPort: (recipient) => ({ conversation: recipient, async appendCompletion() {}, async proveCompletion() { throw new Error("unused"); }, async appendContinuation() { throw new Error("unused"); }, async proveContinuation() { throw new Error("unused"); }, async findContinuation(value: unknown) { asked.push(value); return { entryId: "stale-entry", wakeEpoch: 1, continuationSha256: continuationSha(outboxId, completionId, 1) }; } }) });
  await assert.rejects(engine.retryOpenWake(outboxId), /does not match the durable Wake epoch/u);
  assert.deepEqual(asked, [{ outboxId, wakeEpoch: 2 }], "retry 必须按 durable epoch 精确取证");
  assert.deepEqual(calls, [], "旧 epoch 的 entry 不许写出任何终态");
});

test("a failed Wake commit returns the reserved producer proof capacity", async () => {
  const outboxId = encodeDomainId("out", Buffer.alloc(16, 132)); const completionId = encodeDomainId("cmp", Buffer.alloc(16, 133));
  const calls: unknown[] = [];
  const registry = createProducerProofRegistryV1(1);
  const host = openWakeHost({ outboxId, completionId, state: "cards-appended", wakeState: "not-offered", wakeEpoch: 0, nextEpoch: 1, calls });
  const wake = { snapshot: () => ({ sessionId: "main", offerId: "offer-commit-fail", offerGeneration: 1, ownerId: "pi-subagents", logicalKey: task }), hasClaim: () => false, commit: () => ({ ok: false as const, error: { code: "offer-gone" } }), abort: () => ({ ok: true as const, value: { state: "aborted" } }) };
  const engine = new DeliveryEngineV1({ host, releaseWake: () => wake as never, producerProofRegistry: registry, ownerToken: "main:test", ownerGeneration: 1, resolveAppendPort: (recipient) => ({ conversation: recipient, async appendCompletion() {}, async proveCompletion() { throw new Error("unused"); }, async appendContinuation() {}, async proveContinuation(value) { return { entryId: "entry-commit-fail", continuationSha256: value.continuationSha256 }; } }) });
  await assert.rejects(engine.settleWake(outboxId), /Wake commit failed/u);
  assert.equal(registry.get({ session_id: "main", offer_id: "offer-commit-fail", offer_generation: 1 }), undefined, "死掉的 offer 不留 active proof");
  // 容量只有 1：commit 失败必须把它还回去，下一条 Outbox 才 reserve 得到。
  const next = registry.reserve({ key: { session_id: "main", offer_id: "offer-next", offer_generation: 1 }, owner_token: "main:test", owner_generation: 1 });
  assert.equal(next.ok, true, "commit 失败之后 proof 容量必须归还");
  assert.deepEqual(calls.map((item) => (item as [string])[0]), ["open"], "commit 失败不写任何结算元数据");
});

test("one contradictory Outbox does not starve the rest of the reconcile pass", async () => {
  const bad = encodeDomainId("out", Buffer.alloc(16, 134)); const good = encodeDomainId("out", Buffer.alloc(16, 135));
  const outboxes = [
    { outbox_id: bad, recipient: { kind: "main", session_id: "main" }, state: "wake-settlement-pending", wake_state: "fallback-appended", settlement_kind: "producer-fallback", wake_epoch: 1 },
    { outbox_id: good, recipient: { kind: "main", session_id: "main" }, state: "cards-appended", wake_state: "not-offered", wake_epoch: 0 },
  ];
  const host = { snapshot: () => ({ root: { outbox: outboxes }, agents: [] }) } as unknown as AgentHostCoreV1;
  const settled: string[] = []; const reports: { operation: string; error: unknown }[] = [];
  const delivery = {
    async deliverOutbox() { throw new Error("unused"); },
    async settleWake(outboxId: string) { settled.push(outboxId); return { state: "delivered" as const, kind: "producer-fallback" as const }; },
    async retryOpenWake() { return { state: "skipped" as const, reason: "not-open" as const }; },
    async settlePendingWake() { throw new Error("Main continuation native entry conflicts with the frozen projection"); },
  } as unknown as DeliveryEngineV1;
  await reconcileMainDeliveryV1({ host, delivery, mainSessionId: "main", report: (input) => reports.push(input) });
  assert.deepEqual(settled, [good], "矛盾的那一条不能饿死后面的 Outbox");
  assert.equal(reports.length, 1);
  assert.match((reports[0]!.error as Error).message, /conflicts with the frozen projection/u);
});
