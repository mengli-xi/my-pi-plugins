import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { builtinRoles } from "./builtins.js";
import { parseRoleMarkdown } from "./parser.js";
import type { ResolvedAgentRoleV1, RoleDiagnosticV1, RoleLoadResultV1, RoleSourceKind } from "./types.js";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 65_536;

async function loadScope(input: {
  directory: string;
  sourceKind: Exclude<RoleSourceKind, "builtin">;
  resolvedAt: string;
}): Promise<{ roles: ResolvedAgentRoleV1[]; diagnostics: RoleDiagnosticV1[] }> {
  let names: string[];
  try {
    names = (await readdir(input.directory)).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { roles: [], diagnostics: [] };
    return {
      roles: [],
      diagnostics: [{
        source_kind: input.sourceKind,
        code: "io-error",
        message: `Cannot scan role directory: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
  if (names.length > MAX_FILES) {
    return {
      roles: [],
      diagnostics: [{
        source_kind: input.sourceKind,
        code: "scope-capacity",
        message: `Role scope contains ${names.length} Markdown files; maximum is ${MAX_FILES}.`,
      }],
    };
  }

  const roles: ResolvedAgentRoleV1[] = [];
  const diagnostics: RoleDiagnosticV1[] = [];
  for (const name of names) {
    const path = join(input.directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("role path is not a regular file");
      if (info.size > MAX_FILE_BYTES) throw new Error(`role file exceeds ${MAX_FILE_BYTES} bytes`);
      const bytes = await readFile(path);
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`role file exceeds ${MAX_FILE_BYTES} bytes`);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const sourceDigest = createHash("sha256").update(bytes).digest("hex");
      roles.push(parseRoleMarkdown({
        content,
        fileName: name,
        sourceKind: input.sourceKind,
        sourceIdentity: `${input.sourceKind}:sha256:${sourceDigest}`,
        privateSourcePath: path,
        resolvedAt: input.resolvedAt,
      }));
    } catch (error) {
      diagnostics.push({
        source_kind: input.sourceKind,
        code: "invalid-file",
        file_name: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { roles, diagnostics };
}

export async function loadAgentRoles(input: {
  agentDirectory: string;
  cwd: string;
  projectTrusted: boolean;
  resolvedAt?: string;
}): Promise<RoleLoadResultV1> {
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  const roles = new Map(builtinRoles(resolvedAt));
  const diagnostics: RoleDiagnosticV1[] = [];
  const user = await loadScope({
    directory: join(input.agentDirectory, "pi-subagents", "roles"),
    sourceKind: "user",
    resolvedAt,
  });
  diagnostics.push(...user.diagnostics);
  for (const role of user.roles) roles.set(role.frontmatter.name, role);
  if (input.projectTrusted) {
    const project = await loadScope({
      directory: join(input.cwd, ".pi", "subagents", "roles"),
      sourceKind: "project",
      resolvedAt,
    });
    diagnostics.push(...project.diagnostics);
    for (const role of project.roles) roles.set(role.frontmatter.name, role);
  }
  return Object.freeze({
    roles: roles as ReadonlyMap<string, ResolvedAgentRoleV1>,
    diagnostics: Object.freeze(diagnostics),
  });
}
