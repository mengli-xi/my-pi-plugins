import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBashToolDefinition, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import bashTimeout from "../../../pi-bash-timeout/extensions/index.ts";
import { resolveToolCapabilityClosureV1, type ParentToolInfoV1 } from "../../src/capabilities/closure.ts";
import { toolDefinitionDigest } from "../../src/capabilities/fingerprint.ts";
import { childExecutionFactories } from "../../src/runtime/factory-catalog.ts";
import type { FrozenProfileV1 } from "../../src/persistence/types.ts";
import type { ResolvedAgentRoleV1 } from "../../src/roles/types.ts";

const role: ResolvedAgentRoleV1 = { version: 1, source_kind: "builtin", source_identity: "role", frontmatter: { name: "test", description: "test", tools: ["bash"] }, body: "", content_sha256: "a".repeat(64), resolved_at: "2026-10-30T00:00:00.000Z" };

function closure(tool: ParentToolInfoV1, sessionId: string) {
  return resolveToolCapabilityClosureV1({ activeToolNames: ["bash"], allTools: [tool], role,
    registry: getOrCreateChildCapabilityRegistryV1().snapshot(sessionId), registeredProviderIds: [], providerId: "anthropic" });
}

test("bash override closes to its owner and the audited child factory reproduces the parent fingerprint", async () => {
  let parent: ToolDefinition | undefined;
  const handlers = new Map<string, (...args: any[]) => void>();
  bashTimeout({ registerTool: tool => { parent = tool as ToolDefinition; }, on: (event, handler) => { handlers.set(event, handler); } } as ExtensionAPI);
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => "bash-parent" } } as ExtensionContext;
  handlers.get("session_start")!({}, ctx);
  try {
    const mainPath = fileURLToPath(new URL("../../../pi-bash-timeout/extensions/index.ts", import.meta.url));
    const resolved = closure({ ...parent!, sourceInfo: { path: mainPath, source: "extension", scope: "user", origin: "package" } }, "bash-parent");
    assert.deepEqual(resolved.diagnostics, []);
    assert.deepEqual(resolved.tools.map(tool => [tool.name, tool.owner_id]), [["bash", "pi-bash-timeout"]]);
    assert.deepEqual(resolved.owners.map(owner => owner.owner_id), ["pi-bash-timeout"]);
    assert.equal(resolved.owners[0]!.target.activation, "required-only");
    const entries = resolved.owners.map(owner => ({ owner: owner.owner_id, main_entrypoint: owner.manifest.main_entrypoint.canonical_path,
      child_entrypoint: owner.target.child_entrypoint.canonical_path, sha256: owner.target.child_entrypoint.sha256,
      tools: [...owner.target.tools], providers: [], hooks: [...owner.target.hooks], child_factory: { version: 1 as const, manifest: owner.manifest, target_id: owner.target_id, context: {} }, factory_required: true }));
    const profile = { capabilities: { entries } } as unknown as FrozenProfileV1;
    const input = { profile, agentDir: process.cwd(), sessionId: "bash-child", getBridge: () => undefined };
    const factories = await childExecutionFactories(input);
    assert.equal(factories.length, 1);
    let child: ToolDefinition | undefined;
    const registered = getOrCreateChildCapabilityRegistryV1().snapshot("bash-child");
    const factory = factories[0]!;
    await (typeof factory === "function" ? factory : factory.factory)({ registerTool: tool => { child = tool as ToolDefinition; } } as ExtensionAPI);
    assert.deepEqual(getOrCreateChildCapabilityRegistryV1().snapshot("bash-child"), registered, "child factory must not register ambient capability");
    assert.equal(toolDefinitionDigest({ name: child!.name, owner_id: "pi-bash-timeout", description: child!.description,
      parameters: JSON.parse(JSON.stringify(child!.parameters)), prompt_guidelines: child!.promptGuidelines ?? [] }), resolved.tools[0]!.definition_sha256);
    assert.deepEqual(child!.parameters, parent!.parameters);
    for (const change of [{ owner: "unknown" }, { sha256: "0".repeat(64) }]) {
      const changed = { ...profile, capabilities: { ...profile.capabilities, entries: [{ ...entries[0]!, ...change }] } };
      await assert.rejects(childExecutionFactories({ ...input, profile: changed }), /capability-(unavailable|drift)/);
    }
  } finally {
    handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  }
  const builtin = createBashToolDefinition(process.cwd());
  const unchanged = closure({ ...builtin, sourceInfo: { path: "builtin:bash", source: "builtin", scope: "temporary", origin: "top-level" } }, "without-package");
  assert.deepEqual(unchanged.tools.map(tool => [tool.name, tool.owner_id]), [["bash", "builtin"]]);
  assert.deepEqual(unchanged.owners, []);
  assert.deepEqual(unchanged.childEntrypoints, []);
  assert.deepEqual(builtin.parameters.required, ["command"]);
});
