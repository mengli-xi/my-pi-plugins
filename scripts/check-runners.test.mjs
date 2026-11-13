import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cleanupProcesses } from "./pi-upgrade-check.mjs";
import { installedPiVersion } from "./pi-checks.mjs";
import { integrationEnvironment, runIntegration } from "../integration/run.mjs";
import { integrationScenarios, requiredBuilds, selectScenarios } from "../integration/scenarios.mjs";

const file = name => fileURLToPath(new URL(name, import.meta.url));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runner-unit-"));
  mkdirSync(join(root, "bin"));
  const binary = join(root, "pi");
  writeFileSync(binary, `#!/bin/sh\necho ${installedPiVersion()}\n`, { mode: 0o755 });
  return { root, binary, env: { ...process.env, PI_BIN: binary, PATH: `${join(root, "bin")}:${process.env.PATH}` }, cleanup() { cleanupProcesses([root]); rmSync(root, { recursive: true, force: true }); } };
};

function integrationFixture(root) {
  mkdirSync(join(root, "integration/subagents/real"), { recursive: true });
  writeFileSync(join(root, "ts-resolve.mjs"), "");
  writeFileSync(join(root, "bin/npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(root, "builds")}'\n`, { mode: 0o755 });
}

test("integration 构建由所选场景推导；Goal binary 缺省跟随 PI_BIN", () => {
  const suites = integrationScenarios();
  assert.deepEqual(requiredBuilds(selectScenarios(suites, "ask")), ["pi-claude-style"]);
  assert.deepEqual(requiredBuilds(selectScenarios(suites, "stock-host")), ["pi-subagents"]);
  assert.deepEqual(requiredBuilds(selectScenarios(suites, "patched-host")), ["pi-subagents"]);
  assert.deepEqual(requiredBuilds(selectScenarios(suites, "goal-ui")), ["@narumitw/pi-goal", "pi-claude-style"]);
  assert.deepEqual(requiredBuilds(suites.filter(s => s.id === "side-chat/native")), []);
  const env = integrationEnvironment("/tmp/isolated", "/repo", { PI_BIN: "custom/pi" });
  assert.equal(env.PI_BIN, "/repo/custom/pi");
  assert.equal(env.PI_GOAL_TEST_BINARY, env.PI_BIN);
  assert.equal(integrationEnvironment("/tmp/isolated", "/repo", { PI_BIN: "custom/pi", PI_GOAL_TEST_BINARY: "/other/pi" }).PI_GOAL_TEST_BINARY, "/other/pi");
});

for (const runner of ["host", "host-version", "upgrade", "integration", "integration-build"]) for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${runner} 收到 ${signal} 后清理后代、不启动下一套件`, { timeout: 60_000 }, async t => {
    const f = fixture();
    const ready = join(f.root, "ready"), trace = join(f.root, "trace"), marker = join(f.root, "grandchild"), phase = join(f.root, "startup");
    // spawn 返回不代表后代已运行。用后代自己的 IPC 确认就绪，再断开 IPC，保证它确实能独立存活。
    const worker = `import {spawn} from 'node:child_process';import {writeFileSync,appendFileSync,renameSync} from 'node:fs';
writeFileSync(${JSON.stringify(phase)},'worker entered; spawning detached child');
const p=spawn(process.execPath,['-e',"process.send('READY');setInterval(()=>{},1000)",${JSON.stringify(marker)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});p.unref();
p.once('message',()=>{p.disconnect();writeFileSync(${JSON.stringify(ready + ".tmp")},String(p.pid));renameSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)});});
appendFileSync(${JSON.stringify(trace)},'FIRST\\n');process.stdout.write('TEE_OUT\\n');process.stderr.write('TEE_ERR\\n');
writeFileSync(${JSON.stringify(phase)},'worker entered; waiting for detached child '+p.pid);setInterval(()=>{},1000);`;
    const workerPath = join(f.root, "worker.mjs"); writeFileSync(workerPath, worker);
    let command;
    if (runner.startsWith("host")) {
      if (runner === "host-version") writeFileSync(f.binary, `#!/bin/sh\nexec '${process.execPath}' '${workerPath}'\n`, { mode: 0o755 });
      command = [file("./check-host.mjs"), process.execPath, workerPath, "::", process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(trace)},'SECOND\\n')`];
    } else if (runner === "upgrade") {
      writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "owner", scripts: { "check:upgrade": "runner", "check:upgrade:first": "first", "check:upgrade:second": "second" } }));
      writeFileSync(join(f.root, "bin/npm"), `#!/bin/sh\nif [ "$2" = 'check:upgrade:second' ]; then echo SECOND >> '${trace}'; exit 0; fi\nexec '${process.execPath}' '${workerPath}'\n`, { mode: 0o755 });
      command = [file("./check-upgrade.mjs")];
    } else {
      integrationFixture(f.root);
      if (runner === "integration-build") writeFileSync(join(f.root, "bin/npm"), `#!/bin/sh\nexec '${process.execPath}' '${workerPath}'\n`, { mode: 0o755 });
      writeFileSync(join(f.root, "integration/ask.test.ts"), worker);
      writeFileSync(join(f.root, "integration/fast-statusline.test.ts"), `require('node:fs').appendFileSync(${JSON.stringify(trace)},'SECOND\\n')`);
      const wrapper = join(f.root, "run.mjs");
      writeFileSync(wrapper, `import {runIntegration} from ${JSON.stringify(new URL("../integration/run.mjs", import.meta.url).href)};process.exitCode=await runIntegration('default',${JSON.stringify(f.root)});`);
      command = [wrapper];
    }
    let watcher, timer;
    const started = new Promise((done, reject) => {
      watcher = watch(f.root, () => { if (existsSync(ready)) done(); });
      // fs.watch 是通知，不是启动事实；繁忙环境可能合并/延迟通知，到期再核对已原子发布的 marker。
      timer = setTimeout(() => existsSync(ready) ? done() : reject(new Error(`fixture 未就绪（${existsSync(phase) ? readFileSync(phase, "utf8") : "worker 尚未进入模块"}）：${out}\n${err}`)), 45_000);
    });
    const child = spawn(process.execPath, command, { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    let streamed;
    const live = new Promise(done => { streamed = done; });
    const observe = () => { if (out.includes("TEE_OUT") && err.includes("TEE_ERR")) streamed(); };
    child.stdout.on("data", data => { out += data; observe(); });
    child.stderr.on("data", data => { err += data; observe(); });
    const closed = new Promise(done => child.once("close", (code, exitSignal) => done({ code, exitSignal })));
    t.after(() => { clearTimeout(timer); watcher.close(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); f.cleanup(); });
    await Promise.race([started, closed.then(result => { throw new Error(`fixture 提前退出 ${JSON.stringify(result)}：${out}\n${err}`); })]);
    if (runner === "host") {
      // 两个流必须在套件结束之前到达；完成后再输出不能满足这里。
      await live;
      assert.equal(child.exitCode, null);
      assert.ok(!out.includes("TEE_ERR") && !err.includes("TEE_OUT"));
    }
    assert.equal(child.exitCode, null, out + err);
    assert.equal(child.signalCode, null, out + err);
    assert.doesNotThrow(() => process.kill(Number(readFileSync(ready, "utf8")), 0), "detached 后代必须已就绪且仍存活");
    assert.equal(child.kill(signal), true);
    const result = await closed;
    assert.equal(result.code, 1, out + err);
    assert.equal(result.exitSignal, null);
    assert.equal(readFileSync(trace, "utf8"), "FIRST\n", out + err);
    assert.equal(spawnSync("pgrep", ["-f", marker]).status, 1, "遗留 detached 后代");
    if (runner.startsWith("integration")) {
      const directory = out.match(/日志：(.*)/)[1].trim();
      assert.equal(existsSync(join(directory, "environment")), false);
      assert.ok(existsSync(join(directory, runner === "integration-build" ? "build-pi-claude-style.log" : "ask.test.ts.log")));
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("integration 完成后删除环境、保留日志，只构建所选依赖", { timeout: 30_000 }, async () => {
  const f = fixture(), previous = process.env.PATH;
  const lines = [], log = console.log;
  try {
    integrationFixture(f.root);
    writeFileSync(join(f.root, "integration/ask.test.ts"), "console.log('SCENE_OK')");
    process.env.PATH = f.env.PATH;
    console.log = (...args) => lines.push(args.join(" "));
    assert.equal(await runIntegration("ask", f.root), 0);
    assert.equal(readFileSync(join(f.root, "builds"), "utf8"), "run build -w pi-claude-style\n");
    const directory = lines.find(line => line.startsWith("日志：")).slice(3);
    assert.equal(existsSync(join(directory, "environment")), false);
    assert.match(readFileSync(join(directory, "ask.test.ts.log"), "utf8"), /SCENE_OK/);
    rmSync(directory, { recursive: true, force: true });
  } finally { console.log = log; process.env.PATH = previous; f.cleanup(); }
});

test("tmux 前提由调用者显式声明，与脚本文件名无关", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "bin/tmux"), '#!/bin/sh\necho tmux-unavailable >&2\nexit 1\n', { mode: 0o755 });
    const report = join(f.root, "host.json");
    const result = spawnSync(process.execPath, [file("./check-host.mjs"), "--require=tmux", process.execPath, "-e", "throw Error('must not execute')", "::", process.execPath, "-e", "console.log('SECOND')"], { env: { ...f.env, PI_CHECK_REPORT: report }, encoding: "utf8" });
    assert.equal(result.status, 1);
    const suites = JSON.parse(readFileSync(report, "utf8"));
    assert.deepEqual(suites.map(s => s.status), ["prerequisite", "passed"]);
    assert.match(suites[0].reason, /tmux-unavailable/);
    assert.match(result.stdout, /SECOND/);
  } finally { f.cleanup(); }
});

for (const channel of ["stdout", "stderr"]) test(`tee 的 ${channel} 下游关闭后仍保存日志并正常收尾`, { timeout: 30_000 }, async t => {
  const f = fixture();
  t.after(() => f.cleanup());
  const log = join(f.root, "tee.log"), result = join(f.root, "result.json");
  const code = `import {runCommand} from ${JSON.stringify(new URL("./pi-upgrade-check.mjs", import.meta.url).href)};import {writeFileSync} from 'node:fs';
const r=await runCommand(process.execPath,['-e',\"let n=0;const t=setInterval(()=>{console.log('OUT-'+n);console.error('ERR-'+n);if(++n===8)clearInterval(t)},30)\"],{cwd:process.cwd(),env:process.env,log:${JSON.stringify(log)},tee:true});
writeFileSync(${JSON.stringify(result)},JSON.stringify(r));console.log('FINAL_OUT');console.error('FINAL_ERR');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let other = "", closedPipe = false;
  child[channel].once("data", () => { closedPipe = true; child[channel].destroy(); });
  child[channel === "stdout" ? "stderr" : "stdout"].on("data", data => { other += data; });
  const exit = await new Promise(done => child.once("close", (code, signal) => done({ code, signal })));
  assert.equal(closedPipe, true);
  assert.deepEqual(exit, { code: 0, signal: null }, other);
  assert.equal(JSON.parse(readFileSync(result)).status, "passed");
  assert.match(readFileSync(log, "utf8"), /OUT-7/);
  assert.match(readFileSync(log, "utf8"), /ERR-7/);
});

test("integration 在步骤间收到两次中断仍清理并写报告", { timeout: 30_000 }, async t => {
  const f = fixture(); t.after(() => f.cleanup());
  integrationFixture(f.root);
  const second = join(f.root, "second");
  writeFileSync(join(f.root, "integration/ask.test.ts"), "console.log('FIRST')");
  writeFileSync(join(f.root, "integration/fast-statusline.test.ts"), `require('node:fs').writeFileSync(${JSON.stringify(second)},'unexpected')`);
  const wrapper = join(f.root, "gap.mjs");
  writeFileSync(wrapper, `import assert from 'node:assert/strict';import {runIntegration} from ${JSON.stringify(new URL("../integration/run.mjs", import.meta.url).href)};
const log=console.log;console.log=(...args)=>{if(args[0]?.startsWith('ask.test.ts: passed')){process.emit('SIGINT');assert.ok(process.listenerCount('SIGINT')>0);process.emit('SIGINT');}log(...args)};
process.exitCode=await runIntegration('default',${JSON.stringify(f.root)});`);
  const result = spawnSync(process.execPath, [wrapper], { env: f.env, encoding: "utf8", timeout: 25_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.equal(existsSync(second), false);
  const directory = result.stdout.match(/日志：(.*)/)[1].trim();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = JSON.parse(readFileSync(join(directory, "report.json")));
  assert.equal(report.interrupted, "SIGINT");
  assert.equal(report.passed, false);
  assert.equal(existsSync(join(directory, "environment")), false);
});

test("升级 main 在步骤间收到两次中断仍清理、写报告且不写回", { timeout: 45_000 }, async t => {
  const f = fixture(); t.after(() => f.cleanup());
  execFileSync("git", ["init", "-q", f.root]);
  mkdirSync(join(f.root, "local/owner"), { recursive: true });
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ workspaces: ["local/*"], devDependencies: { "@earendil-works/pi-ai": "1.5.0" } }));
  writeFileSync(join(f.root, "local/owner/package.json"), JSON.stringify({ name: "owner", scripts: { test: "unit" } }));
  writeFileSync(join(f.root, "bun.lock"), "ORIGINAL");
  writeFileSync(join(f.root, "README.md"), "当前验证目标为 **stock Pi 1.5.0**。\n");
  writeFileSync(join(f.root, ".git/info/exclude"), "bin/\ntrace\n");
  execFileSync("git", ["-C", f.root, "add", "."]);
  execFileSync("git", ["-C", f.root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  writeFileSync(join(f.root, "bin/npm"), `#!/bin/sh\nif [ "$1" = view ]; then echo '\"1.5.0\"'; exit 0; fi\necho "$*" >> '${join(f.root, "trace")}'\n`, { mode: 0o755 });
  writeFileSync(join(f.root, "bin/bun"), '#!/bin/sh\nprintf TARGET > bun.lock\n', { mode: 0o755 });
  const wrapper = join(f.root, "bin/gap.mjs");
  writeFileSync(wrapper, `import assert from 'node:assert/strict';import {main} from ${JSON.stringify(new URL("./pi-upgrade-check.mjs", import.meta.url).href)};
const log=console.log;console.log=(...args)=>{if(args[0]?.includes('公开 API 签名')){process.emit('SIGINT');assert.ok(process.listenerCount('SIGINT')>0);process.emit('SIGINT');}log(...args)};
process.exitCode=await main(['1.5.0','--apply']);`);
  const result = spawnSync(process.execPath, [wrapper], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 35_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.equal(existsSync(join(f.root, "trace")), false);
  assert.equal(readFileSync(join(f.root, "bun.lock"), "utf8"), "ORIGINAL");
  const directory = result.stdout.match(/报告：(.*)\/report.json/)[1].trim();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = JSON.parse(readFileSync(join(directory, "report.json")));
  assert.equal(report.interrupted, "SIGINT");
  assert.equal(report.passed, false);
  assert.equal(existsSync(join(directory, "environment")), false);
  assert.equal(existsSync(join(directory, "repository")), false);
});

test("主入口连续收到真实 SIGINT 时保留监听直到清理完成", { timeout: 30_000 }, async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const result = join(f.root, "result.json");
  const code = `import {createInterruptionScope} from ${JSON.stringify(new URL("./pi-upgrade-check.mjs", import.meta.url).href)};import {writeFileSync} from 'node:fs';
const scope=createInterruptionScope();scope.signal.addEventListener('abort',()=>console.log('ABORTED:'+process.listenerCount('SIGINT')));console.log('READY');
await new Promise(resolve=>process.stdin.once('data',resolve));await new Promise(setImmediate);
try{scope.check()}catch(e){writeFileSync(${JSON.stringify(result)},JSON.stringify({interrupted:e.interrupted}));process.exitCode=1}finally{scope.dispose()}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "", first = false, second = false;
  child.stdout.on("data", data => {
    output += data;
    if (!first && output.includes("READY")) { first = true; child.kill("SIGINT"); }
    if (!second && output.includes("ABORTED:1")) { second = true; child.kill("SIGINT"); child.stdin.end("cleanup"); }
  });
  let err = ""; child.stderr.on("data", data => { err += data; });
  const exit = await new Promise(done => child.once("close", (code, signal) => done({ code, signal })));
  assert.equal(second, true, output + err);
  assert.deepEqual(exit, { code: 1, signal: null }, output + err);
  assert.equal(JSON.parse(readFileSync(result)).interrupted, "SIGINT");
});

test("嵌套宿主被外层中断时，临时根归上层 TMPDIR 清理", { timeout: 45_000 }, async t => {
  const f = fixture(); t.after(() => f.cleanup());
  integrationFixture(f.root);
  const hostRootFile = join(f.root, "host-root"), parentTmpFile = join(f.root, "parent-tmp"), runtimeFile = join(f.root, "runtime-root");
  const hostWorker = join(f.root, "host-worker.mjs");
  writeFileSync(hostWorker, `import {writeFileSync} from 'node:fs';import {dirname} from 'node:path';writeFileSync(${JSON.stringify(hostRootFile)},dirname(process.env.HOME));writeFileSync(${JSON.stringify(runtimeFile)},process.env.XDG_RUNTIME_DIR);writeFileSync(process.env.XDG_RUNTIME_DIR+"/runtime-probe","owned");console.log('HOST_READY');setInterval(()=>{},1000);`);
  writeFileSync(join(f.root, "integration/ask.test.ts"), `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(parentTmpFile)},process.env.TMPDIR);const c=spawn(process.execPath,[${JSON.stringify(file("./check-host.mjs"))},process.execPath,${JSON.stringify(hostWorker)}],{env:process.env,stdio:'inherit'});await new Promise(r=>c.on('close',r));`);
  const wrapper = join(f.root, "nested.mjs");
  writeFileSync(wrapper, `import {runIntegration} from ${JSON.stringify(new URL("../integration/run.mjs", import.meta.url).href)};process.exitCode=await runIntegration('ask',${JSON.stringify(f.root)});`);
  const child = spawn(process.execPath, [wrapper], { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); if (existsSync(hostRootFile)) rmSync(readFileSync(hostRootFile, "utf8"), { recursive: true, force: true }); });
  let out = "", err = "", interrupted = false;
  child.stdout.on("data", data => { out += data; if (!interrupted && out.includes("HOST_READY")) { interrupted = true; child.kill("SIGINT"); } });
  child.stderr.on("data", data => { err += data; });
  const exit = await new Promise(done => child.once("close", (code, signal) => done({ code, signal })));
  assert.deepEqual(exit, { code: 1, signal: null }, out + err);
  const hostRoot = readFileSync(hostRootFile, "utf8"), parentTmp = readFileSync(parentTmpFile, "utf8");
  assert.ok(hostRoot.startsWith(parentTmp + "/"), hostRoot + " not within " + parentTmp);
  assert.equal(existsSync(hostRoot), false);
  const runtimeRoot = readFileSync(runtimeFile, "utf8");
  assert.equal(existsSync(join(runtimeRoot, "runtime-probe")), false, "outer interruption also removes the shared runtime artifacts");
  const directory = out.match(/日志：(.*)/)[1].trim();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(JSON.parse(readFileSync(join(directory, "report.json"))).interrupted, "SIGINT");
});
