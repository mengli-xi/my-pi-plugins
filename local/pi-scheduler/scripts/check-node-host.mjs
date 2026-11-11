import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ping, request } from "../src/client.ts";
import { schedulerPaths } from "../src/paths.ts";

const binary = process.env.PI_BIN;
const cli = binary && realpathSync(binary);
if (!cli) throw new Error("PI_BIN is required; use npm run check:host");
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.env.SCHEDULER_NODE_HOST_ARTIFACT_DIR;
const root = artifacts ? resolve(artifacts) : mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "scheduler-node-host-"));
assert.ok(!artifacts || !existsSync(root) || readdirSync(root).length === 0, "Artifact directory must be empty");
const home = join(root, "home"), agent = join(root, "agent"), cwd = join(root, "cwd"), bin = join(root, "bin");
for (const dir of [home, agent, cwd, bin]) mkdirSync(dir, { recursive: true });
// Exercise real direct autostart without ever invoking a user's service manager.
for (const name of ["launchctl", "systemctl"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
symlinkSync(process.execPath, join(bin, "node"));
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(root, "config") };
delete env.PI_SCHEDULER_BINARY;
delete env.PI_PACKAGE_DIR;
const paths = schedulerPaths(agent), parentEvidence = join(root, "parent.json"), childEvidence = join(root, "execution.json");
const fixture = join(root, "faux.ts");
const fauxUrl = pathToFileURL(join(pkg, "../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href;
writeFileSync(fixture, `import {writeFileSync} from "node:fs";
import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(fauxUrl)};
export default function(pi) {
 const f=fauxProvider({provider:"scheduler-node-faux",api:"scheduler-node-faux",models:[{id:"task",contextWindow:200000,maxTokens:4096}],tokensPerSecond:10000000});
 f.setResponses([()=>{writeFileSync(${JSON.stringify(childEvidence)},JSON.stringify({piBinary:process.env.PI_SCHEDULER_BINARY,execPath:process.execPath,argv:process.argv,providerCalls:f.state.callCount}));return fauxAssistantMessage("NODE_SCHEDULE_OK");}]);
 pi.registerProvider(f.provider);
 pi.on("session_start",()=>{if(!process.env.PI_SCHEDULER_BINARY)writeFileSync(${JSON.stringify(parentEvidence)},JSON.stringify({execPath:process.execPath,argv:process.argv,hasOverride:false}));});
}`);
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [fixture, "-builtin:mcp"], cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
writeFileSync(join(agent, "auth.json"), "{}");
let host, daemonPid, stdout = "", stderr = "";
async function until(get, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await get();
    if (value) return value;
    if (host && host.exitCode !== null) throw new Error(`${label}: host exited ${host.exitCode}\n${stderr}`);
    await delay(25);
  }
  throw new Error(`${label}: timeout\n${stderr}`);
}
try {
  const version = execFileSync(process.execPath, [resolve(cli), "--version"], { cwd, env, encoding: "utf8" }).trim();
  assert.equal(version, "1.5.0", "official CLI runs on Node 1.5.0");
  host = spawn(process.execPath, [resolve(cli), "--offline", "--no-extensions", "-e", join(pkg, "index.ts"), "-e", fixture,
    "--mode", "rpc", "--no-session", "--provider", "scheduler-node-faux", "--model", "task", "--thinking", "off", "--no-skills", "--no-prompt-templates", "--no-themes"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  host.stdout.on("data", data => stdout += data); host.stderr.on("data", data => stderr += data);
  await until(() => ping(paths.socket), "default autostart");
  daemonPid = Number(readFileSync(paths.lock, "utf8").trim().split(" ")[0]);
  assert.ok(Number.isSafeInteger(daemonPid) && daemonPid > 0);
  await until(() => existsSync(parentEvidence), "parent identity");
  const parent = JSON.parse(readFileSync(parentEvidence, "utf8"));
  assert.equal(realpathSync(parent.execPath), realpathSync(process.execPath));
  assert.equal(parent.hasOverride, false);
  const id = "node-entry-faux";
  const created = await request({ type: "task.create", task: { id, title: id, prompt: "Return NODE_SCHEDULE_OK using only the local faux provider.",
    schedule: { kind: "once", at: Date.now() }, timeZone: "UTC", toleranceMs: 60000, status: "active", createdAt: Date.now(), origin: "user",
    target: { kind: "agent", cwd, provider: "scheduler-node-faux", model: "task", thinking: "off" } } }, { socketPath: paths.socket });
  assert.equal(created.ok, true, JSON.stringify(created));
  await until(() => existsSync(childEvidence), "real scheduled Node CLI request");
  const runs = await until(async () => {
    const response = await request({ type: "task.runs", id }, { socketPath: paths.socket });
    return response.ok && response.type === "runs" && response.runs.length ? response.runs : undefined;
  }, "scheduled run record");
  assert.equal(runs.length, 1); assert.equal(runs[0].outcome, "success", JSON.stringify(runs));
  const execution = JSON.parse(readFileSync(childEvidence, "utf8"));
  assert.ok(execution.piBinary && execution.piBinary !== execution.execPath, "daemon receives Pi CLI, not Node");
  assert.equal(realpathSync(execution.piBinary), realpathSync(cli));
  assert.equal(execFileSync(execution.piBinary, ["--version"], { cwd, env, encoding: "utf8" }).trim(), "1.5.0");
  assert.equal(execution.providerCalls, 1);
  const evidence = { version, realRequests: 0, fauxRequests: 1, defaultAutostart: true, parent, execution, runs };
  writeFileSync(join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (host?.exitCode === null) {
    const exited = new Promise(resolve => host.once("exit", resolve));
    host.stdin.end();
    const timer = setTimeout(() => host.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
  }
  // The PID comes only from this test's isolated daemon lock, never a daily store.
  if (!daemonPid && existsSync(paths.lock)) daemonPid = Number(readFileSync(paths.lock, "utf8").trim().split(" ")[0]);
  if (Number.isSafeInteger(daemonPid) && daemonPid > 0) {
    try { process.kill(daemonPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    for (let i = 0; i < 200 && existsSync(paths.socket); i++) await delay(25);
  }
  if (artifacts) { writeFileSync(join(root, "rpc.jsonl"), stdout); writeFileSync(join(root, "stderr.log"), stderr); }
  else rmSync(root, { recursive: true, force: true });
}
