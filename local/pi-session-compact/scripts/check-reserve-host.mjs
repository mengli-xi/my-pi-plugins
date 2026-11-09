import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-reserve-host-")));
const agent = join(root, "agent"), cwd = join(root, "cwd"), home = join(root, "home");
const binary = process.env.PI_COMPACT_HOST_BINARY;
if (!binary) throw new Error("Set PI_COMPACT_HOST_BINARY to an explicit Pi 1.5.0 executable");
const artifacts = process.env.PI_COMPACT_HOST_ARTIFACTS;
const evidence = { binary, realRequests: 0, checks: [] };
let child, stderr = "";
const records = [];
const check = (label, value) => { assert.ok(value, label); evidence.checks.push(label); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = fn(); if (result) return result;
    if (child.exitCode !== null) throw new Error(`${label}: process exited ${child.exitCode}\n${stderr}`);
    await pause(20);
  }
  throw new Error(`${label}: timeout\n${stderr}\n${JSON.stringify(records.slice(-5))}`);
}
try {
  for (const dir of [agent, home, cwd, join(cwd, ".pi"), join(root, "faux")]) mkdirSync(dir, { recursive: true });
  evidence.version = execFileSync(binary, ["--version"], { cwd, env: { ...process.env, HOME: home, PI_NEXT_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" }, encoding: "utf8" }).trim();
  check("Pi 1.5.0 binary", evidence.version === "1.5.0");
  const settingsPath = join(agent, "settings.json"), projectPath = join(cwd, ".pi/settings.json");
  const initial = '{\n  "sentinel": [1,2],\n  "cacheWarming": "off",\n  "compaction": {\n    "enabled": false,\n    "reserveTokens": 111,\n    "keepRecentTokens": 4321,\n    "modelOverrides": {\n      "reserve-faux/match": {"reserveTokens":20000,"keepRecentTokens":456},\n      "reserve-faux/wrong": {"extra":"stay","keepRecentTokens":987,"reserveTokens":21600},\n      "unavailable/model": {"reserveTokens":777}\n    }\n  },\n  "after": true\n}\n';
  const project = JSON.stringify({ compaction: { modelOverrides: { "reserve-faux/wrong": { reserveTokens: 333 } } } });
  writeFileSync(settingsPath, initial); writeFileSync(projectPath, project);
  writeFileSync(join(agent, "auth.json"), "{}");
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "reserve-json": {
    baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "unused-faux-key",
    models: [{ id: "overridden", contextWindow: 64000, maxTokens: 4096 }],
    modelOverrides: { overridden: { contextWindow: 872000 } },
  } } }));
  const fauxModule = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
  const fauxPath = join(root, "faux/index.ts");
  writeFileSync(fauxPath, `import {fauxProvider} from ${JSON.stringify(fauxModule)};
export default function(pi) {
 const f=fauxProvider({provider:"reserve-faux",api:"reserve-faux",models:[{id:"match",contextWindow:200000},{id:"missing",contextWindow:872000},{id:"wrong",contextWindow:1000000}]});
 pi.registerProvider(f.provider);
 pi.on("before_provider_request",()=>{throw new Error("Unexpected model request");});
}`);
  child = spawn(binary, ["--offline", "--no-extensions", "-e", join(pkg, "index.ts"), "-e", fauxPath, "--mode", "rpc", "--no-session", "--provider", "reserve-faux", "--model", "match", "--no-skills", "--no-prompt-templates", "--no-themes"], {
    cwd, env: { ...process.env, HOME: home, PI_NEXT_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "", seq = 0;
  child.stderr.on("data", (chunk) => stderr += chunk);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { records.push(JSON.parse(line)); } catch { stderr += `${line}\n`; }
    }
  });
  const rpc = async (type, params = {}) => {
    const id = `reserve-${++seq}`;
    child.stdin.write(`${JSON.stringify({ type, id, ...params })}\n`);
    const response = await until(() => records.find((r) => r.type === "response" && r.id === id), type);
    assert.equal(response.success, true, JSON.stringify(response)); return response;
  };
  const notifications = (from) => records.slice(from).filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => r.message).join("\n");
  await rpc("get_state");
  let from = records.length;
  await rpc("prompt", { message: "/compaction reserve" });
  const report = await until(() => notifications(from).includes("全局需新增/修改") && notifications(from), "report");
  for (const expected of ["reserve-faux/wrong | 1000000", "reserve-faux/missing | 872000", "reserve-faux/match | 200000", "缺覆盖", "不一致", "一致", "项目级", "全局设置"]) check(`report: ${expected}`, report.includes(expected));
  check("models.json effective window override", report.includes("reserve-json/overridden | 872000"));
  check("read-only report leaves settings bytes unchanged", readFileSync(settingsPath, "utf8") === initial);
  check("read-only report creates no backup", readdirSync(agent).every((name) => !name.includes("before-reserve")));

  async function writeCommand(confirm, mutate) {
    const start = records.length;
    const pending = rpc("prompt", { message: "/compaction reserve write" });
    const request = await until(() => records.slice(start).find((r) => r.type === "extension_ui_request" && r.method === "confirm"), "write confirmation");
    check("confirmation names exact proposed model/token changes", request.message.includes("reserve-faux/wrong") && request.message.includes("100000") && request.message.includes("987"));
    mutate?.();
    child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, confirmed: confirm })}\n`);
    await pending;
    return until(() => notifications(start), "write outcome");
  }
  check("cancel writes nothing", (await writeCommand(false)).includes("已取消") && readFileSync(settingsPath, "utf8") === initial);
  const conflict = await writeCommand(true, () => writeFileSync(settingsPath, initial.replace('"reserveTokens": 111', '"reserveTokens": 222')));
  check("changed compaction after confirmation aborts without backup", conflict.includes("确认期间") && readdirSync(agent).every((name) => !name.includes("before-reserve")));
  writeFileSync(settingsPath, initial);
  let heldLockObserved = false;
  const writeNotice = await writeCommand(true, () => {
    writeFileSync(settingsPath, initial.replace('"after": true', '"after": false'));
    const release = lockfile.lockSync(settingsPath, { realpath: false });
    setTimeout(() => { heldLockObserved = !readFileSync(settingsPath, "utf8").includes('"reserveTokens":100000'); release(); }, 100);
  });
  check("write waits for the same lock used by Pi", heldLockObserved);
  check("successful write prompts restart", writeNotice.includes("新开的 pi 才生效，正在运行的会话要重启"));
  const resultText = readFileSync(settingsPath, "utf8"), result = JSON.parse(resultText);
  check("merge retains unrelated concurrent edit", result.after === false);
  check("correct matching entry unchanged byte-for-byte", resultText.includes('"reserve-faux/match": {"reserveTokens":20000,"keepRecentTokens":456}'));
  check("1M window reserve corrected with existing keepRecent retained", result.compaction.modelOverrides["reserve-faux/wrong"].reserveTokens === 100000 && result.compaction.modelOverrides["reserve-faux/wrong"].keepRecentTokens === 987 && result.compaction.modelOverrides["reserve-faux/wrong"].extra === "stay");
  check("872k missing override uses global keepRecent", result.compaction.modelOverrides["reserve-faux/missing"].reserveTokens === 87200 && result.compaction.modelOverrides["reserve-faux/missing"].keepRecentTokens === 4321);
  check("unavailable model preserved", result.compaction.modelOverrides["unavailable/model"].reserveTokens === 777);
  check("unrelated bytes and top-level key order preserved", resultText.includes('"sentinel": [1,2]') && JSON.stringify(Object.keys(result)) === JSON.stringify(Object.keys(JSON.parse(initial))));
  check("project settings never written", readFileSync(projectPath, "utf8") === project);
  const backups = readdirSync(agent).filter((n) => n.startsWith("settings.json.before-reserve-"));
  check("exactly one backup with exact pre-write bytes", backups.length === 1 && readFileSync(join(agent, backups[0]), "utf8") === initial.replace('"after": true', '"after": false'));
  check("no temp or lock remains", readdirSync(agent).every((n) => !n.endsWith(".lock") && !n.endsWith(".tmp")));
  check("zero extension errors", records.every((r) => r.type !== "extension_error"));
  if (artifacts) { mkdirSync(artifacts, { recursive: true }); writeFileSync(join(artifacts, "reserve-host.json"), JSON.stringify({ ...evidence, report, writeNotice, settings: result, records }, null, 2)); }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.stdin.end();
    for (let i = 0; i < 50 && child.exitCode === null; i++) await pause(20);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  rmSync(root, { recursive: true, force: true });
}
