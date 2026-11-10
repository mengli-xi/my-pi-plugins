// 一个包可串联多个检查；失败不阻止其余检查。二进制与环境在任何子命令前确定。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvironment, installedPiVersion, piBin } from "./pi-checks.mjs";

const commands = [[]];
for (const arg of process.argv.slice(2)) {
  if (arg === "::") commands.push([]);
  else commands.at(-1).push(arg);
}
if (commands.some(command => !command.length)) throw new Error("用法：check-host.mjs <命令> [参数] [:: <命令> [参数]]");
const binary = piBin();
// macOS Unix socket 路径很短；不要把子检查的 tmux socket 嵌入长 TMPDIR。
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-host-"));
const env = checkEnvironment(root, { PI_BIN: binary });
for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(root, name));
try {
  const version = execFileSync(binary, ["--version"], { env, encoding: "utf8", timeout: 30_000 }).trim();
  if (version !== installedPiVersion()) throw new Error(`Pi CLI ${version} 与已安装 SDK ${installedPiVersion()} 不一致：${binary}`);
  for (const [command, ...args] of commands) {
    console.log(`\n[check:host] ${[command, ...args].join(" ")}`);
    const result = spawnSync(command, args, { env, stdio: "inherit" });
    if (result.error) console.error(result.error);
    if (result.status !== 0) {
      console.error(`失败：${[command, ...args].join(" ")}（退出码 ${result.status}，信号 ${result.signal}）`);
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
