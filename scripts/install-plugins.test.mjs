import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import test from "node:test";
import { install, installPlan, parseArgs, resolvePi } from "./install-plugins.mjs";
import { checkEnvironment, repositoryRoot } from "./pi-checks.mjs";
import { supportedPiVersion } from "./pi-upgrade-check.mjs";

const version = supportedPiVersion(readFileSync(join(repositoryRoot, "README.md"), "utf8"));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi install spaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["local/*", "fork/*"] }));
  const packages = [
    ["local/ordinary", "ordinary", "插件"],
    ["fork/built", "@fixture/built", "Fork 插件", { build: "unused" }],
    ["local/gallery", "gallery", "开发插件"],
    ["local/library", "library", "共享库"],
  ];
  for (const [directory, name, type, scripts] of packages) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "package.json"), JSON.stringify({
      name, scripts, ...(type === "共享库" ? {} : { pi: { extensions: ["index.ts"] } }),
    }));
  }
  writeFileSync(join(root, "README.md"), `支持 **Pi ${version}**。\n` + packages.map(([directory, name, type]) =>
    `| [${name}](${directory}/README.md) | ${type} | 用途 |`).join("\n"));
  return root;
}
const silent = () => {};

test("查找全局 CLI 时跳过 npm 注入的仓库 Pi，允许显式选择开发 CLI", t => {
  const root = fixture(t), local = join(root, "node_modules/.bin"), global = join(root, "global bin");
  for (const directory of [local, global]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pi"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, "pi"), 0o755);
  }
  assert.equal(resolvePi(root, "pi", [local, global].join(delimiter)), join(global, "pi"));
  assert.equal(resolvePi(root, "pi", ["node_modules/.bin", "global bin"].join(delimiter)), join(global, "pi"));
  assert.equal(resolvePi(root, "./node_modules/.bin/pi", ""), join(local, "pi"));
  assert.throws(() => resolvePi(root, "pi", local), /找不到全局/);
});

test("从 workspace/README 选择生产或开发插件，排除共享库并合并别名", t => {
  const root = fixture(t);
  const all = installPlan(root, parseArgs(["--all"]));
  assert.deepEqual(all.plugins.map(pkg => pkg.name), ["ordinary", "@fixture/built"]);
  assert.deepEqual(all.builds.map(pkg => pkg.name), ["@fixture/built"]);
  assert.equal(installPlan(root, parseArgs(["--all", "--include-dev"])).plugins.length, 3);
  assert.equal(installPlan(root, parseArgs(["built", "@fixture/built", "fork/built"])).plugins.length, 1);
  assert.throws(() => installPlan(root, parseArgs(["library"])), /共享库/);
  assert.throws(() => installPlan(root, parseArgs(["missing"])), /不存在/);
});

test("无选择、未知参数和矛盾选项直接拒绝", () => {
  for (const args of [[], ["--wat"], ["--all", "ordinary"], ["--include-dev"], ["--pi"], ["--pi", "--all"]]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(["--help"]).help, true);
});

test("预览不运行任何外部命令，显示独立参数及选中包的构建", t => {
  const root = fixture(t), lines = [];
  install(root, parseArgs(["--all", "--dry-run", "--pi", "./custom pi"]), () => assert.fail("dry-run 执行了命令"), line => lines.push(line));
  assert(lines.some(line => line === JSON.stringify(["npm", "run", "build", "--workspace", "@fixture/built"])));
  assert(lines.some(line => line === JSON.stringify([join(root, "custom pi"), "install", join(root, "fork/built")])));
});

test("版本或依赖/构建失败时不开始写入 Pi 配置", t => {
  const root = fixture(t);
  const calls = [];
  assert.throws(() => install(root, parseArgs(["--all"]), (cmd, args) => {
    calls.push([cmd, args]);
    return "0.0.0";
  }, silent), /版本/);
  assert.equal(calls.length, 1);
  for (const failure of ["bun", "npm"]) {
    const executed = [];
    assert.throws(() => install(root, parseArgs(["--all"]), (cmd, args) => {
      executed.push([cmd, args]);
      if (args[0] === "--version") return version;
      if (cmd === failure) throw new Error("fixture failure");
    }, silent), /fixture failure/);
    assert(!executed.some(([cmd, args]) => cmd === "pi" && args[0] === "install"));
  }
});

test("安装途中失败立即停止，允许已完成的包保留后重跑", t => {
  const root = fixture(t), installed = [];
  assert.throws(() => install(root, parseArgs(["ordinary", "built", "gallery"]), (_cmd, args) => {
    if (args[0] === "--version") return version;
    if (args[0] !== "install" || args.includes("--frozen-lockfile")) return;
    installed.push(args[1]);
    if (args[1].endsWith("fork/built")) throw new Error("install failed");
  }, silent), /install failed/);
  assert.deepEqual(installed, [join(root, "local/ordinary"), join(root, "fork/built")]);
});

test("真实 Pi 重复安装保留相对路径、对象过滤及无关配置，不增加重复项", t => {
  const root = fixture(t);
  const environment = join(root, "environment");
  for (const name of ["home", "agent", "sessions", "config", "cache", "data", "state", "tmp"]) {
    mkdirSync(join(environment, name), { recursive: true });
  }
  const agent = join(environment, "agent"), settings = join(agent, "settings.json");
  const filtered = { source: relative(agent, join(root, "local/ordinary")), extensions: [] };
  writeFileSync(settings, JSON.stringify({ quietStartup: true, packages: [filtered, "npm:unrelated-fixture"] }));
  const calls = [];
  const run = (cmd, args, options) => {
    calls.push([cmd, args]);
    if (cmd !== "pi") return;
    return execFileSync(join(repositoryRoot, "node_modules/.bin/pi"), args, {
      cwd: options.cwd, env: checkEnvironment(environment), encoding: "utf8", timeout: 30000,
    }).trim();
  };
  for (let i = 0; i < 2; i++) install(root, parseArgs(["--all"]), run, silent);
  const saved = JSON.parse(readFileSync(settings));
  assert.equal(saved.quietStartup, true);
  assert.deepEqual(saved.packages[0], filtered);
  assert.equal(saved.packages[1], "npm:unrelated-fixture");
  assert.equal(saved.packages.length, 3);
  assert.equal(resolve(agent, saved.packages[2]), join(root, "fork/built"));
  assert.deepEqual(calls.slice(0, 3).map(([cmd]) => cmd), ["pi", "bun", "npm"]);
});
