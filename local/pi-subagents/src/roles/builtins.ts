import { createHash } from "node:crypto";
import type { AgentRoleFrontmatterV1, ResolvedAgentRoleV1 } from "./types.js";

const DEFAULT_BODY = "You are a persistent background Subagent. Complete the delegated task autonomously within the stated scope. Keep unrelated work unchanged, report concrete evidence, and use send_input to steer an open direct descendant. Only Main can close or resume agents. If the task cannot finish without user input or approval, call finish_task with blocked instead of opening interactive UI. Do not poll another Agent; use wait_agents only when your next step depends on direct-child tasks.";
const EXPLORER_BODY = "Explore and diagnose without modifying files, configuration, sessions, processes, or external state. Ground conclusions in exact paths, symbols, commands already available without mutation, and observed behavior. Delegate only independent read-only investigation. If evidence requires a mutation, approval, login, or unavailable capability, call finish_task with blocked and state the required next action.";
const WORKER_BODY = "Implement the delegated change completely within its stated ownership. Inspect before editing, preserve concurrent work outside that ownership, run the narrowest decisive verification, and report changed files and evidence. The workspace is shared and has no write coordinator: never overwrite unrelated edits or imply races are prevented. If another direct child supplies a required result, use wait_agents rather than polling.";

const DEFINITIONS: ReadonlyArray<{ frontmatter: AgentRoleFrontmatterV1; body: string }> = [
  {
    frontmatter: {
      name: "default",
      description: "General delegated work with the parent's reproducible capabilities.",
      tools: "*",
    },
    body: DEFAULT_BODY,
  },
  {
    frontmatter: {
      name: "explorer",
      description: "Read-only repository exploration, diagnosis, and evidence gathering.",
      tools: ["read", "grep", "find", "ls", "spawn_agent", "send_input", "wait_agents", "list_agents"],
    },
    body: EXPLORER_BODY,
  },
  {
    frontmatter: {
      name: "worker",
      description: "Focused implementation and verification within explicitly assigned ownership.",
      tools: "*",
    },
    body: WORKER_BODY,
  },
];

function canonicalBuiltin(definition: { frontmatter: AgentRoleFrontmatterV1; body: string }): string {
  return `${JSON.stringify(definition.frontmatter)}\n${definition.body}\n`;
}

export function builtinRoles(resolvedAt = new Date().toISOString()): ReadonlyMap<string, ResolvedAgentRoleV1> {
  const roles = new Map<string, ResolvedAgentRoleV1>();
  for (const definition of DEFINITIONS) {
    const content = canonicalBuiltin(definition);
    roles.set(definition.frontmatter.name, Object.freeze({
      version: 1,
      source_kind: "builtin",
      source_identity: `builtin:${definition.frontmatter.name}:v1`,
      frontmatter: Object.freeze({
        ...definition.frontmatter,
        ...(Array.isArray(definition.frontmatter.tools) ? { tools: Object.freeze([...definition.frontmatter.tools]) } : {}),
      }) as AgentRoleFrontmatterV1,
      body: definition.body,
      content_sha256: createHash("sha256").update(content).digest("hex"),
      resolved_at: resolvedAt,
    }));
  }
  return roles;
}

export const BUILTIN_ROLE_NAMES = Object.freeze(DEFINITIONS.map((definition) => definition.frontmatter.name));
