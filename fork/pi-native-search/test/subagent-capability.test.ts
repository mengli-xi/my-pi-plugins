import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { createSearchChildFactory, installSearch, loadSearchConfig } from "../extensions/index.ts";

function fixture(child: boolean, snapshot = { enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} }) {
  const home = mkdtempSync(join(tmpdir(), "pi-native-search-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "search-config.json"), JSON.stringify({ enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} }));
  const tools: string[] = [];
  const definitions = new Map<string, any>();
  const commands: string[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const active: string[] = child ? ["web_search"] : [];
  let activeWrites = 0;
  const pi = {
    registerTool(tool: { name: string }) { tools.push(tool.name); definitions.set(tool.name, tool); },
    registerCommand(name: string) { commands.push(name); },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { activeWrites++; active.splice(0, active.length, ...names); },
    on(type: string, handler: (event: unknown, ctx: unknown) => unknown) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
  };
  const ctx = {
    mode: "tui",
    model: { provider: "test", id: "model", baseUrl: "" },
    modelRegistry: {
      getApiKeyForProvider: async () => undefined as string | undefined,
      getProviderAuthStatus: (_provider: string) => ({ configured: false }),
      isUsingOAuth: (_model: unknown) => false,
    },
    sessionManager: { getSessionId: () => `search-${child ? "child" : "main"}` },
    ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {} },
  };
  if (child) createSearchChildFactory(snapshot)(pi as never);
  else {
    const agentDir = join(home, ".pi", "agent");
    installSearch(pi as never, { child: false, config: loadSearchConfig(agentDir), agentDir });
  }
  return {
    home, tools, definitions, commands, active, ctx, activeWrites: () => activeWrites,
    async emit(type: string) { for (const handler of handlers.get(type) ?? []) await handler({}, ctx); },
    restore() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("Main registers search tools, command, and both child factory targets", async () => {
  const f = fixture(false);
  try {
    await f.emit("session_start");
    assert.deepEqual(f.tools.sort(), ["web_fetch", "web_search"]);
    assert.deepEqual(f.commands, ["search"]);
    assert.deepEqual(f.active.sort(), ["web_fetch", "web_search"]);
    const registration = getOrCreateChildCapabilityRegistryV1().snapshot("search-main").registrations.find((entry) => entry.owner_id === "pi-native-search");
    assert.deepEqual(Object.keys(registration?.manifest.targets ?? {}), ["pi-side-chat", "pi-subagents"]);
    assert.deepEqual(registration?.manifest.targets["pi-subagents"]?.tools, ["web_fetch", "web_search"]);
    assert.deepEqual(registration?.manifest.targets["pi-subagents"]?.commands, []);
    assert.match(registration?.manifest.targets["pi-subagents"]?.child_entrypoint.canonical_path ?? "", /extensions\/child\.ts$/u);
    for (const target of Object.values(registration!.manifest.targets)) {
      assert.equal(target.activation, "required-only");
      assert.deepEqual(target.tools, ["web_fetch", "web_search"]);
      assert.deepEqual(target.commands, []);
      assert.deepEqual(target.providers, []);
      assert.equal(target.child_factory?.package_name, "pi-native-search");
      assert.equal(target.child_factory?.module, "extensions/child.ts");
      assert.equal(target.child_factory?.export, "createRegisteredSearchChildFactory");
      assert.deepEqual(target.child_factory?.artifacts, ["extensions/index.ts"]);
      assert.match(target.child_factory?.files[1]?.canonical_path ?? "", /extensions\/index\.ts$/u);
      assert.match(target.child_factory?.files[1]?.sha256 ?? "", /^[a-f0-9]{64}$/u);
    }
    await f.emit("session_shutdown");
  } finally { f.restore(); }
});

test("Subagent child keeps tools but omits Main command and status side effects", async () => {
  const f = fixture(true);
  try {
    await f.emit("session_start");
    assert.deepEqual(f.tools.sort(), ["web_fetch", "web_search"]);
    assert.deepEqual(f.commands, []);
    for (const event of ["model_select", "session_tree"]) await f.emit(event);
    assert.deepEqual(f.active, ["web_search"]);
    assert.equal(f.activeWrites(), 0, "child must never rewrite the Host allowlist");
    const registry = getOrCreateChildCapabilityRegistryV1();
    assert.equal(registry.snapshot("search-child").registrations.some(entry => entry.owner_id === "pi-native-search"), false, "SDK child must not advertise another Main capability owner");
    await f.emit("session_shutdown");
    assert.equal(registry.snapshot("search-child").registrations.some(entry => entry.owner_id === "pi-native-search"), false);
  } finally { f.restore(); }
});

test("child lifecycle ignores Main config and caller mutations while snapshot guards execution", async () => {
  const snapshot = { enabled: false, searchEnabled: false, fetchEnabled: false, providerOverrides: {} };
  const f = fixture(true, snapshot);
  try {
    snapshot.enabled = snapshot.searchEnabled = snapshot.fetchEnabled = true;
    writeFileSync(join(f.home, ".pi", "agent", "search-config.json"), "{broken");
    for (const event of ["session_start", "model_select", "session_tree"]) await f.emit(event);
    for (const name of ["web_search", "web_fetch"]) {
      assert.equal((await f.definitions.get(name).execute("call", { query: "fixture", url: "https://fixture.invalid" }, undefined, undefined, f.ctx)).details.error, "disabled");
    }
    assert.deepEqual(f.active, ["web_search"]);
    assert.equal(f.activeWrites(), 0);
  } finally { f.restore(); }
});

test("web_search resolves xAI OAuth through Pi's model registry", async () => {
  const f = fixture(false);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    f.ctx.model = { provider: "xai", id: "grok-4.5", baseUrl: "https://api.x.ai/v1" };
    f.ctx.modelRegistry.getApiKeyForProvider = async (provider: string) => {
      assert.equal(provider, "xai");
      return "oauth-access-token";
    };
    f.ctx.modelRegistry.getProviderAuthStatus = () => ({
      configured: false,
      source: "environment",
      label: "XAI_API_KEY",
    });
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ text: "native result" }] }],
        citations: ["https://example.com"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await f.definitions.get("web_search").execute(
      "call-1",
      { query: "weather" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://api.x.ai/v1/responses");
    assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, "Bearer oauth-access-token");
    assert.match(result.content[0]?.text ?? "", /native result/u);
    assert.equal(result.details.method, "native");
  } finally {
    globalThis.fetch = originalFetch;
    f.restore();
  }
});

test("Anthropic OAuth falls back instead of using the API-key-only native request", async () => {
  const f = fixture(false);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    f.ctx.model = { provider: "anthropic", id: "claude-sonnet", baseUrl: "https://api.anthropic.com" };
    f.ctx.modelRegistry.getApiKeyForProvider = async () => "sk-ant-oat-test-token";
    f.ctx.modelRegistry.isUsingOAuth = () => true;
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response(
        '<a class="result__a" href="https://example.com/result">Result</a>' +
          '<a class="result__snippet">Fallback result</a>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };
    const result = await f.definitions.get("web_search").execute(
      "call-2",
      { query: "weather" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.deepEqual(requests, ["https://html.duckduckgo.com/html/?q=weather"]);
    assert.equal(result.details.method, "ddg");
  } finally {
    globalThis.fetch = originalFetch;
    f.restore();
  }
});

test("an effective Anthropic API-key override wins over stored OAuth", async () => {
  const f = fixture(false);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
  try {
    f.ctx.model = { provider: "anthropic", id: "claude-sonnet", baseUrl: "https://api.anthropic.com" };
    f.ctx.modelRegistry.getApiKeyForProvider = async () => "sk-ant-api-runtime-override";
    f.ctx.modelRegistry.isUsingOAuth = () => true;
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "native result" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await f.definitions.get("web_search").execute(
      "call-3",
      { query: "weather" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(requests[0]?.headers?.["x-api-key"], "sk-ant-api-runtime-override");
    assert.equal(result.details.method, "native");
  } finally {
    globalThis.fetch = originalFetch;
    f.restore();
  }
});

test("web_search throws with both native and fallback failure context", async () => {
  const f = fixture(false);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    f.ctx.model = { provider: "xai", id: "grok-4.5", baseUrl: "https://api.x.ai/v1" };
    f.ctx.modelRegistry.getApiKeyForProvider = async () => "oauth-access-token";
    f.ctx.modelRegistry.isUsingOAuth = () => true;
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      throw new TypeError(`Unable to connect: ${url}`);
    };
    await assert.rejects(
      f.definitions.get("web_search").execute(
        "call-4",
        { query: "weather" },
        undefined,
        undefined,
        f.ctx,
      ),
      /Native xai search failed:.*DuckDuckGo fallback failed:/u,
    );
    assert.deepEqual(requests, [
      "https://api.x.ai/v1/responses",
      "https://html.duckduckgo.com/html/?q=weather",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    f.restore();
  }
});

test("HTTP fetch retains the 50KB and 2000-line limits after SDK removal", async () => {
  const f = fixture(true);
  const originalFetch = globalThis.fetch;
  try {
    f.ctx.model = { provider: "claude-bridge", id: "fixture", baseUrl: "" };
    for (const body of ["x".repeat(60 * 1024), "line\n".repeat(2100)]) {
      globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/plain" } });
      const result = await f.definitions.get("web_fetch").execute("call", { url: "https://fixture.invalid" }, undefined, undefined, f.ctx);
      const text = result.content[0].text as string;
      assert.equal(result.details.method, "local");
      assert.match(text, /\[Truncated:/);
      const content = text.split("\n\n[Truncated:")[0];
      assert.ok(Buffer.byteLength(content) <= 50 * 1024);
      assert.ok(content.split("\n").length <= 2000);
    }
  } finally { globalThis.fetch = originalFetch; f.restore(); }
});

for (const name of ["web_search", "web_fetch"]) {
  test(`${name} rejects a late HTTP result from a backend that ignores cancellation`, async () => {
    const f = fixture(true);
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    try {
      globalThis.fetch = async () => { controller.abort(new Error("fixture cancellation")); return new Response("late success"); };
      await assert.rejects(f.definitions.get(name).execute("call", { query: "fixture", url: "https://fixture.invalid" }, controller.signal, undefined, f.ctx), /cancelled/);
    } finally { globalThis.fetch = originalFetch; f.restore(); }
  });
}

test("native renderers keep failed search and fetch results visibly failed", () => {
  const f = fixture(false);
  const theme = {
    fg: (color: string, text: string) => `${color}:${text}`,
    bold: (text: string) => text,
  };
  try {
    const render = (name: string) => f.definitions.get(name).renderResult(
      { content: [{ type: "text", text: "backend unavailable" }] },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    ).render(80).join("\n");
    assert.match(render("web_search"), /error:Search failed/u);
    assert.doesNotMatch(render("web_search"), /Found results/u);
    assert.match(render("web_fetch"), /error:Fetch failed/u);
    assert.doesNotMatch(render("web_fetch"), /Fetched/u);
  } finally {
    f.restore();
  }
});
