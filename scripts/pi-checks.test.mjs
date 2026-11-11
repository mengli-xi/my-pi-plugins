import assert from "node:assert/strict";
import test from "node:test";
import { piBin, repositoryRoot } from "./pi-checks.mjs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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

test("fresh-profile resolves explicit PI_BIN from the repository after a workspace chdir", () => {
  const fixture = pathToFileURL(resolve(repositoryRoot, "local/pi-subagents/test/fixtures/fresh-profile.ts")).href;
  for (const configured of ["node_modules/.bin/pi", "/tmp/explicit-pi"]) {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const { piBinary } = await import(${JSON.stringify(fixture)}); console.log(piBinary);`], {
      cwd: resolve(repositoryRoot, "local/pi-subagents"), env: { ...process.env, PI_BIN: configured }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(output.trim(), resolve(repositoryRoot, configured));
  }
});
