// HEALTH_PATH is captured when internals.ts is imported. Set the process
// environment before loading any test/probe module, including child bundles.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("usage: node scripts/isolated-agent.mjs <command> [args...]");
const root = mkdtempSync(join(tmpdir(), "cc-test-"));
const home = join(root, "home"), agentDir = join(root, "agent");
for (const directory of [home, agentDir, join(home, ".config")]) mkdirSync(directory, { recursive: true });
try {
  const child = spawnSync(command, args, { stdio: "inherit", env: {
    ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PI_CODING_AGENT_DIR: agentDir,
  } });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
