import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureExecutionFactoryV1, revalidateExecutionFactoryV1 } from "../../src/capabilities/execution-factory.ts";
import { capabilityFingerprint } from "../../src/capabilities/fingerprint.ts";
import { childExecutionFactories } from "../../src/runtime/factory-catalog.ts";
import type { CapabilityEntryV1, FrozenProfileV1 } from "../../src/persistence/types.ts";

for (const spec of [
  { owner: "pi-native-search", directory: "extensions", child: "child.ts", factory: "index.ts", exports: ["createSearchChildFactory", "loadSearchConfig"] },
  { owner: "pi-processes", directory: "dist", child: "child.js", factory: "child-factory.js", exports: ["createProcessesChildFactory"] },
]) {
  test(`${spec.owner} freezes its direct execution file, not only the child wrapper`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-factory-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, spec.directory), child = join(directory, spec.child), factory = join(directory, spec.factory);
    await mkdir(directory);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: spec.owner }));
    await writeFile(child, "// unchanged thin child wrapper\n");
    const definition = { name: "fixture", description: "Frozen fixture", parameters: { type: "object", properties: {} } };
    const implementation = spec.owner === "pi-native-search"
      ? `export function loadSearchConfig() { return {}; } export function createSearchChildFactory() { return pi => pi.registerTool(${JSON.stringify(definition)}); }`
      : `export function createProcessesChildFactory() { return Object.assign(pi => pi.registerTool(${JSON.stringify(definition)}), { cancelPending: async () => {} }); }`;
    await writeFile(factory, implementation);
    const entry: CapabilityEntryV1 = { owner: spec.owner, main_entrypoint: factory, child_entrypoint: child, tools: ["fixture"], providers: [], hooks: [], sha256: createHash("sha256").update(await readFile(child)).digest("hex") };
    const profile = { capabilities: { entries: [entry] } } as unknown as FrozenProfileV1;
    const input = { profile, agentDir: root, sessionId: "child", getBridge: () => undefined };
    await assert.rejects(childExecutionFactories(input), /frozen execution factory proof is missing/);
    entry.execution_factory = await captureExecutionFactoryV1(entry.owner, child);
    assert.deepEqual(entry.execution_factory?.exports, spec.exports);
    assert.equal(entry.execution_factory?.canonical_path, factory);
    assert.deepEqual(await revalidateExecutionFactoryV1(entry), entry.execution_factory);
    const factories = await childExecutionFactories(input), registered: unknown[] = [];
    assert.equal(factories.length, 1);
    const loaded = factories[0]!;
    await (typeof loaded === "function" ? loaded : loaded.factory)({ registerTool: (tool: unknown) => registered.push(tool) } as never);
    assert.deepEqual(registered, [definition]);
    const frozenFingerprint = capabilityFingerprint(profile.capabilities);
    await writeFile(factory, "throw new Error('modified factory must not be evaluated');\n");
    assert.equal(createHash("sha256").update(await readFile(child)).digest("hex"), entry.sha256);
    await assert.rejects(childExecutionFactories(input), /capability-drift: execution factory changed/);
    const changed = await captureExecutionFactoryV1(entry.owner, child);
    assert.notEqual(capabilityFingerprint({ entries: [{ ...entry, execution_factory: changed }] }), capabilityFingerprint({ entries: [entry] }));
    assert.equal(capabilityFingerprint(profile.capabilities), frozenFingerprint, "checking drift never rewrites the frozen proof");
    for (const proof of [{ ...changed!, canonical_path: child }, { ...changed!, exports: ["arbitraryLoader"] }]) {
      await assert.rejects(revalidateExecutionFactoryV1({ ...entry, execution_factory: proof }), /proof\/entry mismatch/);
    }
    await rm(factory);
    await writeFile(join(root, "elsewhere.ts"), "// not a direct factory\n");
    await symlink(join(root, "elsewhere.ts"), factory);
    await assert.rejects(captureExecutionFactoryV1(entry.owner, child), /not the direct audited target/);
  });
}
