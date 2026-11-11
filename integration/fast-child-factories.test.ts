import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { captureEntrypointDescriptorV1 as capture, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import piFast from "../local/pi-fast/index.ts";
import subagents from "../local/pi-subagents/src/index.ts";
import sideChat from "../local/pi-side-chat/index.ts";
import { sideExecutionPlan } from "../local/pi-side-chat/sdk-factories.ts";
import { SideRuntime } from "../local/pi-side-chat/sdk-runtime.ts";
import { fastFixture } from "../local/pi-fast/test/fixture.ts";
import { getProcessServiceCellV1 } from "../local/pi-subagents/src/host/service-cell.ts";
import { until } from "../local/pi-subagents/test/fixtures/sdk-runtime.ts";

async function fixture() {
  const f = fastFixture(), key = Symbol.for(`open-child-fixture:${randomUUID()}`);
  (globalThis as Record<symbol, unknown>)[key] = f.provider;
  const pkg = join(f.root, "faux-sdk"), third = join(f.root, "third-party");
  await mkdir(pkg); await mkdir(third);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "faux-sdk", type: "module" }));
  await writeFile(join(pkg, "main.ts"), "// Test-only provider declaration\n");
  await writeFile(join(pkg, "child.ts"), `export function createProvider() { return pi => pi.registerProvider(globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})]); }`);
  const providerTarget = { child_entrypoint: capture(join(pkg, "child.ts")), activation: "required-only" as const, commands: [], tools: [], hooks: [], requires: [], providers: [{ provider_id: "openai-codex", service_tiers: [], service_tier_application: "none" as const }], sdk_provider_factory: { provider_id: "openai-codex", package_manifest: capture(join(pkg, "package.json")), module: capture(join(pkg, "child.ts")), export: "createProvider", config: {}, artifacts: [] } };
  const providerManifest = { version: 1 as const, owner_id: "faux-sdk", main_entrypoint: capture(join(pkg, "main.ts")), targets: { "pi-subagents": providerTarget, "pi-side-chat": providerTarget } };
  await writeFile(join(f.agentDir, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(providerManifest, "pi-subagents"), sdkProviderApprovalV1(providerManifest, "pi-side-chat")] }));
  const registerProvider: ExtensionFactory = pi => {
    const registry = getOrCreateChildCapabilityRegistryV1(), registration = registry.register({ version: 1, manifest: providerManifest });
    let binding: { release(): void } | undefined;
    pi.on("session_start", (_event, ctx) => { binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: ctx.sessionManager.getSessionId(), runtime_generation: 1, mode: "print" }); });
    pi.on("session_shutdown", () => { binding?.release(); registration.release(); });
  };
  await writeFile(join(third, "package.json"), JSON.stringify({ name: "unknown-third-party", type: "module" }));
  await writeFile(join(third, "factory.ts"), `export function installRequestMarker() { return pi => pi.on('before_provider_request', event => ({ ...event.payload, third_party_child: true })); }`);
  await writeFile(join(third, "main.ts"), `import { join } from 'node:path';
import { captureChildFactoryV1, captureEntrypointDescriptorV1 as capture, getOrCreateChildCapabilityRegistryV1 } from ${JSON.stringify(import.meta.resolve("pi-runtime-contracts/child-capabilities-v1"))};
export default function extension(pi) {
 const main = join(import.meta.dirname, 'main.ts');
 const target = { child_entrypoint: capture(join(import.meta.dirname, 'factory.ts')), child_factory: captureChildFactoryV1(main, { module: 'factory.ts', export: 'installRequestMarker' }), activation: 'mirror', commands: [], tools: [], providers: [], hooks: ['request/third-party-v1'], requires: [] };
 const registry = getOrCreateChildCapabilityRegistryV1(), registration = registry.register({ version: 1, manifest: { version: 1, owner_id: 'unknown-third-party', main_entrypoint: capture(main), targets: { 'pi-subagents': target, 'pi-side-chat': target } } });
 let binding;
 pi.on('session_start', (_event, ctx) => { binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: ctx.sessionManager.getSessionId(), runtime_generation: 1, mode: 'print' }); });
 pi.on('session_shutdown', () => { binding?.release(); registration.release(); });
}`);
  const registerThirdParty: ExtensionFactory = (await import(pathToFileURL(join(third, "main.ts")).href)).default;
  let pi!: ExtensionAPI;
  const captureApi: ExtensionFactory = api => { pi = api; };
  return { f, registerProvider, registerThirdParty, captureApi, get pi() { return pi; }, cleanup() { delete (globalThis as Record<symbol, unknown>)[key]; f.cleanup(); } };
}

for (const consumer of ["subagents", "side-chat"] as const) for (const reverse of consumer === "subagents" ? [false, true] : [false]) for (const state of ["override-on", "default-on", "override-off", "absent"] as const) {
  test(`${consumer}: ${state}, ${reverse ? "consumer first" : "owners first"}, unknown factory is loaded`, { timeout: 30000 }, async () => {
    const source = await fixture(), { f } = source;
    const owners = [source.registerThirdParty, ...(state === "absent" ? [] : [piFast])];
    const consumerExtension = consumer === "subagents" ? subagents : sideChat;
    const runtime = await f.start([source.registerProvider, ...(reverse ? [consumerExtension, ...owners] : [...owners, consumerExtension]), source.captureApi], consumer === "subagents" ? ["read", "spawn_agent", "send_input", "wait_agents", "list_agents", "list_subagent_models", "list_subagent_roles"] : []);
    let side: SideRuntime | undefined;
    const cell = getProcessServiceCellV1();
    try {
      if (state === "override-on") await runtime.session.prompt("/fast on");
      if (state === "default-on" || state === "override-off") await runtime.session.prompt("/fast all on");
      if (state === "override-off") await runtime.session.prompt("/fast off");
      const parentFastEntries = runtime.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-fast:session-state-v1").length;
      if (consumer === "subagents") {
        runtime.session.setActiveToolsByName(["read", "spawn_agent", "send_input", "wait_agents", "list_agents", "list_subagent_models", "list_subagent_roles"]);
        f.faux.setResponses(Array.from({ length: 20 }, () => context => {
          const last = context.messages.at(-1);
          if (last?.role === "user" && JSON.stringify(last).includes("SPAWN_TEST")) return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "fast-child", message: "CHILD_WORK", fork_turns: "none" }), { stopReason: "toolUse" });
          return fauxAssistantMessage("LOCAL_FAUX_OK");
        }));
        await runtime.session.prompt("SPAWN_TEST");
        assert.ok(cell.service, JSON.stringify({ requests: f.requests, errors: f.errors, messages: runtime.session.messages, tools: source.pi.getActiveTools() }));
        const binding = cell.service!.binding(runtime.session.sessionId)!;
        await until(() => binding.host.snapshot().agents[0]?.tasks[0]?.phase === "settled", "fast child settlement", () => ({ agents: binding.host.snapshot().agents, errors: cell.service?.diagnostics() }));
        assert.equal(binding.host.snapshot().agents[0]!.tasks[0]!.outcome, "completed");
        const child = await binding.runtime.childForView(binding.host.snapshot().agents[0]!.agent.agent_id);
        assert.ok(child);
        assert.equal(child.session.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "pi-fast:session-state-v1"), false);
      } else {
        await runtime.session.prompt("Main seed");
        const plan = await sideExecutionPlan(source.pi, runtime.session.extensionRunner!.createContext(), f.agentDir);
        side = await SideRuntime.create({ cwd: f.root, agentDir: f.agentDir, parentSettings: {}, projectTrusted: false,
          selection: { source: "request-capture", exactRequestPrefix: false, messages: [], turnAnchors: [], preambleMessageIndices: [], attachedMessageIndices: [], turnMappingReliable: false },
          provider: "openai-codex", model: "fast-fixture", thinkingLevel: "off", systemPrompt: "Offline child", tools: plan.tools, modelScope: plan.modelScope, factories: plan.factories, beforeDispose: plan.beforeDispose });
        // Later parent changes do not alter the state already captured for Side.
        if (state !== "absent") await runtime.session.prompt(state === "override-on" || state === "default-on" ? "/fast off" : "/fast on");
        const beforeChildEntries = runtime.session.sessionManager.getEntries().length;
        await side.prompt("CHILD_WORK");
        assert.equal(runtime.session.sessionManager.getEntries().length, beforeChildEntries, "child request never writes parent override/history");
        assert.equal(side.session.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "pi-fast:session-state-v1"), false);
      }
      const childRequests = f.requests.filter(body => JSON.stringify((body.messages as Array<{ role: string }>).findLast(message => message.role === "user")).includes("CHILD_WORK"));
      assert.ok(childRequests.length > 0);
      for (const body of childRequests) {
        assert.equal(body.third_party_child, true);
        if (state === "override-on" || state === "default-on") assert.equal(body.service_tier, "priority");
        else assert.equal("service_tier" in body, false);
      }
      if (consumer === "subagents") assert.equal(runtime.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-fast:session-state-v1").length, parentFastEntries);
      assert.deepEqual(f.errors, []);
    } finally {
      await side?.destroy(); await runtime.dispose(); await cell.service?.close(); cell.service = undefined; cell.promise = undefined; source.cleanup();
    }
  });
}

for (const reverse of [false, true]) test(`Subagents nested Fast context follows the immediate parent, Main changed (${reverse})`, { timeout: 30000 }, async () => {
  const source = await fixture(), { f } = source;
  await mkdir(join(f.agentDir, "pi-subagents"), { mode: 0o700 });
  await writeFile(join(f.agentDir, "pi-subagents", "config.json"), JSON.stringify({ schemaVersion: 2, execution: { maxDepth: 2 } }), { mode: 0o600 });
  const owners = [piFast, source.registerThirdParty];
  const runtime = await f.start([source.registerProvider, ...(reverse ? [subagents, ...owners] : [...owners, subagents]), source.captureApi], ["read", "spawn_agent", "send_input", "close_agent", "resume_agent", "wait_agents", "list_agents", "list_subagent_models", "list_subagent_roles"]);
  runtime.session.setActiveToolsByName(["read", "spawn_agent", "send_input", "close_agent", "resume_agent", "wait_agents", "list_agents", "list_subagent_models", "list_subagent_roles"]);
  const cell = getProcessServiceCellV1();
  try {
    f.faux.setResponses(Array.from({ length: 40 }, () => context => {
      const last = context.messages.at(-1), text = JSON.stringify(last);
      if (last?.role === "user" && text.includes("SPAWN_TEST")) return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "fast-child", message: "CHILD_WORK", fork_turns: "none" }), { stopReason: "toolUse" });
      if (last?.role === "user" && text.includes("CLOSE_PARENT")) return fauxAssistantMessage(fauxToolCall("close_agent", { target: "fast-child" }), { stopReason: "toolUse" });
      if (last?.role === "user" && text.includes("REOPEN_PARENT")) return fauxAssistantMessage(fauxToolCall("resume_agent", { target: "fast-child" }), { stopReason: "toolUse" });
      if (last?.role === "user" && text.includes("RESUME_PARENT")) return fauxAssistantMessage(fauxToolCall("send_input", { target: "fast-child", message: "NESTED_PARENT" }), { stopReason: "toolUse" });
      if (last?.role === "user" && text.includes("NESTED_PARENT")) return fauxAssistantMessage(fauxToolCall("spawn_agent", { task_name: "grandchild", message: "GRANDCHILD_WORK", fork_turns: "none" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("LOCAL_FAUX_OK");
    }));
    await runtime.session.prompt("/fast on");
    await runtime.session.prompt("SPAWN_TEST");
    const binding = cell.service!.binding(runtime.session.sessionId)!;
    assert.ok(binding, JSON.stringify({ messages: runtime.session.messages, errors: f.errors }));
    const diagnostics = () => ({ agents: binding.host.snapshot().agents, errors: cell.service?.diagnostics(), requests: f.requests });
    await until(() => binding.host.snapshot().agents[0]?.tasks[0]?.phase === "settled", "first child settled", diagnostics);
    await runtime.session.prompt("/fast off");
    assert.equal(getOrCreateChildCapabilityRegistryV1().snapshot(runtime.session.sessionId).registrations.find(item => item.owner_id === "pi-fast")!.factory_context!.enabled, false);
    const parent = () => binding.host.snapshot().agents.find(item => item.agent.task_name === "fast-child")!;
    const originalGeneration = parent().agent.runtime_generation;
    await runtime.session.prompt("CLOSE_PARENT");
    assert.equal(parent().agent.lifecycle, "closed");
    await runtime.session.prompt("REOPEN_PARENT");
    assert.equal(parent().agent.lifecycle, "open");
    assert.ok(parent().agent.runtime_generation > originalGeneration);
    await runtime.session.prompt("RESUME_PARENT");
    await until(() => binding.host.snapshot().agents.some(item => item.agent.depth === 2 && item.tasks[0]?.phase === "settled"), "nested child settled", diagnostics);
    const grandchild = binding.host.snapshot().agents.find(item => item.agent.depth === 2)!;
    assert.equal(grandchild.tasks[0]!.outcome, "completed");
    const requests = f.requests.filter(body => JSON.stringify((body.messages as Array<{ role: string }>).findLast(message => message.role === "user")).includes("GRANDCHILD_WORK"));
    assert.ok(requests.length);
    for (const body of requests) { assert.equal(body.service_tier, "priority"); assert.equal(body.third_party_child, true); }
    assert.equal(grandchild.agent.profile.capabilities.entries.find(entry => entry.owner === "pi-fast")!.child_factory!.context.enabled, true);
    assert.deepEqual(f.errors, []);
  } finally { await runtime.dispose(); await cell.service?.close(); cell.service = undefined; cell.promise = undefined; source.cleanup(); }
});
