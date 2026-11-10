#!/usr/bin/env node
import { piBin } from "../../../scripts/pi-checks.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.argv[2] === "--host" ? piBin() : undefined;
if (binary) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-skills-probe-"));
  try {
    const home = join(agentDir, "home");
    const sessions = join(agentDir, "sessions");
    mkdirSync(home);
    mkdirSync(sessions);
    const run = spawnSync(binary, ["--mode", "rpc", "--no-session", "--session-dir", sessions, "-ne", "-e", fileURLToPath(new URL("./probe.ts", import.meta.url))], {
      cwd: agentDir,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_NEXT_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", XDG_CONFIG_HOME: join(agentDir, "config") },
      input: '{"type":"get_state"}\n', encoding: "utf8", timeout: 30000,
    });
    process.stderr.write(run.stderr ?? "");
    if (run.error) console.error(run.error.message);
    process.exitCode = run.status === 0 && run.stderr?.includes("OK user-message.render") ? 0 : 1;
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
} else {
  const { checkInternals } = await import("./probe.ts");
  process.exitCode = checkInternals() ? 0 : 1;
}
