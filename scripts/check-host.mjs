// 包可串联多个检查；每个子套件有日志、时限和清理，失败仍继续。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvironment, installedPiVersion, piBin } from "./pi-checks.mjs";
import { probePrerequisites, runCommand } from "./pi-upgrade-check.mjs";

const commands = [[]];
for (const arg of process.argv.slice(2)) {
  if (arg === "::") commands.push([]);
  else commands.at(-1).push(arg);
}
const suitesToRun = commands.map(args => {
  const requires = [];
  while (args[0]?.startsWith("--require=")) {
    const requirement = args.shift().slice("--require=".length);
    if (!["tmux", "pty"].includes(requirement)) throw new Error(`未知前提：${requirement}`);
    requires.push(requirement);
  }
  if (!args.length) throw new Error("用法：check-host.mjs [--require=tmux|pty] <命令> [参数] [:: ...]");
  if (args[0] === "bun" && !requires.includes("pty")) requires.push("pty");
  return { args, requires };
});
const binary = piBin();
// 归上层 TMPDIR 所有，外层中断后也能回收；短前缀和直接复用根目录避免嵌套挤占 Unix socket 路径。
const root = mkdtempSync(join(process.env.PI_CHECK_TMPDIR ?? (process.platform === "darwin" ? "/tmp" : tmpdir()), "ph-"));
const env = checkEnvironment(root, { PI_BIN: binary, PI_CHECK_PREBUILT: process.env.PI_CHECK_PREBUILT ?? "[]", TMPDIR: root, TMP: root, TEMP: root });
const suites = [];
for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(root, name));
try {
  if (!existsSync(binary)) throw new Error(`找不到 Pi CLI：${binary}。先在仓库根运行 bun install，或用 PI_BIN 指定可执行文件。`);
  const versionProbe = await runCommand(binary, ["--version"], {
    cwd: process.cwd(), env, timeoutMs: 120_000, cleanupPaths: [root],
    log: process.env.PI_CHECK_REPORT ? `${process.env.PI_CHECK_REPORT}.version.log` : join(root, "version.log"),
  });
  if (versionProbe.status !== "passed") throw new Error(versionProbe.reason ?? versionProbe.output);
  const version = versionProbe.stdout.trim();
  if (version !== installedPiVersion()) throw new Error(`Pi CLI ${version} 与已安装 SDK ${installedPiVersion()} 不一致：${binary}`);
  for (const { args: [command, ...args], requires } of suitesToRun) {
    const item = [command, ...args].join(" ");
    console.log(`\n[check:host] ${item}`);
    const reason = probePrerequisites(requires, { cwd: process.cwd(), env });
    const log = process.env.PI_CHECK_REPORT ? `${process.env.PI_CHECK_REPORT}.suite-${suites.length + 1}.log` : join(root, `suite-${suites.length + 1}.log`);
    const result = reason ? { status: "prerequisite", reason, durationMs: 0 } : await runCommand(command, args, {
      cwd: process.cwd(), env, log, timeoutMs: 600_000, cleanupPaths: [root], tee: true,
    });
    const { output, stdout, ...entry } = result;
    suites.push({ item, ...entry, ...(reason ? {} : { log }) });
    if (result.status !== "passed") {
      console.error(`失败：${item}（${result.status}，退出码 ${result.code}，信号 ${result.signal}）${reason ?? ""}`);
      process.exitCode = 1;
    }
    if (result.interrupted) break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (process.env.PI_CHECK_REPORT) writeFileSync(process.env.PI_CHECK_REPORT, JSON.stringify(suites));
  rmSync(root, { recursive: true, force: true });
}
