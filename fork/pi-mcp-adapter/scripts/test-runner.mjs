import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { offlineGuard, sourceResolver, testSandbox } from "./test-env.mjs";

const [mode, ...args] = process.argv.slice(2);
const sandbox = testSandbox();
try {
  let commandArgs;
  if (mode === "vitest") {
    const manifestUrl = new URL(import.meta.resolve("vitest/package.json"));
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
    commandArgs = [fileURLToPath(new URL(manifest.bin.vitest, manifestUrl)), ...args];
  } else if (mode === "node") {
    commandArgs = ["--import", sourceResolver, "--import", offlineGuard, ...args];
  } else {
    throw new Error("usage: node scripts/test-runner.mjs <vitest|node> [args...]");
  }
  const env = { ...sandbox.env };
  if (process.env.PI_MCP_TEST_PI_BINARY) env.PI_MCP_TEST_PI_BINARY = process.env.PI_MCP_TEST_PI_BINARY;
  const result = spawnSync(process.execPath, commandArgs, { stdio: "inherit", env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  sandbox.cleanup();
}
