import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = process.env.CC_LONG_WRITE_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "cc-long-write-"));
mkdirSync(root, { recursive: true });
const fixture = fileURLToPath(new URL("./long-write-fixture.mjs", import.meta.url));
const results = [];
for (const size of (process.env.CC_LONG_WRITE_SIZES ?? "50,100,200").split(",")) {
  for (const scenario of (process.env.CC_LONG_WRITE_SCENARIOS ?? "native,main,child,main-perf").split(",")) {
    const runRoot = join(root, `${scenario}-${size}`);
    for (const dir of [runRoot, join(runRoot, "home"), join(runRoot, "agent")]) mkdirSync(dir, { recursive: true });
    const binary = process.argv[2];
    const argv = binary ? ["--mode", "rpc", "--offline", "--no-session", "--approve", "--no-extensions", "-e", fixture]
      : [fixture];
    const child = spawn(binary ?? "bun", argv, { cwd: runRoot, env: { ...process.env,
      HOME: join(runRoot, "home"), XDG_CONFIG_HOME: join(runRoot, "home", ".config"),
      PI_CODING_AGENT_DIR: join(runRoot, "agent"), PI_NEXT_AGENT_DIR: join(runRoot, "agent"), PI_OFFLINE: "1",
      CC_LONG_WRITE_ROOT: runRoot, CC_LONG_WRITE_SCENARIO: scenario, CC_LONG_WRITE_KIB: size,
      CC_LONG_WRITE_DIRECT: binary ? "0" : "1", TERM: "xterm-256color" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { error += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    const code = await new Promise(resolve => child.on("exit", resolve)); clearTimeout(timer);
    writeFileSync(join(runRoot, "stdout.txt"), output); writeFileSync(join(runRoot, "stderr.txt"), error);
    assert.equal(code, 0, `${scenario}/${size}: ${error}\n${output}`);
    const { deltas, memory, previewRows, finalRows, ...summary } = JSON.parse(readFileSync(join(runRoot, "result.json"), "utf8"));
    results.push(summary); console.log(JSON.stringify({ root: runRoot, scenario, kib: summary.kib,
      elapsedMs: summary.elapsedMs, parserMs: summary.parserMs, deliveryMs: summary.deliveryMs,
      layoutMs: summary.layoutMs, memoryPeak: summary.memoryPeak }));
    writeFileSync(join(root, "summary.json"), JSON.stringify(results, null, 2));
  }
}
