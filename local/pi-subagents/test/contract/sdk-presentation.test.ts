import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureChildFactoryV1, captureEntrypointDescriptorV1 as capture, getOrCreateChildCapabilityRegistryV1, validateChildCapabilityManifestV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { approveSdkProviderV1, sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import { ViewLifecycle } from "pi-session-runtime/managed-interactive";
import { childExecutionFactories, childPresentationFactories } from "../../src/runtime/factory-catalog.ts";
import { childViewExtension } from "../../src/runtime/child-session.ts";
import type { FrozenProfileV1 } from "../../src/persistence/types.ts";

test("old frozen Pinned entries need no file while CC entrypoint drift remains enforced", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cc-presentation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-claude-style", type: "module" }));
  const source = `import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import * as tui from "@earendil-works/pi-tui";
export function createClaudeStyleChildExtension() { return pi => pi.capture(codingAgent.AgentSession, ai.normalizeContext, tui.Container); }`;
  const path = join(root, "dist/child.ts");
  await writeFile(path, source);
  const childFactory = { version: 1 as const, target_id: "pi-subagents", context: {}, manifest: { version: 1 as const, owner_id: "pi-claude-style", main_entrypoint: capture(path), targets: { "pi-subagents": { child_entrypoint: capture(path), child_factory: captureChildFactoryV1(path, { module: "dist/child.ts", export: "createClaudeStyleChildExtension", kind: "presentation" }), activation: "mirror" as const, commands: [], tools: [], providers: [], hooks: ["presentation/claude-style-v1"], requires: [] } } } };
  const profile = { capabilities: { entries: [
    { owner: "pi-pinned-layout", providers: [], tools: [], hooks: ["presentation/pinned-layout-v1"],
      child_entrypoint: join(root, "retired/dist/child.js"), sha256: "0".repeat(64) },
    { owner: "pi-claude-style", providers: [], tools: [], child_factory: childFactory, factory_required: true,
      hooks: ["presentation/claude-style-v1"], child_entrypoint: path,
      sha256: createHash("sha256").update(source).digest("hex") },
  ] } } as unknown as FrozenProfileV1;
  const lifecycle = new ViewLifecycle();
  const factories = await childPresentationFactories(profile, lifecycle, "old-child");
  assert.equal(factories.length, 1);
  let captured: unknown[] = [];
  await factories[0]!({ capture: (...values: unknown[]) => { captured = values; } } as never);
  const assembly = await import("pi-session-runtime/session-assembly");
  const modules = assembly.getSessionAssemblyPublicModules();
  assert.deepEqual(captured, [modules["@earendil-works/pi-coding-agent"].AgentSession, modules["@earendil-works/pi-ai"].normalizeContext, modules["@earendil-works/pi-tui"].Container]);
  assert.deepEqual(await childExecutionFactories({ profile, agentDir: root, sessionId: "old-child", getBridge: () => undefined }), []);
  for (const change of [
    { tools: ["bash", "edit", "find", "grep", "ls", "read", "write"] },
    { providers: ["fixture"] },
    { hooks: ["execution/unapproved"] },
  ]) {
    const changed = { ...profile, capabilities: { ...profile.capabilities,
      entries: profile.capabilities.entries.map(entry => entry.owner === "pi-claude-style" ? { ...entry, ...change } : entry),
    } };
    await assert.rejects(childPresentationFactories(changed, lifecycle, "old-child"), /invalid child presentation/);
    await assert.rejects(childExecutionFactories({ profile: changed, agentDir: root, sessionId: "old-child", getBridge: () => undefined }), /invalid child presentation|proof\/entry mismatch/);
  }
  for (const target of ["dist/child.js", "src/child.ts"]) {
    const wrongPath = join(root, target);
    await mkdir(join(root, target.split("/")[0]!), { recursive: true });
    await writeFile(wrongPath, source);
    const changed = { ...profile, capabilities: { ...profile.capabilities,
      entries: profile.capabilities.entries.map(entry => entry.owner === "pi-claude-style" ? { ...entry, child_entrypoint: wrongPath } : entry),
    } };
    await assert.rejects(childPresentationFactories(changed, lifecycle, "old-child"), /proof\/entry mismatch/);
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "other-presentation", type: "module" }));
  await assert.rejects(childPresentationFactories(profile, lifecycle, "old-child"), /capability-drift|live file identity/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-claude-style", type: "module" }));
  await writeFile(path, source + "\n// rebuilt");
  await assert.rejects(childPresentationFactories(profile, lifecycle, "old-child"), /capability-drift|live file identity/);
});

test("SDK catalog executes only an explicitly granted factory and rejects old provider-only profiles", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alternate-factory-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../fixtures/faux-provider-alt/", import.meta.url)), root, { recursive: true });
  const target = join(root, "src/child.ts");
  const source = await readFile(target);
  const entry = { owner: "alternate-provider", providers: ["alternate"], tools: [], hooks: [], main_entrypoint: target, child_entrypoint: target, sha256: createHash("sha256").update(source).digest("hex") };
  const oldProfile = { model_scope: ["alternate/faux"], capabilities: { entries: [entry] } } as unknown as FrozenProfileV1;
  await assert.rejects(childExecutionFactories({ profile: oldProfile, agentDir: root, sessionId: "child", getBridge: () => undefined }), /no SDK proof/);
  const manifest = validateChildCapabilityManifestV1({ version: 1, owner_id: entry.owner, main_entrypoint: capture(target), targets: { "pi-subagents": {
    child_entrypoint: capture(target), activation: "required-only", commands: [], tools: [], hooks: [], requires: [], providers: [{ provider_id: "alternate", service_tiers: [], service_tier_application: "none" }],
    sdk_provider_factory: { provider_id: "alternate", package_manifest: capture(join(root, "package.json")), module: capture(join(root, "src/child-factory.ts")), export: "createAlternateChildFactory", config: {}, artifacts: [] },
  } } });
  await writeFile(join(root, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(manifest, "pi-subagents")] }));
  const proof = approveSdkProviderV1(root, manifest, "pi-subagents", oldProfile.model_scope);
  const profile = { ...oldProfile, capabilities: { ...oldProfile.capabilities, entries: [{ ...entry, sdk_provider: proof }] } };
  const registry = getOrCreateChildCapabilityRegistryV1(), registration = registry.register({ version: 1, manifest });
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: root, runtime_generation: 1, mode: "rpc" });
  t.after(() => { binding.release(); registration.release(); });
  const input = { profile, registry: registry.snapshot(root), agentDir: root, sessionId: "alternate-child", getBridge: () => undefined };
  const factories = await childExecutionFactories(input);
  const providers: string[] = [];
  assert.equal(factories.length, 1);
  const factory = factories[0]!;
  await (typeof factory === "function" ? factory : factory.factory)({ on: () => {}, registerProvider: (provider: string) => providers.push(provider) } as never);
  assert.deepEqual(providers, ["alternate"]);
  await assert.rejects(childExecutionFactories({ ...input, profile: { ...profile, capabilities: { ...profile.capabilities, entries: [{ ...entry, sdk_provider: proof, providers: ["other"] }] } } }), /proof\/entry mismatch/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "other-provider" }));
  await assert.rejects(childExecutionFactories(input), /live file identity/);
});


test("absent presentation uses native Pi while a differently named owner can provide the same capability", async t => {
  const empty = { capabilities: { entries: [] } } as unknown as FrozenProfileV1;
  assert.deepEqual(await childPresentationFactories(empty, new ViewLifecycle(), "native"), []);
  let nativeBindings = 0, renderer: any;
  const view: any = { extension() { nativeBindings++; } };
  const extension = childViewExtension(view);
  await extension({ registerMessageRenderer: (name: string, fn: any) => { assert.equal(name, "subagent-task-resume"); renderer = fn; } } as never);
  await view.prepare(); await view.prepare(); assert.equal(nativeBindings, 1);
  assert.ok(renderer({ content: "native notice" }, {}, { fg: (_tone: string, text: string) => text }));
  const root = await realpath(await mkdtemp(join(tmpdir(), "presentation-standin-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "presentation-standin", type: "module" }));
  const source = `export function createClaudeStyleChildExtension(options) { return pi => pi.capture(options); }`;
  const path = join(root, "dist/child.ts"); await writeFile(path, source);
  const childFactory = { version: 1 as const, target_id: "pi-subagents", context: {}, manifest: { version: 1 as const, owner_id: "presentation-standin", main_entrypoint: capture(path), targets: { "pi-subagents": { child_entrypoint: capture(path), child_factory: captureChildFactoryV1(path, { module: "dist/child.ts", export: "createClaudeStyleChildExtension", kind: "presentation" }), activation: "mirror" as const, commands: [], tools: [], providers: [], hooks: ["presentation/claude-style-v1"], requires: [] } } } };
  const profile = { capabilities: { entries: [{ child_factory: childFactory, owner: "presentation-standin", providers: [], tools: [], hooks: ["presentation/claude-style-v1"], child_entrypoint: path, sha256: createHash("sha256").update(source).digest("hex") }] } } as unknown as FrozenProfileV1;
  const lifecycle = new ViewLifecycle(), factories = await childPresentationFactories(profile, lifecycle, "child");
  let options: any; await factories[0]!({ capture: (value: any) => { options = value; } } as never);
  assert.equal(options.target, "subagent"); assert.equal(options.taskName, "child"); assert.equal(options.viewLifecycle, lifecycle);
});
