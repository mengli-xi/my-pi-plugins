// 测试侧隔离：不继承凭据，不调用用户的服务管理器或桌面通知。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvironment } from "../../../scripts/pi-checks.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("用法：isolated-tests.mjs <命令> [参数...]");
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "scheduler-test-"));
for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp", "bin"]) mkdirSync(join(root, name));
for (const name of ["launchctl", "systemctl", "osascript", "notify-send"]) {
  writeFileSync(join(root, "bin", name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
}
try {
  const result = spawnSync(command, args, { stdio: "inherit", env: checkEnvironment(root, {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    PI_CHECK_BINARY: process.env.PI_CHECK_BINARY ?? "0",
    PI_CHECK_PREBUILT: process.env.PI_CHECK_PREBUILT ?? "[]",
    ...(process.env.PI_CHECK_REPORT ? { PI_CHECK_REPORT: process.env.PI_CHECK_REPORT } : {}),
    ...(process.env.PI_BIN ? { PI_BIN: process.env.PI_BIN } : {}),
  }) });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
