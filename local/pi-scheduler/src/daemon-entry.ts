#!/usr/bin/env node
/**
 * Daemon entry point. Run by launchd/systemd (or `pi-scheduler daemon` for
 * debugging). Resolves the agent dir and pi binary from the environment,
 * starts the runtime, and cleans up on termination signals.
 *
 * Env contract (set by the installer's service definition):
 * - PI_CODING_AGENT_DIR : agent dir inherited from the launching Pi (required).
 * - PI_SCHEDULER_BINARY : absolute path to the pi binary to invoke for tasks.
 * - PI_SCHEDULER_CONCURRENCY : optional integer, default 5.
 */

import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SchedulerRuntime, DaemonAlreadyRunningError } from "./runtime.ts";
import { systemNotifier } from "./notify.ts";

function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured && configured.trim()) return configured;
  throw new Error("PI_CODING_AGENT_DIR is required; start the daemon through Pi or its installed service");
}

function resolveBuildId(): string {
  const entry = process.argv[1];
  if (!entry) return "unknown";
  try {
    return createHash("sha256").update(readFileSync(entry)).digest("hex");
  } catch {
    return "unknown";
  }
}

function resolvePiBinary(): string {
  const configured = process.env.PI_SCHEDULER_BINARY;
  if (configured && configured.trim()) return configured;
  throw new Error("PI_SCHEDULER_BINARY is required; start the daemon through Pi or its installed service");
}

export async function main(): Promise<void> {
  const concurrency = Number(process.env.PI_SCHEDULER_CONCURRENCY) || 5;
  const runtime = new SchedulerRuntime({
    agentDir: resolveAgentDir(),
    piBinary: resolvePiBinary(),
    concurrency,
    buildId: resolveBuildId(),
    onFailure: (task, record) => {
      systemNotifier(
        `Scheduled task failed: ${task.title}`,
        record.detail ? String(record.detail).slice(0, 200) : "See /schedule for details.",
      );
    },
    // A drain is an intentional handoff, not a crash. Runtime has already
    // closed its socket and released its advisory lock, so this process can start
    // the same resolved entry before exiting. This is essential for direct
    // autostart (no launchd/systemd); under a service manager both contenders
    // may race, but the `wx` daemon lock admits exactly one replacement.
    onDrained: () => {
      const entry = process.argv[1];
      if (entry) {
        try {
          const child = spawn(process.execPath, [entry], {
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
        } catch {
          // launchd/systemd or a live Pi's autostart reconciliation provides a
          // second recovery path; never keep the drained owner alive.
        }
      }
      process.exit(0);
    },
    // Advisory lock helper loss means this process no longer owns the single
    // writer lease. Exit fail-closed; launchd/systemd or the Pi watcher will
    // start a replacement that must acquire the kernel lock first.
    onLockLost: () => process.exit(1),
  });
  try {
    await runtime.start();
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      // Another daemon owns this agent dir; exit quietly so a fallback spawn
      // racing the installed service does not double-run.
      process.exit(0);
    }
    throw error;
  }

  const shutdown = () => {
    runtime.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    // Keep DaemonAlreadyRunningError's intentional exit distinct from a real
    // startup failure, but never leave an unhandled entrypoint rejection.
    if (error instanceof DaemonAlreadyRunningError) process.exit(0);
    throw error;
  });
}
