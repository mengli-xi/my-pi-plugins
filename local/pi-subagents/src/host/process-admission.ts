import type { HostProcessWaitAdmissionV2, ProcessWaitAdmissionRequestV2 } from "../child/process-wait-admission.js";
import type { TaskRecordV1 } from "../persistence/types.js";

interface ProcessGrant { taskId: string; generation: number | undefined; resolve(value: "trigger" | "record-only"): void }

/** Shared bridge-v2 admission; each owner supplies only its execution/grant operations. */
export class ProcessAdmissionOwner {
  readonly ports: { task(): TaskRecordV1 | undefined; phase(): string; resume(): Promise<void>; requestGrant(): void };
  #decisions = new Map<string, { decision: "trigger" | "record-only"; taskId: string; generation: number | undefined }>();
  #pending = new Map<string, Promise<HostProcessWaitAdmissionV2>>();
  #consumed = false;
  #epoch = 0;
  #cancelled?: { taskId: string; generation: number };
  #grant?: ProcessGrant;
  constructor(ports: ProcessAdmissionOwner["ports"]) { this.ports = ports; }
  reset(_reason: string): void { this.#epoch++; this.#decisions.clear(); this.#pending.clear(); this.#consumed = false; this.#cancelled = undefined; this.#grant?.resolve("record-only"); this.#grant = undefined; }
  cancel(input: { taskId: string; runtimeGeneration: number }): void {
    const task = this.ports.task();
    if (task?.task_id !== input.taskId || task.runtime_generation !== input.runtimeGeneration) return;
    this.reset("Task admission cancelled"); this.#cancelled = { taskId: input.taskId, generation: input.runtimeGeneration };
  }
  beginWait(): void { this.#consumed = false; }
  get waitingForGrant(): boolean { return this.#grant !== undefined; }
  grant(input: { taskId: string; runtimeGeneration: number }): void {
    if (this.#grant?.taskId === input.taskId && this.#grant.generation === input.runtimeGeneration) { this.#consumed = true; this.#grant.resolve("trigger"); }
  }
  async admit(input: ProcessWaitAdmissionRequestV2): Promise<HostProcessWaitAdmissionV2> {
    const task = this.ports.task();
    if (!task || task.task_id !== input.taskId || task.phase === "settled" || task.finish_declaration || task.interrupt_requested_at
      || task.deadline_at_ms !== undefined && Date.now() >= task.deadline_at_ms
      || this.#cancelled?.taskId === task.task_id && this.#cancelled.generation === task.runtime_generation) return "record-only";
    const cached = this.#decisions.get(input.admissionId);
    if (cached) return cached.decision === "trigger" && (cached.taskId !== task.task_id || cached.generation !== task.runtime_generation
      || task.phase !== "running" || this.ports.phase() !== "running"
      || task.deadline_at_ms !== undefined && Date.now() >= task.deadline_at_ms) ? "record-only" : cached.decision;
    const existing = this.#pending.get(input.admissionId); if (existing) return existing;
    if (this.#decisions.size + this.#pending.size >= 1024) return "record-only";
    const epoch = this.#epoch;
    const request = (async (): Promise<HostProcessWaitAdmissionV2> => {
      const result = await this.admitCurrent(input, task), current = this.ports.task();
      if (epoch !== this.#epoch || !current || current.task_id !== task.task_id || current.runtime_generation !== task.runtime_generation
        || current.phase === "settled" || current.finish_declaration || current.interrupt_requested_at
        || current.deadline_at_ms !== undefined && Date.now() >= current.deadline_at_ms) return "record-only";
      if (result !== "pending") this.#decisions.set(input.admissionId, { decision: result, taskId: task.task_id, generation: task.runtime_generation });
      return result;
    })();
    this.#pending.set(input.admissionId, request);
    try { return await request; }
    finally { if (this.#pending.get(input.admissionId) === request) this.#pending.delete(input.admissionId); }
  }
  private async admitCurrent(input: ProcessWaitAdmissionRequestV2, task: TaskRecordV1): Promise<HostProcessWaitAdmissionV2> {
    if (this.#grant || !input.continuationSignal && input.childIdle || input.continuationSignal && this.#consumed) return "record-only";
    if (task.phase === "running" && this.ports.phase() === "running") {
      if (input.childIdle && !input.settledBoundary) return "pending";
      if (input.continuationSignal) this.#consumed = true;
      return "trigger";
    }
    if (task.phase !== "waiting" || task.waiting_on?.kind !== "process" || !input.continuationSignal) return "record-only";
    if (this.ports.phase() === "starting") return "pending";
    if (this.ports.phase() === "running") {
      if (!input.settledBoundary) return "pending";
      const epoch = this.#epoch;
      await this.ports.resume();
      if (epoch !== this.#epoch) return "record-only";
      this.#consumed = true; return "trigger";
    }
    if (this.ports.phase() !== "waiting") return "record-only";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grant: ProcessGrant | undefined;
    try {
      return await new Promise<"trigger" | "record-only">((resolve) => {
        grant = { taskId: task.task_id, generation: task.runtime_generation, resolve };
        this.#grant = grant;
        // SDK admission stays queued under this Task's authority, not a capacity timeout.
        // The child watchdog may defer only while this exact owner still confirms the queue.
        input.onQueued?.(() => {
          const current = this.ports.task();
          return this.#grant === grant && current?.task_id === task.task_id && current.runtime_generation === task.runtime_generation
            && current.phase === "waiting" && current.waiting_on?.kind === "process" && !current.finish_declaration && !current.interrupt_requested_at
            && (current.deadline_at_ms === undefined || Date.now() < current.deadline_at_ms);
        });
        if (task.deadline_at_ms !== undefined) {
          timer = setTimeout(() => resolve("record-only"), Math.max(0, task.deadline_at_ms - Date.now())); timer.unref?.();
        }
        this.ports.requestGrant();
      });
    } finally { if (timer) clearTimeout(timer); if (this.#grant === grant) this.#grant = undefined; }
  }
}
