import assert from "node:assert/strict";
import test from "node:test";
import { ProcessAdmissionOwner } from "../../src/host/process-admission.ts";
test("cached trigger rechecks Task/generation/grant/final before replay without a second grant", async () => {
  let task: any = { task_id: "tsk_1", phase: "running", runtime_generation: 1 }, phase = "running", requests = 0;
  const admission = new ProcessAdmissionOwner({ task: () => task, phase: () => phase, resume: async () => {}, requestGrant: () => { requests++; } });
  const input = { admissionId: "batch", taskId: "tsk_1", childIdle: false, continuationSignal: true, settledBoundary: false };
  assert.equal(await admission.admit(input), "trigger");
  assert.equal(await admission.admit(input), "trigger"); assert.equal(requests, 0);
  phase = "waiting"; assert.equal(await admission.admit(input), "record-only");
  phase = "running"; task = { ...task, runtime_generation: 2 }; assert.equal(await admission.admit(input), "record-only");
  task = { ...task, runtime_generation: 1, finish_declaration: {} }; assert.equal(await admission.admit(input), "record-only");
  task = { task_id: "tsk_2", phase: "running", runtime_generation: 1 }; assert.equal(await admission.admit(input), "record-only");
});
test("Process completion during mailbox grant startup waits for its real settlement boundary", async () => {
  let task: any = { task_id: "tsk_1", phase: "waiting", waiting_on: { kind: "process", key: "wait" }, runtime_generation: 1 }, phase = "starting";
  let resumed = 0;
  const owner = new ProcessAdmissionOwner({ task: () => task, phase: () => phase, async resume() { resumed++; task = { ...task, phase: "running" }; }, requestGrant() { assert.fail("the mailbox grant already owns this execution"); } });
  const input = { admissionId: "batch", taskId: "tsk_1", childIdle: true, continuationSignal: true, settledBoundary: false };
  assert.equal(await owner.admit(input), "pending"); phase = "running";
  assert.equal(await owner.admit({ ...input, settledBoundary: true }), "trigger");
  assert.equal(await owner.admit({ ...input, settledBoundary: true }), "trigger"); assert.equal(resumed, 1);
});
