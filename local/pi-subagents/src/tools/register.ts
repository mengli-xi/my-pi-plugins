import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SEND_INPUT_SCHEMA,
  RESUME_AGENT_SCHEMA,
  CLOSE_AGENT_SCHEMA,
  LIST_AGENTS_SCHEMA,
  LIST_SUBAGENT_MODELS_SCHEMA,
  LIST_SUBAGENT_ROLES_SCHEMA,
  SPAWN_AGENT_SCHEMA,
  WAIT_AGENTS_SCHEMA,
} from "./schemas.js";
import { invalidArgumentsResult, unavailableResult, type CollaborationToolName, type ToolResultV1 } from "./results.js";
import {
  validateListAgentsInput,
  validateListSubagentModelsInput,
  validateListSubagentRolesInput,
  validateSpawnAgentInput,
  validateTargetInput,
  validateSendInput,
  validateCloseAgentInput,
  validateWaitAgentsInput,
} from "./validate.js";

const DEFINITIONS = [
  {
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Create a persistent background child agent and durably queue its initial task.",
    parameters: SPAWN_AGENT_SCHEMA,
    validate: validateSpawnAgentInput,
  },
  {
    name: "list_subagent_models",
    label: "List Subagent Models",
    description: "Find a subagent model in one query. Exact provider/model wins (case-insensitive, trimmed); otherwise all words split by whitespace, / or : must match in any order. Returns models and unavailable {id,reason}, at most 20 total; more counts omitted matches. Never spawn unavailable IDs. Omit model to inherit the parent.",
    parameters: LIST_SUBAGENT_MODELS_SCHEMA,
    validate: validateListSubagentModelsInput,
  },
  {
    name: "list_subagent_roles",
    label: "List Subagent Roles",
    description: "Find spawn_agent agent_type in one query. Exact role name wins (case-insensitive, trimmed); otherwise all words split by whitespace, / or : must match name/description in any order. Returns at most 20 roles; more counts omitted matches.",
    parameters: LIST_SUBAGENT_ROLES_SCHEMA,
    validate: validateListSubagentRolesInput,
  },
  {
    name: "send_input",
    promptGuidelines: ["Ordinary busy input steers the current Task. Use interrupt=true to stop and assign a new Task; other queued work remains. Resume closed agents before input; resume alone starts no work."],
    label: "Send Input",
    description: "Continue an open agent. Ordinary input steers its current Task, or immediately requests an active slot for its waiting Task. Idle input creates a new Task. interrupt=true stops the current Task and starts a new one, preserving other queued work. Resume closed agents first.",
    parameters: SEND_INPUT_SCHEMA,
    validate: validateSendInput,
  },
  {
    name: "resume_agent",
    label: "Resume Agent",
    description: "Open a closed agent with its frozen profile and history. Resuming is idle: it starts no Task or provider request. Already open agents return idempotently. Main-only.",
    parameters: RESUME_AGENT_SCHEMA,
    validate: validateTargetInput,
  },
  {
    name: "close_agent",
    promptGuidelines: ["Close idle subtrees after collecting results when no immediate work remains. force=true cancels the whole subtree. Do not retain idle agents as a pool or poll for completion."],
    label: "Close Agent",
    description: "Close an idle structural subtree after collecting its results. force=true cancels every current and queued Task in that subtree. History and unread results remain available. Main-only.",
    parameters: CLOSE_AGENT_SCHEMA,
    validate: validateCloseAgentInput,
  },
  {
    name: "wait_agents",
    label: "Wait Agents",
    description: "Arm a non-polling all-of continuation for admitted Tasks owned by the caller; child callers are limited to direct descendants. Call it as the only tool in the assistant message.",
    parameters: WAIT_AGENTS_SCHEMA,
    validate: validateWaitAgentsInput,
  },
  {
    name: "list_agents",
    label: "List Agents",
    description: "List bounded metadata for agents in the current Main-owned tree.",
    parameters: LIST_AGENTS_SCHEMA,
    validate: validateListAgentsInput,
  },
] as const;

export interface CollaborationExecutionV1 { readonly details: ToolResultV1<unknown>; readonly terminate?: boolean }

export function waitAgentsIsStandaloneV1(context: ExtensionContext | undefined, toolCallId: string): boolean {
  const branch = context?.sessionManager.getBranch();
  if (!branch) return false;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const calls = entry.message.content.filter((block): block is Extract<(typeof entry.message.content)[number], { type: "toolCall" }> => typeof block === "object" && block !== null && block.type === "toolCall");
    if (calls.some((call) => call.id === toolCallId)) return calls.length === 1;
  }
  return false;
}

export type CollaborationExecutorV1 = (input: { readonly tool: CollaborationToolName; readonly toolCallId: string; readonly params: unknown; readonly signal?: AbortSignal; readonly context?: ExtensionContext }) => Promise<CollaborationExecutionV1>;

export function registerCollaborationTools(pi: ExtensionAPI, executor?: CollaborationExecutorV1, canSpawn = true, main = true): void {
  for (const definition of DEFINITIONS) {
    if (!main && (definition.name === "close_agent" || definition.name === "resume_agent")) continue;
    if (!canSpawn && definition.name === "spawn_agent") continue;
    pi.registerTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      ...("promptGuidelines" in definition ? { promptGuidelines: [...definition.promptGuidelines] } : {}),
      parameters: definition.parameters,
      executionMode: "parallel",
      prepareArguments(args) {
        return args as never;
      },
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        let executed: CollaborationExecutionV1;
        try { definition.validate(params); }
        catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: invalidArgumentsResult(definition.name as CollaborationToolName, error instanceof Error ? error.message : String(error)), isError: true }; }
        if (definition.name === "wait_agents" && !waitAgentsIsStandaloneV1(ctx, toolCallId)) {
          const message = "wait_agents must be the only tool call in its assistant message; finish other tool calls, then call wait_agents alone.";
          return { content: [{ type: "text" as const, text: message }], details: invalidArgumentsResult("wait_agents", message), isError: true };
        }
        executed = executor ? await executor({ tool: definition.name as CollaborationToolName, toolCallId, params, signal, context: ctx }) : { details: unavailableResult(definition.name as CollaborationToolName) };
        const details = executed.details;
        const rejected = details.outcome !== "ok";
        const text = details.outcome === "ok"
          ? JSON.stringify(details.data)
          : (details.error.message.includes(details.error.code) ? details.error.message : `${details.error.code}: ${details.error.message}`);
        return {
          content: [{ type: "text", text }],
          details: executed.details,
          // 被拒绝的调用要标成 error，否则模型会把 "name-conflict" 这种裸码当作正常返回继续往下走。
          ...(rejected ? { isError: true } : {}),
          ...(executed.terminate === true ? { terminate: true } : {}),
        };
      },
    });
  }
}

export function collaborationDefinitions() {
  return DEFINITIONS;
}
