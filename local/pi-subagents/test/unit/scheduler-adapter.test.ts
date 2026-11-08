import assert from "node:assert/strict";
import test from "node:test";
import { SubagentRuntimeCoordinatorV1 } from "../../src/scheduler/coordinator.ts";
import { SchedulerAdapterV1 } from "../../src/host/scheduler-adapter.ts";
import { encodeDomainId } from "../../src/domain/ids.ts";
const agent = encodeDomainId("agt", Buffer.alloc(16, 1)); const task1 = encodeDomainId("tsk", Buffer.alloc(16, 2)); const task2 = encodeDomainId("tsk", Buffer.alloc(16, 3));
test("scheduler adapter preserves runtime generation for existing residency", async () => { let n = 0; const coordinator = new SubagentRuntimeCoordinatorV1({ generation: 1, limits: { activeTasksPerProcess: 1}, idSource: { next: (kind) => `${kind}-${++n}` } }); const grants: any[] = []; let adapter!: SchedulerAdapterV1; adapter = new SchedulerAdapterV1({ coordinator, mainSessionId: "main", hostGeneration: 1, limits: { activeTasksPerMain: 1}, onGrant: async (grant) => { grants.push(grant); }, nowMonotonicMs: () => n }); adapter.taskAdmitted({ agentId: agent, taskId: task1, admissionOrder: 1, needsResidency: true }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(grants.length, 1); assert.equal(grants[0].runtimeGeneration, 1); assert.equal(grants[0].residency, "granted"); adapter.confirmRuntime({ grantId: grants[0].grantId, runtimeGeneration: 1 }); adapter.releaseGrant({ grantId: grants[0].grantId, coordinatorGeneration: 1, runtimeGeneration: 1, nextResidency: "idle" }); adapter.taskAdmitted({ agentId: agent, taskId: task2, admissionOrder: 2, needsResidency: false }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(grants.length, 2); assert.equal(grants[1].runtimeGeneration, 1); assert.equal(grants[1].residency, "existing"); });

test("scheduler adapter requests an active-only grant for a waiting Task", async () => {
  let n = 0;
  const coordinator = new SubagentRuntimeCoordinatorV1({ generation: 1, limits: { activeTasksPerProcess: 1}, idSource: { next: (kind) => `${kind}-${++n}` } });
  const grants: any[] = [];
  const adapter = new SchedulerAdapterV1({ coordinator, mainSessionId: "main", hostGeneration: 1, limits: { activeTasksPerMain: 1}, onGrant: async (grant) => { grants.push(grant); }, nowMonotonicMs: () => n });
  adapter.taskAdmitted({ agentId: agent, taskId: task1, admissionOrder: 1, needsResidency: true });
  await new Promise((resolve) => setImmediate(resolve));
  adapter.confirmRuntime({ grantId: grants[0].grantId, runtimeGeneration: 1 });
  adapter.releaseGrant({ grantId: grants[0].grantId, coordinatorGeneration: 1, runtimeGeneration: 1, nextResidency: "waiting-pinned" });
  adapter.requestActive({ agentId: agent, taskId: task1, admissionOrder: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(grants.length, 2);
  assert.equal(grants[1].residency, "existing");
  assert.equal(grants[1].taskId, task1);
});

test("one failing grant cannot strand the rest of a drained batch or leak its slot", async () => {
  let n = 0;
  const agentA = encodeDomainId("agt", Buffer.alloc(16, 11)); const agentB = encodeDomainId("agt", Buffer.alloc(16, 12)); const agentC = encodeDomainId("agt", Buffer.alloc(16, 13));
  const taskA = encodeDomainId("tsk", Buffer.alloc(16, 21)); const taskB = encodeDomainId("tsk", Buffer.alloc(16, 22)); const taskC = encodeDomainId("tsk", Buffer.alloc(16, 23));
  const coordinator = new SubagentRuntimeCoordinatorV1({ generation: 1, limits: { activeTasksPerProcess: 3}, idSource: { next: (kind) => `${kind}-${++n}` } });
  const started: string[] = []; const reports: string[] = [];
  let adapter!: SchedulerAdapterV1;
  adapter = new SchedulerAdapterV1({
    coordinator, mainSessionId: "main", hostGeneration: 1, limits: { activeTasksPerMain: 3},
    onGrant: async (grant) => {
      if (grant.agentId === agentA) { adapter.releaseGrant({ grantId: grant.grantId, coordinatorGeneration: grant.coordinatorGeneration, runtimeGeneration: grant.runtimeGeneration, nextResidency: "release-residency" }); throw new Error("spawnRuntime failed"); }
      started.push(grant.taskId);
    },
    report: ({ operation, error }) => reports.push(`${operation}: ${(error as Error).message}`),
    nowMonotonicMs: () => n,
  });
  adapter.taskAdmitted({ agentId: agentA, taskId: taskA, admissionOrder: 1, needsResidency: true });
  adapter.taskAdmitted({ agentId: agentB, taskId: taskB, admissionOrder: 2, needsResidency: true });
  adapter.taskAdmitted({ agentId: agentC, taskId: taskC, admissionOrder: 3, needsResidency: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, [taskB, taskC]);
  assert.deepEqual(reports, ["scheduler-grant: spawnRuntime failed"]);
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.grants.some((item) => item.agentId === agentA), false);
  assert.equal(snapshot.residents.some((item) => item.agentId === agentA), false);
  assert.equal(snapshot.activeCount, 2);
});

test("runtime generations continue past the generations already persisted for an Agent", async () => {
  let n = 0;
  const coordinator = new SubagentRuntimeCoordinatorV1({ generation: 1, limits: { activeTasksPerProcess: 1}, idSource: { next: (kind) => `${kind}-${++n}` } });
  const grants: any[] = [];
  const adapter = new SchedulerAdapterV1({ coordinator, mainSessionId: "main", hostGeneration: 1, limits: { activeTasksPerMain: 1}, onGrant: async (grant) => { grants.push(grant); }, nowMonotonicMs: () => n, initialRuntimeGenerations: new Map([[agent, 4]]) });
  adapter.taskAdmitted({ agentId: agent, taskId: task1, admissionOrder: 1, needsResidency: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(grants.length, 1);
  assert.equal(grants[0].runtimeGeneration, 5);
});
