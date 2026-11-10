import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { memoryHttp, searchFixture, searchPath, until } from "./search/fixtures/harness.ts";
import { discoverSearchBackends } from "../fork/pi-native-search/extensions/backends.ts";

// Jiti keeps its first cache directory for the process, including child assembly.
let scratch: string, previousTmp: string | undefined;
test.before(() => {
  initTheme("dark", false);
  previousTmp = process.env.TMPDIR;
  scratch = mkdtempSync(join(tmpdir(), "search-integration-cache-"));
  process.env.TMPDIR = scratch;
});
test.after(() => {
  if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
  rmSync(scratch, { recursive: true, force: true });
});

for (const cc of [undefined, "before", "after"] as const) {
  test(`real Main Native Search ${cc ? `with compiled CC ${cc}` : "without CC or Subagents"} preserves tool ownership and execution`, async () => {
    const http = memoryHttp();
    const f = await searchFixture({ cc, backendFirst: cc === "before" });
    const id = f.runtime.session.sessionId;
    const registry = getOrCreateChildCapabilityRegistryV1();
    try {
      const runner = f.runtime.session.extensionRunner;
      const originals = new Map(["web_search", "web_fetch"].map(name => [name, f.runtime.session.getToolDefinition(name)!]));
      for (const [name, definition] of originals) {
        assert.ok(definition);
        const info = f.runtime.session.getAllTools().find(tool => tool.name === name)!;
        assert.equal(info.sourceInfo.path, searchPath, "CC never takes ownership of Native Search tools");
        const renderers = runner.resolveToolRenderers(name, () => definition);
        assert.ok(renderers);
        assert.equal(renderers === definition, cc === undefined, "compiled CC decorates the native renderers, not execute");
        assert.equal(f.runtime.session.getToolDefinition(name)!.execute, definition.execute);
      }
      const descriptor = registry.snapshot(id).registrations.find(item => item.owner_id === "pi-native-search");
      assert.ok(descriptor, "Main advertises its real Contracts descriptor even with no SA consumer");
      assert.deepEqual(descriptor.manifest.targets["pi-subagents"]?.tools, ["web_fetch", "web_search"]);
      assert.equal(descriptor.manifest.main_entrypoint.canonical_path, searchPath);
      await f.runtime.session.prompt("SEARCH_MAIN");
      await f.runtime.session.prompt("FETCH_MAIN");
      const results = f.runtime.session.messages.filter(message => message.role === "toolResult");
      assert.deepEqual(results.map(result => [result.toolName, result.isError]), [["web_search", false], ["web_fetch", false]]);
      assert.deepEqual(results[0].content, [{ type: "text", text: "MAIN_BACKEND: SEARCH_MAIN query" }]);
      assert.deepEqual(results[0].details, { query: "SEARCH_MAIN query", provider: "search-faux", method: "native" });
      assert.deepEqual(results[1].content, [{ type: "text", text: "OFFLINE_PAGE offline body" }]);
      assert.deepEqual(results[1].details, { url: "https://page.fixture.invalid/allowed", provider: "search-faux", method: "local" });
      assert.equal(f.runtime.session.model?.provider, "search-faux");
      for (const [name, definition] of originals) assert.equal(f.runtime.session.getToolDefinition(name)!.execute, definition.execute);
      assert.deepEqual(http.requests, ["https://page.fixture.invalid/allowed"]);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); http.restore(); }
    assert.equal(registry.snapshot(id).registrations.some(item => item.owner_id === "pi-native-search"), false, "shutdown withdraws the Main descriptor");
  });
}

test("actual Subagents Host approves Native Search factory, preserves a search-only SDK allowlist, and passes only its Main backend bus", { timeout: 60000 }, async () => {
  const http = memoryHttp();
  const f = await searchFixture({ subagents: true, backendFirst: true, label: "PARENT_ONLY" });
  let sibling: Awaited<ReturnType<typeof searchFixture>> | undefined;
  const { getProcessServiceCellV1 } = await import("../local/pi-subagents/src/host/service-cell.ts");
  const cell = getProcessServiceCellV1();
  try {
    // Contracts intentionally keeps only the latest registration per owner.
    // The unrelated SDK Main supplies a backend, not a second Native Search owner.
    sibling = await searchFixture({ label: "SIBLING_ONLY", native: false });
    assert.notEqual(f.backend.events, sibling.backend.events, "SDK Main sessions have separate emitters");
    assert.deepEqual(discoverSearchBackends(sibling.backend.events).map(backend => backend.label), ["SIBLING_ONLY"]);
    await f.runtime.session.prompt("SPAWN_SEARCH");
    const spawn = f.runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "spawn_agent");
    assert.ok(spawn && spawn.role === "toolResult" && !spawn.isError, JSON.stringify(spawn));
    const service = cell.service!;
    assert.ok(service, "the production Subagents service owns the Task");
    const binding = service.binding(f.runtime.session.sessionId)!;
    const item = () => binding.host.snapshot().agents.find(partition => partition.agent.task_name === "searcher");
    const diagnostics = () => ({ agents: binding.host.snapshot().agents, errors: service.diagnostics(), main: f.runtime.session.messages });
    await until(() => item()?.tasks[0]?.phase === "settled", "real Search child Task settles", diagnostics);
    assert.equal(item()!.tasks[0]!.outcome, "completed");
    const profile = item()!.agent.profile;
    assert.deepEqual(profile.capabilities.active_tools.filter(name => name.startsWith("web_")), ["web_search"]);
    assert.equal(profile.capabilities.tool_definitions.find(tool => tool.name === "web_search")?.owner_id, "pi-native-search");
    const capability = profile.capabilities.entries.find(entry => entry.owner === "pi-native-search");
    assert.ok(capability?.execution_factory, "the real closure captures the audited physical factory proof");
    assert.equal(capability.execution_factory.canonical_path, searchPath);
    const child = await binding.runtime.childForView(item()!.agent.agent_id);
    assert.ok(child);
    assert.equal(child.session.getActiveToolNames().includes("web_search"), true);
    assert.equal(child.session.getActiveToolNames().includes("web_fetch"), false, "factory session_start cannot expand the frozen Host allowlist");
    const childRequests = f.control.requests.filter(request => request.child);
    assert.ok(childRequests.length >= 3, "the actual child provider runs through search and a forbidden fetch attempt");
    assert.ok(childRequests.every(request => request.tools.includes("web_search") && !request.tools.includes("web_fetch")));
    const results = child.session.messages.filter(message => message.role === "toolResult");
    const search = results.find(result => result.toolName === "web_search")!;
    assert.ok(search && !search.isError, JSON.stringify(results));
    assert.deepEqual(search.content, [{ type: "text", text: "PARENT_ONLY: SEARCH_CHILD query" }]);
    assert.deepEqual(search.details, { query: "SEARCH_CHILD query", provider: "search-faux", method: "native" });
    const fetch = results.find(result => result.toolName === "web_fetch");
    assert.ok(fetch?.isError, "a provider-generated, non-allowlisted fetch is rejected by the actual SDK, not a getActiveTools mock");
    assert.match(JSON.stringify(fetch.content), /Tool web_fetch not found/);
    assert.equal(f.backend.calls.length, 1);
    assert.equal(f.backend.calls[0]!.session, child.session.sessionId, "Host passes Main's emitter but execution uses the actual child context");
    assert.equal(sibling.backend.calls.length, 0, "child discovery never leaks to an unrelated Main/Sibling emitter");
    assert.deepEqual(http.requests, [], "no DDG fallback or forbidden page fetch runs");
    assert.equal(getOrCreateChildCapabilityRegistryV1().snapshot(child.session.sessionId).registrations.some(entry => entry.owner_id === "pi-native-search"), false, "child never advertises a new Main descriptor");
    assert.deepEqual(f.errors, []); assert.deepEqual(sibling.errors, []); assert.deepEqual(service.diagnostics(), []);
  } finally {
    await sibling?.close(); await f.close();
    await cell.service?.close(); cell.service = undefined; cell.promise = undefined;
    http.restore();
  }
});

test("Main discovers a late versioned backend, withdraws it per call, and never borrows another Main's backend", async () => {
  const http = memoryHttp();
  const f = await searchFixture({ label: "LOCAL_ONLY", backendFirst: false });
  let sibling: Awaited<ReturnType<typeof searchFixture>> | undefined;
  try {
    sibling = await searchFixture({ label: "FOREIGN_ONLY", backendFirst: true, native: false });
    f.backend.available = false;
    await f.runtime.session.prompt("SEARCH_MAIN absent");
    f.backend.available = true;
    await f.runtime.session.prompt("SEARCH_MAIN late backend");
    f.backend.available = false;
    await f.runtime.session.prompt("SEARCH_MAIN withdrawn backend");
    const results = f.runtime.session.messages.filter(message => message.role === "toolResult").filter(message => message.toolName === "web_search");
    assert.deepEqual(results.map(result => (result.details as { method: string }).method), ["ddg", "native", "ddg"]);
    assert.match(JSON.stringify(results[0].content), /OFFLINE_DDG/);
    assert.deepEqual(results[1].content, [{ type: "text", text: "LOCAL_ONLY: SEARCH_MAIN query" }]);
    assert.match(JSON.stringify(results[2].content), /OFFLINE_DDG/);
    assert.equal(f.backend.calls.length, 1); assert.equal(sibling.backend.calls.length, 0);
    assert.equal(http.requests.length, 2);
    const siblingId = sibling.runtime.session.sessionId;
    const mainId = f.runtime.session.sessionId;
    await sibling.close(); sibling = undefined;
    const registry = getOrCreateChildCapabilityRegistryV1();
    assert.equal(registry.snapshot(siblingId).registrations.some(entry => entry.owner_id === "pi-native-search"), false);
    assert.equal(registry.snapshot(mainId).registrations.some(entry => entry.owner_id === "pi-native-search"), true, "retiring Sibling cannot revoke Main's capability binding");
    assert.deepEqual(f.errors, []);
  } finally { await sibling?.close(); await f.close(); http.restore(); }
});
