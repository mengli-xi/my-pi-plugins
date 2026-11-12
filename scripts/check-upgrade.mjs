// 包自己的 check:upgrade 聚合同一份 check:upgrade:* 声明，失败仍继续。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvironment, piBin, readJson } from "./pi-checks.mjs";
import { probePrerequisites, runCommand, upgradeSuites } from "./pi-upgrade-check.mjs";

const directory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-upgrade-suites-"));
const environment = join(directory, "environment");
for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(environment, name), { recursive: true });
const binary = piBin();
const env = checkEnvironment(environment, { PI_BIN: binary, PI_PROCESSES_TEST_PI: binary, PI_GOAL_TEST_BINARY: binary });
try {
  for (const suite of upgradeSuites([{ ...readJson("package.json"), directory: "." }])) {
    const reason = probePrerequisites(suite.requires, { cwd: process.cwd(), env });
    const result = reason ? { status: "prerequisite", reason, durationMs: 0 } : await runCommand("npm", ["run", suite.item], {
      cwd: process.cwd(), env, log: join(directory, suite.item.replaceAll(":", "-") + ".log"), timeoutMs: suite.timeoutMs, cleanupPaths: [environment],
    });
    console.log(`${suite.item}: ${result.status} (${result.durationMs}ms)`);
    if (result.status !== "passed") { console.error(result.reason ?? result.output); process.exitCode = 1; }
    if (result.interrupted) break;
  }
} finally {
  rmSync(environment, { recursive: true, force: true });
  console.log(`日志：${directory}`);
}
