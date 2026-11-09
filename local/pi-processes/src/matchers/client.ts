import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

export interface MatchRecord {
  sequence: number;
  text: string;
}

export interface MatchRequest {
  mode: "literal" | "regex";
  pattern: string;
  records: MatchRecord[];
}

export interface MatchResult {
  matches: number[];
  lastSequence: number;
}

interface PendingTask {
  resolve(value: MatchResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingStartup {
  child: ChildProcessWithoutNullStreams;
  promise: Promise<ChildProcessWithoutNullStreams>;
  resolve(child: ChildProcessWithoutNullStreams): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const MAX_CONSECUTIVE_FAULTS = 3;
const STARTUP_DEADLINE_MS = 2_000;

export class MatcherClient {
  readonly runtimePath: string;
  readonly workerPath: string;
  readonly deadlineMs: number;
  #child?: ChildProcessWithoutNullStreams;
  #readyChild?: ChildProcessWithoutNullStreams;
  #startup?: PendingStartup;
  #lines?: ReadLineInterface;
  #pending = new Map<string, PendingTask>();
  #closed = false;
  #consecutiveFaults = 0;
  #circuitOpen = false;

  constructor(options: { runtimePath: string; workerPath: string; deadlineMs?: number }) {
    this.runtimePath = options.runtimePath;
    this.workerPath = options.workerPath;
    this.deadlineMs = options.deadlineMs ?? 50;
  }

  get consecutiveFaults(): number {
    return this.#consecutiveFaults;
  }

  get circuitOpen(): boolean {
    return this.#circuitOpen;
  }

  resetCircuit(): void {
    if (this.#closed) throw new Error("[process/matcher-closed] matcher client is closed");
    this.#consecutiveFaults = 0;
    this.#circuitOpen = false;
  }

  async match(request: MatchRequest): Promise<MatchResult> {
    if (this.#closed) throw new Error("[process/matcher-closed] matcher client is closed");
    if (this.#circuitOpen) throw new Error("[process/matcher-disabled] matcher circuit is open");
    const child = await this.#ensureReadyChild();
    const taskId = randomUUID();
    return await new Promise<MatchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(taskId);
        reject(new Error("[process/regex-timeout] matcher task exceeded its deadline"));
        this.#recordFault();
        this.#restart(new Error("[process/regex-timeout] matcher worker was restarted"));
      }, this.deadlineMs);
      timer.unref?.();
      this.#pending.set(taskId, { resolve, reject, timer });
      const line = `${JSON.stringify({ taskId, ...request })}\n`;
      if (!child.stdin.write(line)) child.stdin.once("drain", () => undefined);
    });
  }

  close(): void {
    this.#closed = true;
    this.#restart(new Error("[process/matcher-closed] matcher client closed"), false);
  }

  async #ensureReadyChild(): Promise<ChildProcessWithoutNullStreams> {
    if (this.#child && this.#readyChild === this.#child && this.#child.exitCode === null && this.#child.signalCode === null) {
      return this.#child;
    }
    if (this.#startup && this.#startup.child === this.#child) return await this.#startup.promise;

    const child = spawn(this.runtimePath, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    this.#child = child;
    this.#readyChild = undefined;
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines.on("line", (line) => this.#handleLine(child, line));

    let resolveStartup!: (readyChild: ChildProcessWithoutNullStreams) => void;
    let rejectStartup!: (error: Error) => void;
    const promise = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const timer = setTimeout(() => {
      if (this.#startup?.child !== child) return;
      this.#recordFault();
      this.#restart(new Error("[process/matcher-startup-timeout] matcher worker did not become ready"));
    }, STARTUP_DEADLINE_MS);
    this.#startup = { child, promise, resolve: resolveStartup, reject: rejectStartup, timer };

    child.once("exit", () => {
      if (this.#child !== child) return;
      this.#recordFault();
      this.#restart(new Error("[process/matcher-crashed] matcher worker exited"), false);
    });
    child.stderr.resume();
    return await promise;
  }

  #handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    try {
      const value = JSON.parse(line) as {
        type?: unknown;
        version?: unknown;
        ok?: boolean;
        taskId?: unknown;
        result?: { taskId?: unknown; matches?: unknown; lastSequence?: unknown };
        error?: unknown;
      };
      if (value.type === "matcher-ready" && value.version === 1) {
        const startup = this.#startup;
        if (!startup || startup.child !== child || this.#readyChild) {
          throw new Error("unexpected matcher ready frame");
        }
        clearTimeout(startup.timer);
        this.#startup = undefined;
        this.#readyChild = child;
        startup.resolve(child);
        return;
      }
      if (this.#readyChild !== child) throw new Error("matcher responded before ready");

      const taskId = value.ok ? value.result?.taskId : value.taskId;
      if (typeof taskId !== "string") throw new Error("matcher response is missing taskId");
      const pending = this.#pending.get(taskId);
      if (!pending) return;
      this.#pending.delete(taskId);
      clearTimeout(pending.timer);
      if (!value.ok) {
        pending.reject(new Error(`[process/matcher-error] ${String(value.error ?? "matcher task failed")}`));
        return;
      }
      if (!Array.isArray(value.result?.matches)
        || !value.result.matches.every((item) => Number.isSafeInteger(item) && (item as number) > 0)
        || !Number.isSafeInteger(value.result.lastSequence)
        || (value.result.lastSequence as number) < 0) {
        pending.reject(new Error("[process/matcher-protocol] matcher returned an invalid result"));
        return;
      }
      this.#consecutiveFaults = 0;
      this.#circuitOpen = false;
      pending.resolve({
        matches: value.result.matches as number[],
        lastSequence: value.result.lastSequence as number,
      });
    } catch {
      this.#recordFault();
      this.#restart(new Error("[process/matcher-protocol] matcher returned invalid JSON"));
    }
  }

  #recordFault(): void {
    this.#consecutiveFaults += 1;
    if (this.#consecutiveFaults >= MAX_CONSECUTIVE_FAULTS) this.#circuitOpen = true;
  }

  #restart(error: Error, kill = true): void {
    const child = this.#child;
    this.#child = undefined;
    this.#readyChild = undefined;
    const startup = this.#startup;
    this.#startup = undefined;
    if (startup) {
      clearTimeout(startup.timer);
      startup.reject(error);
    }
    this.#lines?.close();
    this.#lines = undefined;
    if (child) {
      if (kill && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
