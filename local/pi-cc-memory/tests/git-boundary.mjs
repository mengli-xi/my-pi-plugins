// Test-only filesystem boundary: fixtures must not discover a checkout above TMPDIR.
// Keep real Git and real fixture markers, including damaged/bare/worktree cases.
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { sep } from "node:path";

const root = realpathSync(tmpdir());
const identity = new URL("../src/identity.ts", import.meta.url).href;
const wrapper = source => `data:text/javascript,${encodeURIComponent(source)}`;
const files = wrapper(`
  export * from "node:fs/promises";
  import { lstat as realLstat } from "node:fs/promises";
  export function lstat(path, ...args) {
    if (String(path).endsWith("/.git") && (!String(path).startsWith(${JSON.stringify(root + sep)}) || String(path) === ${JSON.stringify(root + sep + ".git")})) {
      return Promise.reject(Object.assign(new Error("outside fixture boundary"), { code: "ENOENT" }));
    }
    return realLstat(path, ...args);
  }
`);
const processes = wrapper(`
  export * from "node:child_process";
  import { execFile as realExecFile } from "node:child_process";
  import { promisify } from "node:util";
  const options = value => ({ ...value, env: { ...value.env, GIT_CEILING_DIRECTORIES: ${JSON.stringify(root)} } });
  export function execFile(file, args, value, callback) {
    return realExecFile(file, args, options(value), callback);
  }
  execFile[promisify.custom] = (file, args, value) => promisify(realExecFile)(file, args, options(value));
`);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === identity) {
      if (specifier === "node:fs/promises") return { url: files, shortCircuit: true };
      if (specifier === "node:child_process") return { url: processes, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
