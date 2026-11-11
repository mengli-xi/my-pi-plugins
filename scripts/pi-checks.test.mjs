import assert from "node:assert/strict";
import test from "node:test";
import { piBin, repositoryRoot } from "./pi-checks.mjs";
import { resolve } from "node:path";

test("PI_BIN is repository-relative even when a workspace launches check:host", () => {
  const cwd = process.cwd(), previous = process.env.PI_BIN;
  try {
    process.chdir(resolve(repositoryRoot, "local/pi-subagents"));
    process.env.PI_BIN = "node_modules/.bin/pi";
    assert.equal(piBin(), resolve(repositoryRoot, "node_modules/.bin/pi"));
    process.env.PI_BIN = "/tmp/explicit-pi";
    assert.equal(piBin(), "/tmp/explicit-pi");
    delete process.env.PI_BIN;
    assert.equal(piBin(), resolve(repositoryRoot, "node_modules/.bin/pi"));
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = previous;
  }
});
