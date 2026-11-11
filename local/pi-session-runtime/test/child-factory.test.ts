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
    badInstall: "export function createChild() { return pi => { pi.on('before_provider_request', () => {}); throw new Error('install failed'); }; }",
  };
  const proofs: Record<string, ChildFactoryProofV1> = {};
  for (const [name, source] of Object.entries(sources)) {
    await writeFile(join(root, `${name}.ts`), source);
    proofs[name] = { version: 1, target_id: "consumer", context: { enabled: true }, manifest: { version: 1, owner_id: "unknown-owner", main_entrypoint: captureEntrypointDescriptorV1(join(root, "main.ts")), targets: { consumer: { child_entrypoint: captureEntrypointDescriptorV1(join(root, `${name}.ts`)), child_factory: captureChildFactoryV1(join(root, "main.ts"), { module: `${name}.ts`, export: "createChild" }), activation: "mirror", commands: [], tools: [], providers: [], hooks: ["request/example-v1"], requires: [] } } } };
  }
  // Persistent journals sort object keys; integrity is independent of JSON key order.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  proofs.good = canonical(proofs.good) as ChildFactoryProofV1;
  const diagnostics: string[] = [], registered: string[] = [];
  const api = { on: (event: string) => registered.push(event) } as never;
  for (const name of ["badImport", "badExport", "badInstall", "good"]) {
    const factory = await loadChildFactoryV1({ proof: proofs[name]!, options: {}, publicModules: getSessionAssemblyPublicModules(), diagnostic: message => diagnostics.push(message) });
    if (factory) await factory(api);
  }
  assert.deepEqual(registered, ["before_provider_request"], "failed installation commits no partial hook");
  assert.equal(diagnostics.length, 3);
  await writeFile(join(root, "good.ts"), "throw new Error('drift must not execute');");
  assert.equal(await loadChildFactoryV1({ proof: proofs.good!, options: {}, publicModules: getSessionAssemblyPublicModules(), diagnostic: message => diagnostics.push(message) }), undefined);
  assert.match(diagnostics.at(-1)!, /capability-drift|live file identity/);
  await assert.rejects(loadChildFactoryV1({ proof: proofs.good!, required: true, options: {}, publicModules: getSessionAssemblyPublicModules(), diagnostic: () => {} }), /capability-drift|live file identity/);
});
