import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listSubagentModelsV1 } from "../capabilities/model.js";
import { unspawnableProviderIdsForContextV1 } from "../capabilities/closure.js";
import { getOrCreateChildCapabilityRegistryV1, type ChildCapabilityRegistrySnapshotV1 } from "../capabilities/registry.js";
import { searchSubagentRolesV1 } from "../capabilities/roles.js";
import { loadAgentRoles } from "../roles/load.js";
import { validateListSubagentModelsInput, validateListSubagentRolesInput } from "./validate.js";
import type { CollaborationToolName } from "./results.js";

export async function localCollaborationQuery(tool: CollaborationToolName, params: unknown, context: ExtensionContext | undefined, agentDirectory: string, registry?: ChildCapabilityRegistrySnapshotV1): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (tool !== "list_subagent_models" && tool !== "list_subagent_roles") return;
  if (!context) throw new Error(`${tool} execution context is unavailable`);
  if (tool === "list_subagent_models") {
    const query = validateListSubagentModelsInput(params).query;
    const excludeProviderIds = unspawnableProviderIdsForContextV1(context, sessionId => registry ?? getOrCreateChildCapabilityRegistryV1().snapshot(sessionId), agentDirectory);
    return { ...listSubagentModelsV1({ availableModels: context.modelRegistry.getAvailable(), scopedModels: context.scopedModels, query, excludeProviderIds }) };
  }
  const query = validateListSubagentRolesInput(params).query;
  const roles = await loadAgentRoles({ agentDirectory, cwd: context.cwd, projectTrusted: context.isProjectTrusted() });
  return searchSubagentRolesV1({ roles: roles.roles, query });
}
