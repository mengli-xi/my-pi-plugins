import { wakePeer } from "../fixtures/wake-peer.ts";
import { nativeMailboxDouble } from "../fixtures/mailbox.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getContinuationRegistryV1 } from "pi-runtime-contracts/continuation-v1";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { AgentHostCoreV1 } from "../../src/host/core.ts";
import { DeliveryEngineV1, reconcileMainDeliveryV1, type DeliveryAppendPortV1 } from "../../src/host/delivery-engine.ts";
import { MainSessionAppendPortV1 } from "../../src/host/main-append-port.ts";
import { getOrCreateProducerProofRegistryV1 } from "../../src/host/producer-proof.ts";
import { rootHeaderV1 } from "../../src/persistence/codecs.ts";
import { collectInboxTranscriptProofsV1 } from "../../src/persistence/inbox-proofs.ts";
import { PRIVATE_DIR_MODE } from "../../src/persistence/layout.ts";
import { openMainStoreV1, type MainStoreV1 } from "../../src/persistence/store.ts";
import type { ConversationRefV1, NormalizedStoreStateV1, OutboxRecordV1 } from "../../src/persistence/types.ts";

const AT = "2027-03-01T00:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const AGENT = encodeDomainId("agt", Buffer.alloc(16, 41));
const TASK = encodeDomainId("tsk", Buffer.alloc(16, 42));

interface TranscriptEntry {
  readonly id: string;
  readonly parentId?: string | null;
  readonly type: "custom_message" | "custom" | "message";
  readonly customType?: string;
  readonly content?: string;
  readonly display?: boolean;
  readonly details?: unknown;
  readonly data?: unknown;
  readonly message?: unknown;
}

class FakeMainTranscript {
  readonly entries: TranscriptEntry[] = [];
  readonly #sessionId: string;
  #counter = 0;
  constructor(sessionId: string) { this.#sessionId = sessionId; }
  getSessionId(): string { return this.#sessionId; }
  getHeader() { return { type: "session" as const, version: 3, id: this.#sessionId, cwd: "/tmp", timestamp: AT }; }
  getSessionFile(): string { return join("/tmp", encodeURIComponent(this.#sessionId) + ".jsonl"); }
  getLeafId(): string | null { return this.entries.at(-1)?.id ?? null; }
  getBranch(): TranscriptEntry[] { return this.entries; }
  getEntries(): TranscriptEntry[] { return this.entries; }
  getEntry(id: string): TranscriptEntry | undefined { return this.entries.find((entry) => entry.id === id); }
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details: unknown): string {
    const id = `entry-${++this.#counter}`;
    this.entries.push({ id, parentId: this.getLeafId(), type: "custom_message", customType, content, display, details });
    return id;
  }
  /** 真实的未 resolve tool batch：main-append-port 的安全追加边界靠它拒绝追加。 */
  openToolCall(callId: string): void { this.entries.push({ id: `call-${callId}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId }], stopReason: "toolUse" } }); }
  closeToolCall(callId: string): void { this.entries.push({ id: `result-${callId}`, type: "message", message: { role: "toolResult", toolCallId: callId } }); }
  cards(customType: string): TranscriptEntry[] { return this.entries.filter((entry) => entry.type === "custom_message" && entry.customType === customType); }
}

function profile(agentId: string) {
  return {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin", body: "role", sha256: sha("role") }, provider: "openai-codex", model: "gpt-5.4", model_scope: ["openai-codex/gpt-5.4"], reasoning_effort: "high" as const, task_timeout_ms: 60_000, cwd: "/tmp", project_trusted: true, system_prompt_options_sha256: sha("o"), prompt_assembler_version: 1 as const, system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: sha("p"), capabilities: { version: 1 as const, fingerprint: sha("c"), active_tools: [], tool_definitions: [], entries: [] }, created_at: AT };
}

function put(transactionId: string, entityType: string, entityId: string, value: unknown) {
  return { version: 1 as const, type: "put" as const, transaction_id: transactionId, entity_type: entityType as never, entity_id: entityId, value };
}

async function seedRunningTask(store: MainStoreV1, sessionId: string): Promise<void> {
  const snapshot = store.snapshot();
  const revision = snapshot.root.host_revision + 1;
  const transactionId = encodeDomainId("txn", Buffer.alloc(16, 43));
  const agent = {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: revision, agent_id: AGENT, parent_conversation: { kind: "main", session_id: sessionId }, task_name: "worker", task_path: "/root/worker", depth: 1, created_at: AT, created_revision: revision, profile: profile(AGENT), conversation: { session_id: "child-session", relative_path: `conversations/${AGENT}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", current_task_id: TASK, queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 };
  const task = {initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: sessionId}}, owner_conversation: {kind: "main" as const, session_id: sessionId},  version: 1, record_revision: revision, task_id: TASK, agent_id: AGENT, origin: "initial", admission_order: 1, message: "work", phase: "running", admitted_at: AT, started_at: AT, deadline_at_ms: Date.parse(AT) + 60_000, runtime_generation: 1, lease_intent: { api_version: 1, session_id: sessionId, owner_id: "pi-subagents", logical_key: TASK, reason: "subagent work" }, lease_disposition: "required" };
  await store.commit({ transactionId, operation: "seed-running-task", mutations: [put(transactionId, "root", "root", { ...rootHeaderV1(snapshot.root), host_revision: revision, agent_ids: [AGENT], next_admission_order: 2 }), put(transactionId, "agent", AGENT, agent), put(transactionId, "task", TASK, task)] });
}

interface Scenario {
  failNextContinuation(): void;
  readonly store: MainStoreV1;
  readonly host: AgentHostCoreV1;
  readonly engine: DeliveryEngineV1;
  readonly liveSends: { readonly customType: string; readonly triggerTurn: boolean }[];
  reconcile(sessionId?: string): Promise<void>;
  /** 进程死亡会丢掉 registry 里所有易失 lease handle；同进程重开必须先模拟这一点。 */
  abandonLeases(): void;
  outbox(): OutboxRecordV1;
  receipts(): NormalizedStoreStateV1["root"]["wake_receipts"];
  /** producer 自己发出的模型通知 turn 数（triggerTurn 的 subagent-continuation-v1）。 */
  notifyTurns(): number;
  close(): Promise<void>;
}

async function openScenario(input: { readonly agentDirectory: string; readonly sessionId: string; readonly transcript: FakeMainTranscript; readonly seed: boolean }): Promise<Scenario> {
  const registry = getContinuationRegistryV1();
  const held: { releaseWithoutWake: (input: { outcome: "cancelled"; reason: string }) => unknown }[] = [];
  const liveSends: { customType: string; triggerTurn: boolean }[] = [];
  const transcript = input.transcript;
  const store = await openMainStoreV1({ agentDirectory: input.agentDirectory, mainSessionId: input.sessionId, now: () => new Date(AT), limits: { maxStoreBytesPerMain: 536_870_912, maxStoreBytesPerProcess: 2_147_483_648, maxMetadataBytesPerMain: 33_554_432 }, liveRuntimeGenerations: new Map(), inboxProofProvider: (state: NormalizedStoreStateV1) => collectInboxTranscriptProofsV1({ state, mainRoot: join(input.agentDirectory, "pi-subagents"), mainSessionManager: transcript as never }) });
  if (input.seed) await seedRunningTask(store, input.sessionId);
  const host = new AgentHostCoreV1({
    mainSessionId: input.sessionId,
    instanceGeneration: 1,
    config: { maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 },
    store,
    leases: {
      acquire: async ({ sessionId: leaseSession, taskId, reason }) => {
        const acquired = registry.acquireBlocking({ sessionId: leaseSession, ownerId: "pi-subagents", logicalKey: taskId, reason });
        if (!acquired.ok) throw new Error(acquired.message);
        held.push(acquired.value);
        return { leaseId: acquired.value.snapshot().leaseId, generation: acquired.value.snapshot().generation, releaseWithoutWake: async (release) => { const result = acquired.value.releaseWithoutWake(release); if (!result.ok) throw new Error(result.message); }, releaseAndOfferWake: (release) => { const result = acquired.value.releaseAndOfferWake(release); if (!result.ok) throw new Error(result.message); return result.value as never; } };
      },
    },
    runtime: { residency: () => undefined, async interrupt() {} },
    scheduler: { taskAdmitted() {} },
    now: () => new Date(AT),
  });
  await host.recoverRootTaskLeases();
  const mailbox = nativeMailboxDouble(transcript as never, (message, options) => { liveSends.push({ customType: message.customType, triggerTurn: options.triggerTurn }); });
  let failContinuation = false;
  const put = mailbox.put.bind(mailbox);
  mailbox.put = input => { if (failContinuation && input.key.endsWith(":continuation")) { failContinuation = false; return Promise.reject(new Error("mailbox acceptance failed")); } return put(input); };
  const appendPort = new MainSessionAppendPortV1(transcript as never, mailbox);
  const engine = new DeliveryEngineV1({
    host,
    resolveAppendPort: (recipient: ConversationRefV1) => (recipient.kind === "main" && recipient.session_id === input.sessionId ? appendPort : undefined),
    offerWake: (offer) => { const created = registry.offerWake({ sessionId: offer.sessionId, ownerId: "pi-subagents", logicalKey: offer.logicalKey, reason: offer.reason, outcome: offer.outcome }); if (!created.ok) throw new Error(created.message); return created.value as never; },
    producerProofRegistry: getOrCreateProducerProofRegistryV1(),
    ownerToken: `main:${input.sessionId}`,
    ownerGeneration: 1,
    now: () => new Date(AT),
  });
  const outboxes = () => { const state = host.snapshot(); return [state.root, ...state.agents].flatMap((item) => item.outbox); };
  return {
    store,
    host,
    engine,
    failNextContinuation() { failContinuation = true; },
    liveSends,
    async reconcile(sessionId = input.sessionId) { await reconcileMainDeliveryV1({ host, delivery: engine, mainSessionId: sessionId }); },
    outbox() { const first = outboxes()[0]; if (!first) throw new Error("no Outbox exists"); return first; },
    receipts() { const state = host.snapshot(); return [state.root, ...state.agents].flatMap((item) => item.wake_receipts); },
    abandonLeases() { for (const lease of held.splice(0)) lease.releaseWithoutWake({ outcome: "cancelled", reason: "simulated process death" }); },
    notifyTurns() { return liveSends.filter((send) => send.customType === "subagent-continuation-v1" && send.triggerTurn).length; },
    async close() { await store.close(); },
  };
}

/** 让 DeliveryEngine 在真实 openOutboxWake 之后、wake.commit 之前跑一次注入动作。 */
function withOpenWakeGap(host: AgentHostCoreV1, gap: () => Promise<void>): AgentHostCoreV1 {
  return new Proxy(host, {
    get(target, property, receiver) {
      if (property === "openOutboxWake") return async (value: Parameters<AgentHostCoreV1["openOutboxWake"]>[0]) => { const result = await target.openOutboxWake(value); await gap(); return result; };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 抓住 DeliveryEngine 实际用掉的 offer 身份，用来检查 proof reservation 与 offer 有没有泄漏。 */
function withCapturedOffer(host: AgentHostCoreV1, sink: { offer?: { sessionId: string; offerId: string; offerGeneration: number } }): AgentHostCoreV1 {
  return new Proxy(host, {
    get(target, property, receiver) {
      if (property === "openOutboxWake") return async (value: Parameters<AgentHostCoreV1["openOutboxWake"]>[0]) => { sink.offer = value.offer; return target.openOutboxWake(value); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 一次性事务故障注入：第一次调用指定的 host transaction 返回一个真实形状的失败结果，之后原样放行。
 * core 内部本来就把异常收敛成 `ok:false`，所以注入失败结果而不是抛异常，走的才是生产同一条分支。
 */
function withOneShotTransactionFailure(host: AgentHostCoreV1, method: "openOutboxWake" | "terminalizeOutbox", message: string): AgentHostCoreV1 {
  let injected = false;
  return new Proxy(host, {
    get(target, property, receiver) {
      if (property === method) return async (value: unknown) => {
        if (!injected) { injected = true; return { ok: false as const, host_revision: target.host_revision, error: { version: 1 as const, code: "delivery-failed" as const, message, retryable: true, current_host_revision: target.host_revision } }; }
        return (target[method] as (input: never) => Promise<unknown>)(value as never);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, PRIVATE_DIR_MODE);
  await mkdir(join(root, "pi-subagents", "store-v2", "mains"), { recursive: true, mode: PRIVATE_DIR_MODE });
  return root;
}

async function settleAndAppendCards(scenario: Scenario): Promise<string> {
  const settled = await scenario.host.settleTask({ agentId: AGENT as never, taskId: TASK as never, runtimeGeneration: 1, completedAt: AT, outcome: "completed", reason: "normal-final", finalText: "background result", summary: "background result" });
  assert.equal(settled.ok, true);
  if (!settled.ok) throw new Error("settleTask failed");
  const outboxId = settled.value.outbox_id!;
  assert.equal((await scenario.engine.deliverOutbox(outboxId)).state, "cards-appended");
  return outboxId;
}

interface Fixture {
  readonly root: string;
  readonly sessionId: string;
  readonly transcript: FakeMainTranscript;
  readonly peer?: ReturnType<typeof wakePeer>;
  readonly scenario: Scenario;
  readonly outboxId: string;
  
}

async function backgroundResult(t: TestContext, input: { readonly prefix: string; readonly noConsumer?: boolean; readonly withdrawBeforeCommit?: boolean; readonly settle?: boolean }): Promise<Fixture> {
  const root = await fixtureRoot(input.prefix);
  const sessionId = `${input.prefix}${crypto.randomUUID()}`;
    const transcript = new FakeMainTranscript(sessionId);
  const peer = input.noConsumer ? undefined : wakePeer(sessionId);
  const scenario = await openScenario({ agentDirectory: root, sessionId, transcript, seed: true });
  t.after(async () => { await scenario.close().catch(() => undefined); peer?.dispose(); await rm(root, { recursive: true, force: true }); });
  const outboxId = await settleAndAppendCards(scenario);
  if (input.settle !== false) {
    const engine = input.withdrawBeforeCommit ? new DeliveryEngineV1({ ...scenario.engine.options, host: withOpenWakeGap(scenario.host, async () => { peer?.dispose(); }) }) : scenario.engine;
    const settled = await engine.settleWake(outboxId);
    assert.deepEqual(settled, { state: "delivered", kind: input.noConsumer || input.withdrawBeforeCommit ? "producer-fallback" : "goal-claimed" });
  }
  return { root, sessionId, transcript, peer, scenario, outboxId };
}

test("a background result that lands on an unclaimed consumer still wakes Main exactly once", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "paused-fresh-", noConsumer: true });

  const outbox = scenario.outbox();
  assert.equal(outbox.state, "delivered");
  assert.equal(outbox.wake_state, "settled");
  assert.equal(outbox.settlement_kind, "producer-fallback");
  const receipts = scenario.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.kind, "producer-fallback");
  assert.equal(receipts[0]!.runtime_delivery, "delivered");
  assert.equal(receipts[0]!.claimant_owner_id, undefined, "a paused Goal never gets a fabricated claimant receipt");
  assert.equal(scenario.notifyTurns(), 1, "exactly one producer notification turn");
  assert.equal(transcript.cards("subagent-completion-v1").length, 1);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  assert.deepEqual(scenario.liveSends, [{ customType: "subagent-completion-v1", triggerTurn: false }, { customType: "subagent-continuation-v1", triggerTurn: true }]);
});

test("a consumer withdrawal inside the claimed Wake gap still wakes Main through the producer fallback", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "paused-gap-", withdrawBeforeCommit: true });

  const outbox = scenario.outbox();
  assert.equal(outbox.state, "delivered");
  assert.equal(outbox.wake_state, "settled");
  assert.equal(outbox.settlement_kind, "producer-fallback");
  assert.equal(outbox.wake_epoch, 1, "the claimed epoch itself carries the producer continuation");
  const receipts = scenario.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.kind, "producer-fallback");
  assert.equal(receipts[0]!.claimant_owner_id, undefined, "a declined claim never becomes a goal-claimed receipt");
  assert.equal(receipts[0]!.claimant_generation, undefined);
  assert.equal(receipts[0]!.runtime_delivery, "delivered");
  assert.equal(scenario.notifyTurns(), 1, "exactly one producer notification turn");
  assert.equal(transcript.cards("subagent-completion-v1").length, 1, "the durable completion card stays exactly once");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  const tasks = scenario.host.snapshot().agents[0]!.tasks;
  assert.equal(tasks.length, 1, "the original Task is never re-run");
  assert.equal(tasks[0]!.phase, "settled");

  // 终态化之后的边界不再 offer，也不再补第二条通知。
  await scenario.reconcile();
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.notifyTurns(), 1);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);

  assert.equal(scenario.notifyTurns(), 1, "resume never replays the producer notification");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
});

/** ③ 安全追加边界拒绝之后进程死亡：重开用 detached offer 补完投递，card 不重发。 */
test("an append boundary failure leaves no permanent open Wake and reconcile finishes it from a detached offer", async (t) => {
  const root = await fixtureRoot("open-wake-recovery-");
  const sessionId = `open-wake-${crypto.randomUUID()}`;
    const transcript = new FakeMainTranscript(sessionId);
  
  const scenario = await openScenario({ agentDirectory: root, sessionId, transcript, seed: true });
  const outboxId = await settleAndAppendCards(scenario);

  // card 已经在安全边界上追加。随后 Main 开了一个未 resolve 的 tool batch：continuation 不得插进去。
  scenario.failNextContinuation();
  const sink: { offer?: { sessionId: string; offerId: string; offerGeneration: number } } = {};
  const captured = new DeliveryEngineV1({ ...scenario.engine.options, host: withCapturedOffer(scenario.host, sink) });
  await assert.rejects(captured.settleWake(outboxId), /mailbox acceptance failed/u);
  const declined = sink.offer!;
  // append 抛出之后 reservation 必须已经释放：换一个 owner_token 还能 reserve 才证明表里没留下占位。
  const reReserved = getOrCreateProducerProofRegistryV1().reserve({ key: { session_id: declined.sessionId, offer_id: declined.offerId, offer_generation: declined.offerGeneration }, owner_token: "leak-probe", owner_generation: 1 });
  assert.equal(reReserved.ok, true, "a failed producer append must release its proof reservation");
  if (reReserved.ok) reReserved.handle.clear();
  assert.equal(getContinuationRegistryV1().snapshot(sessionId).openOffers, 0, "a failed producer append must abort its runtime offer");
  assert.equal(scenario.outbox().state, "cards-appended");
  assert.equal(scenario.outbox().wake_state, "open", "the epoch is durably open while the offer is already gone");
  assert.equal(scenario.outbox().wake_epoch, 1);
  assert.equal(scenario.notifyTurns(), 0);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 0);
  // 这一笔 open transaction 已经把 Task lease 提交成 released：重试只能走 detached offer。
  assert.equal(scenario.host.snapshot().agents[0]!.tasks[0]!.lease_disposition, "released");
  assert.throws(() => scenario.host.releaseRootTaskLease({ taskId: TASK, outcome: "ready", reason: "retry" }), /Task lease Wake authority is unavailable/u);
  await scenario.close();

  const reopened = await openScenario({ agentDirectory: root, sessionId, transcript, seed: false });
  t.after(async () => { await reopened.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  assert.equal(reopened.outbox().wake_state, "not-offered", "recovery resets volatile open authority");
  assert.equal(reopened.outbox().wake_epoch, 1);

  await reopened.reconcile();

  assert.equal(reopened.outbox().state, "delivered");
  assert.equal(reopened.outbox().settlement_kind, "producer-fallback");
  assert.equal(reopened.outbox().wake_epoch, 1, "mailbox retry preserves the original epoch");
  assert.equal(transcript.cards("subagent-completion-v1").length, 1, "recovery never re-appends the completion card");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  assert.equal(reopened.notifyTurns(), 1);
});

/** ④ 退出重开原 session：已 delivered 不再 offer。 */
test("reopening the same session keeps a delivered Wake terminal and consumes nothing again", async (t) => {
  const fixture = await backgroundResult(t, { prefix: "reopen-delivered-", withdrawBeforeCommit: true });
  await fixture.scenario.close();
  fixture.peer?.dispose();

  const reloadedPeer = fixture.peer ? wakePeer(fixture.sessionId) : undefined;
  const reloaded = await openScenario({ agentDirectory: fixture.root, sessionId: fixture.sessionId, transcript: fixture.transcript, seed: false });
  t.after(async () => { await reloaded.close().catch(() => undefined); reloadedPeer?.dispose(); });

  assert.equal(reloaded.outbox().state, "delivered");
  assert.equal(reloaded.outbox().settlement_kind, "producer-fallback");
  assert.equal(reloaded.receipts().length, 1);

  await reloaded.reconcile();

  assert.equal(reloaded.outbox().state, "delivered");
  assert.equal(reloaded.outbox().wake_epoch, 1, "a delivered Outbox is never re-offered");
  assert.equal(reloaded.notifyTurns(), 0, "the reopened process appends no second continuation");
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1);
  assert.equal(fixture.transcript.cards("subagent-continuation-v1").length, 1);
});

/** ④ 退出重开原 session：停在 not-offered 的结果重开后恰好投递一次。 */
test("reopening the same session delivers a still unoffered Wake exactly once", async (t) => {
  const fixture = await backgroundResult(t, { prefix: "reopen-pending-", noConsumer: true, settle: false });
  assert.equal(fixture.scenario.outbox().state, "cards-appended");
  assert.equal(fixture.scenario.outbox().wake_state, "not-offered");
  await fixture.scenario.close();
  fixture.scenario.abandonLeases();
  fixture.peer?.dispose();

  const reloadedPeer = fixture.peer ? wakePeer(fixture.sessionId) : undefined;
  const reloaded = await openScenario({ agentDirectory: fixture.root, sessionId: fixture.sessionId, transcript: fixture.transcript, seed: false });
  t.after(async () => { await reloaded.close().catch(() => undefined); reloadedPeer?.dispose(); });

  await reloaded.reconcile();
  await reloaded.reconcile();

  assert.equal(reloaded.outbox().state, "delivered");
  assert.equal(reloaded.outbox().settlement_kind, "producer-fallback");
  assert.equal(reloaded.receipts().length, 1);
  assert.equal(reloaded.notifyTurns(), 1, "two boundaries still produce one notification turn");
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1);
  assert.equal(fixture.transcript.cards("subagent-continuation-v1").length, 1);
});

/** ⑤ session replacement：旧 scope 的结果留给旧 owner，新 scope 一无所获。 */
test("a replacement session neither claims nor receives the old scope's pending Wake", async (t) => {
  const fixture = await backgroundResult(t, { prefix: "replacement-", noConsumer: true, settle: false });
  fixture.peer?.dispose();

  const replacementTranscript = new FakeMainTranscript(`replacement-${crypto.randomUUID()}`);
  const replacementPeer = wakePeer(replacementTranscript.getSessionId());
  t.after(() => replacementPeer.dispose());

  // 新 session 的 reconcile 只认自己的 recipient.session_id：旧 scope 的 Outbox 原样留着。
  await fixture.scenario.reconcile(replacementTranscript.getSessionId());

  assert.equal(fixture.scenario.outbox().state, "cards-appended");
  assert.equal(fixture.scenario.outbox().wake_state, "not-offered", "the old scope keeps its Outbox for its own owner");
  assert.equal(fixture.scenario.notifyTurns(), 0);
  assert.equal(replacementTranscript.cards("subagent-completion-v1").length, 0, "the old result never reaches the new scope");
  assert.equal(replacementTranscript.cards("subagent-continuation-v1").length, 0);

  const stray = getContinuationRegistryV1().offerWake({ sessionId: fixture.sessionId, ownerId: "pi-subagents", logicalKey: TASK, reason: "old scope terminal", outcome: "ready" });
  assert.equal(stray.ok, true);
  if (!stray.ok) return;
  assert.equal(stray.value.hasClaim(), false);
  assert.equal(stray.value.abort("old append authority is gone").ok, true);
});

test("a claimed protocol receipt terminalizes the Wake from its own receipt without a producer continuation", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "active-claim-" });

  const outbox = scenario.outbox();
  assert.equal(outbox.state, "delivered");
  assert.equal(outbox.settlement_kind, "goal-claimed");
  const receipts = scenario.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.kind, "goal-claimed");
  assert.equal(receipts[0]!.claimant_owner_id, "pi-goal-local");
  assert.equal(receipts[0]!.runtime_delivery, "delivered");
  assert.equal(scenario.notifyTurns(), 0, "a Goal-claimed epoch never appends a producer continuation");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 0);
  assert.equal(transcript.cards("subagent-completion-v1").length, 1);
});

test("a session without any wake consumer keeps the original producer fallback behaviour", async (t) => {
  const root = await fixtureRoot("no-goal-");
  const sessionId = `no-goal-${crypto.randomUUID()}`;
  const transcript = new FakeMainTranscript(sessionId);
  const scenario = await openScenario({ agentDirectory: root, sessionId, transcript, seed: true });
  t.after(async () => { await scenario.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });

  const outboxId = await settleAndAppendCards(scenario);
  const settled = await scenario.engine.settleWake(outboxId);

  assert.deepEqual(settled, { state: "delivered", kind: "producer-fallback" });
  assert.equal(scenario.outbox().settlement_kind, "producer-fallback");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, undefined);
  assert.equal(scenario.notifyTurns(), 1);
  assert.deepEqual(scenario.liveSends, [{ customType: "subagent-completion-v1", triggerTurn: false }, { customType: "subagent-continuation-v1", triggerTurn: true }]);
  assert.equal(transcript.cards("subagent-completion-v1").length, 1);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
});

test("withdrawing the consumer inside the Wake gap still delivers the result to the same session", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "cleared-gap-", withdrawBeforeCommit: true });

  const outbox = scenario.outbox();
  assert.equal(outbox.state, "delivered");
  assert.equal(outbox.settlement_kind, "producer-fallback");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, undefined);
  assert.equal(scenario.notifyTurns(), 1, "a cleared Goal does not withhold the producer notification");
  assert.equal(transcript.cards("subagent-completion-v1").length, 1);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  const tasks = scenario.host.snapshot().agents[0]!.tasks;
  assert.equal(tasks.length, 1, "clearing a Goal never cancels or re-runs the background Task");
  assert.equal(tasks[0]!.phase, "settled");

  await scenario.reconcile();
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.notifyTurns(), 1);
});

/** ⑧ 安全追加边界拒绝之后进程不死：修好 tool batch，下一个正常 reconcile 边界就把这一条补投完。 */
test("an append boundary failure is retried at the next in-process reconcile boundary without a restart", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "open-wake-retry-", noConsumer: true, settle: false });
  const outboxId = scenario.outbox().outbox_id;

  // card 已经追加完。Main 随后开了一个未 resolve 的 tool batch：continuation 插不进去。
  scenario.failNextContinuation();
  await assert.rejects(scenario.engine.settleWake(outboxId), /mailbox acceptance failed/u);
  assert.equal(scenario.outbox().state, "cards-appended");
  assert.equal(scenario.outbox().wake_state, "open");
  assert.equal(scenario.outbox().wake_epoch, 1);
  assert.equal(scenario.notifyTurns(), 0);
  assert.equal(getContinuationRegistryV1().snapshot(scenario.outbox().recipient.session_id).openOffers, 0, "失败的 append 必须先 abort 自己的 offer");

  // tool batch 收口，进程没有重启，store 也没有重开。
  await scenario.reconcile();

  assert.equal(scenario.outbox().state, "delivered");
  assert.equal(scenario.outbox().settlement_kind, "producer-fallback");
  assert.equal(scenario.outbox().wake_epoch, 1, "mailbox 重试保持原 epoch");
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.receipts()[0]!.kind, "producer-fallback");
  assert.equal(scenario.receipts()[0]!.runtime_delivery, "delivered");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, undefined);
  assert.equal(scenario.notifyTurns(), 1, "恰好一次通知 turn");
  assert.equal(getContinuationRegistryV1().snapshot(scenario.outbox().recipient.session_id).openOffers, 0, "重试自己的 offer 也已经结算干净");
  assert.equal(transcript.cards("subagent-completion-v1").length, 1, "重试不重发 card");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  const tasks = scenario.host.snapshot().agents[0]!.tasks;
  assert.equal(tasks.length, 1, "原 Task 不重跑");
  assert.equal(tasks[0]!.phase, "settled");

  // 再来一个边界不再补第二条。
  await scenario.reconcile();
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.notifyTurns(), 1);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
});

/** ⑧ prove 失败但 entry 已经物理落盘：按原 entry 身份终态化，绝不追加第二条。 */
test("a continuation that was appended before its proof failed terminalizes from that same entry", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "open-wake-proof-", noConsumer: true, settle: false });
  const outboxId = scenario.outbox().outbox_id;

  const failing = new DeliveryEngineV1({
    ...scenario.engine.options,
    resolveAppendPort: (recipient: ConversationRefV1) => {
      const port = scenario.engine.options.resolveAppendPort(recipient);
      if (!port) return undefined;
      return { conversation: port.conversation, appendCompletion: (value) => port.appendCompletion(value), proveCompletion: (value) => port.proveCompletion(value), appendContinuation: (value) => port.appendContinuation!(value), proveContinuation: async () => { throw new Error("injected continuation proof failure"); }, findContinuation: port.findContinuation ? (value) => port.findContinuation!(value) : undefined } satisfies DeliveryAppendPortV1;
    },
  });
  await assert.rejects(failing.settleWake(outboxId), /injected continuation proof failure/u);

  assert.equal(transcript.cards("subagent-continuation-v1").length, 1, "prove 失败时 entry 已经在 transcript 里");
  const entryId = transcript.cards("subagent-continuation-v1")[0]!.id;
  assert.equal(scenario.notifyTurns(), 1, "这条 entry 已经唤醒过 Main 一次");
  assert.equal(scenario.outbox().state, "cards-appended");
  assert.equal(scenario.outbox().wake_state, "open");

  await scenario.reconcile();

  assert.equal(transcript.cards("subagent-continuation-v1").length, 1, "已经物理送达的 entry 不得被第二条覆盖");
  assert.equal(scenario.notifyTurns(), 1, "不制造第二次唤醒");
  assert.equal(scenario.outbox().state, "delivered");
  assert.equal(scenario.outbox().settlement_kind, "producer-fallback");
  assert.equal(scenario.outbox().wake_epoch, 1, "已送达的 epoch 不再烧新 epoch");
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.receipts()[0]!.continuation_identity, entryId, "receipt 用原 entry 身份");
  assert.equal(scenario.receipts()[0]!.runtime_delivery, "delivered");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, undefined);
});

/** ⑧ deliver 与 reconcile 两个入口撞上同一个 Outbox：open 期间的 reconcile 不许起第二条 continuation。 */
test("a reconcile boundary inside an open Wake never starts a second continuation for the same Outbox", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "open-wake-race-", noConsumer: true, settle: false });
  const outboxId = scenario.outbox().outbox_id;

  // open 已经落盘、continuation 还没追加的窗口里，正常 lifecycle 边界跑一次 reconcile。
  const racing = new DeliveryEngineV1({ ...scenario.engine.options, host: withOpenWakeGap(scenario.host, async () => { await scenario.reconcile(); }) });
  assert.deepEqual(await racing.settleWake(outboxId), { state: "delivered", kind: "producer-fallback" });

  assert.equal(transcript.cards("subagent-continuation-v1").length, 1, "同一个 Outbox 只能有一条 continuation");
  assert.equal(scenario.notifyTurns(), 1);
  assert.equal(scenario.outbox().state, "delivered");
  assert.equal(scenario.outbox().wake_epoch, 1, "并发边界不额外烧 epoch");
  assert.equal(scenario.receipts().length, 1);
  assert.equal(transcript.cards("subagent-completion-v1").length, 1);
});

/** ⑨ producer 分支的 terminalize 一次失败：Outbox 停在 wake-settlement-pending，下一个边界用原 entry 终态化。 */
test("a failed terminalize on a fallback-appended Wake finishes from the same native entry at the next boundary", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "terminalize-fallback-", noConsumer: true, settle: false });
  const outboxId = scenario.outbox().outbox_id;

  const sink: { offer?: { sessionId: string; offerId: string; offerGeneration: number } } = {};
  const failing = new DeliveryEngineV1({ ...scenario.engine.options, host: withOneShotTransactionFailure(withCapturedOffer(scenario.host, sink), "terminalizeOutbox", "injected terminal Wake transaction failure") });
  await assert.rejects(failing.settleWake(outboxId), /injected terminal Wake transaction failure/u);

  // continuation 已经物理落盘并唤醒过 Main 一次，receipt 事务却没提交：这就是 §7.6 的 wake-settlement-pending。
  assert.equal(scenario.outbox().state, "wake-settlement-pending");
  assert.equal(scenario.outbox().wake_state, "fallback-appended");
  assert.equal(scenario.outbox().settlement_kind, "producer-fallback");
  assert.equal(scenario.outbox().wake_epoch, 1);
  // pending 事务已经把这一 epoch 的结算证据落盘；只有终态事务把它链接到 Outbox 上，delivered 才成立。
  assert.equal(scenario.receipts().length, 1, "pending 事务落盘的结算证据");
  assert.equal(scenario.receipts()[0]!.kind, "producer-fallback");
  assert.equal(scenario.outbox().settlement_proof_id, undefined, "终态事务失败就没有链接");
  assert.equal(scenario.notifyTurns(), 1);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  const entryId = transcript.cards("subagent-continuation-v1")[0]!.id;
  const declined = sink.offer!;
  // §7.5：terminal 事务提交前 proof 必须还活着，不能只因为 wake.commit() 返回就清掉。
  const stillHeld = getOrCreateProducerProofRegistryV1().reserve({ key: { session_id: declined.sessionId, offer_id: declined.offerId, offer_generation: declined.offerGeneration }, owner_token: "leak-probe", owner_generation: 1 });
  assert.equal(stillHeld.ok, false, "terminal 事务之前 proof 保持 active");

  await scenario.reconcile();

  assert.equal(scenario.outbox().state, "delivered");
  assert.equal(scenario.outbox().wake_state, "settled");
  assert.equal(scenario.outbox().settlement_kind, "producer-fallback");
  assert.equal(scenario.outbox().wake_epoch, 1, "已送达的 epoch 不再烧新 epoch");
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.receipts()[0]!.kind, "producer-fallback");
  assert.equal(scenario.receipts()[0]!.continuation_identity, entryId, "receipt 用原 entry 身份");
  assert.equal(scenario.receipts()[0]!.runtime_delivery, "delivered");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, undefined);
  assert.equal(scenario.notifyTurns(), 1, "不制造第二次唤醒");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  assert.equal(transcript.cards("subagent-completion-v1").length, 1);
  // 终态化之后 reservation 必须还回去：换一个 owner_token 还能 reserve 才证明表里没留占位。
  const reReserved = getOrCreateProducerProofRegistryV1().reserve({ key: { session_id: declined.sessionId, offer_id: declined.offerId, offer_generation: declined.offerGeneration }, owner_token: "leak-probe", owner_generation: 1 });
  assert.equal(reReserved.ok, true, "终态化之后 proof reservation 不再永占");
  if (reReserved.ok) reReserved.handle.clear();
  const tasks = scenario.host.snapshot().agents[0]!.tasks;
  assert.equal(tasks.length, 1, "原 Task 不重跑");
  assert.equal(tasks[0]!.phase, "settled");

  await scenario.reconcile();
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.notifyTurns(), 1);
});

test("a failed terminalize on a claimed Wake finishes from the protocol receipt without a producer continuation", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "terminalize-claimed-", settle: false });
  const outboxId = scenario.outbox().outbox_id;

  const failing = new DeliveryEngineV1({ ...scenario.engine.options, host: withOneShotTransactionFailure(scenario.host, "terminalizeOutbox", "injected terminal Wake transaction failure") });
  await assert.rejects(failing.settleWake(outboxId), /injected terminal Wake transaction failure/u);

  assert.equal(scenario.outbox().state, "wake-settlement-pending");
  assert.equal(scenario.outbox().wake_state, "claimed");
  assert.equal(scenario.outbox().settlement_kind, "goal-claimed");
  assert.equal(scenario.receipts().length, 1, "pending 事务落盘的 consumer receipt");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, "pi-goal-local");
  assert.equal(scenario.outbox().settlement_proof_id, undefined, "终态事务失败就没有链接");
  assert.equal(scenario.notifyTurns(), 0);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 0);

  await scenario.reconcile();

  assert.equal(scenario.outbox().state, "delivered");
  assert.equal(scenario.outbox().wake_state, "settled");
  assert.equal(scenario.outbox().settlement_kind, "goal-claimed");
  assert.equal(scenario.outbox().wake_epoch, 1, "claim 过的 epoch 不再重投");
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.receipts()[0]!.kind, "goal-claimed");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, "pi-goal-local", "终态化必须证明真实 owner");
  assert.equal(typeof scenario.receipts()[0]!.claimant_generation, "number");
  assert.equal(scenario.receipts()[0]!.runtime_delivery, "delivered");
  assert.equal(scenario.notifyTurns(), 0, "被 claim 的 epoch 不补 producer continuation");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 0);
  assert.equal(transcript.cards("subagent-completion-v1").length, 1);

  await scenario.reconcile();
  assert.equal(scenario.receipts().length, 1);
});

/** ⑩ lease 已经释放、open 事务一次失败：下一个边界用 detached offer 补投，不再永久缺 Wake authority。 */
test("a released Task lease with a failed open commit still delivers from a detached offer at the next boundary", async (t) => {
  const { scenario, transcript } = await backgroundResult(t, { prefix: "open-commit-lease-", noConsumer: true, settle: false });
  const outboxId = scenario.outbox().outbox_id;
  const sessionId = scenario.outbox().recipient.session_id;

  const failing = new DeliveryEngineV1({ ...scenario.engine.options, host: withOneShotTransactionFailure(scenario.host, "openOutboxWake", "injected Wake open commit failure") });
  await assert.rejects(failing.settleWake(outboxId), /injected Wake open commit failure/u);

  // volatile lease 已经在 releaseAndOfferWake 里没了，durable 记录还停在 release-pending/not-offered。
  assert.equal(scenario.outbox().state, "cards-appended");
  assert.equal(scenario.outbox().wake_state, "not-offered");
  assert.equal(scenario.outbox().wake_epoch, 0, "open 事务失败就没有 epoch");
  assert.equal(scenario.host.snapshot().agents[0]!.tasks[0]!.lease_disposition, "release-pending");
  assert.throws(() => scenario.host.releaseRootTaskLease({ taskId: TASK, outcome: "ready", reason: "retry" }), /Task lease Wake authority is unavailable/u);
  assert.equal(getContinuationRegistryV1().snapshot(sessionId).openOffers, 0, "失败的 open 必须 abort 自己的 offer");
  assert.equal(scenario.notifyTurns(), 0);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 0);

  await scenario.reconcile();

  assert.equal(scenario.outbox().state, "delivered");
  assert.equal(scenario.outbox().settlement_kind, "producer-fallback");
  assert.equal(scenario.outbox().wake_epoch, 1, "detached 重投烧掉这一个 epoch");
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.receipts()[0]!.kind, "producer-fallback");
  assert.equal(scenario.receipts()[0]!.runtime_delivery, "delivered");
  assert.equal(scenario.receipts()[0]!.claimant_owner_id, undefined);
  assert.equal(scenario.notifyTurns(), 1, "恰好一次通知 turn");
  assert.equal(transcript.cards("subagent-completion-v1").length, 1, "恢复不重发 card");
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
  assert.equal(getContinuationRegistryV1().snapshot(sessionId).openOffers, 0);
  assert.equal(scenario.host.snapshot().agents[0]!.tasks[0]!.lease_disposition, "released", "成功的 open 事务把 lease 提交成 released");
  const tasks = scenario.host.snapshot().agents[0]!.tasks;
  assert.equal(tasks.length, 1, "原 Task 不重跑");
  assert.equal(tasks[0]!.phase, "settled");

  await scenario.reconcile();
  assert.equal(scenario.receipts().length, 1);
  assert.equal(scenario.notifyTurns(), 1);
  assert.equal(transcript.cards("subagent-continuation-v1").length, 1);
});

test("a failed terminalize that outlives the process finishes from the persisted settlement receipt", async (t) => {
  const fixture = await backgroundResult(t, { prefix: "restart-claimed-", settle: false });
  const outboxId = fixture.scenario.outbox().outbox_id;

  const failing = new DeliveryEngineV1({ ...fixture.scenario.engine.options, host: withOneShotTransactionFailure(fixture.scenario.host, "terminalizeOutbox", "injected terminal Wake transaction failure") });
  await assert.rejects(failing.settleWake(outboxId), /injected terminal Wake transaction failure/u);
  assert.equal(fixture.scenario.outbox().state, "wake-settlement-pending");
  assert.equal(fixture.scenario.outbox().wake_state, "claimed");
  assert.equal(fixture.scenario.outbox().settlement_kind, "goal-claimed");

  await fixture.scenario.close();
  fixture.scenario.abandonLeases();
  fixture.peer?.dispose();

  const reloadedPeer = fixture.peer ? wakePeer(fixture.sessionId) : undefined;
  const reloaded = await openScenario({ agentDirectory: fixture.root, sessionId: fixture.sessionId, transcript: fixture.transcript, seed: false });
  t.after(async () => { await reloaded.close().catch(() => undefined); reloadedPeer?.dispose(); });

  await reloaded.reconcile();
  await reloaded.reconcile();

  assert.equal(reloaded.outbox().state, "delivered");
  assert.equal(reloaded.outbox().wake_state, "settled");
  assert.equal(reloaded.outbox().settlement_kind, "goal-claimed");
  assert.equal(reloaded.outbox().wake_epoch, 1, "已经定了 owner 的 epoch 不再重投");
  assert.equal(reloaded.receipts().length, 1);
  assert.equal(reloaded.receipts()[0]!.kind, "goal-claimed");
  assert.equal(reloaded.receipts()[0]!.claimant_owner_id, "pi-goal-local", "终态化用的是原 claimant 的真实身份");
  assert.equal(typeof reloaded.receipts()[0]!.claimant_generation, "number");
  assert.equal(reloaded.notifyTurns(), 0, "重开不补 producer continuation");
  assert.equal(fixture.transcript.cards("subagent-continuation-v1").length, 0);
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1);
  const tasks = reloaded.host.snapshot().agents[0]!.tasks;
  assert.equal(tasks.length, 1, "原 Task 不重跑");
  assert.equal(tasks[0]!.phase, "settled");
});

/** ⑫ 已结算 Task 的 release-pending：重开 store 不得为它重新 acquire 一个 blocking lease。 */
test("a settled Task with a pending lease release never reacquires a blocking lease after a restart", async (t) => {
  const fixture = await backgroundResult(t, { prefix: "restart-lease-", noConsumer: true, settle: false });
  const outboxId = fixture.scenario.outbox().outbox_id;

  const failing = new DeliveryEngineV1({ ...fixture.scenario.engine.options, host: withOneShotTransactionFailure(fixture.scenario.host, "openOutboxWake", "injected Wake open commit failure") });
  await assert.rejects(failing.settleWake(outboxId), /injected Wake open commit failure/u);
  assert.equal(fixture.scenario.host.snapshot().agents[0]!.tasks[0]!.phase, "settled");
  assert.equal(fixture.scenario.host.snapshot().agents[0]!.tasks[0]!.lease_disposition, "release-pending");

  await fixture.scenario.close();
  fixture.scenario.abandonLeases();
  fixture.peer?.dispose();
  assert.equal(getContinuationRegistryV1().snapshot(fixture.sessionId).blocking.length, 0);

  // openScenario 内部就跑 recoverRootTaskLeases：重开这一步本身不许把 Main 标成 busy。
  const reloadedPeer = fixture.peer ? wakePeer(fixture.sessionId) : undefined;
  const reloaded = await openScenario({ agentDirectory: fixture.root, sessionId: fixture.sessionId, transcript: fixture.transcript, seed: false });
  t.after(async () => { await reloaded.close().catch(() => undefined); reloadedPeer?.dispose(); });

  assert.deepEqual(getContinuationRegistryV1().snapshot(fixture.sessionId).blocking, [], "已结算 Task 不重新 acquire blocking lease");

  await reloaded.reconcile();

  assert.equal(reloaded.outbox().state, "delivered");
  assert.equal(reloaded.outbox().settlement_kind, "producer-fallback");
  assert.equal(reloaded.receipts().length, 1);
  assert.equal(reloaded.notifyTurns(), 1, "detached offer 恰好补投一次");
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1);
  assert.equal(fixture.transcript.cards("subagent-continuation-v1").length, 1);
  assert.equal(reloaded.host.snapshot().agents[0]!.tasks[0]!.lease_disposition, "released");
  assert.equal(reloaded.host.snapshot().agents[0]!.tasks.length, 1, "原 Task 不重跑");
  assert.deepEqual(getContinuationRegistryV1().snapshot(fixture.sessionId).blocking, [], "补投之后 Main 也不是 busy");
});
