import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureChildFactoryV1, captureEntrypointDescriptorV1 as capture } from "pi-runtime-contracts/child-capabilities-v1";
import { capabilityFingerprint } from "../../src/capabilities/fingerprint.ts";
import { childExecutionFactories } from "../../src/runtime/factory-catalog.ts";
import type { CapabilityEntryV1, FrozenProfileV1 } from "../../src/persistence/types.ts";

for (const spec of [
  { owner: "pi-native-search", directory: "extensions", child: "child.ts", factory: "index.ts", export: "createSearchChildFactory" },
  { owner: "pi-processes", directory: "dist", child: "child.js", factory: "child-factory.js", export: "createProcessesChildFactory" },
]) test(`${spec.owner} freezes its declared direct execution file, not only the child wrapper`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-factory-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, spec.directory), child = join(directory, spec.child), factory = join(directory, spec.factory);
  await mkdir(directory); await writeFile(join(root, "package.json"), JSON.stringify({ name: spec.owner }));
  await writeFile(child, "// unchanged thin child wrapper\n");
  const definition = { name: "fixture", description: "Frozen fixture", parameters: { type: "object", properties: {} } };
  await writeFile(factory, `export function ${spec.export}() { return pi => pi.registerTool(${JSON.stringify(definition)}); }`);
  const entry: CapabilityEntryV1 = { owner: spec.owner, main_entrypoint: factory, child_entrypoint: child, tools: ["fixture"], providers: [], hooks: [], sha256: capture(child).sha256 };
  const profile = { capabilities: { entries: [entry] } } as unknown as FrozenProfileV1;
  const input = { profile, agentDir: root, sessionId: "child", getBridge: () => undefined };
  await assert.rejects(childExecutionFactories(input), /frozen execution factory proof is missing/);
  const declaration = captureChildFactoryV1(factory, { module: `${spec.directory}/${spec.factory}`, export: spec.export });
  entry.child_factory = { version: 1, target_id: "pi-subagents", context: {}, manifest: { version: 1, owner_id: entry.owner, main_entrypoint: capture(factory), targets: { "pi-subagents": { child_entrypoint: capture(child), child_factory: declaration, tools: ["fixture"], providers: [], commands: [], hooks: [], requires: [], activation: "required-only" } } } };
  entry.factory_required = true;
  assert.equal(declaration.files[0]!.canonical_path, factory); assert.equal(declaration.export, spec.export);
  const factories = await childExecutionFactories(input), registered: unknown[] = [];
  assert.equal(factories.length, 1);
  const loaded = factories[0]!; await (typeof loaded === "function" ? loaded : loaded.factory)({ registerTool: (tool: unknown) => registered.push(tool) } as never);
  assert.deepEqual(registered, [definition]);
  for (const change of [{ providers: ["undeclared-provider"] }, { owner: "other-owner" }, { child_factory: { ...entry.child_factory, target_id: "pi-side-chat", manifest: { ...entry.child_factory.manifest, targets: { ...entry.child_factory.manifest.targets, "pi-side-chat": entry.child_factory.manifest.targets["pi-subagents"]! } } } }]) {
    const changed = { ...entry, ...change };
    await assert.rejects(childExecutionFactories({ ...input, profile: { capabilities: { entries: [changed] } } as unknown as FrozenProfileV1 }), /proof\/entry mismatch/);
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
    const optional = { ...changed, factory_required: false };
    const survivors = await childExecutionFactories({ ...input, profile: { capabilities: { entries: [optional, entry] } } as unknown as FrozenProfileV1 });
    assert.equal(survivors.length, 1, "a mismatched optional proof cannot block the next factory");
    assert.equal(warnings.length, 1); assert.match(warnings[0]!, /proof\/entry mismatch/);
    t.mock.restoreAll();
  }
  const frozenFingerprint = capabilityFingerprint(profile.capabilities);
  await writeFile(factory, "throw new Error('modified factory must not be evaluated');\n");
  assert.equal(capture(child).sha256, entry.sha256);
  await assert.rejects(childExecutionFactories(input), /capability-drift|live file identity/);
  const changed = captureChildFactoryV1(factory, { module: `${spec.directory}/${spec.factory}`, export: spec.export });
  assert.notEqual(capabilityFingerprint({ entries: [{ ...entry, child_factory: { ...entry.child_factory, manifest: { ...entry.child_factory.manifest, targets: { "pi-subagents": { ...entry.child_factory.manifest.targets["pi-subagents"]!, child_factory: changed } } } } }] }), capabilityFingerprint({ entries: [entry] }));
  assert.equal(capabilityFingerprint(profile.capabilities), frozenFingerprint, "checking drift never rewrites the frozen proof");
  await rm(factory); await writeFile(join(root, "elsewhere.ts"), "// replacement file\n"); await symlink(join(root, "elsewhere.ts"), factory);
  await assert.rejects(childExecutionFactories(input), /capability-drift|live file identity/);
  assert.equal(await readFile(child, "utf8"), "// unchanged thin child wrapper\n");
});
