import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { installClaudeStyleChildCapability } from "../src/child-capability.ts";

test("declares and releases both Claude-style child presentation targets", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cc-style-child-")));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-claude-style", type: "module" }));
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.ts"), "export default()=>{}\n");
  await writeFile(join(dist, "child.ts"), "export default()=>{}\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = getOrCreateChildCapabilityRegistryV1();
  const capability = installClaudeStyleChildCapability(dist);
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "cc-style-child-test" } } as never;
  capability.bind(ctx);
  const registration = registry.snapshot("cc-style-child-test").registrations.find((entry) => entry.owner_id === "pi-claude-style");
  assert.ok(registration);
  assert.deepEqual(Object.keys(registration.manifest.targets), ["pi-side-chat", "pi-subagents"]);
  for (const target of Object.values(registration.manifest.targets)) {
    assert.equal(target.child_factory?.package_name, "pi-claude-style");
    assert.equal(target.child_factory?.module, "dist/child.ts");
    assert.equal(target.child_factory?.export, "createClaudeStyleChildExtension");
    assert.equal(target.child_factory?.kind, "presentation");
    assert.equal(target.activation, "mirror");
    assert.deepEqual(target.commands, []);
    assert.deepEqual(target.tools, []);
    assert.deepEqual(target.providers, []);
    assert.deepEqual(target.hooks, ["presentation/claude-style-v1"]);
    assert.deepEqual(target.requires, []);
    assert.equal(target.child_entrypoint.canonical_path, join(dist, "child.ts"));
  }
  assert.deepEqual(
    registration.manifest.targets["pi-side-chat"]?.child_entrypoint,
    registration.manifest.targets["pi-subagents"]?.child_entrypoint,
  );
  capability.release(ctx);
  capability.dispose();
  assert.equal(registry.snapshot("cc-style-child-test").registrations.some((entry) => entry.owner_id === "pi-claude-style"), false);
});
