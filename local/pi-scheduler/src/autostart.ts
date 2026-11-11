/**
 * Client wrapper the Pi side uses: send a request, and if the daemon is not
 * answering, start it via the installed service (or a direct spawn) and retry.
 * This is what makes the tool/command work even on the very first use after a
 * reboot before anything has touched the daemon.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { DaemonUnavailableError, ping, request } from "./client.ts";
import { serviceLabel, systemdUnitName } from "./install-service.ts";
import type { SchedulerRequest, SchedulerResponse } from "./protocol.ts";

export interface EnsureOptions {
  socketPath: string;
  /** Runtime that runs the daemon entry when spawning directly. */
  runtime: string;
  /** Daemon entry module path. */
  daemonEntry: string;
  agentDir: string;
  piBinary: string;
  /** Total time to wait for the daemon to come up. */
  startupTimeoutMs?: number;
  /** Maximum time a requested drain may wait for active subprocesses. */
  updateTimeoutMs?: number;
}

export type DaemonBuildReconcileResult = "current" | "updated" | "legacy" | "unavailable" | "timed-out";

/** Stable identity of the bundled daemon that a Pi extension expects to serve it. */
export function daemonBuildId(entry: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(entry)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Try to (re)start the daemon via the platform service manager, else spawn it. */
function kickDaemon(options: EnsureOptions): void {
  const os = platform();
  if (os === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const result = spawnSync("launchctl", ["kickstart", "-p", `gui/${uid}/${serviceLabel(options.agentDir)}`], { stdio: "ignore" });
    if (result.status === 0) return;
  } else if (os === "linux") {
    const result = spawnSync("systemctl", ["--user", "start", systemdUnitName(options.agentDir)], { stdio: "ignore" });
    if (result.status === 0) return;
  }
  // Fallback: detached direct spawn so first use works before install.
  if (!existsSync(options.daemonEntry)) return;
  const child = spawn(options.runtime, [options.daemonEntry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: options.agentDir,
      PI_SCHEDULER_BINARY: options.piBinary,
    },
  });
  child.unref();
}

/** Send a request, auto-starting the daemon on first-connect failure. */
/**
 * Reconcile a reachable daemon with the bundle this Pi extension loaded.
 *
 * New daemons drain in place: they stop dispatching new work, preserve leased
 * injection markers as proof-only, and close their socket only after live
 * subprocesses have persisted terminal records. Once the socket disappears we
 * use the normal service/direct-spawn path to start the rebuilt entry. A daemon
 * that predates `daemon.status` is deliberately left alone: it cannot promise
 * a safe drain, so automatic SIGTERM would violate scheduler task ownership.
 */
export async function reconcileDaemonBuild(options: EnsureOptions): Promise<DaemonBuildReconcileResult> {
  const expected = daemonBuildId(options.daemonEntry);
  if (!expected) return "unavailable";
  let status: SchedulerResponse;
  try {
    status = await request({ type: "daemon.status" }, { socketPath: options.socketPath });
  } catch (error) {
    return error instanceof DaemonUnavailableError ? "unavailable" : "legacy";
  }
  if (!status || !status.ok || status.type !== "daemon-status") return "legacy";
  if (status.buildId === expected && !status.draining) return "current";
  if (!status.draining) {
    const update = await request({ type: "daemon.update" }, { socketPath: options.socketPath });
    if (!update.ok) return "legacy";
  }

  const updated = await waitForExpectedBuild(options, expected, options.updateTimeoutMs ?? 10 * 60_000);
  if (updated) return "updated";
  // The caller may stop waiting after its bounded budget, but a direct-spawn
  // daemon has no service manager to retry its own replacement. Keep a single
  // background watcher alive until the rebuilt socket actually responds.
  scheduleBackgroundReconcile(options, expected);
  return "timed-out";
}

const backgroundReconcilers = new Set<string>();

async function waitForExpectedBuild(options: EnsureOptions, expected: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let nextKickAt = 0;
  while (Date.now() < deadline) {
    try {
      const current = await request({ type: "daemon.status" }, { socketPath: options.socketPath, timeoutMs: 1_000 });
      if (current.ok && current.type === "daemon-status" && current.buildId === expected && !current.draining) return true;
    } catch {
      // A draining daemon can close an accepted connection before the client's
      // response listener settles. Keep retrying the service/direct spawn: an
      // early spawn can legitimately lose the race with lock release.
      if (Date.now() >= nextKickAt) {
        kickDaemon(options);
        nextKickAt = Date.now() + 1_000;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function scheduleBackgroundReconcile(options: EnsureOptions, expected: string): void {
  const key = `${options.socketPath}:${expected}`;
  if (backgroundReconcilers.has(key)) return;
  backgroundReconcilers.add(key);
  const retry = setTimeout(async () => {
    let retryAgain = false;
    try {
      retryAgain = !await waitForExpectedBuild(options, expected, 60_000);
    } finally {
      backgroundReconcilers.delete(key);
    }
    if (retryAgain) scheduleBackgroundReconcile(options, expected);
  }, 1_000);
  retry.unref?.();
}

export async function requestWithAutostart(
  body: SchedulerRequest,
  options: EnsureOptions,
): Promise<SchedulerResponse> {
  try {
    return await request(body, { socketPath: options.socketPath });
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError)) throw error;
  }
  kickDaemon(options);
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    if (await ping(options.socketPath)) {
      return request(body, { socketPath: options.socketPath });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("scheduler daemon did not start");
}
