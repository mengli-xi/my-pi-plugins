import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcessWaitAdmissionV2 } from "../../src/child/process-wait-admission.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("early Process wait signal retries the same admission once at the settled boundary", async () => {
  const requests: any[] = [];
  const admission = new ChildProcessWaitAdmissionV2({
    currentTaskId: () => "tsk_demo",
    childIdle: () => true,
    async request(input) {
      requests.push(input);
      return input.settledBoundary ? "trigger" : "pending";
    },
    report(error) { throw error; },
  });
  const pending = admission.admit("batch-early", true);
  const replay = admission.admit("batch-early", true);
  assert.equal(replay, pending);
  assert.equal(await admission.admit("batch-other", true), "record-only");
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(await admission.beforeTaskSettlement("tsk_demo"), true);
  assert.equal(await pending, "trigger");
  assert.deepEqual(requests.map((item) => [item.admissionId, item.settledBoundary]), [["batch-early", false], ["batch-early", true]]);
  assert.equal(await admission.beforeTaskSettlement("tsk_demo"), false);
});

test("unrelated terminal and disposal cannot trigger a turn", async () => {
  let requests = 0;
  const admission = new ChildProcessWaitAdmissionV2({
    currentTaskId: () => "tsk_demo",
    childIdle: () => true,
    async request(input) { requests++; return input.continuationSignal ? "pending" : "record-only"; },
    report(error) { throw error; },
  });
  assert.equal(await admission.admit("batch-unrelated", false), "record-only");
  assert.equal(requests, 1);
  const pending = admission.admit("batch-dispose", true);
  await tick();
  admission.dispose();
  assert.equal(await pending, "record-only");
  assert.equal(await admission.beforeTaskSettlement("tsk_demo"), false);
});

test("an ordinary turn notification may steer only while the Task is active", async () => {
  let idle = false;
  const admission = new ChildProcessWaitAdmissionV2({
    currentTaskId: () => "tsk_demo",
    childIdle: () => idle,
    async request(input) { return input.childIdle ? "record-only" : "trigger"; },
    report(error) { throw error; },
  });
  assert.equal(await admission.admit("batch-active", false), "trigger");
  idle = true;
  assert.equal(await admission.admit("batch-idle", false), "record-only");
});

test("a Host admission that never answers cannot block Task settlement", async () => {
  const reports: unknown[] = [];
  const admission = new ChildProcessWaitAdmissionV2({
    currentTaskId: () => "tsk_demo",
    childIdle: () => true,
    async request(input) { if (input.settledBoundary) return await new Promise<never>(() => {}); return "pending"; },
    report(error) { reports.push(error); },
    settlementTimeoutMs: 20,
  });
  const pending = admission.admit("batch-timeout", true);
  await tick();
  assert.equal(await admission.beforeTaskSettlement("tsk_demo"), false);
  assert.equal(await pending, "record-only");
  assert.equal(reports.length, 1);
});
