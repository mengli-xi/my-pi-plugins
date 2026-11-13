import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const isPiDependency = name => name.startsWith("@earendil-works/pi-");
export const readJson = path => JSON.parse(readFileSync(path, "utf8"));

// 只枚举根 workspace 声明，不维护包名清单。
export function workspacePackages(root) {
  const { workspaces } = readJson(join(root, "package.json"));
  return workspaces.flatMap(pattern => {
    if (!pattern.endsWith("/*")) throw new Error(`不支持的 workspace 声明：${pattern}`);
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const directory = join(parent, entry.name);
        return { directory, ...readJson(join(root, directory, "package.json")) };
      });
  }).sort((a, b) => a.directory.localeCompare(b.directory));
}

export function discoverChecks(root, { quick = false } = {}) {
  return workspacePackages(root).flatMap(pkg => ["check:internals", quick ? "check:smoke" : "check:host"]
    .filter(check => Object.hasOwn(pkg.scripts ?? {}, check))
    .map(check => ({ package: pkg.name, directory: pkg.directory, check })));
}

// 前置声明只影响官方二进制；原因必须由包给出，不能按包名豁免。
export function parseHostSuites(argv) {
  const commands = [[]];
  for (const arg of argv) {
    if (arg === "::") commands.push([]);
    else commands.at(-1).push(arg);
  }
  return commands.map(command => {
    const args = [...command], requires = [];
    let binarySkip;
    while (args[0]?.startsWith("--require=") || args[0]?.startsWith("--skip-binary=")) {
      const arg = args.shift();
      if (arg.startsWith("--skip-binary=")) {
        if (binarySkip !== undefined || !arg.slice(14).trim()) throw new Error("--skip-binary 必须有唯一的非空理由");
        binarySkip = arg.slice(14);
      } else {
        const requirement = arg.slice("--require=".length);
        if (!["tmux", "pty"].includes(requirement)) throw new Error(`未知前提：${requirement}`);
        requires.push(requirement);
      }
    }
    if (!args.length) throw new Error("check-host.mjs 需要子套件命令");
    if (args[0] === "bun" && !requires.includes("pty")) requires.push("pty");
    return { args, requires, binarySkip };
  });
}

export function piBin() {
  return resolve(repositoryRoot, process.env.PI_BIN ?? "node_modules/.bin/pi");
}

export function installedPiVersion() {
  return readJson(join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json")).version;
}

export function checkEnvironment(root, extra = {}) {
  return {
    PATH: process.env.PATH,
    // npm/Bun/curl 的联网步骤仍需继承现有代理；缺省时不造空变量。
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(https?_proxy|no_proxy)$/i.test(key))),
    HOME: join(root, "home"),
    // Share only a runner-owned, short runtime root across nested harnesses.
    // Its original owner removes it on failure/timeout; never reuse a live desktop runtime.
    XDG_RUNTIME_DIR: process.env.PI_CHECK_RUNTIME_DIR ?? root,
    PI_CHECK_RUNTIME_DIR: process.env.PI_CHECK_RUNTIME_DIR ?? root,
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    npm_config_userconfig: join(root, "config/npmrc"),
    npm_config_globalconfig: join(root, "config/global-npmrc"),
    npm_config_cache: join(root, "cache"), npm_config_update_notifier: "false",
    TERM: "xterm-256color",
    ...extra,
    // 标记由验收入口拥有的 TMPDIR；不要把用户 shell 的长系统 TMPDIR 当作上层隔离目录。
    PI_CHECK_TMPDIR: extra.TMPDIR ?? join(root, "tmp"),
  };
}
