/**
 * Filesystem locations for the scheduler, all under the agent dir so they are
 * per-user and match where the rest of Pi stores state. The socket lives in a
 * short runtime dir because Unix socket paths have a ~104 byte limit on macOS.
 */

import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface SchedulerPaths {
  /** Store root: getAgentDir()/scheduler */
  root: string;
  /** Daemon control socket. */
  socket: string;
  /** Daemon pid/lock file. */
  lock: string;
  /** Daemon log. */
  log: string;
}

export function schedulerPaths(agentDir: string): SchedulerPaths {
  const root = join(agentDir, "scheduler");
  // Keep the socket path short and stable per agent dir.
  const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 12);
  const name = `pi-scheduler-${digest}.sock`;
  const candidate = join(process.env.XDG_RUNTIME_DIR || tmpdir(), name);
  let socket = candidate;
  if (Buffer.byteLength(candidate) > (process.platform === "darwin" ? 103 : 107)) {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("A Unix uid is required for the scheduler socket directory");
    const directory = join("/tmp", `pi-scheduler-${uid}`);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe scheduler socket directory: ${directory}`);
    }
    socket = join(directory, name);
  }
  return {
    root,
    socket,
    lock: join(root, "daemon.lock"),
    log: join(root, "daemon.log"),
  };
}
