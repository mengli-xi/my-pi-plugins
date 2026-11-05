import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CHILD_CAPABILITY_REGISTRY_V1,
  PI_CHILD_RUNTIME_TARGET,
  captureEntrypointDescriptorV1,
  canonicalChildCapabilityManifestV1,
  createChildCapabilityRegistryV1,
  getOrCreateChildCapabilityRegistryV1,
  resolveChildCapabilityClosureV1,
  type ChildCapabilityManifestV1,
  validateChildCapabilityManifestV1,
} from "pi-runtime-contracts/child-capabilities-v1";

function files(t: TestContext, names: readonly string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-child-capability-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    writeFileSync(join(root, name), `export default ${JSON.stringify(name)};\n`, { mode: 0o600 });
    chmodSync(join(root, name), 0o600);
  }
  return root;
}

function target(root: string, child: string, values: Partial<{
  activation: "mirror" | "required-only";
  commands: string[];
  tools: string[];
  providers: Array<{ provider_id: string; service_tiers: string[]; service_tier_application: "none" | "owner-before-provider-request" }>;
  hooks: string[];
  requires: string[];
}> = {}) {
  return {
    child_entrypoint: captureEntrypointDescriptorV1(join(root, child)),
    activation: values.activation ?? "required-only" as const,
    commands: values.commands ?? [],
    tools: values.tools ?? [],
    providers: values.providers ?? [],
    hooks: values.hooks ?? [],
    requires: values.requires ?? [],
  };
}

function manifest(root: string, owner: string, main: string, targets: ChildCapabilityManifestV1["targets"]): ChildCapabilityManifestV1 {
  return { version: 1, owner_id: owner, main_entrypoint: captureEntrypointDescriptorV1(join(root, main)), targets };
}

function bind(registry: ReturnType<typeof createChildCapabilityRegistryV1>, value: ChildCapabilityManifestV1, session = "session") {
  const registration = registry.register({ version: 1, manifest: value });
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: session, runtime_generation: 1, mode: "tui" });
  return { registration, binding };
}

function resolve(registry: ReturnType<typeof createChildCapabilityRegistryV1>, values: Partial<Parameters<typeof resolveChildCapabilityClosureV1>[0]> = {}) {
  return resolveChildCapabilityClosureV1({
    snapshot: registry.snapshot("session"),
    target_id: "pi-side-chat",
    required_owner_ids: [],
    active_commands: [],
    active_tools: [],
    active_providers: [],
    required_capabilities: [],
    ...values,
  });
}

test("V1 DTO API uses the isolated child registry storage ABI 2 namespace", () => {
  assert.equal(PI_CHILD_RUNTIME_TARGET, "PI_CHILD_RUNTIME_TARGET");
  assert.equal(CHILD_CAPABILITY_REGISTRY_V1, Symbol.for("pi.child-capability-registry.v2"));
  const first = getOrCreateChildCapabilityRegistryV1();
  assert.equal(first, getOrCreateChildCapabilityRegistryV1());
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, CHILD_CAPABILITY_REGISTRY_V1);
  assert.equal(descriptor?.writable, false);
  assert.equal(descriptor?.configurable, false);
  assert.equal(descriptor?.enumerable, false);
});

test("manifest validates live identities and canonicalizes target order", (t) => {
  const root = files(t, ["main.js", "sub.js", "side.js"]);
  const value = manifest(root, "presentation", "main.js", {
    "pi-side-chat": target(root, "side.js", { activation: "mirror", commands: ["side_status"], hooks: ["presentation/layout-v1"] }),
    "pi-subagents": target(root, "sub.js", { activation: "mirror", hooks: ["presentation/layout-v1"] }),
  });
  const reversed = { ...value, targets: { "pi-subagents": value.targets["pi-subagents"]!, "pi-side-chat": value.targets["pi-side-chat"]! } };
  const validated = validateChildCapabilityManifestV1(value);
  assert.deepEqual(Object.keys(validated.targets), ["pi-side-chat", "pi-subagents"]);
  assert.equal(canonicalChildCapabilityManifestV1(validated), canonicalChildCapabilityManifestV1(validateChildCapabilityManifestV1(reversed)));
  assert.equal(Object.isFrozen(validated.targets["pi-side-chat"]?.commands), true);
  writeFileSync(join(root, "side.js"), "export default 'drift';\n");
  assert.throws(() => validateChildCapabilityManifestV1(value), /does not match the live file identity/);
});

test("manifest rejects unknown keys, unsorted abilities and invalid targets", (t) => {
  const root = files(t, ["main.js", "child.js"]);
  const base = manifest(root, "owner", "main.js", { "pi-side-chat": target(root, "child.js") });
  assert.throws(() => validateChildCapabilityManifestV1({ ...base, extra: true }), /unknown key/);
  assert.throws(() => validateChildCapabilityManifestV1({ ...base, targets: { "Bad Target": target(root, "child.js") } }), /invalid characters/);
  assert.throws(() => validateChildCapabilityManifestV1({ ...base, targets: { "pi-side-chat": target(root, "child.js", { tools: ["z", "a"] }) } }), /sorted and unique/);
});

test("registry snapshots frozen current registrations and fences stale handles", (t) => {
  const root = files(t, ["main.js", "child.js"]);
  const value = manifest(root, "owner", "main.js", { "pi-side-chat": target(root, "child.js", { hooks: ["presentation/v1"] }) });
  const registry = createChildCapabilityRegistryV1();
  const first = registry.register({ version: 1, manifest: value });
  const oldBinding = registry.bind({ version: 1, registrationToken: first.registrationToken, session_id: "session", runtime_generation: 1, mode: "tui" });
  const replacement = registry.register({ version: 1, manifest: value });
  assert.throws(() => registry.bind({ version: 1, registrationToken: first.registrationToken, session_id: "session", runtime_generation: 2, mode: "tui" }), /superseded/);
  const currentBinding = registry.bind({ version: 1, registrationToken: replacement.registrationToken, session_id: "session", runtime_generation: 2, mode: "tui" });
  oldBinding.release();
  first.release();
  const snapshot = registry.snapshot("session");
  assert.equal(snapshot.registrations[0]?.owner_generation, 2);
  assert.equal(Object.isFrozen(snapshot.registrations[0]?.manifest.targets), true);
  currentBinding.release();
  replacement.release();
  assert.equal(registry.snapshot("session").registrations.length, 0);
});

test("manifest drift conflicts until the stale candidate releases", (t) => {
  const root = files(t, ["main.js", "one.js", "two.js"]);
  const registry = createChildCapabilityRegistryV1();
  const one = registry.register({ version: 1, manifest: manifest(root, "owner", "main.js", { "pi-side-chat": target(root, "one.js") }) });
  const two = registry.register({ version: 1, manifest: manifest(root, "owner", "main.js", { "pi-side-chat": target(root, "two.js") }) });
  assert.deepEqual(registry.snapshot("session").conflicts, [{ owner_id: "owner", code: "manifest-drift" }]);
  assert.throws(() => registry.bind({ version: 1, registrationToken: two.registrationToken, session_id: "session", runtime_generation: 1, mode: "tui" }), /conflicted/);
  one.release();
  const binding = registry.bind({ version: 1, registrationToken: two.registrationToken, session_id: "session", runtime_generation: 1, mode: "tui" });
  assert.equal(registry.snapshot("session").registrations.length, 1);
  binding.release();
  two.release();
});

test("closure selects target abilities, mirror hooks, explicit capabilities and dependencies in bind order", (t) => {
  const root = files(t, ["dep-main.js", "dep-child.js", "tool-main.js", "tool-child.js", "provider-main.js", "provider-child.js", "mirror-main.js", "mirror-child.js"]);
  const registry = createChildCapabilityRegistryV1();
  bind(registry, manifest(root, "dep", "dep-main.js", { "pi-side-chat": target(root, "dep-child.js", { hooks: ["support/v1"] }) }));
  bind(registry, manifest(root, "tool", "tool-main.js", { "pi-side-chat": target(root, "tool-child.js", { tools: ["edit"], commands: ["inspect"], hooks: ["feature/v1"], requires: ["dep"] }) }));
  bind(registry, manifest(root, "provider", "provider-main.js", { "pi-side-chat": target(root, "provider-child.js", { providers: [{ provider_id: "custom", service_tiers: [], service_tier_application: "none" }] }) }));
  bind(registry, manifest(root, "mirror", "mirror-main.js", { "pi-side-chat": target(root, "mirror-child.js", { activation: "mirror", hooks: ["presentation/v1"] }) }));
  const closure = resolve(registry, { active_commands: ["inspect"], active_providers: ["custom"], required_capabilities: ["tool/feature/v1"] });
  assert.deepEqual(closure.owners.map((owner) => owner.owner_id), ["dep", "tool", "provider", "mirror"]);
  assert.equal(closure.owners[1]?.target.tools[0], "edit");
  assert.equal(Object.isFrozen(closure.owners), true);
});

test("required-only remains absent without an active ability", (t) => {
  const root = files(t, ["main.js", "child.js"]);
  const registry = createChildCapabilityRegistryV1();
  bind(registry, manifest(root, "tool", "main.js", { "pi-side-chat": target(root, "child.js", { tools: ["edit"] }) }));
  assert.deepEqual(resolve(registry).owners, []);
  assert.deepEqual(resolve(registry, { active_tools: ["edit"] }).owners.map((owner) => owner.owner_id), ["tool"]);
});

test("closure fails closed for missing target, dependency order, cycles and duplicate child paths", (t) => {
  const root = files(t, ["a-main.js", "b-main.js", "shared.js", "a-child.js", "b-child.js"]);
  const missingTarget = createChildCapabilityRegistryV1();
  bind(missingTarget, manifest(root, "owner", "a-main.js", { "pi-subagents": target(root, "a-child.js") }));
  assert.throws(() => resolve(missingTarget, { required_owner_ids: ["owner"] }), /target 'pi-side-chat' is unavailable/);

  const missingDependency = createChildCapabilityRegistryV1();
  bind(missingDependency, manifest(root, "dependent", "a-main.js", { "pi-side-chat": target(root, "a-child.js", { requires: ["missing"] }) }));
  assert.throws(() => resolve(missingDependency, { required_owner_ids: ["dependent"] }), /owner is unavailable: missing/);

  const late = createChildCapabilityRegistryV1();
  bind(late, manifest(root, "dependent", "a-main.js", { "pi-side-chat": target(root, "a-child.js", { requires: ["dependency"] }) }));
  bind(late, manifest(root, "dependency", "b-main.js", { "pi-side-chat": target(root, "b-child.js") }));
  assert.throws(() => resolve(late, { required_owner_ids: ["dependent"] }), /bound after dependent/);

  const cycle = createChildCapabilityRegistryV1();
  bind(cycle, manifest(root, "a", "a-main.js", { "pi-side-chat": target(root, "a-child.js", { requires: ["b"] }) }));
  bind(cycle, manifest(root, "b", "b-main.js", { "pi-side-chat": target(root, "b-child.js", { requires: ["a"] }) }));
  assert.throws(() => resolve(cycle, { required_owner_ids: ["a"] }), /dependency cycle/);

  const duplicate = createChildCapabilityRegistryV1();
  bind(duplicate, manifest(root, "a", "a-main.js", { "pi-side-chat": target(root, "shared.js") }));
  bind(duplicate, manifest(root, "b", "b-main.js", { "pi-side-chat": target(root, "shared.js") }));
  assert.throws(() => resolve(duplicate, { required_owner_ids: ["a", "b"] }), /claimed by multiple/);
});
