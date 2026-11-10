#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkEnvironment, discoverChecks, isPiDependency, readJson, workspacePackages } from "./pi-checks.mjs";

export function parseArgs(args) {
  const options = { keep: false, apply: false };
  for (const arg of args) {
    if (arg === "--keep" || arg === "--apply") {
      const key = arg.slice(2);
      if (options[key]) throw new Error(`重复参数：${arg}`);
      options[key] = true;
    } else if (!options.version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(arg)) {
      options.version = arg;
    } else throw new Error(`无效参数：${arg}`);
  }
  if (!options.version) throw new Error("用法：node scripts/pi-upgrade-check.mjs <目标版本> [--keep] [--apply]");
  return options;
}

export function updatePiVersions(manifest, version, { peers = false } = {}) {
  const updated = structuredClone(manifest);
  for (const field of peers ? ["peerDependencies"] : ["devDependencies"]) {
    for (const [name, range] of Object.entries(updated[field] ?? {})) {
      if (isPiDependency(name)) updated[field][name] = peers && /^[~^]/.test(range) ? range[0] + version : version;
    }
  }
  return updated;
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
  const labels = { passed: "通过", failed: "失败", skipped: "未运行" };
  const lines = [`Pi 升级检查：${report.from.join("、")} → ${report.target}`, `临时目录：${report.directory}`];
  for (const step of report.steps) {
    lines.push(`${labels[step.status]} · ${step.package} · ${step.stage} · ${step.item}${step.durationMs === undefined ? "" : ` · ${(step.durationMs / 1000).toFixed(1)}s`}`);
    if (step.reason) lines.push(`  ${step.reason}`);
    for (const failure of step.failures ?? []) lines.push(`  ${failure.package}：${failure.item}`);
    if (step.log) lines.push(`  原始日志：${step.log}`);
  }
  lines.push("", ...report.notices, "", `报告：${join(report.directory, "report.json")}`);
  return lines.join("\n");
}

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

async function saveManifest(path, manifest) {
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
}

// 同步日志到文件，超时/中断回收整个命令组，避免遗留 npm 或 Pi 后代。
export async function runCommand(command, args, { cwd, env, log, timeoutMs = 1_800_000 }) {
  const start = Date.now();
  const stream = createWriteStream(log);
  const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stdout = "", reason;
  const record = data => { stream.write(data); output += data; };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => { stdout += data; record(data); });
  child.stderr.on("data", record);
  const kill = () => {
    try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const interrupt = signal => { reason = `收到 ${signal}`; kill(); };
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
  const timer = setTimeout(() => { reason = `超过 ${timeoutMs / 1000}s 时限`; kill(); }, timeoutMs);
  let error;
  child.once("error", value => { error = value; record(String(value) + "\n"); });
  const exit = await new Promise(done => child.once("close", (code, signal) => done({ code, signal })));
  clearTimeout(timer);
  process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
  if (reason) record(reason + "\n");
  await new Promise((done, reject) => { stream.once("error", reject); stream.end(done); });
  return { status: !error && !reason && exit.code === 0 ? "passed" : "failed", ...exit, reason: reason ?? error?.message, durationMs: Date.now() - start, output, stdout };
}

export async function main(args) {
  const options = parseArgs(args);
  const source = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (git(source, "status", "--porcelain")) throw new Error("请先提交或收起当前改动；检查只 clone 当前已提交快照。");
  const head = git(source, "rev-parse", "HEAD");
  const manifest = JSON.parse(git(source, "show", `${head}:package.json`));
  const dependencies = Object.keys(manifest.devDependencies ?? {}).filter(isPiDependency);
  if (!dependencies.length) throw new Error("根 devDependencies 没有 Pi 依赖");
  // 避免 macOS 长 TMPDIR 影响 Unix socket，以及终端测试中的路径截断。
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-upgrade-"));
  const checkout = join(directory, "repository"), environment = join(directory, "environment");
  for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) await mkdir(join(environment, name), { recursive: true });
  const env = checkEnvironment(environment);
  const report = {
    target: options.version, from: [...new Set(dependencies.map(name => manifest.devDependencies[name]))],
    source, commit: head, directory, steps: [], notices: [
      "未覆盖：真实 provider、人工终端与输入法、没有探针的私有行为。",
      "补丁宿主检查不纳入原版升级门禁；test:patched-host 与补丁联测须用匹配的真实构建另跑。",
      "host-patches/ 的补丁固定上游版本；Pi 版本变更必须按 host-patches/pi/v1.5.0/README.md 重新 pin、重新构建和验证，不能直接套用旧补丁。",
      options.keep ? "保留临时副本及日志。" : "结束后删除临时副本，保留报告与原始日志；需要保留副本请加 --keep。",
    ],
  };
  const step = async (stage, pkg, item, command, commandArgs, cwd = checkout, extraEnv = {}) => {
    const log = join(directory, `${String(report.steps.length + 1).padStart(2, "0")}-${stage.replace(/[^\w\u3400-\u9fff-]/g, "-")}.log`);
    console.log(`检查：${pkg} · ${stage} · ${item}`);
    const { output, stdout, ...result } = await runCommand(command, commandArgs, { cwd, env: { ...env, ...extraEnv }, log });
    const entry = { stage, package: pkg, item, ...result, log, failures: result.status === "failed" ? diagnostics(output, pkg) : [] };
    if (result.status === "failed" && !entry.failures.length) entry.failures.push({ package: pkg, item: output.trim().slice(-4000) || result.reason || `退出码 ${result.code}，信号 ${result.signal}` });
    report.steps.push(entry);
    if (result.reason?.startsWith("收到 SIG")) throw new Error(result.reason);
    return { ...entry, output, stdout };
  };
  const skipped = (stage, pkg, item, reason) => report.steps.push({ stage, package: pkg, item, status: "skipped", reason });
  try {
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
      skipped("安装", "仓库", "目标依赖", "目标版本不存在或 registry 不可达，未安装任何目标依赖。");
    } else {
      const cloned = await step("临时副本", "仓库", "clone", "git", ["clone", "--no-hardlinks", "--no-local", "--quiet", source, checkout], source);
      if (cloned.status === "passed") {
        git(checkout, "checkout", "--quiet", "--detach", head);
        await saveManifest(join(checkout, "package.json"), updatePiVersions(manifest, options.version));
        const installed = await step("安装", "仓库", "bun install", "bun", ["install"], checkout);
        const checks = discoverChecks(checkout);
        const gates = [
          ["公开 API 签名", "typecheck", ["run", "typecheck"]],
          ["公开 API 行为", "test", ["test"]],
          ["公开 API 行为", "test:integration", ["run", "test:integration"]],
        ];
        for (const [stage, item, argv] of gates) {
          if (installed.status === "passed") await step(stage, "仓库", item, "npm", argv);
          else skipped(stage, "仓库", item, "目标依赖安装失败");
        }
        for (const check of checks) {
          if (installed.status === "passed") await step("私有 seam", check.package, check.check, "npm", ["run", check.check], join(checkout, check.directory), { PI_BIN: join(checkout, "node_modules/.bin/pi") });
          else skipped("私有 seam", check.package, check.check, "目标依赖安装失败");
        }
        if (options.apply) {
          if (report.steps.every(entry => entry.status === "passed")) {
            const files = ["package.json", "bun.lock"];
            for (const pkg of workspacePackages(checkout)) {
              if (!Object.keys(pkg.peerDependencies ?? {}).some(isPiDependency)) continue;
              const path = join(pkg.directory, "package.json");
              await saveManifest(join(checkout, path), updatePiVersions(readJson(join(checkout, path)), options.version, { peers: true }));
              files.push(path);
            }
            const lock = await step("应用准备", "仓库", "更新 peers 与 bun.lock", "bun", ["install", "--lockfile-only"]);
            if (lock.status === "passed") {
              if (git(source, "rev-parse", "HEAD") !== head || git(source, "status", "--porcelain")) throw new Error("检查期间当前工作区或 HEAD 已变，拒绝 --apply");
              // 不在当前工作区安装；只复制临时副本中已生成的 manifests 与 lock。
              const originals = await Promise.all(files.map(file => readFile(join(source, file))));
              try {
                for (const file of files) await copyFile(join(checkout, file), join(source, file));
              } catch (error) {
                await Promise.all(files.map((file, index) => writeFile(join(source, file), originals[index])));
                throw error;
              }
              report.steps.push({ stage: "应用", package: "仓库", item: "根 devDeps、各包 peers、bun.lock", status: "passed" });
            }
          } else skipped("应用", "仓库", "--apply", "有失败或未运行项，不修改当前工作区。");
        }
      }
    }
  } catch (error) {
    report.steps.push({ stage: "流程", package: "仓库", item: "异常", status: "failed", reason: String(error.stack ?? error) });
  } finally {
    if (!options.keep) {
      try {
        await Promise.all([checkout, environment].map(path => rm(path, { recursive: true, force: true })));
      } catch (error) {
        report.steps.push({ stage: "清理", package: "仓库", item: "临时副本与隔离环境", status: "failed", reason: String(error) });
      }
    }
    report.passed = report.steps.length > 0 && report.steps.every(entry => entry.status === "passed");
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log("\n" + renderReport(report));
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
