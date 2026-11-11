import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureChildFactoryV1, captureEntrypointDescriptorV1, createChildCapabilityRegistryV1, validateChildCapabilityManifestV1 } from "../src/child-capabilities-v1.ts";

test("declarations freeze the actual package and execution artifacts; only bound owners are discovered", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "child-declaration-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "third-party" }));
  for (const file of ["main.ts", "factory.ts", "delegate.ts"]) await writeFile(join(root, file), "// initial\n");
  const main = captureEntrypointDescriptorV1(join(root, "main.ts"));
  const declaration = captureChildFactoryV1(main.canonical_path, { module: "factory.ts", export: "createChild", artifacts: ["delegate.ts"] });
  const manifest = { version: 1 as const, owner_id: "third-party", main_entrypoint: main, targets: { consumer: { child_factory: declaration, child_entrypoint: captureEntrypointDescriptorV1(join(root, "factory.ts")), activation: "mirror" as const, commands: [], tools: [], providers: [], hooks: ["request/example-v1"], requires: [] } } };
  const registry = createChildCapabilityRegistryV1(), registration = registry.register({ version: 1, manifest });
  assert.equal(registry.snapshot("parent").registrations.length, 0);
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: "parent", runtime_generation: 1, mode: "rpc", capture_context: () => ({ enabled: true }) });
  const snapshot = registry.snapshot("parent");
  assert.equal(snapshot.registrations[0]!.manifest.targets.consumer!.child_factory!.package_name, "third-party");
  assert.deepEqual(snapshot.registrations[0]!.factory_context, { enabled: true });
  assert.ok(Object.isFrozen(snapshot.registrations[0]!.manifest.targets.consumer!.child_factory!.files));
  await writeFile(join(root, "delegate.ts"), "throw new Error('drifted delegate');\n");
  assert.throws(() => validateChildCapabilityManifestV1(manifest), /capability-drift/);
  assert.equal(snapshot.registrations[0]!.manifest.targets.consumer!.child_factory!.files[1]!.sha256, declaration.files[1]!.sha256);
  binding.release(); assert.equal(registry.snapshot("parent").registrations.length, 0); registration.release();
});

test("outside paths, symlink escapes and borrowed package names are rejected", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "child-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "package"); await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "actual-owner" }));
  await writeFile(join(pkg, "main.ts"), "// main"); await writeFile(join(root, "outside.ts"), "// outside");
  await symlink(join(root, "outside.ts"), join(pkg, "escape.ts"));
  for (const module of ["../outside.ts", "escape.ts", join(root, "outside.ts")]) assert.throws(() => captureChildFactoryV1(join(pkg, "main.ts"), { module, export: "createChild" }), /outside declaring package|package-relative/);
  assert.throws(() => captureChildFactoryV1(join(pkg, "main.ts"), { module: "main.ts", export: "createChild", package_name: "someone-else" }), /package name mismatch/);
});

test("one context callback failure cannot remove another registered owner", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "child-context-"))); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "main.ts"), "// main");
  const file = captureEntrypointDescriptorV1(join(root, "main.ts"));
  const registry = createChildCapabilityRegistryV1();
  for (const owner of ["broken", "healthy"]) {
    const registration = registry.register({ version: 1, manifest: { version: 1, owner_id: owner, main_entrypoint: file, targets: { consumer: { child_entrypoint: file, activation: "mirror", commands: [], tools: [], providers: [], hooks: ["request/example-v1"], requires: [] } } } });
    registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: "parent", runtime_generation: 1, mode: "rpc", capture_context: () => { if (owner === "broken") throw new Error("broken context"); return { healthy: true }; } });
  }
  const snapshot = registry.snapshot("parent");
  assert.equal(snapshot.registrations.length, 2);
  assert.deepEqual(snapshot.registrations.find(item => item.owner_id === "healthy")!.factory_context, { healthy: true });
});
