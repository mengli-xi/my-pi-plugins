import assert from "node:assert/strict";
import test from "node:test";
import { builtinRoles } from "../../src/roles/builtins.js";
import { listSubagentRolesV1, searchSubagentRolesV1 } from "../../src/capabilities/roles.js";

test("role query returns matching summaries sorted by name", () => {
  const roles = builtinRoles("2026-09-13T00:00:00.000Z");
  const result = listSubagentRolesV1({ roles, query: "read" });
  assert.deepEqual(result.map((entry) => entry.name), ["explorer"]);
  assert.equal(result[0]!.source, "built-in");
  assert.equal(result[0]!.tools[0], "read");
});

test("role query matches name or description case-insensitively", () => {
  const roles = builtinRoles("2026-09-13T00:00:00.000Z");
  assert.deepEqual(
    listSubagentRolesV1({ roles, query: "EXPLORER" }).map((entry) => entry.name),
    ["explorer"],
  );
  assert.deepEqual(
    listSubagentRolesV1({ roles, query: "implementation" }).map((entry) => entry.name),
    ["worker"],
  );
});

test("role query with no match returns empty", () => {
  const roles = builtinRoles("2026-09-13T00:00:00.000Z");
  assert.deepEqual(listSubagentRolesV1({ roles, query: "nonexistent" }), []);
});

test("role query matches every word across name and description in any order", () => {
  const roles = builtinRoles("2026-09-13T00:00:00.000Z");
  for (const query of ["explorer read", "READ:explorer", "read/explorer", " read\n\texplorer "]) {
    assert.deepEqual(listSubagentRolesV1({ roles, query }).map((entry) => entry.name), ["explorer"], query);
  }
  assert.deepEqual(listSubagentRolesV1({ roles, query: "explorer implementation" }), []);
});

test("role query exposes no role body or private path", () => {
  const roles = builtinRoles("2026-09-13T00:00:00.000Z");
  const result = listSubagentRolesV1({ roles, query: "default" });
  assert.equal(result.length, 1);
  const entry = result[0]!;
  assert.equal(Object.hasOwn(entry, "body"), false);
  assert.equal(Object.hasOwn(entry, "private_source_path"), false);
});

test("role name exact match wins over description/partial matches and words are bounded", () => {
  const template = builtinRoles().get("worker")!;
  const roles = new Map(Array.from({ length: 25 }, (_, index) => {
    const name = `worker-${String(index).padStart(2, "0")}`;
    return [name, { ...template, frontmatter: { ...template.frontmatter, name, description: "worker-24 implementation" } }];
  }));
  assert.deepEqual(searchSubagentRolesV1({ roles, query: " WORKER-24 " }).roles.map((entry) => entry.name), ["worker-24"]);
  const result = searchSubagentRolesV1({ roles, query: "implementation worker" });
  assert.equal(result.roles.length, 20);
  assert.equal(result.more, 5);
  assert.deepEqual(result.roles.map((entry) => entry.name), [...roles.keys()].sort().slice(0, 20));
  assert.deepEqual(searchSubagentRolesV1({ roles, query: "missing" }), { roles: [] });
});
