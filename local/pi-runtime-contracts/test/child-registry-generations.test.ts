import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const current = new URL("../src/child-capabilities-v1.ts", import.meta.url).href;
const legacy = new URL("./fixtures/child-registry-abi1/index.ts", import.meta.url).href;
function run(script: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { encoding: "utf8" });
}
for (const order of ["old-first", "new-first"]) test(`physical ABI 1/2 libraries coexist and register their actual schemas: ${order}`, () => {
  const result = run(`
    import assert from "node:assert/strict";
    import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const root = realpathSync(mkdtempSync(join(tmpdir(), "child-registry-generations-")));
    try {
      let oldApi, newApi, oldRegistry, newRegistry;
      if (${JSON.stringify(order)} === "old-first") {
        oldApi = await import(${JSON.stringify(legacy)}); oldRegistry = oldApi.getOrCreateChildCapabilityRegistryV1();
        newApi = await import(${JSON.stringify(current)}); newRegistry = newApi.getOrCreateChildCapabilityRegistryV1();
      } else {
        newApi = await import(${JSON.stringify(current)}); newRegistry = newApi.getOrCreateChildCapabilityRegistryV1();
        oldApi = await import(${JSON.stringify(legacy)}); oldRegistry = oldApi.getOrCreateChildCapabilityRegistryV1();
      }
      assert.notEqual(oldRegistry, newRegistry);
      assert.equal(oldRegistry.version, 1); assert.equal(newRegistry.version, 2);
      const oldKey = Symbol.for("pi.child-capability-registry.v1"), newKey = Symbol.for("pi.child-capability-registry.v2");
      assert.equal(globalThis[oldKey], oldRegistry); assert.equal(globalThis[newKey], newRegistry);
      assert.equal(globalThis[newKey].operationVersion, 2);
      assert.equal(globalThis[newKey].brand, "pi-child-capability-registry-v2");
      writeFileSync(join(root, "entry.ts"), "export function create() {};");
      writeFileSync(join(root, "package.json"), '{"name":"unbranded-generation-fixture"}');
      const descriptor = newApi.captureEntrypointDescriptorV1(join(root, "entry.ts"));
      const target = { child_entrypoint: descriptor, activation: "required-only", commands: [], tools: [], providers: [{ provider_id: "faux", service_tiers: [], service_tier_application: "none" }], hooks: [], requires: [] };
      const legacyManifest = { version: 1, owner_id: "legacy-provider", main_entrypoint: descriptor, targets: { "pi-subagents": target } };
      const sdk = { provider_id: "faux", package_manifest: newApi.captureEntrypointDescriptorV1(join(root, "package.json")), module: descriptor, export: "create", config: {}, artifacts: [] };
      const supplemental = { ...legacyManifest, owner_id: "external-sdk-faux", targets: { "pi-subagents": { ...target, sdk_provider_factory: sdk } } };
      const oldRegistration = oldRegistry.register({ version: 1, manifest: legacyManifest });
      const oldBinding = oldRegistry.bind({ version: 1, registrationToken: oldRegistration.registrationToken, session_id: "main", runtime_generation: 1, mode: "rpc" });
      // This is the actual old validator closure, not a permissive mock.
      assert.throws(() => oldRegistry.register({ version: 1, manifest: supplemental }), /unknown key/);
      const registration = newRegistry.register({ version: 1, manifest: supplemental });
      const binding = newRegistry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: "main", runtime_generation: 1, mode: "rpc" });
      const snapshot = newRegistry.snapshot("main");
      assert.equal(snapshot.version, 1); // DTOs are unchanged, manager ABI is not.
      assert.deepEqual(snapshot.registrations.map(item => item.owner_id), ["external-sdk-faux"]);
      assert.equal(snapshot.registrations[0].manifest.targets["pi-subagents"].sdk_provider_factory.export, "create");
      assert.deepEqual(oldRegistry.snapshot("main").registrations.map(item => item.owner_id), ["legacy-provider"]);
      const closure = newApi.resolveChildCapabilityClosureV1({ snapshot, target_id: "pi-subagents", required_owner_ids: ["external-sdk-faux"], active_commands: [], active_tools: [], active_providers: ["faux"], required_capabilities: [] });
      assert.deepEqual(closure.owners.map(item => item.owner_id), ["external-sdk-faux"]);
      oldBinding.release(); oldRegistration.release();
      assert.equal(newRegistry.snapshot("main").registrations.length, 1);
      binding.release(); registration.release();
      assert.equal(newRegistry.snapshot("main").registrations.length, 0);
      assert.equal(oldApi.getOrCreateChildCapabilityRegistryV1(), oldRegistry);
      assert.equal(newApi.getOrCreateChildCapabilityRegistryV1(), newRegistry);
    } finally { rmSync(root, { recursive: true, force: true }); }
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("an unknown legacy holder neither supplies nor blocks the new schema manager", () => {
  const result = run(`
    import assert from "node:assert/strict";
    const unknown = Object.freeze({ version: 999 });
    Object.defineProperty(globalThis, Symbol.for("pi.child-capability-registry.v1"), { value: unknown });
    const api = await import(${JSON.stringify(current)});
    const manager = api.getOrCreateChildCapabilityRegistryV1();
    assert.equal(manager.version, 2);
    assert.equal(globalThis[Symbol.for("pi.child-capability-registry.v1")], unknown);
    assert.notEqual(manager, unknown);
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("an ABI-1-shaped manager placed under the ABI-2 key is rejected, never adopted", () => {
  const result = run(`
    import assert from "node:assert/strict";
    const oldApi = await import(${JSON.stringify(legacy)});
    const old = oldApi.getOrCreateChildCapabilityRegistryV1();
    Object.defineProperty(globalThis, Symbol.for("pi.child-capability-registry.v2"), { value: old });
    const api = await import(${JSON.stringify(current)});
    assert.throws(() => api.getOrCreateChildCapabilityRegistryV1(), /incompatible Pi child capability registry cell/);
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
