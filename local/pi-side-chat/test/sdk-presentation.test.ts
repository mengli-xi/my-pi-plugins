import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ViewLifecycle } from "pi-session-runtime/managed-interactive";
import { captureChildFactoryV1, captureEntrypointDescriptorV1, getOrCreateChildCapabilityRegistryV1, type ChildCapabilityManifestV1 } from "pi-runtime-contracts/child-capabilities-v1";
const fixtureRoots: string[] = [];
test.after(async () => { for (const root of fixtureRoots) await rm(root, { recursive: true, force: true }); });

import { sidePresentationFactories } from "../sdk-factories.ts";

async function presentationFixture(options: { source?: string; target?: string; packageName?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "side-presentation-"));
  fixtureRoots.push(root);
  const directory = join(root, "dist");
  await mkdir(directory);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: options.packageName ?? "pi-claude-style" }));
  await writeFile(join(directory, "index.ts"), "export default () => {};\n");
  const path = join(directory, "child.ts");
  await writeFile(path, options.source ?? "throw new Error('Rejected factories must not load');\n");
  const registry = getOrCreateChildCapabilityRegistryV1();
  const sessionId = randomUUID();
  const manifest = { version: 1 as const, owner_id: "pi-claude-style", main_entrypoint: captureEntrypointDescriptorV1(join(directory, "index.ts")),
    targets: { [options.target ?? "pi-side-chat"]: { child_factory: captureChildFactoryV1(join(directory, "index.ts"), { module: "dist/child.ts", export: "createClaudeStyleChildExtension", kind: "presentation", package_name: "pi-claude-style" }), child_entrypoint: captureEntrypointDescriptorV1(path), activation: "mirror" as const,
      tools: [], providers: [], commands: [], hooks: ["presentation/claude-style-v1"], requires: [] } } };
  const registration = registry.register({ version: 1, manifest });
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: sessionId, runtime_generation: 1, mode: "rpc" });
  const owner = registry.snapshot(sessionId).registrations.find(item => item.owner_id === "pi-claude-style")!;
  const presentationOwners = [{ ...owner, target_id: "pi-side-chat", target: owner.manifest.targets["pi-side-chat"]! }];
  return { ctx: { sessionManager: { getSessionId: () => sessionId } } as ExtensionContext, manifest, path, presentationOwners,
    async dispose() { binding.release(); registration.release(); await rm(root, { recursive: true, force: true }); } };
}

test("Side uses native presentation when CC Style has no bound descriptor", async () => {
  const sessionId = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
  assert.deepEqual(await sidePresentationFactories(ctx, {} as ViewLifecycle), []);
});

test("Side uses native presentation when CC Style declares no Side target", async () => {
  const fixture = await presentationFixture({ target: "pi-subagents" });
  try { assert.deepEqual(await sidePresentationFactories(fixture.ctx, {} as ViewLifecycle), []); }
  finally { await fixture.dispose(); }
});

test("Side loads the display-only factory with independent view lifecycle options", async () => {
  const fixture = await presentationFixture({ source: `export function createClaudeStyleChildExtension(options) {
    return pi => pi.on("session_start", () => options);
  }\n` });
  try {
    const firstLifecycle = {} as ViewLifecycle, secondLifecycle = {} as ViewLifecycle;
    const [first] = await sidePresentationFactories(fixture.ctx, firstLifecycle);
    const [second] = await sidePresentationFactories(fixture.ctx, secondLifecycle);
    const captured: unknown[] = [];
    const pi = { on(event: string, handler: () => unknown) { assert.equal(event, "session_start"); captured.push(handler()); } } as unknown as ExtensionAPI;
    assert.equal(typeof first, "function");
    assert.equal(typeof second, "function");
    assert.notEqual(first, second);
    first!(pi); second!(pi);
    assert.deepEqual(captured, [firstLifecycle, secondLifecycle].map(viewLifecycle => ({
      context: {}, target: "side-chat", taskName: "Side", returnLabel: "Alt+/ Main", readOnlyStatusline: true, viewLifecycle,
    })));
    assert.equal((captured[0] as { viewLifecycle: ViewLifecycle }).viewLifecycle, firstLifecycle);
    assert.equal((captured[1] as { viewLifecycle: ViewLifecycle }).viewLifecycle, secondLifecycle);
  } finally { await fixture.dispose(); }
});

test("a supplied presentation plan does not consult the live session or registry", async () => {
  const fixture = await presentationFixture({ source: "export function createClaudeStyleChildExtension() { return pi => pi.on('session_start', () => {}); }" });
  try {
    const registration = getOrCreateChildCapabilityRegistryV1().snapshot(fixture.ctx.sessionManager.getSessionId()).registrations.find(item => item.owner_id === "pi-claude-style")!;
    const owner = { ...registration, target_id: "pi-side-chat", target: registration.manifest.targets["pi-side-chat"]! };
    const unavailable = { sessionManager: { getSessionId() { throw new Error("live session must not be read"); } } } as unknown as ExtensionContext;
    const factories = await sidePresentationFactories(unavailable, {} as ViewLifecycle, { presentationOwners: [owner] });
    assert.equal(factories.length, 1);
    assert.deepEqual(await sidePresentationFactories(unavailable, {} as ViewLifecycle, {}), []);
  } finally { await fixture.dispose(); }
});

test("Side rejects a changed required presentation file rather than falling back to native", async () => {
  const fixture = await presentationFixture();
  try {
    await writeFile(fixture.path, "throw new Error('Drifted factories must not load');\n");
    await assert.rejects(sidePresentationFactories(fixture.ctx, {} as ViewLifecycle, { presentationOwners: fixture.presentationOwners, requiredOwnerIds: ["pi-claude-style"] }), /capability-drift|live file identity/);
  } finally { await fixture.dispose(); }
});

test("Side skips only an optional presentation whose file drifted", async () => {
  const fixture = await presentationFixture();
  try { await writeFile(fixture.path, "throw new Error('must not import drift');\n"); assert.deepEqual(await sidePresentationFactories(fixture.ctx, {} as ViewLifecycle), []); }
  finally { await fixture.dispose(); }
});

test("Side rejects conflicting presentation descriptors rather than treating them as absent", async () => {
  const fixture = await presentationFixture();
  const registration = getOrCreateChildCapabilityRegistryV1().register({ version: 1, manifest: { ...fixture.manifest,
    targets: { "pi-side-chat": { ...fixture.manifest.targets["pi-side-chat"]!, hooks: ["presentation/other-v1"] } } } });
  try { await assert.rejects(sidePresentationFactories(fixture.ctx, {} as ViewLifecycle), /registry conflict/); }
  finally { registration.release(); await fixture.dispose(); }
});

test("Side rejects an invalid presentation package identity", async () => {
  await assert.rejects(presentationFixture({ packageName: "unapproved-presentation" }), /declaring package name mismatch/);

});

test("Side rejects a presentation module without the approved factory export", async () => {
  const fixture = await presentationFixture({ source: "export const createClaudeStyleChildExtension = null;\n" });
  try { await assert.rejects(sidePresentationFactories(fixture.ctx, {} as ViewLifecycle, { presentationOwners: fixture.presentationOwners, requiredOwnerIds: ["pi-claude-style"] }), /Approved factory export is missing/); }
  finally { await fixture.dispose(); }
});

test("Side rejects malformed published descriptors at registration", async () => {
  const fixture = await presentationFixture();
  try {
    for (const target of [
      { ...fixture.manifest.targets["pi-side-chat"]!, child_entrypoint: undefined },
      { ...fixture.manifest.targets["pi-side-chat"]!, child_entrypoint: { ...fixture.manifest.targets["pi-side-chat"]!.child_entrypoint, sha256: "0".repeat(64) } },
    ]) assert.throws(() => getOrCreateChildCapabilityRegistryV1().register({ version: 1,
      manifest: { ...fixture.manifest, targets: { "pi-side-chat": target } } as unknown as ChildCapabilityManifestV1 }), /child_entrypoint|live file identity/);
  } finally { await fixture.dispose(); }
});

test("Side rejects execution-capable presentation declarations and an undeclared JavaScript replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-presentation-"));
  fixtureRoots.push(root);
  const directory = join(root, "dist");
  await mkdir(directory);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-claude-style" }));
  await writeFile(join(directory, "index.ts"), "export default () => {};\n");
  for (const filename of ["child.ts", "child.js"]) await writeFile(join(directory, filename), "throw new Error('Rejected factories must not load');\n");
  const registry = getOrCreateChildCapabilityRegistryV1();
  try {
    for (const candidate of [
      { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] },
      { tools: ["other-execution"] },
      { providers: [{ provider_id: "other-provider", service_tiers: [], service_tier_application: "none" as const }] },
      { commands: ["other-command"] },
      { sdk_provider_factory: { provider_id: "other-provider", package_manifest: captureEntrypointDescriptorV1(join(root, "package.json")),
        module: captureEntrypointDescriptorV1(join(directory, "child.ts")), export: "createProvider", config: {}, artifacts: [] } },
      { filename: "child.js" },
    ]) {
      const declaration = captureChildFactoryV1(join(directory, "index.ts"), { module: "dist/child.ts", export: "createClaudeStyleChildExtension", kind: "presentation" });
      assert.throws(() => registry.register({ version: 1, manifest: { version: 1, owner_id: "pi-claude-style",
        main_entrypoint: captureEntrypointDescriptorV1(join(directory, "index.ts")), targets: { "pi-side-chat": {
          child_factory: candidate.filename ? { ...declaration, module: "dist/child.js" } : declaration,
          child_entrypoint: captureEntrypointDescriptorV1(join(directory, candidate.filename ?? "child.ts")), activation: "mirror",
          tools: [...candidate.tools ?? []].sort(), providers: candidate.providers ?? [], commands: candidate.commands ?? [], hooks: ["presentation/claude-style-v1"], requires: [],
          ...(candidate.sdk_provider_factory ? { sdk_provider_factory: candidate.sdk_provider_factory } : {}),
        } } } }), candidate.filename ? /capability-drift/ : /display-only|cannot authorize providers/);

    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
