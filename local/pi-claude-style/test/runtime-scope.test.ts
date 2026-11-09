import assert from "node:assert/strict";
import test from "node:test";
import {
  installRuntimeModule,
  loadRuntimeModuleOnFirstUse,
  RuntimeScope,
} from "../src/runtime-scope.ts";

function context() {
  return { hasUI: true, mode: "tui", ui: { theme: {} } } as never;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("runtime phase and context belong to one factory invocation", async () => {
  const runtime = new RuntimeScope();
  assert.equal(runtime.phase, "created");
  runtime.beginEagerInstall();
  runtime.markReady();
  assert.equal(runtime.phase, "ready");
  const generation = runtime.bindSession(context());
  assert.equal(generation, 1);
  assert.equal(runtime.phase, "session-bound");
  runtime.markActive();
  assert.equal(runtime.phase, "active");
  await runtime.dispose("reload");
  assert.equal(runtime.phase, "disposed");
  assert.equal(runtime.contextSnapshot, undefined);
  assert.equal(runtime.lifecycle.isClosed, true);
});

test("runtime modules deduplicate one in-flight load", async () => {
  const runtime = new RuntimeScope();
  runtime.bindSession(context());
  const pending = deferred<{ name: string }>();
  let loads = 0;
  let accepts = 0;
  const module = runtime.module<{ name: string }>("overlay");
  const load = () => { loads++; return pending.promise; };
  const first = module.load(load, () => { accepts++; });
  const second = module.load(load, () => { accepts++; });
  assert.equal(first, second);
  assert.equal(module.state, "loading");
  pending.resolve({ name: "overlay" });
  assert.deepEqual(await first, { name: "overlay" });
  assert.equal(loads, 1);
  assert.equal(accepts, 1);
  assert.equal(module.state, "ready");
});

test("a module finishing after shutdown cannot install into the old runtime", async () => {
  const runtime = new RuntimeScope();
  runtime.bindSession(context());
  const pending = deferred<string>();
  let accepted = false;
  const module = runtime.module<string>("doctor");
  const result = module.load(() => pending.promise, () => { accepted = true; });
  await runtime.dispose("fork");
  pending.resolve("loaded");
  assert.equal(await result, undefined);
  assert.equal(accepted, false);
  assert.equal(module.state, "disposed");
});

test("a session generation change discards a stale module continuation", async () => {
  const runtime = new RuntimeScope();
  runtime.bindSession(context());
  const pending = deferred<string>();
  let accepted = false;
  const module = runtime.module<string>("session-info");
  const result = module.load(() => pending.promise, () => { accepted = true; });
  runtime.bindSession(context());
  pending.resolve("loaded");
  assert.equal(await result, undefined);
  assert.equal(accepted, false);
  assert.equal(module.state, "idle");
});

test("installer failures remain observable and are cached as failed", async () => {
  const runtime = new RuntimeScope();
  const failure = new Error("install failed");
  const module = runtime.module<boolean>("broken");
  let loads = 0;
  await assert.rejects(
    module.load(async () => { loads++; return true; }, () => { throw failure; }),
    failure,
  );
  assert.equal(module.state, "failed");
  assert.equal(module.error, failure);
  await assert.rejects(
    module.load(async () => { loads++; return true; }, () => {}),
    failure,
  );
  assert.equal(loads, 1, "a failed module retries only in a replacement runtime");
});

test("first-use loading records import, wait, cache, and deduplicated requests", async () => {
  const runtime = new RuntimeScope();
  runtime.bindSession(context());
  const pending = deferred<{ loaded: true }>();
  const increments: string[] = [];
  const measures: string[] = [];
  const observability = {
    increment(name: string) { increments.push(name); },
    async measureAsync<T>(name: string, action: () => Promise<T>) {
      measures.push(name);
      return action();
    },
  };
  let imports = 0;
  const loader = () => { imports++; return pending.promise; };
  const first = loadRuntimeModuleOnFirstUse(runtime, "overlay", loader, observability);
  const second = loadRuntimeModuleOnFirstUse(runtime, "overlay", loader, observability);
  pending.resolve({ loaded: true });
  assert.deepEqual(await first, { loaded: true });
  assert.deepEqual(await second, { loaded: true });
  assert.equal(imports, 1);
  assert.ok(increments.includes("cc-style.loading.overlay.deduplicated"));
  assert.equal(measures.filter((name) => name.endsWith(".import")).length, 1);
  assert.equal(measures.filter((name) => name.endsWith(".wait")).length, 2);

  await loadRuntimeModuleOnFirstUse(runtime, "overlay", loader, observability);
  assert.ok(increments.includes("cc-style.loading.overlay.cache-hit"));
  assert.equal(imports, 1);
});

test("first-use loading reports a discarded continuation after session replacement", async () => {
  const runtime = new RuntimeScope();
  runtime.bindSession(context());
  const pending = deferred<string>();
  const increments: string[] = [];
  const observability = {
    increment(name: string) { increments.push(name); },
    async measureAsync<T>(_name: string, action: () => Promise<T>) { return action(); },
  };
  const result = loadRuntimeModuleOnFirstUse(runtime, "overlay", () => pending.promise, observability);
  runtime.bindSession(context());
  pending.resolve("stale");
  assert.equal(await result, undefined);
  assert.ok(increments.includes("cc-style.loading.overlay.discarded"));
});

test("all loading modes keep Tier-0 installation generation-guarded", async () => {
  for (const mode of ["balanced", "eager", "minimal"] as const) {
    const runtime = new RuntimeScope();
    let installed = 0;
    const result = await installRuntimeModule(
      runtime,
      mode,
      "feature",
      async () => ({ feature: true }),
      () => { installed++; },
    );
    assert.deepEqual(result, { feature: true });
    assert.equal(installed, 1);
    assert.deepEqual(
      runtime.moduleStates(),
      { feature: "ready" },
    );
  }
});

test("markReady cannot regress an already active session", () => {
  const runtime = new RuntimeScope();
  runtime.bindSession(context());
  runtime.markActive();
  runtime.markReady();
  assert.equal(runtime.phase, "active");
});
