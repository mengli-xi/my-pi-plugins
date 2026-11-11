import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureChildFactoryV1, captureEntrypointDescriptorV1, type ChildFactoryProofV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { getSessionAssemblyPublicModules } from "../src/session-assembly.ts";
import { loadChildFactoryV1 } from "../src/child-factory.ts";

test("unknown factories load by declaration; failed import/export/install and SHA drift are isolated", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-child-factory-"))); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "unknown-owner", type: "module" }));
  await writeFile(join(root, "main.ts"), "// main\n");
  const sources = {
    good: "export function createChild(options) { return pi => pi.on('before_provider_request', () => options.context); }",
    badImport: "throw new Error('import failed'); export function createChild() {}",
    badExport: "export function differentExport() {}",
    badSchema: "export function createChild() { return pi => { pi.on('before_provider_request', () => {}); pi.registerTool({ name: 'fixture', parameters: null }); }; }",
    badCommand: "export function createChild() { return pi => { pi.on('before_provider_request', () => {}); pi.registerCommand('probe', { handler: null }); }; }",
    badAsync: "export function createChild() { return async pi => { pi.on('before_provider_request', () => {}); await Promise.reject(new Error('async install failed')); }; }",
    badInstall: "export function createChild() { return pi => { pi.on('before_provider_request', () => {}); throw new Error('install failed'); }; }",
  };
  const proofs: Record<string, ChildFactoryProofV1> = {};
  for (const [name, source] of Object.entries(sources)) {
    await writeFile(join(root, `${name}.ts`), source);
    proofs[name] = { version: 1, target_id: "consumer", context: { enabled: true }, manifest: { version: 1, owner_id: "unknown-owner", main_entrypoint: captureEntrypointDescriptorV1(join(root, "main.ts")), targets: { consumer: { child_entrypoint: captureEntrypointDescriptorV1(join(root, `${name}.ts`)), child_factory: captureChildFactoryV1(join(root, "main.ts"), { module: `${name}.ts`, export: "createChild" }), activation: "mirror", commands: name === "badCommand" ? ["probe"] : [], tools: name === "badSchema" ? ["fixture"] : [], providers: [], hooks: ["request/example-v1"], requires: [] } } } };
  }
  // Persistent journals sort object keys; integrity is independent of JSON key order.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  proofs.good = canonical(proofs.good) as ChildFactoryProofV1;
  const diagnostics: string[] = [], registered: string[] = [];
  const api = { on: (event: string) => registered.push(event) } as never;
  for (const name of ["badImport", "badExport", "badInstall", "badSchema", "badCommand", "badAsync", "good"]) {
    const factory = await loadChildFactoryV1({ proof: proofs[name]!, options: {}, publicModules: getSessionAssemblyPublicModules(), diagnostic: message => diagnostics.push(message) });
    if (factory) await factory(api);
  }
  assert.deepEqual(registered, ["before_provider_request"], "failed installation commits no partial hook");
  assert.equal(diagnostics.length, 6);
  await writeFile(join(root, "good.ts"), "throw new Error('drift must not execute');");
  assert.equal(await loadChildFactoryV1({ proof: proofs.good!, options: {}, publicModules: getSessionAssemblyPublicModules(), diagnostic: message => diagnostics.push(message) }), undefined);
  assert.match(diagnostics.at(-1)!, /capability-drift|live file identity/);
  await assert.rejects(loadChildFactoryV1({ proof: proofs.good!, required: true, options: {}, publicModules: getSessionAssemblyPublicModules(), diagnostic: () => {} }), /capability-drift|live file identity/);
});

test("cancellation retains the factory receiver and isolates only optional failures", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "child-cancel-"))); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "cancel-owner", type: "module" }));
  await writeFile(join(root, "child.ts"), `export function createChild() {
    const factory = Object.assign(pi => pi.on('session_shutdown', () => {}), { cancelPending: async function() {
      if (this !== factory) throw new Error('wrong cancellation receiver');
      throw new Error('cancel failed');
    } });
    return factory;
  }`);
  const main = captureEntrypointDescriptorV1(join(root, "child.ts"));
  const proof: ChildFactoryProofV1 = { version: 1, target_id: "consumer", context: {}, manifest: { version: 1, owner_id: "cancel-owner", main_entrypoint: main, targets: { consumer: {
    child_entrypoint: main, child_factory: captureChildFactoryV1(main.canonical_path, { module: "child.ts", export: "createChild" }), activation: "mirror", commands: [], tools: [], providers: [], hooks: ["execution/cancel-pending-v1"], requires: [],
  } } } };
  for (const required of [false, true]) {
    let cancel!: () => Promise<void>;
    const diagnostics: string[] = [];
    const factory = await loadChildFactoryV1({ proof, required, options: {}, publicModules: getSessionAssemblyPublicModules(), diagnostic: message => diagnostics.push(message), onCancel: callback => { cancel = callback; } });
    assert.ok(factory); await factory({ on: () => () => {} } as never);
    if (required) await assert.rejects(cancel(), /cancel failed/);
    else await assert.doesNotReject(cancel());
    assert.equal(diagnostics.length, 1); assert.match(diagnostics[0]!, /cancel failed/);
  }
});
