import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collaborationDefinitions, registerCollaborationTools, type CollaborationExecutionV1, type CollaborationExecutorV1 } from "../tools/register.js";
import { toolDefinitionDigest } from "../capabilities/fingerprint.js";
import { isHostErrorCode } from "../tools/errors.js";
import type { CollaborationToolName, ToolResultV1 } from "../tools/results.js";
import { localCollaborationQuery } from "../tools/local-query.js";
import { validateListAgentsInput, validateListSubagentModelsInput, validateListSubagentRolesInput, validateSpawnAgentInput, validateTargetInput, validateTargetMessageInput, validateSendInput, validateWaitAgentsInput } from "../tools/validate.js";
import { generateDomainId } from "../domain/ids.js";
import type { MainSpawnPreparationV1 } from "../host/main-spawn-preparation.js";
import type { ChildToolPort, ChildPreparedArtifacts } from "./tool-port.js";
export const FINISH_TASK_SCHEMA = Type.Object({ outcome: Type.Union([Type.Literal("partial"), Type.Literal("blocked")]), text: Type.String(), reason: Type.Optional(Type.Union([Type.Literal("user-input-required"), Type.Literal("approval-required"), Type.Literal("external-prerequisite")])) }, { additionalProperties: false });
export const FINISH_TASK_DESCRIPTION = "Declare the current task partial or blocked and stop this run. Do not call it when the task is fully done: a normal final reply without tool calls is recorded as completed. partial = you stopped early with usable results; blocked = you cannot proceed without a user decision, approval, or a capability you lack (reason required).";
function jsonValue(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) as unknown; }
export function mandatoryChildReadyToolsV1(canSpawn = true): readonly { readonly name: string; readonly definitionSha256: string }[] {
  const definitions = [
    ...collaborationDefinitions().filter(definition => !["close_agent", "resume_agent"].includes(definition.name)).filter(definition => canSpawn || definition.name !== "spawn_agent").map(definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters, promptGuidelines: "promptGuidelines" in definition ? definition.promptGuidelines : [] })),
    { name: "finish_task", description: FINISH_TASK_DESCRIPTION, parameters: FINISH_TASK_SCHEMA },
  ];
  return Object.freeze(definitions.map((definition) => Object.freeze({ name: definition.name, definitionSha256: toolDefinitionDigest({ name: definition.name, owner_id: "pi-subagents", description: definition.description, parameters: jsonValue(definition.parameters), prompt_guidelines: "promptGuidelines" in definition ? definition.promptGuidelines : [] }) })).sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name))));
}
export function finishInput(value: unknown): { outcome: "partial" | "blocked"; text: string; reason?: "user-input-required" | "approval-required" | "external-prerequisite" } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("finish_task input must be a plain object"); const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["outcome", "text", "reason"].includes(key)) || (input.outcome !== "partial" && input.outcome !== "blocked") || typeof input.text !== "string" || input.text.trim().length === 0 || Buffer.byteLength(input.text) > 65_536 || input.text.normalize("NFC") !== input.text) throw new Error("finish_task input is invalid");
  if (input.reason !== undefined && !["user-input-required", "approval-required", "external-prerequisite"].includes(input.reason as string)) throw new Error("finish_task reason is invalid");
  if (input.outcome === "blocked" && input.reason === undefined) throw new Error("blocked finish_task requires reason: user-input-required, approval-required, or external-prerequisite");
  // partial 带了 reason 就丢掉，不为此打回一整次 finish；模型第二次重试只会浪费一个 turn。
  return { outcome: input.outcome, text: input.text, ...(input.outcome === "blocked" && input.reason !== undefined ? { reason: input.reason as "user-input-required" | "approval-required" | "external-prerequisite" } : {}) };
}
function rejected(tool: CollaborationToolName, code: string, message: string, hostRevision = 0, correlationId?: string): ToolResultV1<never> { return { version: 1, tool, outcome: "rejected", host_revision: hostRevision, error: { code: isHostErrorCode(code) ? code : "protocol-error", message, ...(correlationId ? { correlation_id: correlationId } : {}) } }; }
function success(tool: CollaborationToolName, hostRevision: number, data: unknown): ToolResultV1<unknown> { return { version: 1, tool, outcome: "ok", host_revision: hostRevision, data }; }
function payloadFor(tool: CollaborationToolName, params: unknown): Readonly<Record<string, unknown>> {
  if (tool === "spawn_agent") return validateSpawnAgentInput(params) as unknown as Readonly<Record<string, unknown>>;
  if (tool === "send_input") return validateSendInput(params) as unknown as Readonly<Record<string, unknown>>;
  if (tool === "wait_agents") return validateWaitAgentsInput(params) as unknown as Readonly<Record<string, unknown>>;
  if (tool === "list_subagent_models") return validateListSubagentModelsInput(params) as unknown as Readonly<Record<string, unknown>>;
  if (tool === "list_subagent_roles") return validateListSubagentRolesInput(params) as unknown as Readonly<Record<string, unknown>>;
  const list = validateListAgentsInput(params); return list.path_prefix === undefined ? {} : { pathPrefix: list.path_prefix };
}

export function childCollaborationExecutorV1(port: ChildToolPort, preparation?: MainSpawnPreparationV1): CollaborationExecutorV1 {
  return async ({ tool, params, signal, context }): Promise<CollaborationExecutionV1> => {
    try {
      if (signal?.aborted) return { details: rejected(tool, "cancelled", "Task input was cancelled.") };
      port.assertReady();
      const identity = port.identity();
      if (tool === "spawn_agent" && identity.depth >= 2) return { details: rejected(tool, "depth-limit", "Maximum Subagent depth reached: this Agent is at depth 2 and cannot spawn children. Do the work with your own tools, or finish_task with blocked and tell the parent what is needed.") };
      const query = await localCollaborationQuery(tool, params, context, port.agentDirectory, port.capabilitySnapshot);
      if (query) return { details: success(tool, port.revision(), query) };
      if (tool === "spawn_agent") {
        const requestId = randomUUID();
        let artifacts: ChildPreparedArtifacts | undefined;
        if (tool === "spawn_agent") {
          if (!preparation || !context) throw new Error("context-unavailable: nested spawn preparation is unavailable");
          const accepted = validateSpawnAgentInput(params), agentId = generateDomainId("agt"), taskId = generateDomainId("tsk");
          const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: identity.sessionId, agent_id: identity.agentId }, runtime_generation: identity.generation, owner_request_id: requestId };
          const release = preparation.bind(requestId, context);
          try { artifacts = { agentId, taskId, preparation: await preparation.prepare({ requestId, agentId, taskId, taskPath: `${identity.taskPath}/${accepted.task_name}`, caller,
            taskName: accepted.task_name, message: accepted.message, forkTurns: accepted.fork_turns ?? "none", agentType: accepted.agent_type, model: accepted.model,
            reasoningEffort: accepted.reasoning_effort, serviceTier: accepted.service_tier, taskTimeoutMs: accepted.task_timeout_ms }) }; }
          finally { release(); }
        }
        port.assertReady();
        const staged = await port.prepare({ requestId, kind: "spawn", payload: payloadFor(tool, params), artifacts });
        if (staged.result.state === "committed") {
          const publicResult = staged.result.publicResult;
          if (!publicResult || typeof publicResult !== "object" || Array.isArray(publicResult)) throw new Error("committed prepare result is invalid");
          return { details: success(tool, staged.hostRevision, publicResult) };
        }
        if (staged.result.state !== "prepared" || !staged.result.prepared || typeof staged.result.prepared !== "object" || Array.isArray(staged.result.prepared)) throw new Error("prepared task result is invalid");
        const prepared = staged.result.prepared as Record<string, unknown>, leaseOwner = prepared.leaseOwner as Record<string, unknown> | undefined;
        if (!leaseOwner || leaseOwner.kind !== "agent" || leaseOwner.agentId !== identity.agentId || leaseOwner.sessionId !== identity.sessionId || typeof prepared.taskId !== "string" || prepared.logicalLeaseKey !== prepared.taskId || typeof prepared.preparedToken !== "string") throw new Error("prepared Task lease owner does not match caller child");
        const token = { requestId, preparedToken: prepared.preparedToken, taskId: prepared.taskId };
        if (signal?.aborted) { await port.abort({ ...token, reason: "caller-aborted" }); return { details: rejected(tool, "cancelled", "Nested task admission was cancelled.", port.revision()) }; }
        let lease;
        try { lease = port.acquireTaskLease(prepared.taskId); }
        catch (error) { await port.abort({ ...token, reason: "lease-failed" }); throw error; }
        const committed = await port.commit({ ...token, lease });
        return { details: success(tool, committed.hostRevision, committed.result) };
      }
      const result = await port.collaborate(tool, payloadFor(tool, params));
      return { details: success(tool, result.hostRevision, result.result), ...(tool === "wait_agents" && result.result.state === "armed" ? { terminate: true } : {}) };
    } catch (error) {
      const value = error as Error & { code?: string; hostRevision?: number; correlationId?: string };
      return { details: rejected(tool, value.code ?? "protocol-error", value.message, value.hostRevision ?? port.revision(), value.correlationId) };
    }
  };
}

export function registerChildToolsV1(pi: ExtensionAPI, port: ChildToolPort, preparation?: MainSpawnPreparationV1, canSpawn = true): void {
  registerCollaborationTools(pi, childCollaborationExecutorV1(port, preparation), canSpawn, false);
  pi.registerTool<typeof FINISH_TASK_SCHEMA, unknown>({
    name: "finish_task", label: "Finish Task", description: FINISH_TASK_DESCRIPTION, parameters: FINISH_TASK_SCHEMA, executionMode: "parallel",
    async execute(toolCallId, params) {
      const input = finishInput(params);
      try {
        port.assertReady();
        const result = await port.finish({ taskId: port.taskId(), toolCallId, outcome: input.outcome, text: input.text, textSha256: createHash("sha256").update(input.text).digest("hex"), ...(input.reason ? { reason: input.reason } : {}) });
        return { content: [{ type: "text", text: JSON.stringify(result.result) }], details: { version: 1, outcome: "ok", host_revision: result.hostRevision, data: result.result }, terminate: true };
      } catch (error) {
        const value = error as Error & { code?: string; hostRevision?: number };
        return { content: [{ type: "text", text: value.message }], details: { version: 1, outcome: "rejected", host_revision: value.hostRevision ?? port.revision(), error: { code: isHostErrorCode(value.code) ? value.code : "protocol-error", message: value.message } }, isError: true };
      }
    },
  });
}
