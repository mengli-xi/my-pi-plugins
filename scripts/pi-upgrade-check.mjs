#!/usr/bin/env node
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkEnvironment, discoverChecks, isPiDependency, workspacePackages } from "./pi-checks.mjs";
import { integrationScenarios } from "../integration/scenarios.mjs";

export function parseArgs(args) {
  const options = { keep: false, apply: false, quick: false };
  for (const arg of args) {
    if (arg === "--keep" || arg === "--apply" || arg === "--quick") {
      const key = arg.slice(2);
      if (options[key]) throw new Error(`重复参数：${arg}`);
      options[key] = true;
    } else if (!options.version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(arg)) {
      options.version = arg;
    } else throw new Error(`无效参数：${arg}`);
  }
  if (!options.version) throw new Error("用法：node scripts/pi-upgrade-check.mjs <目标版本> [--quick] [--keep] [--apply]");
  return options;
}

// 快速档只允许同一稳定 major/minor 的补丁升级（含当前版本自检）。
export function validateQuick(version, from) {
  const target = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!target || from.some(value => {
    const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return !current || current[1] !== target[1] || current[2] !== target[2] || Number(current[3]) > Number(target[3]);
  })) throw new Error("--quick 只用于同一稳定 major/minor 的补丁升级；次版本、主版本、预发布和降级必须完整验收。");
}

export function supportedPiVersion(readme) {
  const versions = [...readme.matchAll(/^当前验证目标为 \*\*stock Pi ([^*\s]+)\*\*/gm)];
  if (versions.length !== 1) throw new Error("README 必须有唯一的 stock Pi 支持版本声明");
  return versions[0][1];
}

export function updateSupportedVersion(readme, version) {
  supportedPiVersion(readme);
  return readme.replace(/^(当前验证目标为 \*\*stock Pi )[^*\s]+(\*\*)/m, (_match, prefix, suffix) => `${prefix}${version}${suffix}`);
}

// 根开发依赖是精确 pin，公开 peer 范围不随升级改写。
export function updatePiVersions(manifest, version) {
  const updated = structuredClone(manifest);
  for (const name of Object.keys(updated.devDependencies ?? {})) {
    if (isPiDependency(name)) updated.devDependencies[name] = version;
  }
  return { manifest: updated };
}

export function peerCoverage(packages, version, env = process.env) {
  const peers = packages.flatMap(pkg => Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => isPiDependency(name))
    .map(([name, range]) => ({ package: pkg.name, directory: pkg.directory, name, range })));
  if (!peers.length) return [];
  // Bun 是已有安装/构建前提；使用内置 semver，不添加依赖或手写范围解析器。
  const result = spawnSync("bun", ["-e", "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(p => Bun.semver.satisfies(process.argv[2], p.range))))", JSON.stringify(peers), version], { env, encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`peer 范围检查失败：${result.stderr}`);
  const covered = JSON.parse(result.stdout);
  return peers.map((peer, index) => ({ ...peer, covered: covered[index] }));
}

export function upgradeSuites(packages) {
  return packages.filter(pkg => Object.hasOwn(pkg.scripts ?? {}, "check:upgrade")).flatMap(pkg =>
    Object.keys(pkg.scripts).filter(name => name.startsWith("check:upgrade:")).map(item => ({
      package: pkg.name, directory: pkg.directory, item, timeoutMs: 300_000, requires: item.endsWith(":ui") ? ["pty"] : [],
    })));
}

// 证据分类不代表豁免；单个套件可能同时有真实失败和环境错误。
export function failureKinds(output, { timedOut = false, error } = {}) {
  const kinds = [];
  if (timedOut || /(?:^|\n).*?(?:timed out|timeout:|RPC timeout|ETIMEDOUT)/i.test(output)) kinds.push("timeout");
  if (error?.code === "ENOENT" || /spawnSync (?:\S*\/)?(?:ps|sandbox-exec) EPERM|EPERM[^\n]*posix_spawn ['"](?:ps|sandbox-exec)['"]|(?:EPERM|Operation not permitted).*(?:link|sandbox)|(?:link|sandbox-exec).*?(?:EPERM|Operation not permitted)/i.test(output)) kinds.push("environment");
  if (!kinds.length || /AssertionError|error TS\d+|^SNAPSHOT/m.test(output)) kinds.push("failure");
  return kinds;
}

// 原始日志始终保留；摘要提取 npm workspace、TS 位置及失败用例，不替代报错。
export function diagnostics(output, defaultPackage = "仓库") {
  let current = defaultPackage;
  const failures = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const header = line.match(/^> (\S+)@\S+ (?:typecheck|test)(?:\s|$)/);
    if (header) current = header[1];
    const workspace = line.match(/npm error workspace (\S+)/);
    const location = line.match(/(?:local|fork)\/([^/]+)\/.*error TS/);
    if (workspace || location || /error TS\d+|^\s*not ok\b|^\s*✖ (?!failing tests:)|^\s*FAIL\b|^SNAPSHOT\b|^失败：/.test(line)) {
      failures.push({ package: workspace?.[1] ?? location?.[1] ?? current, item: line.trim().replace(/\s+\([\d.]+ms\)$/, "") });
    }
  }
  return failures.filter((failure, index) => failures.findIndex(other => other.package === failure.package && other.item === failure.item) === index);
}

export function renderReport(report) {
  const labels = { passed: "通过", failed: "失败", skipped: "未运行", prerequisite: "前提不满足" };
  const kinds = { failure: "真实失败", environment: "环境限制（仍阻断）", timeout: "超时（仍阻断）" };
  const lines = [`Pi 升级检查：${report.from.join("、")} → ${report.target}（${report.mode === "quick" ? "快速档" : "完整档"}）`, `临时目录：${report.directory}`];
  for (const step of report.steps) {
    lines.push(`${labels[step.status]} · ${step.package} · ${step.stage} · ${step.item}${step.durationMs === undefined ? "" : ` · ${(step.durationMs / 1000).toFixed(1)}s`}`);
    if (step.kinds?.length) lines.push(`  类别：${step.kinds.map(kind => kinds[kind]).join("、")}`);
    if (step.reason) lines.push(`  ${step.reason}`);
    for (const failure of step.failures ?? []) lines.push(`  ${failure.package}：${failure.item}`);
    for (const suite of step.suites ?? []) {
      lines.push(`  ${labels[suite.status]} · ${suite.item} · ${(suite.durationMs / 1000).toFixed(1)}s${suite.kinds?.length ? ` · ${suite.kinds.map(kind => kinds[kind]).join("、")}` : ""}`);
      if (suite.reason) lines.push(`    ${suite.reason}`);
      if (suite.log) lines.push(`    原始日志：${suite.log}`);
    }
    if (step.log) lines.push(`  原始日志：${step.log}`);
  }
  if (report.interrupted) lines.push(`中断：${report.interrupted}`);
  if (report.durationMs !== undefined) lines.push(`总耗时：${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push("", ...report.notices);
  if (report.peers?.length) lines.push(`peer 范围：${report.peers.filter(peer => peer.covered).length}/${report.peers.length} 覆盖目标（含 fork）；未覆盖项阻断应用。`);
  if (report.manual?.length) {
    lines.push("", "未自动改写、需人工处理：");
    for (const item of report.manual) lines.push(`  ${item.package} · ${item.name} · ${item.range}：${item.reason}`);
  }
  lines.push("", `报告：${join(report.directory, "report.json")}`);
  return lines.join("\n");
}

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

async function saveManifest(path, manifest) {
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
}

// 只探测所需能力；缺前提明确阻断，不假装 suite 已通过。
export function probePrerequisites(requirements, { cwd, env }) {
  for (const requirement of requirements) {
    const command = requirement === "tmux" ? ["tmux", "-V"] : ["bun", "-e", "const p=Bun.spawn({cmd:['/bin/sh','-c','exit 0'],terminal:{cols:80,rows:24,data(){}}});await p.exited;p.terminal.close();"];
    const result = spawnSync(command[0], command.slice(1), { cwd, env, encoding: "utf8", timeout: 15_000 });
    if (result.error || result.status !== 0) return `${requirement} 前提不满足：${result.error?.message ?? result.stderr}`;
  }
}

// 回收已脱离原进程组、但 argv 仍携带本次独占路径的宿主/helper。
// 不用 ps，也不匹配日常 Pi 的通用进程名。
export function cleanupProcesses(paths) {
  if (!paths.length) return;
  const pattern = paths.map(path => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status === 1) return;
  if (result.status !== 0) throw new Error(`pgrep 清理失败：${result.stderr}`);
  for (const text of result.stdout.trim().split("\n")) {
    const pid = Number(text);
    if (!pid || pid === process.pid || pid === process.ppid) continue;
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

// 超时/中断时先收集仍在运行的后代，再杀根进程组，覆盖嵌套 runner 自建的组。
function descendantPids(pid) {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`pgrep 后代失败：${result.stderr}`);
  return result.stdout.trim().split("\n").map(Number).flatMap(child => [...descendantPids(child), child]);
}

// 标准输出属于整个验收进程；关闭下游只停止显示，日志照常保存。
const brokenOutputs = new Set();
for (const output of [process.stdout, process.stderr]) {
  output.on("error", error => {
    if (error.code !== "EPIPE") throw error;
    brokenOutputs.add(output);
  });
}

// 主入口持有监听直到清理和报告完成；重复信号不会恢复默认退出行为。
export function createInterruptionScope() {
  const controller = new AbortController();
  const listeners = ["SIGINT", "SIGTERM", "SIGALRM"].map(name => [name, () => {
    if (!controller.signal.aborted) controller.abort(name);
  }]);
  for (const [name, listener] of listeners) process.on(name, listener);
  return {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted) throw Object.assign(new Error(`收到 ${controller.signal.reason}`), { interrupted: controller.signal.reason });
    },
    dispose() { for (const [name, listener] of listeners) process.removeListener(name, listener); },
  };
}

// 独立子命令自持监听；主验收传入同一个 signal，覆盖命令之间的空隙。
export async function runCommand(command, args, { cwd, env, log, timeoutMs = 1_800_000, cleanupPaths = [], tee = false, signal }) {
  const ownedScope = signal ? null : createInterruptionScope();
  signal ??= ownedScope.signal;
  try {
    if (signal.aborted) throw Object.assign(new Error(`收到 ${signal.reason}`), { interrupted: signal.reason });
    const start = Date.now();
    const stream = createWriteStream(log);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stdout = "", reason, cleanupError, timedOut = false;
    const record = data => { stream.write(data); output += data; };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", data => { stdout += data; record(data); if (tee && !brokenOutputs.has(process.stdout)) process.stdout.write(data); });
    child.stderr.on("data", data => { record(data); if (tee && !brokenOutputs.has(process.stderr)) process.stderr.write(data); });
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const cleanup = () => {
      try { cleanupProcesses(cleanupPaths); }
      catch (value) { cleanupError = value; record(`清理失败：${value}\n`); }
    };
    const stop = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          for (const pid of descendantPids(child.pid)) {
            try { process.kill(pid, "SIGKILL"); }
            catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        } catch (value) { cleanupError = value; record(`后代清理失败：${value}\n`); }
      }
      kill(); cleanup();
    };
    const onAbort = () => { reason = `收到 ${signal.reason}`; stop(); };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; reason = `超过 ${timeoutMs / 1000}s 时限`; stop(); }, timeoutMs);
    child.once("exit", stop);
    let error;
    child.once("error", value => { error = value; record(String(value) + "\n"); });
    const exit = await new Promise(done => child.once("close", (code, exitSignal) => done({ code, signal: exitSignal })));
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    cleanup();
    if (reason) record(reason + "\n");
    await new Promise((done, reject) => { stream.once("error", reject); stream.end(done); });
    const interrupted = signal.aborted ? signal.reason : null;
    const passed = !error && !reason && !cleanupError && !interrupted && exit.code === 0;
    return { status: passed ? "passed" : "failed", ...exit, log, interrupted, reason: reason ?? (interrupted ? `收到 ${interrupted}` : error?.message ?? cleanupError?.message), durationMs: Date.now() - start, timeoutMs,
      kinds: passed ? [] : failureKinds(output, { timedOut: timedOut || interrupted === "SIGALRM", error }), output, stdout };
  } finally { ownedScope?.dispose(); }
}

export async function main(args) {
  const interruption = createInterruptionScope();
  try { return await upgradeCheck(args, interruption); }
  finally { interruption.dispose(); }
}

async function upgradeCheck(args, interruption) {
  const started = Date.now();
  const options = parseArgs(args);
  const source = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (git(source, "status", "--porcelain")) throw new Error("请先提交或收起当前改动；检查只 clone 当前已提交快照。");
  const head = git(source, "rev-parse", "HEAD");
  const manifest = JSON.parse(git(source, "show", `${head}:package.json`));
  const dependencies = Object.keys(manifest.devDependencies ?? {}).filter(isPiDependency);
  if (!dependencies.length) throw new Error("根 devDependencies 没有 Pi 依赖");
  if (options.quick) validateQuick(options.version, dependencies.map(name => manifest.devDependencies[name]));
  // 避免 macOS 长 TMPDIR 影响 Unix socket，以及终端测试中的路径截断。
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-upgrade-"));
  const checkout = join(directory, "repository"), environment = join(directory, "environment");
  for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) await mkdir(join(environment, name), { recursive: true });
  const env = checkEnvironment(environment);
  const report = {
    target: options.version, mode: options.quick ? "quick" : "full", from: [...new Set(dependencies.map(name => manifest.devDependencies[name]))],
    source, commit: head, directory, steps: [], peers: [], manual: [], notices: [
      "未覆盖：真实 provider、人工终端与输入法、没有探针的私有行为。",
      "补丁宿主检查不纳入原版升级门禁；test:patched-host 与补丁联测须用匹配的真实构建另跑。",
      "可选补丁只适用于其固定上游；stock 升级不要求重新 pin 或构建。原版 child 主题热更新沿用降级逻辑。",
      options.keep ? "保留临时副本及日志。" : "结束后删除临时副本，保留报告与原始日志；需要保留副本请加 --keep。",
    ],
  };
  const packages = workspacePackages(source);
  if (options.quick) report.notices.push("快速档：全部包单测、internals 与 check:smoke；未运行完整 host、check:upgrade:* 和根 integration 矩阵，不代表完整兼容验收。");
  const checks = discoverChecks(source, { quick: options.quick });
  const testPackages = packages.filter(pkg => Object.hasOwn(pkg.scripts ?? {}, "test"));
  const extras = options.quick ? [] : upgradeSuites(packages);
  const scenarios = !options.quick && manifest.scripts?.["test:integration"] ? integrationScenarios(source).filter(suite => suite.stock !== false) : [];
  const builds = packages.filter(pkg => pkg.scripts?.build);
  const failedBuilds = new Set();
  const step = async (stage, pkg, item, command, commandArgs, cwd = checkout, extraEnv = {}, timeoutMs = 300_000, requires = []) => {
    interruption.check();
    const log = join(directory, `${String(report.steps.length + 1).padStart(2, "0")}-${stage.replace(/[^\w\u3400-\u9fff-]/g, "-")}.log`);
    console.log(`检查：${pkg} · ${stage} · ${item}`);
    const childEnv = { ...env, ...extraEnv };
    const buildMissing = stage !== "构建" && stage !== "公开 API 签名" && (failedBuilds.has(pkg) || stage === "integration" && failedBuilds.size > 0);
    const reason = buildMissing ? `所需构建失败：${[...failedBuilds].join("、")}` : probePrerequisites(requires, { cwd, env: childEnv });
    if (reason) {
      const entry = { stage, package: pkg, item, status: "prerequisite", reason, durationMs: 0, timeoutMs };
      report.steps.push(entry);
      return entry;
    }
    const detail = join(directory, `host-${report.steps.length + 1}.json`);
    if (item === "check:host" || item === "check:smoke") childEnv.PI_CHECK_REPORT = detail;
    const { output, stdout, ...result } = await runCommand(command, commandArgs, { cwd, env: childEnv, log, timeoutMs, signal: interruption.signal, cleanupPaths: stage === "版本存在性" || stage === "临时副本" ? [] : [checkout, environment] });
    const entry = { stage, package: pkg, item, ...result, log, failures: result.status === "failed" ? diagnostics(output, pkg) : [] };
    if (result.status === "failed" && !entry.failures.length) entry.failures.push({ package: pkg, item: output.trim().slice(-4000) || result.reason || `退出码 ${result.code}，信号 ${result.signal}` });
    if (item === "check:host" || item === "check:smoke") {
      try { entry.suites = JSON.parse(await readFile(detail, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (entry.suites?.length) {
      if (entry.suites.some(suite => suite.status === "prerequisite") && entry.suites.every(suite => suite.status !== "failed")) entry.status = "prerequisite";
      if (entry.status !== "passed") entry.kinds = [...new Set(entry.suites.flatMap(suite => suite.kinds ?? []))];
    }
    report.steps.push(entry);
    interruption.check();
    return { ...entry, output, stdout };
  };
  const skipped = (stage, pkg, item, reason) => report.steps.push({ stage, package: pkg, item, status: "skipped", reason });
  // 未运行项也逐条列出，便于一眼看出哪个包、哪一步没有结果。
  const skipApply = reason => { if (options.apply) skipped("应用", "仓库", "--apply", reason); };
  const skipGatesAndChecks = reason => {
    skipped("公开 API 签名", "仓库", "typecheck", reason);
    for (const pkg of testPackages) skipped("公开 API 行为", pkg.name, "test", reason);
    for (const pkg of builds) skipped("构建", pkg.name, "build", reason);
    for (const suite of scenarios) skipped("integration", "仓库", suite.id, reason);
    for (const suite of extras) skipped("扩展验收", suite.package, suite.item, reason);
    for (const check of checks) skipped("私有 seam", check.package, check.check, reason);
    skipApply("有失败或未运行项，不修改当前工作区。");
  };
  try {
    interruption.check();
    report.peers = peerCoverage(packages, options.version, env);
    for (const peer of report.peers.filter(peer => !peer.covered)) report.manual.push({ ...peer, reason: "peer 不覆盖目标，需维护者确认最低 API；fork 修改须记录 LOCAL_PATCHES.md" });
    // 显式校验每个根 Pi devDep 的精确版本；失败时从未调用安装。
    let published = true;
    for (const name of dependencies) {
      const result = await step("版本存在性", name, options.version, "npm", ["view", `${name}@${options.version}`, "version", "--json", "--fetch-retries=0", "--fetch-timeout=60000"], source);
      if (result.status !== "passed") published = false;
      else {
        let version;
        try { version = JSON.parse(result.stdout); } catch { /* 下方报告无效 registry 响应。 */ }
        if (version !== options.version) {
          const entry = report.steps.at(-1);
          entry.status = "failed";
          entry.reason = `registry 没有返回精确目标版本 ${options.version}：${result.stdout.trim()}`;
          published = false;
        }
      }
    }
    if (!published) {
      skipped("临时副本", "仓库", "clone", "目标版本不存在或 registry 不可达，未创建临时副本。");
      skipped("安装", "仓库", "bun install", "目标版本不存在，未安装任何目标依赖。");
      skipGatesAndChecks("目标版本不存在或 registry 不可达，未运行。");
    } else {
      const cloned = await step("临时副本", "仓库", "clone", "git", ["clone", "--no-hardlinks", "--no-local", "--quiet", source, checkout], source);
      if (cloned.status !== "passed") {
        skipped("安装", "仓库", "bun install", "临时副本 clone 失败，未运行。");
        skipGatesAndChecks("临时副本 clone 失败，未运行。");
      } else {
        git(checkout, "checkout", "--quiet", "--detach", head);
        await saveManifest(join(checkout, "package.json"), updatePiVersions(manifest, options.version).manifest);
        const installed = await step("安装", "仓库", "bun install", "bun", ["install", "--ignore-scripts"], checkout, {}, 600_000);
        if (installed.status !== "passed") {
          skipGatesAndChecks("目标依赖安装失败。");
        } else {
          Object.assign(env, {
            PI_BIN: join(checkout, "node_modules/.bin/pi"),
            PI_GOAL_TEST_BINARY: join(checkout, "node_modules/.bin/pi"),
            PI_PROCESSES_TEST_PI: join(checkout, "node_modules/.bin/pi"),
            PI_GOAL_TEST_CC_ENTRY: join(checkout, "local/pi-claude-style/dist/index.ts"),
            PI_PROCESSES_TEST_GOAL_ENTRY: join(checkout, "fork/pi-goal/dist/index.js"),
          });
          for (const pkg of builds) {
            const result = await step("构建", pkg.name, "build", "npm", ["run", "build", "-w", pkg.name]);
            if (result.status !== "passed") failedBuilds.add(pkg.name);
          }
          env.PI_CHECK_PREBUILT = JSON.stringify(builds.map(pkg => pkg.name));
          await step("公开 API 签名", "仓库", "typecheck", "npm", ["run", "typecheck"]);
          for (const pkg of testPackages) await step("公开 API 行为", pkg.name, "test", "npm", ["run", "test", "-w", pkg.name]);
          if (!options.quick && !scenarios.length) await step("公开 API 行为", "仓库", "test:integration", "npm", ["run", "test:integration"]);
          for (const check of checks) {
            await step("私有 seam", check.package, check.check, "npm", ["run", check.check], join(checkout, check.directory), {}, 1_800_000);
          }
          for (const suite of extras) {
            await step("扩展验收", suite.package, suite.item, "npm", ["run", suite.item], join(checkout, suite.directory), {}, suite.timeoutMs, suite.requires);
          }
          for (const suite of scenarios) {
            const command = suite.command.map(arg => arg.replaceAll(source, checkout).replace("$TMPDIR", env.TMPDIR));
            const extraEnv = Object.fromEntries(Object.entries(suite.env ?? {}).map(([key, value]) => [key, value.replaceAll(source, checkout)]));
            await step("integration", "仓库", suite.id, command[0], command.slice(1), join(checkout, suite.cwd ?? ""), extraEnv, suite.timeoutMs, suite.requires ?? []);
          }
          interruption.check();
          if (options.apply) {
            if (report.steps.every(entry => entry.status === "passed") && report.peers.every(peer => peer.covered)) {
              const files = ["package.json", "bun.lock", "README.md"];
              const readme = join(checkout, "README.md");
              await writeFile(readme, updateSupportedVersion(await readFile(readme, "utf8"), options.version));
              const lock = await step("应用准备", "仓库", "更新 bun.lock", "bun", ["install", "--lockfile-only", "--ignore-scripts"]);
              if (lock.status === "passed") {
                if (git(source, "rev-parse", "HEAD") !== head || git(source, "status", "--porcelain")) throw new Error("检查期间当前工作区或 HEAD 已变，拒绝 --apply");
                // 不在当前工作区安装；只复制临时副本中已生成的 manifests 与 lock。
                const originals = await Promise.all(files.map(file => readFile(join(source, file))));
                try {
                  for (const file of files) {
                    interruption.check();
                    await copyFile(join(checkout, file), join(source, file));
                  }
                  interruption.check();
                } catch (error) {
                  await Promise.all(files.map((file, index) => writeFile(join(source, file), originals[index])));
                  throw error;
                }
                report.steps.push({ stage: "应用", package: "仓库", item: "根 devDeps、bun.lock、README 支持版本", status: "passed" });
                report.applied = true;
              }
            } else skipApply("有失败或未运行项，不修改当前工作区。");
          }
        }
      }
    }
  } catch (error) {
    report.steps.push({ stage: "流程", package: "仓库", item: "异常", status: error.code === "ENOENT" ? "prerequisite" : "failed", interrupted: error.interrupted, kinds: failureKinds(String(error), { error, timedOut: error.interrupted === "SIGALRM" }), reason: String(error.stack ?? error) });
  } finally {
    if (!options.keep) {
      try {
        await Promise.all([checkout, environment].map(path => rm(path, { recursive: true, force: true })));
      } catch (error) {
        report.steps.push({ stage: "清理", package: "仓库", item: "临时副本与隔离环境", status: "failed", reason: String(error) });
      }
    }
    report.durationMs = Date.now() - started;
    report.interrupted = interruption.signal.aborted ? interruption.signal.reason : null;
    report.passed = !report.interrupted && report.peers.every(peer => peer.covered) && report.steps.length > 0 && report.steps.every(entry => entry.status === "passed");
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    if (interruption.signal.aborted && !report.interrupted) {
      report.interrupted = interruption.signal.reason;
      report.passed = false;
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
    console.log("\n" + renderReport(report));
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
