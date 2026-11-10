import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSearchChildFactory } from "../extensions/child.ts";
import { installSearch, SEARCH_BACKENDS_REQUEST_V1, type SearchBackendV1, type SearchConfig } from "../extensions/index.ts";

function eventBus() {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  return {
    emit(channel: string, payload: unknown) { for (const listener of listeners.get(channel) ?? []) listener(payload); },
    on(channel: string, listener: (payload: any) => void) {
      const entries = listeners.get(channel) ?? new Set(); listeners.set(channel, entries); entries.add(listener);
      return () => { entries.delete(listener); };
    },
  };
}

function fixture(child: boolean, searchBackend?: string) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-search-backends-"));
  const parentEvents = eventBus(), childEvents = eventBus();
  const tools = new Map<string, any>();
  const config: SearchConfig = { enabled: true, searchEnabled: true, fetchEnabled: true,
    providerOverrides: { "fixture-provider": { searchBackend } } };
  const pi = { events: child ? childEvents : parentEvents,
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, on() {},
  };
  const ctx = { cwd: agentDir, model: { provider: "fixture-provider", id: "fixture-model" },
    modelRegistry: {
      getAll() { throw new Error("internal configuration must not be discovered by public Search"); },
      getApiKeyForProvider() { throw new Error("unregistered providers must not resolve credentials"); },
    },
  };
  const install = () => child
    ? createSearchChildFactory(config, { backendEvents: parentEvents })(pi as never)
    : installSearch(pi as never, { child: false, config, agentDir });
  const originalFetch = globalThis.fetch;
  let ddgCalls = 0, ddgFailure = false;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
    ddgCalls++;
    if (ddgFailure) throw new Error("fixture DDG unavailable");
    return new Response('<a class="result__a" href="https://fixture.invalid/result">Public fallback</a>');
  };
  return { install, parentEvents, childEvents, ctx,
    search: (signal?: AbortSignal) => tools.get("web_search").execute("call", { query: "fixture query" }, signal, undefined, ctx),
    register(backend: unknown) { return parentEvents.on(SEARCH_BACKENDS_REQUEST_V1, request => request.contribute(backend)); },
    ddgCalls: () => ddgCalls, failDdg() { ddgFailure = true; },
    restore() { globalThis.fetch = originalFetch; rmSync(agentDir, { recursive: true, force: true }); },
  };
}

for (const child of [false, true]) for (const backendFirst of [false, true]) {
  test(`${child ? "child with approved Main bus" : "Main"}: ${backendFirst ? "backend" : "Search"} loads first, unload and re-register`, async () => {
    const f = fixture(child);
    const backend: SearchBackendV1 = { version: 1, id: "fixture-backend", label: "Fixture", defaultProviders: ["fixture-provider"],
      async search({ query, ctx }) { assert.equal(ctx, f.ctx); return `Optional result: ${query}`; } };
    try {
      let release: () => void;
      if (backendFirst) { release = f.register(backend); f.install(); }
      else { f.install(); assert.match((await f.search()).content[0].text, /Public fallback/); release = f.register(backend); }
      assert.equal((await f.search()).content[0].text, "Optional result: fixture query");
      release(); release();
      assert.match((await f.search()).content[0].text, /Public fallback/);
      const nextRelease = f.register(backend);
      release();
      assert.equal((await f.search()).details.method, "native", "stale unsubscribe cannot clear replacement");
      nextRelease();
      const before = f.ddgCalls();
      assert.equal((await f.search()).details.method, "ddg");
      assert.equal(f.ddgCalls(), before + 1);
    } finally { f.restore(); }
  });
}

for (const child of [false, true]) {
  test(`${child ? "child" : "Main"} without optional backend never probes config/auth or sends private traffic`, async () => {
    const f = fixture(child, "unknown-private-backend");
    try { f.install(); assert.equal((await f.search()).details.method, "ddg"); assert.equal(f.ddgCalls(), 1); }
    finally { f.restore(); }
  });
  test(`${child ? "child" : "Main"} selects explicit backend ID and preserves both failure contexts`, async () => {
    const f = fixture(child, "explicit-backend");
    try {
      f.install();
      f.register({ version: 1, id: "explicit-backend", label: "Fixture", defaultProviders: [],
        async search() { throw new Error("fixture native unavailable"); } });
      assert.match((await f.search()).content[0].text, /Native failed \(fixture native unavailable\), used DuckDuckGo/);
      f.failDdg();
      await assert.rejects(f.search(), /Native fixture-provider search failed: fixture native unavailable; DuckDuckGo fallback failed: fixture DDG unavailable/);
    } finally { f.restore(); }
  });
}

for (const conflict of ["id", "provider", "malformed"] as const) {
  test(`${conflict} discovery conflict fails before execution or network`, async () => {
    const f = fixture(true);
    try {
      f.install();
      const backend = { version: 1, id: "fixture-backend", label: "Fixture", defaultProviders: ["fixture-provider"],
        async search() { throw new Error("must not execute an ambiguous backend"); } };
      f.register(backend);
      f.register(conflict === "malformed" ? { ...backend, version: 2 } :
        { ...backend, id: conflict === "id" ? backend.id : "second-backend" });
      await assert.rejects(f.search(), /Search backend (conflict|discovery)/);
      assert.equal(f.ddgCalls(), 0, "conflicts must not silently downgrade to DDG");
    } finally { f.restore(); }
  });
}

for (const outcome of ["late success", "late failure"] as const) {
  test(`cancelled optional backend ${outcome} is not success and never starts DDG`, async () => {
    const f = fixture(true);
    const controller = new AbortController();
    try {
      f.install();
      f.register({ version: 1, id: "cancelled", label: "Fixture", defaultProviders: ["fixture-provider"],
        async search() {
          controller.abort(new Error("fixture cancellation"));
          if (outcome === "late failure") throw new Error("late backend error");
          return "late backend success";
        } });
      await assert.rejects(f.search(controller.signal), /Web search cancelled/);
      assert.equal(f.ddgCalls(), 0);
    } finally { f.restore(); }
  });
}

test("pre-cancelled search never starts a backend or DDG", async () => {
  const f = fixture(false);
  try {
    f.install();
    await assert.rejects(f.search(AbortSignal.abort(new Error("fixture cancellation"))), /fixture cancellation/);
    assert.equal(f.ddgCalls(), 0);
  } finally { f.restore(); }
});

test("late asynchronous contribution is ignored and reserved IDs are rejected", async () => {
  const f = fixture(false);
  try {
    f.install();
    const lateRelease = f.parentEvents.on(SEARCH_BACKENDS_REQUEST_V1, request => {
      queueMicrotask(() => request.contribute({ version: 1, id: "late", label: "Late", defaultProviders: ["fixture-provider"], search: async () => "late" }));
    });
    assert.equal((await f.search()).details.method, "ddg");
    lateRelease();
    f.register({ version: 1, id: "native", label: "Reserved", defaultProviders: [], search: async () => "reserved" });
    await assert.rejects(f.search(), /invalid v1 backend/);
  } finally { f.restore(); }
});
