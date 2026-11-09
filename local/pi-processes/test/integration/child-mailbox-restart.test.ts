import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const scenario of ["changed", "same", "unknown", "late-changed", "late-same"]) test(`fresh stock SDK process restores frozen child mail with ${scenario} Task authority`, () => {
  const root = mkdtempSync(join(process.env.PI_PROCESSES_TEST_OUTPUT ?? tmpdir(), "child-mailbox-restart-" + scenario + "-"));
  mkdirSync(join(root, "tmp"));
  try {
    for (const phase of [1, 2]) {
      const result = spawnSync(process.execPath, ["--import", new URL("../../../../ts-resolve.mjs", import.meta.url).pathname, "--experimental-strip-types", new URL("./child-mailbox-restart-fixture.ts", import.meta.url).pathname, root, scenario, String(phase)],
        { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), TMPDIR: join(root, "tmp") }, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
      writeFileSync(join(root, "phase" + phase + ".log"), result.stdout); writeFileSync(join(root, "phase" + phase + "-stderr.log"), result.stderr);
      assert.equal(result.error, undefined, String(result.error));
      assert.deepEqual({ code: result.status, signal: result.signal }, phase === 1 ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null }, result.stderr);
    }
    const first = JSON.parse(readFileSync(join(root, "phase1.json"), "utf8")), reopened = JSON.parse(readFileSync(join(root, "phase2.json"), "utf8"));
    assert.deepEqual([first.mainRequests, first.childRequests], [1, 1]);
    assert.deepEqual([reopened.mainRequests, reopened.childRequests], [0, scenario === "same" || scenario.startsWith("late-") ? 1 : 0]);
    assert.equal(reopened.pending, ["unknown", "late-same"].includes(scenario) ? 1 : 0); assert.equal(reopened.terminal, 0);
    console.log(JSON.stringify({ root, scenario, originalRequests: [1, 1], restartRequests: [0, reopened.childRequests], pending: reopened.pending }));
  } finally { if (!process.env.PI_PROCESSES_TEST_OUTPUT) rmSync(root, { recursive: true, force: true }); }
});
