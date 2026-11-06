import assert from "node:assert/strict";
import { test } from "node:test";

import { fallbackDisplayName, packageIdentity, packageKind } from "../src/identity.ts";

const cwd = "/work/project";
const agentDir = "/home/user/.pi/agent";

test("npm identity ignores configured versions", () => {
  assert.equal(
    packageIdentity("npm:@scope/tool@1.2.3", "global", cwd, agentDir),
    packageIdentity("npm:@scope/tool@latest", "project", cwd, agentDir),
  );
  assert.equal(fallbackDisplayName("npm:@scope/tool@1.2.3"), "@scope/tool");
});

test("git identity ignores transport and pinned refs", () => {
  assert.equal(
    packageIdentity("git:git@github.com:user/repo.git@v1", "global", cwd, agentDir),
    packageIdentity("https://github.com/user/repo@main", "project", cwd, agentDir),
  );
  assert.equal(packageKind("ssh://git@github.com/user/repo"), "git");
});

test("relative local identity follows the settings scope", () => {
  assert.equal(
    packageIdentity("../plugin", "project", cwd, agentDir),
    "local:/work/project/plugin",
  );
  assert.equal(
    packageIdentity("./plugin", "global", cwd, agentDir),
    "local:/home/user/.pi/agent/plugin",
  );
  assert.equal(packageKind("./plugin"), "local");
});

test("git repository path case is not collapsed into another package", () => {
  assert.notEqual(
    packageIdentity("https://git.example.test/team/Tool", "global", cwd, agentDir),
    packageIdentity("https://git.example.test/team/tool", "global", cwd, agentDir),
  );
});
