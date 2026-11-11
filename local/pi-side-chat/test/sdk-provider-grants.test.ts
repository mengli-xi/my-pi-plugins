import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { captureEntrypointDescriptorV1 as capture, getOrCreateChildCapabilityRegistryV1, validateChildCapabilityManifestV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import { sideExecutionPlan } from "../sdk-factories.ts";

test("Side never derives external provider authority from Subagents; explicit Side grant executes with frozen scope", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "side-provider-grants-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"name":"unbranded-sdk-fixture","type":"module"}');
  writeFileSync(join(root, "child.ts"), "export {};");
  const marker = join(root, "factory-executed");
  writeFileSync(join(root, "factory.ts"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export function create(options) { return pi => pi.record(options); }`);
  const descriptor = capture(join(root, "child.ts"));
  const target = { child_entrypoint: descriptor, activation: "required-only" as const, commands: [], tools: [], hooks: [], requires: [], providers: [{ provider_id: "custom", service_tiers: [], service_tier_application: "none" as const }],
    sdk_provider_factory: { provider_id: "custom", package_manifest: capture(join(root, "package.json")), module: capture(join(root, "factory.ts")), export: "create", config: {}, artifacts: [] } };
  const registry = getOrCreateChildCapabilityRegistryV1();
  const register = (id: string, targetId: string, sdk: boolean) => {
    const { sdk_provider_factory, ...legacy } = target;
    const manifest = validateChildCapabilityManifestV1({ version: 1, owner_id: id, main_entrypoint: descriptor, targets: { [targetId]: sdk ? target : legacy } });
    const registration = registry.register({ version: 1, manifest });
    const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: root, runtime_generation: 1, mode: "rpc" });
    t.after(() => { binding.release(); registration.release(); }); return manifest;
  };
  const subagent = register("subagent-provider", "pi-subagents", true);
  // Legacy provider and supplemental declarations coexist without owner conflicts.
  register("legacy-provider", "pi-side-chat", false);
  writeFileSync(join(root, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(subagent, "pi-subagents")] }));
  const provider = fauxProvider({ provider: "custom", api: "fixture", models: [{ id: "allowed" }, { id: "outside" }] });
  const model = provider.getModel();
  let reference = provider.provider;
  const context = { sessionManager: { getSessionId: () => root }, model, scopedModels: [{ model }], modelRegistry: { getAvailable: () => provider.provider.getModels(), getRegisteredProviderIds: () => ["custom"], getProvider: () => reference } };
  const pi = { getActiveTools: () => [], getAllTools: () => [] };
  await assert.rejects(sideExecutionPlan(pi as never, context as never, root), /current provider has no approved Side factory/);
  register("unapproved-side-provider", "pi-side-chat", true);
  const side = register("side-provider", "pi-side-chat", true);
  for (const state of ["未批准", "文件不存在", "文件损坏"]) {
    await t.test(state, async () => {
      const path = join(root, "sdk-provider-grants.json");
      if (state === "文件不存在") rmSync(path);
      else writeFileSync(path, state === "文件损坏" ? "{" : '{"version":1,"grants":[]}');
      await assert.rejects(sideExecutionPlan(pi as never, context as never, root), error => {
        assert.match(String(error), /未授权/);
        for (const text of ["custom", "pi-side-chat", path, "side-provider", "unapproved-side-provider"]) assert.ok(String(error).includes(text));
        return true;
      });
      assert.equal(existsSync(marker), false);
    });
  }
  writeFileSync(join(root, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(side, "pi-side-chat")] }));
  const plan = await sideExecutionPlan(pi as never, context as never, root);
  assert.deepEqual(plan.modelScope, ["custom/allowed"]);
  const factories = await plan.factories("child"), calls: unknown[] = [];
  await factories[0]!({ on: () => {}, record: (options: unknown) => calls.push(options) } as never);
  assert.deepEqual(calls, [{ version: 1, target: "pi-side-chat", agentDir: root, providerId: "custom", modelIds: ["allowed"], config: {} }]);
  reference = { ...provider.provider };
  assert.throws(plan.beforeExecution, /provider replaced/);
  reference = provider.provider;
  writeFileSync(join(root, "sdk-provider-grants.json"), '{"version":1,"grants":[]}');
  assert.throws(plan.beforeExecution, /未授权/);
  await plan.beforeDispose("startup-failed");
});
