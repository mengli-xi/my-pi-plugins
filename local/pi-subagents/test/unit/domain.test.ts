import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateUniqueDomainId,
  assertDomainId,
  encodeDomainId,
  generateDomainId,
  isDomainId,
  isMainKey,
  mainKey,
} from "../../src/domain/ids.js";
import {
  resolveAgentTarget,
  taskPath,
  validateCanonicalTaskPath,
  validateTaskName,
} from "../../src/domain/paths.js";
import { assertTaskState, deriveAgentState, reduceTask } from "../../src/domain/state-machine.js";
import type { AgentId, AgentTreeNode, TaskState } from "../../src/domain/types.js";

const a1 = "agt_AAAAAAAAAAAAAAAAAAAAAA" as AgentId;
const a2 = "agt_BBBBBBBBBBBBBBBBBBBBBB" as AgentId;
const a3 = "agt_CCCCCCCCCCCCCCCCCCCCCC" as AgentId;
const tree: AgentTreeNode[] = [
  { agentId: a1, taskName: "review", taskPath: "/root/review", depth: 1 },
  { agentId: a2, taskName: "tests", taskPath: "/root/tests", depth: 1 },
  { agentId: a3, taskName: "schema", taskPath: "/root/review/schema", depth: 2, parentAgentId: a1 },
];

function admitted(): TaskState {
  return {
    taskId: "tsk_DDDDDDDDDDDDDDDDDDDDDD",
    phase: "admitted",
    admittedAt: "2026-08-17T00:00:00.000Z",
    leaseDisposition: "required",
  };
}

test("domain ids encode exact 128-bit base64url and validate every prefix", () => {
  const zero = encodeDomainId("agt", new Uint8Array(16));
  assert.equal(zero, "agt_AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(isDomainId(zero, "agt"), true);
  assert.equal(isDomainId(zero, "tsk"), false);
  assert.equal(isDomainId("agt_AAAAAAAAAAAAAAAAAAAAA="), false);
  assert.throws(() => encodeDomainId("tsk", new Uint8Array(15)), /128 bits/);
  assert.doesNotThrow(() => assertDomainId(generateDomainId("tsk"), "tsk"));
});

test("unique allocation retries eight collisions and then fails closed", () => {
  let calls = 0;
  const bytes = new Uint8Array(16);
  const candidate = encodeDomainId("msg", bytes);
  const allocated = allocateUniqueDomainId(
    "msg",
    (value) => value === candidate && calls++ < 2,
    () => bytes,
  );
  assert.equal(allocated, candidate);
  assert.equal(calls, 3);
  assert.throws(
    () => allocateUniqueDomainId("msg", () => true, () => bytes),
    /id-generation-failed/,
  );
});

test("main keys are deterministic, scoped, and grammar-bound", () => {
  const first = mainKey("main-session-a");
  assert.equal(first, mainKey("main-session-a"));
  assert.notEqual(first, mainKey("main-session-b"));
  assert.equal(isMainKey(first), true);
  assert.equal(first.length, 37);
  assert.throws(() => mainKey(""), /non-empty/);
});

test("task names and canonical paths enforce grammar, NFC, depth, and root policy", () => {
  assert.equal(validateTaskName("review_auth-2.0"), "review_auth-2.0");
  assert.equal(taskPath("/root", "review"), "/root/review");
  assert.equal(taskPath("/root/review", "schema"), "/root/review/schema");
  assert.equal(validateCanonicalTaskPath("/root/review/schema"), "/root/review/schema");
  assert.throws(() => validateTaskName("bad/name"), /match/);
  assert.throws(() => validateTaskName("e\u0301"), /NFC/);
  assert.throws(() => validateCanonicalTaskPath("/root"), /root is not an agent/);
  assert.throws(() => taskPath("/root/review/schema", "too-deep"), /depth/);
});

test("target resolution follows id, absolute path, relative path, root, and direct-child authority", () => {
  assert.equal(resolveAgentTarget(a3, { kind: "main" }, tree).kind, "agent");
  assert.equal(resolveAgentTarget("/root/tests", { kind: "main" }, tree).kind, "agent");
  assert.deepEqual(resolveAgentTarget("schema", { kind: "agent", agentId: a1 }, tree), {
    kind: "agent",
    agent: tree[2],
  });
  assert.deepEqual(resolveAgentTarget("root", { kind: "agent", agentId: a1 }, tree, { allowRoot: true }), {
    kind: "main",
    taskPath: "/root",
  });
  assert.throws(
    () => resolveAgentTarget("schema", { kind: "main" }, tree),
    /not-found/,
  );
  assert.throws(
    () => resolveAgentTarget("/root/tests", { kind: "agent", agentId: a1 }, tree, { directChildOnly: true }),
    /target-not-child/,
  );
  assert.equal(
    resolveAgentTarget("/root/review", { kind: "main" }, tree, { directChildOnly: true }).kind,
    "agent",
  );
  assert.throws(() => resolveAgentTarget("/root", { kind: "main" }, tree), /target-root/);
  assert.throws(() => resolveAgentTarget("../tests", { kind: "agent", agentId: a1 }, tree), /not-found/);
});

test("ambiguous duplicate paths fail closed while duplicate ids invalidate the tree", () => {
  const duplicatePath: AgentTreeNode = {
    agentId: "agt_EEEEEEEEEEEEEEEEEEEEEE",
    taskName: "review",
    taskPath: "/root/review",
    depth: 1,
  };
  assert.throws(
    () => resolveAgentTarget("/root/review", { kind: "main" }, [...tree, duplicatePath]),
    /ambiguous/,
  );
  assert.throws(
    () => resolveAgentTarget(a1, { kind: "main" }, [...tree, { ...duplicatePath, agentId: a1 }]),
    /duplicate agent id/,
  );
});

test("task reducer preserves start/deadline/generation across waiting and uses first settlement", () => {
  const start = reduceTask(admitted(), {
    type: "start",
    startedAt: "2026-08-17T00:00:01.000Z",
    deadlineAtMs: 10_000,
    runtimeGeneration: 1,
  });
  assert.equal(start.changed, true);
  const running = reduceTask(start.state, { type: "begin-running", runtimeGeneration: 1 });
  const waiting = reduceTask(running.state, {
    type: "begin-wait",
    runtimeGeneration: 1,
    waitingOn: { kind: "agent-barrier", key: "bar_1" },
  });
  assert.equal(waiting.state.phase, "waiting");
  assert.equal(waiting.state.deadlineAtMs, 10_000);
  const resumed = reduceTask(waiting.state, { type: "dependency-ready", runtimeGeneration: 1 });
  assert.equal(resumed.state.phase, "running");
  assert.equal(resumed.state.waitingOn, undefined);
  const settled = reduceTask(resumed.state, {
    type: "settle",
    runtimeGeneration: 1,
    settledAt: "2026-08-17T00:00:02.000Z",
    outcome: "completed",
    reason: "normal-final",
    completionId: "cmp_FFFFFFFFFFFFFFFFFFFFFF",
  });
  assert.equal(settled.state.phase, "settled");
  assert.equal(settled.state.leaseDisposition, "release-pending");
  assert.equal(
    reduceTask(settled.state, {
      type: "settle",
      runtimeGeneration: 1,
      settledAt: "2026-08-17T00:00:03.000Z",
      outcome: "failed",
      reason: "timeout",
      completionId: "cmp_GGGGGGGGGGGGGGGGGGGGGG",
    }).stale,
    true,
  );
  assert.equal(reduceTask(settled.state, { type: "mark-lease-released" }).state.leaseDisposition, "released");
});

test("stale generation and duplicate interrupt events cannot mutate a current task", () => {
  const start = reduceTask(admitted(), {
    type: "start",
    startedAt: "2026-08-17T00:00:01.000Z",
    deadlineAtMs: 10_000,
    runtimeGeneration: 2,
  }).state;
  assert.equal(reduceTask(start, { type: "begin-running", runtimeGeneration: 1 }).stale, true);
  const interrupted = reduceTask(start, {
    type: "request-interrupt",
    runtimeGeneration: 2,
    requestedAt: "2026-08-17T00:00:01.500Z",
  });
  assert.equal(interrupted.changed, true);
  assert.equal(
    reduceTask(interrupted.state, {
      type: "request-interrupt",
      runtimeGeneration: 2,
      requestedAt: "2026-08-17T00:00:01.600Z",
    }).stale,
    true,
  );
});

test("task invariants and agent state derivation keep availability, phase, and residency separate", () => {
  assert.doesNotThrow(() => assertTaskState(admitted()));
  assert.throws(
    () => assertTaskState({ ...admitted(), phase: "waiting" }),
    /requires start/,
  );
  assert.equal(deriveAgentState({ available: false, queuedTasks: 3, residency: "resident" }), "unavailable");
  assert.equal(deriveAgentState({ available: true, queuedTasks: 1, residency: "unloaded" }), "queued");
  assert.equal(
    deriveAgentState({ available: true, currentTask: { phase: "running" }, queuedTasks: 2, residency: "resident" }),
    "running",
  );
  assert.equal(
    deriveAgentState({ available: true, currentTask: { phase: "waiting" }, queuedTasks: 0, residency: "resident" }),
    "waiting",
  );
  assert.throws(
    () => deriveAgentState({ available: true, currentTask: { phase: "waiting" }, queuedTasks: 0, residency: "unloaded" }),
    /must remain resident/,
  );
  assert.equal(deriveAgentState({ available: true, queuedTasks: 0, residency: "unloaded" }), "idle");
});
