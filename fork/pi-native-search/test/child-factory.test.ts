import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, initTheme, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { createSearchChildFactory, installSearch, loadSearchConfig, type SearchConfig } from "../extensions/index.ts";

test("SDK search installs own immutable child snapshots and survive sibling shutdown", async () => {
  initTheme("dark");
  const root = mkdtempSync(join(tmpdir(), "pi-search-sdk-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const config: SearchConfig = { enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} };
  const configPath = join(agentDir, "search-config.json"); writeFileSync(configPath, JSON.stringify(config));
  const errors: string[] = [];
  const runtimes: Awaited<ReturnType<typeof make>>[] = [];
  async function make(name: string, factory: ExtensionFactory, tools = ["web_search", "web_fetch"]) {
    const cwd = join(root, name); mkdirSync(cwd);
    const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "one" }, { id: "two" }], tokensPerSecond: 100000 });
    faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("OK")));
    return createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
        extensionFactories: [pi => pi.registerProvider(faux.provider), factory],
      } });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("fixture", "one"), tools });
      await result.session.bindExtensions({ mode: "rpc", onError: error => errors.push(JSON.stringify(error)) });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  }
  try {
    runtimes.push(await make("main", pi => installSearch(pi, { child: false, config: loadSearchConfig(agentDir), agentDir })));
    const registry = getOrCreateChildCapabilityRegistryV1();
    const advertised = registry.snapshot(runtimes[0].session.sessionId);
    assert.deepEqual(advertised.registrations.map(item => item.owner_id), ["pi-native-search"]);
    const searchOnly = { ...config, fetchEnabled: false, providerOverrides: { fixture: { searchEnabled: true } } };
    const factory = createSearchChildFactory(searchOnly);
    searchOnly.providerOverrides.fixture.searchEnabled = false;
    runtimes.push(await make("a", factory, ["web_search"]));
    runtimes.push(await make("b", createSearchChildFactory({ ...config, searchEnabled: false }), ["web_fetch"]));
    const [main, a, b] = runtimes;
    assert.deepEqual(registry.snapshot(main.session.sessionId), advertised);
    for (const item of [a, b]) assert.deepEqual(registry.snapshot(item.session.sessionId).registrations, []);
    await main.session.bindExtensions({ mode: "rpc", onError: error => errors.push(JSON.stringify(error)) });
    const rebound = registry.snapshot(main.session.sessionId);
    assert.deepEqual(rebound.registrations.map(item => item.manifest), advertised.registrations.map(item => item.manifest));
    await a.session.bindExtensions({ mode: "rpc", onError: error => errors.push(JSON.stringify(error)) });
    assert.deepEqual(registry.snapshot(main.session.sessionId), rebound);
    assert.deepEqual(errors, []);
    assert.deepEqual(a.session.getActiveToolNames(), ["web_search"]);
    assert.deepEqual(b.session.getActiveToolNames(), ["web_fetch"]);
    await main.session.prompt("/search off");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, false);
    for (const item of [a, b]) {
      await item.session.setModel(item.services.modelRuntime.getModel("fixture", "two")!);
    }
    assert.deepEqual(a.session.getActiveToolNames(), ["web_search"]);
    assert.deepEqual(b.session.getActiveToolNames(), ["web_fetch"]);
    await main.session.prompt("/search on");
    for (const item of [a, b]) await item.session.prompt("/search off");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, true, "child slash input cannot write Main config");
    await a.dispose();
    assert.deepEqual(registry.snapshot(main.session.sessionId), rebound);
    assert.deepEqual(registry.snapshot(b.session.sessionId).registrations, []);
    await b.session.reload();
    assert.deepEqual(b.session.getActiveToolNames(), ["web_fetch"]);
    assert.equal(b.session.getToolDefinition("web_search"), undefined, "Host-excluded search stays unavailable after child reload");
    assert.ok(main.session.getToolDefinition("web_fetch"));
    await main.session.prompt("/search on");
    assert.ok(main.session.getActiveToolNames().includes("web_search"));
    await b.session.prompt("Return OK.");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, true);
    assert.deepEqual(errors, []);
  } finally {
    for (const item of runtimes) await item.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});


test("Claude subscription provider uses ordinary DDG and HTTP through both SDK children", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-search-bridge-sdk-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    if (url.startsWith("https://html.duckduckgo.com/html/?q="))
      return new Response('<a class="result__a" href="https://fixture.invalid/result">Public fallback</a>');
    assert.match(url, /^https:\/\/fixture\.invalid\/[ab]$/);
    return new Response(`HTTP ${url}`, { headers: { "content-type": "text/plain" } });
  };
  const runtimes: Awaited<ReturnType<typeof make>>[] = [];
  const errors: string[] = [];
  async function make(name: string) {
    const cwd = join(root, name); mkdirSync(cwd);
    const faux = fauxProvider({ provider: "claude-bridge", api: "fixture-bridge", models: [{ id: "fixture" }], tokensPerSecond: 100000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("web_search", { query: "fixture" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("web_fetch", { url: `https://fixture.invalid/${name}` }), { stopReason: "toolUse" }),
      fauxAssistantMessage("OK"),
    ]);
    return createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
        extensionFactories: [pi => pi.registerProvider(faux.provider), createSearchChildFactory({ enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} })],
      } });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("claude-bridge", "fixture"), tools: ["web_search", "web_fetch"] });
      await result.session.bindExtensions({ mode: "rpc", onError: error => errors.push(JSON.stringify(error)) });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  }
  try {
    runtimes.push(await make("a"), await make("b"));
    await Promise.all(runtimes.map(item => item.session.prompt("Run the fixture public fallback operations.")));
    for (const item of runtimes) {
      const results = item.session.messages.filter(message => message.role === "toolResult");
      assert.equal(results.length, 2);
      for (const message of results) assert.equal(message.isError, false, JSON.stringify(message));
      assert.match((results[0].content[0] as { text: string }).text, /Public fallback/);
      assert.match((results[1].content[0] as { text: string }).text, /HTTP https:\/\/fixture\.invalid\/[ab]/);
    }
    assert.notEqual(runtimes[0].cwd, runtimes[1].cwd);
    assert.equal(requests.filter(url => url.startsWith("https://html.duckduckgo.com/")).length, 2);
    assert.deepEqual(requests.filter(url => url.startsWith("https://fixture.invalid/")).sort(), ["https://fixture.invalid/a", "https://fixture.invalid/b"]);
    assert.deepEqual(errors, []);
  } finally {
    for (const item of runtimes) await item.dispose();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
