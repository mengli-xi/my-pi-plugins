import { TASK_TIMEOUT_MIN_MS, TASK_TIMEOUT_MAX_MS, TASK_TIMEOUT_DESCRIPTION } from "../domain/task-policy.js";
import { Type } from "typebox";
import { FORK_TURN_KEYWORDS, FORK_TURNS_DESCRIPTION } from "pi-session-runtime/fork-turns";

const Target = Type.String({ description: "Agent id or task path." });
const Message = Type.String();
const ReasoningEffort = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
], { description: "Requested level; the selected model must support it. Omit to take the role's effort, else the parent level when the model is unchanged, else medium clamped to the model." });

export const SPAWN_AGENT_SCHEMA = Type.Object({
  task_name: Type.String({ description: "Unique sibling task name." }),
  message: Message,
  fork_turns: Type.Optional(Type.String({ description: FORK_TURNS_DESCRIPTION, examples: [...FORK_TURN_KEYWORDS] })),
  agent_type: Type.Optional(Type.String({ description: "Role name. Built-ins: default, explorer, worker; configured custom roles are also allowed." })),
  model: Type.Optional(Type.String({ description: "Omit to inherit the parent conversation's model (recommended; a role may override it). Set only when the user names a model or the task needs a different one, as provider/model; bare id rejected unless unique in scope." })),
  reasoning_effort: Type.Optional(ReasoningEffort),
  task_timeout_ms: Type.Optional(Type.Integer({ minimum: TASK_TIMEOUT_MIN_MS, maximum: TASK_TIMEOUT_MAX_MS, description: TASK_TIMEOUT_DESCRIPTION })),
  service_tier: Type.Optional(Type.String({ description: "Service tier." })),
}, { additionalProperties: false });

export const LIST_SUBAGENT_MODELS_SCHEMA = Type.Object({
  query: Type.String({ description: "Exact provider/model first; otherwise all words split by whitespace, / or : match in any order. Case-insensitive." }),
}, { additionalProperties: false });

export const LIST_SUBAGENT_ROLES_SCHEMA = Type.Object({
  query: Type.String({ description: "Exact role name first; otherwise all words split by whitespace, / or : match name/description in any order. Case-insensitive." }),
}, { additionalProperties: false });

export const SEND_INPUT_SCHEMA = Type.Object({ target: Target, message: Message, interrupt: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const RESUME_AGENT_SCHEMA = Type.Object({ target: Target }, { additionalProperties: false });
export const CLOSE_AGENT_SCHEMA = Type.Object({ target: Target, force: Type.Optional(Type.Boolean()) }, { additionalProperties: false });

export const WAIT_AGENTS_SCHEMA = Type.Object({
  targets: Type.Array(Target, { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

export const LIST_AGENTS_SCHEMA = Type.Object({
  path_prefix: Type.Optional(Type.String({ description: "Task-path prefix." })),
}, { additionalProperties: false });
