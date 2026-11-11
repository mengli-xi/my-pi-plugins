import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hostPi from "@earendil-works/pi-coding-agent";
import { captureEntrypointDescriptorV1 as capture, createChildCapabilityRegistryV1, validateChildCapabilityManifestV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { approveSdkProviderV1, sdkProviderApprovalV1, loadSdkProviderFactoryV1, revalidateSdkProviderProofV1, sdkProviderBindingFenceV1, sdkProviderProofNarrowsV1, decodeSdkProviderProofV1 } from "../src/sdk-provider.ts";
import { loadApprovedFactoryModule } from "../src/factory-loader.ts";

function fixture(t: test.TestContext, exportName = "createProvider", source = 'export function createProvider(options) { return pi => { pi.record(options); }; }') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sdk-provider-grant-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(["package.json", "main.ts", "child.ts", "factory.ts", "delegate.ts", "observer.ts"].map(name => [name, join(root, name)]));
  writeFileSync(paths["package.json"]!, '{"name":"faux-unbranded-provider","type":"module"}');
  writeFileSync(paths["main.ts"]!, "export {};"); writeFileSync(paths["child.ts"]!, "export {};");
  writeFileSync(paths["delegate.ts"]!, "export const value = 1;");
  writeFileSync(paths["factory.ts"]!, source);
  writeFileSync(paths["observer.ts"]!, 'export function observe(bus) { return bus.on("faux:input", value => bus.emit("provider:activity-v1", value)); }');
  const manifest = validateChildCapabilityManifestV1({ version: 1, owner_id: "faux-sdk", main_entrypoint: capture(paths["main.ts"]!), targets: { "pi-subagents": {
    child_entrypoint: capture(paths["child.ts"]!), activation: "required-only", commands: [], tools: [], providers: [{ provider_id: "faux", service_tiers: [], service_tier_application: "none" }], hooks: [], requires: [], sdk_provider_factory: {
      provider_id: "faux", package_manifest: capture(paths["package.json"]!), module: capture(paths["factory.ts"]!), export: exportName,
      config: { agentDir: "cannot-override", modelIds: ["forged"] }, artifacts: [capture(paths["delegate.ts"]!)],
      observer: { module: capture(paths["observer.ts"]!), export: "observe", input_channel: "faux:input" },
    },
  } } });
  const grant = sdkProviderApprovalV1(manifest, "pi-subagents");
  const grantPath = join(root, "sdk-provider-grants.json");
  const grantIt = () => writeFileSync(grantPath, JSON.stringify({ version: 1, grants: [grant] }));
  const proof = () => approveSdkProviderV1(root, manifest, "pi-subagents", ["faux/a", "native/b"]);
  return { root, paths, manifest, grantPath, grantIt, proof };
}
const publicModules = { "@earendil-works/pi-coding-agent": hostPi };

test("unchanged malformed grants reuse the parsed failure and a new file version recovers", t => {
  const f = fixture(t);
  writeFileSync(f.grantPath, "{invalid");
  let first: unknown;
  assert.throws(f.proof, error => { assert.ok(error instanceof Error); first = error.cause; return first instanceof SyntaxError; });
  assert.throws(f.proof, error => error instanceof Error && error.cause === first);
  f.grantIt();
  assert.equal(f.proof().owner_id, f.manifest.owner_id);
});

test("external factories require exact grant; assembly fields cannot be overwritten; observer survives view detach and disposes", async t => {
  const f = fixture(t);
  assert.throws(f.proof, /未授权.*批准文件不存在/);
  f.grantIt(); const proof = f.proof();
  assert.throws(() => revalidateSdkProviderProofV1(proof, f.root, "pi-side-chat", proof.model_scope), /target\/model scope/);
  assert.throws(() => revalidateSdkProviderProofV1(proof, f.root, "pi-subagents", ["faux/a"]), /target\/model scope/);
  assert(sdkProviderProofNarrowsV1({ ...proof, model_scope: ["faux/a"] }, proof));
  assert(!sdkProviderProofNarrowsV1({ ...proof, model_scope: ["faux/extra"] }, proof));
  const disposers: Array<() => void> = [];
  const factory = await loadSdkProviderFactoryV1({ proof, agentDir: f.root, target: "pi-subagents", modelScope: proof.model_scope, publicModules, onDispose: dispose => disposers.push(dispose) });
  const listeners = new Map<string, (value: unknown) => void>(), events: unknown[] = [], calls: unknown[] = [], hooks = new Map<string, () => void>();
  const pi = { record: (options: unknown) => calls.push(options), events: {
    on: (channel: string, listener: (value: unknown) => void) => { listeners.set(channel, listener); return () => { listeners.delete(channel); }; }, emit: (_channel: string, value: unknown) => events.push(value),
  }, on: (event: string, listener: () => void) => hooks.set(event, listener) };
  await factory(pi as never);
  assert.deepEqual(calls, [{ version: 1, target: "pi-subagents", agentDir: f.root, providerId: "faux", modelIds: ["a"], config: { agentDir: "cannot-override", modelIds: ["forged"] } }]);
  assert.equal(listeners.size, 1);
  listeners.get("faux:input")!({ version: 1, provider: "faux", sessionId: "child", kind: "turn.end" }); assert.equal(events.length, 1);
  assert.throws(() => listeners.get("faux:input")!({ version: 1, provider: "different", sessionId: "child", kind: "turn.end" }), /invalid provider activity/);
  assert.equal(hooks.has("view_detach"), false);
  disposers.forEach(dispose => dispose()); assert.equal(listeners.size, 0);
  hooks.get("session_shutdown")!(); assert.equal(listeners.size, 0);
  writeFileSync(f.grantPath, '{"version":1,"grants":[]}');
  await assert.rejects(factory(pi as never) as Promise<void>, /未授权/);
  // Disk drift does not make persisted historical proofs undecodable.
  writeFileSync(f.paths["child.ts"]!, "changed"); assert.deepEqual(decodeSdkProviderProofV1(proof), proof);
});

for (const name of ["factory.ts", "delegate.ts", "package.json", "observer.ts", "child.ts", "main.ts"]) test(`actual ${name} drift rejects despite unchanged declaration/grant`, t => {
  const f = fixture(t); f.grantIt(); f.proof(); writeFileSync(f.paths[name]!, `changed ${name}`);
  assert.throws(f.proof, /live file identity/);
});

test("wrong export and symlink retarget fail closed", async t => {
  const f = fixture(t, "missingExport"); f.grantIt(); const proof = f.proof();
  await assert.rejects(loadSdkProviderFactoryV1({ proof, agentDir: f.root, target: "pi-subagents", modelScope: proof.model_scope, publicModules }), /export is missing/);
  const path = f.paths["delegate.ts"]!; unlinkSync(path); symlinkSync(f.paths["child.ts"]!, path);
  assert.throws(f.proof, /live file identity/);
});

test("loaded same-path code changes demand fresh process even with refreshed descriptors", async t => {
  const f = fixture(t); const path = f.paths["factory.ts"]!;
  await loadApprovedFactoryModule({ path, exports: ["createProvider"], publicModules });
  writeFileSync(path, 'export function createProvider() { return () => "replacement"; }');
  await assert.rejects(loadApprovedFactoryModule({ path, exports: ["createProvider"], publicModules }), /fresh process/);
});

test("release/rebind/replacement fences reject stale assembly", t => {
  const f = fixture(t); const registry = createChildCapabilityRegistryV1();
  const registration = registry.register({ version: 1, manifest: f.manifest });
  let binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: "main", runtime_generation: 1, mode: "rpc" });
  const fence = sdkProviderBindingFenceV1(registry.snapshot("main"), () => registry.snapshot("main"), "faux-sdk"); fence();
  binding.release(); assert.throws(fence, /binding changed/);
  binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: "main", runtime_generation: 2, mode: "rpc" });
  assert.throws(fence, /binding changed/); binding.release(); registration.release();
});

test("grant revocation across loader await rejects before returning an executable factory", async t => {
  const f = fixture(t); f.grantIt(); const proof = f.proof();
  const pending = loadSdkProviderFactoryV1({ proof, agentDir: f.root, target: "pi-subagents", modelScope: proof.model_scope, publicModules });
  writeFileSync(f.grantPath, '{"version":1,"grants":[]}');
  await assert.rejects(pending, /未授权/);
});

test("provider startup failure disposes the child observer even before execution ownership publishes", async t => {
  const f = fixture(t, "createProvider", 'export function createProvider() { return async () => { throw new Error("provider startup failed"); }; }');
  f.grantIt(); const proof = f.proof(); let listeners = 0;
  const factory = await loadSdkProviderFactoryV1({ proof, agentDir: f.root, target: "pi-subagents", modelScope: proof.model_scope, publicModules });
  await assert.rejects(factory({ on: () => {}, events: { on: () => { listeners++; return () => { listeners--; }; }, emit: () => {} } } as never) as Promise<void>, /provider startup failed/);
  assert.equal(listeners, 0);
});

test("owner release during factory loading rejects its stale binding and declaration", async t => {
  const f = fixture(t); f.grantIt(); const proof = f.proof();
  const registry = createChildCapabilityRegistryV1(), registration = registry.register({ version: 1, manifest: f.manifest });
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: "main", runtime_generation: 1, mode: "rpc" });
  const fence = sdkProviderBindingFenceV1(registry.snapshot("main"), () => registry.snapshot("main"), proof.owner_id, proof);
  const pending = loadSdkProviderFactoryV1({ proof, agentDir: f.root, target: "pi-subagents", modelScope: proof.model_scope, publicModules, fence });
  binding.release(); registration.release();
  await assert.rejects(pending, /binding changed/);
});
