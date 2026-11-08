import assert from "node:assert/strict";
import test from "node:test";
import type { AgentId, TaskId } from "../../src/domain/types.js";
import { SubagentRuntimeCoordinatorV1 } from "../../src/scheduler/coordinator.js";
import {
  createRuntimeCoordinatorCellV1,
  getOrCreateRuntimeCoordinatorCellV1,
} from "../../src/scheduler/global.js";
import type {
  HostTokenV1,
  SchedulerHostLimitsV1,
  SchedulerIdSourceV1,
  TaskStartRequestV1,
} from "../../src/scheduler/types.js";

const DEFAULT_HOST_LIMITS: SchedulerHostLimitsV1 = {
  activeTasksPerMain: 3,
};

function agent(index: number): AgentId {
  return `agt_${Buffer.alloc(16, index).toString("base64url")}` as AgentId;
}

function task(index: number): TaskId {
  return `tsk_${Buffer.alloc(16, index).toString("base64url")}` as TaskId;
}

class DeterministicIds implements SchedulerIdSourceV1 {
  binding = 0;
  grant = 0;
  next(kind: "binding" | "grant"): string {
    if (kind === "binding") return `binding-${++this.binding}`;
    return `grant-${++this.grant}`;
  }
}

function coordinator(input?: { active?: number; resident?: number }) {
  return new SubagentRuntimeCoordinatorV1({
    generation: 7,
    limits: {
      activeTasksPerProcess: input?.active ?? 3,
    },
    idSource: new DeterministicIds(),
  });
}

function register(
  scheduler: SubagentRuntimeCoordinatorV1,
  mainSessionId: string,
  generation = 1,
  limits: SchedulerHostLimitsV1 = DEFAULT_HOST_LIMITS,
): HostTokenV1 {
  return scheduler.registerHost({ version: 1, mainSessionId, hostGeneration: generation, limits });
}

function request(input: {
  token: HostTokenV1;
  number: number;
  agent?: AgentId;
  taskId?: TaskId;
  admissionOrder?: number;
  enqueuedAt?: number;
  needsResidency?: boolean;
}): TaskStartRequestV1 {
  return {
    version: 1,
    request_id: `request-${input.number}`,
    main_session_id: input.token.mainSessionId,
    host_generation: input.token.hostGeneration,
    agent_id: input.agent ?? agent(input.number),
    task_id: input.taskId ?? task(input.number),
    admission_order: input.admissionOrder ?? input.number,
    needs_residency: input.needsResidency ?? true,
    enqueued_at_ms: input.enqueuedAt ?? input.number,
  };
}

function grantEvents(scheduler: SubagentRuntimeCoordinatorV1, token: HostTokenV1) {
  return scheduler.drainEvents(token).filter((event) => event.type === "grant");
}

function confirmAndIdle(
  scheduler: SubagentRuntimeCoordinatorV1,
  token: HostTokenV1,
  grantId: string,
  runtimeGeneration: number,
  at: number,
): void {
  scheduler.confirmRuntime(token, { grantId, runtimeGeneration, atMonotonicMs: at });
  assert.equal(scheduler.releaseGrant(token, {
    grantId,
    coordinatorGeneration: 7,
    runtimeGeneration,
    nextResidency: "idle",
    atMonotonicMs: at,
  }), true);
}

test("historical view residency consumes no active slot and becomes control-pinned after runtime confirmation",()=>{const scheduler=coordinator({active:1,resident:1}),token=register(scheduler,"main-view",1,{activeTasksPerMain:1});const requested=scheduler.requestViewResidency(token,{agentId:agent(9),atMonotonicMs:1});assert.equal(requested.state,"granted");assert.equal(scheduler.snapshot().activeCount,0);assert.equal(scheduler.snapshot().residentCount,1);assert.equal(scheduler.snapshot().residents[0]?.runtimeGeneration,undefined);scheduler.confirmViewRuntime(token,{agentId:agent(9),runtimeGeneration:1,atMonotonicMs:2});assert.equal(scheduler.snapshot().activeCount,0);assert.equal(scheduler.snapshot().residents[0]?.state,"control-pinned");assert.equal(scheduler.snapshot().residents[0]?.runtimeGeneration,1);});

test("task start grants active and residency atomically and cancellation holds neither", () => {
  const scheduler = coordinator({ active: 1, resident: 1 });
  const first = register(scheduler, "main-a", 1, { activeTasksPerMain: 1});
  const second = register(scheduler, "main-b", 1, { activeTasksPerMain: 1});
  scheduler.enqueue(first, request({ token: first, number: 1 }));
  scheduler.enqueue(second, request({ token: second, number: 2 }));
  const firstGrant = grantEvents(scheduler, first)[0]!;
  assert.equal(firstGrant.grant.residency, "granted");
  assert.deepEqual(scheduler.snapshot(), {
    ...scheduler.snapshot(),
    activeCount: 1,
    residentCount: 1,
    queuedCount: 1,
  });
  assert.equal(scheduler.cancel(second, "request-2"), true);
  assert.equal(scheduler.snapshot().queuedCount, 0);
  assert.equal(scheduler.snapshot().activeCount, 1);
  assert.equal(scheduler.snapshot().residentCount, 1);
});

test("ten Hosts receive deterministic round-robin progress without foreground priority", () => {
  const scheduler = coordinator({ active: 3, resident: 12 });
  const hostLimits = { activeTasksPerMain: 3};
  const hosts = Array.from({ length: 10 }, (_, index) => register(scheduler, `main-${index}`, 1, hostLimits));
  for (let index = 0; index < 8; index++) scheduler.enqueue(hosts[0]!, request({ token: hosts[0]!, number: index + 1, enqueuedAt: 1 }));
  for (let index = 1; index < hosts.length; index++) scheduler.enqueue(hosts[index]!, request({ token: hosts[index]!, number: index + 20, enqueuedAt: index + 1 }));

  const order: string[] = [];
  for (let iteration = 0; iteration < 20; iteration++) {
    for (const host of hosts) {
      for (const event of grantEvents(scheduler, host)) {
        order.push(host.mainSessionId);
        scheduler.confirmRuntime(host, { grantId: event.grant.grant_id, runtimeGeneration: iteration * 20 + order.length, atMonotonicMs: 100 + order.length });
        scheduler.releaseGrant(host, { grantId: event.grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: iteration * 20 + order.length, nextResidency: "release-residency", atMonotonicMs: 100 + order.length });
      }
    }
    if (scheduler.snapshot().queuedCount === 0 && scheduler.snapshot().activeCount === 0) break;
  }
  assert.deepEqual(order.slice(0, 12), [
    "main-0", "main-0", "main-0",
    "main-1", "main-2", "main-3",
    "main-4", "main-5", "main-6",
    "main-7", "main-8", "main-9",
  ]);
  for (const host of hosts) assert.equal(order.includes(host.mainSessionId), true);
  assert.equal(scheduler.snapshot().queuedCount, 0);
});

test("one Agent preserves durable FIFO while another Agent can use the same Host capacity", () => {
  const scheduler = coordinator({ active: 2, resident: 3 });
  const host = register(scheduler, "main-a", 1, { activeTasksPerMain: 2});
  scheduler.enqueue(host, request({ token: host, number: 1, agent: agent(1), admissionOrder: 1 }));
  scheduler.enqueue(host, request({ token: host, number: 2, agent: agent(1), admissionOrder: 2, needsResidency: false }));
  scheduler.enqueue(host, request({ token: host, number: 3, agent: agent(3), admissionOrder: 3 }));
  const grants = grantEvents(scheduler, host);
  assert.equal(grants.length, 2);
  assert.deepEqual(grants.map((event) => event.grant.task_id), [task(1), task(3)]);
  assert.deepEqual(scheduler.snapshot().hosts[0]!.queuedRequestIds, ["request-2"]);
});

test("per-Main active cap skips a blocked Host without losing its ring position", () => {
  const scheduler = coordinator({ active: 2, resident: 4 });
  const limits = { activeTasksPerMain: 1};
  const a = register(scheduler, "main-a", 1, limits);
  const b = register(scheduler, "main-b", 1, limits);
  scheduler.enqueue(a, request({ token: a, number: 1, enqueuedAt: 1 }));
  scheduler.enqueue(a, request({ token: a, number: 2, enqueuedAt: 2 }));
  scheduler.enqueue(b, request({ token: b, number: 3, enqueuedAt: 3 }));
  assert.equal(grantEvents(scheduler, a).length, 1);
  assert.equal(grantEvents(scheduler, b).length, 1);
  assert.equal(scheduler.snapshot().hosts.find((host) => host.mainSessionId === "main-a")!.queuedRequestIds[0], "request-2");
});

test("waiting dependency resumes through active-only grant on the same runtime", () => {
  const scheduler = coordinator({ active: 1, resident: 2 });
  const limits = { activeTasksPerMain: 1};
  const a = register(scheduler, "main-a", 1, limits);
  const b = register(scheduler, "main-b", 1, limits);
  scheduler.enqueue(a, request({ token: a, number: 1 }));
  const waitingGrant = grantEvents(scheduler, a)[0]!;
  scheduler.confirmRuntime(a, { grantId: waitingGrant.grant.grant_id, runtimeGeneration: 11, atMonotonicMs: 10 });
  scheduler.releaseGrant(a, { grantId: waitingGrant.grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: 11, nextResidency: "waiting-pinned", atMonotonicMs: 10 });
  scheduler.enqueue(b, request({ token: b, number: 2 }));
  const busyGrant = grantEvents(scheduler, b)[0]!;
  scheduler.enqueue(a, request({ token: a, number: 3, agent: agent(1), taskId: task(1), needsResidency: false }));
  assert.equal(grantEvents(scheduler, a).length, 0);
  assert.equal(scheduler.snapshot().queuedCount, 1);
  scheduler.confirmRuntime(b, { grantId: busyGrant.grant.grant_id, runtimeGeneration: 22, atMonotonicMs: 20 });
  scheduler.releaseGrant(b, { grantId: busyGrant.grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: 22, nextResidency: "release-residency", atMonotonicMs: 21 });
  const resumed = grantEvents(scheduler, a)[0]!;
  assert.equal(resumed.grant.residency, "existing");
  assert.equal(scheduler.snapshot().residents.find((resident) => resident.agentId === agent(1))!.runtimeGeneration, 11);
  assert.equal(scheduler.snapshot().residentCount, 1);
});

test("waiting runtime cannot resume a different follow-up Task", () => {
  const scheduler = coordinator({ active: 1, resident: 1 });
  const host = register(scheduler, "main-a", 1, { activeTasksPerMain: 1});
  scheduler.enqueue(host, request({ token: host, number: 1 }));
  const first = grantEvents(scheduler, host)[0]!;
  scheduler.confirmRuntime(host, { grantId: first.grant.grant_id, runtimeGeneration: 10, atMonotonicMs: 10 });
  scheduler.releaseGrant(host, { grantId: first.grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: 10, nextResidency: "waiting-pinned", atMonotonicMs: 10 });
  scheduler.enqueue(host, request({ token: host, number: 2, agent: agent(1), needsResidency: false }));
  assert.equal(grantEvents(scheduler, host).length, 0);
  assert.equal(scheduler.snapshot().queuedCount, 1);
  assert.equal(scheduler.snapshot().residents[0]!.pinnedTaskId, task(1));
});

test("existing idle residency consumes only active capacity", () => {
  const scheduler = coordinator({ active: 1, resident: 1 });
  const host = register(scheduler, "main-a", 1, { activeTasksPerMain: 1});
  scheduler.enqueue(host, request({ token: host, number: 1 }));
  const first = grantEvents(scheduler, host)[0]!;
  confirmAndIdle(scheduler, host, first.grant.grant_id, 10, 10);
  scheduler.enqueue(host, request({ token: host, number: 2, agent: agent(1), needsResidency: false }));
  const second = grantEvents(scheduler, host)[0]!;
  assert.equal(second.grant.residency, "existing");
  assert.equal(scheduler.snapshot().residentCount, 1);
});

test("generation fencing rejects stale Host tokens and ignores stale grant/runtime releases", () => {
  const scheduler = coordinator({ active: 1, resident: 1 });
  const host = register(scheduler, "main-a", 2, { activeTasksPerMain: 1});
  scheduler.enqueue(host, request({ token: host, number: 1 }));
  const grant = grantEvents(scheduler, host)[0]!;
  scheduler.confirmRuntime(host, { grantId: grant.grant.grant_id, runtimeGeneration: 9, atMonotonicMs: 10 });
  assert.equal(scheduler.releaseGrant(host, { grantId: grant.grant.grant_id, coordinatorGeneration: 6, runtimeGeneration: 9, nextResidency: "idle", atMonotonicMs: 11 }), false);
  assert.equal(scheduler.releaseGrant(host, { grantId: grant.grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: 8, nextResidency: "idle", atMonotonicMs: 11 }), false);
  assert.equal(scheduler.touchResident(host, { agentId: agent(1), runtimeGeneration: 8, atMonotonicMs: 12 }), false);
  assert.equal(scheduler.snapshot().activeCount, 1);
  const stale = { ...host, bindingNonce: "old-binding" };
  assert.throws(() => scheduler.cancel(stale, "missing"), /stale Host token/);
});

test("reload reclaims the process-global holder without replacing coordinator state", () => {
  const ids = new DeterministicIds();
  const cell = createRuntimeCoordinatorCellV1();
  const first = cell.claim({ ownerGeneration: 1, processLimits: { activeTasksPerProcess: 2}, idSource: ids });
  const host = register(first.coordinator, "main-a", 1, { activeTasksPerMain: 2});
  first.coordinator.enqueue(host, request({ token: host, number: 1 }));
  assert.equal(first.coordinator.snapshot().activeCount, 1);
  const replacement = cell.claim({ ownerGeneration: 2, processLimits: { activeTasksPerProcess: 2} });
  assert.equal(replacement.coordinator, first.coordinator);
  assert.equal(replacement.coordinator.snapshot().activeCount, 1);
  first.release();
  assert.deepEqual(cell.snapshot(), { version: 1, coordinatorGeneration: 1, ownerGeneration: 2, ownerActive: true });
  replacement.release();
  assert.equal(cell.snapshot().ownerActive, false);
  assert.throws(() => cell.claim({ ownerGeneration: 2, processLimits: { activeTasksPerProcess: 2} }), /stale/);
});

test("process-global cell installation is order-independent and singleton", () => {
  const first = getOrCreateRuntimeCoordinatorCellV1();
  const second = getOrCreateRuntimeCoordinatorCellV1();
  assert.equal(first, second);
  assert.deepEqual(Object.keys(first).sort(), ["brand", "claim", "operationVersion", "snapshot", "version"]);
});

test("ten Main Hosts share one process cap regardless of their per-Main limits", () => {
  const scheduler = coordinator({ active: 3, resident: 6 });
  const hosts = Array.from({ length: 10 }, (_, index) => register(scheduler, `main-cap-${index}`, 1, DEFAULT_HOST_LIMITS));
  for (let index = 0; index < hosts.length; index++) scheduler.enqueue(hosts[index]!, request({ token: hosts[index]!, number: index + 30 }));
  assert.equal(scheduler.snapshot().activeCount, 3);
  assert.equal(scheduler.snapshot().residentCount, 3);
  assert.equal(scheduler.snapshot().queuedCount, 7);
});

test("Host unregister requires queues, grants and residents to be fully drained", () => {
  const scheduler = coordinator({ active: 1, resident: 1 });
  const host = register(scheduler, "main-a", 1, { activeTasksPerMain: 1});
  scheduler.enqueue(host, request({ token: host, number: 1 }));
  const first = grantEvents(scheduler, host)[0]!;
  assert.throws(() => scheduler.unregisterHost(host), /still owns scheduler authority/);
  scheduler.confirmRuntime(host, { grantId: first.grant.grant_id, runtimeGeneration: 10, atMonotonicMs: 10 });
  scheduler.releaseGrant(host, { grantId: first.grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: 10, nextResidency: "release-residency", atMonotonicMs: 11 });
  assert.doesNotThrow(() => scheduler.unregisterHost(host));
  assert.equal(scheduler.snapshot().hosts.length, 0);
});

test("snapshot and health DTOs are detached closed views", () => {
  const scheduler = coordinator({ active: 1, resident: 1 });
  const host = register(scheduler, "main-a", 1, { activeTasksPerMain: 1});
  scheduler.enqueue(host, request({ token: host, number: 1 }));
  const snapshot = scheduler.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.hosts), true);
  assert.equal(Object.isFrozen(snapshot.hosts[0]!.limits), true);
  assert.deepEqual(Object.keys(scheduler.health()).sort(), ["failedEvictions", "status", "version"]);
  assert.throws(() => { (snapshot.hosts as unknown as unknown[]).push({}); }, TypeError);
});

test("a queued spawn and follow-up admitted before residency exists share one runtime", () => {
  const scheduler = coordinator({ active: 1 });
  const token = register(scheduler, "main", 1, { activeTasksPerMain: 1});
  // 两条请求都在 Agent 还没有 runtime 时入队，因此都带 needs_residency=true。
  scheduler.enqueue(token, request({ token, number: 1, agent: agent(1), taskId: task(1), admissionOrder: 1, needsResidency: true }));
  scheduler.enqueue(token, request({ token, number: 2, agent: agent(1), taskId: task(2), admissionOrder: 2, needsResidency: true }));
  const first = scheduler.drainEvents(token).filter((event) => event.type === "grant");
  assert.equal(first.length, 1);
  const grant = (first[0] as { grant: { grant_id: string; task_id: string; residency: string } }).grant;
  assert.equal(grant.task_id, task(1));
  assert.equal(grant.residency, "granted");
  scheduler.confirmRuntime(token, { grantId: grant.grant_id, runtimeGeneration: 1, atMonotonicMs: 1 });
  scheduler.releaseGrant(token, { grantId: grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: 1, nextResidency: "idle", atMonotonicMs: 2 });
  const second = scheduler.drainEvents(token).filter((event) => event.type === "grant");
  assert.equal(second.length, 1);
  const followUp = (second[0] as { grant: { task_id: string; residency: string } }).grant;
  assert.equal(followUp.task_id, task(2));
  assert.equal(followUp.residency, "existing");
  const residents = scheduler.snapshot().residents.filter((item) => item.agentId === agent(1));
  assert.equal(residents.length, 1);
  assert.equal(residents[0]!.runtimeGeneration, 1);
});

test("a queued active-only request is re-granted with a fresh runtime after its resident disappears", () => {
  const scheduler = coordinator({ active: 1 });
  const token = register(scheduler, "main", 1, { activeTasksPerMain: 1});
  scheduler.enqueue(token, request({ token, number: 1, agent: agent(1), taskId: task(1), admissionOrder: 1, needsResidency: true }));
  const grant = (scheduler.drainEvents(token).find((event) => event.type === "grant") as { grant: { grant_id: string } }).grant;
  scheduler.confirmRuntime(token, { grantId: grant.grant_id, runtimeGeneration: 1, atMonotonicMs: 1 });
  // 结算时按「runtime 还在」入队下一条，之后 runtime 却被关掉了。
  scheduler.enqueue(token, request({ token, number: 2, agent: agent(1), taskId: task(2), admissionOrder: 2, needsResidency: false }));
  scheduler.releaseGrant(token, { grantId: grant.grant_id, coordinatorGeneration: 7, runtimeGeneration: 1, nextResidency: "release-residency", atMonotonicMs: 2 });
  const next = scheduler.drainEvents(token).filter((event) => event.type === "grant");
  assert.equal(next.length, 1);
  const followUp = (next[0] as { grant: { task_id: string; residency: string } }).grant;
  assert.equal(followUp.task_id, task(2));
  assert.equal(followUp.residency, "granted");
});

test("ten active grants queue the eleventh and a resumed wait joins the new FIFO order", () => {
 const scheduler=coordinator({active:10}),token=register(scheduler,"ten",1,{activeTasksPerMain:10});
 for(let n=1;n<=11;n++)scheduler.enqueue(token,request({token,number:n,agent:agent(n),taskId:task(n),admissionOrder:n}));
 assert.equal(scheduler.snapshot().activeCount,10);assert.equal(scheduler.snapshot().queuedCount,1);
 const grant=scheduler.drainEvents(token).find(e=>e.grant.agent_id===agent(1))!.grant;
 scheduler.confirmRuntime(token,{grantId:grant.grant_id,runtimeGeneration:1,atMonotonicMs:20});scheduler.releaseGrant(token,{grantId:grant.grant_id,coordinatorGeneration:7,runtimeGeneration:1,nextResidency:"waiting-pinned",atMonotonicMs:21});
 assert.equal(scheduler.snapshot().activeCount,10);assert.ok(scheduler.snapshot().grants.some(g=>g.taskId===task(11)));
 scheduler.enqueue(token,request({token,number:12,agent:agent(1),taskId:task(1),admissionOrder:12,needsResidency:false}));assert.equal(scheduler.snapshot().queuedCount,1);
});

test("cross-Main round-robin rechecks the global cap for every grant in one pass", () => {
  const c = coordinator({active:10}), a = register(c,"a",1,{activeTasksPerMain:10}), b = register(c,"b",1,{activeTasksPerMain:10}), d = register(c,"c",1,{activeTasksPerMain:10});
  for (let n=1;n<=10;n++) c.enqueue(a,request({token:a,number:n}));
  c.enqueue(a,request({token:a,number:11})); c.enqueue(b,request({token:b,number:12})); c.enqueue(d,request({token:d,number:13}));
  const release = () => { const grant = c.snapshot().grants.find(g=>g.mainSessionId==="a")!; c.releaseGrant(a,{grantId:grant.grantId,coordinatorGeneration:7,runtimeGeneration:1,nextResidency:"release-residency",atMonotonicMs:20}); };
  release(); assert.equal(c.snapshot().activeCount,10); assert.equal(c.snapshot().queuedCount,2);
  release(); assert.equal(c.snapshot().activeCount,10); assert.equal(c.snapshot().queuedCount,1);
  release(); assert.equal(c.snapshot().activeCount,10); assert.equal(c.snapshot().queuedCount,0);
});
