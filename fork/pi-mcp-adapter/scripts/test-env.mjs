import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const offlineGuard = new URL("./test-offline.mjs", import.meta.url).href;
export const sourceResolver = new URL("../../../ts-resolve.mjs", import.meta.url).href;

export function testSandbox(prefix = "pi-mcp-test-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const name of ["home", "agent", "config", "cache", "data", "cwd", "tmp"]) mkdirSync(join(root, name));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_PACKAGE_DIR: "", PI_OFFLINE: "1",
    npm_config_cache: join(root, "cache"), npm_config_userconfig: join(root, "config", "npm-user.conf"),
    npm_config_globalconfig: join(root, "config", "npm-global.conf"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(offlineGuard)}`.trim(),
    NO_COLOR: "1", TERM: "dumb",
  };
  if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot;
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
