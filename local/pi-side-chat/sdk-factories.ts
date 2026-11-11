import type * as agent from "@earendil-works/pi-coding-agent";
import type { ViewLifecycle } from "pi-session-runtime/managed-interactive";
import { loadChildFactoryV1 } from "pi-session-runtime/child-factory";
import { assertSdkProviderModelApprovedV1, approvedSdkProviderRegistrationsV1, approveSdkProviderV1, loadSdkProviderFactoryV1, revalidateSdkProviderProofV1, sdkProviderBindingFenceV1 } from "pi-session-runtime/sdk-provider";
import { contextFingerprint } from "pi-session-runtime/effective-context";
import { isSyntheticToolSourcePath, sourcePath, resolveChildCapabilityClosureV1, getOrCreateChildCapabilityRegistryV1, type ResolvedChildCapabilityOwnerV1 } from "pi-runtime-contracts/child-capabilities-v1";

async function factoryPublicModules() {
  const assembly = await import("pi-session-runtime/session-assembly");
  return assembly.getSessionAssemblyPublicModules();
}
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export async function sidePresentationFactories(ctx: agent.ExtensionContext, lifecycle: ViewLifecycle, plan?: { presentationOwners?: readonly ResolvedChildCapabilityOwnerV1[]; requiredOwnerIds?: readonly string[] }): Promise<agent.ExtensionFactory[]> {
  const result: agent.ExtensionFactory[] = [];
  const owners = plan ? plan.presentationOwners ?? [] : resolveChildCapabilityClosureV1({
    snapshot: getOrCreateChildCapabilityRegistryV1().snapshot(ctx.sessionManager.getSessionId()), target_id: "pi-side-chat", required_owner_ids: [], active_commands: [], active_tools: [], active_providers: [], required_capabilities: [],
  }).owners;
  for (const owner of owners) {
    if (owner.target.child_factory?.kind !== "presentation") continue;
    const factory = await loadChildFactoryV1({ proof: { version: 1, manifest: owner.manifest, target_id: owner.target_id, context: owner.factory_context ?? {} }, publicModules: await factoryPublicModules(), required: plan?.requiredOwnerIds?.includes(owner.owner_id),
      options: { target: "side-chat", taskName: "Side", returnLabel: "Alt+/ Main", readOnlyStatusline: true, viewLifecycle: lifecycle } });
    if (factory) result.push(factory);
  }
  return result;
}

// Every owner comes from the pi-side-chat closure, so its target is already fixed.

function toolFingerprint(tool: { name: string; description: string; parameters: unknown; promptGuidelines?: readonly string[]; exposure?: string }): string {
  return contextFingerprint({ name: tool.name, description: tool.description, parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines ?? [], exposure: tool.exposure ?? "direct" });
}

/** Side requires its own target declaration and exact grant for extension providers. */
export async function sideExecutionPlan(pi: agent.ExtensionAPI, ctx: agent.ExtensionContext, agentDir: string) {
  const registry = getOrCreateChildCapabilityRegistryV1().snapshot(ctx.sessionManager.getSessionId());
  if (registry.conflicts.length) throw new Error(`Side capability registry conflict: ${registry.conflicts.map(item => item.owner_id).join(", ")}`);
  const factories: Array<(sessionId: string) => agent.ExtensionFactory | Promise<agent.ExtensionFactory>> = [];
  const mainTools = new Set(pi.getActiveTools());
  const tools = [...mainTools].filter(name => BUILTINS.includes(name));
  const allTools = pi.getAllTools();
  const toolOwners = new Map<string, typeof registry.registrations[number]>();
  for (const tool of allTools) {
    if (!mainTools.has(tool.name) || tool.sourceInfo.source === "builtin" || isSyntheticToolSourcePath(tool.sourceInfo.path)) continue;
    try {
      const path = sourcePath(tool.sourceInfo);
      const owner = registry.registrations.find(item => item.manifest.main_entrypoint.canonical_path === path && item.manifest.targets["pi-side-chat"]?.tools.includes(tool.name));
      if (owner) { toolOwners.set(tool.name, owner); continue; }
    } catch (error) {
      console.warn(`Side tool ${tool.name}: source unavailable at ${tool.sourceInfo.path}: ${String(error)}`); continue;
    }
    console.warn(`Side tool ${tool.name}: no declared owner for ${tool.sourceInfo.path}; skipped`);
  }
  const mainBash = mainTools.has("bash") ? allTools.find(tool => tool.name === "bash") : undefined;
  const bashOwner = toolOwners.get("bash");
  if (mainTools.has("bash") && (!mainBash || mainBash.sourceInfo.source !== "builtin" && !bashOwner)) throw new Error("The active Main bash has no approved Side factory");
  if (ctx.model) assertSdkProviderModelApprovedV1(registry, agentDir, "pi-side-chat", ctx.model.provider);
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
  const cancellations = new Set<() => Promise<void>>();
  const requiredOwners = new Set<string>();
  for (const [name, owner] of toolOwners) {
    requiredOwners.add(owner.owner_id);
    if (!tools.includes(name)) tools.push(name);
  }
  const closure = resolveChildCapabilityClosureV1({ snapshot: { ...registry, registrations: registry.registrations.filter(item => !item.manifest.targets["pi-side-chat"]?.sdk_provider_factory) }, target_id: "pi-side-chat", required_owner_ids: [...requiredOwners], active_commands: [], active_tools: [...mainTools].filter(name => allTools.find(tool => tool.name === name)?.sourceInfo.source !== "builtin"), active_providers: [], required_capabilities: [] });
  for (const owner of closure.owners) {
    if (owner.target.child_factory?.kind === "presentation") continue;
    const required = requiredOwners.has(owner.owner_id) || closure.owners.some(other => other.target.requires.includes(owner.owner_id));
    if (!owner.target.child_factory) {
      if (required) throw new Error(`Side factory unavailable: ${owner.owner_id}`);
      console.warn(`child factory ${owner.owner_id}: declaration missing; skipped`); continue;
    }
    // Capture context now, not when a later Side request starts.
    const proof = { version: 1 as const, manifest: owner.manifest, target_id: owner.target_id, context: owner.factory_context ?? {} };
    factories.push(async sessionId => {
      let registeredBash = false;
      const factory = await loadChildFactoryV1({ proof, publicModules: await factoryPublicModules(), required,
        options: { target: "side-chat", agentDir, sessionScopeId: sessionId, backendEvents: pi.events }, onCancel: cancel => cancellations.add(cancel),
        checkTool: tool => {
          if (tool.name !== "bash" || !bashOwner) return;
          if (registeredBash || toolFingerprint(tool) !== toolFingerprint(mainBash!)) throw new Error(`Side bash definition changed: ${owner.owner_id}`);
          registeredBash = true;
        } });
      return childPi => {
        const result = factory?.(childPi);
        const check = () => { if (bashOwner?.owner_id === owner.owner_id && !registeredBash) throw new Error(`Side bash factory registered no tool: ${owner.owner_id}`); };
        if (result && typeof (result as Promise<void>).then === "function") return Promise.resolve(result).then(check);
        check();
      };
    });
  }
  if (!ctx.model || !models.some(model => model.provider === ctx.model!.provider && model.id === ctx.model!.id)) throw new Error("The current provider has no approved Side factory");
  checkProviders();
  return { presentationOwners: closure.owners.filter(owner => owner.target.child_factory?.kind === "presentation"), requiredOwnerIds: [...new Set([...requiredOwners, ...closure.owners.flatMap(owner => owner.target.requires)])], beforeExecution: checkProviders, factories: async (sessionId: string) => { checkProviders(); return Promise.all(factories.map(factory => factory(sessionId))); }, beforeDispose: async (_cause: import("./sdk-runtime.ts").SideDisposeCause) => { try { await Promise.all([...cancellations].map(cancel => cancel())); } finally { cleanupProviders(); } }, tools: [...new Set(tools)], modelScope };
}
