import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcessWaitAdmissionV2 } from "../../src/child/process-wait-admission.ts";
import { ProcessAdmissionOwner } from "../../src/host/process-admission.ts";

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(deadline?: number) {
  let task: any = { task_id: "tsk_1", phase: "waiting", waiting_on: { kind: "process", key: "wait" }, runtime_generation: 1,
    ...(deadline === undefined ? {} : { deadline_at_ms: deadline }) }, phase = "waiting", requests = 0;
  const reports: unknown[] = [];
  const owner = new ProcessAdmissionOwner({ task: () => task, phase: () => phase, resume: async () => {}, requestGrant() { requests++; } });
  const child = new ChildProcessWaitAdmissionV2({ currentTaskId: () => task.task_id, childIdle: () => true,
    request: input => owner.admit(input), report: error => reports.push(error) });
  return { owner, child, reports, get requests() { return requests; }, get task() { return task; },
    replace(value: any) { task = value; phase = "waiting"; },
    grant() { task = { ...task, phase: "running" }; phase = "running"; owner.grant({ taskId: task.task_id, runtimeGeneration: task.runtime_generation }); } };
}

test("a confirmed Process capacity queue survives both the 30s and 60s boundaries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = fixture(), pending = f.child.admit("batch", true), settled = f.child.beforeTaskSettlement("tsk_1");
  let answered = false; void pending.then(() => { answered = true; });
  t.mock.timers.tick(30_001); await tick();
  assert.equal(answered, false); assert.equal(f.owner.waitingForGrant, true);
  t.mock.timers.tick(60_001); await tick();
  assert.equal(answered, false); assert.equal(f.owner.waitingForGrant, true);
  assert.equal(f.child.admit("batch", true), pending); assert.equal(f.requests, 1); assert.deepEqual(f.reports, []);
  f.grant();
  assert.equal(await pending, "trigger"); assert.equal(await settled, true);
});

test("Task deadline ends the queue without waiting for a capacity grant", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = fixture(90_000), pending = f.child.admit("batch-deadline", true), settled = f.child.beforeTaskSettlement("tsk_1");
  t.mock.timers.tick(60_001); await tick();
  assert.equal(f.owner.waitingForGrant, true);
  t.mock.timers.tick(30_000); await tick();
  assert.equal(await pending, "record-only"); assert.equal(await settled, false); assert.equal(f.owner.waitingForGrant, false);
  f.grant();
  assert.equal(await f.child.admit("batch-deadline", true), "record-only");
});

test("the settled watchdog still releases a genuinely unresponsive Host after 60s", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const reports: unknown[] = [];
  const child = new ChildProcessWaitAdmissionV2({ currentTaskId: () => "tsk_1", childIdle: () => true,
    request: async () => new Promise<never>(() => {}), report: error => reports.push(error) });
  const pending = child.admit("batch-unanswered", true), settled = child.beforeTaskSettlement("tsk_1");
  t.mock.timers.tick(60_001); await tick();
  assert.equal(await pending, "record-only"); assert.equal(await settled, false); assert.equal(reports.length, 1);
});

test("a stale queue confirmation does not disable the unresponsive Host watchdog", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let current = true;
  const reports: unknown[] = [];
  const child = new ChildProcessWaitAdmissionV2({ currentTaskId: () => "tsk_1", childIdle: () => true,
    request: async input => { input.onQueued?.(() => current); return new Promise<never>(() => {}); }, report: error => reports.push(error) });
  const pending = child.admit("batch-stale-owner", true), settled = child.beforeTaskSettlement("tsk_1");
  t.mock.timers.tick(60_001); await tick(); assert.deepEqual(reports, []);
  current = false; t.mock.timers.tick(60_001); await tick();
  assert.equal(await pending, "record-only"); assert.equal(await settled, false); assert.equal(reports.length, 1);
});

test("a late resume callback cannot consume the successor Task's continuation", async () => {
  let task: any = { task_id: "tsk_old", runtime_generation: 1, phase: "waiting", waiting_on: { kind: "process", key: "wait" } };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = new ProcessAdmissionOwner({ task: () => task, phase: () => "running", resume: () => gate, requestGrant() { assert.fail("already active"); } });
  const input = { admissionId: "reused-batch", taskId: "tsk_old", childIdle: true, continuationSignal: true, settledBoundary: true };
  const old = owner.admit(input), duplicate = owner.admit(input);
  owner.cancel({ taskId: "tsk_old", runtimeGeneration: 1 }); owner.reset("New Task");
  task = { task_id: "tsk_next", runtime_generation: 1, phase: "running" };
  release();
  assert.equal(await old, "record-only"); assert.equal(await duplicate, "record-only");
  assert.equal(await owner.admit({ ...input, taskId: "tsk_next" }), "trigger");
});

test("fenced cancellation and late grant cannot clear the successor admission", async () => {
  const f = fixture(), pending = f.child.admit("batch-old", true), settled = f.child.beforeTaskSettlement("tsk_1");
  f.owner.cancel({ taskId: "tsk_1", runtimeGeneration: 2 });
  assert.equal(f.owner.waitingForGrant, true);
  f.owner.cancel({ taskId: "tsk_1", runtimeGeneration: 1 }); f.child.cancel("tsk_1");
  f.replace({ ...f.task, task_id: "tsk_2" }); f.owner.reset("New Task");
  const next = f.child.admit("batch-next", true), nextSettled = f.child.beforeTaskSettlement("tsk_2");
  f.owner.grant({ taskId: "tsk_1", runtimeGeneration: 1 });
  await tick();
  assert.equal(await pending, "record-only"); assert.equal(await settled, false);
  assert.equal(f.owner.waitingForGrant, true, "old finally must not clear the successor grant waiter");
  assert.equal(f.child.admit("batch-next", true), next, "old callback must not clear the successor child waiter");
  f.owner.cancel({ taskId: "tsk_1", runtimeGeneration: 1 }); f.child.cancel("tsk_1");
  assert.equal(f.owner.waitingForGrant, true);
  f.grant(); assert.equal(await next, "trigger"); assert.equal(await nextSettled, true);
});
