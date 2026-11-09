import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { displayEditPath } from "../src/edit-path.ts";

test("cwd-contained paths render relative, including already-relative args", () => {
  assert.equal(displayEditPath("src/a.ts", "/tmp/project"), "src/a.ts");
  assert.equal(displayEditPath("/tmp/project/src/a.ts", "/tmp/project"), "src/a.ts");
  assert.equal(displayEditPath("./src/../src/a.ts", "/tmp/project"), "src/a.ts");
  assert.equal(displayEditPath("/tmp/project", "/tmp/project"), ".");
});

test("paths outside cwd render absolute", () => {
  assert.equal(displayEditPath("/etc/hosts", "/tmp/project"), "/etc/hosts");
  assert.equal(displayEditPath("../secret.ts", "/tmp/project"), resolve("/tmp/secret.ts"));
});

test("missing cwd keeps relative args and normalizes absolute args", () => {
  assert.equal(displayEditPath("src/a.ts"), "src/a.ts");
  assert.equal(displayEditPath("/tmp/project/src/a.ts"), "/tmp/project/src/a.ts");
});

test("display paths expand home before cwd containment", () => {
  const home = homedir();
  assert.equal(displayEditPath("~/project/src/a.ts", join(home, "project")), "src/a.ts");
  assert.equal(displayEditPath("~", home), ".");
});

test("display paths strip terminal sequences before containment", () => {
  assert.equal(displayEditPath("src/\u001b[31ma.ts", "/tmp/project"), "src/a.ts");
  assert.equal(displayEditPath("/etc/\u001b[31mhosts", "/tmp/project"), "/etc/hosts");
});
