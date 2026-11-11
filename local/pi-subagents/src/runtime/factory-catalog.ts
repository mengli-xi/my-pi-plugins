import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ProcessWaitBridgeV2 } from "pi-runtime-contracts/process-wait-bridge-v2";
import type { FrozenProfileV1 } from "../persistence/types.js";
import type { ViewLifecycle } from "pi-session-runtime/managed-interactive";
import { loadSdkProviderFactoryV1, sdkProviderBindingFenceV1 } from "pi-session-runtime/sdk-provider";
import { getOrCreateChildCapabilityRegistryV1, type ChildCapabilityRegistrySnapshotV1 } from "../capabilities/registry.js";
import { loadChildFactoryV1 } from "pi-session-runtime/child-factory";
import { builtinRoleApiV1, validateBuiltinEntryV1 } from "../capabilities/builtin.js";

function isPresentationEntry(entry: FrozenProfileV1["capabilities"]["entries"][number]) {
  return entry.child_factory?.manifest.targets[entry.child_factory.target_id]?.child_factory?.kind === "presentation"
    || !entry.child_factory && entry.hooks.length > 0 && entry.hooks.every(hook => hook.startsWith("presentation/")) && entry.providers.length === 0 && entry.tools.length === 0;
}
function matchesDeclaredFactory(entry: FrozenProfileV1["capabilities"]["entries"][number]): boolean {
  const proof = entry.child_factory;
  if (!proof || proof.target_id !== "pi-subagents") return false;
  const declared = proof.manifest.targets[proof.target_id];
  return !!declared && proof.manifest.owner_id === entry.owner
    && proof.manifest.main_entrypoint.canonical_path === entry.main_entrypoint
    && declared.child_entrypoint.canonical_path === entry.child_entrypoint
    && declared.child_entrypoint.sha256 === entry.sha256
    && JSON.stringify(declared.tools) === JSON.stringify(entry.tools)
    && JSON.stringify(declared.providers.map(provider => provider.provider_id)) === JSON.stringify(entry.providers)
    && JSON.stringify(declared.hooks) === JSON.stringify(entry.hooks);
}
function factoryMismatch(entry: FrozenProfileV1["capabilities"]["entries"][number], reason: string): void {
  const message = `capability-unavailable: ${reason}`;
  if (entry.factory_required) throw new Error(message);
  console.warn(`child factory ${entry.owner}: ${message}; skipped`);
}
async function factoryPublicModules() {
  const assembly = await import("pi-session-runtime/session-assembly");
  return assembly.getSessionAssemblyPublicModules();
}
export async function childPresentationFactories(profile: FrozenProfileV1, lifecycle: ViewLifecycle, taskName: string): Promise<ExtensionFactory[]> {
  const result: ExtensionFactory[] = [];
  for (const entry of profile.capabilities.entries.filter(isPresentationEntry)) {
    if (!entry.child_factory) continue; // Retired presentation remains readable, not executable.
    if (!matchesDeclaredFactory(entry)) {
      factoryMismatch(entry, "invalid child presentation proof/entry mismatch"); continue;
    }
    const factory = await loadChildFactoryV1({ proof: entry.child_factory, publicModules: await factoryPublicModules(), required: entry.factory_required,
      options: { target: "subagent", taskName, returnLabel: "Alt+/ Main", readOnlyStatusline: true, viewLifecycle: lifecycle } });
    if (factory) result.push(factory);
  }
  return result;
}

/** Builtins and external providers retain their separate authorization paths. */
export async function childExecutionFactories(input: { profile: FrozenProfileV1; agentDir: string; sessionId: string; getBridge: (sessionId: string) => ProcessWaitBridgeV2 | undefined; onTaskCancel?: (cancel: () => Promise<void>, owner: string) => void; registry?: ChildCapabilityRegistrySnapshotV1; parentEvents?: import("@earendil-works/pi-coding-agent").ExtensionAPI["events"]; onExecutionDispose?: (dispose: () => void) => void }): Promise<InlineExtension[]> {
  const factories: InlineExtension[] = [], builtins = new Set<string>();
  for (const entry of input.profile.capabilities.entries) {
    if (isPresentationEntry(entry)) {
      if (entry.child_factory && !matchesDeclaredFactory(entry)) factoryMismatch(entry, "invalid child presentation proof/entry mismatch");
      continue;
    }
    if ([entry.owner, entry.main_entrypoint, entry.child_entrypoint].some(value => typeof value === "string" && value.startsWith("builtin:"))) {
      const { getSessionAssemblyPublicModules } = await import("pi-session-runtime/session-assembly");
      const sdk = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
      const name = validateBuiltinEntryV1(entry, input.profile, sdk.VERSION);
      if (builtins.has(name)) throw new Error(`capability-unavailable: duplicate frozen built-in ${name}`);
      builtins.add(name);
      const create = {
        codemode: () => sdk.createCodemodeExtension(),
        "tool-search": () => sdk.createToolSearchExtension(),
      };
      if (typeof sdk.createCodemodeExtension !== "function" || typeof sdk.createToolSearchExtension !== "function") throw new Error("capability-unavailable: canonical SDK has no public built-in factories");
      const factory = create[name]();
      factories.push({ name, builtin: true, factory: pi => factory(builtinRoleApiV1(pi, input.profile)) });
      continue;
    }
    if (entry.sdk_provider) {
      const proof = entry.sdk_provider;
      const declared = proof.manifest.targets["pi-subagents"];
      if (!declared || JSON.stringify(entry.providers) !== JSON.stringify(declared.providers.map(provider => provider.provider_id)) || JSON.stringify(entry.tools) !== JSON.stringify(declared.tools) || JSON.stringify(entry.hooks) !== JSON.stringify(declared.hooks)) throw new Error("capability-unavailable: SDK provider proof/entry mismatch");
      if (!input.registry || proof.owner_id !== entry.owner || proof.manifest.main_entrypoint.canonical_path !== entry.main_entrypoint || proof.manifest.targets["pi-subagents"]?.child_entrypoint.canonical_path !== entry.child_entrypoint || proof.manifest.targets["pi-subagents"]?.child_entrypoint.sha256 !== entry.sha256) throw new Error("capability-unavailable: SDK provider proof/entry mismatch");
      const assembly = await import("pi-session-runtime/session-assembly");
      factories.push(await loadSdkProviderFactoryV1({ proof, agentDir: input.agentDir, target: "pi-subagents", modelScope: input.profile.model_scope,
        publicModules: assembly.getSessionAssemblyPublicModules(),
        fence: sdkProviderBindingFenceV1(input.registry, () => getOrCreateChildCapabilityRegistryV1().snapshot(input.registry!.session_id), entry.owner, proof), onDispose: input.onExecutionDispose }));
      continue;
    }
    if (!entry.child_factory) {
      if (entry.providers.length) throw new Error(`capability-unavailable: frozen provider has no SDK proof: ${entry.owner}`);
      if (entry.tools.length > 0) throw new Error(`capability-unavailable: frozen execution factory proof is missing: ${entry.owner}; prepare a new profile`);
      console.warn(`child factory ${entry.owner}: declaration missing; skipped`);
      continue;
    }
    if (!matchesDeclaredFactory(entry)) {
      factoryMismatch(entry, "child factory proof/entry mismatch"); continue;
    }
    const factory = await loadChildFactoryV1({ proof: entry.child_factory, publicModules: await factoryPublicModules(), required: entry.factory_required,
      options: { target: "subagent", agentDir: input.agentDir, sessionScopeId: input.sessionId, getBridge: input.getBridge, backendEvents: input.parentEvents },
      onCancel: cancel => input.onTaskCancel?.(cancel, entry.owner) });
    if (factory) factories.push(factory);
  }
  return factories;
}
