/**
 * Pure scheduling core: trigger rules, timezone-aware occurrence math, and the
 * run/skip/wait decision. No I/O, no clock of its own — every function takes
 * `now`. This is the part the design is most likely to get subtly wrong, so it
 * is isolated and pinned by tests.
 *
 * Decisions encoded here (see docs/design.md):
 * - #23 structured schedules, not cron strings.
 * - #24 the wall-clock fields are interpreted in the task's stored IANA zone.
 * - #4/#5/#7 one unified rule: only the latest due occurrence is considered
 *   (coalescing missed periodic/interval runs into one), and tolerance decides
 *   run-vs-skip. Interval advances by scheduled time, never by completion time.
 */

/** A one-shot absolute instant. */
export interface OnceSchedule {
  kind: "once";
  /** Epoch milliseconds. */
  at: number;
}

/** Every day at a wall-clock time in the task's zone. */
export interface DailySchedule {
  kind: "daily";
  /** "HH:MM" 24h. */
  at: string;
}

/** Every week on one weekday at a wall-clock time. */
export interface WeeklySchedule {
  kind: "weekly";
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** "HH:MM" 24h. */
  at: string;
}

/** A fixed interval anchored at a known instant. */
export interface IntervalSchedule {
  kind: "interval";
  everyMs: number;
  /** Epoch ms the cadence is measured from (typically task creation). */
  anchor: number;
}

export type Schedule =
  | OnceSchedule
  | DailySchedule
  | WeeklySchedule
  | IntervalSchedule;

/** Whether a schedule names an exact clock time or a recurring cadence. */
export function isClockTime(schedule: Schedule): boolean {
  return schedule.kind === "once" || schedule.kind === "daily" ||
    schedule.kind === "weekly";
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHhmm(at: string): { hour: number; minute: number } {
  const match = HHMM.exec(at);
  if (!match) throw new Error(`invalid time-of-day: ${JSON.stringify(at)}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The UTC-offset (minutes) a zone is at for a given instant. Uses the formatted
 * wall-clock parts to derive the offset, which follows DST transitions.
 */
function zoneOffsetMinutes(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const field: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") field[part.type] = Number(part.value);
  }
  // The wall clock the zone shows for `instant`, read back as if it were UTC.
  const asUtc = Date.UTC(
    field.year!,
    field.month! - 1,
    field.day!,
    field.hour! === 24 ? 0 : field.hour!,
    field.minute!,
    field.second!,
  );
  return Math.round((asUtc - instant) / 60000);
}

/**
 * Epoch ms for a wall-clock time in a zone. Resolves the offset at the target
 * itself (two-pass) so DST-adjacent times land on the correct instant.
 */
export function zonedWallClockToEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = zoneOffsetMinutes(timeZone, naiveUtc);
  const candidate = naiveUtc - firstOffset * 60000;
  const secondOffset = zoneOffsetMinutes(timeZone, candidate);
  if (secondOffset === firstOffset) return candidate;
  // Offset changed across the DST boundary; re-resolve with the local offset.
  return naiveUtc - secondOffset * 60000;
}

interface ZonedDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function zonedDate(timeZone: string, instant: number): ZonedDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const field: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") field[part.type] = part.value;
  }
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(field.year),
    month: Number(field.month),
    day: Number(field.day),
    weekday: weekdays.indexOf(field.weekday!),
  };
}

/** Add whole days to a zoned wall-clock date, returning the epoch of HH:MM. */
function epochForDayOffset(
  timeZone: string,
  base: ZonedDate,
  dayOffset: number,
  hour: number,
  minute: number,
): number {
  // Advance the calendar day via a UTC noon anchor to avoid DST underflow,
  // then read that day back in-zone and resolve the wall-clock time.
  const anchor = Date.UTC(base.year, base.month - 1, base.day + dayOffset, 12);
  const shifted = zonedDate(timeZone, anchor);
  return zonedWallClockToEpoch(
    timeZone,
    shifted.year,
    shifted.month,
    shifted.day,
    hour,
    minute,
  );
}

/** Search bound so a broken zone/schedule can never spin forever. */
const MAX_DAY_SCAN = 8;

/**
 * The next occurrence strictly at or after `fromMs`. Returns undefined only for
 * a one-shot schedule whose instant is already before `fromMs`.
 */
export function nextOccurrenceAtOrAfter(
  schedule: Schedule,
  timeZone: string,
  fromMs: number,
): number | undefined {
  switch (schedule.kind) {
    case "once":
      return schedule.at >= fromMs ? schedule.at : undefined;
    case "interval": {
      if (schedule.everyMs <= 0) throw new Error("interval everyMs must be > 0");
      // Occurrences are anchor + k*everyMs for k >= 1: "every hour" created at
      // T first fires at T+1h, never at T itself.
      if (fromMs <= schedule.anchor + schedule.everyMs) {
        return schedule.anchor + schedule.everyMs;
      }
      const steps = Math.ceil((fromMs - schedule.anchor) / schedule.everyMs);
      return schedule.anchor + steps * schedule.everyMs;
    }
    case "daily":
    case "weekly": {
      const { hour, minute } = parseHhmm(schedule.at);
      const base = zonedDate(timeZone, fromMs);
      for (let offset = 0; offset <= MAX_DAY_SCAN; offset++) {
        const candidate = epochForDayOffset(timeZone, base, offset, hour, minute);
        if (candidate < fromMs) continue;
        if (schedule.kind === "weekly") {
          const cd = zonedDate(timeZone, candidate);
          if (cd.weekday !== schedule.dayOfWeek) continue;
        }
        return candidate;
      }
      throw new Error("could not resolve next occurrence within scan window");
    }
  }
}

/**
 * The latest occurrence at or before `atMs`, or undefined if none has happened
 * yet. Used to coalesce missed periodic/interval runs to a single catch-up.
 */
export function latestOccurrenceAtOrBefore(
  schedule: Schedule,
  timeZone: string,
  atMs: number,
): number | undefined {
  switch (schedule.kind) {
    case "once":
      return schedule.at <= atMs ? schedule.at : undefined;
    case "interval": {
      if (schedule.everyMs <= 0) throw new Error("interval everyMs must be > 0");
      // Mirror nextOccurrenceAtOrAfter: first occurrence is anchor + everyMs.
      if (atMs < schedule.anchor + schedule.everyMs) return undefined;
      const steps = Math.floor((atMs - schedule.anchor) / schedule.everyMs);
      return schedule.anchor + steps * schedule.everyMs;
    }
    case "daily":
    case "weekly": {
      const { hour, minute } = parseHhmm(schedule.at);
      const base = zonedDate(timeZone, atMs);
      for (let offset = 0; offset <= MAX_DAY_SCAN; offset++) {
        const candidate = epochForDayOffset(timeZone, base, -offset, hour, minute);
        if (candidate > atMs) continue;
        if (schedule.kind === "weekly") {
          const cd = zonedDate(timeZone, candidate);
          if (cd.weekday !== schedule.dayOfWeek) continue;
        }
        return candidate;
      }
      return undefined;
    }
  }
}

export interface ScheduleState {
  /** Latest scheduled time already dispatched (run or skipped). Undefined = none yet. */
  lastScheduledTime?: number;
}

export type ScheduleDecision =
  | { action: "run"; scheduledTime: number }
  | { action: "skip"; scheduledTime: number; reason: "late-beyond-tolerance" }
  | { action: "wait"; until: number }
  | { action: "done" };

/**
 * Decide what to do for a task right now.
 *
 * Only the latest due occurrence newer than `lastScheduledTime` is considered,
 * which coalesces any number of missed periodic/interval runs into one. The
 * tolerance then decides run-vs-skip identically for every schedule kind:
 * clock-time tasks skip when stale, interval tasks skip the stale occurrence
 * and continue on cadence.
 */
export function evaluate(
  schedule: Schedule,
  timeZone: string,
  toleranceMs: number,
  state: ScheduleState,
  now: number,
): ScheduleDecision {
  const last = state.lastScheduledTime;
  const due = latestOccurrenceAtOrBefore(schedule, timeZone, now);

  if (due !== undefined && (last === undefined || due > last)) {
    if (now - due <= toleranceMs) return { action: "run", scheduledTime: due };
    // Stale beyond tolerance: consume this occurrence so it is not retried.
    // The caller advances lastScheduledTime to `due` and re-evaluates, which
    // then returns `wait` for the next occurrence (interval keeps its cadence).
    return { action: "skip", scheduledTime: due, reason: "late-beyond-tolerance" };
  }

  const nextAfter = nextOccurrenceAtOrAfter(
    schedule,
    timeZone,
    Math.max(now, (last ?? -Infinity) + 1),
  );
  if (nextAfter === undefined) return { action: "done" };
  return { action: "wait", until: nextAfter };
}
