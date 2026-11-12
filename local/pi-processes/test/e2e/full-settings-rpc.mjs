import { installedPiVersion } from "../../../../scripts/pi-checks.mjs";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-processes-smoke-"));
for (const name of ["home", "agent", "cwd", "tmp"]) mkdirSync(join(root, name));
const pkg = fileURLToPath(new URL("../../", import.meta.url));
writeFileSync(join(root, "agent/settings.json"), JSON.stringify({ packages: [pkg], retry: { enabled: false }, compaction: { enabled: false } }));
const env = { PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
  TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
  PI_OFFLINE: "1", PI_TELEMETRY: "0", NODE_OPTIONS: process.env.NODE_OPTIONS };
process.on("exit", () => { rmSync(root, { recursive: true, force: true }); });
const configuredPi = process.env.PI_PROCESSES_TEST_PI ?? fileURLToPath(new URL("../../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
accessSync(configuredPi, constants.X_OK);
const piExecutable = realpathSync(configuredPi);
const versionProbe = spawnSync(piExecutable, ["--version"], { encoding: "utf8", env });
assert.equal(versionProbe.status, 0, `Pi version probe failed: ${versionProbe.stderr}`);
assert.equal(versionProbe.stdout.trim(), installedPiVersion(), "CLI must match the installed SDK");

// 让真实 Pi 的 startup scavenging 只看到本次 smoke 自己的 temp base。隔离只用标准 TMPDIR，
// 且只传给子进程：父进程的 env 不动，os.tmpdir() 每次调用都读 TMPDIR，因此 Pi 里 root 的创建和
// 扫描都落在这个 base 上。
const scavengeBase = join(root, "tmp");

/** 拿一个已确认退出（kill(pid,0) 抛 ESRCH）的 PID。 */
function deadPid() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const probe = spawnSync("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    if (!probe.pid) continue;
    try { process.kill(probe.pid, 0); } catch (error) {
      if (error.code === "ESRCH") return probe.pid;
    }
  }
  throw new Error("could not obtain a confirmed dead pid");
}

/** 种一个 owner 已经死掉的合法 root：真实 Pi 删掉它，才证明 TMPDIR 隔离确实生效。 */
function plantDeadRoot() {
  const hostNonce = randomBytes(32).toString("hex");
  const piPid = deadPid();
  const path = join(scavengeBase, `pi-processes-${piPid}-${hostNonce}`);
  mkdirSync(path, { mode: 0o700 });
  mkdirSync(join(path, "records"), { mode: 0o700 });
  writeFileSync(join(path, "supervisor.json"), JSON.stringify({ version: 1, hostNonce, piPid, supervisorPid: deadPid(), generation: 1 }), { mode: 0o600 });
  return path;
}

const plantedRoot = plantDeadRoot();

const child = spawn(piExecutable, ["--mode", "rpc", "--no-session", "--offline", "--approve"], {
  cwd: join(root, "cwd"),
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let buffer = "";
const messages = [];
const waiters = new Map();
const STARTUP_RESPONSE_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    messages.push(message);
    if (message.type === "response" && message.id && waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    }
  }
});

let nextId = 1;
function request(type, extra = {}) {
  const id = `smoke-${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`RPC timeout for ${type}\nstdout=${stdout}\nstderr=${stderr}`));
    }, STARTUP_RESPONSE_TIMEOUT_MS);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
  });
}

const SCAVENGE_TIMEOUT_MS = 15_000;
async function waitForScavenge() {
  const deadline = Date.now() + SCAVENGE_TIMEOUT_MS;
  while (existsSync(plantedRoot)) {
    if (Date.now() >= deadline) throw new Error(`Pi did not scavenge ${plantedRoot}; TMPDIR isolation may not have taken effect\nstderr=${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Pi RPC did not exit after EOF\nstdout=${stdout}\nstderr=${stderr}`));
    }, EXIT_TIMEOUT_MS);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.stdin.end();
  });
}

try {
  const commandsResponse = await request("get_commands");
  assert.equal(commandsResponse.success, true, JSON.stringify(commandsResponse));
  const commands = commandsResponse.data.commands;
  assert.equal(commands.filter((command) => command.name === "ps").length, 1, "expected one /ps command");
  assert.equal(commands.filter((command) => command.name === "skill:pi-processes").length, 1, "expected one V2 skill");
  assert.equal(commands.some((command) => command.name.startsWith("ps:")), false, "legacy /ps:* commands must be absent");

  const stateResponse = await request("get_state");
  assert.equal(stateResponse.success, true, JSON.stringify(stateResponse));
  assert.equal(messages.some((message) => message.type === "extension_error"), false, JSON.stringify(messages));

  await waitForScavenge();

  const exit = await waitForExit();
  assert.equal(exit.code, 0, `Pi RPC exit=${JSON.stringify(exit)} stderr=${stderr}`);
  assert.equal(messages.some((message) => message.type === "extension_error"), false, JSON.stringify(messages));
  console.log(JSON.stringify({ piExecutable, scavengeBase, scavengedRoot: plantedRoot, commands: commands.filter((command) => command.name === "ps" || command.name === "skill:pi-processes"), sessionId: stateResponse.data.sessionId ?? null, exit }, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
