import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.js";
import { AgentHostCoreV1 } from "../../src/host/core.js";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.js";
import type { FrozenProfileV1, NormalizedStoreStateV1 } from "../../src/persistence/types.js";
import { ChildSession } from "../../src/runtime/child-session.js";
import type { ChildHostPort } from "../../src/runtime/child-tools.js";
import { SdkRuntimeControllerV1 } from "../../src/runtime/sdk-controller.js";

const agentId = encodeDomainId("agt", Buffer.alloc(16, 81));
const taskId = encodeDomainId("tsk", Buffer.alloc(16, 82));
const at = "2027-03-01T00:00:00.000Z";
const digest = "a".repeat(64);
const caller = { kind: "main-model" as const, conversation: { kind: "main" as const, session_id: "main" }, binding_generation: 1 };
function gate() { let resolve!: () => void; const promise = new Promise<void>(next => { resolve = next; }); return { promise, resolve }; }

async function fixture(t: test.TestContext, activationOrder?: number) {
  const mainRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-activation-")));
  await chmod(mainRoot, 0o700); await mkdir(join(mainRoot, "prepared"), { mode: 0o700 });
  t.after(() => rm(mainRoot, { recursive: true, force: true }));
  const profile: FrozenProfileV1 = { version: 1, settings_snapshot: {}, delegation_max_depth: 1,
    role: { name: "default", source: "built-in", provenance: "builtin", body: "role", sha256: digest },
    provider: "fixture", model: "faux-1", model_scope: ["fixture/faux-1"], reasoning_effort: "off", task_timeout_ms: 1_800_000,
    cwd: mainRoot, project_trusted: false, system_prompt_options_sha256: digest, prompt_assembler_version: 1,
    system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: digest,
    capabilities: { version: 1, fingerprint: digest, active_tools: [], tool_definitions: [], entries: [] }, created_at: at };
  let state: NormalizedStoreStateV1 = {
    root: { version: 1, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 3,
      next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [agentId],
      mailbox: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] },
    agents: [{ version: 1, host_revision: 1,
      agent: { version: 1, record_revision: 1, agent_id: agentId, parent_conversation: caller.conversation,
        task_name: "worker", task_path: "/root/worker", depth: 1, created_at: at, created_revision: 1, profile,
        lifecycle: "open", lifecycle_revision: 1, runtime_generation: 1, current_task_id: taskId, queued_task_ids: [],
        conversation: { session_id: "child", relative_path: `conversations/${agentId}/session.jsonl`, initial_bytes: 1,
          initial_sha256: digest, last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available",
        next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 },
      tasks: [{ version: 1, record_revision: 1, task_id: taskId, agent_id: agentId, origin: "initial", admission_order: 1,
        initiator: { kind: caller.kind, conversation: caller.conversation }, owner_conversation: caller.conversation, message: "work", phase: "waiting", admitted_at: at,
        started_at: at, deadline_at_ms: Date.parse(at) + 1_800_000, runtime_generation: 1,
        waiting_on: { kind: "process", key: digest }, ...(activationOrder === undefined ? {} : { activation_order: activationOrder }),
        lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: taskId, reason: "work" }, lease_disposition: "required" }],
      mailbox: [], completions: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [] }],
  };
  const host = new AgentHostCoreV1({ mainSessionId: "main", instanceGeneration: 1, bindingGeneration: 1, managerGeneration: 1,
    spawnPreparation: { async prepare() { throw new Error("unexpected spawn"); } },
    config: { maxDepth: 1, maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 },
    store: { mainRoot, snapshot: () => structuredClone(state), async commit(input) {
      state = applyJournalMutationsV1(state, state.root.host_revision + 1, input.mutations, input.operation);
      return { revision: state.root.host_revision, proof: "sync", transactionId: input.transactionId };
    } },
    leases: { async acquire() { throw new Error("unexpected lease"); } },
    runtime: { residency: () => ({ runtimeGeneration: 1, state: "active", executionReady: true }), async interrupt() {} },
    scheduler: { taskAdmitted() {} }, now: () => new Date(at),
  });
  const task = () => state.agents[0]!.tasks[0]!;
  const send = (index: number) => host.sendInput({ request_id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    caller, input: { target: "/root/worker", message: `note ${index}` } });
  const finish = (expectedActivationOrder: number | undefined, runtimeGeneration = 1) => host.finishWaitingActivation({ agentId, taskId, runtimeGeneration, expectedActivationOrder, at });
  return { host, mainRoot, task, send, finish };
}

test("waiting activation completion clears only its own order, including duplicate and stale callbacks", async t => {
  const f = await fixture(t, 2);
  assert.equal((await f.finish(2)).ok, true); assert.equal(f.task().activation_order, undefined);
  const revision = f.host.host_revision;
  assert.equal((await f.finish(2)).ok, true); assert.equal(f.host.host_revision, revision, "duplicate completion is a no-op");
  assert.equal((await f.send(1)).ok, true); const next = f.task().activation_order;
  assert.equal(next, 3);
  for (const previous of [undefined, 2]) {
    const revision = f.host.host_revision;
    assert.equal((await f.finish(previous)).ok, true);
    assert.equal(f.task().activation_order, next); assert.equal(f.host.host_revision, revision);
  }
  assert.equal((await f.finish(next, 2)).ok, false, "a stale runtime cannot complete the activation");
  assert.equal(f.task().activation_order, next);
  assert.equal((await f.finish(next)).ok, true); assert.equal(f.task().activation_order, undefined);
});

async function controller(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  let port!: ChildHostPort;
  const original = ChildSession.create;
  ChildSession.create = async input => {
    port = input.host;
    return { preflight: async () => {}, deliver: async () => {}, resumeFromCompletions: async () => {}, drain: async () => {},
      cancelProcessAdmission() {}, cancelTaskMail: async () => {}, dispose: async () => {}, session: { isCompacting: false },
      conversation: { appendMailboxMessages: async (items: any[]) => items.map(item => ({ messageId: item.messageId,
        bodySha256: item.bodySha256, entryId: "mailbox-entry", state: "injected", injectedInto: item.injectedInto })) } } as unknown as ChildSession;
  };
  const requested = gate(); const requests: number[] = [];
  const runtime = new SdkRuntimeControllerV1({ host: f.host, agentDir: f.mainRoot, skillPath: "skill", taskTimeoutMs: 1_800_000,
    settings: () => ({}), registry: () => ({}) as never,
    scheduler: { requestActive(input) { requests.push(input.admissionOrder); requested.resolve(); }, confirmRuntime() {}, releaseGrant() {} },
    reportOperationalError({ error }) { throw error; },
  });
  t.after(() => { runtime.deadlines.dispose(); ChildSession.create = original; });
  await runtime.start({ grantId: "grant-1", coordinatorGeneration: 1, agentId, taskId, runtimeGeneration: 1 });
  return { runtime, port, requests, requested };
}

test("old SDK settled snapshot cannot erase input admitted before its waiting completion commits", { timeout: 5_000 }, async t => {
  const f = await fixture(t), c = await controller(t, f);
  await c.port.recordProcessWait({ taskId, blocking: [{ leaseId: "process", generation: 1, logicalKey: "process" }] });
  assert.equal(f.task().phase, "waiting");
  const entered = gate(), release = gate(), finish = f.host.finishWaitingActivation.bind(f.host);
  f.host.finishWaitingActivation = async input => {
    assert.equal(input.expectedActivationOrder, undefined, "the original run owns no mailbox activation");
    entered.resolve(); await release.promise; return finish(input);
  };
  t.after(() => release.resolve());
  const settling = c.port.settled({ taskId, aborted: false, sessionFile: "" });
  await entered.promise;
  assert.equal((await f.send(2)).ok, true); const order = f.task().activation_order;
  assert.equal(order, 3);
  release.resolve(); await settling;
  assert.equal(f.task().activation_order, order, "old completion must preserve the new input's activation");
  await c.requested.promise;
  assert.deepEqual(c.requests, [order], "the preserved input still requests its own active grant");
  assert.equal(c.runtime.residency(agentId)?.state, "waiting");
});

test("SDK completion uses the grant's activation rather than a successor in its latest snapshot", { timeout: 5_000 }, async t => {
  const f = await fixture(t, 2), c = await controller(t, f);
  f.task().activation_order = 3;
  let expected: number | undefined;
  const finish = f.host.finishWaitingActivation.bind(f.host);
  f.host.finishWaitingActivation = async input => { expected = input.expectedActivationOrder; return finish(input); };
  await c.port.settled({ taskId, aborted: false, sessionFile: "" });
  assert.equal(expected, 2);
  assert.equal(f.task().activation_order, 3);
});
