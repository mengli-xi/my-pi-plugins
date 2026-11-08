import { randomUUID } from "node:crypto";
import type { AgentId, TaskId } from "../domain/types.js";
import type { SubagentRuntimeCoordinatorV1 } from "../scheduler/coordinator.js";
import type { HostTokenV1, SchedulerHostLimitsV1, TaskStartGrantV1 } from "../scheduler/types.js";
import type { HostSchedulerPortV1 } from "./types.js";
import type { RuntimeStartGrantV1 } from "../runtime/sdk-controller.js";

export interface SchedulerAdapterOptionsV1 { readonly coordinator: SubagentRuntimeCoordinatorV1; readonly mainSessionId: string; readonly hostGeneration: number; readonly limits: SchedulerHostLimitsV1; readonly onGrant: (grant: RuntimeStartGrantV1) => Promise<void>; readonly nowMonotonicMs?: () => number; readonly report?: (input: { operation: string; error: unknown }) => void; readonly initialRuntimeGenerations?: ReadonlyMap<string, number> }
export class SchedulerAdapterV1 implements HostSchedulerPortV1 {
  readonly options: SchedulerAdapterOptionsV1; readonly token: HostTokenV1; #pumping = false; #draining?: Promise<void>; #again = false; #closed = false; #paused = false; #runtimeGenerations = new Map<string, number>();
  constructor(options: SchedulerAdapterOptionsV1) { this.options = options; for (const [agentId, generation] of options.initialRuntimeGenerations ?? []) if (Number.isSafeInteger(generation) && generation > 0) this.#runtimeGenerations.set(agentId, generation); this.token = options.coordinator.registerHost({ version: 1, mainSessionId: options.mainSessionId, hostGeneration: options.hostGeneration, limits: options.limits }); }
  async requestViewResidency(agentId: AgentId, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ runtimeGeneration: number }> {
    if (this.#closed || options.signal?.aborted) throw new Error("scheduler adapter is closed or cancelled");
    const result = this.options.coordinator.requestViewResidency(this.token, { agentId, atMonotonicMs: this.now() });
    if (result.state !== "granted") throw new Error("stale-runtime: runtime is already open");
    const runtimeGeneration = (this.#runtimeGenerations.get(agentId) ?? 0) + 1;
    this.#runtimeGenerations.set(agentId, runtimeGeneration);
    return { runtimeGeneration };
  }
  cancelAgent(agentId: AgentId): void { this.options.coordinator.cancelAgentRequests(this.token, agentId); }
  registerIdleRuntime(input: { agentId: AgentId; runtimeGeneration: number }): void {
    this.#runtimeGenerations.set(input.agentId, input.runtimeGeneration);
    this.options.coordinator.registerIdleRuntime(this.token, input);
  }
  confirmViewRuntime(agentId:AgentId,runtimeGeneration:number):void{this.options.coordinator.confirmViewRuntime(this.token,{agentId,runtimeGeneration,atMonotonicMs:this.now()});this.pump();}
  pinResident(agentId:AgentId,runtimeGeneration:number):void{this.options.coordinator.transitionResident(this.token,{agentId,runtimeGeneration,state:"control-pinned",atMonotonicMs:this.now()});this.pump();}
  unpinResident(agentId:AgentId,runtimeGeneration:number):void{this.options.coordinator.transitionResident(this.token,{agentId,runtimeGeneration,state:"idle",atMonotonicMs:this.now()});this.pump();}
  cancelViewResidency(agentId:AgentId):void{this.options.coordinator.cancelViewResidency(this.token,{agentId});this.pump();}
  taskAdmitted(input: { readonly agentId: AgentId; readonly taskId: TaskId; readonly admissionOrder: number; readonly needsResidency: boolean }): void { if (this.#closed) throw new Error("scheduler adapter is closed"); this.options.coordinator.enqueue(this.token, { version: 1, request_id: randomUUID(), main_session_id: this.options.mainSessionId, host_generation: this.options.hostGeneration, agent_id: input.agentId, task_id: input.taskId, admission_order: input.admissionOrder, needs_residency: input.needsResidency, enqueued_at_ms: this.now() }); this.pump(); }
  requestActive(input:{readonly agentId:AgentId;readonly taskId:TaskId;readonly admissionOrder:number}):void{this.taskAdmitted({...input,needsResidency:false});}
  confirmRuntime(input: { readonly grantId: string; readonly runtimeGeneration: number }): void { this.options.coordinator.confirmRuntime(this.token, { grantId: input.grantId, runtimeGeneration: input.runtimeGeneration, atMonotonicMs: this.now() }); this.pump(); }
  retireResident(input: { readonly agentId: import("../domain/types.js").AgentId; readonly runtimeGeneration: number }): void { this.options.coordinator.retireResident(this.token, input); this.pump(); }
  transitionResident(input: { readonly agentId: import("../domain/types.js").AgentId; readonly runtimeGeneration: number; readonly state: "idle" | "control-pinned" | "waiting-pinned"; readonly pinnedTaskId?: import("../domain/types.js").TaskId }): void { this.options.coordinator.transitionResident(this.token, { agentId: input.agentId, runtimeGeneration: input.runtimeGeneration, state: input.state, ...(input.pinnedTaskId ? { pinnedTaskId: input.pinnedTaskId } : {}), atMonotonicMs: this.now() }); this.pump(); }
  releaseGrant(input: { readonly grantId: string; readonly coordinatorGeneration: number; readonly runtimeGeneration: number; readonly nextResidency: "idle" | "waiting-pinned" | "control-pinned" | "release-residency" }): void { this.options.coordinator.releaseGrant(this.token, { grantId: input.grantId, coordinatorGeneration: input.coordinatorGeneration, runtimeGeneration: input.runtimeGeneration, nextResidency: input.nextResidency, atMonotonicMs: this.now() }); this.pump(); }
  pause():void{this.#paused=true;}
  resume():void{if(this.#closed)return;this.#paused=false;this.pump();}
  async close(): Promise<void> { this.#closed = true; this.#paused=true; await this.#draining; await this.drain(); const snapshot = this.options.coordinator.snapshot(); const residents = snapshot.residents.filter((item) => item.mainSessionId === this.options.mainSessionId); if (residents.length || snapshot.grants.some((item) => item.mainSessionId === this.options.mainSessionId)) throw new Error("scheduler adapter still owns runtime authority"); this.options.coordinator.unregisterHost(this.token); }
  pump(): void { if (this.#closed||this.#paused) return; if (this.#pumping) { this.#again = true; return; } this.#pumping = true; const draining = Promise.resolve().then(() => this.drain()); this.#draining = draining; void draining.finally(() => { if (this.#draining === draining) this.#draining = undefined; }); }
  private async drain(): Promise<void> { try { while (true) { if(this.#paused&&!this.#closed)break;this.#again = false; const events = this.options.coordinator.drainEvents(this.token); if (events.length === 0) break; for (const event of events) { try { if (event.type === "grant") await this.handleGrant(event.grant);  } catch (error) { this.options.report?.({ operation: "scheduler-grant", error }); } } } } catch (error) { this.options.report?.({ operation: "scheduler-event", error }); } finally { this.#pumping = false; if (this.#again) this.pump(); } }
  private async handleGrant(grant: TaskStartGrantV1): Promise<void> { await this.options.onGrant({ grantId: grant.grant_id, coordinatorGeneration: grant.coordinator_generation, agentId: grant.agent_id as AgentId, taskId: grant.task_id as TaskId, runtimeGeneration: this.runtimeGeneration(grant), residency: grant.residency }); }
  private runtimeGeneration(grant: TaskStartGrantV1): number { const prior = this.#runtimeGenerations.get(grant.agent_id) ?? 0; const next = grant.residency === "existing" ? prior : prior + 1; if (next < 1) throw new Error("existing residency has no runtime generation"); this.#runtimeGenerations.set(grant.agent_id, next); return next; }
  private now(): number { const value = (this.options.nowMonotonicMs ?? (() => Math.floor(performance.now())))(); if (!Number.isSafeInteger(value) || value < 0) throw new Error("scheduler monotonic clock is invalid"); return value; }
}
