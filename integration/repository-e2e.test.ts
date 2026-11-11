import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

// 迁出的仓库内协作矩阵使用锁定的 stock CLI，不发现真实 profile。
process.env.PI_BIN ??= fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
process.chdir(fileURLToPath(new URL("../local/pi-subagents", import.meta.url)));
await import("./subagents/real/bash-timeout-child-e2e.test.ts");

test("bash-timeout spawn failure reports ENOENT without hanging cleanup", { timeout: 30_000 }, async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_BIN: "missing-pi-binary-r3" };
  delete env.NODE_TEST_CONTEXT; // This is an independent runner, not a child-v8 test worker.
  await assert.rejects(promisify(execFile)(process.execPath, [
    "--import", fileURLToPath(new URL("../ts-resolve.mjs", import.meta.url)),
    "--experimental-strip-types", "--test", "--test-timeout=15000",
    fileURLToPath(new URL("./subagents/real/bash-timeout-child-e2e.test.ts", import.meta.url)),
  ], { env, timeout: 20_000 }), (error: any) => {
    assert.equal(error.killed, false, "spawn failure must finish by itself, not by the outer timeout");
    assert.equal(error.code, 1);
    assert.match(error.stdout, /ENOENT/);
    assert.doesNotMatch(error.stdout, /timed out|cancelledByParent/);
    return true;
  });
});
