import { goalMailboxSourceDouble } from "../fixtures/goal-mailbox.js";
import { nativeMailboxDouble } from "../fixtures/mailbox.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  getContinuationRegistryV1,
  type WakeSettlementV1,
} from "pi-runtime-contracts/continuation-v1";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { AgentHostCoreV1 } from "../../src/host/core.ts";
import { DeliveryEngineV1 } from "../../src/host/delivery-engine.ts";
import { MainSessionAppendPortV1 } from "../../src/host/main-append-port.ts";
import { getOrCreateProducerProofRegistryV1 } from "../../src/host/producer-proof.ts";
import { rootHeaderV1 } from "../../src/persistence/codecs.ts";
import { collectInboxTranscriptProofsV1 } from "../../src/persistence/inbox-proofs.ts";
import { PRIVATE_DIR_MODE } from "../../src/persistence/layout.ts";
import { openMainStoreV1, type MainStoreV1 } from "../../src/persistence/store.ts";
import type {
  ConversationRefV1,
  NormalizedStoreStateV1,
  OutboxRecordV1,
} from "../../src/persistence/types.ts";

// 真实 Goal extension 按源码加载，与 paused-goal-wake-recovery.test.ts 同一条 test-scope
// direct-source 边（docs/pi/dependencies.json）；production import 边界不变。
const GOAL_ROOT = new URL("../../../../fork/pi-goal/", import.meta.url).href;

const AT = "2027-04-01T00:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const AGENT_A = encodeDomainId("agt", Buffer.alloc(16, 51));
const AGENT_B = encodeDomainId("agt", Buffer.alloc(16, 52));
const TASK_A = encodeDomainId("tsk", Buffer.alloc(16, 61));
const TASK_B = encodeDomainId("tsk", Buffer.alloc(16, 62));
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

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

/** Main 的 native transcript：Goal state entry 与 Subagent card 共用同一条 branch。 */
class FakeMainTranscript {
  readonly entries: TranscriptEntry[] = [];
  readonly #sessionId: string;
  #counter = 0;
  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }
  getSessionId(): string {
    return this.#sessionId;
  }
  getLeafId(): string | null { return this.entries.at(-1)?.id ?? null; }
  getHeader() { return { type: "session" as const, version: 3, id: this.#sessionId, cwd: "/tmp", timestamp: AT }; }
  getSessionFile(): string { return join("/tmp", encodeURIComponent(this.#sessionId) + ".jsonl"); }
  getBranch(): TranscriptEntry[] {
    return this.entries;
  }
  getEntries(): TranscriptEntry[] {
    return this.entries;
  }
  getEntry(id: string): TranscriptEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }
  appendCustomMessageEntry(
    customType: string,
    content: string,
    display: boolean,
    details: unknown,
  ): string {
    const id = `entry-${++this.#counter}`;
    this.entries.push({ id, parentId: this.getLeafId(), type: "custom_message", customType, content, display, details });
    return id;
  }
  cards(customType: string): TranscriptEntry[] {
    return this.entries.filter(
      (entry) => entry.type === "custom_message" && entry.customType === customType,
    );
  }
}

function profile(agentId: string) {
  return {settings_snapshot: {}, delegation_max_depth: 2 as const,
    version: 1 as const,
    role: {
      name: "default",
      source: "built-in" as const,
      provenance: "builtin",
      body: "role",
      sha256: sha("role"),
    },
    provider: "openai-codex",
    model: "gpt-5.4",
    model_scope: ["openai-codex/gpt-5.4"],
    reasoning_effort: "high" as const,
    task_timeout_ms: 60_000,
    cwd: "/tmp",
    project_trusted: true,
    system_prompt_options_sha256: sha("o"),
    prompt_assembler_version: 1 as const,
    system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`,
    system_prompt_bytes: 1,
    system_prompt_sha256: sha("p"),
    capabilities: {
      version: 1 as const,
      fingerprint: sha("c"),
      active_tools: [],
      tool_definitions: [],
      entries: [],
    },
    created_at: AT,
  };
}

function put(transactionId: string, entityType: string, entityId: string, value: unknown) {
  return {
    version: 1 as const,
    type: "put" as const,
    transaction_id: transactionId,
    entity_type: entityType as never,
    entity_id: entityId,
    value,
  };
}

interface SeedChild {
  readonly agentId: string;
  readonly taskId: string;
  readonly name: string;
  readonly order: number;
}

/** 把若干 running Subagent Task 一次性 seed 进真实 store，lease 由 recoverRootTaskLeases 取得。 */
async function seedRunningTasks(
  store: MainStoreV1,
  sessionId: string,
  children: readonly SeedChild[],
): Promise<void> {
  const snapshot = store.snapshot();
  const revision = snapshot.root.host_revision + 1;
  const transactionId = encodeDomainId("txn", Buffer.alloc(16, 71));
  const mutations = children.flatMap((child) => {
    const agent = {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,
      version: 1,
      record_revision: revision,
      agent_id: child.agentId,
      parent_conversation: { kind: "main", session_id: sessionId },
      task_name: child.name,
      task_path: `/root/${child.name}`,
      depth: 1,
      created_at: AT,
      created_revision: revision,
      profile: profile(child.agentId),
      conversation: {
        session_id: `child-session-${child.name}`,
        relative_path: `conversations/${child.agentId}/session.jsonl`,
        initial_bytes: 1,
        initial_sha256: sha("s"),
        last_validated_bytes: 1,
        last_validated_mtime_ms: 1,
      },
      availability: "available",
      current_task_id: child.taskId,
      queued_task_ids: [],
      next_mailbox_sequence: 1,
      next_owner_event_sequence: 1,
      last_owner_event_acked_sequence: 0,
    };
    const task = {initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: sessionId}}, owner_conversation: {kind: "main" as const, session_id: sessionId},
      version: 1,
      record_revision: revision,
      task_id: child.taskId,
      agent_id: child.agentId,
      origin: "initial",
      admission_order: child.order,
      message: "work",
      phase: "running",
      admitted_at: AT,
      started_at: AT,
      deadline_at_ms: Date.parse(AT) + 60_000,
      runtime_generation: 1,
      lease_intent: {
        api_version: 1,
        session_id: sessionId,
        owner_id: "pi-subagents",
        logical_key: child.taskId,
        reason: "subagent work",
      },
      lease_disposition: "required",
    };
    return [put(transactionId, "agent", child.agentId, agent), put(transactionId, "task", child.taskId, task)];
  });
  await store.commit({
    transactionId,
    operation: "seed-running-tasks",
    mutations: [
      put(transactionId, "root", "root", {
        ...rootHeaderV1(snapshot.root),
        host_revision: revision,
        agent_ids: children.map((child) => child.agentId).sort(),
        next_admission_order: children.length + 1,
      }),
      ...mutations,
    ],
  });
}

interface GoalHarness {
  readonly mock: {
    pi: never;
    sentUserMessages: { text: string }[];
    commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
    events: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
    rawPi: { appendEntry: (customType: string, data: unknown) => void };
  };
  command(args: string): Promise<void>;
  shutdown(): Promise<void>;
  /** Main 是否空闲；置 false 表示模型还在跑一个 turn。 */
  setIdle(idle: boolean): void;
  /** Goal 自主推进的 prompt 文本，与 producer 的模型通知 turn 分开计数。 */
  goalPromptTexts(): string[];
  goalPrompts(): number;
  goalStatus(): string | undefined;
  /** 触发 Pi 的 agent_settled 安全边界。 */
  settle(): Promise<void>;
  /** 让排队中的 Goal prompt 真正开跑，关闭当前这个处理边界。 */
  startQueuedTurn(): Promise<void>;
}

async function startGoal(transcript: FakeMainTranscript, settingsPath: string): Promise<GoalHarness> {
  const support = (await import(`${GOAL_ROOT}test/support.ts`)) as {
    createMockPi: (options: Record<string, unknown>) => GoalHarness["mock"];
    createMockContext: (overrides: Record<string, unknown>) => { ctx: unknown };
  };
  const goalModule = (await import(`${GOAL_ROOT}extensions/pi-goal/src/goal.ts`)) as {
    default: (pi: never, options: Record<string, unknown>) => void;
  };
  const mock = support.createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
  const nativeAppend = mock.rawPi.appendEntry.bind(mock.rawPi);
  mock.rawPi.appendEntry = (customType: string, data: unknown) => {
    nativeAppend(customType, data);
    transcript.entries.push({
      id: `goal-${transcript.entries.length + 1}`,
      parentId: transcript.getLeafId(),
      type: "custom",
      customType,
      data: structuredClone(data),
    });
  };
  const sourceMailbox = goalMailboxSourceDouble(transcript);
  goalModule.default(mock.pi, { settingsPath, mailbox: sourceMailbox.binding });
  let idle = true;
  const context = support.createMockContext({
    // C's support factory spreads this value, so methods must be own properties.
    sessionManager: {
      getSessionId: () => transcript.getSessionId(), getLeafId: () => transcript.getLeafId(),
      getHeader: () => transcript.getHeader(), getSessionFile: () => transcript.getSessionFile(),
      getBranch: () => transcript.getBranch(), getEntries: () => transcript.getEntries(),
      getEntry: (id: string) => transcript.getEntry(id),
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, context.ctx);
  const goalPromptTexts = () =>
    sourceMailbox.texts();
  return {
    mock,
    async command(args: string) {
      await mock.commands.get("goal")?.handler(args, context.ctx);
    },
    async shutdown() {
      for (const handler of mock.events.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, context.ctx);
    },
    setIdle(next: boolean) {
      idle = next;
    },
    goalPromptTexts,
    goalPrompts() {
      return goalPromptTexts().length;
    },
    goalStatus() {
      return (
        transcript.entries.filter((entry) => entry.customType === "goal-state").at(-1)?.data as
          | { goal?: { status?: string } }
          | undefined
      )?.goal?.status;
    },
    async settle() {
      for (const handler of mock.events.get("agent_settled") ?? []) await handler({ type: "agent_settled", aborted: false }, context.ctx);
      await sourceMailbox.settled(context.ctx);
    },
    async startQueuedTurn() {
      await sourceMailbox.start(context.ctx);
    },
  };
}

/** Process producer：只用 pi-runtime-contracts 的公共 lease/offer 面，与 pi-processes host 同一契约。 */
function processProducer(sessionId: string, key: string) {
  const registry = getContinuationRegistryV1();
  const acquired = registry.acquireBlocking({
    sessionId,
    ownerId: "pi-processes",
    logicalKey: key,
    reason: `Process '${key}' is waiting for exit`,
  });
  if (!acquired.ok) throw new Error(acquired.message);
  let released = false;
  return {
    releaseAndCommit(): WakeSettlementV1 {
      const offer = acquired.value.releaseAndOfferWake({
        outcome: "ready",
        reason: `Process '${key}' exited`,
      });
      if (!offer.ok) throw new Error(offer.message);
      released = true;
      // 真实 producer 在 offer 与 commit 之间持久化自己的 notification artifact。
      const settled = offer.value.commit("delivered");
      if (!settled.ok) throw new Error(settled.message);
      return settled.value;
    },
    dispose() {
      if (!released) acquired.value.releaseWithoutWake({ outcome: "cancelled", reason: "test end" });
    },
  };
}

interface Scenario {
  readonly store: MainStoreV1;
  readonly host: AgentHostCoreV1;
  readonly engine: DeliveryEngineV1;
  outboxes(): OutboxRecordV1[];
  receipts(): NormalizedStoreStateV1["root"]["wake_receipts"];
  /** producer 自己发出的模型通知 turn 数（triggerTurn 的 subagent-continuation-v1）。 */
  notifyTurns(): number;
  releaseHeldLeases(): void;
  close(): Promise<void>;
}

async function openScenario(input: {
  readonly agentDirectory: string;
  readonly sessionId: string;
  readonly transcript: FakeMainTranscript;
  readonly children: readonly SeedChild[];
}): Promise<Scenario> {
  const registry = getContinuationRegistryV1();
  const held: { releaseWithoutWake: (value: { outcome: "cancelled"; reason: string }) => unknown }[] = [];
  const liveSends: { customType: string; triggerTurn: boolean }[] = [];
  const transcript = input.transcript;
  const store = await openMainStoreV1({
    agentDirectory: input.agentDirectory,
    mainSessionId: input.sessionId,
    now: () => new Date(AT),
    limits: {
      maxStoreBytesPerMain: 536_870_912,
      maxStoreBytesPerProcess: 2_147_483_648,
      maxMetadataBytesPerMain: 33_554_432,
    },
    liveRuntimeGenerations: new Map(),
    inboxProofProvider: (state: NormalizedStoreStateV1) =>
      collectInboxTranscriptProofsV1({
        state,
        mainRoot: join(input.agentDirectory, "pi-subagents"),
        mainSessionManager: transcript as never,
      }),
  });
  await seedRunningTasks(store, input.sessionId, input.children);
  const host = new AgentHostCoreV1({
    mainSessionId: input.sessionId,
    instanceGeneration: 1,
    config: { maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 },
    store,
    leases: {
      acquire: async ({ sessionId: leaseSession, taskId, reason }) => {
        const acquired = registry.acquireBlocking({
          sessionId: leaseSession,
          ownerId: "pi-subagents",
          logicalKey: taskId,
          reason,
        });
        if (!acquired.ok) throw new Error(acquired.message);
        held.push(acquired.value);
        return {
          leaseId: acquired.value.snapshot().leaseId,
          generation: acquired.value.snapshot().generation,
          releaseWithoutWake: async (release) => {
            const result = acquired.value.releaseWithoutWake(release);
            if (!result.ok) throw new Error(result.message);
          },
          releaseAndOfferWake: (release) => {
            const result = acquired.value.releaseAndOfferWake(release);
            if (!result.ok) throw new Error(result.message);
            return result.value as never;
          },
        };
      },
    },
    runtime: { residency: () => undefined, async interrupt() {} },
    scheduler: { taskAdmitted() {} },
    now: () => new Date(AT),
  });
  await host.recoverRootTaskLeases();
  const appendPort = new MainSessionAppendPortV1(transcript as never, nativeMailboxDouble(transcript as never,
    (message, options) => { liveSends.push({ customType: message.customType, triggerTurn: options.triggerTurn }); }));
  const engine = new DeliveryEngineV1({
    host,
    resolveAppendPort: (recipient: ConversationRefV1) =>
      recipient.kind === "main" && recipient.session_id === input.sessionId ? appendPort : undefined,
    offerWake: (offer) => {
      const created = registry.offerWake({
        sessionId: offer.sessionId,
        ownerId: "pi-subagents",
        logicalKey: offer.logicalKey,
        reason: offer.reason,
        outcome: offer.outcome,
      });
      if (!created.ok) throw new Error(created.message);
      return created.value as never;
    },
    producerProofRegistry: getOrCreateProducerProofRegistryV1(),
    ownerToken: `main:${input.sessionId}`,
    ownerGeneration: 1,
    now: () => new Date(AT),
  });
  const allOutboxes = () => {
    const state = host.snapshot();
    return [state.root, ...state.agents].flatMap((item) => item.outbox);
  };
  return {
    store,
    host,
    engine,
    outboxes: allOutboxes,
    receipts() {
      const state = host.snapshot();
      return [state.root, ...state.agents].flatMap((item) => item.wake_receipts);
    },
    notifyTurns() {
      return liveSends.filter(
        (send) => send.customType === "subagent-continuation-v1" && send.triggerTurn,
      ).length;
    },
    releaseHeldLeases() {
      for (const lease of held.splice(0))
        lease.releaseWithoutWake({ outcome: "cancelled", reason: "test end" });
    },
    async close() {
      await store.close();
    },
  };
}

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, PRIVATE_DIR_MODE);
  await mkdir(join(root, "pi-subagents", "store-v2", "mains"), {
    recursive: true,
    mode: PRIVATE_DIR_MODE,
  });
  return root;
}

interface Fixture {
  readonly root: string;
  readonly sessionId: string;
  readonly transcript: FakeMainTranscript;
  readonly goal: GoalHarness;
  readonly scenario: Scenario;
  readonly kickoffPrompts: number;
}

async function activeGoalFixture(
  t: TestContext,
  input: { readonly prefix: string; readonly children: readonly SeedChild[] },
): Promise<Fixture> {
  const root = await fixtureRoot(input.prefix);
  const sessionId = `${input.prefix}${crypto.randomUUID()}`;
  const settingsPath = join(root, "goal-settings.json");
  await writeFile(settingsPath, '{"toolVisibility":"always"}\n');
  const transcript = new FakeMainTranscript(sessionId);
  const goal = await startGoal(transcript, settingsPath);
  await goal.command("finish the background work");
  const kickoffPrompts = goal.mock.sentUserMessages.length;
  assert.equal(kickoffPrompts, 1, "goal kickoff is a distinct user-owned prompt");
  assert.equal(goal.goalStatus(), "active");
  const scenario = await openScenario({
    agentDirectory: root,
    sessionId,
    transcript,
    children: input.children,
  });
  t.after(async () => {
    scenario.releaseHeldLeases();
    await scenario.close().catch(() => undefined);
    await goal.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessionId, transcript, goal, scenario, kickoffPrompts };
}

/** 真实 settlement + card 追加，返回该 completion 的 Outbox ID。 */
async function settleAndAppendCards(
  scenario: Scenario,
  agentId: string,
  taskId: string,
): Promise<string> {
  const settled = await scenario.host.settleTask({
    agentId: agentId as never,
    taskId: taskId as never,
    runtimeGeneration: 1,
    completedAt: AT,
    outcome: "completed",
    reason: "normal-final",
    finalText: `result of ${taskId}`,
    summary: `result of ${taskId}`,
  });
  assert.equal(settled.ok, true, settled.ok ? "" : JSON.stringify(settled));
  if (!settled.ok) throw new Error("settleTask failed");
  const outboxId = settled.value.outbox_id;
  if (!outboxId) throw new Error("settlement produced no Outbox");
  assert.equal((await scenario.engine.deliverOutbox(outboxId)).state, "cards-appended");
  return outboxId;
}

function goalReceipt(settlement: WakeSettlementV1) {
  const receipt = settlement.consumerReceipt;
  assert.ok(receipt, "an active Goal must return a synchronous consumer receipt");
  assert.equal(receipt.consumerId, "pi-goal-local");
  return receipt;
}

/** ① D-008：两个独立 producer 在同一个安全边界完成，Goal 恰好排一次 turn（scheduled + coalesced）。 */
for (const order of ["process-first", "subagent-first"] as const) {
  test(`independent Process and Subagent completions on one safe boundary coalesce into a single Goal turn (${order})`, async (t) => {
    const prefix = `wake-coalesce-${order}-`;
    const fixture = await activeGoalFixture(t, {
      prefix,
      children: [{ agentId: AGENT_A, taskId: TASK_A, name: "a", order: 1 }],
    });
    const { goal, scenario, sessionId } = fixture;
    const process = processProducer(sessionId, "proc-1");
    t.after(() => process.dispose());

    const subagentOutbox = await settleAndAppendCards(scenario, AGENT_A, TASK_A);
    const continuationIds = new Set<string>();

    const runProcess = (expected: "scheduled" | "coalesced") => {
      const settlement = process.releaseAndCommit();
      const receipt = goalReceipt(settlement);
      assert.equal(receipt.scheduling, expected);
      continuationIds.add(receipt.continuationId);
      return settlement;
    };
    const runSubagent = async () => {
      const settled = await scenario.engine.settleWake(subagentOutbox);
      assert.deepEqual(settled, { state: "delivered", kind: "goal-claimed" });
      const receipt = scenario.receipts().at(-1);
      assert.ok(receipt, "a claimed Subagent Wake persists a goal-claimed receipt");
      continuationIds.add(receipt.continuation_identity);
      return receipt;
    };

    if (order === "process-first") {
      const first = runProcess("scheduled");
      assert.equal(first.offer.remainingBlocking, 1, "the Subagent lease is still live on the first release");
      await runSubagent();
    } else {
      await runSubagent();
      const second = runProcess("coalesced");
      assert.equal(second.offer.remainingBlocking, 0);
    }

    // 一个 continuation 身份、一条 Goal prompt：第一个完成先唤醒，第二个只 coalesce。
    assert.equal(continuationIds.size, 1, "both releases share one Goal continuation identity");
    assert.equal(goal.goalPrompts(), 1, "the same safe boundary produces exactly one Goal turn");
    assert.equal(
      goal.mock.sentUserMessages.length,
      fixture.kickoffPrompts,
      "custom continuation does not add another user prompt",
    );
    // 三类计数分开：Goal 自主推进 / Subagent producer 通知 turn / 终态 card。
    assert.equal(scenario.notifyTurns(), 0, "a claimed Subagent offer never adds a producer turn");
    assert.equal(fixture.transcript.cards("subagent-continuation-v1").length, 0);
    assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1, "one durable completion card");
    const receipts = scenario.receipts();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.kind, "goal-claimed");
    assert.equal(receipts[0]!.claimant_owner_id, "pi-goal-local");
    assert.equal(goal.goalStatus(), "active");
  });
}

/** ② D-008 ①：一个 producer 先完成时 Main 正忙，continuation 意图不得在下一个 agent_settled 被另一个 lease 抹掉。 */
test("a partial completion recorded while Main is busy still wakes the Goal at the next settled boundary", async (t) => {
  const fixture = await activeGoalFixture(t, {
    prefix: "wake-busy-partial-",
    children: [{ agentId: AGENT_A, taskId: TASK_A, name: "a", order: 1 }],
  });
  const { goal, scenario, sessionId } = fixture;
  const process = processProducer(sessionId, "proc-busy");
  t.after(() => process.dispose());

  // Main 正在跑一个 turn：既不 idle，也没有可插入的安全点。
  goal.setIdle(false);
  const settlement = process.releaseAndCommit();
  const receipt = goalReceipt(settlement);
  assert.equal(receipt.scheduling, "scheduled", "the claimed offer records a fresh continuation intent");
  assert.equal(settlement.offer.remainingBlocking, 1, "the Subagent lease is untouched");
  assert.equal(goal.goalPrompts(), 0, "a busy Main receives no prompt yet");

  // Main 到达安全边界。Subagent lease 仍然存活，但那是另一件事的等待，不该吃掉已完成结果的 turn。
  goal.setIdle(true);
  await goal.settle();

  assert.equal(goal.goalPrompts(), 1, "the finished Process result gets its own turn");
  assert.equal(goal.goalPromptTexts()[0]?.includes(receipt.continuationId), true, "same continuation identity");
  assert.equal(scenario.notifyTurns(), 0, "the Subagent producer sends nothing");
  assert.equal(
    getContinuationRegistryV1().snapshot(sessionId).blocking.length,
    1,
    "the still running Subagent keeps its blocking lease",
  );
  assert.equal(
    scenario.host.snapshot().agents.find((item) => item.agent.agent_id === AGENT_A)!.tasks[0]!.phase,
    "running",
    "the unfinished Subagent Task is never disturbed",
  );

  // 这一轮开跑之后再 settle，不会凭空多一条 prompt。
  await goal.startQueuedTurn();
  await goal.settle();
  assert.equal(goal.goalPrompts(), 1, "a live lease still defers ordinary Goal continuation");
});

/** ③ WAKE-004：A 走普通 settlement 并已投递，B 仍在跑，再 wait_agents([A,B])。 */
test("wait_agents arms over an already delivered child without duplicating its completion vehicle", async (t) => {
  const fixture = await activeGoalFixture(t, {
    prefix: "wake-mixed-barrier-",
    children: [
      { agentId: AGENT_A, taskId: TASK_A, name: "a", order: 1 },
      { agentId: AGENT_B, taskId: TASK_B, name: "b", order: 2 },
    ],
  });
  const { goal, scenario, sessionId } = fixture;

  // A 走完整的普通路径：settlement → card → Wake settle。
  const outboxA = await settleAndAppendCards(scenario, AGENT_A, TASK_A);
  assert.deepEqual(await scenario.engine.settleWake(outboxA), { state: "delivered", kind: "goal-claimed" });
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1);
  assert.equal(goal.goalPrompts(), 1, "A 的完成独立唤醒一次");
  await goal.startQueuedTurn();

  const caller = {
    kind: "main-model" as const,
    conversation: { kind: "main" as const, session_id: sessionId },
    binding_generation: 1,
  };
  const armed = await scenario.host.waitAgents({
    request_id: uuid(1),
    caller,
    input: { targets: ["/root/a", "/root/b"] },
  });
  assert.equal(armed.ok, true, armed.ok ? "" : JSON.stringify(armed));
  if (!armed.ok) return;
  assert.equal(armed.value.state, "armed");
  if (armed.value.state !== "armed") return;
  assert.deepEqual([...armed.value.settled_task_ids], [TASK_A], "A 已 settle，作为 settled 报告");
  assert.deepEqual([...armed.value.remaining_task_ids], [TASK_B]);
  assert.deepEqual([...armed.value.task_ids], [TASK_A, TASK_B], "snapshot 仍然是两个 Task");

  // A 保留自己已经投递的普通 Outbox，barrier 不得把它算成 covered completion。
  const ordinaryA = scenario.outboxes().filter((outbox) => outbox.outbox_id === outboxA);
  assert.equal(ordinaryA.length, 1);
  assert.equal(ordinaryA[0]!.state, "delivered");
  assert.equal(ordinaryA[0]!.kind, "completion-wake");
  const barrier = scenario.host.snapshot().root.barrier;
  assert.ok(barrier);
  assert.equal(barrier.state, "armed");
  assert.deepEqual(
    [...barrier.completion_ids],
    [],
    "已经独立投递的 completion 不再进入 barrier 的聚合集合",
  );
  assert.deepEqual([...barrier.task_ids], [TASK_B], "barrier 只等尚未 settle 的 Task");

  // 重开 store 会重跑全部持久化 invariant：这是 WAKE-004 的红线。
  await scenario.close();
  const reopened = await openMainStoreV1({
    agentDirectory: fixture.root,
    mainSessionId: sessionId,
    now: () => new Date(AT),
    limits: {
      maxStoreBytesPerMain: 536_870_912,
      maxStoreBytesPerProcess: 2_147_483_648,
      maxMetadataBytesPerMain: 33_554_432,
    },
    liveRuntimeGenerations: new Map(),
    inboxProofProvider: (state: NormalizedStoreStateV1) =>
      collectInboxTranscriptProofsV1({
        state,
        mainRoot: join(fixture.root, "pi-subagents"),
        mainSessionManager: fixture.transcript as never,
      }),
  });
  t.after(async () => {
    await reopened.close().catch(() => undefined);
  });
  const state = reopened.snapshot();
  assert.ok(state.root.barrier, "barrier 记录本身可以被重新读出");
  assert.equal(
    state.agents.find((item) => item.agent.agent_id === AGENT_A)!.tasks[0]!.phase,
    "settled",
    "A 不重跑",
  );
  // A 的 completion 只有它自己那一条已投递载体，barrier 没有把它再收进聚合集合。
  const completionA = state.agents.find((item) => item.agent.agent_id === AGENT_A)!.completions[0]!;
  const vehicles = [state.root, ...state.agents]
    .flatMap((item) => item.outbox)
    .filter((outbox) => outbox.completion_ids.includes(completionA.completion_id));
  assert.equal(vehicles.length, 1, "A 只有一条投递载体");
  assert.equal(vehicles[0]!.kind, "completion-wake");
  assert.equal(vehicles[0]!.state, "delivered");
  assert.equal(state.root.barrier!.completion_ids.includes(completionA.completion_id), false);
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1, "A 不重发 card");
});

/** ③ 续：B 完成才 satisfy barrier，并只为 B 投递一次聚合结果。 */
test("the mixed barrier only releases when the remaining child settles", async (t) => {
  const fixture = await activeGoalFixture(t, {
    prefix: "wake-mixed-release-",
    children: [
      { agentId: AGENT_A, taskId: TASK_A, name: "a", order: 1 },
      { agentId: AGENT_B, taskId: TASK_B, name: "b", order: 2 },
    ],
  });
  const { goal, scenario, sessionId } = fixture;

  const outboxA = await settleAndAppendCards(scenario, AGENT_A, TASK_A);
  assert.deepEqual(await scenario.engine.settleWake(outboxA), { state: "delivered", kind: "goal-claimed" });
  await goal.startQueuedTurn();

  const armed = await scenario.host.waitAgents({
    request_id: uuid(2),
    caller: {
      kind: "main-model" as const,
      conversation: { kind: "main" as const, session_id: sessionId },
      binding_generation: 1,
    },
    input: { targets: ["/root/a", "/root/b"] },
  });
  assert.equal(armed.ok, true, armed.ok ? "" : JSON.stringify(armed));

  // barrier armed 期间 B 完成：走 aggregate branch，不再产生普通 Outbox。
  const settledB = await scenario.host.settleTask({
    agentId: AGENT_B as never,
    taskId: TASK_B as never,
    runtimeGeneration: 1,
    completedAt: AT,
    outcome: "completed",
    reason: "normal-final",
    finalText: "b result",
    summary: "b result",
  });
  assert.equal(settledB.ok, true, settledB.ok ? "" : JSON.stringify(settledB));
  if (!settledB.ok) return;
  const barrier = scenario.host.snapshot().root.barrier!;
  assert.equal(barrier.state, "satisfied", "最后一个 covered Task 才 satisfy barrier");
  assert.equal(barrier.wake_outbox_id, settledB.value.outbox_id);
  const aggregate = scenario.outboxes().find((outbox) => outbox.outbox_id === settledB.value.outbox_id)!;
  assert.equal(aggregate.kind, "barrier-wake");
  assert.deepEqual([...aggregate.completion_ids], [...barrier.completion_ids]);
  assert.equal(aggregate.completion_ids.length, 1, "聚合结果只覆盖 barrier 自己等到的 completion");

  assert.equal((await scenario.engine.deliverOutbox(aggregate.outbox_id)).state, "cards-appended");
  assert.deepEqual(await scenario.engine.settleWake(aggregate.outbox_id), {
    state: "delivered",
    kind: "goal-claimed",
  });
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 2, "A、B 各一张 card，A 不重发");
  assert.equal(scenario.notifyTurns(), 0, "两次 Wake 都由 Goal claim");
  assert.equal(goal.goalPrompts(), 2, "两个独立的安全边界各一次 Goal turn");
});

/** ④ 一个 partition 只保留最新 Barrier：上一个 barrier 交付过的 Completion 不能因为被顶替而失去载体。 */
test("a second barrier can arm after the previous one was satisfied", async (t) => {
  const fixture = await activeGoalFixture(t, {
    prefix: "wake-sequential-barrier-",
    children: [
      { agentId: AGENT_A, taskId: TASK_A, name: "a", order: 1 },
      { agentId: AGENT_B, taskId: TASK_B, name: "b", order: 2 },
    ],
  });
  const caller = {
    kind: "main-model" as const,
    conversation: { kind: "main" as const, session_id: fixture.sessionId },
    binding_generation: 1,
  };

  const first = await fixture.scenario.host.waitAgents({
    request_id: uuid(11),
    caller,
    input: { targets: ["/root/a"] },
  });
  assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first));
  const aggregateA = await settleAndAppendCards(fixture.scenario, AGENT_A, TASK_A);
  assert.equal(fixture.scenario.host.snapshot().root.barrier!.state, "satisfied");
  assert.deepEqual(await fixture.scenario.engine.settleWake(aggregateA), {
    state: "delivered",
    kind: "goal-claimed",
  });
  assert.equal(
    fixture.scenario.outboxes().find((outbox) => outbox.outbox_id === aggregateA)!.kind,
    "barrier-wake",
  );
  await fixture.goal.startQueuedTurn();

  // 第二个 barrier 顶替第一个：A 的 completion 只剩 barrier-wake 这一条载体，仍然合法。
  const second = await fixture.scenario.host.waitAgents({
    request_id: uuid(12),
    caller,
    input: { targets: ["/root/b"] },
  });
  assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second));
  if (!second.ok || second.value.state !== "armed") return;
  assert.deepEqual([...second.value.remaining_task_ids], [TASK_B]);
  assert.equal(fixture.scenario.host.snapshot().root.barrier!.barrier_id !== undefined, true);
  assert.equal(fixture.transcript.cards("subagent-completion-v1").length, 1);
});
