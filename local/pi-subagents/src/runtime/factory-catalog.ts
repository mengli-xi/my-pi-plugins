import { dirname, join, basename } from "node:path";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as typebox from "typebox";
import { loadApprovedFactoryModule } from "pi-session-runtime/factory-loader";
async function approved(path: string, names: string[], expectedSha256?: string): Promise<Record<string, (...args: any[]) => any>> {
  const assembly = await import("pi-session-runtime/session-assembly");
  // Approved factories must use the SDK that owns session assembly, not this
  // consumer's separately resolved Pi copy. Keep the shared identity fail-closed.
  const publicModules = { ...assembly.getSessionAssemblyPublicModules(), "@earendil-works/pi-agent-core": piAgentCore, "typebox": typebox };
  const { captureEntrypointDescriptorV1 } = await import("../capabilities/manifest.js");
  const descriptor = expectedSha256 === undefined ? undefined : captureEntrypointDescriptorV1(path);
  if (descriptor && descriptor.sha256 !== expectedSha256) throw new Error(`capability-drift: execution factory changed: ${path}`);
  return await loadApprovedFactoryModule({ path, exports: names, publicModules, ...(descriptor ? { codeDescriptors: [descriptor] } : {}) }) as Record<string, (...args: any[]) => any>;
}
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ProcessWaitBridgeV2 } from "pi-runtime-contracts/process-wait-bridge-v2";
import type { FrozenProfileV1 } from "../persistence/types.js";
import type { ViewLifecycle } from "pi-session-runtime/managed-interactive";
import { loadSdkProviderFactoryV1, sdkProviderBindingFenceV1 } from "pi-session-runtime/sdk-provider";
import { getOrCreateChildCapabilityRegistryV1, type ChildCapabilityRegistrySnapshotV1 } from "../capabilities/registry.js";
import { revalidateExecutionFactoryV1 } from "../capabilities/execution-factory.js";
import { builtinRoleApiV1, validateBuiltinEntryV1 } from "../capabilities/builtin.js";

// CC's presentation-only descriptor owns no tools/providers; execution claims
// fail closed. Retired Pinned entries keep the same empty presentation shape:
// skip them without reading their deleted entrypoint or treating them as tools.
function isPresentationEntry(entry: FrozenProfileV1["capabilities"]["entries"][number]) {
  return ["pi-claude-style", "pi-pinned-layout"].includes(entry.owner) && entry.providers.length === 0
    && entry.hooks.every(hook => hook.startsWith("presentation/"))
    && entry.tools.length === 0;
}

export async function childPresentationFactories(profile: FrozenProfileV1, lifecycle: ViewLifecycle, taskName: string): Promise<ExtensionFactory[]> {
  const result: ExtensionFactory[] = [];
  for (const owner of ["pi-claude-style"]) {
    const entry = profile.capabilities.entries.find(item => item.owner === owner);
    if (!entry || !isPresentationEntry(entry)) throw new Error(`capability-unavailable: missing child presentation ${owner}`);
    const path = entry.child_entrypoint, directory = dirname(path);
    // CC's precompiled .ts entry keeps Pi 1.5 loader/host component identity.
    // Only this audited dist target is accepted; other suffixes fail closed.
    if (basename(path) !== "child.ts" || basename(directory) !== "dist") throw new Error(`capability-unavailable: unknown presentation target ${path}`);
    const manifest = JSON.parse(await readFile(join(dirname(directory), "package.json"), "utf8"));
    if (manifest.name !== owner || createHash("sha256").update(await readFile(path)).digest("hex") !== entry.sha256) throw new Error(`capability-drift: ${owner}`);
    const name = "createClaudeStyleChildExtension";
    const module = await approved(path, [name]);
    result.push(module[name]!({ target: "subagent", taskName, returnLabel: "Alt+/ Main", readOnlyStatusline: true, viewLifecycle: lifecycle }));
  }
  return result;
}

/** Audited mapping only. An owner name alone never authorizes an arbitrary module. */
export async function childExecutionFactories(input: { profile: FrozenProfileV1; agentDir: string; sessionId: string; getBridge: (sessionId: string) => ProcessWaitBridgeV2 | undefined; onTaskCancel?: (cancel: () => Promise<void>) => void; registry?: ChildCapabilityRegistrySnapshotV1; parentEvents?: import("@earendil-works/pi-coding-agent").ExtensionAPI["events"]; onExecutionDispose?: (dispose: () => void) => void }): Promise<InlineExtension[]> {
  const factories: InlineExtension[] = [], builtins = new Set<string>();
  for (const entry of input.profile.capabilities.entries) {
    if (isPresentationEntry(entry)) continue;
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
        publicModules: { ...assembly.getSessionAssemblyPublicModules(), "@earendil-works/pi-agent-core": piAgentCore, typebox },
        fence: sdkProviderBindingFenceV1(input.registry, () => getOrCreateChildCapabilityRegistryV1().snapshot(input.registry!.session_id), entry.owner, proof), onDispose: input.onExecutionDispose }));
      continue;
    }
    if (entry.providers.length) throw new Error(`capability-unavailable: frozen provider has no SDK proof: ${entry.owner}`);
    const target = entry.child_entrypoint;
    const bytes = await readFile(target);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`capability-drift: ${entry.owner}`);
    const directory = dirname(target), root = dirname(directory);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
    if (entry.owner === "pi-processes" && manifest.name === "pi-processes" && basename(target) === "child.js" && basename(directory) === "dist") {
      const proof = await revalidateExecutionFactoryV1(entry);
      const module = await approved(proof.canonical_path, proof.exports, proof.sha256);
      factories.push(pi => {
        const factory = module.createProcessesChildFactory({ agentDir: input.agentDir, sessionScopeId: input.sessionId, getBridge: input.getBridge });
        if (typeof factory.cancelPending !== "function") throw new Error("capability-unavailable: Processes child factory has no Task cancellation port");
        factory(pi);
        input.onTaskCancel?.(() => factory.cancelPending());
      });
    } else if (entry.owner === "pi-native-search" && manifest.name === "pi-native-search" && basename(target) === "child.ts" && basename(directory) === "extensions") {
      const proof = await revalidateExecutionFactoryV1(entry);
      const module = await approved(proof.canonical_path, proof.exports, proof.sha256);
      factories.push(module.createSearchChildFactory(module.loadSearchConfig(input.agentDir), { backendEvents: input.parentEvents }));
    } else if (entry.owner === "pi-bash-timeout" && manifest.name === "pi-bash-timeout" && basename(target) === "child.ts" && basename(directory) === "extensions") {
      // Pi 1.5's same-name bash override is reproduced only by this declared
      // TS target and named factory. Unknown package/path/export or hash drift
      // fails closed through the audited catalog and approved loader.
      const module = await approved(target, ["createBashTimeoutChildFactory"]);
      factories.push(module.createBashTimeoutChildFactory());
    } else throw new Error(`capability-unavailable: unknown SDK child target ${entry.owner}: ${target}`);
  }
  return factories;
}
