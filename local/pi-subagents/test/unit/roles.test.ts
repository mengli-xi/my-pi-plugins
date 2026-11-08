import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtinRoles } from "../../src/roles/builtins.ts";
import { loadAgentRoles } from "../../src/roles/load.ts";
import { parseRoleMarkdown } from "../../src/roles/parser.ts";

const USER_ROLE = `---
name: reviewer
description: Review changes without mutation.
tools:
  - read
  - grep
required_capabilities:
  - pi-processes/background-process/continuation-v1
reasoning_effort: high
task_timeout_ms: 60000
---
Review the assigned change and report evidence.
`;

function parse(content = USER_ROLE, fileName = "reviewer.md") {
  return parseRoleMarkdown({
    content,
    fileName,
    sourceKind: "user",
    sourceIdentity: "user:test",
    resolvedAt: "2026-08-17T00:00:00.000Z",
  });
}

test("built-in roles are exact, frozen, and complete", () => {
  const roles = builtinRoles("2026-08-17T00:00:00.000Z");
  assert.deepEqual([...roles.keys()], ["default", "explorer", "worker"]);
  assert.equal(roles.get("default")?.frontmatter.tools, "*");
  assert.deepEqual(roles.get("explorer")?.frontmatter.tools, [
    "read", "grep", "find", "ls", "spawn_agent", "send_input", "wait_agents", "list_agents",
  ]);
  assert.match(roles.get("worker")?.body ?? "", /shared and has no write coordinator/);
  assert.equal(Object.isFrozen(roles.get("explorer")?.frontmatter.tools), true);
  for (const role of roles.values()) assert.match(role.content_sha256, /^[a-f0-9]{64}$/u);
});

test("strict role parser accepts the closed frontmatter and normalizes line endings", () => {
  const role = parse(USER_ROLE.replaceAll("\n", "\r\n"));
  assert.equal(role.frontmatter.name, "reviewer");
  assert.deepEqual(role.frontmatter.tools, ["read", "grep"]);
  assert.deepEqual(role.frontmatter.required_capabilities, ["pi-processes/background-process/continuation-v1"]);
  assert.equal(role.frontmatter.reasoning_effort, "high");
  assert.equal(role.frontmatter.task_timeout_ms, 60_000);
  assert.equal(role.body, "Review the assigned change and report evidence.");
  assert.equal(Object.isFrozen(role), true);
});

test("role parser rejects unknown/duplicate keys, basename drift, duplicates, and unsafe YAML", () => {
  assert.throws(() => parse(USER_ROLE.replace("description:", "unknown:")), /unknown frontmatter key/);
  assert.throws(() => parse(USER_ROLE.replace("tools:\n", "description: duplicate\ntools:\n")), /duplicate frontmatter key/);
  assert.throws(() => parse(USER_ROLE, "wrong.md"), /basename/);
  assert.throws(() => parse(USER_ROLE.replace("  - grep\n", "  - read\n")), /unique/);
  assert.throws(() => parse(USER_ROLE.replace("description: Review changes without mutation.", "description: bad # comment")), /quote YAML/);
  assert.throws(() => parse(USER_ROLE.replace("task_timeout_ms: 60000", "task_timeout_ms: 59999")), /60000/);
  assert.throws(() => parse(USER_ROLE.replace("pi-processes/background-process/continuation-v1", "Bad/capability")), /invalid owner/);
});

test("load precedence is builtin < user < trusted project and invalid higher role does not shadow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-roles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home", ".pi", "agent");
  const cwd = join(root, "project");
  const userDir = join(home, "pi-subagents", "roles");
  const projectDir = join(cwd, ".pi", "subagents", "roles");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(userDir, "reviewer.md"), USER_ROLE);
  await writeFile(join(projectDir, "reviewer.md"), USER_ROLE.replace("Review changes without mutation.", "Trusted project review.").replace("Review the assigned change", "Review the trusted project change"));
  await writeFile(join(projectDir, "worker.md"), "---\nname: worker\nunknown: invalid\n---\nInvalid override\n");

  const trusted = await loadAgentRoles({ agentDirectory: home, cwd, projectTrusted: true, resolvedAt: "2026-08-17T00:00:00.000Z" });
  assert.equal(trusted.roles.get("reviewer")?.source_kind, "project");
  assert.equal(trusted.roles.get("reviewer")?.frontmatter.description, "Trusted project review.");
  assert.equal(trusted.roles.get("worker")?.source_kind, "builtin");
  assert.equal(trusted.diagnostics.length, 1);
  assert.equal(trusted.diagnostics[0]?.file_name, "worker.md");

  const untrusted = await loadAgentRoles({ agentDirectory: home, cwd, projectTrusted: false, resolvedAt: "2026-08-17T00:00:00.000Z" });
  assert.equal(untrusted.roles.get("reviewer")?.source_kind, "user");
});
