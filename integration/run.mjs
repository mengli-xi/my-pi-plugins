import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkEnvironment, repositoryRoot } from "../scripts/pi-checks.mjs";
import { cleanupProcesses, createInterruptionScope, probePrerequisites, runCommand } from "../scripts/pi-upgrade-check.mjs";
import { integrationScenarios, requiredBuilds, selectScenarios } from "./scenarios.mjs";

export function integrationEnvironment(root, repository = repositoryRoot, supplied = process.env) {
  const binary = resolve(repository, supplied.PI_BIN ?? "node_modules/.bin/pi");
  return checkEnvironment(root, {
    PI_BIN: binary, PI_GOAL_TEST_BINARY: resolve(repository, supplied.PI_GOAL_TEST_BINARY ?? binary),
    PI_PROCESSES_TEST_PI: binary,
    PI_GOAL_TEST_CC_ENTRY: join(repository, "local/pi-claude-style/dist/index.ts"),
    PI_PROCESSES_TEST_GOAL_ENTRY: join(repository, "fork/pi-goal/dist/index.js"),
  });
}

export async function runIntegration(tag, repository = repositoryRoot) {
  const interruption = createInterruptionScope();
  try { return await integrationCheck(tag, repository, interruption); }
  finally { interruption.dispose(); }
}

async function integrationCheck(tag, repository, interruption) {
  const suites = selectScenarios(integrationScenarios(repository), tag);
  const directory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-integration-"));
  const root = join(directory, "environment");
  for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(root, name), { recursive: true });
  const env = integrationEnvironment(root, repository);
  let code = 0;
  const report = { tag, steps: [], interrupted: null, passed: false };
  try {
    for (const name of requiredBuilds(suites)) {
      interruption.check();
      const result = await runCommand("npm", ["run", "build", "-w", name], {
        cwd: repository, env, tee: true, signal: interruption.signal, timeoutMs: 300_000, cleanupPaths: [root], log: join(directory, `build-${name.replaceAll("/", "-")}.log`),
      });
      const { output, stdout, ...entry } = result;
      report.steps.push({ item: `build ${name}`, ...entry });
      interruption.check();
      if (result.status !== "passed") { code = 1; break; }
    }
    if (suites.some(suite => suite.stock === false)) {
      for (const key of ["PI_PATCHED_SDK", "PI_PATCHED_CLI"]) if (process.env[key]) env[key] = process.env[key];
    }
    // 构建失败就不跑套件。
    for (const suite of code === 0 ? suites : []) {
      interruption.check();
      const [command, ...args] = suite.command.map(arg => arg.replace("$TMPDIR", env.TMPDIR));
      const reason = probePrerequisites(suite.requires ?? [], { cwd: repository, env });
      const result = reason ? { status: "prerequisite", reason, durationMs: 0 } : await runCommand(command, args, {
        cwd: join(repository, suite.cwd ?? ""), env: { ...env, ...suite.env }, timeoutMs: suite.timeoutMs, signal: interruption.signal,
        cleanupPaths: [root], log: join(directory, suite.id.replaceAll("/", "-") + ".log"), tee: true,
      });
      const { output, stdout, ...entry } = result;
      report.steps.push({ item: suite.id, ...entry });
      console.log(`${suite.id}: ${result.status} (${result.durationMs}ms)`);
      if (result.status !== "passed") { code = 1; if (result.reason) console.error(result.reason); }
      interruption.check();
    }
  } catch (error) {
    code = 1;
    report.steps.push({ item: "验收", status: "failed", reason: error.message, interrupted: error.interrupted });
    console.error(error.message);
  } finally {
    let cleanupError;
    try {
      cleanupProcesses([root]);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
      report.steps.push({ item: "清理", status: "failed", reason: error.message });
    }
    report.interrupted = interruption.signal.aborted ? interruption.signal.reason : null;
    report.passed = !report.interrupted && report.steps.every(step => step.status === "passed");
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`日志：${directory}`);
    if (cleanupError) throw cleanupError;
  }
  // 清理期间收到信号时 try 已返回 0，以报告为准。
  return report.passed ? code : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runIntegration(process.argv[2] ?? "default"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
