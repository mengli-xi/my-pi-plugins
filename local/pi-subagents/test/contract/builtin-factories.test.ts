import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSessionAssemblyPublicModules } from "pi-session-runtime/session-assembly";
import { assertFrozenToolDefinitionV1, builtinEntrypointDigestV1, builtinRoleApiV1, builtinToolOwnerV1, frozenToolFenceV1 } from "../../src/capabilities/builtin.ts";
import { assertCapabilityFingerprintV1, capabilityFingerprint, toolDefinitionDigest } from "../../src/capabilities/fingerprint.ts";
import { resolveToolCapabilityClosureV1 } from "../../src/capabilities/closure.ts";
import { createChildCapabilityRegistryV1 } from "../../src/capabilities/registry.ts";
import { childExecutionFactories } from "../../src/runtime/factory-catalog.ts";
import type { CapabilityEntryV1, FrozenProfileV1 } from "../../src/persistence/types.ts";
import type { ResolvedAgentRoleV1 } from "../../src/roles/types.ts";

const sdk = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
function info(definition: ToolDefinition, owner: string): ToolInfo {
  return { ...definition, exposure: definition.exposure ?? "direct", sourceInfo: { path: owner, source: owner.startsWith("builtin:") ? "builtin" : "extension", scope: "temporary", origin: "top-level" } };
}
function frozen(definition: ToolInfo, owner: string) {
  return { name: definition.name, owner_id: owner, definition_sha256: toolDefinitionDigest({ name: definition.name, owner_id: owner, description: definition.description, parameters: JSON.parse(JSON.stringify(definition.parameters)), prompt_guidelines: definition.promptGuidelines ?? [] }) };
}
function profile(entries: CapabilityEntryV1[], definitions: FrozenProfileV1["capabilities"]["tool_definitions"]): FrozenProfileV1 {
  const content = { version: 1 as const, entries, active_tools: definitions.map(tool => tool.name), tool_definitions: definitions };
  return { project_trusted: true, capabilities: { ...content, fingerprint: capabilityFingerprint(content) } } as FrozenProfileV1;
}
function entry(owner: `builtin:${string}`, tools: string[]): CapabilityEntryV1 { return { owner, main_entrypoint: owner, child_entrypoint: owner, sha256: builtinEntrypointDigestV1(owner, sdk.VERSION), tools, hooks: [], providers: [], builtin_proof: { version: 1, pi_version: sdk.VERSION } }; }
function api(owner: string) {
  const definitions = new Map<string, ToolDefinition>(), handlers = new Map<string, Array<(...args: any[]) => any>>();
  let active: string[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => { definitions.set(tool.name, tool); }, registerToolRenderer: () => {}, registerCommand: () => {},
    getAllTools: () => [...definitions.values()].map(tool => info(tool, owner)), getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; },
    getSettings: () => ({}), appendEntry: () => {},
    on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, [...handlers.get(event) ?? [], handler]); return () => {}; },
  } as unknown as ExtensionAPI;
  const emit = async (name: string, event: any, ctx: any) => { for (const handler of handlers.get(name) ?? []) { const result = await handler(event, ctx); if (result?.block) return result; } };
  return { pi, definitions, emit };
}

for (const spec of [{ owner: "builtin:codemode" as const, name: "codemode", create: sdk.createCodemodeExtension }, { owner: "builtin:tool-search" as const, name: "tool_search", create: sdk.createToolSearchExtension }]) {
  test(`${spec.owner} uses the assembly SDK factory and exact builtin provenance`, async () => {
    const main = api(spec.owner); await spec.create()(main.pi);
    const definition = main.pi.getAllTools().find(tool => tool.name === spec.name)!;
    const expected = frozen(definition, spec.owner), capability = entry(spec.owner, [spec.name]), snapshot = profile([capability], [expected]);
    const factories = await childExecutionFactories({ profile: snapshot, agentDir: sdk.getAgentDir(), sessionId: "child", getBridge: () => undefined });
    assert.equal(factories.length, 1);
    const loaded = factories[0]!; assert.notEqual(typeof loaded, "function"); if (typeof loaded === "function") throw new Error("named builtin required");
    assert.equal(loaded.builtin, true); assert.equal(loaded.name, spec.owner.slice(8));
    const child = api(spec.owner); await loaded.factory(child.pi);
    assertFrozenToolDefinitionV1(expected, child.pi.getAllTools()[0]);
    assert.throws(() => assertFrozenToolDefinitionV1(expected, { ...definition, sourceInfo: { ...definition.sourceInfo, source: "extension" } }), /provenance/);
    for (const change of [{ owner: "builtin:unknown" }, { child_entrypoint: "builtin:mcp" }, { sha256: "0".repeat(64) }, { tools: ["write"] }, { builtin_proof: undefined }, { builtin_proof: { version: 1 as const, pi_version: "other" } }]) {
      const modified = { ...capability, ...change };
      if (modified.builtin_proof === undefined) delete modified.builtin_proof;
      await assert.rejects(childExecutionFactories({ profile: profile([modified], [expected]), agentDir: sdk.getAgentDir(), sessionId: "child", getBridge: () => undefined }), /capability-unavailable/);
    }
  });
}

test("readonly role filters codemode and tool_search, and the public pipeline blocks guessed nested tools", async () => {
  const child = api("builtin:codemode");
  const allowed = "allowed_read", forbidden = "forbidden_write", owner = "fixture-tools";
  const template = sdk.createReadToolDefinition(process.cwd()) as unknown as ToolDefinition;
  const read = { ...template, name: allowed, exposure: "deferred" as const }, write = { ...template, name: forbidden, exposure: "deferred" as const };
  child.definitions.set(allowed, read); child.definitions.set(forbidden, write);
  const snapshot = profile([], [{ name: "codemode", owner_id: "builtin:codemode", definition_sha256: "a".repeat(64) }, { name: "tool_search", owner_id: "builtin:tool-search", definition_sha256: "a".repeat(64) }, frozen(info(read, owner), owner)]);
  const scoped = builtinRoleApiV1(child.pi, snapshot);
  await sdk.createCodemodeExtension()(scoped); await sdk.createToolSearchExtension()(scoped);
  const search = child.definitions.get("tool_search")!;
  const searchContext = { tools: [read, write] } as unknown as ExtensionToolContext;
  await search.execute("search", { query: forbidden }, undefined, undefined, searchContext);
  assert.equal(child.pi.getActiveTools().includes(forbidden), false);
  await search.execute("search", { query: allowed }, undefined, undefined, searchContext);
  assert.deepEqual(child.pi.getActiveTools(), [allowed]);
  let executions = 0;
  const codemode = child.definitions.get("codemode")!;
  const result = await codemode.execute("code", { code: `return await tools.${forbidden}({path: "forbidden"});` }, undefined, undefined, {
    tools: [read, write], executeTool: async () => { executions++; throw new Error("must not execute"); }, sessionManager: { getBranch: () => [] }, modelRegistry: {},
  } as unknown as ExtensionToolContext);
  assert.equal(executions, 0); assert.equal(result.isError, true);
  const fence = api(owner); fence.definitions.set(allowed, read); fence.definitions.set(forbidden, write);
  await frozenToolFenceV1(snapshot, snapshot.capabilities.active_tools)(fence.pi);
  for (const parentToolCallId of [undefined, "code"]) assert.equal((await fence.emit("tool_call", { toolName: forbidden, parentToolCallId, input: {} }, {}))?.block, true);
  assert.equal(await fence.emit("tool_call", { toolName: allowed, parentToolCallId: "code", input: {} }, {}), undefined);
  fence.definitions.set(allowed, { ...read, description: "changed" });
  assert.equal((await fence.emit("tool_call", { toolName: allowed, parentToolCallId: "code", input: {} }, {}))?.block, true);
});

test("stock MCP, llama.cpp and unknown builtin tools fail closed at admission and assembly", async () => {
  const role: ResolvedAgentRoleV1 = { version: 1, source_kind: "builtin", source_identity: "role", frontmatter: { name: "test", description: "test", tools: "*" }, body: "", content_sha256: "a".repeat(64), resolved_at: "2026-11-06T00:00:00.000Z" };
  const registry = createChildCapabilityRegistryV1().snapshot("unsupported-builtin");
  for (const [owner, name] of [["builtin:mcp", "read_mcp_resource"], ["builtin:mcp", "mcp__server__read"], ["builtin:llama.cpp", "read"], ["builtin:unknown", "unknown_tool"]] as const) {
    const tool = info({ ...(sdk.createReadToolDefinition(process.cwd()) as unknown as ToolDefinition), name }, owner);
    assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: [name], allTools: [tool], role, registry, registeredProviderIds: [], providerId: "anthropic" }), /unsupported Pi built-in tool source/);
    const snapshot = profile([entry(owner, [name])], [frozen(tool, owner)]);
    await assert.rejects(childExecutionFactories({ profile: snapshot, agentDir: sdk.getAgentDir(), sessionId: "child", getBridge: () => undefined }), /unsupported built-in child owner/);
  }
});

test("runtime fingerprint binds structured builtin and direct-factory execution proofs", () => {
  const capability = entry("builtin:codemode", ["codemode"]), snapshot = profile([capability], [{ name: "codemode", owner_id: "builtin:codemode", definition_sha256: "a".repeat(64) }]);
  assert.doesNotThrow(() => assertCapabilityFingerprintV1(snapshot.capabilities));
  capability.builtin_proof!.pi_version = "tampered";
  assert.throws(() => assertCapabilityFingerprintV1(snapshot.capabilities), /frozen capability fingerprint/);
  const other = profile([{ owner: "pi-native-search", main_entrypoint: "/search/index.ts", child_entrypoint: "/search/child.ts", tools: [], hooks: [], providers: [], sha256: "a".repeat(64), execution_factory: { version: 1, canonical_path: "/search/index.ts", sha256: "b".repeat(64), exports: ["createSearchChildFactory"] } }], []);
  other.capabilities.entries[0]!.execution_factory!.sha256 = "c".repeat(64);
  assert.throws(() => assertCapabilityFingerprintV1(other.capabilities), /frozen capability fingerprint/);
});

test("llama.cpp is provider/command-only in stock Pi 1.5, not an implicit tool capability", () => {
  assert.throws(() => builtinToolOwnerV1("read", { path: "builtin:llama.cpp", source: "builtin" }), /unsupported/);
  assert.throws(() => builtinToolOwnerV1("write", { path: "builtin:codemode", source: "builtin" }), /unsupported/);
});
