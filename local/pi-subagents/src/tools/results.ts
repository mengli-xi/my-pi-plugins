import type { HostErrorCode } from "./errors.js";

export const COLLABORATION_TOOL_NAMES = [
  "spawn_agent",
  "list_subagent_models",
  "list_subagent_roles",
  "send_input",
  "resume_agent",
  "close_agent",
  "wait_agents",
  "list_agents",
] as const;

export type CollaborationToolName = (typeof COLLABORATION_TOOL_NAMES)[number];

export interface ToolErrorV1 {
  readonly code: HostErrorCode;
  readonly message: string;
  readonly correlation_id?: string;
}

export type ToolResultV1<T> =
  | {
      readonly version: 1;
      readonly tool: CollaborationToolName;
      readonly outcome: "ok";
      readonly host_revision: number;
      readonly data: T;
    }
  | {
      readonly version: 1;
      readonly tool: CollaborationToolName;
      readonly outcome: "rejected";
      readonly host_revision: number;
      readonly error: ToolErrorV1;
    };

export function invalidArgumentsResult(
  tool: CollaborationToolName,
  message: string,
): Extract<ToolResultV1<never>, { outcome: "rejected" }> {
  return {
    version: 1,
    tool,
    outcome: "rejected",
    host_revision: 0,
    error: {
      code: "invalid-arguments",
      message: message.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").slice(0, 512) || "Tool arguments are invalid.",
    },
  };
}

export function unavailableResult(
  tool: CollaborationToolName,
): Extract<ToolResultV1<never>, { outcome: "rejected" }> {
  return {
    version: 1,
    tool,
    outcome: "rejected",
    host_revision: 0,
    error: {
      code: "unavailable",
      message: "Subagent runtime is not available in this build.",
    },
  };
}
