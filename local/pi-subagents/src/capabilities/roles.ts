import type { ResolvedAgentRoleV1 } from "../roles/types.js";
import { matchesQueryWordsV1, queryWordsV1, SEARCH_RESULT_LIMIT_V1 } from "./search.js";

export interface RoleSummaryV1 {
  readonly name: string;
  readonly description: string;
  readonly source: "built-in" | "user" | "project";
  readonly tools: "*" | readonly string[];
}

/**
 * Caller-local, read-only role search. Mirrors `listSubagentModelIdsV1`:
 * every query word must match role name or description, in any order,
 * and only matching summaries are returned. Role bodies and private source
 * paths are never exposed.
 */
export function searchSubagentRolesV1(input: {
  readonly roles: ReadonlyMap<string, ResolvedAgentRoleV1>;
  readonly query: string;
}): { readonly roles: readonly RoleSummaryV1[]; readonly more?: number } {
  const words = queryWordsV1(input.query);
  const summaries: RoleSummaryV1[] = [];
  const exact = [...input.roles.values()].find((role) => role.frontmatter.name.toLowerCase() === input.query.trim().toLowerCase());
  for (const role of exact ? [exact] : input.roles.values()) {
    const haystack = `${role.frontmatter.name}\n${role.frontmatter.description}`.toLowerCase();
    if (!exact && !matchesQueryWordsV1(haystack, words)) continue;
    summaries.push(Object.freeze({
      name: role.frontmatter.name,
      description: role.frontmatter.description,
      source: role.source_kind === "builtin" ? "built-in" : role.source_kind,
      tools: role.frontmatter.tools,
    }));
  }
  summaries.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    roles: Object.freeze(summaries.slice(0, SEARCH_RESULT_LIMIT_V1)),
    ...(summaries.length > SEARCH_RESULT_LIMIT_V1 ? { more: summaries.length - SEARCH_RESULT_LIMIT_V1 } : {}),
  });
}

export function listSubagentRolesV1(input: Parameters<typeof searchSubagentRolesV1>[0]): readonly RoleSummaryV1[] {
  return searchSubagentRolesV1(input).roles;
}
