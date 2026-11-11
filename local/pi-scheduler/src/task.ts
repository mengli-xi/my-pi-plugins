/**
 * Task and run-record domain types shared by the daemon, IPC, and extension.
 *
 * Decisions encoded here (docs/design.md):
 * - #1/#21/#22 two target kinds, both freezing only a prompt.
 * - #9 agent target freezes cwd/provider/model/thinking at creation.
 * - #23/#24 structured schedule + stored IANA zone.
 * - #6 per-task tolerance.
 */

import type { Schedule } from "./schedule.ts";

export type TaskTargetKind = "agent" | "session";

/** Isolated Agent: a fresh session per run with frozen config. */
export interface AgentTarget {
  kind: "agent";
  cwd: string;
  provider: string;
  model: string;
  thinking?: string;
}

/** Deliver the prompt into a specific Pi session when it is idle. */
export interface SessionTarget {
  kind: "session";
  sessionId: string;
  /**
   * The project directory the session belongs to, frozen at creation. Pi
   * namespaces sessions by cwd: resuming `--session <id>` from a different
   * directory triggers a "session found in different project" fork prompt,
   * which under `--print` silently declines and appends nothing. The daemon
   * must therefore spawn the resume from the session's own cwd (decision #10:
   * a session target reuses that session's cwd).
   */
  cwd: string;
  /** Session storage directory, when the session lives outside the default. */
  sessionDir?: string;
}

export type TaskTarget = AgentTarget | SessionTarget;

export type TaskStatus = "active" | "paused" | "done";

export interface Task {
  id: string;
  /** Human-facing label; agent-derived from the request. */
  title: string;
  /** The frozen, self-contained instruction executed at each occurrence. */
  prompt: string;
  schedule: Schedule;
  /** IANA zone the schedule's wall-clock fields are interpreted in. */
  timeZone: string;
  /** Max lateness (ms) an occurrence may run after its scheduled time. */
  toleranceMs: number;
  target: TaskTarget;
  status: TaskStatus;
  createdAt: number;
  /** Latest scheduled occurrence already dispatched (run or skipped). */
  lastScheduledTime?: number;
  /** Who created it, for the visible list. */
  origin: "agent" | "user";
  /** Session that created it, when known (audit only, not an execution target). */
  createdInSession?: string;
}

/** Legacy `delivered` proved append only. New mailbox-fulfilled records prove a successful request opportunity. */
export type RunOutcome = "success" | "failure" | "skipped" | "delivered";

export interface RunRecord {
  taskId: string;
  scheduledTime: number;
  /** When execution actually started; absent for skips. */
  startedAt?: number;
  finishedAt: number;
  outcome: RunOutcome;
  /** Skip/failure detail, e.g. "late-beyond-tolerance" or an error message. */
  detail?: string;
  target: TaskTargetKind;
  /** Stable occurrence identity for a live-session injection. */
  injectionId?: string;
  /** Whether the operator has seen this in a Pi surface yet. */
  acknowledged?: boolean;
}

export interface RetentionPolicy {
  /** Keep at most this many records per task. */
  maxPerTask: number;
  /** Drop records older than this many ms. */
  maxAgeMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxPerTask: 50,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Apply retention to one task's records (newest-first output). Records are
 * dropped when older than maxAgeMs OR beyond the maxPerTask cap, whichever
 * removes more. Unacknowledged failures are never dropped by age alone, so an
 * operator who was away longer than the window still sees they failed.
 */
export function applyRetention(
  records: readonly RunRecord[],
  policy: RetentionPolicy,
  now: number,
): RunRecord[] {
  const sorted = [...records].sort((a, b) => b.finishedAt - a.finishedAt);
  const kept: RunRecord[] = [];
  for (const record of sorted) {
    const tooOld = now - record.finishedAt > policy.maxAgeMs;
    const unreadFailure = record.outcome === "failure" && !record.acknowledged;
    if (tooOld && !unreadFailure) continue;
    if (kept.length >= policy.maxPerTask && !unreadFailure) continue;
    kept.push(record);
  }
  return kept;
}
