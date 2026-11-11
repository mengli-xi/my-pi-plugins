import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ping, request } from "../src/client.ts";
import { DaemonAlreadyRunningError, SchedulerRuntime } from "../src/runtime.ts";
import { SchedulerStore } from "../src/store.ts";
import type { ExecutionResult, TaskRunner } from "../src/executor.ts";
import type { Task } from "../src/task.ts";

const MIN = 60_000;

function agentTask(id: string, at: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    prompt: "do it",
    schedule: { kind: "once", at },
    timeZone: "UTC",
    toleranceMs: 10 * MIN,
    target: { kind: "agent", cwd: "/work", provider: "scheduler-faux", model: "faux-model" },
    status: "active",
    createdAt: at - MIN,
    origin: "agent",
    ...overrides,
  };
}

async function withRuntime(
  run: (ctx: { socket: string; ran: Task[]; now: () => number; setNow: (v: number) => void }) => Promise<void>,
  result: ExecutionResult = { outcome: "success" },
): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-scheduler-e2e-"));
  const ran: Task[] = [];
  let current = Date.UTC(2026, 0, 1, 0, 0);
  const runner: TaskRunner = async ({ task }) => { ran.push(task); return result; };
  const runtime = new SchedulerRuntime({
    agentDir,
    piBinary: "/bin/true",
    concurrency: 5,
    runner,
    now: () => current,
    maxSleepMs: 50,
  });
  await runtime.start();
  try {
    await run({
      socket: runtime.paths.socket,
      ran,
      now: () => current,
      setNow: (v) => { current = v; },
    });
  } finally {
    runtime.stop();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("two runtimes cannot acquire the same daemon lock", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-scheduler-lock-"));
  const first = new SchedulerRuntime({ agentDir, piBinary: "/bin/true", buildId: "first" });
  const second = new SchedulerRuntime({ agentDir, piBinary: "/bin/true", buildId: "second" });
  await first.start();
  t.after(() => {
    first.stop();
    second.stop();
    rmSync(agentDir, { recursive: true, force: true });
  });
  await assert.rejects(second.start(), DaemonAlreadyRunningError);
});

test("stale diagnostic lock text never blocks advisory ownership", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-scheduler-stale-lock-"));
  const root = join(agentDir, "scheduler");
  mkdirSync(join(root, "daemon.lock.recovery"), { recursive: true });
  writeFileSync(join(root, "daemon.lock"), "999999 stale-diagnostic\n");
  writeFileSync(join(root, "daemon.lock.recovery", "owner"), "999999 stale\n");
  const runtime = new SchedulerRuntime({ agentDir, piBinary: "/bin/true", buildId: "recovered" });
  t.after(() => {
    runtime.stop();
    rmSync(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
  assert.equal(runtime.paths.socket.length > 0, true);
});

test("daemon answers ping over the socket", async () => {
  await withRuntime(async ({ socket }) => {
    assert.equal(await ping(socket), true);
  });
});

test("creating a task over IPC schedules and runs it", async () => {
  await withRuntime(async ({ socket, ran, now }) => {
    const at = now(); // due immediately, within tolerance
    const reply = await request({ type: "task.create", task: agentTask("a", at) }, { socketPath: socket });
    assert.equal(reply.ok, true);
    // The create triggers an immediate re-plan; give the async run a moment.
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(ran.map((t) => t.id), ["a"]);
    const runs = await request({ type: "task.runs", id: "a" }, { socketPath: socket });
    assert.equal(runs.ok && runs.type === "runs" && runs.runs.at(-1)?.outcome, "success");
  });
});

test("update drains in-flight work before closing and never starts new work", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-scheduler-drain-"));
  const now = Date.UTC(2026, 0, 1, 0, 0);
  const ran: string[] = [];
  let releaseRun!: () => void;
  let markStarted!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
  let runAtDrain: string | undefined;
  const runtime = new SchedulerRuntime({
    agentDir,
    piBinary: "/bin/true",
    buildId: "build-42",
    runner: async ({ task }) => {
      ran.push(task.id);
      markStarted();
      await runGate;
      return { outcome: "success" };
    },
    now: () => now,
    maxSleepMs: 20,
    onDrained: () => {
      runAtDrain = new SchedulerStore(runtime.paths.root).listRuns("active").at(-1)?.outcome;
      resolveDrained();
    },
  });
  await runtime.start();
  try {
    assert.deepEqual(
      await request({ type: "daemon.status" }, { socketPath: runtime.paths.socket }),
      { ok: true, type: "daemon-status", buildId: "build-42", draining: false },
    );
    await request({ type: "task.create", task: agentTask("active", now) }, { socketPath: runtime.paths.socket });
    await started;

    assert.deepEqual(
      await request({ type: "daemon.update" }, { socketPath: runtime.paths.socket }),
      { ok: true, type: "ack" },
    );
    assert.deepEqual(
      await request({ type: "daemon.status" }, { socketPath: runtime.paths.socket }),
      { ok: true, type: "daemon-status", buildId: "build-42", draining: true },
    );

    const create = await request({
      type: "task.create",
      task: agentTask("queued", now),
    }, { socketPath: runtime.paths.socket });
    assert.equal(create.ok, true, "mutations remain available during drain");
    const runNow = await request({ type: "task.runNow", id: "queued" }, { socketPath: runtime.paths.socket });
    assert.deepEqual(runNow, { ok: false, error: "daemon is draining" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(ran, ["active"], "drain starts no scheduled or manual work");

    releaseRun();
    await drained;
    assert.equal(runAtDrain, "success", "the final run record is durable before onDrained");
    assert.deepEqual(ran, ["active"]);
  } finally {
    runtime.stop();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("task.create rejects a malformed task instead of persisting it", async () => {
  await withRuntime(async ({ socket, now }) => {
    // A session target missing cwd must be refused at create time, not left to
    // silently no-op when the daemon later spawns it from the wrong cwd.
    const bad = {
      ...agentTask("bad", now()),
      target: { kind: "session", sessionId: "s-1" } as unknown as Task["target"],
    };
    const reply = await request({ type: "task.create", task: bad }, { socketPath: socket });
    assert.equal(reply.ok, false, "malformed task.create is rejected");
    const list = await request({ type: "task.list" }, { socketPath: socket });
    assert.ok(list.ok && list.type === "tasks" && list.tasks.length === 0, "nothing persisted");
  });
});

test("list, pause, resume, and delete round-trip over IPC", async () => {
  await withRuntime(async ({ socket, now }) => {
    await request({ type: "task.create", task: agentTask("a", now() + 60 * MIN) }, { socketPath: socket });
    let list = await request({ type: "task.list" }, { socketPath: socket });
    assert.ok(list.ok && list.type === "tasks" && list.tasks.length === 1);
    const paused = await request({ type: "task.pause", id: "a" }, { socketPath: socket });
    assert.ok(paused.ok && paused.type === "task" && paused.task.status === "paused");
    const resumed = await request({ type: "task.resume", id: "a" }, { socketPath: socket });
    assert.ok(resumed.ok && resumed.type === "task" && resumed.task.status === "active");
    await request({ type: "task.delete", id: "a" }, { socketPath: socket });
    list = await request({ type: "task.list" }, { socketPath: socket });
    assert.ok(list.ok && list.type === "tasks" && list.tasks.length === 0);
  });
});

test("occupancy registration defers a session task until the pid unregisters", async () => {
  await withRuntime(async ({ socket, ran, now }) => {
    const at = now();
    const task = agentTask("s", at, { target: { kind: "session", sessionId: "held", cwd: "/work" } });
    // A live pid holds the session (use our own pid so liveness is true).
    await request({ type: "occupancy.register", sessionId: "held", pid: process.pid }, { socketPath: socket });
    await request({ type: "task.create", task }, { socketPath: socket });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ran.length, 0, "held session task does not run");
    await request({ type: "occupancy.unregister", sessionId: "held", pid: process.pid }, { socketPath: socket });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(ran.map((t) => t.id), ["s"], "runs once the session frees");
  });
});

test("failures are listed and can be acknowledged over IPC", async () => {
  await withRuntime(async ({ socket, now }) => {
    await request({ type: "task.create", task: agentTask("a", now()) }, { socketPath: socket });
    await new Promise((r) => setTimeout(r, 30));
    const failures = await request({ type: "failures.list" }, { socketPath: socket });
    assert.ok(failures.ok && failures.type === "failures" && failures.failures.length === 1);
    await request({ type: "failures.acknowledge", through: now() + 1 }, { socketPath: socket });
    const after = await request({ type: "failures.list" }, { socketPath: socket });
    assert.ok(after.ok && after.type === "failures" && after.failures.length === 0);
  }, { outcome: "failure", detail: "boom" });
});

test("runNow on a session held by a live Pi returns a refusal, not an ack", async () => {
  await withRuntime(async ({ socket, ran, now }) => {
    const task = agentTask("s", now() + 60 * MIN, { target: { kind: "session", sessionId: "held", cwd: "/work" } });
    await request({ type: "occupancy.register", sessionId: "held", pid: process.pid }, { socketPath: socket });
    await request({ type: "task.create", task }, { socketPath: socket });
    const reply = await request({ type: "task.runNow", id: "s" }, { socketPath: socket });
    assert.equal(reply.ok, false, "refusal is surfaced as an error");
    assert.match((reply as { error: string }).error, /live Pi/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ran.length, 0, "nothing ran while the session was held");
  });
});
