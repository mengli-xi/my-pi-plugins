// SUB-PENDING-STATE-003: owner-level turn settlement (DELIVERY_PROTOCOL §7.9). `delivered` only proves the
// message landed and one wake was requested; whether the model handled the cards in a non-aborted,
// non-errored Main run is recorded separately as `turn_settlement` and settled by the Main-side owner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { DeliveryEngineV1 } from "../../src/host/delivery-engine.ts";
import { AgentHostCoreV1 } from "../../src/host/core.ts";
import { MAIN_RUN_COMPLETED_CUSTOM_TYPE, MainTurnSettlementV1, completionCardInboxIdsV1, mainRunFailedV1, pendingTurnOutboxesV1 } from "../../src/host/main-turn-settlement.ts";
import { validateNormalizedStoreStateV1 } from "../../src/persistence/invariants.ts";
import { planTaskSettlementV1 } from "../../src/persistence/settlement.ts";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.ts";
import { pruneForCheckpointV1 } from "../../src/persistence/retention.ts";
import { planRecoveryV1 } from "../../src/persistence/recovery.ts";
import { decodeOutboxRecordV1, rootHeaderV1 } from "../../src/persistence/codecs.ts";
import type { NormalizedStoreStateV1, OutboxRecordV1 } from "../../src/persistence/types.ts";
import type { MainStoreCommitInputV1 } from "../../src/persistence/store.ts";

const agent = encodeDomainId("agt", Buffer.alloc(16, 111)); const task = encodeDomainId("tsk", Buffer.alloc(16, 112)); const txn = encodeDomainId("txn", Buffer.alloc(16, 113)); const sha = (v: string) => createHash("sha256").update(v).digest("hex"); const at = "2027-01-01T00:00:00.000Z";
const profile = {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin", body: "role", sha256: sha("role") }, provider: "openai-codex", model: "gpt-5.4", model_scope: ["openai-codex/gpt-5.4"], reasoning_effort: "high" as const, task_timeout_ms: 60_000, cwd: "/tmp", project_trusted: true, system_prompt_options_sha256: sha("o"), prompt_assembler_version: 1 as const, system_prompt_relative_path: `conversations/${agent}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: sha("p"), capabilities: { version: 1 as const, fingerprint: sha("c"), active_tools: [], tool_definitions: [], entries: [] }, created_at: at };
function running(): NormalizedStoreStateV1 { return { root: { version: 1, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 2, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [agent], mailbox: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] }, agents: [{ version: 1, host_revision: 1, agent: {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: 1, agent_id: agent, parent_conversation: { kind: "main", session_id: "main" }, task_name: "worker", task_path: "/root/worker", depth: 1, created_at: at, created_revision: 1, profile, conversation: { session_id: "child", relative_path: `conversations/${agent}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", current_task_id: task, queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 }, tasks: [{initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main"}}, owner_conversation: {kind: "main" as const, session_id: "main"},  version: 1, record_revision: 1, task_id: task, agent_id: agent, origin: "initial", admission_order: 1, message: "work", phase: "running", admitted_at: at, started_at: at, deadline_at_ms: 1, runtime_generation: 1, lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: task, reason: "work" }, lease_disposition: "required" }], mailbox: [], completions: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [] }] }; }


function harness(initial = running()) {
  let state = initial;
  const settlements = initial.agents.flatMap(partition => partition.tasks).map((item, index) => {
    const settlement = planTaskSettlementV1(state, { transactionId: index === 0 ? txn : encodeDomainId("txn", Buffer.alloc(16, 113 + index)), taskId: item.task_id, completedAt: at, outcome: "completed", reason: "normal-final", finalText: "done", summary: "done" });
    state = applyJournalMutationsV1(state, state.root.host_revision + 1, settlement.mutations, "settle-task");
    return settlement;
  });
  const settlement = settlements[0]!;
  const store = { mainRoot: "/tmp", snapshot: () => structuredClone(state), async commit(input: MainStoreCommitInputV1) { state = applyJournalMutationsV1(state, state.root.host_revision + 1, input.mutations, input.operation); return { revision: state.root.host_revision, proof: "sync" as const, transactionId: input.transactionId }; } };
  const host = new AgentHostCoreV1({ mainSessionId: "main", instanceGeneration: 1, config: { maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 }, store, leases: { async acquire() { throw new Error("unused"); } }, runtime: { residency: () => undefined, async interrupt() {} }, scheduler: { taskAdmitted() {} }, now: () => new Date(at) });
  const wake = { snapshot: () => ({ sessionId: "main", offerId: "offer-1", offerGeneration: 1, ownerId: "pi-subagents", logicalKey: task, state: "open" }), hasClaim: () => false, commit: () => ({ ok: true as const, value: { state: "committed", delivery: "delivered" } }), abort: () => ({ ok: true as const, value: { state: "aborted" } }) };
  const engine = new DeliveryEngineV1({ host, now: () => new Date(at), releaseWake: ({ taskId }) => ({ ...wake, snapshot: () => ({ ...wake.snapshot(), offerId: `offer:${taskId}`, logicalKey: taskId }) }), resolveAppendPort: (recipient) => ({ conversation: recipient, async appendCompletion() {}, async proveCompletion(input) { return { entryId: input.inboxId === settlement.inbox.inbox_id ? "entry-1" : `entry:${input.inboxId}`, completionId: input.completionId, projectionSha256: input.projectionSha256 }; }, async appendContinuation() {}, async proveContinuation(input) { return { entryId: input.outboxId === settlement.outbox!.outbox_id ? "continuation-1" : `continuation:${input.outboxId}`, continuationSha256: input.continuationSha256 }; } }) });
  const outboxId = settlement.outbox!.outbox_id; const inboxId = settlement.inbox.inbox_id;
  const card = { role: "custom", customType: "subagent-completion-v1", content: "card", display: true, details: { inbox_id: inboxId } };
  const tracker = new MainTurnSettlementV1();
  return {
    host, outboxId, inboxId, card, tracker,
    obligations: settlements.map(item => ({ outboxId: item.outbox!.outbox_id, inboxId: item.inbox.inbox_id })),
    deliver: async (id = outboxId) => { await engine.deliverOutbox(id); await engine.settleWake(id); },
    deliverCards: (id = outboxId) => engine.deliverOutbox(id),
    settleWake: () => engine.settleWake(outboxId),
    outbox: (id = outboxId): OutboxRecordV1 => host.snapshot().agents.flatMap(partition => partition.outbox).find(item => item.outbox_id === id)!,
    settle: () => tracker.settle({ host, mainSessionId: "main", at }),
    mutate: (fn: (value: NormalizedStoreStateV1) => void) => { fn(state); },
  };
}
const PENDING = { version: 1 as const, wake_epoch: 1, continuation_identity: "continuation-1", state: "pending" as const, pending_at: at };

test("terminalizing an Outbox records a pending turn keyed by the settlement receipt", async () => {
  const h = harness(); await h.deliver();
  const outbox = h.outbox(); const receipt = h.host.snapshot().agents[0]!.wake_receipts[0]!;
  assert.equal(outbox.state, "delivered");
  assert.deepEqual(outbox.turn_settlement, PENDING);
  assert.equal(outbox.turn_settlement!.continuation_identity, receipt.continuation_identity);
  assert.deepEqual(pendingTurnOutboxesV1(h.host.snapshot(), "main").map((item) => item.outbox_id), [h.outboxId]);
  assert.deepEqual(pendingTurnOutboxesV1(h.host.snapshot(), "another-main"), [], "another Main never sees this pending turn");
  validateNormalizedStoreStateV1(h.host.snapshot());
});

test("aborted, errored, card-less, or still-running runs never settle; one durable successful run with the cards settles once", async ctx => {
  const h = harness(); await h.deliver(); const t = h.tracker;
  const p = await persistentCard(ctx, h);
  t.runStarted(); t.observeContext([h.card]); t.runEnded(true);
  assert.deepEqual(await h.settle(), [], "an aborted run does not settle");
  assert.equal(h.outbox().turn_settlement!.state, "pending");
  t.runStarted(); t.observeContext([{ role: "user", content: "hello" }]); t.runEnded(false);
  assert.deepEqual(await h.settle(), [], "a run that never saw the card does not settle");
  assert.equal(h.outbox().turn_settlement!.state, "pending");
  t.runStarted(); t.observeContext([h.card]);
  assert.deepEqual(await h.settle(), [], "a delivery boundary inside a still-running run does not settle");
  p.session.appendMessage(fauxAssistantMessage("handled"));
  await t.recordRunEnded({ failed: false, pi: p.pi, ctx: p.ctx, state: h.host.snapshot() });
  assert.deepEqual(await h.settle(), [h.outboxId]);
  assert.deepEqual(h.outbox().turn_settlement, { ...PENDING, state: "settled", settled_at: at });
  assert.deepEqual(await h.settle(), [], "settling is idempotent");
  assert.deepEqual(t.handledInboxIds(), []);
  validateNormalizedStoreStateV1(h.host.snapshot());
});

test("cards durably handled before the terminal transaction settle at the next boundary", async ctx => {
  const h = harness(); const t = h.tracker;
  await h.deliverCards(); const p = await persistentCard(ctx, h);
  p.session.appendMessage(fauxAssistantMessage("handled"));
  t.runStarted(); t.observeContext([h.card]);
  await t.recordRunEnded({ failed: false, pi: p.pi, ctx: p.ctx, state: h.host.snapshot() });
  assert.deepEqual(await h.settle(), [], "nothing is delivered yet");
  assert.deepEqual(t.handledInboxIds(), [h.inboxId]);
  await h.settleWake();
  assert.equal(h.outbox().turn_settlement!.state, "pending");
  assert.deepEqual(await h.settle(), [h.outboxId], "the delivery boundary settles what the earlier successful run handled");
  assert.equal(h.outbox().turn_settlement!.state, "settled");
});

test("turn settlement is bound to the epoch and continuation identity and never regresses", async () => {
  const h = harness(); await h.deliver();
  assert.equal((await h.host.settleOutboxTurn({ outboxId: h.outboxId, wakeEpoch: 2, continuationIdentity: "continuation-1", at })).ok, false, "a foreign epoch cannot settle it");
  assert.equal((await h.host.settleOutboxTurn({ outboxId: h.outboxId, wakeEpoch: 1, continuationIdentity: "someone-else", at })).ok, false, "a foreign continuation cannot settle it");
  assert.equal(h.outbox().turn_settlement!.state, "pending");
  assert.equal((await h.host.settleOutboxTurn({ outboxId: h.outboxId, wakeEpoch: 1, continuationIdentity: "continuation-1", at })).ok, true);
  assert.equal((await h.host.settleOutboxTurn({ outboxId: h.outboxId, wakeEpoch: 1, continuationIdentity: "continuation-1", at })).ok, false, "settled is terminal");
  const state = h.host.snapshot(); const outbox = state.agents[0]!.outbox[0]!; const revision = state.root.host_revision + 1;
  const mutations = (value: OutboxRecordV1) => [
    { version: 1 as const, type: "put" as const, transaction_id: txn, entity_type: "root" as const, entity_id: "root", value: { ...rootHeaderV1(state.root), host_revision: revision } },
    { version: 1 as const, type: "put" as const, transaction_id: txn, entity_type: "outbox" as const, entity_id: outbox.outbox_id, value: { ...value, record_revision: revision } },
  ];
  const { settled_at: _settledAt, ...regressed } = outbox.turn_settlement!;
  assert.throws(() => applyJournalMutationsV1(state, revision, mutations({ ...outbox, turn_settlement: { ...regressed, state: "pending" } }), "settle-outbox-turn"), /pending to settled/);
  assert.throws(() => applyJournalMutationsV1(state, revision, mutations({ ...outbox, delivery_attempts: 9 }), "settle-outbox-turn"), /delivered Outbox is immutable/);
});

test("delivered records without a turn settlement are left alone instead of guessed", async ctx => {
  const h = harness(); await h.deliver();
  const p = await persistentCard(ctx, h);
  h.mutate((state) => { delete state.agents[0]!.outbox[0]!.turn_settlement; });
  assert.deepEqual(pendingTurnOutboxesV1(h.host.snapshot(), "main"), []);
  p.session.appendMessage(fauxAssistantMessage("handled"));
  h.tracker.runStarted(); h.tracker.observeContext([h.card]);
  await h.tracker.recordRunEnded({ failed: false, pi: p.pi, ctx: p.ctx, state: h.host.snapshot() });
  assert.deepEqual(await h.settle(), []);
  assert.equal(h.outbox().turn_settlement, undefined);
  assert.equal((await h.host.settleOutboxTurn({ outboxId: h.outboxId, wakeEpoch: 1, continuationIdentity: "continuation-1", at })).ok, false);
});

test("context cards and run failure are read from the Pi event shapes", () => {
  assert.deepEqual([...completionCardInboxIdsV1([{ role: "custom", customType: "subagent-completion-v1", details: { inbox_id: "inb_a" } }, { role: "custom", customType: "subagent-continuation-v1", details: { outbox_id: "out_a" } }, { role: "user", content: "x" }, null])], ["inb_a"]);
  assert.equal(mainRunFailedV1([{ role: "assistant", stopReason: "stop" }], false), false);
  assert.equal(mainRunFailedV1([{ role: "assistant", stopReason: "aborted" }], false), true);
  assert.equal(mainRunFailedV1([{ role: "assistant", stopReason: "error" }], false), true);
  assert.equal(mainRunFailedV1([{ role: "assistant", stopReason: "stop" }], true), true);
  assert.equal(mainRunFailedV1([{ role: "user", content: "x" }], false), true, "a run without any assistant message handled nothing");
});

async function persistentCard(t: test.TestContext, h: ReturnType<typeof harness>, inboxId = h.inboxId, existing?: { file: string; session: SessionManager }) {
  let file: string, session: SessionManager;
  if (existing) { file = existing.file; session = existing.session; }
  else {
    const directory = await mkdtemp(join(tmpdir(), "subagents-main-turn-proof-")); file = join(directory, "main.jsonl");
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "main", timestamp: at, cwd: directory }) + "\n");
    session = SessionManager.open(file);
  }
  const inbox = h.host.snapshot().root.inbox.find(item => item.inbox_id === inboxId)!;
  const card = { customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
    details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } };
  session.appendMessage({ role: "user", content: "handle the result", timestamp: Date.now() });
  session.appendCustomMessageEntry("unrelated-extension-message", "ordinary custom message", false);
  const entryId = session.appendCustomMessageEntry(card.customType, card.content, card.display, card.details);
  h.mutate(state => { const index = state.root.inbox.findIndex(item => item.inbox_id === inboxId); state.root.inbox[index] = { ...state.root.inbox[index]!, model_entry_id: entryId }; });
  const pi = { appendEntry<T>(customType: string, data: T) { session.appendCustomEntry(customType, data); } };
  return { file, session, card, entryId, pi, ctx: { sessionManager: session } };
}

test("a durable whole-run observation recovers the actual Host turn commit after owner replacement", async t => {
  const h = harness(); await h.deliver(); const p = await persistentCard(t, h);
  p.session.appendMessage(fauxAssistantMessage("handled"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...p.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: p.pi, ctx: p.ctx, state: h.host.snapshot() });
  assert.equal(h.outbox().turn_settlement!.state, "pending", "observation precedes the original source transaction");
  p.session.appendMessage(fauxAssistantMessage("later ordinary answer with the same history"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...p.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: p.pi, ctx: p.ctx, state: h.host.snapshot() });
  const reopened = SessionManager.open(p.file), fresh = new MainTurnSettlementV1();
  assert.equal(reopened.getBranch().filter(entry => entry.type === "custom" && entry.customType === MAIN_RUN_COMPLETED_CUSTOM_TYPE).length, 1);
  assert.deepEqual(await fresh.settle({ host: h.host, mainSessionId: "main", at, branch: reopened.getBranch() }), [h.outboxId]);
  assert.equal(h.outbox().turn_settlement!.state, "settled");
  assert.deepEqual(await fresh.settle({ host: h.host, mainSessionId: "main", at, branch: reopened.getBranch() }), [], "original epoch is committed once");
  validateNormalizedStoreStateV1(h.host.snapshot());
});

for (const stopReason of ["aborted", "error"] as const) test(`an earlier fulfilled toolUse request followed by ${stopReason} never restores business success`, async t => {
  const h = harness(); await h.deliver(); const p = await persistentCard(t, h);
  const assistantEntryId = p.session.appendMessage(fauxAssistantMessage("will continue", { stopReason: "toolUse" }));
  const mail = { producer: "pi-subagents", key: "card:" + h.inboxId, anchorEntryId: null, policy: "next-request", wake: false, messages: [p.card] };
  p.session.appendCustomEntry("agent-mailbox-delivery-v1", { version: 1, sessionId: "main", terminals: [{ mail, branchEntryId: p.entryId,
    evidence: { producer: "pi-subagents", key: mail.key, terminalId: "terminal", outcome: "fulfilled", scope: { sessionId: "main", anchorEntryId: null }, assistantEntryId, nativeEntryIds: [p.entryId] } }] });
  p.session.appendMessage(fauxAssistantMessage("failed later", { stopReason }));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...p.card }]);
  await h.tracker.recordRunEnded({ failed: true, pi: p.pi, ctx: p.ctx, state: h.host.snapshot() });
  const fresh = new MainTurnSettlementV1(), branch = SessionManager.open(p.file).getBranch();
  assert.equal(branch.some(entry => entry.type === "custom" && entry.customType === MAIN_RUN_COMPLETED_CUSTOM_TYPE), false);
  assert.equal(fresh.hasCardOpportunity({ state: h.host.snapshot(), mainSessionId: "main", branch, completionIds: h.outbox().completion_ids }), true, "the receipt still proves the transport opportunity");
  assert.deepEqual(fresh.handledInboxIds(), [], "transport proof never becomes whole-run success");
  assert.deepEqual(await fresh.settle({ host: h.host, mainSessionId: "main", at, branch }), []);
  assert.equal(h.outbox().turn_settlement!.state, "pending");
});

test("a missing durable successful-run write holds the dependent business transaction", async t => {
  const h = harness(); await h.deliver(); const p = await persistentCard(t, h);
  p.session.appendMessage(fauxAssistantMessage("handled"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...p.card }]);
  await assert.rejects(h.tracker.recordRunEnded({ failed: false, pi: { appendEntry() {} }, ctx: p.ctx, state: h.host.snapshot() }), /persistent transcript proof/);
  assert.deepEqual(await h.settle(), [], "the failed item cannot supply commit authority, but the queue remains usable");
  assert.equal(h.outbox().turn_settlement!.state, "pending");
  assert.equal((await readFile(p.file, "utf8")).includes(MAIN_RUN_COMPLETED_CUSTOM_TYPE), false);
});

for (const outcome of ["durable", "append-failure", "sync-failure"] as const) test(`an earlier settle cannot bypass a newly registered ${outcome} observation`, { timeout: 10_000 }, async t => {
  const h = harness(); await h.deliver(); const p = await persistentCard(t, h);
  p.session.appendMessage(fauxAssistantMessage("handled"));
  const events: string[] = []; let durable = false, commits = 0;
  let entered!: () => void, release!: () => void;
  const syncing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const handle = await open(p.file, "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync as FileHandle["sync"];
  await handle.close();
  t.mock.method(prototype, "sync", async function(this: FileHandle) {
    events.push("sync-enter"); entered(); await gate;
    if (outcome === "sync-failure") throw new Error("injected observation sync failure");
    await sync.call(this); durable = true; events.push("sync-complete");
  });
  const commit = h.host.settleOutboxTurn.bind(h.host);
  h.host.settleOutboxTurn = async input => {
    assert.equal(durable, true, "Host authority requires completed fsync, not a live observation or an appended marker");
    assert.ok((await readFile(p.file, "utf8")).includes(MAIN_RUN_COMPLETED_CUSTOM_TYPE));
    commits++; events.push("host-turn-commit"); return commit(input);
  };
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...p.card }]);
  const earlier = Promise.allSettled([h.settle()]);
  const recording = Promise.allSettled([h.tracker.recordRunEnded({ failed: false, ctx: p.ctx, state: h.host.snapshot(), pi: {
    appendEntry<T>(type: string, data: T) {
      events.push("append-observation");
      if (outcome === "append-failure") throw new Error("injected observation append failure");
      p.pi.appendEntry(type, data);
    },
  } })]);
  if (outcome === "append-failure") await recording; else await syncing;
  // This replay sees an appended, not-yet-synced marker. Even the synchronous
  // wake guard must not publish it into the Host's business authority set.
  const replay = Promise.allSettled([h.tracker.settle({ host: h.host, mainSessionId: "main", at, branch: p.session.getBranch() })]);
  try {
    assert.deepEqual(await earlier, [{ status: "fulfilled", value: [] }]);
    assert.equal(h.tracker.hasCardOpportunity({ state: h.host.snapshot(), mainSessionId: "main", branch: p.session.getBranch(), completionIds: h.outbox().completion_ids }), true);
    assert.deepEqual(h.tracker.handledInboxIds(), []);
    assert.equal(commits, 0); assert.equal(h.outbox().turn_settlement!.state, "pending");
  } finally { release(); }
  const [recorded] = await recording, [settled] = await replay;
  if (outcome === "durable") {
    assert.equal(recorded!.status, "fulfilled");
    assert.deepEqual(settled, { status: "fulfilled", value: [h.outboxId] });
    assert.deepEqual(events, ["append-observation", "sync-enter", "sync-complete", "host-turn-commit"]);
    assert.equal(commits, 1); assert.equal(h.outbox().turn_settlement!.state, "settled");
  } else {
    assert.equal(recorded!.status, "rejected"); assert.deepEqual(settled, { status: "fulfilled", value: [] });
    assert.equal(commits, 0); assert.equal(h.outbox().turn_settlement!.state, "pending");
    assert.deepEqual(h.tracker.handledInboxIds(), []);
  }
  validateNormalizedStoreStateV1(h.host.snapshot());
  t.diagnostic(JSON.stringify({ outcome, events, commits, sourceTurn: h.outbox().turn_settlement!.state }));
});

function twoObligations() {
  const state = running(), original = state.agents[0]!, nextAgent = encodeDomainId("agt", Buffer.alloc(16, 121)), nextTask = encodeDomainId("tsk", Buffer.alloc(16, 122));
  const another = structuredClone(original);
  return harness({ ...state, root: { ...state.root, agent_ids: [agent, nextAgent], next_admission_order: 3 }, agents: [original, {
    ...another, agent: { ...another.agent, agent_id: nextAgent, task_name: "another", task_path: "/root/another", current_task_id: nextTask,
      profile: { ...another.agent.profile, system_prompt_relative_path: `conversations/${nextAgent}/system-prompt.txt` },
      conversation: { ...another.agent.conversation, session_id: "another-child", relative_path: `conversations/${nextAgent}/session.jsonl` } },
    tasks: another.tasks.map(item => ({ ...item, task_id: nextTask, agent_id: nextAgent, admission_order: 2, lease_intent: { ...item.lease_intent!, logical_key: nextTask } })),
  }] });
}

test("an unexpected settle throw rejects only its caller; the same owner records the next run and retries the pending item", async t => {
  const h = twoObligations(), [first, second] = h.obligations;
  await h.deliver(first!.outboxId); await h.deliver(second!.outboxId);
  const a = await persistentCard(t, h, first!.inboxId);
  a.session.appendMessage(fauxAssistantMessage("handled the first card"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...a.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: a.pi, ctx: a.ctx, state: h.host.snapshot() });
  const commit = h.host.settleOutboxTurn.bind(h.host), expected = new Error("one unexpected Host throw"), calls: string[] = [];
  h.host.settleOutboxTurn = async input => {
    calls.push(input.outboxId);
    if (calls.length === 1) throw expected;
    return commit(input);
  };
  await assert.rejects(h.settle(), (error: unknown) => error === expected);
  assert.equal(h.outbox(first!.outboxId).turn_settlement!.state, "pending");
  const b = await persistentCard(t, h, second!.inboxId, a);
  b.session.appendMessage(fauxAssistantMessage("handled the next independent card"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...b.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: b.pi, ctx: b.ctx, state: h.host.snapshot() });
  assert.equal(h.outbox(first!.outboxId).turn_settlement!.state, "pending", "recording another run does not silently commit the failed item");
  assert.deepEqual(await h.settle(), [first!.outboxId, second!.outboxId], "the next ordinary boundary retries the original item and commits the next run");
  assert.deepEqual(calls, [first!.outboxId, first!.outboxId, second!.outboxId]);
  assert.equal(h.outbox(first!.outboxId).turn_settlement!.state, "settled");
  assert.equal(h.outbox(second!.outboxId).turn_settlement!.state, "settled");
  validateNormalizedStoreStateV1(h.host.snapshot());
  t.diagnostic(JSON.stringify({ scenario: "settle-throw", sameOwner: true, callerRejected: true, pendingBeforeRetry: true, laterRunRecorded: true, originalRetried: true, commits: 2 }));
});

for (const fault of ["append", "append-after-write", "sync"] as const) test(`a ${fault} observation failure leaves only that run unproven while the same owner continues`, async t => {
  const h = twoObligations(), [first, second] = h.obligations;
  await h.deliver(first!.outboxId); await h.deliver(second!.outboxId);
  const a = await persistentCard(t, h, first!.inboxId);
  const failedAssistant = a.session.appendMessage(fauxAssistantMessage("first successful run, failed persistence"));
  const expected = new Error(`one observation ${fault} failure`), commits: string[] = [];
  const commit = h.host.settleOutboxTurn.bind(h.host);
  h.host.settleOutboxTurn = async input => { commits.push(input.outboxId); return commit(input); };
  if (fault === "sync") {
    const handle = await open(a.file, "r"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync as FileHandle["sync"];
    await handle.close(); let fail = true;
    t.mock.method(prototype, "sync", async function(this: FileHandle) { if (fail) { fail = false; throw expected; } await sync.call(this); });
  }
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...a.card }]);
  await assert.rejects(h.tracker.recordRunEnded({ failed: false, ctx: a.ctx, state: h.host.snapshot(), pi: {
    appendEntry<T>(type: string, data: T) {
      if (fault === "append") throw expected;
      a.pi.appendEntry(type, data);
      if (fault === "append-after-write") throw expected;
    },
  } }), (error: unknown) => error === expected);
  const branch = () => a.session.getBranch();
  const failedMarkerVisible = branch().some(entry => entry.type === "custom" && entry.customType === MAIN_RUN_COMPLETED_CUSTOM_TYPE
    && (entry.data as { assistantEntryId?: string })?.assistantEntryId === failedAssistant);
  assert.equal(failedMarkerVisible, fault !== "append");
  assert.deepEqual(await h.tracker.settle({ host: h.host, mainSessionId: "main", at, branch: branch() }), []);
  assert.deepEqual(h.tracker.handledInboxIds(), []); assert.deepEqual(commits, []);
  const b = await persistentCard(t, h, second!.inboxId, a);
  b.session.appendMessage(fauxAssistantMessage("unrelated later run"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...b.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: b.pi, ctx: b.ctx, state: h.host.snapshot() });
  assert.deepEqual(h.tracker.handledInboxIds(), [second!.inboxId]);
  assert.deepEqual(await h.tracker.settle({ host: h.host, mainSessionId: "main", at, branch: branch() }), [second!.outboxId]);
  assert.equal(h.outbox(first!.outboxId).turn_settlement!.state, "pending", "even syncing a later run must not launder the failed run's visible marker");
  assert.equal(h.outbox(second!.outboxId).turn_settlement!.state, "settled");
  a.session.appendMessage({ role: "user", content: "handle the original pending result", timestamp: Date.now() });
  a.session.appendMessage(fauxAssistantMessage("handled the first card again"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...a.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: a.pi, ctx: a.ctx, state: h.host.snapshot() });
  assert.deepEqual(await h.tracker.settle({ host: h.host, mainSessionId: "main", at, branch: branch() }), [first!.outboxId]);
  assert.deepEqual(commits, [second!.outboxId, first!.outboxId]);
  assert.equal(h.outbox(first!.outboxId).turn_settlement!.state, "settled");
  validateNormalizedStoreStateV1(h.host.snapshot());
  t.diagnostic(JSON.stringify({ scenario: "observation-failure", fault, sameOwner: true, failedMarkerVisible, falseCommits: 0, independentRunCommitted: true, originalHandledLater: true }));
});

test("opportunity joins independent card receipts by exact native identity and never grants malformed/conflicting evidence", async t => {
  const h = twoObligations(), [first, second] = h.obligations;
  await h.deliverCards(first!.outboxId); await h.deliverCards(second!.outboxId);
  const a = await persistentCard(t, h, first!.inboxId);
  const assistantA = a.session.appendMessage(fauxAssistantMessage("first request", { stopReason: "toolUse" }));
  const receipt = (card: typeof a.card, entryId: string, assistant: string, key: string, terminalId: string) => ({ version: 1, sessionId: "main", terminals: [{
    mail: { producer: "pi-subagents", key, anchorEntryId: null, policy: "next-request", wake: false, messages: [card] }, branchEntryId: entryId,
    evidence: { producer: "pi-subagents", key, terminalId, outcome: "fulfilled", scope: { sessionId: "main", anchorEntryId: null }, assistantEntryId: assistant, nativeEntryIds: [entryId] },
  }] });
  const rA = receipt(a.card, a.entryId, assistantA, `card:${first!.inboxId}`, "terminal-a");
  a.session.appendCustomEntry("agent-mailbox-delivery-v1", rA);
  const b = await persistentCard(t, h, second!.inboxId, a), assistantB = b.session.appendMessage(fauxAssistantMessage("second request"));
  const rB = receipt(b.card, b.entryId, assistantB, `card:${second!.inboxId}`, "terminal-b");
  b.session.appendCustomEntry("agent-mailbox-delivery-v1", rB);
  const owner = new MainTurnSettlementV1(), input = () => ({ state: h.host.snapshot(), mainSessionId: "main", branch: b.session.getBranch() });
  const completions = [first!, second!].map(item => h.outbox(item.outboxId).completion_ids[0]!);
  assert.equal(owner.hasCardOpportunity({ ...input(), completionIds: completions }), true);
  assert.equal(owner.handlingProof({ ...input(), outbox: h.outbox(first!.outboxId) }), undefined, "transport receipts are not successful-run markers");
  const onlyOther = b.session.getBranch().filter(entry => entry.type !== "custom" || entry.customType !== "agent-mailbox-delivery-v1" || (entry.data as any).terminals[0].mail.key === rB.terminals[0]!.mail.key);
  assert.equal(owner.hasCardOpportunity({ ...input(), branch: onlyOther, completionIds: [completions[0]!] }), false, "a legal unrelated receipt is skipped");
  for (const mutate of [
    (data: any) => { data.terminals[0].mail.messages = []; },
    (data: any) => { delete data.terminals[0].mail.policy; },
    (data: any) => { data.terminals[0].evidence.nativeEntryIds = [a.entryId, a.entryId]; data.terminals[0].mail.messages = [a.card, a.card]; },
    (data: any) => { data.terminals[0].mail.messages[0].content = "wrong native bytes"; },
    (data: any) => { data.terminals[0].evidence.scope.sessionId = "another-main"; },
  ]) {
    const bad = structuredClone(rA); mutate(bad);
    const branch = [...onlyOther, { type: "custom", id: "malformed", parentId: onlyOther.at(-1)!.id, timestamp: at, customType: "agent-mailbox-delivery-v1", data: bad }] as any;
    assert.equal(owner.hasCardOpportunity({ ...input(), branch, completionIds: [completions[0]!] }), false);
  }
  const conflict = structuredClone(rA); conflict.terminals[0]!.evidence.terminalId = "another-terminal";
  b.session.appendCustomEntry("agent-mailbox-delivery-v1", conflict);
  assert.equal(owner.hasCardOpportunity({ ...input(), completionIds: [completions[0]!] }), false, "conflicting terminal identities cannot authorize a card");
});

test("only persistent success for every barrier card permits handled, across independent successful runs", async t => {
  const h = twoObligations(), [first, second] = h.obligations;
  await h.deliverCards(first!.outboxId); await h.deliverCards(second!.outboxId);
  h.mutate(state => {
    const boxes = state.agents.flatMap(partition => partition.outbox);
    state.root.outbox = [{ ...boxes[0]!, source: { kind: "main", session_id: "main" }, kind: "barrier-wake", completion_ids: boxes.flatMap(item => item.completion_ids) }];
    for (const partition of state.agents) partition.outbox = [];
  });
  const current = () => h.host.snapshot().root.outbox[0]!, a = await persistentCard(t, h, first!.inboxId);
  a.session.appendMessage(fauxAssistantMessage("handled first"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...a.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: a.pi, ctx: a.ctx, state: h.host.snapshot() });
  const b = await persistentCard(t, h, second!.inboxId, a);
  b.session.appendMessage(fauxAssistantMessage("will continue", { stopReason: "toolUse" }));
  b.session.appendMessage(fauxAssistantMessage("aborted", { stopReason: "aborted" }));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...b.card }]);
  await h.tracker.recordRunEnded({ failed: true, pi: b.pi, ctx: b.ctx, state: h.host.snapshot() });
  const settle = () => h.tracker.settleHandled({ host: h.host, mainSessionId: "main", outboxId: current().outbox_id, branch: () => b.session.getBranch(), at });
  assert.equal(await settle(), false, "partial success and toolUse/abort cannot end the barrier");
  b.session.appendMessage(fauxAssistantMessage("handled second"));
  h.tracker.runStarted(); h.tracker.observeContext([{ role: "custom", ...b.card }]);
  await h.tracker.recordRunEnded({ failed: false, pi: b.pi, ctx: b.ctx, state: h.host.snapshot() });
  assert.equal(await settle(), true); assert.equal(current().state, "handled"); assert.equal(current().wake_epoch, 0);
  assert.equal(new Set(current().handling_proof!.cards.map(card => card.run_entry_id)).size, 2, "one assistant is not required for the whole barrier");
  assert.equal(current().settlement_proof_id, undefined); assert.equal(current().turn_settlement, undefined);
  assert.deepEqual(decodeOutboxRecordV1(current()), current()); validateNormalizedStoreStateV1(h.host.snapshot());
  const revision = h.host.host_revision; assert.equal(await settle(), true); assert.equal(h.host.host_revision, revision);
  assert.equal(planRecoveryV1(h.host.snapshot(), { now: () => new Date(at), mailboxImport: true }), undefined, "handled is not reset when native recovery is unavailable");
  h.mutate(state => { for (const inbox of state.root.inbox) { inbox.ui_read_at = at; inbox.ui_read_revision = state.root.host_revision; } });
  assert.equal(pruneForCheckpointV1(h.host.snapshot(), { preparedTransactionIds: new Set() }).state.root.inbox.length, 2, "the original cards remain available until handled cleanup and subtree deletion");
});
