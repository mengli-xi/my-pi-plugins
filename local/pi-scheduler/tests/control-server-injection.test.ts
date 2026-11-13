import { schedulerPaths } from "../src/paths.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ping, request } from "../src/client.ts";
import { startControlServer, type ControlServerOptions } from "../src/control-server.ts";
import { OccupancyRegistry } from "../src/occupancy.ts";
import { SchedulerStore } from "../src/store.ts";
import type { InjectionOffer } from "../src/protocol.ts";
import type { Task } from "../src/task.ts";

const NOW = Date.UTC(2026, 0, 1);

function task(id = "task-1"): Task {
  return {
    id,
    title: "Test",
    prompt: "do it",
    schedule: { kind: "once", at: NOW + 60_000 },
    timeZone: "UTC",
    toleranceMs: 60_000,
    target: { kind: "session", sessionId: "s", cwd: "/work" },
    status: "active",
    createdAt: NOW,
    origin: "agent",
  };
}

async function withServer(
  configure: (base: Omit<ControlServerOptions, "socketPath">) => Omit<ControlServerOptions, "socketPath">,
  run: (context: { socketPath: string; store: SchedulerStore; occupancy: OccupancyRegistry }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-scheduler-control-"));
  const socketPath = schedulerPaths(root).socket;
  const store = new SchedulerStore(join(root, "store"));
  store.init();
  const occupancy = new OccupancyRegistry({ alive: () => true });
  const base: Omit<ControlServerOptions, "socketPath"> = {
    store,
    occupancy,
    onMutate: () => {},
    onRunNow: () => ({ started: true }),
    onDaemonStatus: () => ({ buildId: "test-build", draining: false }),
    onDaemonUpdate: () => {},
    now: () => NOW,
  };
  const server = startControlServer({ socketPath, ...configure(base) });
  if (!server.listening) await once(server, "listening");
  try {
    await run({ socketPath, store, occupancy });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test("the control socket is private to the profile owner", async () => {
  await withServer(base => base, async ({ socketPath }) => {
    assert.equal(statSync(socketPath).mode & 0o777, 0o600, "another local user cannot drive this daemon");
    assert.equal(await ping(socketPath), true, "the owner can still connect");
  });
});

test("daemon status reports build identity and update starts drain", async () => {
  let draining = false;
  let updates = 0;
  await withServer(
    (base) => ({
      ...base,
      onDaemonStatus: () => ({ buildId: "build-42", draining }),
      onDaemonUpdate: () => {
        updates++;
        draining = true;
      },
    }),
    async ({ socketPath }) => {
      assert.deepEqual(
        await request({ type: "daemon.status" }, { socketPath }),
        { ok: true, type: "daemon-status", buildId: "build-42", draining: false },
      );
      assert.deepEqual(
        await request({ type: "daemon.update" }, { socketPath }),
        { ok: true, type: "ack" },
      );
      assert.deepEqual(
        await request({ type: "daemon.status" }, { socketPath }),
        { ok: true, type: "daemon-status", buildId: "build-42", draining: true },
      );
      assert.equal(updates, 1);
    },
  );
});

test("injection poll validates the unique tokenful holder and returns append/prove offers", async () => {
  let mutations = 0;
  const offers: InjectionOffer[] = [
    {
      mode: "append",
      injectionId: "task-1:1",
      taskId: "task-1",
      title: "Test",
      prompt: "do it",
      contentDigest: "digest",
      scheduledTime: 1,
      leaseToken: "lease",
      expiresAt: NOW + 30_000,
    },
    {
      mode: "prove",
      injectionId: "task-1:2",
      taskId: "task-1",
      title: "Test",
      prompt: "do it",
      contentDigest: "digest",
      scheduledTime: 2,
    },
  ];
  let polls = 0;
  await withServer(
    (base) => ({
      ...base,
      onMutate: () => { mutations++; },
      onInjectionPoll: () => offers[polls++],
    }),
    async ({ socketPath }) => {
      await request({
        type: "occupancy.register",
        sessionId: "s",
        pid: 10,
        holderToken: "holder",
        bindingGen: 1,
      }, { socketPath });
      const before = mutations;
      const stale = await request({
        type: "injection.poll",
        sessionId: "s",
        pid: 10,
        holderToken: "stale",
        bindingGen: 1,
      }, { socketPath });
      assert.deepEqual(stale, { ok: false, error: "not unique live session holder", holderRejection: "token-mismatch" });
      assert.equal(polls, 0);
      assert.equal(mutations, before);

      const append = await request({
        type: "injection.poll",
        sessionId: "s",
        pid: 10,
        holderToken: "holder",
        bindingGen: 1,
      }, { socketPath });
      assert.ok(append.ok && append.type === "injection" && append.injection?.mode === "append");
      assert.equal(append.ok && append.type === "injection" && append.injection?.leaseToken, "lease");

      const prove = await request({
        type: "injection.poll",
        sessionId: "s",
        pid: 10,
        holderToken: "holder",
        bindingGen: 1,
      }, { socketPath });
      assert.ok(prove.ok && prove.type === "injection" && prove.injection?.mode === "prove");
      if (prove.ok && prove.type === "injection" && prove.injection?.mode === "prove") {
        assert.equal("leaseToken" in prove.injection, false);
      }
      assert.equal(mutations, before + 2);
    },
  );
});

test("injection ack and nack forward optional lease tokens and reschedule only on success", async () => {
  const seen: unknown[] = [];
  let mutations = 0;
  await withServer(
    (base) => ({
      ...base,
      onMutate: () => { mutations++; },
      onInjectionAck: (message) => {
        seen.push(message);
        return message.entryId === "bad"
          ? { ok: false, error: "stale-lease" }
          : { ok: true };
      },
      onInjectionNack: (message) => {
        seen.push(message);
        return { ok: true };
      },
    }),
    async ({ socketPath }) => {
      const ack = await request({
        type: "injection.ack",
        injectionId: "i-1",
        entryId: "e-1",
      }, { socketPath });
      assert.deepEqual(ack, { ok: true, type: "ack" });
      const nack = await request({
        type: "injection.nack",
        injectionId: "i-2",
        leaseToken: "lease",
        reason: "append-unknown",
      }, { socketPath });
      assert.deepEqual(nack, { ok: true, type: "ack" });
      const failed = await request({
        type: "injection.ack",
        injectionId: "i-3",
        leaseToken: "stale",
        entryId: "bad",
      }, { socketPath });
      assert.deepEqual(failed, { ok: false, error: "stale-lease" });
      assert.equal(mutations, 2);
      assert.deepEqual(seen, [
        { type: "injection.ack", injectionId: "i-1", entryId: "e-1" },
        { type: "injection.nack", injectionId: "i-2", leaseToken: "lease", reason: "append-unknown" },
        { type: "injection.ack", injectionId: "i-3", leaseToken: "stale", entryId: "bad" },
      ]);
    },
  );
});

test("active injection marker rejects every task mutation", async () => {
  await withServer(
    (base) => base,
    async ({ socketPath, store }) => {
      store.putTask(task());
      store.putInjection({
        injectionId: "task-1:1",
        taskId: "task-1",
        scheduledTime: 1,
        prompt: "do it",
        title: "Test",
        sessionId: "s",
        staleAt: NOW + 60_000,
        phase: "pending",
        createdAt: NOW,
      });
      const duplicateCreate = await request({ type: "task.create", task: { ...task(), title: "overwrite" } }, { socketPath });
      assert.deepEqual(duplicateCreate, { ok: false, error: "task already exists: task-1" });
      const requests = [
        { type: "task.update", id: "task-1", patch: { title: "changed" } },
        { type: "task.delete", id: "task-1" },
        { type: "task.pause", id: "task-1" },
        { type: "task.resume", id: "task-1" },
        { type: "task.runNow", id: "task-1" },
      ] as const;
      for (const body of requests) {
        const reply = await request(body, { socketPath });
        assert.deepEqual(reply, { ok: false, error: "task has active injection occurrence" });
      }
      assert.equal(store.getTask("task-1")?.title, "Test");
      assert.equal(store.listInjectionsForTask("task-1").length, 1);
    },
  );
});
