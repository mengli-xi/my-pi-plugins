import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_CAPACITY_READY_CHANNEL, MODEL_CAPACITY_REGISTER_CHANNEL, MODEL_CAPACITY_REQUEST_CHANNEL,
  MODEL_CAPACITY_WATCH_CHANNEL, isModelCapacitySnapshot, readCapacityRequest, readCapacityWatch,
} from "../src/contracts.ts";
import { registerCapacityAdapter } from "../src/registration.ts";
import type { CapacityAdapter, CapacityAuthContext } from "../src/adapters/shared.ts";
import { ModelCapacityRuntime } from "../src/runtime.ts";

class Bus {
  readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
  on(channel: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? [];
    this.handlers.set(channel, handlers);
    handlers.push(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  }
  emit(channel: string, payload: unknown): void { for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(payload); }
}

function adapter(overrides: Partial<CapacityAdapter> = {}): CapacityAdapter {
  return {
    provider: "neutral-capacity", intervalMs: 30_000, staleMs: 90_000,
    resolveAuth: async () => ({ apiKey: "fixture", headers: {}, fingerprint: "one" }),
    fetch: async () => ({ models: { model: { loadPercent: 25 } } }),
    ...overrides,
  };
}
function context(session = "session-one"): any {
  return {
    sessionManager: { getSessionId: () => session },
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://fixture.invalid", complete: () => assert.fail("execution") }),
      complete: () => assert.fail("execution"),
    },
    ui: { notify: () => assert.fail("UI exposure") },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const integrationFirst of [true, false]) {
  test(`adapter handshake converges (${integrationFirst ? "integration" : "owner"} first), duplicate ready keeps cache`, async () => {
    const bus = new Bus();
    let runtime: ModelCapacityRuntime | undefined;
    if (!integrationFirst) runtime = new ModelCapacityRuntime({ bus, adapters: [] });
    const registration = registerCapacityAdapter(bus, adapter());
    if (integrationFirst) {
      assert.equal(registration.accepted, false);
      runtime = new ModelCapacityRuntime({ bus, adapters: [] });
    }
    assert.equal(registration.accepted, true);
    runtime!.bindContext(context());
    await runtime!.refreshAll();
    const snapshot = runtime!.snapshot();
    bus.emit(MODEL_CAPACITY_READY_CHANNEL, { version: 1, ownerId: snapshot.ownerId });
    assert.deepEqual(runtime!.snapshot(), snapshot);
    registration.dispose();
    assert.equal(runtime!.snapshot().providers.length, 0);
    assert.ok(runtime!.snapshot().revision > snapshot.revision);
    registration.dispose();
    runtime!.dispose();
  });
}

test("registration rejects duplicate providers and unknown protocol versions without replacing data", async () => {
  const bus = new Bus();
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter()] });
  runtime.bindContext(context());
  await runtime.refreshAll();
  const snapshot = runtime.snapshot();
  const errors: string[] = [];
  const conflict = registerCapacityAdapter(bus, adapter(), (error) => errors.push(error));
  assert.equal(conflict.accepted, false);
  assert.match(conflict.error!, /already registered/);
  assert.equal(errors.length, 1);
  assert.deepEqual(runtime.snapshot(), snapshot);
  let replies = 0;
  bus.emit(MODEL_CAPACITY_REGISTER_CHANNEL, { version: 2, adapter: adapter({ provider: "other" }), reply() { replies++; } });
  assert.equal(replies, 0);
  for (const version of [1, 3, undefined]) {
    assert.equal(readCapacityRequest({ version, reply() {} }), undefined);
    assert.equal(readCapacityWatch({ version, watcherId: "view", action: "acquire" }), undefined);
    assert.equal(isModelCapacitySnapshot({ ...snapshot, version }), false);
  }
  assert.equal(isModelCapacitySnapshot({ ...snapshot, ownerId: undefined }), false);
  assert.equal(isModelCapacitySnapshot({ ...snapshot, providers: [...snapshot.providers, ...snapshot.providers] }), false);
  for (const provider of ["", "Bad ID", "../secret", "x".repeat(129)]) {
    assert.equal(readCapacityWatch({ version: 2, watcherId: "view", action: "acquire", providers: [provider] }), undefined);
  }
  conflict.dispose();
  assert.deepEqual(runtime.snapshot(), snapshot, "a rejected lease owns nothing");
  runtime.dispose();
});

test("late adapters join all-provider and targeted watches; release aborts and stale leases cannot remove replacement", async () => {
  const bus = new Bus();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const runtime = new ModelCapacityRuntime({ bus, adapters: [], clock: {
    now: () => 1_000,
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  } });
  runtime.bindContext(context());
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, { version: 2, watcherId: "all", action: "acquire" });
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, { version: 2, watcherId: "targeted", action: "acquire", providers: ["neutral-capacity"] });
  const pending = deferred<{ models: { model: { loadPercent: number } } }>();
  let signal: AbortSignal | undefined;
  const first = registerCapacityAdapter(bus, adapter({ fetch: async (_auth, ctx) => { signal = ctx.signal; return pending.promise; } }));
  await tick();
  assert.equal(runtime.providerSnapshot("neutral-capacity").state, "refreshing");
  assert.equal(timers.size, 1);
  first.dispose();
  assert.equal(signal?.aborted, true);
  assert.equal(timers.size, 0);
  const second = registerCapacityAdapter(bus, adapter());
  await tick();
  assert.equal(runtime.providerSnapshot("neutral-capacity").models?.model?.loadPercent, 25);
  first.dispose();
  pending.resolve({ models: { model: { loadPercent: 99 } } });
  await tick();
  assert.equal(runtime.providerSnapshot("neutral-capacity").models?.model?.loadPercent, 25);
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, { version: 2, watcherId: "all", action: "release" });
  assert.equal(timers.size, 1, "targeted watch still owns polling");
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, { version: 2, watcherId: "targeted", action: "release" });
  assert.equal(timers.size, 0);
  second.dispose();
  runtime.dispose();
});

test("a raw stale release lease cannot delete a newer provider registration", () => {
  const bus = new Bus();
  const runtime = new ModelCapacityRuntime({ bus, adapters: [] });
  let releaseOld: (() => void) | undefined;
  bus.emit(MODEL_CAPACITY_REGISTER_CHANNEL, { version: 1, adapter: adapter(), reply(value: any) { releaseOld = value.release; } });
  assert.equal(typeof releaseOld, "function");
  releaseOld!();
  const replacement = registerCapacityAdapter(bus, adapter());
  releaseOld!();
  assert.equal(runtime.snapshot().providers[0]?.provider, "neutral-capacity");
  replacement.dispose();
  runtime.dispose();
});

test("auth resolution and confirmed receipts cannot survive adapter replacement", async () => {
  const bus = new Bus();
  const runtime = new ModelCapacityRuntime({ bus, adapters: [] });
  runtime.bindContext(context());
  const auth = deferred<{ apiKey: string; headers: {}; fingerprint: string }>();
  let fetches = 0;
  let authSignal: AbortSignal | undefined;
  const first = registerCapacityAdapter(bus, adapter({ resolveAuth: (_ctx, signal) => { authSignal = signal; return auth.promise; }, fetch: async () => { fetches++; return {}; } }));
  let receipt: any;
  bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, { version: 2, refreshProviders: ["neutral-capacity"], reply: (_snapshot: unknown, value: unknown) => { receipt = value; } });
  first.dispose();
  assert.equal(authSignal?.aborted, true);
  const replacement = registerCapacityAdapter(bus, adapter());
  await runtime.refreshAll();
  auth.resolve({ apiKey: "old", headers: {}, fingerprint: "old" });
  await tick();
  assert.equal(fetches, 0);
  assert.equal(receipt.providers[0].refreshed, false);
  assert.equal(runtime.providerSnapshot("neutral-capacity").models?.model?.loadPercent, 25);
  replacement.dispose();
  runtime.dispose();
});

test("external adapters receive observation-only context and cached data is validated, projected and detached", async () => {
  const bus = new Bus();
  let seen: CapacityAuthContext | undefined;
  const data = { models: { model: { loadPercent: 25, rawToken: "private" } }, apiKey: "private" };
  let malformed = false;
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter({
    resolveAuth: async (ctx) => { seen = ctx; return { apiKey: "fixture", headers: {}, fingerprint: "one" }; },
    fetch: async () => malformed ? { models: { model: { quota: { remaining: 101, limit: 100 } } } } : data,
  })] });
  runtime.bindContext(context());
  assert.equal(await runtime.refreshProvider("neutral-capacity"), true);
  assert.deepEqual(Object.keys(seen!), ["modelRegistry"]);
  assert.equal("complete" in seen!.modelRegistry, false);
  assert.deepEqual(seen!.modelRegistry.getProvider("neutral-capacity"), { baseUrl: "https://fixture.invalid" });
  assert.equal(JSON.stringify(runtime.snapshot()).includes("private"), false);
  data.models.model.loadPercent = 99;
  assert.equal(runtime.providerSnapshot("neutral-capacity").models?.model?.loadPercent, 25);
  malformed = true;
  assert.equal(await runtime.refreshProvider("neutral-capacity"), false);
  assert.equal(runtime.providerSnapshot("neutral-capacity").state, "stale");
  assert.equal(runtime.providerSnapshot("neutral-capacity").models?.model?.loadPercent, 25);
  runtime.dispose();
});

test("successful unknown samples replace old quota, and repeated source snapshots do not become fresh", async () => {
  const bus = new Bus();
  let unknown = false;
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter({ staleMs: 10,
    fetch: async () => unknown ? { models: { model: {} }, observedAt: undefined }
      : { windows: [{ kind: "other", label: "Shared", usedPercent: 10, remainingPercent: 90 }], observedAt: 100 },
  })], clock: { now: () => 1_000, setTimeout, clearTimeout } });
  runtime.bindContext(context());
  for (let i = 0; i < 2; i++) {
    await runtime.refreshAll();
    assert.equal(runtime.providerSnapshot("neutral-capacity").state, "stale");
    assert.equal(runtime.providerSnapshot("neutral-capacity").observedAt, 100);
  }
  unknown = true;
  await runtime.refreshAll();
  assert.equal(runtime.providerSnapshot("neutral-capacity").windows, undefined);
  assert.deepEqual(runtime.providerSnapshot("neutral-capacity").models?.model, {});
  runtime.dispose();
});

test("last watcher release invalidates a confirmed follow-up waiting behind an older fetch", async () => {
  const bus = new Bus();
  const pending = deferred<{}>();
  let fetches = 0;
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter({ fetch: async () => { fetches++; return pending.promise; } })] });
  runtime.bindContext(context());
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, { version: 2, watcherId: "view", action: "acquire" });
  await tick();
  const confirmed = runtime.refreshProviderAfterCurrent("neutral-capacity");
  bus.emit(MODEL_CAPACITY_WATCH_CHANNEL, { version: 2, watcherId: "view", action: "release" });
  pending.resolve({});
  assert.equal(await confirmed, false);
  assert.equal(fetches, 1);
  assert.equal(runtime.providerSnapshot("neutral-capacity").state, "unavailable");
  runtime.dispose();
});

test("malformed adapter auth fails closed and clears an older account snapshot", async () => {
  const bus = new Bus();
  let malformed = false;
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter({
    resolveAuth: async () => (malformed ? { apiKey: "fixture", headers: {}, fingerprint: undefined }
      : { apiKey: "fixture", headers: {}, fingerprint: "valid" }) as never,
  })] });
  runtime.bindContext(context());
  assert.equal(await runtime.refreshProvider("neutral-capacity"), true);
  malformed = true;
  assert.equal(await runtime.refreshProvider("neutral-capacity"), false);
  assert.equal(runtime.providerSnapshot("neutral-capacity").state, "error");
  assert.equal(runtime.providerSnapshot("neutral-capacity").models, undefined);
  runtime.dispose();
});

test("one event bus admits only one capacity owner", () => {
  const bus = new Bus();
  const runtime = new ModelCapacityRuntime({ bus, adapters: [] });
  assert.throws(() => new ModelCapacityRuntime({ bus, adapters: [] }), /already active/);
  runtime.dispose();
  new ModelCapacityRuntime({ bus, adapters: [] }).dispose();
});

test("an older auth resolution cannot overwrite a newer account", async () => {
  const bus = new Bus();
  const slow = deferred<{ apiKey: string; headers: {}; fingerprint: string }>();
  let resolutions = 0;
  const runtime = new ModelCapacityRuntime({ bus, adapters: [adapter({
    resolveAuth: async () => ++resolutions === 1 ? slow.promise : { apiKey: "new", headers: {}, fingerprint: "new" },
    fetch: async (auth) => ({ plan: auth.fingerprint }),
  })] });
  runtime.bindContext(context());
  const older = runtime.refreshProvider("neutral-capacity");
  assert.equal(await runtime.refreshProvider("neutral-capacity"), true);
  slow.resolve({ apiKey: "old", headers: {}, fingerprint: "old" });
  assert.equal(await older, false);
  assert.equal(runtime.providerSnapshot("neutral-capacity").plan, "new");
  runtime.dispose();
});

test("owner replacement re-admits integrations; session rebinding clears cache and pending auth", async () => {
  const bus = new Bus();
  const registration = registerCapacityAdapter(bus, adapter());
  const first = new ModelCapacityRuntime({ bus, adapters: [] });
  first.bindContext(context());
  await first.refreshAll();
  const owner = first.snapshot().ownerId;
  first.dispose();
  assert.deepEqual(first.snapshot().providers, []);
  const next = new ModelCapacityRuntime({ bus, adapters: [] });
  assert.notEqual(next.snapshot().ownerId, owner);
  next.bindContext(context());
  await next.refreshAll();
  assert.equal(next.providerSnapshot("neutral-capacity").state, "ready");
  next.bindContext(context("session-two"));
  assert.equal(next.providerSnapshot("neutral-capacity").state, "unavailable");
  assert.equal(next.watcherCount(), 0);
  registration.dispose();
  next.dispose();
});
