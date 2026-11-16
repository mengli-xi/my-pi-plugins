#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { productionPlugins } from "./pi-binary.mjs";
import { repositoryRoot, workspacePackages } from "./pi-checks.mjs";
import { supportedPiVersion } from "./pi-upgrade-check.mjs";

const usage = `用法：node scripts/install-plugins.mjs <包名...|--all> [选项]
  --all           安装全部生产插件
  --include-dev   与 --all 一起使用，包含开发/示例插件
  --dry-run       仅显示计划，不执行命令、不写配置
  --pi <路径>     指定 Pi CLI，默认使用 PATH 中的全局 pi
  --help          显示帮助
也可指定包名、目录名或仓库相对目录，例如 pi-todo、pi-goal、fork/pi-goal。
安装使用个人配置，遵守 PI_CODING_AGENT_DIR；不升级 Pi。`;

export function parseArgs(args) {
  const options = { names: [], pi: "pi" };
  const flags = { "--all": "all", "--include-dev": "includeDev", "--dry-run": "dryRun", "--help": "help" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (Object.hasOwn(flags, arg)) {
      if (options[flags[arg]]) throw new Error(`重复参数：${arg}`);
      options[flags[arg]] = true;
    } else if (arg === "--pi") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error("--pi 需要 CLI 路径或命令名");
      options.pi = args[++i];
    } else if (arg.startsWith("-")) throw new Error(`未知参数：${arg}`);
    else options.names.push(arg);
  }
  if (options.help) return options;
  if (options.all && options.names.length) throw new Error("--all 不能与包名同时使用");
  if (options.includeDev && !options.all) throw new Error("--include-dev 需要 --all");
  if (!options.all && !options.names.length) throw new Error(usage);
  return options;
}

export function installPlan(root, options) {
  const packages = workspacePackages(root);
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const production = productionPlugins(packages, readme);
  const extensions = packages.filter(pkg => pkg.pi?.extensions?.length);
  const selected = options.all
    ? (options.includeDev ? extensions : production)
    : options.names.map(name => {
      const matches = extensions.filter(pkg => [pkg.name, pkg.directory, pkg.directory.split("/").at(-1)].includes(name));
      if (matches.length !== 1) throw new Error(`插件名不存在或不唯一：${name}（共享库不单独安装）`);
      return matches[0];
    });
  const plugins = [...new Map(selected.map(pkg => [pkg.directory, pkg])).values()];
  return {
    version: supportedPiVersion(readme),
    plugins,
    builds: plugins.filter(pkg => pkg.scripts?.build),
  };
}

export function resolvePi(root, command, searchPath = process.env.PATH ?? "") {
  if (command.includes("/")) return resolve(root, command);
  // npm run 会注入本仓的 devDependency Pi；默认检查用户日常使用的宿主。
  for (const directory of searchPath.split(delimiter)) {
    if (resolve(root, directory) === resolve(root, "node_modules/.bin")) continue;
    const candidate = resolve(root, directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* 继续搜索 PATH。 */ }
  }
  throw new Error(`PATH 中找不到全局 ${command}；请先安装，或用 --pi 指定 CLI`);
}

function runCommand(command, args, { cwd, capture = false, piCommand = false }) {
  if (piCommand) command = resolvePi(cwd, command);
  const result = spawnSync(command, args, {
    cwd, env: process.env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败（${result.signal ?? result.status}）${capture ? `\n${result.stderr ?? ""}` : ""}`);
  }
  return result.stdout?.trim();
}

export function install(root, options, run = runCommand, log = console.log) {
  const plan = installPlan(root, options);
  // 显式相对 CLI 路径以仓库根解析；裸命令名交给 PATH。
  const pi = options.pi.includes("/") ? resolve(root, options.pi) : options.pi;
  log(`目标 Pi：${plan.version}；个人配置${process.env.PI_CODING_AGENT_DIR ? "（PI_CODING_AGENT_DIR）" : ""}`);
  log(`插件 ${plan.plugins.length} 个：\n${plan.plugins.map(pkg => `  ${pkg.directory}`).join("\n")}`);
  const commands = [
    ["bun", ["install", "--frozen-lockfile"]],
    ...plan.builds.map(pkg => ["npm", ["run", "build", "--workspace", pkg.name]]),
    ...plan.plugins.map(pkg => [pi, ["install", resolve(root, pkg.directory)]]),
  ];
  if (options.dryRun) {
    log(`预览；执行时先检查 ${JSON.stringify([pi, "--version"])} 必须为 ${plan.version}`);
    for (const [command, args] of commands) log(JSON.stringify([command, ...args]));
    return;
  }
  const version = run(pi, ["--version"], { cwd: root, capture: true, piCommand: true });
  if (version !== plan.version) throw new Error(`Pi 版本 ${version} 与仓库支持的 ${plan.version} 不符；请先升级 Pi 或用 --pi 指定 CLI`);
  // 构建全部成功后才写个人配置；每次 install 的去重、锁和资源过滤由 Pi 管理。
  for (const [index, [command, args]] of commands.entries()) {
    run(command, args, { cwd: root, piCommand: index > plan.builds.length });
  }
  log("安装完成。请保留整个仓库，并启动新的 Pi 进程。已有资源禁用/过滤保持原样。");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else install(repositoryRoot, options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
