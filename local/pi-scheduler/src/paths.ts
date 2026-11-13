/**
 * Filesystem locations for the scheduler, all under the agent dir so they are
 * per-user and match where the rest of Pi stores state. The socket lives in a
 * short runtime dir because Unix socket paths have a ~104 byte limit on macOS.
 */

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
  // TMPDIR differs between shells and service managers and can exceed sun_path.
  // XDG_RUNTIME_DIR is the user runtime contract; the installer freezes it.
  const name = `pi-scheduler-${process.getuid?.() ?? 0}-${digest}.sock`;
  const runtime = process.env.XDG_RUNTIME_DIR || "/tmp";
  const candidate = join(runtime, name);
  const socket = Buffer.byteLength(candidate) <= 103 ? candidate : join("/tmp", name);
  return {
    root,
    socket,
    lock: join(root, "daemon.lock"),
    log: join(root, "daemon.log"),
  };
}
