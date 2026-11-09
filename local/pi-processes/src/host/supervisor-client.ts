import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FrameDecoder, ProtocolError, encodeFrame, type FrameV1 } from "../supervisor/protocol.js";
import { executionIsolationBootstrap, parseExecutionIsolationBootstrap, SUPERVISOR_EXECUTION_ISOLATION_ENV, type ExecutionIsolationV1 } from "../execution-isolation.js";

export interface SupervisorEvent {
  type: string;
  eventSequence: number;
  payload: Record<string, unknown>;
}

export interface SupervisorClientOptions {
  runtimePath: string;
  supervisorPath: string;
  sessionScopeId: string;
  generation: number;
  isolation?: ExecutionIsolationV1;
  launchTimeoutMs?: number;
  requestTimeoutMs?: (type: string, payload: Record<string, unknown>) => number;
  onEvent?: (event: SupervisorEvent) => void | Promise<void>;
  onChannelLost?: (error: Error) => void;
}

interface PendingRequest {
  sequence: number;
  timer: NodeJS.Timeout;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

const DEFAULT_DEADLINES: Record<string, number> = {
  health: 2_000,
  cancel: 2_000,
  input: 5_000,
  stop: 5_000,
  watchSet: 5_000,
  spawn: 10_000,
  shellProbe: 10_000,
  logPage: 10_000,
  logSearch: 30_000,
  clearRecords: 30_000,
  eventAck: 5_000,
};

function errorFromResponse(payload: Record<string, unknown>): Error {
  const code = typeof payload.code === "string" ? payload.code : "protocol-error";
  const message = typeof payload.message === "string" ? payload.message : "supervisor request failed";
  return new Error(`[process/${code}] ${message}`);
}

function exactReady(frame: FrameV1, nonce: string, generation: number): { supervisorPid: number; platform: string } {
  if (frame.type !== "ready" || frame.requestId || frame.requestSequence || frame.eventSequence) {
    throw new ProtocolError("protocol-handshake", "expected ready as first supervisor frame");
  }
  if (frame.hostNonce !== nonce || frame.supervisorGeneration !== generation) {
    throw new ProtocolError("protocol-handshake", "ready nonce or generation mismatch");
  }
  const keys = Object.keys(frame.payload).sort();
  if (keys.length !== 2 || keys[0] !== "platform" || keys[1] !== "supervisorPid") {
    throw new ProtocolError("protocol-handshake", "ready payload shape is invalid");
  }
  const supervisorPid = frame.payload.supervisorPid;
  const platform = frame.payload.platform;
  if (!Number.isSafeInteger(supervisorPid) || (supervisorPid as number) <= 0) {
    throw new ProtocolError("protocol-handshake", "ready supervisorPid is invalid");
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new ProtocolError("protocol-handshake", "ready platform is unsupported");
  }
  return { supervisorPid: supervisorPid as number, platform };
}

export class SupervisorClient {
  readonly hostNonce: string;
  readonly generation: number;
  readonly root: string;
  readonly child: ChildProcess;

  #input: Writable;
  #output: Readable;
  #decoder = new FrameDecoder();
  #pending = new Map<string, PendingRequest>();
  #requestSequence = 0;
  #eventSequence = 0;
  #ready = false;
  #closed = false;
  #supervisorPid?: number;
  #platform?: string;
  #eventQueue: Promise<void> = Promise.resolve();
  #onEvent?: SupervisorClientOptions["onEvent"];
  #onChannelLost?: SupervisorClientOptions["onChannelLost"];
  #requestTimeoutMs: NonNullable<SupervisorClientOptions["requestTimeoutMs"]>;

  private constructor(options: SupervisorClientOptions, child: ChildProcess, input: Writable, output: Readable, nonce: string, root: string) {
    this.hostNonce = nonce;
    this.generation = options.generation;
    this.root = root;
    this.child = child;
    this.#input = input;
    this.#output = output;
    this.#onEvent = options.onEvent;
    this.#onChannelLost = options.onChannelLost;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? ((type) => DEFAULT_DEADLINES[type] ?? 10_000);
  }

  static async launch(options: SupervisorClientOptions): Promise<SupervisorClient> {
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) throw new Error("[process/protocol-invalid] generation must be positive");
    const isolation = JSON.stringify(executionIsolationBootstrap(options.isolation));
    const nonce = randomBytes(32).toString("hex");
    const root = join(tmpdir(), `pi-processes-${process.pid}-${nonce}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    parseExecutionIsolationBootstrap(isolation);
    const child = spawn(options.runtimePath, [options.supervisorPath], {
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_PROCESSES_SUPERVISOR_NONCE: nonce,
        PI_PROCESSES_SUPERVISOR_GENERATION: String(options.generation),
        PI_PROCESSES_SESSION_SCOPE: options.sessionScopeId,
        PI_PROCESSES_PI_PID: String(process.pid),
        PI_PROCESSES_SUPERVISOR_ROOT: root,
        PI_PROCESSES_SUPERVISOR_HELPER_RUNTIME: options.runtimePath,
        [SUPERVISOR_EXECUTION_ISOLATION_ENV]: isolation,
      },
    });
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (!(input instanceof Writable) || !(output instanceof Readable)) {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      throw new Error("[process/supervisor-unavailable] fd3/fd4 pipes are unavailable");
    }
    const client = new SupervisorClient(options, child, input, output, nonce, root);
    try {
      await client.#handshake(options.sessionScopeId, options.launchTimeoutMs ?? 5_000);
      return client;
    } catch (error) {
      client.#close(error instanceof Error ? error : new Error(String(error)));
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      throw error;
    }
  }

  get supervisorPid(): number {
    if (!this.#supervisorPid) throw new Error("[process/supervisor-unavailable] supervisor is not ready");
    return this.#supervisorPid;
  }

  get platform(): string {
    if (!this.#platform) throw new Error("[process/supervisor-unavailable] supervisor is not ready");
    return this.#platform;
  }

  get closed(): boolean { return this.#closed; }

  async request(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.#ready || this.#closed) throw new Error("[process/supervisor-unavailable] supervisor channel is closed");
    const requestId = randomUUID();
    const sequence = ++this.#requestSequence;
    const deadline = timeoutMs ?? this.#requestTimeoutMs(type, payload);
    const frame: FrameV1 = {
      version: 1,
      hostNonce: this.hostNonce,
      supervisorGeneration: this.generation,
      type,
      requestId,
      requestSequence: sequence,
      payload,
    };
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        const error = new Error(`[process/protocol-timeout] supervisor ${type} timed out`);
        reject(error);
        this.#close(error);
      }, deadline);
      this.#pending.set(requestId, { sequence, timer, resolve, reject });
      if (!this.#input.write(encodeFrame(frame))) {
        this.#input.once("drain", () => undefined);
      }
    });
  }

  async cleanup(reason: string, timeoutMs = 35_000): Promise<Record<string, unknown>> {
    return await this.request("cleanup", { operationId: randomUUID(), reason }, timeoutMs);
  }

  async waitForExit(timeoutMs = 5_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.off("exit", onExit);
        this.child.off("close", onClose);
        resolve();
      };
      const onExit = (): void => finish();
      const onClose = (): void => finish();
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.child.off("exit", onExit);
        this.child.off("close", onClose);
        reject(new Error("[process/supervisor-unavailable] supervisor exit timed out"));
      }, timeoutMs);
      this.child.once("exit", onExit);
      this.child.once("close", onClose);
      if (this.child.exitCode !== null || this.child.signalCode !== null) finish();
    });
  }

  terminate(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      if (this.child.pid) process.kill(-this.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  close(): void {
    this.#close(new Error("[process/supervisor-unavailable] supervisor client closed"));
  }

  async #handshake(sessionScopeId: string, timeoutMs: number): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("[process/supervisor-unavailable] supervisor launch timed out")), timeoutMs);
      const fail = (error: Error): void => { clearTimeout(timer); reject(error); };
      this.child.once("error", fail);
      this.child.once("exit", (code, signal) => {
        if (!this.#ready) fail(new Error(`[process/supervisor-unavailable] supervisor exited before ready (${String(code)}/${String(signal)})`));
      });
      this.#output.on("data", (chunk: Buffer) => {
        try {
          for (const frame of this.#decoder.push(chunk)) {
            if (!this.#ready) {
              const value = exactReady(frame, this.hostNonce, this.generation);
              this.#supervisorPid = value.supervisorPid;
              this.#platform = value.platform;
              this.#ready = true;
              clearTimeout(timer);
              resolve();
            } else {
              this.#receive(frame);
            }
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          this.#close(error instanceof Error ? error : new Error(String(error)));
        }
      });
      this.#output.on("end", () => {
        try { this.#decoder.finish(); } catch (error) { this.#close(error instanceof Error ? error : new Error(String(error))); }
        if (!this.#closed) this.#close(new Error("[process/supervisor-unavailable] supervisor output ended"));
      });
      this.#output.on("error", (error) => this.#close(error));
    });
    this.#input.write(encodeFrame({
      version: 1,
      hostNonce: this.hostNonce,
      supervisorGeneration: this.generation,
      type: "hello",
      payload: { sessionScopeId, piPid: process.pid },
    }));
    await ready;
  }

  #receive(frame: FrameV1): void {
    if (frame.hostNonce !== this.hostNonce || frame.supervisorGeneration !== this.generation) {
      throw new ProtocolError("protocol-invalid", "supervisor frame identity mismatch");
    }
    if (frame.type === "response") {
      if (!frame.requestId || !frame.requestSequence || frame.eventSequence !== undefined) throw new ProtocolError("protocol-invalid", "response metadata is invalid");
      const pending = this.#pending.get(frame.requestId);
      if (!pending || pending.sequence !== frame.requestSequence) throw new ProtocolError("protocol-invalid", "response does not match a pending request");
      this.#pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      if (frame.payload.ok === true && frame.payload.result && typeof frame.payload.result === "object" && !Array.isArray(frame.payload.result)) {
        pending.resolve(frame.payload.result as Record<string, unknown>);
      } else if (frame.payload.ok === false) {
        pending.reject(errorFromResponse(frame.payload));
      } else {
        throw new ProtocolError("protocol-invalid", "response payload is invalid");
      }
      return;
    }
    if (!frame.eventSequence || frame.requestId || frame.requestSequence) throw new ProtocolError("protocol-invalid", "event metadata is invalid");
    if (frame.eventSequence !== this.#eventSequence + 1) throw new ProtocolError("protocol-invalid", "event sequence gap or regression");
    this.#eventSequence = frame.eventSequence;
    const event: SupervisorEvent = { type: frame.type, eventSequence: frame.eventSequence, payload: frame.payload };
    this.#eventQueue = this.#eventQueue.then(async () => {
      await this.#onEvent?.(event);
      if (!this.#closed) await this.request("eventAck", { eventSequence: event.eventSequence }, 5_000);
    }).catch((error) => this.#close(error instanceof Error ? error : new Error(String(error))));
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#input.destroy();
    this.#output.destroy();
    this.#onChannelLost?.(error);
  }
}
