#!/usr/bin/env node
// 真实宿主检查：Pi 1.5 把本包加载为扩展后，/exit 出现在命令列表里；
// 临时会话下执行 /exit 只提示错误，不退出宿主。
import { piBin } from "../../../scripts/pi-checks.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 2) {
  console.error("用法：node scripts/check-host.mjs");
  process.exit(2);
}

const binary = piBin();
const root = mkdtempSync(join(tmpdir(), "pi-exit-host-"));
const agent = join(root, "agent");
const sessions = join(root, "sessions");
for (const path of [join(root, "home"), agent, sessions, join(root, "config")]) mkdirSync(path);

const results = new Map();
const report = (id, ok) => {
  results.set(id, ok);
  process.stdout.write(`${ok ? "OK" : "MISSING"} ${id}\n`);
};

try {
  const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
  const input = [
    '{"id":"1","type":"get_commands"}',
    '{"id":"2","type":"prompt","message":"/exit"}',
    "",
  ].join("\n");
  const run = spawnSync(
    binary,
    ["--mode", "rpc", "--no-session", "--session-dir", sessions, "-ne", "-e", extension],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: agent,
        PI_NEXT_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        XDG_CONFIG_HOME: join(root, "config"),
      },
      input,
      encoding: "utf8",
      timeout: 120_000,
    },
  );

  const records = [];
  for (const line of (run.stdout ?? "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ type: "unparsable", line });
    }
  }

  const commands = records.find((record) => record.command === "get_commands");
  report(
    "command.exit-registered",
    commands?.success === true &&
      Array.isArray(commands.data?.commands) &&
      commands.data.commands.some(
        (command) => command.name === "exit" && command.source === "extension",
      ),
  );

  const prompt = records.find((record) => record.command === "prompt");
  report(
    "command.exit-handled",
    prompt?.success === true && prompt.data?.disposition === "handled",
  );

  const notify = records.find(
    (record) => record.type === "extension_ui_request" && record.method === "notify",
  );
  report(
    "command.ephemeral-session-error",
    notify?.notifyType === "error" && /无法重启/u.test(String(notify?.message)),
  );
  // 宿主正常退出，说明 /exit 在临时会话下没有提前关闭进程。
  report("command.host-alive", run.status === 0 && run.error === undefined);

  if (![...results.values()].every(Boolean)) {
    process.stderr.write(`${run.stdout ?? ""}${run.stderr ?? ""}${run.error?.message ?? ""}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
