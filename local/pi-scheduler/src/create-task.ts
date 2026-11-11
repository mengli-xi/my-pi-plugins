/**
 * Build and validate a Task from the tool's structured input (decisions #20/
 * #21/#23/#24). Pure so it can be unit-tested and reused by both the tool and
 * the /schedule command. The agent supplies already-parsed structured fields;
 * this validates them and freezes the task.
 */

import { randomUUID } from "node:crypto";
import type { Schedule } from "./schedule.ts";
import type { Task, TaskTarget } from "./task.ts";

export interface CreateTaskInput {
  title: string;
  prompt: string;
  schedule: Schedule;
  /** IANA zone; defaults to the host zone when omitted. */
  timeZone?: string;
  /** Lateness allowance in ms; defaults to 5 minutes. */
  toleranceMs?: number;
  target: TaskTarget;
  origin: "agent" | "user";
  createdInSession?: string;
  now: number;
}

export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export class CreateTaskError extends Error {}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function validateSchedule(schedule: Schedule, now: number): void {
  switch (schedule.kind) {
    case "once":
      if (!Number.isFinite(schedule.at)) throw new CreateTaskError("once.at must be a timestamp");
      if (schedule.at < now) throw new CreateTaskError("once.at is in the past");
      return;
    case "daily":
      if (!HHMM.test(schedule.at)) throw new CreateTaskError(`daily.at must be HH:MM, got ${schedule.at}`);
      return;
    case "weekly":
      if (!HHMM.test(schedule.at)) throw new CreateTaskError(`weekly.at must be HH:MM, got ${schedule.at}`);
      if (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6) {
        throw new CreateTaskError("weekly.dayOfWeek must be 0..6");
      }
      return;
    case "interval":
      if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
        throw new CreateTaskError("interval.everyMs must be > 0");
      }
      // Guard against runaway self-wake loops from agent-created tasks.
      if (schedule.everyMs < MIN_INTERVAL_MS) {
        throw new CreateTaskError(`interval.everyMs must be >= ${MIN_INTERVAL_MS}ms`);
      }
      return;
  }
}

/** Floor on interval cadence, so an agent cannot schedule a per-second loop. */
export const MIN_INTERVAL_MS = 60_000;

function validateTarget(target: TaskTarget): void {
  if (target.kind === "agent") {
    if (!target.cwd) throw new CreateTaskError("agent target requires cwd");
    if (!target.provider) throw new CreateTaskError("agent target requires provider");
    if (!target.model) throw new CreateTaskError("agent target requires model");
    return;
  }
  if (target.kind === "session") {
    if (!target.sessionId) throw new CreateTaskError("session target requires sessionId");
    if (!target.cwd) throw new CreateTaskError("session target requires cwd");
    return;
  }
  throw new CreateTaskError(`unknown target kind: ${(target as { kind: string }).kind}`);
}

function validateTimeZone(zone: string): void {
  try {
    // Throws RangeError for an invalid IANA zone.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new CreateTaskError(`invalid IANA time zone: ${zone}`);
  }
}

/**
 * Validate an already-built Task (e.g. after applying a partial update). Throws
 * CreateTaskError on any invalid field. Unlike createTask this does not require
 * a future `once.at`, since an update may leave a past one-shot that the
 * planner will simply retire.
 */
export function validateTask(task: Task, now: number): void {
  if (!task.title.trim()) throw new CreateTaskError("title is required");
  if (!task.prompt.trim()) throw new CreateTaskError("prompt is required");
  if (task.schedule.kind === "once") {
    if (!Number.isFinite(task.schedule.at)) throw new CreateTaskError("once.at must be a timestamp");
  } else {
    validateSchedule(task.schedule, now);
  }
  validateTarget(task.target);
  validateTimeZone(task.timeZone);
  if (!Number.isFinite(task.toleranceMs) || task.toleranceMs < 0) {
    throw new CreateTaskError("toleranceMs must be >= 0");
  }
}

/** Validate and freeze a Task from tool input. Throws CreateTaskError. */
export function createTask(input: CreateTaskInput): Task {
  if (!input.title.trim()) throw new CreateTaskError("title is required");
  if (!input.prompt.trim()) throw new CreateTaskError("prompt is required");
  validateSchedule(input.schedule, input.now);
  validateTarget(input.target);
  const timeZone = input.timeZone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  validateTimeZone(timeZone);
  const toleranceMs = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new CreateTaskError("toleranceMs must be >= 0");
  }
  return {
    id: randomUUID(),
    title: input.title.trim(),
    prompt: input.prompt,
    schedule: input.schedule,
    timeZone,
    toleranceMs,
    target: input.target,
    status: "active",
    createdAt: input.now,
    origin: input.origin,
    createdInSession: input.createdInSession,
  };
}
