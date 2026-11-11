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

export function discoverChecks(root) {
  return workspacePackages(root).flatMap(pkg => ["check:internals", "check:host"]
    .filter(check => Object.hasOwn(pkg.scripts ?? {}, check))
    .map(check => ({ package: pkg.name, directory: pkg.directory, check })));
}

export function piBin() {
  return resolve(process.env.PI_BIN ?? join(repositoryRoot, "node_modules/.bin/pi"));
}

export function installedPiVersion() {
  return readJson(join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json")).version;
}

export function checkEnvironment(root, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
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
  };
}
