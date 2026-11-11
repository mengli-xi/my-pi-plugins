import assert from "node:assert/strict";
import test from "node:test";
import { OccupancyRegistry } from "../src/occupancy.ts";
import {
  OVER_LIMIT_RECHECK_MS,
  planTick,
} from "../src/planner.ts";
import type { Task } from "../src/task.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const anchor = Date.UTC(2026, 0, 1, 0, 0);

function agentTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    prompt: "p",
    schedule: { kind: "interval", everyMs: HOUR, anchor },
    timeZone: "UTC",
    toleranceMs: 5 * MIN,
    target: { kind: "agent", cwd: "/tmp", provider: "scheduler-faux", model: "faux-model" },
    status: "active",
    createdAt: anchor,
    origin: "agent",
    ...overrides,
  };
}

function sessionTask(id: string, sessionId: string, overrides: Partial<Task> = {}): Task {
  return { ...agentTask(id, overrides), target: { kind: "session", sessionId, cwd: "/work" } };
}

// ── occupancy registry ──────────────────────────────────────────────────────

test("registry treats a live pid as occupied and a dead pid as free", () => {
  const live = new Set([100]);
  const reg = new OccupancyRegistry((pid) => live.has(pid));
  reg.register("s", 100);
  assert.equal(reg.isOccupied("s"), true);
  live.delete(100); // process died without unregistering
  assert.equal(reg.isOccupied("s"), false);
  assert.deepEqual(reg.snapshot(), []);
});

test("unregister frees a session held by a live pid", () => {
  const reg = new OccupancyRegistry(() => true);
  reg.register("s", 100);
  reg.unregister("s", 100);
  assert.equal(reg.isOccupied("s"), false);
});

test("restores persisted holders on construct, dropping dead pids", () => {
  const live = new Set([100]);
  const reg = new OccupancyRegistry({
    alive: (pid) => live.has(pid),
    initial: [{ sessionId: "live", pid: 100 }, { sessionId: "dead", pid: 200 }],
  });
  assert.equal(reg.isOccupied("live"), true, "live holder restored");
  assert.equal(reg.isOccupied("dead"), false, "dead holder dropped on restore");
});

test("onChange fires with a snapshot the daemon can persist", () => {
  const snapshots: number[] = [];
  const reg = new OccupancyRegistry({
    alive: () => true,
    onChange: (entries) => snapshots.push(entries.length),
  });
  reg.register("a", 1);
  reg.register("b", 2);
  reg.unregister("a", 1);
  assert.deepEqual(snapshots, [1, 2, 1]);
});

test("duplicate register does not re-fire onChange", () => {
  let changes = 0;
  const reg = new OccupancyRegistry({ alive: () => true, onChange: () => changes++ });
  reg.register("a", 1);
  reg.register("a", 1);
  assert.equal(changes, 1, "idempotent register");
});

// ── planner ─────────────────────────────────────────────────────────────────

test("dispatches a due agent task within tolerance", () => {
  const plan = planTick({
    tasks: [agentTask("a")],
    isOccupied: () => false,
    running: 0,
    concurrency: 5,
    now: anchor + HOUR + MIN,
  });
  assert.deepEqual(plan.dispatch.map((d) => [d.task.id, d.scheduledTime]), [["a", anchor + HOUR]]);
  assert.deepEqual(plan.skip, []);
});

test("skips an agent task that is late beyond tolerance", () => {
  const plan = planTick({
    tasks: [agentTask("a")],
    isOccupied: () => false,
    running: 0,
    concurrency: 5,
    now: anchor + HOUR + 30 * MIN,
  });
  assert.deepEqual(plan.dispatch, []);
  assert.deepEqual(plan.skip.map((s) => [s.task.id, s.reason]), [["a", "late-beyond-tolerance"]]);
});

test("stages a due session task while its session is occupied", () => {
  const now = anchor + HOUR + MIN;
  const plan = planTick({
    tasks: [sessionTask("a", "held")],
    isOccupied: (id) => id === "held",
    running: 0,
    concurrency: 5,
    now,
  });
  assert.deepEqual(plan.dispatch, []);
  assert.deepEqual(plan.skip, []);
  assert.deepEqual(plan.inject.map((item) => [item.task.id, item.scheduledTime, item.staleAt]), [
    ["a", anchor + HOUR, anchor + HOUR + 5 * MIN],
  ]);
  assert.equal(plan.wakeAt, undefined);
});

test("occupied session at the exact tolerance boundary still stages like schedule core", () => {
  const plan = planTick({
    tasks: [sessionTask("a", "held")],
    isOccupied: () => true,
    running: 0,
    concurrency: 5,
    now: anchor + HOUR + 5 * MIN,
  });
  assert.deepEqual(plan.skip, []);
  assert.equal(plan.inject.length, 1);
});

test("occupied session past tolerance is skipped, not deferred forever", () => {
  const plan = planTick({
    tasks: [sessionTask("a", "held")],
    isOccupied: () => true,
    running: 0,
    concurrency: 5,
    now: anchor + HOUR + 30 * MIN,
  });
  assert.deepEqual(plan.skip.map((s) => s.task.id), ["a"]);
});

test("a free session task dispatches normally", () => {
  const plan = planTick({
    tasks: [sessionTask("a", "idle")],
    isOccupied: () => false,
    running: 0,
    concurrency: 5,
    now: anchor + HOUR + MIN,
  });
  assert.deepEqual(plan.dispatch.map((d) => d.task.id), ["a"]);
});

test("concurrency limit admits oldest-first and defers the rest", () => {
  const now = anchor + HOUR + 2 * MIN;
  const tasks = [
    agentTask("new", { schedule: { kind: "once", at: anchor + HOUR + MIN } }),
    agentTask("old", { schedule: { kind: "once", at: anchor + HOUR } }),
  ];
  const plan = planTick({ tasks, isOccupied: () => false, running: 0, concurrency: 1, now });
  assert.equal(plan.dispatch.length, 1);
  assert.equal(plan.dispatch[0]!.task.id, "old", "older scheduled time wins the single slot");
  assert.equal(plan.wakeAt, now + OVER_LIMIT_RECHECK_MS);
});

test("no free slots dispatches nothing and asks to recheck soon", () => {
  const plan = planTick({
    tasks: [agentTask("a")],
    isOccupied: () => false,
    running: 5,
    concurrency: 5,
    now: anchor + HOUR + MIN,
  });
  assert.deepEqual(plan.dispatch, []);
  assert.equal(plan.wakeAt, (anchor + HOUR + MIN) + OVER_LIMIT_RECHECK_MS);
});

test("waits and reports the earliest future wake across tasks", () => {
  const soon = agentTask("soon", { schedule: { kind: "interval", everyMs: HOUR, anchor } });
  const later = agentTask("later", { schedule: { kind: "interval", everyMs: 2 * HOUR, anchor } });
  const plan = planTick({
    tasks: [soon, later],
    isOccupied: () => false,
    running: 0,
    concurrency: 5,
    now: anchor + 10 * MIN,
  });
  assert.deepEqual(plan.dispatch, []);
  assert.equal(plan.wakeAt, anchor + HOUR);
});

test("retires a one-shot task whose only occurrence is already dispatched", () => {
  const once = agentTask("o", {
    schedule: { kind: "once", at: anchor + HOUR },
    lastScheduledTime: anchor + HOUR,
  });
  const plan = planTick({
    tasks: [once],
    isOccupied: () => false,
    running: 0,
    concurrency: 5,
    now: anchor + HOUR + MIN,
  });
  assert.deepEqual(plan.retire.map((r) => r.task.id), ["o"]);
});

test("paused tasks are ignored entirely", () => {
  const plan = planTick({
    tasks: [agentTask("a", { status: "paused" })],
    isOccupied: () => false,
    running: 0,
    concurrency: 5,
    now: anchor + HOUR + MIN,
  });
  assert.deepEqual(plan, { dispatch: [], inject: [], skip: [], retire: [], wakeAt: undefined });
});
