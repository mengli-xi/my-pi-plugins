import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluate,
  isClockTime,
  latestOccurrenceAtOrBefore,
  nextOccurrenceAtOrAfter,
  type Schedule,
  type ScheduleState,
  zonedWallClockToEpoch,
} from "../src/schedule.ts";

const UTC = "UTC";
const NY = "America/New_York";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

test("classifies clock-time vs interval schedules", () => {
  assert.equal(isClockTime({ kind: "once", at: 0 }), true);
  assert.equal(isClockTime({ kind: "daily", at: "09:00" }), true);
  assert.equal(isClockTime({ kind: "weekly", dayOfWeek: 1, at: "09:00" }), true);
  assert.equal(isClockTime({ kind: "interval", everyMs: HOUR, anchor: 0 }), false);
});

test("daily occurrence lands on the zone's wall clock, across DST", () => {
  // 2026-03-08 is US spring-forward. 09:00 NY is EST (UTC-5) before, EDT (UTC-4) after.
  const beforeDst = zonedWallClockToEpoch(NY, 2026, 3, 7, 9, 0);
  assert.equal(iso(beforeDst), "2026-03-07T14:00:00.000Z");
  const afterDst = zonedWallClockToEpoch(NY, 2026, 3, 9, 9, 0);
  assert.equal(iso(afterDst), "2026-03-09T13:00:00.000Z");
});

test("next daily occurrence is at-or-after and picks the same wall time", () => {
  const schedule: Schedule = { kind: "daily", at: "09:00" };
  const from = Date.UTC(2026, 0, 1, 12, 0); // past 09:00 UTC already
  const next = nextOccurrenceAtOrAfter(schedule, UTC, from)!;
  assert.equal(iso(next), "2026-01-02T09:00:00.000Z");
  // Exactly at 09:00 counts as the current occurrence, not tomorrow.
  const at9 = Date.UTC(2026, 0, 1, 9, 0);
  assert.equal(iso(nextOccurrenceAtOrAfter(schedule, UTC, at9)!), "2026-01-01T09:00:00.000Z");
});

test("weekly occurrence selects the requested weekday", () => {
  const schedule: Schedule = { kind: "weekly", dayOfWeek: 1, at: "09:00" }; // Monday
  // 2026-01-01 is a Thursday; next Monday 09:00 is 2026-01-05.
  const from = Date.UTC(2026, 0, 1, 0, 0);
  const next = nextOccurrenceAtOrAfter(schedule, UTC, from)!;
  assert.equal(iso(next), "2026-01-05T09:00:00.000Z");
  assert.equal(new Date(next).getUTCDay(), 1);
});

test("interval advances by scheduled time from the anchor, not completion", () => {
  const anchor = Date.UTC(2026, 0, 1, 0, 0);
  const schedule: Schedule = { kind: "interval", everyMs: HOUR, anchor };
  // 90 minutes in: latest due is +1h, next is +2h — never anchored on 'now'.
  const now = anchor + 90 * MIN;
  assert.equal(latestOccurrenceAtOrBefore(schedule, UTC, now), anchor + HOUR);
  assert.equal(nextOccurrenceAtOrAfter(schedule, UTC, now), anchor + 2 * HOUR);
});

test("once schedule is a single instant with no repeat", () => {
  const at = Date.UTC(2026, 0, 1, 9, 0);
  const schedule: Schedule = { kind: "once", at };
  assert.equal(latestOccurrenceAtOrBefore(schedule, UTC, at - 1), undefined);
  assert.equal(latestOccurrenceAtOrBefore(schedule, UTC, at), at);
  assert.equal(nextOccurrenceAtOrAfter(schedule, UTC, at + 1), undefined);
});

// ── evaluate(): run / skip / wait / done ────────────────────────────────────

const anchor = Date.UTC(2026, 0, 1, 0, 0);

test("runs a fresh occurrence within tolerance", () => {
  const schedule: Schedule = { kind: "interval", everyMs: HOUR, anchor };
  const decision = evaluate(schedule, UTC, 5 * MIN, {}, anchor + HOUR + MIN);
  assert.deepEqual(decision, { action: "run", scheduledTime: anchor + HOUR });
});

test("waits when the next occurrence is still in the future", () => {
  const schedule: Schedule = { kind: "interval", everyMs: HOUR, anchor };
  const decision = evaluate(schedule, UTC, 5 * MIN, {}, anchor + 30 * MIN);
  assert.deepEqual(decision, { action: "wait", until: anchor + HOUR });
});

test("does not re-run an occurrence already dispatched", () => {
  const schedule: Schedule = { kind: "interval", everyMs: HOUR, anchor };
  const state: ScheduleState = { lastScheduledTime: anchor + HOUR };
  const decision = evaluate(schedule, UTC, 5 * MIN, state, anchor + HOUR + MIN);
  assert.deepEqual(decision, { action: "wait", until: anchor + 2 * HOUR });
});

test("clock-time task skips when late beyond tolerance", () => {
  const schedule: Schedule = { kind: "daily", at: "09:00" };
  const nine = Date.UTC(2026, 0, 1, 9, 0);
  const decision = evaluate(schedule, UTC, 5 * MIN, {}, nine + 30 * MIN);
  assert.deepEqual(decision, {
    action: "skip",
    scheduledTime: nine,
    reason: "late-beyond-tolerance",
  });
});

test("interval coalesces many missed runs into one, then continues on cadence", () => {
  const schedule: Schedule = { kind: "interval", everyMs: HOUR, anchor };
  // Slept 8 hours; only the latest occurrence (+8h) is considered, within tol.
  const now = anchor + 8 * HOUR + 2 * MIN;
  const first = evaluate(schedule, UTC, 5 * MIN, {}, now);
  assert.deepEqual(first, { action: "run", scheduledTime: anchor + 8 * HOUR });
  // After dispatching +8h, the next wait is +9h — cadence preserved, no catch-up burst.
  const after = evaluate(schedule, UTC, 5 * MIN, { lastScheduledTime: anchor + 8 * HOUR }, now);
  assert.deepEqual(after, { action: "wait", until: anchor + 9 * HOUR });
});

test("interval late beyond tolerance skips the stale occurrence", () => {
  const schedule: Schedule = { kind: "interval", everyMs: HOUR, anchor };
  const now = anchor + 8 * HOUR + 30 * MIN; // latest due +8h, 30m late
  const decision = evaluate(schedule, UTC, 5 * MIN, {}, now);
  assert.deepEqual(decision, {
    action: "skip",
    scheduledTime: anchor + 8 * HOUR,
    reason: "late-beyond-tolerance",
  });
  // Consuming the skip lets the cadence move on to +9h.
  const after = evaluate(schedule, UTC, 5 * MIN, { lastScheduledTime: anchor + 8 * HOUR }, now);
  assert.deepEqual(after, { action: "wait", until: anchor + 9 * HOUR });
});

test("a one-shot task reports done after its occurrence is dispatched", () => {
  const at = Date.UTC(2026, 0, 1, 9, 0);
  const schedule: Schedule = { kind: "once", at };
  const run = evaluate(schedule, UTC, 5 * MIN, {}, at + MIN);
  assert.deepEqual(run, { action: "run", scheduledTime: at });
  const done = evaluate(schedule, UTC, 5 * MIN, { lastScheduledTime: at }, at + MIN);
  assert.deepEqual(done, { action: "done" });
});

test("tolerance bounds the wait for a busy/occupied session equally", () => {
  // Same rule the daemon uses when a session is occupied: an occurrence that
  // cannot run yet is subject to the same tolerance as sleep/downtime.
  const schedule: Schedule = { kind: "once", at: anchor };
  assert.deepEqual(
    evaluate(schedule, UTC, 10 * MIN, {}, anchor + 9 * MIN),
    { action: "run", scheduledTime: anchor },
  );
  assert.deepEqual(
    evaluate(schedule, UTC, 10 * MIN, {}, anchor + 11 * MIN),
    { action: "skip", scheduledTime: anchor, reason: "late-beyond-tolerance" },
  );
});
