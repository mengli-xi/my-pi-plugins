import { assertDomainId } from "../domain/ids.js";
import type {
  HostRegistrationV1,
  HostTokenV1,
  ReleaseGrantInputV1,
  ResidentStateV1,
  ResidentTransitionInputV1,
  SchedulerGrantEventV1,
  SchedulerGrantSnapshotV1,
  SchedulerHealthV1,
  SchedulerHostEventV1,
  SchedulerHostLimitsV1,
  SchedulerHostSnapshotV1,
  SchedulerIdSourceV1,
  SchedulerProcessLimitsV1,
  SchedulerResidentSnapshotV1,
  SchedulerSnapshotV1,
  TaskStartGrantV1,
  TaskStartRequestV1,
  ViewResidencyRequestResultV1,
} from "./types.js";

interface HostStateV1 {
  mainSessionId: string;
  hostGeneration: number;
  hostOrdinal: number;
  bindingNonce: string;
  limits: SchedulerHostLimitsV1;
  queue: TaskStartRequestV1[];
  events: SchedulerHostEventV1[];
  queueEnteredAtMs?: number;
}

interface GrantStateV1 extends SchedulerGrantSnapshotV1 {}

interface ResidentStateRecordV1 {
  mainSessionId: string;
  hostGeneration: number;
  hostOrdinal: number;
  agentId: string;
  runtimeGeneration?: number;
  pinnedTaskId?: string;
  state: ResidentStateV1;
  lastUsedMonotonicMs: number;
}

function safeInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) throw new Error(`${label} must be a bounded non-empty string`);
}

function validateProcessLimits(limits: SchedulerProcessLimitsV1): SchedulerProcessLimitsV1 {
  safeInteger(limits.activeTasksPerProcess, "activeTasksPerProcess", 1);
  if (limits.activeTasksPerProcess > 64) throw new Error("activeTasksPerProcess is invalid");
  return Object.freeze({ ...limits });
}
function validateHostLimits(limits: SchedulerHostLimitsV1, process: SchedulerProcessLimitsV1): SchedulerHostLimitsV1 {
  safeInteger(limits.activeTasksPerMain, "activeTasksPerMain", 1);
  if (limits.activeTasksPerMain > 32 || limits.activeTasksPerMain > process.activeTasksPerProcess) throw new Error("activeTasksPerMain is invalid");
  return Object.freeze({ ...limits });
}

function requestOrder(left: TaskStartRequestV1, right: TaskStartRequestV1): number {
  return left.admission_order - right.admission_order
    || left.agent_id.localeCompare(right.agent_id)
    || left.task_id.localeCompare(right.task_id)
    || left.request_id.localeCompare(right.request_id);
}

function residentKey(mainSessionId: string, agentId: string): string { return `${mainSessionId}\0${agentId}`; }

export class SubagentRuntimeCoordinatorV1 {
  readonly generation: number;
  readonly idSource: SchedulerIdSourceV1;
  #limits: SchedulerProcessLimitsV1;
  #nextHostOrdinal = 1;
  #hosts = new Map<string, HostStateV1>();
  #ring: string[] = [];
  #requests = new Map<string, string>();
  #grants = new Map<string, GrantStateV1>();
  #residents = new Map<string, ResidentStateRecordV1>();
  #scheduling = false;
  #capacityBlocked = false;

  constructor(input: { generation: number; limits: SchedulerProcessLimitsV1; idSource: SchedulerIdSourceV1 }) {
    safeInteger(input.generation, "coordinator generation", 1);
    this.generation = input.generation;
    this.#limits = validateProcessLimits(input.limits);
    this.idSource = input.idSource;
  }

  registerHost(registration: HostRegistrationV1): HostTokenV1 {
    if (registration.version !== 1) throw new Error("host registration version is invalid");
    nonEmpty(registration.mainSessionId, "mainSessionId");
    safeInteger(registration.hostGeneration, "hostGeneration", 1);
    if (this.#hosts.has(registration.mainSessionId)) throw new Error("Host is already registered");
    const bindingNonce = this.idSource.next("binding");
    nonEmpty(bindingNonce, "binding nonce");
    const host: HostStateV1 = {
      mainSessionId: registration.mainSessionId,
      hostGeneration: registration.hostGeneration,
      hostOrdinal: this.#nextHostOrdinal++,
      bindingNonce,
      limits: validateHostLimits(registration.limits, this.#limits),
      queue: [],
      events: [],
    };
    this.#hosts.set(host.mainSessionId, host);
    this.#schedule();
    return Object.freeze({ version: 1, mainSessionId: host.mainSessionId, hostGeneration: host.hostGeneration, hostOrdinal: host.hostOrdinal, bindingNonce, coordinatorGeneration: this.generation });
  }

  unregisterHost(token: HostTokenV1): void {
    const host = this.#host(token);
    if (host.queue.length > 0 || this.#hostGrants(host).length > 0 || this.#hostResidents(host).length > 0) throw new Error("Host still owns scheduler authority");
    this.#hosts.delete(host.mainSessionId);
    this.#ring = this.#ring.filter((main) => main !== host.mainSessionId);
  }

  updateProcessLimits(limits: SchedulerProcessLimitsV1): void {
    const next = validateProcessLimits(limits);
    this.#limits = next;
    this.#schedule();
  }

  updateHostLimits(token: HostTokenV1, limits: SchedulerHostLimitsV1): void {
    const host = this.#host(token);
    host.limits = validateHostLimits(limits, this.#limits);
    this.#schedule();
  }

  requestViewResidency(token:HostTokenV1,input:{agentId:string;atMonotonicMs:number}):ViewResidencyRequestResultV1{
    const host=this.#host(token);assertDomainId(input.agentId,"agt");safeInteger(input.atMonotonicMs,"atMonotonicMs");
    if(this.#resident(host.mainSessionId,input.agentId))return Object.freeze({state:"unavailable"});
    this.#residents.set(residentKey(host.mainSessionId,input.agentId),{mainSessionId:host.mainSessionId,hostGeneration:host.hostGeneration,hostOrdinal:host.hostOrdinal,agentId:input.agentId,state:"active",lastUsedMonotonicMs:input.atMonotonicMs});
    return Object.freeze({state:"granted",grant:Object.freeze({version:1,main_session_id:host.mainSessionId,agent_id:input.agentId,coordinator_generation:this.generation,residency:"granted"})});
  }

  confirmViewRuntime(token:HostTokenV1,input:{agentId:string;runtimeGeneration:number;atMonotonicMs:number}):void{const host=this.#host(token);assertDomainId(input.agentId,"agt");safeInteger(input.runtimeGeneration,"runtimeGeneration",1);safeInteger(input.atMonotonicMs,"atMonotonicMs");const resident=this.#resident(host.mainSessionId,input.agentId);if(!resident||resident.state!=="active"||resident.runtimeGeneration!==undefined||this.#grantsForAgent(host.mainSessionId,input.agentId))throw new Error("view residency is not awaiting runtime confirmation");resident.runtimeGeneration=input.runtimeGeneration;resident.state="control-pinned";resident.lastUsedMonotonicMs=input.atMonotonicMs;this.#schedule();}

  cancelViewResidency(token:HostTokenV1,input:{agentId:string}):boolean{const host=this.#host(token);assertDomainId(input.agentId,"agt");const key=residentKey(host.mainSessionId,input.agentId),resident=this.#residents.get(key);if(!resident||resident.runtimeGeneration!==undefined||this.#grantsForAgent(host.mainSessionId,input.agentId))return false;this.#residents.delete(key);this.#schedule();return true;}

  enqueue(token: HostTokenV1, request: TaskStartRequestV1): void {
    const host = this.#host(token);
    this.#validateRequest(host, request);
    if (this.#requests.has(request.request_id) || [...this.#grants.values()].some((grant) => grant.requestId === request.request_id)) throw new Error("scheduler request_id is duplicated");
    if (host.queue.some((candidate) => candidate.task_id === request.task_id)) throw new Error("Task already has scheduler authority");
    if ([...this.#grants.values()].some((grant) => grant.mainSessionId === request.main_session_id && grant.taskId === request.task_id)) throw new Error("Task already has scheduler authority");
    host.queue.push(Object.freeze({ ...request }));
    host.queue.sort(requestOrder);
    this.#requests.set(request.request_id, host.mainSessionId);
    this.#ensureRing(host, request.enqueued_at_ms);
    this.#schedule();
  }

  cancel(token: HostTokenV1, requestId: string): boolean {
    const host = this.#host(token);
    const index = host.queue.findIndex((request) => request.request_id === requestId);
    if (index < 0) return false;
    host.queue.splice(index, 1);
    this.#requests.delete(requestId);
    if (host.queue.length === 0) this.#removeFromRing(host);
    this.#schedule();
    return true;
  }

  registerIdleRuntime(token: HostTokenV1, input: { agentId: string; runtimeGeneration: number }): void {
    const host = this.#host(token); assertDomainId(input.agentId, "agt"); safeInteger(input.runtimeGeneration, "runtimeGeneration", 1);
    if (this.#resident(host.mainSessionId, input.agentId)) throw new Error("runtime already registered");
    this.#residents.set(residentKey(host.mainSessionId, input.agentId), { mainSessionId: host.mainSessionId, hostGeneration: host.hostGeneration, hostOrdinal: host.hostOrdinal, agentId: input.agentId, runtimeGeneration: input.runtimeGeneration, state: "idle", lastUsedMonotonicMs: 0 });
  }
  cancelAgentRequests(token: HostTokenV1, agentId: string): void {
    const host = this.#host(token);
    for (const request of [...host.queue]) if (request.agent_id === agentId) this.cancel(token, request.request_id);
  }

  drainEvents(token: HostTokenV1): readonly SchedulerHostEventV1[] {
    const host = this.#host(token);
    const events = host.events.map((event) => structuredClone(event));
    host.events.length = 0;
    return Object.freeze(events);
  }

  confirmRuntime(token: HostTokenV1, input: { grantId: string; runtimeGeneration: number; atMonotonicMs: number }): void {
    const host = this.#host(token);
    const grant = this.#grant(host, input.grantId);
    safeInteger(input.runtimeGeneration, "runtimeGeneration", 1);
    safeInteger(input.atMonotonicMs, "atMonotonicMs");
    const resident = this.#resident(host.mainSessionId, grant.agentId);
    if (!resident || resident.state !== "active" || resident.runtimeGeneration !== undefined) throw new Error("grant does not own an unconfirmed runtime");
    resident.runtimeGeneration = input.runtimeGeneration;
    resident.lastUsedMonotonicMs = input.atMonotonicMs;
  }

  releaseGrant(token: HostTokenV1, input: ReleaseGrantInputV1): boolean {
    const host = this.#host(token);
    if (input.coordinatorGeneration !== this.generation) return false;
    const grant = this.#grants.get(input.grantId);
    if (!grant || grant.mainSessionId !== host.mainSessionId || grant.hostGeneration !== host.hostGeneration) return false;
    const resident = this.#resident(host.mainSessionId, grant.agentId);
    if (!resident) throw new Error("active grant lost residency authority");
    safeInteger(input.atMonotonicMs, "atMonotonicMs");
    // runtime 从来没 confirm 过：它起不来了，grant 和 residency 只能一起丢，否则 slot 永久泄漏。
    if (resident.runtimeGeneration === undefined) {
      this.#grants.delete(grant.grantId);
      this.#residents.delete(residentKey(host.mainSessionId, resident.agentId));
      this.#schedule();
      return true;
    }
    if (resident.runtimeGeneration !== input.runtimeGeneration) return false;
    this.#grants.delete(grant.grantId);
    if (input.nextResidency === "release-residency") {
      this.#residents.delete(residentKey(host.mainSessionId, resident.agentId));
    } else {
      if (resident.runtimeGeneration === undefined) throw new Error("cannot retain an unconfirmed runtime");
      resident.state = input.nextResidency;
      resident.pinnedTaskId = input.nextResidency === "waiting-pinned" ? grant.taskId : undefined;
      resident.lastUsedMonotonicMs = input.atMonotonicMs;
    }
    this.#schedule();
    return true;
  }

  retireResident(token: HostTokenV1, input: { agentId: string; runtimeGeneration: number }): boolean { const host = this.#host(token); assertDomainId(input.agentId, "agt"); safeInteger(input.runtimeGeneration, "runtimeGeneration", 1); if (this.#grantsForAgent(host.mainSessionId, input.agentId)) return false; const key = residentKey(host.mainSessionId, input.agentId); const resident = this.#residents.get(key); if (!resident || resident.runtimeGeneration !== input.runtimeGeneration) return false; this.#residents.delete(key); this.#schedule(); return true; }

  transitionResident(token: HostTokenV1, input: ResidentTransitionInputV1): boolean {
    const host = this.#host(token);
    assertDomainId(input.agentId, "agt");
    safeInteger(input.runtimeGeneration, "runtimeGeneration", 1);
    safeInteger(input.atMonotonicMs, "atMonotonicMs");
    const resident = this.#resident(host.mainSessionId, input.agentId);
    if (!resident || resident.runtimeGeneration !== input.runtimeGeneration || resident.state === "active") return false;
    if (input.state === "waiting-pinned") {
      if (typeof input.pinnedTaskId !== "string") throw new Error("waiting-pinned requires pinnedTaskId");
      assertDomainId(input.pinnedTaskId, "tsk");
    } else if (input.pinnedTaskId !== undefined) throw new Error("pinnedTaskId is only valid for waiting-pinned");
    resident.state = input.state;
    resident.pinnedTaskId = input.pinnedTaskId;
    resident.lastUsedMonotonicMs = input.atMonotonicMs;
    this.#schedule();
    return true;
  }

  touchResident(token: HostTokenV1, input: { agentId: string; runtimeGeneration: number; atMonotonicMs: number }): boolean {
    const host = this.#host(token);
    assertDomainId(input.agentId, "agt");
    safeInteger(input.runtimeGeneration, "runtimeGeneration", 1);
    safeInteger(input.atMonotonicMs, "atMonotonicMs");
    const resident = this.#resident(host.mainSessionId, input.agentId);
    if (!resident || resident.runtimeGeneration !== input.runtimeGeneration) return false;
    if (input.atMonotonicMs < resident.lastUsedMonotonicMs) return false;
    resident.lastUsedMonotonicMs = input.atMonotonicMs;
    return true;
  }

  snapshot(): SchedulerSnapshotV1 {
    const hosts: SchedulerHostSnapshotV1[] = [...this.#hosts.values()].sort((left, right) => left.hostOrdinal - right.hostOrdinal).map((host) => Object.freeze({
      mainSessionId: host.mainSessionId,
      hostGeneration: host.hostGeneration,
      hostOrdinal: host.hostOrdinal,
      limits: Object.freeze({ ...host.limits }),
      queuedRequestIds: Object.freeze(host.queue.map((request) => request.request_id)),
      activeCount: this.#hostGrants(host).length,
      residentCount: this.#hostResidents(host).length,
      idleCount: this.#hostResidents(host).filter((resident) => resident.state === "idle").length,
      eventCount: host.events.length,
    }));
    const grants = [...this.#grants.values()].sort((left, right) => left.grantId.localeCompare(right.grantId)).map((grant) => Object.freeze({ ...grant }));
    const residents: SchedulerResidentSnapshotV1[] = [...this.#residents.values()].sort(this.#residentOrder).map((resident) => Object.freeze({ ...resident }));
    return Object.freeze({ version: 1, coordinatorGeneration: this.generation, limits: Object.freeze({ ...this.#limits }), activeCount: grants.length, residentCount: residents.length, queuedCount: hosts.reduce((sum, host) => sum + host.queuedRequestIds.length, 0), hosts: Object.freeze(hosts), grants: Object.freeze(grants), residents: Object.freeze(residents) });
  }

  health(): SchedulerHealthV1 { return Object.freeze({ version: 1, status: "healthy", failedEvictions: [] }); }

  #host(token: HostTokenV1): HostStateV1 {
    if (token.version !== 1 || token.coordinatorGeneration !== this.generation) throw new Error("stale coordinator token");
    const host = this.#hosts.get(token.mainSessionId);
    if (!host || host.hostGeneration !== token.hostGeneration || host.hostOrdinal !== token.hostOrdinal || host.bindingNonce !== token.bindingNonce) throw new Error("stale Host token");
    return host;
  }

  #grant(host: HostStateV1, grantId: string): GrantStateV1 {
    const grant = this.#grants.get(grantId);
    if (!grant || grant.mainSessionId !== host.mainSessionId || grant.hostGeneration !== host.hostGeneration) throw new Error("grant is not owned by Host");
    return grant;
  }

  #resident(mainSessionId: string, agentId: string): ResidentStateRecordV1 | undefined { return this.#residents.get(residentKey(mainSessionId, agentId)); }
  #hostGrants(host: HostStateV1): GrantStateV1[] { return [...this.#grants.values()].filter((grant) => grant.mainSessionId === host.mainSessionId); }
  #hostResidents(host: HostStateV1): ResidentStateRecordV1[] { return [...this.#residents.values()].filter((resident) => resident.mainSessionId === host.mainSessionId); }

  #validateRequest(host: HostStateV1, request: TaskStartRequestV1): void {
    if (request.version !== 1 || request.main_session_id !== host.mainSessionId || request.host_generation !== host.hostGeneration) throw new Error("scheduler request Host identity is invalid");
    nonEmpty(request.request_id, "request_id");
    assertDomainId(request.agent_id, "agt");
    assertDomainId(request.task_id, "tsk");
    safeInteger(request.admission_order, "admission_order", 1);
    safeInteger(request.enqueued_at_ms, "enqueued_at_ms");
    if (typeof request.needs_residency !== "boolean") throw new Error("needs_residency must be boolean");
    const resident = this.#resident(host.mainSessionId, request.agent_id);
  }

  #ensureRing(host: HostStateV1, enteredAt: number): void {
    if (this.#ring.includes(host.mainSessionId)) return;
    host.queueEnteredAtMs = enteredAt;
    this.#ring.push(host.mainSessionId);
    this.#ring.sort((leftKey, rightKey) => {
      const left = this.#hosts.get(leftKey)!;
      const right = this.#hosts.get(rightKey)!;
      return (left.queueEnteredAtMs ?? 0) - (right.queueEnteredAtMs ?? 0) || left.hostOrdinal - right.hostOrdinal;
    });
  }

  #removeFromRing(host: HostStateV1): void {
    this.#ring = this.#ring.filter((main) => main !== host.mainSessionId);
    host.queueEnteredAtMs = undefined;
  }

  #schedule(): void {
    if (this.#scheduling) return;
    this.#scheduling = true;
    try {
      while (this.#grants.size < this.#limits.activeTasksPerProcess && this.#ring.length > 0) {
        const pass = this.#ring.length;
        let granted = false;
        for (let index = 0; index < pass; index++) {
          if (this.#grants.size >= this.#limits.activeTasksPerProcess) break;
          const mainSessionId = this.#ring.shift()!;
          const host = this.#hosts.get(mainSessionId);
          if (!host || host.queue.length === 0) continue;
          const request = this.#nextEligible(host);
          if (!request || this.#hostGrants(host).length >= host.limits.activeTasksPerMain) {
            this.#ring.push(mainSessionId);
            continue;
          }
          if (!this.#canGrantResidency(host, request)) {
            this.#ring.push(mainSessionId);
            continue;
          }
          this.#grantRequest(host, request);
          granted = true;
          if (host.queue.length > 0) this.#ring.push(mainSessionId);
          else host.queueEnteredAtMs = undefined;
        }
        if (!granted) break;
      }
    } finally {
      this.#scheduling = false;
    }
  }

  #nextEligible(host: HostStateV1): TaskStartRequestV1 | undefined {
    return host.queue.find((request) => !this.#grantsForAgent(host.mainSessionId, request.agent_id));
  }

  #grantsForAgent(mainSessionId: string, agentId: string): boolean {
    return [...this.#grants.values()].some((grant) => grant.mainSessionId === mainSessionId && grant.agentId === agentId);
  }

  #canGrantResidency(host: HostStateV1, request: TaskStartRequestV1): boolean {
    const existing = this.#resident(host.mainSessionId, request.agent_id);
    return !existing || existing.state === "idle" || existing.state === "control-pinned"
      || existing.state === "waiting-pinned" && existing.pinnedTaskId === request.task_id;
  }

  #grantRequest(host: HostStateV1, request: TaskStartRequestV1): void {
    const requestIndex = host.queue.indexOf(request);
    if (requestIndex < 0) throw new Error("scheduler queue lost request");
    host.queue.splice(requestIndex, 1);
    this.#requests.delete(request.request_id);
    const grantId = this.idSource.next("grant");
    nonEmpty(grantId, "grant id");
    if (this.#grants.has(grantId)) throw new Error("grant id is duplicated");
    const residency = this.#resident(host.mainSessionId, request.agent_id) ? "existing" : "granted";
    if (residency === "granted") {
      this.#residents.set(residentKey(host.mainSessionId, request.agent_id), {
        mainSessionId: host.mainSessionId,
        hostGeneration: host.hostGeneration,
        hostOrdinal: host.hostOrdinal,
        agentId: request.agent_id,
        state: "active",
        lastUsedMonotonicMs: request.enqueued_at_ms,
      });
    } else {
      const resident = this.#resident(host.mainSessionId, request.agent_id)!;
      resident.state = "active";
      resident.pinnedTaskId = undefined;
    }
    const grant: GrantStateV1 = { grantId, mainSessionId: host.mainSessionId, hostGeneration: host.hostGeneration, agentId: request.agent_id, taskId: request.task_id, requestId: request.request_id, coordinatorGeneration: this.generation, residency };
    this.#grants.set(grantId, grant);
    const publicGrant: TaskStartGrantV1 = Object.freeze({ version: 1, grant_id: grantId, active: true, residency, main_session_id: host.mainSessionId, agent_id: request.agent_id, task_id: request.task_id, coordinator_generation: this.generation });
    const event: SchedulerGrantEventV1 = Object.freeze({ version: 1, type: "grant", requestId: request.request_id, hostGeneration: host.hostGeneration, grant: publicGrant });
    host.events.push(event);
  }

  #residentOrder(left: ResidentStateRecordV1, right: ResidentStateRecordV1): number {
    return left.lastUsedMonotonicMs - right.lastUsedMonotonicMs || left.hostOrdinal - right.hostOrdinal || left.agentId.localeCompare(right.agentId);
  }
}
