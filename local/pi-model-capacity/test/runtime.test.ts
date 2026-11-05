import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_CAPACITY_REQUEST_CHANNEL,
  MODEL_CAPACITY_SNAPSHOT_CHANNEL,
  MODEL_CAPACITY_WATCH_CHANNEL,
  type ModelCapacitySnapshotV2,
} from "../src/contracts.ts";
import type { CapacityAdapter, ResolvedCapacityAuth } from "../src/adapters/shared.ts";
import { ModelCapacityRuntime } from "../src/runtime.ts";

class TestBus {
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  on(channel: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? [];
    handlers.push(handler);
    this.handlers.set(channel, handlers);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  }

  emit(channel: string, payload: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(payload);
  }
}

class TestClock {
  value = 1_000;
  nextId = 1;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  now(): number { return this.value; }
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { callback, delayMs });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }
  run(delayMs: number): void {
    const entry = [...this.timers.entries()].find(([, timer]) => timer.delayMs === delayMs);
    assert.ok(entry, `missing ${delayMs}ms timer`);
    this.timers.delete(entry[0]);
    this.value += delayMs;
    entry[1].callback();
  }
}

function auth(key: string): ResolvedCapacityAuth {
  return { apiKey: key, headers: {}, fingerprint: `fp:${key}` };
}

function context(): any {
  return {
    sessionManager: { getSessionId: () => "session-1" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("consumer-first broadcast and owner-first request/reply both converge", async () => {
  const bus = new TestBus();
  const broadcasts: ModelCapacitySnapshotV2[] = [];
  bus.on(MODEL_CAPACITY_SNAPSHOT_CHANNEL, (payload) => broadcasts.push(payload as ModelCapacitySnapshotV2));
  const adapter: CapacityAdapter = {
    provider: "fixture-gateway",
    intervalMs: 5_000,
    staleMs: 15_000,
    resolveAuth: async () => auth("a"),
    fetch: async () => ({ models: { sol: { loadPercent: 50, quota: { remaining: 9, limit: 10 } } } }),
  };
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter] });
  runtime.bindContext(context());
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2, watcherId: "selector", action: "acquire", sessionId: "session-1",
  });
  await tick();
  assert.equal(broadcasts.at(-1)?.providers[0]?.models?.sol?.loadPercent, 50);

  let reply: ModelCapacitySnapshotV2 | undefined;
  bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
    version: 2,
    sessionId: "session-1",
    reply: (snapshot: ModelCapacitySnapshotV2) => { reply = snapshot; },
  });
  assert.equal(reply?.providers[0]?.state, "ready");
  assert.equal(Object.isFrozen(reply), true);
  assert.equal(Object.isFrozen(reply?.providers), true);
  assert.equal(Object.isFrozen(reply?.providers[0]?.models), true);
  assert.equal(Object.isFrozen(reply?.providers[0]?.models?.sol?.quota), true);
  runtime.dispose();
});

test("refresh request waits for a post-request provider fetch before replying", async () => {
  const bus = new TestBus();
  const clock = new TestClock();
  const first = deferred<{ models: { sol: { loadPercent: number } } }>();
  const followUp = deferred<{ models: { sol: { loadPercent: number } } }>();
  let fetches = 0;
  const adapter: CapacityAdapter = {
    provider: "fixture-gateway",
    intervalMs: 5_000,
    staleMs: 15_000,
    resolveAuth: async () => auth("a"),
    fetch: async () => {
      fetches++;
      return fetches === 1 ? first.promise : followUp.promise;
    },
  };
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter], clock });
  runtime.bindContext(context());
  const background = runtime.refreshProvider("fixture-gateway");
  await tick();
  assert.equal(fetches, 1);
  type Reply = { snapshot: ModelCapacitySnapshotV2; refresh?: { providers: Array<{ refreshed: boolean; observedAt?: number }> } };
  const replies = [deferred<Reply>(), deferred<Reply>()];
  let replyCount = 0;
  for (const reply of replies) {
    bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
      version: 2,
      sessionId: "session-1",
      refreshProviders: ["fixture-gateway"],
      reply: (snapshot: ModelCapacitySnapshotV2, refresh?: { providers: Array<{ refreshed: boolean; observedAt?: number }> }) => {
        replyCount++;
        reply.resolve({ snapshot, refresh });
      },
    });
  }
  await tick();
  assert.equal(fetches, 1, "click requests first wait for the already-running poll");
  assert.equal(replyCount, 0, "reply waits for the provider fetch");
  first.resolve({ models: { sol: { loadPercent: 10 } } });
  await background;
  await tick();
  assert.equal(fetches, 2, "click requests trigger one deduplicated follow-up refresh");
  assert.equal(replyCount, 0, "the pre-click poll cannot satisfy confirmed refresh");
  followUp.resolve({ models: { sol: { loadPercent: 73 } } });
  const results = await Promise.all(replies.map((reply) => reply.promise));
  assert.equal(results.length, 2);
  for (const reply of results) {
    assert.equal(reply.snapshot.providers[0]?.models?.sol?.loadPercent, 73);
    assert.deepEqual(reply.refresh?.providers, [{
      provider: "fixture-gateway",
      refreshed: true,
      state: "ready",
      observedAt: 1_000,
    }]);
  }
  runtime.dispose();
});

test("refresh request reports failure while retaining stale data", async () => {
  const bus = new TestBus();
  let fail = false;
  const adapter: CapacityAdapter = {
    provider: "fixture-gateway",
    intervalMs: 5_000,
    staleMs: 15_000,
    resolveAuth: async () => auth("a"),
    fetch: async () => {
      if (fail) throw new Error("gateway offline");
      return { models: { sol: { loadPercent: 42 } } };
    },
  };
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter] });
  runtime.bindContext(context());
  await runtime.refreshProvider("fixture-gateway");
  fail = true;
  let reply: any;
  bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
    version: 2,
    sessionId: "session-1",
    refreshProviders: ["fixture-gateway"],
    reply: (snapshot: ModelCapacitySnapshotV2, refresh: unknown) => { reply = { snapshot, refresh }; },
  });
  await tick();
  assert.equal(reply.snapshot.providers[0].state, "stale");
  assert.equal(reply.snapshot.providers[0].models.sol.loadPercent, 42);
  assert.equal(reply.refresh.providers[0].refreshed, false);
  assert.equal(reply.refresh.providers[0].state, "stale");
  assert.match(reply.refresh.providers[0].error, /gateway offline/);
  runtime.dispose();
});

test("watch acquire refreshes immediately, deduplicates fetches, and release clears timers", async () => {
  const bus = new TestBus();
  const clock = new TestClock();
  const pending = deferred<Record<string, never>>();
  let fetches = 0;
  const adapter: CapacityAdapter = {
    provider: "fixture-gateway",
    intervalMs: 5_000,
    staleMs: 15_000,
    resolveAuth: async () => auth("a"),
    fetch: async () => { fetches++; return pending.promise; },
  };
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter], clock });
  runtime.bindContext(context());
  const acquire = { version: 2, watcherId: "selector", action: "acquire", sessionId: "session-1" };
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, acquire);
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, acquire);
  await tick();
  assert.equal(fetches, 1);
  assert.equal(runtime.watcherCount(), 1);
  assert.equal(clock.timers.size, 1);
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2, watcherId: "selector", action: "release", sessionId: "session-1",
  });
  assert.equal(runtime.watcherCount(), 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(runtime.providerSnapshot("fixture-gateway").state, "unavailable");
  pending.resolve({});
  await tick();
  assert.equal(runtime.providerSnapshot("fixture-gateway").state, "unavailable", "aborted work cannot republish");
  runtime.dispose();
});

test("release during auth resolution prevents the network request from starting", async () => {
  const bus = new TestBus();
  const resolving = deferred<ResolvedCapacityAuth | undefined>();
  let fetches = 0;
  const adapter: CapacityAdapter = {
    provider: "fixture-gateway",
    intervalMs: 5_000,
    staleMs: 15_000,
    resolveAuth: async () => resolving.promise,
    fetch: async () => { fetches++; return {}; },
  };
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter] });
  runtime.bindContext(context());
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2, watcherId: "selector", action: "acquire", sessionId: "session-1",
  });
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2, watcherId: "selector", action: "release", sessionId: "session-1",
  });
  resolving.resolve(auth("a"));
  await tick();
  assert.equal(fetches, 0);
  runtime.dispose();
});

test("same-credential failures retain stale data but credential changes clear it before fetch", async () => {
  const bus = new TestBus();
  let key = "a";
  let mode: "ok" | "fail" | "pending" = "ok";
  const next = deferred<Record<string, never>>();
  const adapter: CapacityAdapter = {
    provider: "fixture-gateway",
    intervalMs: 5_000,
    staleMs: 15_000,
    resolveAuth: async () => auth(key),
    fetch: async (resolved) => {
      if (mode === "fail") throw new Error("offline");
      if (mode === "pending") return next.promise;
      return { models: { sol: { loadPercent: resolved.apiKey === "a" ? 10 : 20 } } };
    },
  };
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter] });
  runtime.bindContext(context());
  await runtime.refreshProvider("fixture-gateway");
  assert.equal(runtime.providerSnapshot("fixture-gateway").models?.sol?.loadPercent, 10);

  mode = "fail";
  await runtime.refreshProvider("fixture-gateway");
  const stale = runtime.providerSnapshot("fixture-gateway");
  assert.equal(stale.state, "stale");
  assert.equal(stale.models?.sol?.loadPercent, 10);

  key = "b";
  mode = "pending";
  const refreshing = runtime.refreshProvider("fixture-gateway");
  await tick();
  const isolated = runtime.providerSnapshot("fixture-gateway");
  assert.equal(isolated.state, "refreshing");
  assert.equal(isolated.models, undefined, "old-account values must not cross credential fingerprints");
  next.resolve({});
  await refreshing;
  runtime.dispose();
});

test("staleAfter changes materialized ready snapshots to stale without polling", async () => {
  const bus = new TestBus();
  const clock = new TestClock();
  const adapter: CapacityAdapter = {
    provider: "fixture-gateway",
    intervalMs: 5_000,
    staleMs: 15_000,
    resolveAuth: async () => auth("a"),
    fetch: async () => ({ models: { sol: { loadPercent: 1 } } }),
  };
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter], clock });
  runtime.bindContext(context());
  await runtime.refreshProvider("fixture-gateway");
  assert.equal(runtime.providerSnapshot("fixture-gateway").state, "ready");
  clock.value += 15_001;
  assert.equal(runtime.providerSnapshot("fixture-gateway").state, "stale");
  runtime.dispose();
});

test("provider-scoped watches refresh only their union and release providers independently", async () => {
  const bus = new TestBus();
  const clock = new TestClock();
  const fetches = new Map<string, number>();
  const adapter = (provider: "fixture-gateway" | "openai-codex"): CapacityAdapter => ({
    provider,
    intervalMs: provider === "fixture-gateway" ? 5_000 : 30_000,
    staleMs: 90_000,
    resolveAuth: async () => auth(provider),
    fetch: async () => {
      fetches.set(provider, (fetches.get(provider) ?? 0) + 1);
      return {};
    },
  });
  const runtime = new ModelCapacityRuntime({
    bus,
    adapters: [adapter("fixture-gateway"), adapter("openai-codex")],
    clock,
  });
  runtime.bindContext(context());
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2,
    watcherId: "statusline",
    action: "acquire",
    sessionId: "session-1",
    providers: ["fixture-gateway"],
  });
  await tick();
  assert.deepEqual(Object.fromEntries(fetches), { "fixture-gateway": 1 });
  assert.deepEqual([...clock.timers.values()].map((timer) => timer.delayMs), [5_000]);

  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2,
    watcherId: "selector",
    action: "acquire",
    sessionId: "session-1",
  });
  await tick();
  assert.equal(fetches.get("openai-codex"), 1);
  assert.deepEqual([...clock.timers.values()].map((timer) => timer.delayMs).sort((a, b) => a - b), [5_000, 30_000]);

  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2,
    watcherId: "selector",
    action: "release",
    sessionId: "session-1",
  });
  assert.deepEqual([...clock.timers.values()].map((timer) => timer.delayMs), [5_000]);
  runtime.dispose();
});

test("wrong-session requests and watches fail closed", () => {
  const bus = new TestBus();
  const runtime = new ModelCapacityRuntime({ bus, adapters: [] });
  runtime.bindContext(context());
  let replied = false;
  bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
    version: 2, sessionId: "other", reply: () => { replied = true; },
  });
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
    version: 2, watcherId: "selector", action: "acquire", sessionId: "other",
  });
  assert.equal(replied, false);
  assert.equal(runtime.watcherCount(), 0);
  runtime.dispose();
});
