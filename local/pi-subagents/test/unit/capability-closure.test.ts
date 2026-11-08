import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import { localCollaborationQuery } from "../../src/tools/local-query.js";
import { resolveToolCapabilityClosureV1, unspawnableProviderIdsForContextV1, unspawnableProviderIdsV1, type ParentToolInfoV1 } from "../../src/capabilities/closure.js";
import { captureEntrypointDescriptorV1 } from "../../src/capabilities/manifest.js";
import { createChildCapabilityRegistryV1 } from "../../src/capabilities/registry.js";
import type { ResolvedAgentRoleV1 } from "../../src/roles/types.js";

function role(tools: "*" | readonly string[], required?: readonly string[]): ResolvedAgentRoleV1 { return { version: 1, source_kind: "builtin", source_identity: "role", frontmatter: { name: "test", description: "test", tools, ...(required ? { required_capabilities: required } : {}) }, body: "body", content_sha256: "a".repeat(64), resolved_at: "2026-08-18T00:00:00.000Z" }; }
function tool(name: string, sourceInfo: ParentToolInfoV1["sourceInfo"], extra: Partial<ParentToolInfoV1> = {}): ParentToolInfoV1 { return { name, description: `${name} tool`, parameters: { type: "object", properties: {} }, promptGuidelines: [], sourceInfo, ...extra }; }
function builtin(name: string) { return tool(name, { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" }); }

test("built-in extension owners freeze explicit tokens and reproduce child tool fingerprints", () => {
  const all = [builtin("read"), tool("codemode", { path: "builtin:codemode", source: "builtin", scope: "temporary", origin: "top-level" }), tool("tool_search", { path: "builtin:tool-search", source: "builtin", scope: "temporary", origin: "top-level" })];
  const registry = createChildCapabilityRegistryV1().snapshot("s");
  const closure = resolveToolCapabilityClosureV1({ activeToolNames: all.map((tool) => tool.name), allTools: all, role: role("*"), registry, registeredProviderIds: [], providerId: "anthropic" });
  assert.deepEqual(closure.childEntrypoints, ["builtin:codemode", "builtin:tool-search"]);
  assert.deepEqual(closure.tools.map((tool) => [tool.name, tool.owner_id]), [["codemode", "builtin:codemode"], ["read", "builtin"], ["tool_search", "builtin:tool-search"]]);
  assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: ["read"], allTools: [tool("read", { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" })], role: role("*"), registry, registeredProviderIds: [], providerId: "anthropic" }), /unsupported/);
});
function registryFixture(t: test.TestContext, extTools = ["ext_tool"], providerId = "fixture") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-closure-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ["dep-main.js", "dep-child.js", "ext-main.js", "ext-child.js", "provider-main.js", "provider-child.js"];
  for (const file of files) { writeFileSync(join(root, file), `${file}\n`, { mode: 0o600 }); chmodSync(join(root, file), 0o600); }
  const manifest = (owner_id: string, prefix: string, values: Partial<{ tools: string[]; hooks: string[]; requires: string[]; providers: Array<{ provider_id: string; service_tiers: string[]; service_tier_application: "none" | "owner-before-provider-request" }>; activation: "mirror" | "required-only" }> = {}) => ({ version: 1 as const, owner_id, main_entrypoint: captureEntrypointDescriptorV1(join(root, `${prefix}-main.js`)), targets: { "pi-subagents": { child_entrypoint: captureEntrypointDescriptorV1(join(root, `${prefix}-child.js`)), activation: values.activation ?? "required-only" as const, commands: [], tools: values.tools ?? [], providers: values.providers ?? [], hooks: values.hooks ?? [], requires: values.requires ?? [] } } });
  const registry = createChildCapabilityRegistryV1();
  const dep = registry.register({ version: 1, manifest: manifest("dep", "dep", { hooks: ["support/v1"] }) }); registry.bind({ version: 1, registrationToken: dep.registrationToken, session_id: "session", runtime_generation: 1, mode: "tui" });
  const ext = registry.register({ version: 1, manifest: manifest("ext", "ext", { tools: extTools, hooks: ["feature/v1"], requires: ["dep"] }) }); registry.bind({ version: 1, registrationToken: ext.registrationToken, session_id: "session", runtime_generation: 1, mode: "tui" });
  const base = manifest("provider", "provider", { providers: [{ provider_id: providerId, service_tiers: ["fast"], service_tier_application: "owner-before-provider-request" }] });
  writeFileSync(join(root, "package.json"), '{"name":"unbranded-fixture"}');
  const providerManifest = { ...base, targets: { "pi-subagents": { ...base.targets["pi-subagents"], ...(providerId === "unknown" ? {} : { sdk_provider_factory: {
    provider_id: providerId, package_manifest: captureEntrypointDescriptorV1(join(root, "package.json")), module: captureEntrypointDescriptorV1(join(root, "provider-child.js")), export: "createProvider", config: {}, artifacts: [],
  } }) } } };
  if (providerId !== "unknown") writeFileSync(join(root, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(providerManifest, "pi-subagents")] }));
  const provider = registry.register({ version: 1, manifest: providerManifest }); registry.bind({ version: 1, registrationToken: provider.registrationToken, session_id: "session", runtime_generation: 1, mode: "tui" });
  return { root, registry, snapshot: registry.snapshot("session") };
}

test("tool closure freezes builtins, collaboration, extension owner and dependency order", (t) => {
  const fx = registryFixture(t);
  const extPath = join(fx.root, "ext-main.js");
  const all = [builtin("read"), tool("spawn_agent", { path: "/package/pi-subagents/index.js", source: "extension", scope: "temporary", origin: "package" }), tool("ext_tool", { path: extPath, source: "extension", scope: "user", origin: "package" })];
  const closure = resolveToolCapabilityClosureV1({ activeToolNames: ["read", "spawn_agent", "ext_tool"], allTools: all, role: role("*"), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" });
  assert.deepEqual(closure.tools.map((entry) => [entry.name, entry.owner_id]), [["ext_tool", "ext"], ["read", "builtin"], ["spawn_agent", "pi-subagents"]]);
  assert.deepEqual(closure.owners.map((entry) => entry.owner_id), ["dep", "ext"]);
  assert.deepEqual(closure.childEntrypoints, [join(fx.root, "dep-child.js"), join(fx.root, "ext-child.js")]);
  assert.equal(closure.owners[1]?.target.tools[0], "ext_tool");
  assert.equal(closure.tools.every((entry) => /^[0-9a-f]{64}$/u.test(entry.definition_sha256)), true);
});

test("wildcard omits SDK and unknown tools while explicit role rejects them", (t) => {
  const fx = registryFixture(t); const sdk = tool("sdk_tool", { path: "<sdk:sdk_tool>", source: "sdk", scope: "temporary", origin: "top-level" }); const unknown = tool("unknown", { path: "<synthetic:unknown>", source: "synthetic", scope: "temporary", origin: "top-level" }); const unclaimed=join(fx.root,"unclaimed.js");writeFileSync(unclaimed,"x\n",{mode:0o600});const extension=tool("unclaimed",{path:unclaimed,source:"extension",scope:"user",origin:"package"});
  const closure = resolveToolCapabilityClosureV1({ activeToolNames: ["sdk_tool", "unknown", "unclaimed"], allTools: [sdk, unknown, extension], role: role("*"), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" });
  assert.equal(closure.tools.length, 0); assert.deepEqual(closure.diagnostics.map((entry) => entry.reason), ["sdk-tool", "unknown-source", "unknown-source"]);
  assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: ["sdk_tool"], allTools: [sdk], role: role(["sdk_tool"]), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" }), /not reproducible/);
});

test("custom provider, service tier and required capability select exact target owners", (t) => {
  const fx = registryFixture(t);
  const closure = resolveToolCapabilityClosureV1({ activeToolNames: ["read"], allTools: [builtin("read")], role: role(["read"], ["ext/feature/v1"]), registry: fx.snapshot, agentDir: fx.root, registeredProviderIds: ["fixture"], providerId: "fixture", serviceTier: "fast" });
  assert.equal(closure.providerOwnerId, "provider"); assert.equal(closure.serviceTierOwnerId, "provider"); assert.deepEqual(closure.owners.map((entry) => entry.owner_id), ["dep", "ext", "provider"]);
  assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: ["read"], allTools: [builtin("read")], role: role(["read"]), registry: fx.snapshot, registeredProviderIds: ["missing"], providerId: "missing" }), /provider owner/);
});

test("unknown providers with a capability declaration are unavailable in discovery and rejected at spawn admission", async t => {
  const fx = registryFixture(t, [], "unknown");
  const model = { provider: "unknown", id: "faux" };
  const result = await localCollaborationQuery("list_subagent_models", { query: "unknown" }, {
    modelRegistry: { getAvailable: () => [model], getRegisteredProviderIds: () => ["unknown"] },
    sessionManager: { getSessionId: () => "session" }, scopedModels: [],
  } as never, fx.root, fx.snapshot);
  assert.deepEqual(result, { models: [], unavailable: [{ id: "unknown/faux", reason: "provider has no subagent support" }] });
  assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: [], allTools: [], role: role([]), registry: fx.snapshot,
    registeredProviderIds: ["unknown"], providerId: "unknown" }), /model-unavailable: provider has no subagent support: unknown/);
  for (const providerId of ["fixture", "alternate"]) {
    const fixture = registryFixture(t, [], providerId), registry = fixture.snapshot;
    assert.deepEqual([...unspawnableProviderIdsV1({ registry, agentDir: fixture.root, registeredProviderIds: [providerId] })], []);
    assert.equal(resolveToolCapabilityClosureV1({ activeToolNames: [], allTools: [], role: role([]), registry, agentDir: fixture.root,
      registeredProviderIds: [providerId], providerId }).providerOwnerId, "provider");
  }
});

test("an active extension tool requires an explicit target declaration", (t) => {
  const fx = registryFixture(t, []);
  const undeclared = tool("undeclared", { path: join(fx.root, "ext-main.js"), source: "extension", scope: "user", origin: "package" });
  const wildcard = resolveToolCapabilityClosureV1({
    activeToolNames: ["undeclared"],
    allTools: [undeclared],
    role: role("*"),
    registry: fx.snapshot,
    registeredProviderIds: [],
    providerId: "anthropic",
  });
  assert.deepEqual(wildcard.tools, []);
  assert.deepEqual(wildcard.diagnostics.map((entry) => [entry.tool, entry.reason]), [["undeclared", "undeclared-tool"]]);
  assert.throws(() => resolveToolCapabilityClosureV1({
    activeToolNames: ["undeclared"],
    allTools: [undeclared],
    role: role(["undeclared"]),
    registry: fx.snapshot,
    registeredProviderIds: [],
    providerId: "anthropic",
  }), /does not declare tool: undeclared/u);
});

test("active definition drift, duplicate definitions and inactive explicit tools fail closed", (t) => {
  const fx = registryFixture(t);
  assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: ["missing"], allTools: [], role: role("*"), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" }), /no definition/);
  assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: ["read"], allTools: [builtin("read"), builtin("read")], role: role("*"), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" }), /duplicate/);
  assert.throws(() => resolveToolCapabilityClosureV1({ activeToolNames: [], allTools: [builtin("read")], role: role(["read"]), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" }), /not active/);
});

test("a tool registered by the child entrypoint resolves to the same owner as in Main", (t) => {
  const fx = registryFixture(t);
  const childPath = join(fx.root, "ext-child.js");
  const all = [tool("ext_tool", { path: childPath, source: "extension", scope: "user", origin: "package" })];
  const closure = resolveToolCapabilityClosureV1({ activeToolNames: ["ext_tool"], allTools: all, role: role("*"), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" });
  assert.deepEqual(closure.tools.map((entry) => [entry.name, entry.owner_id]), [["ext_tool", "ext"]]);
  assert.deepEqual(closure.diagnostics, []);
  const explicit = resolveToolCapabilityClosureV1({ activeToolNames: ["ext_tool"], allTools: all, role: role(["ext_tool"]), registry: fx.snapshot, registeredProviderIds: [], providerId: "anthropic" });
  assert.deepEqual(explicit.tools.map((entry) => entry.owner_id), ["ext"]);
});

test("approved supplemental providers may share Main, but duplicate approved owners for one provider are ambiguous", t => {
  const fx = registryFixture(t), base = fx.snapshot.registrations.find(item => item.owner_id === "provider")!.manifest;
  const second = { ...base, owner_id: "provider-two", targets: { "pi-subagents": { ...base.targets["pi-subagents"]!, providers: [{ provider_id: "second", service_tiers: [], service_tier_application: "none" as const }], sdk_provider_factory: { ...base.targets["pi-subagents"]!.sdk_provider_factory!, provider_id: "second" } } } };
  const handle = fx.registry.register({ version: 1, manifest: second });
  fx.registry.bind({ version: 1, registrationToken: handle.registrationToken, session_id: "session", runtime_generation: 1, mode: "rpc" });
  writeFileSync(join(fx.root, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(base, "pi-subagents"), sdkProviderApprovalV1(second, "pi-subagents")] }));
  const input = { activeToolNames: [], allTools: [], role: role([]), registry: fx.registry.snapshot("session"), agentDir: fx.root, registeredProviderIds: ["fixture", "second"], providerId: "second" };
  assert.equal(resolveToolCapabilityClosureV1(input).providerOwnerId, "provider-two");
  const duplicate = { ...base, owner_id: "provider-duplicate" };
  const duplicated = fx.registry.register({ version: 1, manifest: duplicate });
  fx.registry.bind({ version: 1, registrationToken: duplicated.registrationToken, session_id: "session", runtime_generation: 1, mode: "rpc" });
  writeFileSync(join(fx.root, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(base, "pi-subagents"), sdkProviderApprovalV1(second, "pi-subagents"), sdkProviderApprovalV1(duplicate, "pi-subagents")] }));
  assert.throws(() => resolveToolCapabilityClosureV1({ ...input, registry: fx.registry.snapshot("session"), providerId: "fixture" }), /provider owner is missing or ambiguous/);
});

test("unspawnable provider lookup excludes custom providers without exactly one Subagent owner and tolerates bare contexts", () => {
  const registry = createChildCapabilityRegistryV1().snapshot("s");
  assert.deepEqual([...unspawnableProviderIdsV1({ registry, registeredProviderIds: ["alternate", "fixture-gateway"] })].sort(), ["alternate", "fixture-gateway"]);
  assert.deepEqual([...unspawnableProviderIdsForContextV1({}, () => registry)], []);
  assert.deepEqual([...unspawnableProviderIdsForContextV1({ sessionManager: { getSessionId: () => "s" }, modelRegistry: { getRegisteredProviderIds: () => ["alternate"] } }, () => registry)], ["alternate"]);
});
