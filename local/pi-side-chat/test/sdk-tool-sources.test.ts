import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { captureChildFactoryV1, captureEntrypointDescriptorV1 as capture, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { sideExecutionPlan } from "../sdk-factories.ts";

test("Side canonicalizes absolute symlinks and package-relative tool sources, and diagnoses omitted tools", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "side-tool-sources-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tool-source-owner", type: "module" }));
  await writeFile(join(root, "main.ts"), "// main");
  await writeFile(join(root, "child.ts"), "export function createChild() { return pi => pi.registerTool({ name: 'probe', description: 'fixture', parameters: { type: 'object' } }); }");
  await symlink(join(root, "main.ts"), join(root, "alias.ts"));
  const sessionId = randomUUID(), registry = getOrCreateChildCapabilityRegistryV1();
  const registration = registry.register({ version: 1, manifest: { version: 1, owner_id: "tool-source-owner", main_entrypoint: capture(join(root, "main.ts")), targets: { "pi-side-chat": {
    child_entrypoint: capture(join(root, "child.ts")), child_factory: captureChildFactoryV1(join(root, "main.ts"), { module: "child.ts", export: "createChild" }), activation: "required-only", commands: [], tools: ["probe"], providers: [], hooks: [], requires: [],
  } } } });
  t.after(() => registration.release());
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: sessionId, runtime_generation: 1, mode: "rpc" });
  t.after(() => binding.release());
  const model = fauxProvider({ provider: "public-fixture", api: "fixture", models: [{ id: "fixture" }] }).getModel();
  const ctx = { sessionManager: { getSessionId: () => sessionId }, model, scopedModels: [], modelRegistry: { getAvailable: () => [model], getRegisteredProviderIds: () => [] } } as unknown as ExtensionContext;
  for (const source of [{ path: join(root, "alias.ts") }, { path: "alias.ts", baseDir: root }]) {
    const pi = { getActiveTools: () => ["probe"], getAllTools: () => [{ name: "probe", sourceInfo: { ...source, source: "extension" } }] } as unknown as ExtensionAPI;
    const plan = await sideExecutionPlan(pi, ctx, root);
    assert.deepEqual(plan.tools, ["probe"]);
    const factories = await plan.factories("side");
    const registered: string[] = [];
    for (const factory of factories) await factory({ registerTool: (tool: { name: string }) => registered.push(tool.name) } as unknown as ExtensionAPI);
    assert.deepEqual(registered, ["probe"]);
  }
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const pi = { getActiveTools: () => ["unknown", "missing"], getAllTools: () => [
    { name: "unknown", sourceInfo: { path: join(root, "child.ts"), source: "extension" } },
    { name: "missing", sourceInfo: { path: "missing.ts", source: "extension" } },
  ] } as unknown as ExtensionAPI;
  const plan = await sideExecutionPlan(pi, ctx, root);
  assert.deepEqual(plan.tools, []);
  assert.deepEqual(await plan.factories("side"), []);
  assert.ok(warnings.some(message => message.includes("unknown") && message.includes(join(root, "child.ts"))));
  assert.ok(warnings.some(message => message.includes("missing") && message.includes("missing.ts")));
});
