import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SchedulerStore } from "../src/store.ts";
import { applyRetention, type RunRecord, type Task } from "../src/task.ts";

const DAY = 24 * 60 * 60 * 1000;

function tempStore(): { store: SchedulerStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-scheduler-store-"));
  return { store: new SchedulerStore(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    prompt: "do the thing",
    schedule: { kind: "daily", at: "09:00" },
    timeZone: "UTC",
    toleranceMs: 5 * 60 * 1000,
    target: { kind: "agent", cwd: "/tmp", provider: "scheduler-faux", model: "faux-model" },
    status: "active",
    createdAt: 1000,
    origin: "agent",
    ...overrides,
  };
}

function run(taskId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    taskId,
    scheduledTime: 1000,
    finishedAt: 2000,
    outcome: "success",
    target: "agent",
    ...overrides,
  };
}

test("round-trips a task and lists it back", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(task("a"));
  assert.deepEqual(store.getTask("a")?.id, "a");
  assert.deepEqual(store.listTasks().map((x) => x.id), ["a"]);
});

test("missing store directory reads as empty, not an error", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.deepEqual(store.listTasks(), []);
  assert.equal(store.getTask("nope"), undefined);
  assert.deepEqual(store.listRuns("nope"), []);
});

test("deleting a task drops its runs too", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(task("a"));
  store.appendRun(run("a"));
  store.deleteTask("a");
  assert.equal(store.getTask("a"), undefined);
  assert.deepEqual(store.listRuns("a"), []);
});

test("a corrupt task file is skipped, others still load", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(task("good"));
  // Write garbage where a task file would be.
  writeFileSync(join(store.root, "tasks", "bad.json"), "{ not json");
  assert.deepEqual(store.listTasks().map((x) => x.id), ["good"]);
});

test("runs persist chronologically and prune by count", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const small = new SchedulerStore(store.root, { maxPerTask: 3, maxAgeMs: 10 * DAY });
  const base = 1_000_000_000_000;
  for (let i = 0; i < 5; i++) {
    small.appendRun(run("a", { scheduledTime: i, finishedAt: base + i }), base + 5);
  }
  const kept = small.listRuns("a");
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((r) => r.finishedAt), [base + 2, base + 3, base + 4]);
});

test("unacknowledged failures survive age and count pressure", () => {
  const now = 100 * DAY;
  const records: RunRecord[] = [
    run("a", { finishedAt: now - 60 * DAY, outcome: "failure", acknowledged: false }),
    ...Array.from({ length: 60 }, (_, i) =>
      run("a", { finishedAt: now - i * 1000, outcome: "success" })),
  ];
  const kept = applyRetention(records, { maxPerTask: 50, maxAgeMs: 30 * DAY }, now);
  assert.ok(kept.some((r) => r.outcome === "failure"), "old unread failure is retained");
});

test("acknowledged failures are subject to normal retention", () => {
  const now = 100 * DAY;
  const old = run("a", { finishedAt: now - 60 * DAY, outcome: "failure", acknowledged: true });
  const kept = applyRetention([old], { maxPerTask: 50, maxAgeMs: 30 * DAY }, now);
  assert.deepEqual(kept, []);
});

test("unacknowledged failures are collected and can be acknowledged", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(task("a"));
  store.appendRun(run("a", { finishedAt: 5000, outcome: "failure", detail: "boom" }), 6000);
  store.appendRun(run("a", { finishedAt: 6000, outcome: "success" }), 6000);
  assert.equal(store.unacknowledgedFailures().length, 1);
  store.acknowledgeFailures(6000);
  assert.equal(store.unacknowledgedFailures().length, 0);
});

test("occupancy persists and reads back", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.deepEqual(store.readOccupancy(), []);
  store.writeOccupancy([{ sessionId: "s", pid: 42 }]);
  assert.deepEqual(store.readOccupancy(), [{ sessionId: "s", pid: 42 }]);
});

test("in-flight markers round-trip and clear", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.markInflight({ taskId: "a", scheduledTime: 1, startedAt: 2, target: "agent", daemonPid: 7 });
  assert.deepEqual(store.listInflight().map((m) => m.taskId), ["a"]);
  store.clearInflight("a");
  assert.deepEqual(store.listInflight(), []);
});
