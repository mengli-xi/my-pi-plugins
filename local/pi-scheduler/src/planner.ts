/**
 * Pure planner the daemon runs on each tick. Given the current tasks, which
 * sessions are occupied, how many executions are already in flight, and the
 * concurrency limit, it decides — deterministically — what to do with each
 * task right now. All I/O (spawning, writing records, sleeping) is the
 * daemon's job; this function only decides.
 *
 * Decisions encoded here:
 * - #3/#13 session-target defers while its session is occupied.
 * - #4/#5/#7 tolerance + coalesced catch-up via the schedule core.
 * - #18 concurrency limit (default 5); excess due tasks queue by scheduled time.
 */

import { evaluate, type ScheduleDecision } from "./schedule.ts";
import type { Task } from "./task.ts";

export interface PlanInputs {
  tasks: readonly Task[];
  /** Is this sessionId currently held by a live Pi? */
  isOccupied: (sessionId: string) => boolean;
  /** Task ids that already own a durable injection occurrence marker. */
  activeInjectionTaskIds?: ReadonlySet<string>;
  /** How many executions are already running. */
  running: number;
  /** Max concurrent executions (decision #18). */
  concurrency: number;
  now: number;
}

export interface DispatchPlan {
  task: Task;
  scheduledTime: number;
}

export interface SkipPlan {
  task: Task;
  scheduledTime: number;
  reason: "late-beyond-tolerance";
}

/** A due session occurrence that must be delivered by its live Pi holder. */
export interface InjectionPlan {
  task: Task;
  scheduledTime: number;
  staleAt: number;
}

/** For a task consumed with no further occurrences (one-shot done). */
export interface RetirePlan {
  task: Task;
}

export interface Plan {
  /** Tasks to execute now, ordered by scheduled time, capped by free slots. */
  dispatch: DispatchPlan[];
  /** Occurrences to stage for injection into their occupied live session. */
  inject: InjectionPlan[];
  /** Occurrences to record as skipped and advance past. */
  skip: SkipPlan[];
  /** One-shot tasks whose only occurrence is gone; mark done. */
  retire: RetirePlan[];
  /** Earliest future instant the daemon should wake for, if any. */
  wakeAt?: number;
}

interface DueCandidate {
  task: Task;
  scheduledTime: number;
}

/**
 * Decide the whole plan for this tick. `evaluate` yields run/skip/wait/done per
 * task; occupancy defers session targets; the concurrency limit then admits due
 * tasks in scheduled-time order and pushes the rest to the next wake.
 */
export function planTick(inputs: PlanInputs): Plan {
  const { tasks, isOccupied, running, concurrency, now } = inputs;
  const activeInjectionTaskIds = inputs.activeInjectionTaskIds ?? new Set<string>();
  const dueRun: DueCandidate[] = [];
  const inject: InjectionPlan[] = [];
  const skip: SkipPlan[] = [];
  const retire: RetirePlan[] = [];
  let wakeAt: number | undefined;

  const noteWake = (instant: number) => {
    if (wakeAt === undefined || instant < wakeAt) wakeAt = instant;
  };

  for (const task of tasks) {
    if (task.status !== "active") continue;
    // The marker owns this occurrence and its consumed watermark. Re-evaluating
    // it could stage a later recurring occurrence under the same task id.
    if (activeInjectionTaskIds.has(task.id)) continue;
    const decision: ScheduleDecision = evaluate(
      task.schedule,
      task.timeZone,
      task.toleranceMs,
      { lastScheduledTime: task.lastScheduledTime },
      now,
    );
    switch (decision.action) {
      case "run": {
        // A session target held by a live Pi gets a durable occurrence marker.
        // The daemon stages it before advancing the watermark; the extension
        // later proves one native injection instead of a second Pi process
        // writing the same session.
        if (task.target.kind === "session" && isOccupied(task.target.sessionId)) {
          const staleAt = decision.scheduledTime + task.toleranceMs;
          if (now > staleAt) {
            skip.push({ task, scheduledTime: decision.scheduledTime, reason: "late-beyond-tolerance" });
          } else {
            inject.push({ task, scheduledTime: decision.scheduledTime, staleAt });
          }
          break;
        }
        dueRun.push({ task, scheduledTime: decision.scheduledTime });
        break;
      }
      case "skip":
        skip.push({ task, scheduledTime: decision.scheduledTime, reason: decision.reason });
        break;
      case "wait":
        noteWake(decision.until);
        break;
      case "done":
        retire.push({ task });
        break;
    }
  }

  // Admit due tasks oldest-first, up to the free concurrency slots.
  dueRun.sort((a, b) => a.scheduledTime - b.scheduledTime);
  const free = Math.max(0, concurrency - running);
  const dispatch = dueRun.slice(0, free).map((c) => ({ task: c.task, scheduledTime: c.scheduledTime }));
  // Anything over the limit should be retried on the next tick, not lost.
  if (dueRun.length > free) noteWake(now + OVER_LIMIT_RECHECK_MS);

  return { dispatch, inject, skip, retire, wakeAt };
}

/** How soon to recheck an occupied session while waiting for it to free. */
export const OCCUPIED_RECHECK_MS = 15_000;
/** How soon to recheck when due tasks exceed the concurrency limit. */
export const OVER_LIMIT_RECHECK_MS = 5_000;
