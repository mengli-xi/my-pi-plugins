export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type RoleSourceKind = "builtin" | "user" | "project";

export interface AgentRoleFrontmatterV1 {
  readonly name: string;
  readonly description: string;
  readonly tools: "*" | readonly string[];
  readonly required_capabilities?: readonly string[];
  readonly model?: string;
  readonly reasoning_effort?: ReasoningEffort;
  readonly service_tier?: string;
  readonly task_timeout_ms?: number;
}

export interface ResolvedAgentRoleV1 {
  readonly version: 1;
  readonly source_kind: RoleSourceKind;
  readonly source_identity: string;
  readonly private_source_path?: string;
  readonly frontmatter: AgentRoleFrontmatterV1;
  readonly body: string;
  readonly content_sha256: string;
  readonly resolved_at: string;
}

export interface RoleDiagnosticV1 {
  readonly source_kind: Exclude<RoleSourceKind, "builtin">;
  readonly code: "scope-capacity" | "invalid-file" | "io-error";
  readonly file_name?: string;
  readonly message: string;
}

export interface RoleLoadResultV1 {
  readonly roles: ReadonlyMap<string, ResolvedAgentRoleV1>;
  readonly diagnostics: readonly RoleDiagnosticV1[];
}
