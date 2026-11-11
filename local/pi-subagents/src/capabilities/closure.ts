import { VERSION } from "@earendil-works/pi-coding-agent";
import { sourcePath } from "pi-runtime-contracts/child-capabilities-v1";
import { supportsSdkProviderV1 } from "./sdk-provider.js";
import type { ResolvedAgentRoleV1 } from "../roles/types.js";
import {
  resolveChildCapabilityClosureV1,
  type ChildCapabilityRegistrySnapshotV1,
  type ResolvedChildCapabilityOwnerV1,
} from "./registry.js";
import { canonicalJson } from "./canonical.js";
import { toolDefinitionDigest, type FrozenToolDefinitionV1 } from "./fingerprint.js";
import { builtinToolOwnerV1, builtinEntrypointDigestV1, isBuiltinExtensionV1 } from "./builtin.js";
import type { CapabilityEntryV1 } from "../persistence/types.js";

export const SUBAGENT_CHILD_TARGET = "pi-subagents";
const COLLABORATION_TOOLS = new Set(["spawn_agent", "send_input", "wait_agents", "list_agents", "list_subagent_models", "list_subagent_roles"]);

export interface ToolSourceInfoV1 { readonly path: string; readonly source: string; readonly scope: "user" | "project" | "temporary"; readonly origin: "package" | "top-level"; readonly baseDir?: string }
export interface ParentToolInfoV1 { readonly name: string; readonly description: string; readonly parameters: unknown; readonly promptGuidelines?: readonly string[]; readonly promptSnippet?: string; readonly sourceInfo: ToolSourceInfoV1 }
export interface ToolClosureDiagnosticV1 { readonly code: "wildcard-omitted"; readonly tool: string; readonly reason: "sdk-tool" | "unknown-source" | "undeclared-tool" }
export interface ToolCapabilityClosureV1 {
  readonly tools: readonly FrozenToolDefinitionV1[];
  readonly owners: readonly ResolvedChildCapabilityOwnerV1[];
  readonly childEntrypoints: readonly string[];
  readonly diagnostics: readonly ToolClosureDiagnosticV1[];
  readonly builtinEntries: readonly CapabilityEntryV1[];
  readonly providerOwnerId?: string;
  readonly serviceTierOwnerId?: string;
}

function cleanName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > 256 || value.includes("\0") || value.normalize("NFC") !== value) throw new Error(`${label} is invalid`);
  return value;
}
function cleanText(value: unknown, label: string, maxBytes = 16_384): string { if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes || value.includes("\0") || value.normalize("NFC") !== value) throw new Error(`${label} is invalid`); return value; }
function cleanLines(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 128) throw new Error("tool prompt guidelines are invalid");
  return Object.freeze(value.map((line) => cleanText(line, "tool prompt guideline")));
}
function canonicalToolParameters(value: unknown): unknown { const projected = JSON.parse(JSON.stringify(value)) as unknown; return JSON.parse(canonicalJson(projected)) as unknown; }


export function resolveToolCapabilityClosureV1(input: {
  readonly activeToolNames: readonly string[];
  readonly allTools: readonly ParentToolInfoV1[];
  readonly role: ResolvedAgentRoleV1;
  readonly registry: ChildCapabilityRegistrySnapshotV1;
  readonly registeredProviderIds: readonly string[];
  readonly providerId: string;
  readonly serviceTier?: string;
  readonly canSpawn?: boolean;
  readonly agentDir?: string;
}): ToolCapabilityClosureV1 {
  if (input.registry.conflicts.length > 0) throw new Error(`capability registry conflict: ${input.registry.conflicts.map((item) => item.owner_id).join(",")}`);
  const active = [...input.activeToolNames].map((name) => cleanName(name, "active tool name"));
  if (new Set(active).size !== active.length) throw new Error("active tool names are duplicated");
  const byName = new Map<string, ParentToolInfoV1>();
  for (const tool of input.allTools) {
    cleanName(tool.name, "tool name");
    if (byName.has(tool.name)) throw new Error(`duplicate tool definition: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  for (const name of active) if (!byName.has(name)) throw new Error(`active tool has no definition: ${name}`);
  const wildcard = input.role.frontmatter.tools === "*";
  const selectedNames = (wildcard ? active : [...input.role.frontmatter.tools]).filter(name => !["close_agent", "resume_agent"].includes(name) && (input.canSpawn !== false || name !== "spawn_agent"));
  if (!wildcard) for (const name of selectedNames) if (!active.includes(name)) throw new Error(`explicit role tool is not active: ${name}`);
  const targetOwners = input.registry.registrations.filter((entry) => {
    const target = entry.manifest.targets[SUBAGENT_CHILD_TARGET];
    return target && (target.providers.length === 0 || target.providers.some(provider => supportsSdkProviderV1(entry, provider.provider_id, input.agentDir)));
  });
  const byEntrypoint = new Map<string, typeof targetOwners[number]>();
  const claimEntrypoint = (path: string, entry: typeof targetOwners[number]): void => {
    const existing = byEntrypoint.get(path);
    if (existing && existing.owner_id !== entry.owner_id) throw new Error(`capability entrypoint is claimed by multiple owners: ${path}`);
    byEntrypoint.set(path, entry);
  };
  for (const entry of targetOwners) {
    // Supplemental provider-only owners may share their real Main module.
    // They cannot claim tool provenance and are selected solely by SDK proof.
    if (entry.manifest.targets[SUBAGENT_CHILD_TARGET]!.sdk_provider_factory) continue;
    claimEntrypoint(entry.manifest.main_entrypoint.canonical_path, entry);
    claimEntrypoint(entry.manifest.targets[SUBAGENT_CHILD_TARGET]!.child_entrypoint.canonical_path, entry);
  }
  const selectedOwners = new Set<string>();
  const diagnostics: ToolClosureDiagnosticV1[] = [];
  const tools: FrozenToolDefinitionV1[] = [];
  const builtinTools = new Map<string, string[]>();
  for (const name of selectedNames) {
    if (["close_agent", "resume_agent"].includes(name) || name === "spawn_agent" && input.canSpawn === false) continue;
    const tool = byName.get(name); if (!tool) throw new Error(`selected tool is missing: ${name}`);
    let ownerId: string | undefined;
    if (COLLABORATION_TOOLS.has(name)) ownerId = "pi-subagents";
    else if (tool.sourceInfo.source === "builtin") {
      ownerId = builtinToolOwnerV1(name, tool.sourceInfo)!;
      if (ownerId && isBuiltinExtensionV1(ownerId)) builtinTools.set(ownerId, [...(builtinTools.get(ownerId) ?? []), name]);
    }
    else if (tool.sourceInfo.path === `<sdk:${name}>`) {
      if (!wildcard) throw new Error(`SDK tool is not reproducible: ${name}`);
      diagnostics.push(Object.freeze({ code: "wildcard-omitted", tool: name, reason: "sdk-tool" })); continue;
    } else if (!tool.sourceInfo.path.startsWith("<")) {
      const path = sourcePath(tool.sourceInfo);
      const provenanceOwner = byEntrypoint.get(path);
      if (!provenanceOwner) {
        if (wildcard) { diagnostics.push(Object.freeze({ code: "wildcard-omitted", tool: name, reason: "unknown-source" })); continue; }
        throw new Error(`extension tool owner is missing or ambiguous: ${name}`);
      }
      const target = provenanceOwner.manifest.targets[SUBAGENT_CHILD_TARGET]!;
      if (!target.tools.includes(name)) { if (wildcard) { diagnostics.push(Object.freeze({ code: "wildcard-omitted", tool: name, reason: "undeclared-tool" })); continue; } throw new Error(`extension tool owner does not declare tool: ${name}`); }
      ownerId = provenanceOwner.owner_id;
      selectedOwners.add(ownerId);
    } else {
      if (!wildcard) throw new Error(`tool source is not reproducible: ${name}`);
      diagnostics.push(Object.freeze({ code: "wildcard-omitted", tool: name, reason: "unknown-source" })); continue;
    }
    const definition = { name, owner_id: ownerId, description: cleanText(tool.description, `tool description: ${name}`), parameters: canonicalToolParameters(tool.parameters), prompt_guidelines: cleanLines(tool.promptGuidelines) };
    tools.push(Object.freeze({ ...definition, source_scope: tool.sourceInfo.scope, definition_sha256: toolDefinitionDigest(definition) }));
  }

  const registeredProviderIds = new Set(input.registeredProviderIds.map((id) => cleanName(id, "registered provider id")));
  let providerOwnerId: string | undefined;
  if (registeredProviderIds.has(input.providerId)) {
    const owners = targetOwners.filter((entry) => entry.manifest.targets[SUBAGENT_CHILD_TARGET]!.providers.some((provider) => provider.provider_id === input.providerId));
    if (owners.length === 0 && input.registry.registrations.some(entry => entry.manifest.targets[SUBAGENT_CHILD_TARGET]?.providers.some(provider => provider.provider_id === input.providerId))) throw new Error(`model-unavailable: provider has no subagent support: ${input.providerId}`);
    if (owners.length !== 1) throw new Error(`model-unavailable: custom provider owner is missing or ambiguous: ${input.providerId} (${owners.length === 0 ? "no" : "more than one"} extension declares it for Subagents, so it cannot be frozen for a child); pass a model from list_subagent_models, which only lists spawnable models`);
    if (!supportsSdkProviderV1(owners[0]!, input.providerId, input.agentDir)) throw new Error(`model-unavailable: provider has no subagent support: ${input.providerId}`);
    providerOwnerId = owners[0]!.owner_id; selectedOwners.add(providerOwnerId);
  }
  let serviceTierOwnerId: string | undefined;
  if (input.serviceTier !== undefined) {
    if (input.providerId === "openai-codex" && input.serviceTier === "priority") serviceTierOwnerId = "pi-subagents";
    else {
      const owners = targetOwners.filter((entry) => entry.manifest.targets[SUBAGENT_CHILD_TARGET]!.providers.some((provider) => provider.provider_id === input.providerId && provider.service_tiers.includes(input.serviceTier!) && provider.service_tier_application === "owner-before-provider-request"));
      if (owners.length !== 1) throw new Error(`service tier is unsupported: ${input.providerId}/${input.serviceTier}`);
      serviceTierOwnerId = owners[0]!.owner_id; selectedOwners.add(serviceTierOwnerId);
    }
  }
  const childClosure = resolveChildCapabilityClosureV1({
    snapshot: { ...input.registry, registrations: targetOwners },
    target_id: SUBAGENT_CHILD_TARGET,
    required_owner_ids: [...selectedOwners],
    active_commands: [],
    active_tools: selectedNames,
    active_providers: [input.providerId],
    required_capabilities: input.role.frontmatter.required_capabilities ?? [],
  });
  tools.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const builtinEntries = [...builtinTools].sort(([a], [b]) => a.localeCompare(b)).map(([owner, names]) => Object.freeze({ owner, main_entrypoint: owner, child_entrypoint: owner, tools: names.sort(), providers: [], hooks: [], sha256: builtinEntrypointDigestV1(owner as `builtin:${string}`, VERSION), builtin_proof: { version: 1 as const, pi_version: VERSION } }));
  return Object.freeze({ tools: Object.freeze(tools), owners: childClosure.owners, builtinEntries: Object.freeze(builtinEntries), childEntrypoints: Object.freeze([...childClosure.child_entrypoints, ...builtinEntries.map((entry) => entry.child_entrypoint)]), diagnostics: Object.freeze(diagnostics), ...(providerOwnerId === undefined ? {} : { providerOwnerId }), ...(serviceTierOwnerId === undefined ? {} : { serviceTierOwnerId }) });
}

/**
 * 已注册的自定义 provider 里，没有唯一、已审计 SDK factory owner 的那些。
 * 这些 provider 的模型 spawn_agent 一定会拒绝，搜索时只列入 unavailable 解释原因。
 */
export function unspawnableProviderIdsV1(input: {
  readonly registry: ChildCapabilityRegistrySnapshotV1;
  readonly registeredProviderIds: readonly string[];
  readonly agentDir?: string;
}): ReadonlySet<string> {
  const targetOwners = input.registry.registrations.filter((entry) => entry.manifest.targets[SUBAGENT_CHILD_TARGET]);
  const excluded = new Set<string>();
  for (const providerId of input.registeredProviderIds) {
    const owners = targetOwners.filter((entry) => entry.manifest.targets[SUBAGENT_CHILD_TARGET]!.providers.some((provider) => provider.provider_id === providerId) && supportsSdkProviderV1(entry, providerId, input.agentDir));
    if (owners.length !== 1) excluded.add(providerId);
  }
  return excluded;
}

/**
 * 从 ExtensionContext 直接算 unspawnable provider；测试里的假 context 可能没有 registry 或 provider 列表，
 * 那种情况下什么都不排除，宁可多列也不能把正常模型漏掉。
 */
export function unspawnableProviderIdsForContextV1(context: {
  readonly sessionManager?: { getSessionId?: () => string };
  readonly modelRegistry?: { getRegisteredProviderIds?: () => readonly string[] };
}, snapshot: (sessionId: string) => ChildCapabilityRegistrySnapshotV1, agentDir?: string): ReadonlySet<string> {
  try {
    const sessionId = context.sessionManager?.getSessionId?.();
    const registeredProviderIds = context.modelRegistry?.getRegisteredProviderIds?.();
    if (typeof sessionId !== "string" || !Array.isArray(registeredProviderIds)) return new Set();
    return unspawnableProviderIdsV1({ registry: snapshot(sessionId), registeredProviderIds, agentDir });
  } catch {
    return new Set();
  }
}
