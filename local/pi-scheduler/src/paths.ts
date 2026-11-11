/**
 * Filesystem locations for the scheduler, all under the agent dir so they are
 * per-user and match where the rest of Pi stores state. The socket lives in a
 * short runtime dir because Unix socket paths have a ~104 byte limit on macOS.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
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
  const socket = join(tmpdir(), `pi-scheduler-${digest}.sock`);
  return {
    root,
    socket,
    lock: join(root, "daemon.lock"),
    log: join(root, "daemon.log"),
  };
}
