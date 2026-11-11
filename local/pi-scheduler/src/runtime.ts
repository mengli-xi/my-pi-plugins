/**
 * Daemon runtime: the long-lived object launchd/systemd runs. It owns the
 * control server and the tick loop, holds a single-instance lock, and cleans
 * up its socket on shutdown. Kept separate from `daemon.ts` (pure tick logic)
 * so the loop stays testable without timers or sockets.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { type Server } from "node:net";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { platform } from "node:os";
import { startControlServer } from "./control-server.ts";
import { SchedulerDaemon } from "./daemon.ts";
import { defaultRunner, type TaskRunner } from "./executor.ts";
import { OccupancyRegistry, processAlive } from "./occupancy.ts";
import { schedulerPaths, type SchedulerPaths } from "./paths.ts";
import { SchedulerStore } from "./store.ts";
import type { RunRecord, Task } from "./task.ts";
export interface RuntimeOptions {
  agentDir: string;
  piBinary: string;
  /** Identifies the daemon bundle serving the socket. */
  buildId?: string;
  concurrency?: number;
  runner?: TaskRunner;
  now?: () => number;
  onFailure?: (task: Task, record: RunRecord) => void;
  /** Upper bound between planning passes even when nothing is due (safety net). */
  maxSleepMs?: number;
  /** Called after a requested drain has stopped the server and released the lock. */
  onDrained?: () => void;
  /** Fail-closed notification when the kernel advisory lock helper dies unexpectedly. */
  onLockLost?: () => void;
}

const DEFAULT_MAX_SLEEP_MS = 60_000;
const DRAIN_POLL_MS = 10;

/** Thrown when a live daemon already holds the lock. */
export class DaemonAlreadyRunningError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`scheduler daemon already running (pid ${pid})`);
    this.pid = pid;
  }
}

export class SchedulerRuntime {
  readonly paths: SchedulerPaths;
  private readonly store: SchedulerStore;
  private readonly occupancy: OccupancyRegistry;
  private readonly daemon: SchedulerDaemon;
  private readonly now: () => number;
  private readonly maxSleepMs: number;
  private readonly buildId: string;
  private readonly onDrained?: () => void;
  private readonly onLockLost?: () => void;
  private server?: Server;
  private timer?: ReturnType<typeof setTimeout>;
  private lockFd?: number;
  private lockHelper?: ChildProcess;
  private stopped = false;
  private drainCompleted = false;
  private releasingLock = false;
  private lockLost = false;

  constructor(options: RuntimeOptions) {
    this.paths = schedulerPaths(options.agentDir);
    this.store = new SchedulerStore(this.paths.root);
    this.now = options.now ?? Date.now;
    this.maxSleepMs = options.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
    this.buildId = options.buildId ?? "development";
    this.onDrained = options.onDrained;
    this.onLockLost = options.onLockLost;
    // Restore persisted occupancy so a daemon restart keeps deferring sessions
    // still held by a live Pi (decision #13), and persist every change.
    this.occupancy = new OccupancyRegistry({
      initial: this.store.readOccupancy(),
      onChange: (entries) => this.store.writeOccupancy(entries),
    });
    this.daemon = new SchedulerDaemon({
      store: this.store,
      occupancy: this.occupancy,
      runner: options.runner ?? defaultRunner,
      piBinary: options.piBinary,
      concurrency: options.concurrency ?? 5,
      now: this.now,
      onFailure: options.onFailure,
    });
  }

  /** Acquire the single-instance lock, start the server, run the first tick. */
  async start(): Promise<void> {
    this.store.init();
    await this.acquireLock();
    // Turn crash-orphaned in-flight runs into recorded failures before planning.
    this.daemon.reconcileCrashed();
    this.server = startControlServer({
      socketPath: this.paths.socket,
      store: this.store,
      occupancy: this.occupancy,
      onMutate: () => this.reschedule(),
      onRunNow: (id) => this.runNow(id),
      onDaemonStatus: () => ({ buildId: this.buildId, draining: this.daemon.isDraining }),
      onDaemonUpdate: () => this.beginDrain(),
      onMailboxInjection: (request) => this.daemon.mailbox.apply(request),
      onInjectionPoll: (request) => this.daemon.pollInjection(request),
      onInjectionAck: (request) => this.daemon.ackInjection(request),
      onInjectionNack: (request) => this.daemon.nackInjection(request),
      now: this.now,
    });
    this.reschedule();
  }

  private async acquireLock(): Promise<void> {
    // A kernel advisory lock, held by a small helper whose stdin stays open,
    // is the ownership primitive. Unlike a PID lockfile it is released on a
    // crash and has no stale-file ABA recovery path. The text file remains
    // diagnostics only; it cannot grant ownership.
    const token = randomUUID();
    const command = platform() === "darwin"
      ? { file: "/usr/bin/lockf", args: ["-k", "-t", "0", this.paths.lock, "sh", "-c", "printf 'READY\\n'; exec cat"] }
      : { file: "flock", args: ["-n", this.paths.lock, "sh", "-c", "printf 'READY\\n'; exec cat"] };
    const helper = spawn(command.file, command.args, { stdio: ["pipe", "pipe", "ignore"] });
    const acquired = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const done = (value: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!value) helper.kill();
        if (error) reject(error); else resolve(value);
      };
      // Allow cold process startup on a busy host; -t 0/-n still refuses an
      // already-held lock immediately. This bounds helper startup, not ownership.
      const timer = setTimeout(() => done(false, new Error("scheduler advisory lock helper timed out")), 15_000);
      let output = "";
      helper.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("READY\n")) done(true);
      });
      helper.once("error", (error) => done(false, error));
      helper.once("exit", () => done(false));
    });
    if (!acquired) throw new DaemonAlreadyRunningError(0);
    this.lockHelper = helper;
    helper.once("exit", () => {
      if (!this.releasingLock) this.handleLockLoss();
    });
    this.lockFd = openSync(this.paths.lock, "w", 0o600);
    writeSync(this.lockFd, `${process.pid} ${token}\n`);
  }

  /**
   * The helper is the sole kernel ownership proof. If it exits unexpectedly,
   * continuing to serve or dispatch would permit a second daemon to obtain the
   * lock and create two writers. Contain immediately; daemon-entry exits via
   * onLockLost, while tests may inspect the closed runtime without process exit.
   */
  private handleLockLoss(): void {
    if (this.stopped || this.releasingLock || this.lockLost) return;
    this.lockLost = true;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const server = this.server;
    this.server = undefined;
    try { server?.close(); } catch { /* already closed */ }
    if (server) {
      try { rmSync(this.paths.socket, { force: true }); } catch { /* best effort */ }
    }
    if (this.lockFd !== undefined) {
      try { closeSync(this.lockFd); } catch { /* already closed */ }
      this.lockFd = undefined;
    }
    this.lockHelper = undefined;
    try { this.onLockLost?.(); } catch { /* exit/observer must not re-open ownership */ }
  }

  private reschedule(): void {
    if (this.stopped) return;
    if (this.daemon.isDraining) {
      this.scheduleDrainCheck();
      return;
    }
    const { wakeAt } = this.daemon.tick();
    if (this.timer) clearTimeout(this.timer);
    const at = this.now();
    const delay = wakeAt === undefined
      ? this.maxSleepMs
      : Math.max(0, Math.min(this.maxSleepMs, wakeAt - at));
    this.timer = setTimeout(() => this.reschedule(), delay);
    this.timer.unref?.();
  }

  private runNow(id: string): { started: boolean; reason?: string } {
    const task = this.store.getTask(id);
    if (!task) return { started: false, reason: `no such task: ${id}` };
    // A manual run executes the frozen prompt immediately without moving the
    // schedule watermark; the daemon refuses a session held by a live Pi.
    return this.daemon.runNow(task);
  }

  private beginDrain(): void {
    if (this.stopped) return;
    this.daemon.beginDrain();
    this.scheduleDrainCheck();
  }

  private scheduleDrainCheck(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.daemon.runningCount > 0) {
        this.scheduleDrainCheck();
        return;
      }
      this.completeDrain();
    }, DRAIN_POLL_MS);
    this.timer.unref?.();
  }

  private completeDrain(): void {
    if (this.stopped || this.drainCompleted) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const complete = () => {
      if (this.drainCompleted) return;
      this.drainCompleted = true;
      // Server.close guarantees the listener is no longer accepting. Remove
      // its pathname before releasing the lock: a successor can only acquire
      // the lock after this cleanup, so this daemon can never unlink the new
      // listener's socket between successor lock acquisition and bind.
      try { rmSync(this.paths.socket, { force: true }); } catch { /* best effort */ }
      void this.releaseLock().then(() => this.onDrained?.());
    };
    if (!this.server) {
      complete();
      return;
    }
    this.server.close(complete);
  }

  private async releaseLock(): Promise<void> {
    if (this.lockFd !== undefined) {
      try { closeSync(this.lockFd); } catch { /* already closed */ }
      this.lockFd = undefined;
    }
    // EOF is asynchronous. Wait for the helper's exit so the kernel advisory
    // lock is definitely released before drain's onDrained spawns a successor.
    const helper = this.lockHelper;
    this.lockHelper = undefined;
    this.releasingLock = true;
    if (!helper || helper.exitCode !== null) {
      this.releasingLock = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { helper.kill(); } catch { /* already gone */ }
      }, 2_000);
      helper.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try { helper.stdin?.end(); } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.releasingLock = false;
  }

  stop(): void {
    if (this.stopped && this.drainCompleted) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const server = this.server;
    this.server = undefined;
    try { server?.close(); } catch { /* already closed */ }
    // A runtime that lost the atomic lock race never bound this socket. It must
    // not tear down the real daemon's listener when its owner cleans up.
    if (server) {
      try { rmSync(this.paths.socket, { force: true }); } catch { /* best effort */ }
    }
    void this.releaseLock();
  }
}
