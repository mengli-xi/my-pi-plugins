import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SchedulerDaemon } from "../src/daemon.ts";
import { buildPiArgs, type ExecutionResult, type TaskRunner } from "../src/executor.ts";
import { OccupancyRegistry } from "../src/occupancy.ts";
import { SchedulerStore } from "../src/store.ts";
import type { Task } from "../src/task.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const anchor = Date.UTC(2026, 0, 1, 0, 0);

function tempStore(): { store: SchedulerStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-scheduler-daemon-"));
  return { store: new SchedulerStore(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function agentTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    prompt: "do it",
    schedule: { kind: "once", at: anchor },
    timeZone: "UTC",
    toleranceMs: 10 * MIN,
    target: { kind: "agent", cwd: "/work", provider: "scheduler-faux", model: "faux-model", thinking: "high" },
    status: "active",
    createdAt: anchor - HOUR,
    origin: "agent",
    ...overrides,
  };
}

/** A runner that records calls and resolves on demand. */
function recordingRunner(result: ExecutionResult = { outcome: "success" }): {
  runner: TaskRunner;
  calls: Task[];
} {
  const calls: Task[] = [];
  const runner: TaskRunner = async ({ task }) => {
    calls.push(task);
    return result;
  };
  return { runner, calls };
}

test("buildPiArgs freezes agent config and a fresh session per run", () => {
  const { args, cwd } = buildPiArgs(agentTask("a"));
  assert.equal(cwd, "/work");
  assert.deepEqual(args.slice(0, 2), ["--print", "--session-id"]);
  assert.match(args[2]!, /^[0-9a-f-]{36}$/);
  assert.ok(args.includes("--provider") && args.includes("scheduler-faux"));
  assert.ok(args.includes("--model") && args.includes("faux-model"));
  assert.ok(args.includes("--thinking") && args.includes("high"));
  assert.equal(args.at(-1), "do it");
});

test("buildPiArgs for a session target resumes that exact session in its own cwd", () => {
  const task = agentTask("s", { target: { kind: "session", sessionId: "sess-42", cwd: "/work" } });
  const { args, cwd } = buildPiArgs(task);
  assert.equal(cwd, "/work", "resume runs in the session's project cwd");
  assert.deepEqual(args, ["--print", "--session", "sess-42", "--", "do it"]);
});

test("buildPiArgs passes a custom session dir for a session target", () => {
  const task = agentTask("s", { target: { kind: "session", sessionId: "sess-42", cwd: "/work", sessionDir: "/tmp/sess" } });
  const { args } = buildPiArgs(task);
  assert.deepEqual(args, ["--print", "--session", "sess-42", "--session-dir", "/tmp/sess", "--", "do it"]);
});

test("buildPiArgs fails closed for a session target with no frozen cwd", () => {
  // A task persisted before cwd became required must not resume from the
  // daemon's cwd and silently no-op on Pi's cross-project fork prompt.
  const task = agentTask("s", { target: { kind: "session", sessionId: "sess-42" } as unknown as Task["target"] });
  assert.throws(() => buildPiArgs(task), /no frozen cwd/);
});

test("dispatches a due task once and records success", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("a"));
  const { runner, calls } = recordingRunner();
  const daemon = new SchedulerDaemon({
    store, occupancy: new OccupancyRegistry(() => false), runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });
  const first = daemon.tick();
  assert.deepEqual(first.dispatched, ["a"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  const runs = store.listRuns("a");
  assert.equal(runs.at(-1)?.outcome, "success");
  // The one-shot occurrence is consumed; the next tick retires it and
  // dispatches nothing further.
  const second = daemon.tick();
  assert.deepEqual(second.dispatched, []);
  assert.equal(store.getTask("a")?.status, "done");
});

test("does not double-dispatch a task whose run is still in flight", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("a", { schedule: { kind: "interval", everyMs: MIN, anchor } }));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const runner: TaskRunner = async ({ task }) => {
    calls.push(task.id);
    await gate;
    return { outcome: "success" };
  };
  const daemon = new SchedulerDaemon({
    store, occupancy: new OccupancyRegistry(() => false), runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + 5 * MIN,
  });
  daemon.tick();
  daemon.tick(); // second tick while the first run is blocked
  assert.equal(calls.length, 1, "in-flight task is not dispatched twice");
  release();
  await new Promise((r) => setTimeout(r, 5));
});

test("records a failure unacknowledged and notifies once", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("a"));
  const notified: string[] = [];
  const daemon = new SchedulerDaemon({
    store,
    occupancy: new OccupancyRegistry(() => false),
    runner: async () => ({ outcome: "failure", detail: "boom" }),
    piBinary: "/bin/pi",
    concurrency: 5,
    now: () => anchor + MIN,
    onFailure: (task) => notified.push(task.id),
  });
  daemon.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(notified, ["a"]);
  assert.equal(store.unacknowledgedFailures().length, 1);
});

test("no auto-retry: a failed occurrence is consumed, not repeated", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("a", { schedule: { kind: "interval", everyMs: HOUR, anchor } }));
  const { runner, calls } = recordingRunner({ outcome: "failure", detail: "x" });
  const daemon = new SchedulerDaemon({
    store, occupancy: new OccupancyRegistry(() => false), runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + HOUR + MIN,
  });
  daemon.tick();
  await new Promise((r) => setTimeout(r, 5));
  daemon.tick(); // same clock: occurrence already consumed
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1, "failed interval occurrence is not retried at the same time");
});

test("session target is deferred while occupied, then runs when free", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("s", {
    schedule: { kind: "interval", everyMs: HOUR, anchor },
    target: { kind: "session", sessionId: "held", cwd: "/work" },
  }));
  const live = new Set([4242]);
  const occupancy = new OccupancyRegistry((pid) => live.has(pid));
  occupancy.register("held", 4242);
  const { runner, calls } = recordingRunner();
  const daemon = new SchedulerDaemon({
    store, occupancy, runner, piBinary: "/bin/pi", concurrency: 5,
    now: () => anchor + HOUR + MIN,
  });
  const deferred = daemon.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 0, "held session is not run");
  assert.ok(deferred.wakeAt, "a recheck is scheduled");
  // Live Pi exits; the session frees and the next tick runs it.
  live.delete(4242);
  daemon.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.map((c) => c.id), ["s"]);
});

test("runNow refuses a session held by a live Pi, runs it once free", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("s", { target: { kind: "session", sessionId: "held", cwd: "/work" } }));
  const live = new Set([4242]);
  const occupancy = new OccupancyRegistry((pid) => live.has(pid));
  occupancy.register("held", 4242);
  const { runner, calls } = recordingRunner();
  const daemon = new SchedulerDaemon({
    store, occupancy, runner, piBinary: "/bin/pi", concurrency: 5, now: () => anchor,
  });
  const refused = daemon.runNow(store.getTask("s")!);
  assert.equal(refused.started, false);
  assert.match(refused.reason ?? "", /live Pi/);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 0);
  live.delete(4242);
  const ok = daemon.runNow(store.getTask("s")!);
  assert.equal(ok.started, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.map((c) => c.id), ["s"]);
});

test("reconcileCrashed turns an orphaned in-flight run into a recorded failure", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("a"));
  // Simulate a previous daemon that dispatched but died mid-run.
  store.markInflight({ taskId: "a", scheduledTime: anchor, startedAt: anchor, target: "agent", daemonPid: 999999 });
  const { runner } = recordingRunner();
  const daemon = new SchedulerDaemon({
    store, occupancy: new OccupancyRegistry(() => false), runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });
  daemon.reconcileCrashed(() => false); // prior daemon pid is dead
  const runs = store.listRuns("a");
  assert.equal(runs.at(-1)?.outcome, "failure");
  assert.match(runs.at(-1)?.detail ?? "", /daemon exited/);
  assert.deepEqual(store.listInflight(), [], "marker cleared after reconcile");
});

test("reconcileCrashed leaves a live daemon's in-flight marker alone", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("a"));
  store.markInflight({ taskId: "a", scheduledTime: anchor, startedAt: anchor, target: "agent", daemonPid: 4242 });
  const daemon = new SchedulerDaemon({
    store, occupancy: new OccupancyRegistry(() => false), runner: recordingRunner().runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });
  daemon.reconcileCrashed(() => true); // another live daemon owns it
  assert.equal(store.listRuns("a").length, 0, "no failure recorded for a live owner");
  assert.equal(store.listInflight().length, 1, "marker preserved");
});

test("reconcileCrashed is idempotent when the run already recorded an outcome", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("a"));
  // A crash after appendRun landed but before clearInflight: both a success
  // record and the marker exist for the same occurrence.
  store.appendRun({ taskId: "a", scheduledTime: anchor, startedAt: anchor, finishedAt: anchor + 1, outcome: "success", target: "agent" }, anchor + 1);
  store.markInflight({ taskId: "a", scheduledTime: anchor, startedAt: anchor, target: "agent", daemonPid: 999999 });
  const daemon = new SchedulerDaemon({
    store, occupancy: new OccupancyRegistry(() => false), runner: recordingRunner().runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });
  daemon.reconcileCrashed(() => false);
  const runs = store.listRuns("a");
  assert.equal(runs.length, 1, "no duplicate failure appended");
  assert.equal(runs[0]!.outcome, "success");
  assert.deepEqual(store.listInflight(), [], "marker cleared");
});

test("occupied occurrence stages, leases, and records one idempotent delivery", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const task = agentTask("live", {
    target: { kind: "session", sessionId: "sess", cwd: "/work" },
  });
  store.putTask(task);
  const occupancy = new OccupancyRegistry(() => true);
  occupancy.register("sess", 4242, "holder-1", 1);
  const daemon = new SchedulerDaemon({
    store, occupancy, runner: recordingRunner().runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });

  assert.deepEqual(daemon.tick().dispatched, []);
  const [pending] = store.listInjections();
  assert.equal(pending?.phase, "pending");
  assert.equal(pending?.injectionId, `live:${anchor}`);
  assert.equal(store.getTask("live")?.lastScheduledTime, anchor);

  const offer = daemon.pollInjection({ sessionId: "sess", pid: 4242, holderToken: "holder-1", bindingGen: 1 });
  assert.equal(offer?.mode, "append");
  assert.equal(
    offer?.contentDigest,
    createHash("sha256").update(task.prompt).digest("hex"),
  );
  assert.equal(
    daemon.pollInjection({ sessionId: "sess", pid: 4242, holderToken: "wrong", bindingGen: 1 }),
    undefined,
  );
  assert.ok(offer?.mode === "append");
  assert.deepEqual(
    daemon.ackInjection({ injectionId: offer.injectionId, leaseToken: offer.leaseToken, entryId: "entry-1" }),
    { ok: true },
  );
  assert.deepEqual(store.listInjections(), []);
  assert.equal(store.listRuns("live").at(-1)?.outcome, "delivered");
  assert.deepEqual(
    daemon.ackInjection({ injectionId: offer.injectionId, leaseToken: offer.leaseToken, entryId: "entry-1" }),
    { ok: true },
    "a repeated ack is accepted from the durable run record",
  );
  assert.equal(store.listRuns("live").length, 1);
});

test("pending marker hands its frozen prompt to subprocess when the session frees", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("fallback", {
    prompt: "current task prompt",
    target: { kind: "session", sessionId: "sess", cwd: "/work" },
    lastScheduledTime: anchor,
  }));
  store.putInjection({
    injectionId: `fallback:${anchor}`,
    taskId: "fallback",
    scheduledTime: anchor,
    prompt: "frozen marker prompt",
    title: "frozen title",
    sessionId: "sess",
    staleAt: anchor + 10 * MIN,
    phase: "pending",
    createdAt: anchor,
  });
  const prompts: string[] = [];
  const daemon = new SchedulerDaemon({
    store,
    occupancy: new OccupancyRegistry(() => false),
    runner: async ({ task }) => {
      prompts.push(task.prompt);
      return { outcome: "success" };
    },
    piBinary: "/bin/pi",
    concurrency: 5,
    now: () => anchor + MIN,
  });

  assert.deepEqual(daemon.tick().dispatched, ["fallback"]);
  assert.deepEqual(store.listInjections(), [], "handoff clears marker after inflight is durable");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(prompts, ["frozen marker prompt"]);
  assert.equal(store.listRuns("fallback").at(-1)?.outcome, "success");
});

test("drain stops dispatch and converts an active lease to proof-only", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("leased", {
    target: { kind: "session", sessionId: "sess", cwd: "/work" },
  }));
  const occupancy = new OccupancyRegistry(() => true);
  occupancy.register("sess", 4242, "holder-1", 1);
  const { runner, calls } = recordingRunner();
  const daemon = new SchedulerDaemon({
    store, occupancy, runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });

  daemon.tick();
  const append = daemon.pollInjection({
    sessionId: "sess", pid: 4242, holderToken: "holder-1", bindingGen: 1,
  });
  assert.equal(append?.mode, "append");

  daemon.beginDrain();
  store.putTask(agentTask("new", { schedule: { kind: "once", at: anchor + MIN } }));
  assert.equal(daemon.isDraining, true);
  assert.equal(store.listInjectionsForTask("leased")[0]?.phase, "append-uncertain");
  assert.deepEqual(daemon.tick(), { dispatched: [] });
  assert.deepEqual(daemon.runNow(store.getTask("new")!), {
    started: false,
    reason: "daemon is draining",
  });
  assert.equal(
    daemon.pollInjection({ sessionId: "sess", pid: 4242, holderToken: "holder-1", bindingGen: 1 }),
    undefined,
  );
  assert.deepEqual(calls, []);

  const recovered = new SchedulerDaemon({
    store, occupancy, runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });
  const proof = recovered.pollInjection({
    sessionId: "sess", pid: 4242, holderToken: "holder-1", bindingGen: 1,
  });
  assert.equal(proof?.mode, "prove");
});

test("expired lease becomes proof-only and a missing proof records append-lost", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("proof", {
    target: { kind: "session", sessionId: "sess", cwd: "/work" },
  }));
  const occupancy = new OccupancyRegistry(() => true);
  occupancy.register("sess", 4242, "holder-1", 1);
  let now = anchor + MIN;
  const failures: string[] = [];
  const daemon = new SchedulerDaemon({
    store, occupancy, runner: recordingRunner().runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => now,
    onFailure: (_task, record) => failures.push(record.detail ?? ""),
  });
  daemon.tick();
  const append = daemon.pollInjection({ sessionId: "sess", pid: 4242, holderToken: "holder-1", bindingGen: 1 });
  assert.ok(append?.mode === "append");
  now = append.expiresAt;
  daemon.tick();
  const proof = daemon.pollInjection({ sessionId: "sess", pid: 4242, holderToken: "holder-1", bindingGen: 1 });
  assert.equal(proof?.mode, "prove");
  assert.deepEqual(
    daemon.nackInjection({ injectionId: append.injectionId, reason: "not-appended" }),
    { ok: true },
  );
  const run = store.listRuns("proof").at(-1);
  assert.equal(run?.outcome, "failure");
  assert.equal(run?.detail, "injection-append-lost");
  assert.deepEqual(failures, ["injection-append-lost"]);
});

test("reconcile repairs marker watermark and converts a lost lease to proof", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.putTask(agentTask("repair", {
    target: { kind: "session", sessionId: "sess", cwd: "/work" },
  }));
  store.putInjection({
    injectionId: `repair:${anchor}`,
    taskId: "repair",
    scheduledTime: anchor,
    prompt: "do it",
    title: "repair",
    sessionId: "sess",
    staleAt: anchor + 10 * MIN,
    phase: "leased",
    leaseToken: "dead-lease",
    leaseExpiresAt: anchor + 2 * MIN,
    holderPid: 4242,
    holderToken: "holder-1",
    createdAt: anchor,
  });
  const daemon = new SchedulerDaemon({
    store, occupancy: new OccupancyRegistry(() => true), runner: recordingRunner().runner,
    piBinary: "/bin/pi", concurrency: 5, now: () => anchor + MIN,
  });

  daemon.reconcileCrashed(() => false);
  assert.equal(store.getTask("repair")?.lastScheduledTime, anchor);
  assert.equal(store.listInjections()[0]?.phase, "append-uncertain");
});
