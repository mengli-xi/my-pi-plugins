import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CAPACITY_READY_CHANNEL,
  MODEL_CAPACITY_REQUEST_CHANNEL,
  MODEL_CAPACITY_SNAPSHOT_CHANNEL,
  MODEL_CAPACITY_WATCH_CHANNEL,
} from "../src/integration-contracts.ts";
import { ModelCapacityClient } from "../src/model-capacity-client.ts";

class Bus {
  readonly emitted: Array<{ channel: string; payload: unknown }> = [];
  readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  on(channel: string, handler: (payload: unknown) => void): () => void {
    const entries = this.handlers.get(channel) ?? [];
    entries.push(handler);
    this.handlers.set(channel, entries);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = entries.indexOf(handler);
      if (index >= 0) entries.splice(index, 1);
    };
  }

  emit(channel: string, payload: unknown): void {
    this.emitted.push({ channel, payload });
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(payload);
  }
}

const snapshot = (revision: number, sessionId = "session-a", ownerId = "owner-one") => ({
  version: 2,
  ownerId,
  revision,
  sessionId,
  providers: [{ provider: "neutral-capacity", state: "ready" }],
});

function refreshRequest(bus: Bus): { refreshProviders?: string[]; reply(snapshot: unknown, refresh?: unknown): void } {
  return bus.emitted.filter((entry) => entry.channel === MODEL_CAPACITY_REQUEST_CHANNEL).at(-1)?.payload as never;
}

function fresh(revision = 4, ownerId = "owner-one") {
  return {
    ...snapshot(revision, "session-a", ownerId),
    providers: [{ provider: "neutral-capacity", state: "ready", observedAt: 2_000, models: { sol: { loadPercent: 73 } } }],
  };
}

const receipt = {
  version: 2,
  completedAt: 2_001,
  providers: [{ provider: "neutral-capacity", refreshed: true, state: "ready", observedAt: 2_000 }],
};

function watches(bus: Bus): Array<{ version: number; watcherId: string; action: string; providers?: string[]; sessionId?: string }> {
  return bus.emitted.filter((entry) => entry.channel === MODEL_CAPACITY_WATCH_CHANNEL).map((entry) => entry.payload as never);
}

function publishReady(bus: Bus, ownerId = "owner-one", version = 1): void {
  bus.emit(MODEL_CAPACITY_READY_CHANNEL, { version, ownerId });
}

test("one client owns the capacity subscriptions and fans V2 snapshots out locally", () => {
  const bus = new Bus();
  const client = new ModelCapacityClient(bus as never);
  assert.equal(bus.handlers.get(MODEL_CAPACITY_SNAPSHOT_CHANNEL)?.length, 1);
  assert.equal(bus.handlers.get(MODEL_CAPACITY_READY_CHANNEL)?.length, 1);
  client.bindSession("session-a");
  let first = 0;
  let second = 0;
  client.subscribe(() => { first++; });
  client.subscribe(() => { second++; });
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(2));
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(1));
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(3, "session-b"));
  for (const version of [1, 3]) bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, { ...snapshot(99), version });
  assert.equal(client.current()?.revision, 2);
  assert.equal(first, 1);
  assert.equal(second, 1);

  client.request();
  const request = refreshRequest(bus);
  assert.equal((request as { sessionId?: string }).sessionId, "session-a");
  assert.equal((request as unknown as { version: number }).version, 2);
  client.watch("statusline", "acquire", undefined, ["neutral-capacity"]);
  assert.deepEqual(watches(bus)[0]?.providers, ["neutral-capacity"]);
  client.dispose();
  assert.equal(bus.handlers.get(MODEL_CAPACITY_SNAPSHOT_CHANNEL)?.length, 0);
  assert.equal(bus.handlers.get(MODEL_CAPACITY_READY_CHANNEL)?.length, 0);
  assert.equal(watches(bus).at(-1)?.action, "release");
});

test("confirmed refresh resolves only with a matching V2 ready receipt", async () => {
  const bus = new Bus();
  const client = new ModelCapacityClient(bus as never);
  client.bindSession("session-a");
  const refreshing = client.refresh("neutral-capacity");
  const request = refreshRequest(bus);
  assert.deepEqual(request.refreshProviders, ["neutral-capacity"]);
  request.reply(fresh(), receipt);
  const result = await refreshing;
  assert.equal(result.providers[0]?.models?.sol?.loadPercent, 73);
  assert.equal(client.current()?.revision, 4);
  client.dispose();
});

test("disposing the client cancels a pending confirmed refresh and late replies cannot restore it", async () => {
  const bus = new Bus();
  const client = new ModelCapacityClient(bus as never);
  client.bindSession("session-a");
  const pending = client.refresh("neutral-capacity");
  const request = refreshRequest(bus);
  client.dispose();
  request.reply(fresh(), receipt);
  await assert.rejects(pending, /disposed/);
  assert.equal(client.current(), undefined);
});

test("confirmed refresh rejects unsupported owners, failures and inconsistent receipts", async () => {
  for (const [name, refresh] of [
    ["old owner", undefined],
    ["V1 receipt", { ...receipt, version: 1 }],
    ["unknown receipt", { ...receipt, version: 3 }],
    ["failed", {
      version: 2, completedAt: 2_001,
      providers: [{ provider: "neutral-capacity", refreshed: false, state: "stale", observedAt: 1_000, error: "offline" }],
    }],
    ["inconsistent", {
      version: 2, completedAt: 2_001,
      providers: [{ provider: "neutral-capacity", refreshed: true, state: "ready", observedAt: 999 }],
    }],
  ] as const) {
    const bus = new Bus();
    const client = new ModelCapacityClient(bus as never);
    client.bindSession("session-a");
    const promise = client.refresh("neutral-capacity");
    refreshRequest(bus).reply(fresh(), refresh);
    await assert.rejects(promise, name === "failed" ? /offline/ : /confirmed refresh|inconsistent/);
    client.dispose();
  }
});

for (const consumerFirst of [true, false]) {
  test(`watch handshake converges (${consumerFirst ? "consumer" : "owner"} first) and ignores duplicate readiness`, () => {
    const bus = new Bus();
    const installOwner = () => {
      bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (raw) => {
        const request = raw as { version?: number; refreshProviders?: string[]; reply(snapshot: unknown): void };
        if (request.version === 2 && !request.refreshProviders) request.reply(snapshot(2));
      });
      publishReady(bus);
    };
    if (!consumerFirst) installOwner();
    const client = new ModelCapacityClient(bus as never);
    client.bindSession("session-a");
    client.watch("selector", "acquire");
    client.watch("statusline", "acquire", undefined, ["neutral-capacity"]);
    client.request();
    if (consumerFirst) installOwner();
    assert.equal(client.current()?.ownerId, "owner-one");
    assert.equal(watches(bus).filter((watch) => watch.action === "acquire").length, consumerFirst ? 4 : 2);
    publishReady(bus);
    const afterReady = watches(bus).length;
    publishReady(bus);
    publishReady(bus, "untrusted-owner", 99);
    assert.equal(watches(bus).length, afterReady);
    client.dispose();
  });
}

test("new owner resets revision, replays only live watches, and retires old snapshots, ready and replies", async () => {
  const bus = new Bus();
  let current = snapshot(99);
  bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (raw) => {
    const request = raw as { refreshProviders?: string[]; reply(snapshot: unknown): void };
    if (!request.refreshProviders) request.reply(current);
  });
  const client = new ModelCapacityClient(bus as never);
  client.bindSession("session-a");
  client.request();
  client.watch("selector", "acquire");
  client.watch("closed", "acquire");
  client.watch("closed", "release");
  client.watch("statusline", "acquire", undefined, ["neutral-capacity"]);
  const pending = client.refresh("neutral-capacity");
  const oldRequest = refreshRequest(bus);
  const rejected = assert.rejects(pending, /owner changed/);
  const before = watches(bus).length;
  current = snapshot(1, "session-a", "owner-two");
  // Construction can broadcast snapshots before the new owner installs request/watch listeners.
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, current);
  assert.equal(watches(bus).length, before, "replay waits for the listener-ready handshake");
  publishReady(bus, "owner-two");
  await rejected;
  assert.equal(client.current()?.ownerId, "owner-two");
  assert.equal(client.current()?.revision, 1);
  assert.deepEqual(watches(bus).slice(before).map((watch) => watch.watcherId), ["selector", "statusline"]);
  oldRequest.reply(fresh(100), receipt);
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(101));
  publishReady(bus, "owner-one");
  assert.equal(client.current()?.ownerId, "owner-two");
  assert.equal(client.current()?.revision, 1);
  client.dispose();
});

test("owner replacement during a broadcast cannot let the outer retired snapshot or reply roll state back", async () => {
  const bus = new Bus();
  let current = snapshot(1);
  let replacing = false;
  const stopOldOwner = bus.on(MODEL_CAPACITY_SNAPSHOT_CHANNEL, (raw) => {
    if (!replacing || (raw as { ownerId?: string }).ownerId !== "owner-one") return;
    stopOldOwner();
    stopOldOwner();
    current = snapshot(1, "session-a", "owner-two");
    bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, current);
    publishReady(bus, "owner-two");
  });
  bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (raw) => {
    const request = raw as { refreshProviders?: string[]; reply(snapshot: unknown): void };
    if (!request.refreshProviders) request.reply(current);
  });
  const client = new ModelCapacityClient(bus as never);
  client.bindSession("session-a");
  client.request();
  client.watch("view", "acquire");
  const pending = client.refresh("neutral-capacity");
  const oldReply = refreshRequest(bus);
  const rejected = assert.rejects(pending, /owner changed/);
  replacing = true;
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(2));
  await rejected;
  oldReply.reply(fresh(100), receipt);
  assert.equal(client.current()?.ownerId, "owner-two");
  assert.equal(client.current()?.revision, 1);
  assert.equal(watches(bus).filter((watch) => watch.action === "acquire").length, 2);
  client.dispose();
});

test("readiness must be versioned and corroborated by the synchronous owner reply", () => {
  const bus = new Bus();
  const client = new ModelCapacityClient(bus as never);
  client.bindSession("session-a");
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(2));
  client.watch("view", "acquire");
  const before = watches(bus).length;
  publishReady(bus, "unconfirmed-owner");
  publishReady(bus, "owner-one", 2);
  assert.equal(watches(bus).length, before);
  assert.equal(client.current()?.ownerId, "owner-one");
  bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (raw) => (raw as { reply(value: unknown): void }).reply(snapshot(3)));
  publishReady(bus, "wrong-owner");
  assert.equal(watches(bus).length, before);
  assert.equal(client.current()?.ownerId, "owner-one");
  client.dispose();
});

test("session replacement releases watches, rejects refreshes and ignores delayed cache/refresh replies", async () => {
  const bus = new Bus();
  const client = new ModelCapacityClient(bus as never);
  client.bindSession("session-a");
  bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(2));
  client.watch("old-view", "acquire");
  client.request();
  const oldCache = refreshRequest(bus);
  const pending = client.refresh("neutral-capacity");
  const oldRefresh = refreshRequest(bus);
  client.bindSession("session-b");
  await assert.rejects(pending, /session changed/);
  assert.equal(watches(bus).at(-1)?.action, "release");
  assert.equal(watches(bus).at(-1)?.sessionId, "session-a");
  oldCache.reply(snapshot(90));
  oldRefresh.reply(fresh(91), receipt);
  assert.equal(client.current(), undefined);
  let current = snapshot(1, "session-b", "owner-two");
  bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (raw) => (raw as { reply(value: unknown): void }).reply(current));
  const before = watches(bus).length;
  publishReady(bus, "owner-two");
  assert.equal(watches(bus).length, before, "old session watchers are not replayed");
  assert.equal(client.current()?.sessionId, "session-b");
  current = snapshot(2, "session-b", "owner-two");
  client.dispose();
});

test("a confirmed reply cannot switch owners, return an older revision or bypass session validation", async () => {
  for (const [reply, expected] of [
    [fresh(9, "unannounced-owner"), /another owner/],
    [fresh(1), /stale capacity refresh reply/],
    [{ ...fresh(9), sessionId: "session-b" }, /another session/],
    [{ ...fresh(9), version: 1 }, /confirmed refresh/],
  ] as const) {
    const bus = new Bus();
    const client = new ModelCapacityClient(bus as never);
    client.bindSession("session-a");
    bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, snapshot(8));
    const pending = client.refresh("neutral-capacity");
    refreshRequest(bus).reply(reply, receipt);
    await assert.rejects(pending, expected);
    assert.equal(client.current()?.ownerId, "owner-one");
    assert.equal(client.current()?.revision, 8);
    client.dispose();
  }
});
