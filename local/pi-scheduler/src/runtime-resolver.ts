/**
 * Resolve a real Node/Bun runtime to run the daemon. Pi's own `process.execPath`
 * is the bundled Pi binary, which is not a general-purpose script runner, so the
 * daemon (a standalone process) needs an actual node/bun. Mirrors the approach
 * pi-processes uses for its supervisor.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/** First runnable node/bun on PATH, or undefined if none is found. */
export function resolveDaemonRuntime(pathValue = process.env.PATH ?? ""): string | undefined {
  const directories = pathValue.split(delimiter).filter(Boolean);
  for (const executable of ["node", "bun"]) {
    for (const directory of directories) {
      const candidate = runnable(resolve(directory, executable));
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function runnable(path: string): string | undefined {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) return undefined;
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}
