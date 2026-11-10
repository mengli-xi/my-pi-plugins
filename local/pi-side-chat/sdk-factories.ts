import { dirname, join, basename } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type * as agent from "@earendil-works/pi-coding-agent";
import * as core from "@earendil-works/pi-agent-core";
import type { ViewLifecycle } from "pi-session-runtime/managed-interactive";
import { loadApprovedFactoryModule } from "pi-session-runtime/factory-loader";
import { approvedSdkProviderRegistrationsV1, approveSdkProviderV1, loadSdkProviderFactoryV1, revalidateSdkProviderProofV1, sdkProviderBindingFenceV1 } from "pi-session-runtime/sdk-provider";
import { contextFingerprint } from "pi-session-runtime/effective-context";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";

async function factoryPublicModules() {
  const assembly = await import("pi-session-runtime/session-assembly");
  return { ...assembly.getSessionAssemblyPublicModules(), "@earendil-works/pi-agent-core": core };
}
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export async function sidePresentationFactories(ctx: agent.ExtensionContext, lifecycle: ViewLifecycle): Promise<agent.ExtensionFactory[]> {
  const snapshot = getOrCreateChildCapabilityRegistryV1().snapshot(ctx.sessionManager.getSessionId());
  const result: agent.ExtensionFactory[] = [];
  for (const owner of ["pi-claude-style"]) {
    if (snapshot.conflicts.some(item => item.owner_id === owner)) throw new Error(`Side presentation changed: ${owner}`);
    const manifest = snapshot.registrations.find(item => item.manifest.owner_id === owner)?.manifest;
    const target = manifest?.targets["pi-side-chat"];
    // CC Style's Side target is optional: without it ManagedInteractive uses native Pi.
    // Only absence falls back; a published target must satisfy the display-only contract below.
    if (!target) continue;
    const entry = target.child_entrypoint;
    if (!entry) throw new Error(`Side presentation unavailable: ${owner}`);
    if (target.tools.length || target.providers.length || target.commands.length || target.sdk_provider_factory) throw new Error(`Side presentation is not display-only: ${owner}`);
    const path = entry.canonical_path, directory = dirname(path);
    const pkg = JSON.parse(await readFile(join(dirname(directory), "package.json"), "utf8"));
    if (pkg.name !== owner || basename(path) !== "child.ts" || basename(directory) !== "dist" || createHash("sha256").update(await readFile(path)).digest("hex") !== entry.sha256) throw new Error(`Side presentation changed: ${owner}`);
    const name = "createClaudeStyleChildExtension";
    const module = await loadApprovedFactoryModule({ path, exports: [name], publicModules: await factoryPublicModules() }) as Record<string, (options: unknown) => agent.ExtensionFactory>;
    result.push(module[name]!({ target: "side-chat", taskName: "Side", returnLabel: "Alt+/ Main", readOnlyStatusline: true, viewLifecycle: lifecycle }));
  }
  return result;
}

function toolFingerprint(tool: { name: string; description: string; parameters: unknown; promptGuidelines?: readonly string[]; exposure?: string }): string {
  return contextFingerprint({ name: tool.name, description: tool.description, parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines ?? [], exposure: tool.exposure ?? "direct" });
}

/** Side requires its own target declaration and exact grant for extension providers. */
export async function sideExecutionPlan(pi: agent.ExtensionAPI, ctx: agent.ExtensionContext, agentDir: string) {
  const registry = getOrCreateChildCapabilityRegistryV1().snapshot(ctx.sessionManager.getSessionId());
  if (registry.conflicts.length) throw new Error(`Side capability registry conflict: ${registry.conflicts.map(item => item.owner_id).join(", ")}`);
  const factories: Array<(sessionId: string) => agent.ExtensionFactory> = [];
  const mainTools = new Set(pi.getActiveTools());
  const tools = [...mainTools].filter(name => BUILTINS.includes(name));
  const mainBash = mainTools.has("bash") ? pi.getAllTools().find(tool => tool.name === "bash") : undefined;
  const timeout = registry.registrations.find(item => item.manifest.owner_id === "pi-bash-timeout")?.manifest;
  const needsTimeout = !!mainBash && mainBash.sourceInfo.source !== "builtin";
  if (mainTools.has("bash") && (!mainBash || (needsTimeout && mainBash.sourceInfo.path !== timeout?.main_entrypoint.canonical_path))) {
    throw new Error("The active Main bash has no approved Side factory");
  }
  const approvedProviders = approvedSdkProviderRegistrationsV1(registry, agentDir, "pi-side-chat");
  const counts = new Map<string, number>();
  for (const item of approvedProviders) { const id = item.manifest.targets["pi-side-chat"]!.sdk_provider_factory!.provider_id; counts.set(id, (counts.get(id) ?? 0) + 1); }
  if ([...counts.values()].some(count => count !== 1)) throw new Error("Side SDK provider owner is ambiguous");
  const scoped = ctx.scopedModels.length ? ctx.scopedModels.map(entry => entry.model) : ctx.modelRegistry.getAvailable();
  const candidates = [...scoped, ...(!ctx.scopedModels.length && ctx.model ? [ctx.model] : [])];
  const models = [...new Map(candidates.filter(model => counts.has(model.provider) || !ctx.modelRegistry.getRegisteredProviderIds().includes(model.provider))
    .map(model => [`${model.provider}/${model.id}`, model])).values()];
  const modelScope = models.map(model => `${model.provider}/${model.id}`);
  const providerChecks: Array<() => void> = [];
  const checkProviders = () => { for (const check of providerChecks) check(); };
  const disposers = new Set<() => void>();
  const cleanupProviders = () => { for (const dispose of disposers) dispose(); disposers.clear(); };
  for (const item of approvedProviders) {
    const providerId = item.manifest.targets["pi-side-chat"]!.sdk_provider_factory!.provider_id;
    if (!models.some(model => model.provider === providerId)) continue;
    const reference = ctx.modelRegistry.getProvider?.(providerId);
    const bindingFence = sdkProviderBindingFenceV1(registry, () => getOrCreateChildCapabilityRegistryV1().snapshot(registry.session_id), item.owner_id);
    const proof = approveSdkProviderV1(agentDir, item.manifest, "pi-side-chat", modelScope);
    const check = () => { bindingFence(); if (ctx.modelRegistry.getProvider?.(providerId) !== reference) throw new Error("Side provider replaced during assembly"); revalidateSdkProviderProofV1(proof, agentDir, "pi-side-chat", modelScope); };
    providerChecks.push(check);
    const factory = await loadSdkProviderFactoryV1({ proof, agentDir, target: "pi-side-chat", modelScope,
      publicModules: await factoryPublicModules(), onDispose: dispose => disposers.add(dispose), fence: check });
    factories.push(() => factory);
  }
  let cancelProcesses: (() => Promise<void>) | undefined;
  for (const registration of registry.registrations) {
    const manifest = registration.manifest;
    if (manifest.owner_id === "pi-bash-timeout" && !needsTimeout) continue;
    if (!["pi-processes", "pi-native-search", "pi-bash-timeout"].includes(manifest.owner_id)) continue;
    const target = manifest.targets[manifest.owner_id === "pi-bash-timeout" ? "pi-side-chat" : "pi-subagents"];
    const entry = target?.child_entrypoint;
    if (!entry) throw new Error(`Side factory unavailable: ${manifest.owner_id}`);
    const path = entry.canonical_path;
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Side factory changed: ${manifest.owner_id}`);
    const directory = dirname(path);
    const pkg = JSON.parse(await readFile(join(dirname(directory), "package.json"), "utf8"));
    let factoryPath: string, names: string[];
    if (manifest.owner_id === "pi-bash-timeout" && pkg.name === "pi-bash-timeout" && basename(directory) === "extensions" && basename(path) === "child.ts"
      && dirname(manifest.main_entrypoint.canonical_path) === directory && basename(manifest.main_entrypoint.canonical_path) === "index.ts"
      && target?.activation === "required-only" && target.tools.length === 1 && target.tools[0] === "bash"
      && target.commands.length === 0 && target.providers.length === 0 && target.hooks.length === 0 && target.requires.length === 0) {
      factoryPath = path; names = ["createBashTimeoutChildFactory"];
    } else if (manifest.owner_id === "pi-processes" && pkg.name === "pi-processes" && basename(directory) === "dist") {
      factoryPath = join(directory, "index.js"); names = ["createProcessesSideFactory"];
    } else if (manifest.owner_id === "pi-native-search" && pkg.name === "pi-native-search" && basename(directory) === "extensions") {
      factoryPath = join(directory, "index.ts"); names = ["createSearchChildFactory", "loadSearchConfig"];
    } else throw new Error(`Unapproved Side factory: ${path}`);
    const module = await loadApprovedFactoryModule({ path: factoryPath, exports: names, publicModules: await factoryPublicModules() }) as Record<string, (...args: any[]) => any>;
    if (names[0] === "createBashTimeoutChildFactory") {
      // Timeout owns Main's bash schema. The audited child export must register the same definition;
      // absent descriptors, source-owner drift or definition drift reject instead of restoring builtin bash.
      const expected = toolFingerprint(mainBash!);
      factories.push(() => childPi => {
        let registered = false;
        module.createBashTimeoutChildFactory()({ ...childPi, registerTool(tool: agent.ToolDefinition) {
          if (registered || tool.name !== "bash" || toolFingerprint(tool) !== expected) throw new Error("Side bash definition changed: pi-bash-timeout");
          registered = true;
          childPi.registerTool(tool);
        } });
        if (!registered) throw new Error("Side bash factory registered no tool: pi-bash-timeout");
      });
    } else if (names[0] === "createProcessesSideFactory") {
      factories.push(sessionId => {
        const factory = module.createProcessesSideFactory({ sessionScopeId: sessionId, agentDir });
        if (typeof factory.cancelPending !== "function") throw new Error("Processes Side factory lacks durable mailbox cancellation");
        cancelProcesses = () => factory.cancelPending();
        return factory;
      }); tools.push("process");
    } else if (names[0] === "createSearchChildFactory") {
      const config = module.loadSearchConfig(agentDir);
      factories.push(() => module.createSearchChildFactory(config, { backendEvents: pi.events })); tools.push("web_search", "web_fetch");
    }
  }
  for (const name of ["process", "web_search", "web_fetch"]) {
    if (mainTools.has(name) && !tools.includes(name)) throw new Error(`The active Main tool has no approved Side factory: ${name}`);
  }
  if (!ctx.model || !models.some(model => model.provider === ctx.model!.provider && model.id === ctx.model!.id)) throw new Error("The current provider has no approved Side factory");
  checkProviders();
  return { beforeExecution: checkProviders, factories: async (sessionId: string) => { checkProviders(); return factories.map(factory => factory(sessionId)); }, beforeDispose: async (_cause: import("./sdk-runtime.ts").SideDisposeCause) => { try { await cancelProcesses?.(); } finally { cleanupProviders(); } }, tools: [...new Set(tools)], modelScope };
}
