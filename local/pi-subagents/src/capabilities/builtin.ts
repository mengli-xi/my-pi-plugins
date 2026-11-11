import type { ExtensionAPI, ExtensionFactory, ToolInfo, ToolLoadout } from "@earendil-works/pi-coding-agent";
import type { CapabilityEntryV1, CapabilityToolDefinitionV1, FrozenProfileV1 } from "../persistence/types.js";
import { sha256Hex } from "./canonical.js";
import { toolDefinitionDigest } from "./fingerprint.js";

const EXTENSIONS = new Set(["builtin:codemode", "builtin:tool-search"]);
const BASE_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
export type BuiltinExtensionTokenV1 = `builtin:${string}`;
export type ApprovedBuiltinNameV1 = "codemode" | "tool-search";

export function isBuiltinExtensionV1(value: string): value is BuiltinExtensionTokenV1 { return EXTENSIONS.has(value); }
function builtinOwnsTool(token: string, name: string): boolean {
  return token === "builtin:codemode" && name === "codemode" || token === "builtin:tool-search" && name === "tool_search";
}

export function builtinToolOwnerV1(name: string, source: { source: string; path: string }): string | undefined {
  if (source.source !== "builtin") return undefined;
  if (source.path === `builtin:${name}` && BASE_TOOLS.has(name)) return "builtin";
  if (isBuiltinExtensionV1(source.path) && builtinOwnsTool(source.path, name)) return source.path;
  // Only these two native tool factories are supported. Stock MCP is not the
  // configured MCP adapter; llama.cpp owns a provider/command, not tools.
  // Unknown claims never authorize CLI services or another tool owner.
  throw new Error(`unsupported Pi built-in tool source: ${source.path}/${name}`);
}

export function builtinEntrypointDigestV1(token: BuiltinExtensionTokenV1, piVersion: string): string {
  return sha256Hex(`pi-subagents/builtin/v1\0${piVersion}\0${token}`);
}

export function validateBuiltinEntryV1(entry: CapabilityEntryV1, profile: FrozenProfileV1, piVersion: string): ApprovedBuiltinNameV1 {
  const token = entry.owner;
  if (!isBuiltinExtensionV1(token)) throw new Error(`capability-unavailable: unsupported built-in child owner: ${token}`);
  if (entry.main_entrypoint !== token || entry.child_entrypoint !== token
    || entry.providers.length || entry.hooks.length || entry.sdk_provider || entry.child_factory || entry.execution_factory || !entry.builtin_proof
    || entry.builtin_proof.version !== 1 || entry.builtin_proof.pi_version !== piVersion || entry.sha256 !== builtinEntrypointDigestV1(token, piVersion)
    || !entry.tools.length || new Set(entry.tools).size !== entry.tools.length) throw new Error(`capability-unavailable: invalid frozen built-in proof: ${token}`);
  const definitions = profile.capabilities.tool_definitions.filter(tool => tool.owner_id === token);
  if (entry.tools.some(name => !builtinOwnsTool(token, name) || !profile.capabilities.active_tools.includes(name) || !definitions.some(tool => tool.name === name))
    || definitions.some(tool => !entry.tools.includes(tool.name))) throw new Error(`capability-unavailable: built-in proof/tool mismatch: ${token}`);
  return token.slice("builtin:".length) as ApprovedBuiltinNameV1;
}

export function assertFrozenToolDefinitionV1(expected: CapabilityToolDefinitionV1, actual: ToolInfo | undefined): void {
  if (!actual) throw new Error(`capability-drift: child tool ${expected.name}`);
  const owner = expected.owner_id ?? "builtin";
  const builtinOwner = builtinToolOwnerV1(actual.name, actual.sourceInfo);
  if ((owner === "builtin" || owner.startsWith("builtin:") || builtinOwner !== undefined) && owner !== builtinOwner) throw new Error(`capability-drift: child tool provenance ${expected.name}`);
  if (toolDefinitionDigest({ name: actual.name, owner_id: owner, description: actual.description,
    parameters: JSON.parse(JSON.stringify(actual.parameters)), prompt_guidelines: actual.promptGuidelines ?? [] }) !== expected.definition_sha256) throw new Error(`capability-drift: child tool ${expected.name}`);
}

/** Pi 1.5's public tool pipeline also covers codemode's nested executeTool calls. */
export function frozenToolFenceV1(profile: FrozenProfileV1, active: readonly string[]): ExtensionFactory {
  const allowed = new Set(active), definitions = new Map(profile.capabilities.tool_definitions.map(tool => [tool.name, tool]));
  return pi => { pi.on("tool_call", event => {
    if (!allowed.has(event.toolName)) return { block: true, reason: `permission-denied: tool was not frozen for this role: ${event.toolName}` };
    try { const expected = definitions.get(event.toolName); if (!expected) throw new Error(`capability-drift: missing frozen tool ${event.toolName}`); assertFrozenToolDefinitionV1(expected, pi.getAllTools().find(tool => tool.name === event.toolName)); }
    catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
  }); };
}

/**
 * Pi 1.5 codemode calls ctx.executeTool and tool_search captures the supplied
 * API's getAllTools/setActiveTools. Restrict those public surfaces without
 * changing definitions or forging sourceInfo; the named builtin loader owns
 * provenance. Unknown registration/discovery/activation stays outside the role.
 */
export function builtinRoleApiV1(pi: ExtensionAPI, profile: FrozenProfileV1): ExtensionAPI {
  const allowed = new Set(profile.capabilities.active_tools);
  const filter = <T extends { name: string }>(tools: readonly T[]): T[] => tools.filter(tool => allowed.has(tool.name));
  return new Proxy(pi, { get(target, key) {
    if (key === "getAllTools") return () => filter(target.getAllTools());
    if (key === "getActiveTools") return () => target.getActiveTools().filter(name => allowed.has(name));
    if (key === "setActiveTools") return (names: string[]) => target.setActiveTools(names.filter(name => allowed.has(name)));
    if (key === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      if (!allowed.has(definition.name)) return;
      target.registerTool({ ...definition,
        ...(definition.prepareLoadout ? { prepareLoadout: (loadout: ToolLoadout) => definition.prepareLoadout!({ ...loadout, declared: filter(loadout.declared), callable: filter(loadout.callable), registered: filter(loadout.registered) }) } : {}),
        execute: (id, args, signal, update, ctx) => definition.execute(id, args, signal, update, { ...ctx, tools: filter(ctx.tools), executeTool: (name, input, options) => {
          if (!allowed.has(name)) return Promise.reject(new Error(`permission-denied: tool was not frozen for this role: ${name}`));
          return ctx.executeTool(name, input, options);
        } }),
      });
    };
    return Reflect.get(target, key);
  } });
}
