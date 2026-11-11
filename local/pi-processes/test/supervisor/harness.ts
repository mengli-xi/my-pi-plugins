import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FrameDecoder, encodeFrame, type FrameV1 } from "../../src/supervisor/protocol.ts";

export interface SupervisorHarness {
  child: ChildProcess;
  hostNonce: string;
  generation: number;
  root: string;
  frames: FrameV1[];
  write(type: string, payload: Record<string, unknown>): { requestId: string; requestSequence: number };
  send(type: string, payload: Record<string, unknown>): Promise<FrameV1>;
  waitFor(predicate: (frame: FrameV1) => boolean, timeoutMs?: number): Promise<FrameV1>;
  closeInput(): void;
  waitForExit(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function startSupervisor(options: { runtime: string; supervisorPath: string }): Promise<SupervisorHarness> {
  const hostNonce = randomBytes(32).toString("hex");
  const generation = 1;
  const root = join(tmpdir(), `pi-processes-supervisor-test-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  // These local Supervisor fixtures load no providers. Keep runner preloads on
  // the test process instead of charging their startup to command deadlines.
  const { NODE_OPTIONS: _runnerPreloads, ...env } = process.env;
  const child = spawn(options.runtime, [options.supervisorPath], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: {
      ...env,
      PI_PROCESSES_SUPERVISOR_NONCE: hostNonce,
      PI_PROCESSES_SUPERVISOR_GENERATION: String(generation),
      PI_PROCESSES_SESSION_SCOPE: "session-e2e",
      PI_PROCESSES_PI_PID: String(process.pid),
      PI_PROCESSES_SUPERVISOR_ROOT: root,
      PI_PROCESSES_SUPERVISOR_HELPER_RUNTIME: options.runtime,
    },
  });
  const input = child.stdio[3];
  const output = child.stdio[4];
  if (!(input instanceof Writable) || !(output instanceof Readable)) throw new Error("supervisor fd3/fd4 pipes are unavailable");
  // Mirror SupervisorClient's channel teardown. Linux can keep an outstanding
  // fd3 read alive until the peer closes after the Supervisor's output EOF.
  output.once("end", () => input.destroy());
  const decoder = new FrameDecoder();
  const frames: FrameV1[] = [];
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const waiters = new Set<() => void>();
  output.on("data", (chunk: Buffer) => {
    frames.push(...decoder.push(chunk));
    for (const wake of [...waiters]) wake();
  });
  let requestSequence = 0;

  // Command starts and signal delivery on a loaded machine can take seconds;
  // the cap only bounds how long a missing frame is waited for.
  const waitFor = async (predicate: (frame: FrameV1) => boolean, timeoutMs = 15_000): Promise<FrameV1> => {
    const existing = frames.find(predicate);
    if (existing) return existing;
    return await new Promise<FrameV1>((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`supervisor frame timeout${stderr.length ? `: ${stderr.join("")}` : ""}`)); }, timeoutMs);
      const check = (): void => {
        const found = frames.find(predicate);
        if (!found) return;
        clearTimeout(timeout);
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
    });
  };

  input.write(encodeFrame({
    version: 1,
    hostNonce,
    supervisorGeneration: generation,
    type: "hello",
    payload: { piPid: process.pid, sessionScopeId: "session-e2e", extensionVersion: "test", platform: process.platform },
  }));
  await waitFor((frame) => frame.type === "ready");

  const waitForExit = async (timeoutMs = 15_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.off("exit", onExit);
        reject(new Error(`supervisor exit timeout${stderr.length ? `: ${stderr.join("")}` : ""}`));
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timeout);
        child.off("exit", onExit);
        resolve();
      }
    });
  };

  const write = (type: string, payload: Record<string, unknown>): { requestId: string; requestSequence: number } => {
    const requestId = randomUUID();
    const sequence = ++requestSequence;
    input.write(encodeFrame({
      version: 1,
      hostNonce,
      supervisorGeneration: generation,
      type,
      requestId,
      requestSequence: sequence,
      payload,
    }));
    return { requestId, requestSequence: sequence };
  };

  return {
    child,
    hostNonce,
    generation,
    root,
    frames,
    write,
    async send(type, payload) {
      const { requestId } = write(type, payload);
      return await waitFor((frame) => frame.type === "response" && frame.requestId === requestId);
    },
    waitFor,
    closeInput() { input.end(); },
    waitForExit,
    async dispose() {
      input.destroy();
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      await waitForExit();
    },
  };
}
