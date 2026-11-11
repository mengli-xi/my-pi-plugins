import type { AgentId, TaskId } from "../domain/types.js";
import type { AgentHostCoreV1 } from "./core.js";
type Identity = { agentId: AgentId; taskId: TaskId; runtimeGeneration: number };
/** Execution uses the durable Task deadline; timers only request its enforcement. */
export class TaskDeadlines {
  readonly host: AgentHostCoreV1;
  readonly expired: (identity: Identity) => Promise<void>;
  #timers = new Map<AgentId, { taskId: TaskId; timer: ReturnType<typeof setTimeout> }>();
  constructor(host: AgentHostCoreV1, expired: TaskDeadlines["expired"]) { this.host = host; this.expired = expired; }
  arm(identity: Identity): void {
    this.cancel(identity.agentId);
    const task = this.host.snapshot().agents.find(item => item.agent.agent_id === identity.agentId)?.tasks.find(item => item.task_id === identity.taskId);
    if (task?.deadline_at_ms === undefined || task.phase === "settled" || task.interrupt_requested_at) return;
    const now = this.host.options.now ?? (() => new Date());
    const timer = setTimeout(() => {
      if (this.#timers.get(identity.agentId)?.timer !== timer) return;
      void (async () => {
        const result = await this.host.requestTaskTimeout({ ...identity, at: now().toISOString() });
        // Keep ownership through the async Host check: cancel/re-arm may have
        // replaced this timer while its request was queued.
        if (this.#timers.get(identity.agentId)?.timer !== timer) return;
        this.#timers.delete(identity.agentId);
        if (result.ok) {
          if (result.value.interrupt) await this.expired(identity);
          // Timer time and wall time can differ by a millisecond (or a clock
          // adjustment). An early wake must recheck the original deadline.
          else this.arm(identity);
        } else if (result.error.code !== "stale-task") throw new Error(result.error.message);
      })().catch(error => {
        if (this.#timers.get(identity.agentId)?.timer === timer) this.#timers.delete(identity.agentId);
        this.host.options.reportOperationalError?.({ operation: "task-deadline", error });
      });
    }, Math.max(0, task.deadline_at_ms - now().getTime()));
    timer.unref?.(); this.#timers.set(identity.agentId, { taskId: identity.taskId, timer });
  }
  cancel(agentId: AgentId, taskId?: TaskId): void { const entry = this.#timers.get(agentId); if (!entry || taskId && taskId !== entry.taskId) return; clearTimeout(entry.timer); this.#timers.delete(agentId); }
  dispose(): void { for (const agentId of this.#timers.keys()) this.cancel(agentId); }
}
