import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, writeSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MatcherClient } from "../matchers/client.js";
import { validateExecutionIsolation, type ExecutionIsolationV1 } from "../execution-isolation.js";
import { commandEnvironment } from "./command-environment.js";
import { StreamNormalizer, type LogStream, type NormalizedLogRecord } from "../logs/normalizer.js";
import { SessionLogStore, type LogReadOptions, type StoredLogRecordV1 } from "../logs/store.js";
import { FrameDecoder, ProtocolError, encodeFrame, type FrameV1 } from "./protocol.js";
import {
  parseCleanup,
  parseClearRecords,
  parseEmpty,
  parseEventAck,
  parseInput,
  parseLogPage,
  parseLogSearch,
  parseCancel,
  parseShellProbe,
  parseSpawn,
  parseStop,
  parseWatchSet,
  type CleanupRequest,
  type SpawnRequest,
  type WatchDefinition,
} from "./types.js";

interface WatchState {
  definition: WatchDefinition;
  generation: number;
  lastAckSequence: number;
  enabled: boolean;
}

interface ManagedRecord {
  id: string;
  name: string;
  command: string;
  child: ChildProcessWithoutNullStreams;
  pid: number;
  pgid: number;
  stopGraceMs: number;
  timeoutMs?: number;
  startedAt: string;
  deadlineAt?: string;
  deadlineMonotonic?: number;
  deadlineTimer?: NodeJS.Timeout;
  timeoutKillAt?: number;
  signalError?: Error;
  stdout: StreamNormalizer;
  stderr: StreamNormalizer;
  stopRequested: boolean;
  terminalizing: boolean;
  terminal: boolean;
  stdinOpen: boolean;
  logRevision: number;
  latestSequence: number;
  stopTimer?: NodeJS.Timeout;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  eventsArmed: boolean;
  pendingEvents: Array<{ type: string; payload: Record<string, unknown> }>;
  logQueue: Promise<void>;
  matcherQueue: Promise<void>;
  watchRevision: number;
  watchGeneration: number;
  watches: Map<string, WatchState>;
}

interface RequestCacheEntry {
  hash: string;
  response: FrameV1;
}

interface RuntimeOptions {
  inputFd?: number;
  outputFd?: number;
  root: string;
  hostNonce: string;
  supervisorGeneration: number;
  sessionScopeId: string;
  piPid: number;
  sessionLogBytes?: number;
  matcherRuntimePath: string;
  matcherWorkerPath: string;
  isolation?: ExecutionIsolationV1;
}

const REQUEST_CACHE_LIMIT = 2048;
const DEFAULT_SESSION_LOG_BYTES = 256 * 1024 * 1024;
const SIGNAL_CHECK_MS = 25;
const MAX_TIMER_MS = 2_147_483_647;
const TIMEOUT_GRACE_MS = 5_000;
const KILL_REAP_MS = 1_000;
const CLEANUP_HARD_DEADLINE_MS = 33_000;

function debugSupervisor(event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.PI_PROCESSES_SUPERVISOR_DEBUG !== "1") return;
  process.stderr.write(`${JSON.stringify({ source: "pi-processes-supervisor", event, ...fields })}\n`);
}

function operationError(code: string, message: string): Error {
  return new Error(`[process/${code}] ${message}`);
}

function errorCode(error: unknown): string {
  if (error instanceof ProtocolError) return error.code;
  const match = error instanceof Error ? /^\[process\/([^\]]+)\]/.exec(error.message) : undefined;
  return match?.[1] ?? "operation-failed";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.replace(/^\[process\/[^\]]+\]\s*/, "") : "operation failed";
  return message.slice(0, 500);
}

function canonicalHash(frame: FrameV1): string {
  return JSON.stringify({
    type: frame.type,
    requestId: frame.requestId,
    requestSequence: frame.requestSequence,
    payload: frame.payload,
  });
}

function aliveGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export class SupervisorRuntime {
  readonly #input;
  readonly #output;
  readonly #inputFd: number;
  readonly #outputFd: number;
  readonly #decoder = new FrameDecoder();
  readonly #root: string;
  readonly #hostNonce: string;
  readonly #generation: number;
  readonly #sessionScopeId: string;
  readonly #piPid: number;
  readonly #isolation?: ExecutionIsolationV1;
  readonly #records = new Map<string, ManagedRecord>();
  readonly #terminal = new Set<string>();
  readonly #requestCache = new Map<number, RequestCacheEntry>();
  readonly #logStore: SessionLogStore;
  readonly #matcher: MatcherClient;
  readonly #cancelledRequests = new Set<string>();
  #ready = false;
  #closing = false;
  #cleanupWatchdog?: NodeJS.Timeout;
  #requestSequence = 0;
  #eventSequence = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RuntimeOptions) {
    this.#root = options.root;
    this.#hostNonce = options.hostNonce;
    this.#generation = options.supervisorGeneration;
    this.#sessionScopeId = options.sessionScopeId;
    this.#piPid = options.piPid;
    this.#isolation = options.isolation === undefined ? undefined : validateExecutionIsolation(options.isolation);
    this.#inputFd = options.inputFd ?? 3;
    this.#outputFd = options.outputFd ?? 4;
    this.#input = createReadStream("", { fd: this.#inputFd, autoClose: false });
    this.#output = createWriteStream("", { fd: this.#outputFd, autoClose: false });
    this.#logStore = new SessionLogStore({
      root: options.root,
      sessionScopeId: options.sessionScopeId,
      hostNonce: options.hostNonce,
      sessionBytes: options.sessionLogBytes ?? DEFAULT_SESSION_LOG_BYTES,
    });
    this.#matcher = new MatcherClient({
      runtimePath: options.matcherRuntimePath,
      workerPath: options.matcherWorkerPath,
    });
  }

  async start(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await this.#logStore.initialize();
    await writeFile(join(this.#root, "supervisor.json"), JSON.stringify({
      version: 1,
      hostNonce: this.#hostNonce,
      piPid: this.#piPid,
      supervisorPid: process.pid,
      generation: this.#generation,
    }), { mode: 0o600, flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await writeFile(join(this.#root, "supervisor.json"), JSON.stringify({
        version: 1,
        hostNonce: this.#hostNonce,
        piPid: this.#piPid,
        supervisorPid: process.pid,
        generation: this.#generation,
      }), { mode: 0o600 });
    });

    this.#output.on("drain", () => this.#input.resume());
    this.#input.on("data", (chunk) => this.#accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.#input.on("end", () => {
      this.#armCleanupWatchdog();
      this.#queue = this.#queue.then(() => this.#onParentEnd(), (error) => this.#failProtocol(error));
    });
    this.#input.on("error", (error) => void this.#failProtocol(error));
    this.#output.on("error", (error) => void this.#failProtocol(error));
  }

  #accept(chunk: Buffer): void {
    try {
      const frames = this.#decoder.push(chunk);
      for (const frame of frames) {
        if (frame.type === "cleanup") this.#armCleanupWatchdog();
        if (frame.type === "cancel") {
          try { this.#cancelledRequests.add(parseCancel(frame.payload).requestIdToCancel); } catch {}
        }
        this.#queue = this.#queue.then(() => this.#handleFrame(frame), (error) => this.#failProtocol(error));
      }
    } catch (error) {
      void this.#failProtocol(error);
    }
  }

  async #handleFrame(frame: FrameV1): Promise<void> {
    if (this.#closing) return;
    if (!this.#ready) {
      this.#acceptHello(frame);
      return;
    }
    if (frame.hostNonce !== this.#hostNonce || frame.supervisorGeneration !== this.#generation) {
      throw new ProtocolError("protocol-invalid", "nonce or generation mismatch");
    }
    if (!frame.requestId || !frame.requestSequence || frame.eventSequence !== undefined) {
      throw new ProtocolError("protocol-invalid", "request metadata is required");
    }
    const hash = canonicalHash(frame);
    const cached = this.#requestCache.get(frame.requestSequence);
    if (cached) {
      if (cached.hash !== hash) throw new ProtocolError("protocol-contradiction", "request replay is contradictory");
      this.#send(cached.response);
      return;
    }
    if (frame.requestSequence <= this.#requestSequence) {
      this.#respondError(frame, "operation-expired", "request is older than replay cache");
      return;
    }
    if (frame.requestSequence !== this.#requestSequence + 1) {
      throw new ProtocolError("protocol-sequence", "request sequence gap or regression");
    }
    this.#requestSequence = frame.requestSequence;

    let response: FrameV1;
    let succeeded = false;
    try {
      const result = await this.#dispatch(frame);
      response = this.#response(frame, { ok: true, result });
      succeeded = true;
      this.#cache(frame.requestSequence, hash, response);
      if (frame.type === "cleanup") {
        debugSupervisor("cleanup-dispatch-complete");
        this.#flushAndExit(response, 0);
        return;
      }
    } catch (error) {
      response = this.#response(frame, { ok: false, code: errorCode(error), message: errorMessage(error) });
      this.#cache(frame.requestSequence, hash, response);
      if (frame.type === "cleanup") {
        if (this.#closing) {
          debugSupervisor("cleanup-dispatch-failed", { code: errorCode(error) });
          await this.#forceCleanupAfterFailure();
          this.#flushAndExit(response, 1);
          return;
        }
        this.#clearCleanupWatchdog();
      }
    }
    this.#send(response);
    if (frame.type === "spawn" && succeeded) {
      const id = typeof frame.payload.id === "string" ? frame.payload.id : undefined;
      if (id) this.#armRecordEvents(id);
    }
  }

  #acceptHello(frame: FrameV1): void {
    if (frame.type !== "hello" || frame.requestId || frame.requestSequence || frame.eventSequence) {
      throw new ProtocolError("protocol-handshake", "first frame must be hello");
    }
    if (frame.hostNonce !== this.#hostNonce || frame.supervisorGeneration !== this.#generation) {
      throw new ProtocolError("protocol-handshake", "hello nonce or generation mismatch");
    }
    const { sessionScopeId, piPid } = frame.payload;
    if (sessionScopeId !== this.#sessionScopeId || piPid !== this.#piPid) {
      throw new ProtocolError("protocol-handshake", "hello identity mismatch");
    }
    this.#ready = true;
    this.#send({
      version: 1,
      hostNonce: this.#hostNonce,
      supervisorGeneration: this.#generation,
      type: "ready",
      payload: { supervisorPid: process.pid, platform: process.platform },
    });
  }

  async #dispatch(frame: FrameV1): Promise<Record<string, unknown>> {
    switch (frame.type) {
      case "shellProbe": return this.#shellProbe(parseShellProbe(frame.payload));
      case "spawn": return this.#spawn(parseSpawn(frame.payload));
      case "input": return this.#inputRequest(parseInput(frame.payload));
      case "stop": return this.#stop(parseStop(frame.payload));
      case "logPage": return this.#logPage(parseLogPage(frame.payload));
      case "watchSet": return this.#watchSet(parseWatchSet(frame.payload));
      case "logSearch": return this.#logSearch(frame.requestId!, parseLogSearch(frame.payload));
      case "cancel": return this.#cancel(parseCancel(frame.payload));
      case "clearRecords": return this.#clearRecords(parseClearRecords(frame.payload));
      case "health": return this.#health(parseEmpty(frame.payload));
      case "cleanup": return this.#cleanup(parseCleanup(frame.payload));
      case "eventAck": return { acknowledgedEventSequence: parseEventAck(frame.payload).eventSequence };
      default:
        throw operationError("operation-unsupported", `unknown request ${frame.type}`);
    }
  }

  async #shellProbe(payload: { shell: string }): Promise<Record<string, unknown>> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(payload.shell, ["-c", "exit 0"], { stdio: "ignore", env: commandEnvironment(process.env, this.#isolation) });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(operationError("shell-unsupported", "shell probe timed out"));
      }, 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(operationError("shell-unsupported", error.message)); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(operationError("shell-unsupported", `shell exited with ${String(code)}`));
      });
    });
    return { supported: true };
  }

  async #spawn(payload: SpawnRequest): Promise<Record<string, unknown>> {
    if (this.#records.has(payload.id) || this.#terminal.has(payload.id)) throw operationError("conflict", `process ${payload.id} already exists`);
    await this.#logStore.openProcess({ processId: payload.id, perProcessBytes: payload.logLimits.perProcessBytes });
    let child: ChildProcessWithoutNullStreams;
    let startedAtMs = 0;
    let startedMonotonic = 0;
    try {
      child = spawn(payload.shell, ["-c", payload.command], {
        cwd: payload.cwd,
        env: commandEnvironment(process.env, this.#isolation),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          startedAtMs = Date.now();
          startedMonotonic = performance.now();
          child.off("error", onError);
          resolve();
        };
        const onError = (error: Error): void => { child.off("spawn", onSpawn); reject(error); };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      await this.#logStore.clear([payload.id]);
      throw operationError("spawn-failed", errorMessage(error));
    }
    const pid = child.pid;
    if (!pid || pid <= 0 || pid === process.pid || pid === this.#piPid) {
      child.kill("SIGKILL");
      await this.#logStore.clear([payload.id]);
      throw operationError("spawn-failed", "spawn did not return a safe PID");
    }
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    const deadline = payload.timeoutMs === undefined ? undefined : new Date(startedAtMs + payload.timeoutMs);
    const record: ManagedRecord = {
      id: payload.id,
      name: payload.name,
      command: payload.command,
      child,
      pid,
      pgid: pid,
      stopGraceMs: payload.stopGraceMs,
      timeoutMs: payload.timeoutMs,
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: deadline && Number.isFinite(deadline.getTime()) ? deadline.toISOString() : undefined,
      deadlineMonotonic: payload.timeoutMs === undefined ? undefined : startedMonotonic + payload.timeoutMs,
      stdout: new StreamNormalizer(),
      stderr: new StreamNormalizer(),
      stopRequested: false,
      terminalizing: false,
      terminal: false,
      stdinOpen: true,
      logRevision: 0,
      latestSequence: 0,
      terminalPromise,
      resolveTerminal,
      eventsArmed: false,
      pendingEvents: [],
      logQueue: Promise.resolve(),
      matcherQueue: Promise.resolve(),
      watchRevision: 0,
      watchGeneration: payload.watches.length,
      watches: new Map(payload.watches.map((definition, index) => [definition.key, {
        definition,
        generation: index + 1,
        lastAckSequence: 0,
        enabled: true,
      }])),
    };
    this.#records.set(record.id, record);
    child.stdout.on("data", (chunk: Buffer) => this.#queueLog(record, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#queueLog(record, "stderr", chunk));
    child.stdin.on("close", () => { record.stdinOpen = false; });
    child.once("exit", (code, signal) => void this.#terminalize(record, code, signal).catch((error) => this.#failProtocol(error)));
    child.once("error", (error) => void this.#terminalize(record, null, null, error).catch((failure) => this.#failProtocol(failure)));
    this.#armDeadline(record);
    return {
      pid, pgid: pid, stdinOpen: true, watchRevision: 0, logRevision: 0,
      startedAt: record.startedAt,
      ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt }),
      ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
    };
  }

  #armDeadline(record: ManagedRecord): void {
    const deadline = record.timeoutKillAt ?? record.deadlineMonotonic;
    if (deadline === undefined || record.terminal) return;
    const remaining = deadline - performance.now();
    record.deadlineTimer = setTimeout(() => {
      record.deadlineTimer = undefined;
      // An expired group still needs KILL while its leader is terminalizing.
      if (record.terminal || (record.terminalizing && record.timeoutKillAt === undefined)) return;
      if (performance.now() < deadline) this.#armDeadline(record);
      else if (record.timeoutKillAt === undefined) this.#expire(record);
      else void this.#killTimedOutGroup(record).catch((error) => this.#failProtocol(error));
    }, Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(remaining))));
    record.deadlineTimer.unref?.();
  }

  #signalRecord(record: ManagedRecord, signal: NodeJS.Signals): boolean {
    try { return signalGroup(record.pgid, signal); }
    catch (error) {
      const failure = operationError("signal-failed", `${signal} to process group ${record.pgid} failed: ${error instanceof Error ? error.message : String(error)}`);
      record.signalError ??= failure;
      throw failure;
    }
  }

  #expire(record: ManagedRecord): void {
    if (record.terminal || record.terminalizing || record.timeoutKillAt !== undefined) return;
    record.timeoutKillAt = performance.now() + TIMEOUT_GRACE_MS;
    try { this.#signalRecord(record, "SIGTERM"); } catch { /* Retain the failure while the fixed KILL deadline stays armed. */ }
    this.#armDeadline(record);
  }

  async #killTimedOutGroup(record: ManagedRecord): Promise<void> {
    if (record.terminal) return;
    if (aliveGroup(record.pgid)) this.#signalRecord(record, "SIGKILL");
    await this.#waitForGroupExit(record.pgid, KILL_REAP_MS);
    if (aliveGroup(record.pgid)) throw operationError("cleanup-incomplete", `process group ${record.pgid} remains after timeout SIGKILL${record.signalError ? `; ${record.signalError.message}` : ""}`);
  }

  async #inputRequest(payload: { operationId: string; id: string; dataBase64?: string; eof: boolean }): Promise<Record<string, unknown>> {
    const record = this.#requireLive(payload.id);
    if (!record.stdinOpen || !record.child.stdin.writable) throw operationError("stdin-closed", `stdin for ${payload.id} is closed`);
    const data = payload.dataBase64 ? Buffer.from(payload.dataBase64, "base64") : Buffer.alloc(0);
    if (data.length > 65_536) throw operationError("invalid-arguments", "decoded input exceeds 65536 bytes");
    if (data.length > 0) {
      await new Promise<void>((resolve, reject) => {
        record.child.stdin.write(data, (error) => error ? reject(operationError("stdin-failed", error.message)) : resolve());
      });
    }
    if (payload.eof) {
      await new Promise<void>((resolve, reject) => record.child.stdin.end((error?: Error | null) => error ? reject(operationError("stdin-failed", error.message)) : resolve()));
      record.stdinOpen = false;
    }
    return { bytesAccepted: data.length, stdinOpen: record.stdinOpen };
  }

  async #stop(payload: { operationId: string; id: string }): Promise<Record<string, unknown>> {
    const record = this.#requireLive(payload.id);
    record.stopRequested = true;
    const delivered = this.#signalRecord(record, "SIGTERM");
    if (delivered && !record.stopTimer && record.timeoutKillAt === undefined) {
      record.stopTimer = setTimeout(() => {
        try { if (!record.terminal) this.#signalRecord(record, "SIGKILL"); }
        catch (error) { void this.#failProtocol(error); }
      }, record.stopGraceMs);
      record.stopTimer.unref?.();
    }
    return { signal: "SIGTERM", delivered };
  }

  async #logPage(payload: ReturnType<typeof parseLogPage>): Promise<Record<string, unknown>> {
    const page = await this.#logStore.read(payload.id, {
      stream: payload.stream,
      limit: payload.tailLines,
      cursor: payload.cursor,
      expectedRevision: payload.expectedLogRevision,
      direction: "backward",
    });
    if (!payload.pattern) return page as unknown as Record<string, unknown>;
    const matched = await this.#matcher.match({
      mode: payload.mode ?? "literal",
      pattern: payload.pattern,
      records: page.lines.map(({ sequence, text }) => ({ sequence, text })),
    });
    const sequences = new Set(matched.matches);
    return { ...page, lines: page.lines.filter((line) => sequences.has(line.sequence)) } as unknown as Record<string, unknown>;
  }

  async #watchSet(payload: ReturnType<typeof parseWatchSet>): Promise<Record<string, unknown>> {
    const record = this.#requireLive(payload.id);
    if (payload.expectedWatchRevision !== record.watchRevision) {
      throw operationError("conflict", `watch revision changed from ${payload.expectedWatchRevision} to ${record.watchRevision}`);
    }
    const nextGeneration = record.watchGeneration + 1;
    record.watches = new Map(payload.definitions.map((definition) => [definition.key, {
      definition,
      generation: nextGeneration,
      lastAckSequence: record.latestSequence,
      enabled: true,
    }]));
    record.watchGeneration = nextGeneration;
    record.watchRevision += 1;
    return { watchRevision: record.watchRevision, armedAfterSequence: record.latestSequence };
  }

  async #logSearch(requestId: string, payload: ReturnType<typeof parseLogSearch>): Promise<Record<string, unknown>> {
    if (this.#cancelledRequests.delete(requestId)) throw operationError("operation-cancelled", "log search was cancelled");
    const page = await this.#logStore.read(payload.id, {
      stream: payload.stream,
      limit: 2_000,
      cursor: payload.cursor,
      direction: "forward",
    });
    const matched = await this.#matcher.match({
      mode: payload.mode,
      pattern: payload.pattern,
      records: page.lines.map(({ sequence, text }) => ({ sequence, text })),
    });
    if (this.#cancelledRequests.delete(requestId)) throw operationError("operation-cancelled", "log search was cancelled");
    const matches = new Set(matched.matches);
    return {
      revision: page.revision,
      matches: page.lines.filter((line) => matches.has(line.sequence)).slice(0, payload.pageSize),
      nextCursor: page.nextCursor,
      truncated: page.truncated,
      droppedBytes: page.droppedBytes,
      droppedLines: page.droppedLines,
    };
  }

  async #cancel(payload: ReturnType<typeof parseCancel>): Promise<Record<string, unknown>> {
    this.#cancelledRequests.add(payload.requestIdToCancel);
    return { cancelledRequestId: payload.requestIdToCancel };
  }

  async #clearRecords(payload: ReturnType<typeof parseClearRecords>): Promise<Record<string, unknown>> {
    for (const id of payload.ids) {
      const record = this.#records.get(id);
      if (record && !record.terminal) throw operationError("conflict", `process ${id} is still live`);
    }
    const outcomes = await this.#logStore.clear(payload.ids);
    for (const [id, outcome] of Object.entries(outcomes)) {
      if (!outcome.cleared) continue;
      this.#terminal.delete(id);
      this.#records.delete(id);
    }
    return { outcomes };
  }

  async #health(_: Record<string, never>): Promise<Record<string, unknown>> {
    const logs = await this.#logStore.health();
    return {
      generation: this.#generation,
      supervisorPid: process.pid,
      live: [...this.#records.values()].filter((record) => !record.terminal).length,
      terminal: this.#terminal.size,
      retainedLogBytes: logs.retainedBytes,
      storage: logs.degraded ? "degraded" : "healthy",
      matcher: this.#matcher.circuitOpen ? "disabled" : "healthy",
      latestEventSequence: this.#eventSequence,
    };
  }

  async #cleanup(payload: CleanupRequest): Promise<Record<string, unknown>> {
    this.#beginCleanup();
    const owned = [...this.#records.values()];
    const live = owned.filter((record) => !record.terminal);
    for (const record of owned) {
      record.stopRequested = true;
      if (aliveGroup(record.pgid)) this.#signalRecord(record, "SIGTERM");
    }
    await Promise.all(owned.map(async (record) => {
      let graceTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          record.terminalPromise,
          new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, record.stopGraceMs); }),
        ]);
      } finally { if (graceTimer) clearTimeout(graceTimer); }
      if (record.timeoutKillAt === undefined && aliveGroup(record.pgid)) this.#signalRecord(record, "SIGKILL");
      await record.terminalPromise;
    }));
    const unresolved = owned.filter((record) => aliveGroup(record.pgid)).length;
    this.#matcher.close();
    await this.#logStore.cleanup();
    return {
      reason: payload.reason,
      liveStopped: live.filter((record) => !aliveGroup(record.pgid)).length,
      unresolved,
      recordsClosed: this.#terminal.size,
    };
  }

  #queueLog(record: ManagedRecord, stream: LogStream, chunk: Buffer): void {
    record.logQueue = record.logQueue.then(async () => {
      const normalizer = stream === "stdout" ? record.stdout : record.stderr;
      const before = normalizer.counters;
      const normalized = normalizer.push(chunk);
      await this.#persist(record, stream, normalized, before);
    }).catch(() => undefined);
  }

  async #persist(record: ManagedRecord, stream: LogStream, normalized: NormalizedLogRecord[], before: Readonly<{ droppedBytes: number; droppedLines: number }>): Promise<void> {
    for (const item of normalized) {
      const stored = await this.#logStore.append(record.id, stream, item);
      record.latestSequence = stored.sequence;
      this.#queueWatchMatch(record, stored);
    }
    const after = (stream === "stdout" ? record.stdout : record.stderr).counters;
    const droppedBytes = after.droppedBytes - before.droppedBytes;
    const droppedLines = after.droppedLines - before.droppedLines;
    if (droppedBytes > 0 || droppedLines > 0) await this.#logStore.addDropped(record.id, droppedBytes, droppedLines);
    const page = await this.#logStore.read(record.id, { stream: "both", limit: 1 });
    record.logRevision = page.revision;
    if (normalized.length > 0 || droppedBytes > 0 || droppedLines > 0) {
      this.#emitRecordEvent(record, "logCursorAdvanced", {
        id: record.id,
        logRevision: page.revision,
        earliestSequence: page.earliestSequence,
        nextSequence: page.nextSequence,
        droppedBytes: page.droppedBytes,
        droppedLines: page.droppedLines,
      });
    }
  }

  #queueWatchMatch(record: ManagedRecord, stored: StoredLogRecordV1): void {
    record.matcherQueue = record.matcherQueue.then(async () => {
      for (const watch of record.watches.values()) {
        if (!watch.enabled || stored.sequence <= watch.lastAckSequence) continue;
        if (watch.definition.stream !== "both" && watch.definition.stream !== stored.stream) {
          watch.lastAckSequence = stored.sequence;
          continue;
        }
        try {
          const result = await this.#matcher.match({
            mode: watch.definition.mode,
            pattern: watch.definition.pattern,
            records: [{ sequence: stored.sequence, text: stored.text }],
          });
          watch.lastAckSequence = stored.sequence;
          if (result.matches.length === 0) continue;
          this.#emitRecordEvent(record, "watchMatch", {
            id: record.id,
            key: watch.definition.key,
            generation: watch.generation,
            sequence: stored.sequence,
            stream: stored.stream,
            text: stored.text,
          });
          if (!watch.definition.repeat) watch.enabled = false;
        } catch (error) {
          watch.enabled = false;
          this.#emitRecordEvent(record, "matcherError", {
            id: record.id,
            key: watch.definition.key,
            generation: watch.generation,
            sequence: stored.sequence,
            code: errorCode(error),
          });
        }
      }
    }).catch(() => undefined);
  }

  async #terminalize(record: ManagedRecord, exitCode: number | null, signal: NodeJS.Signals | null, error?: Error): Promise<void> {
    if (record.terminal || record.terminalizing) return;
    record.terminalizing = true;
    record.stdinOpen = false;
    if (aliveGroup(record.pgid)) {
      if (record.timeoutKillAt === undefined) this.#signalRecord(record, "SIGKILL");
      while (aliveGroup(record.pgid)) await new Promise((resolve) => setTimeout(resolve, SIGNAL_CHECK_MS));
    }
    if (record.stopTimer) clearTimeout(record.stopTimer);
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
    await record.logQueue;
    const outBefore = record.stdout.counters;
    const errBefore = record.stderr.counters;
    await this.#persist(record, "stdout", record.stdout.finish(), outBefore).catch(() => undefined);
    await this.#persist(record, "stderr", record.stderr.finish(), errBefore).catch(() => undefined);
    await record.matcherQueue;
    record.terminal = true;
    if (record.eventsArmed) this.#records.delete(record.id);
    this.#terminal.add(record.id);
    record.resolveTerminal();
    this.#emitRecordEvent(record, "terminal", {
      id: record.id,
      pid: record.pid,
      pgid: record.pgid,
      exitCode,
      signal,
      classification: record.timeoutKillAt !== undefined ? "timeout" : error ? "error" : record.stopRequested ? "stopped" : exitCode === 0 ? "natural" : "failed",
      ...(record.timeoutKillAt === undefined ? {} : { cause: "timeout", timeoutMs: record.timeoutMs }),
      ...(record.signalError ? { code: "signal-failed", message: errorMessage(record.signalError) } : {}),
      endedAt: new Date().toISOString(),
      logRevision: record.logRevision,
      finalMatcherSequence: record.latestSequence,
    });
  }

  #armRecordEvents(id: string): void {
    const record = this.#records.get(id);
    if (!record) return;
    record.eventsArmed = true;
    for (const pending of record.pendingEvents.splice(0)) this.#emitEvent(pending.type, pending.payload);
    if (record.terminal) this.#records.delete(id);
  }

  #emitRecordEvent(record: ManagedRecord, type: string, payload: Record<string, unknown>): void {
    if (!record.eventsArmed) {
      record.pendingEvents.push({ type, payload });
      return;
    }
    this.#emitEvent(type, payload);
  }

  #requireLive(id: string): ManagedRecord {
    const record = this.#records.get(id);
    if (!record || record.terminal) throw operationError("not-found", `live process ${id} was not found`);
    return record;
  }

  #response(request: FrameV1, payload: Record<string, unknown>): FrameV1 {
    return {
      version: 1,
      hostNonce: this.#hostNonce,
      supervisorGeneration: this.#generation,
      type: "response",
      requestId: request.requestId,
      requestSequence: request.requestSequence,
      payload,
    };
  }

  #respondError(request: FrameV1, code: string, message: string): void {
    this.#send(this.#response(request, { ok: false, code, message }));
  }

  #emitEvent(type: string, payload: Record<string, unknown>): void {
    if (!this.#ready || this.#closing) return;
    this.#send({
      version: 1,
      hostNonce: this.#hostNonce,
      supervisorGeneration: this.#generation,
      type,
      eventSequence: ++this.#eventSequence,
      payload,
    });
  }

  #send(frame: FrameV1, onFlushed?: () => void): void {
    if (!this.#output.write(encodeFrame(frame), onFlushed)) this.#input.pause();
  }

  #hasLiveGroups(): boolean {
    for (const record of this.#records.values()) if (aliveGroup(record.pgid)) return true;
    return false;
  }

  #cache(sequence: number, hash: string, response: FrameV1): void {
    this.#requestCache.set(sequence, { hash, response });
    while (this.#requestCache.size > REQUEST_CACHE_LIMIT) {
      const oldest = this.#requestCache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#requestCache.delete(oldest);
    }
  }

  async #onParentEnd(): Promise<void> {
    try {
      this.#decoder.finish();
    } catch {}
    if (this.#closing) return;
    try {
      await this.#cleanup({ operationId: randomUUID(), reason: "pi-exit" });
      this.#closeTransport(0);
    } catch (error) {
      process.stderr.write(`${errorMessage(error)}\n`);
      await this.#forceCleanupAfterFailure();
      this.#closeTransport(1);
    }
  }

  #beginCleanup(): void {
    this.#closing = true;
    this.#armCleanupWatchdog();
  }

  #armCleanupWatchdog(): void {
    if (this.#cleanupWatchdog) return;
    this.#cleanupWatchdog = setTimeout(() => {
      this.#forceKillOwnedGroups();
      this.#matcher.close();
      this.#closeTransport(1);
    }, CLEANUP_HARD_DEADLINE_MS);
  }

  #clearCleanupWatchdog(): void {
    if (!this.#cleanupWatchdog) return;
    clearTimeout(this.#cleanupWatchdog);
    this.#cleanupWatchdog = undefined;
  }

  async #waitForGroupExit(pgid: number, timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (aliveGroup(pgid) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SIGNAL_CHECK_MS));
    }
  }

  #forceKillOwnedGroups(): void {
    for (const record of this.#records.values()) {
      try {
        if (aliveGroup(record.pgid)) this.#signalRecord(record, "SIGKILL");
      } catch (error) { process.stderr.write(`${errorMessage(error)}\n`); }
    }
  }

  async #forceCleanupAfterFailure(): Promise<void> {
    this.#forceKillOwnedGroups();
    await Promise.all([...this.#records.values()].map((record) => this.#waitForGroupExit(record.pgid, KILL_REAP_MS).catch(() => undefined)));
    this.#matcher.close();
  }

  #flushAndExit(frame: FrameV1, exitCode: number): void {
    this.#clearCleanupWatchdog();
    const encoded = encodeFrame(frame);
    if (!this.#input.destroyed) this.#input.destroy();
    try {
      let offset = 0;
      while (offset < encoded.length) offset += writeSync(this.#outputFd, encoded, offset, encoded.length - offset);
    } catch {
      exitCode = 1;
    }
    try { closeSync(this.#inputFd); } catch {}
    try { closeSync(this.#outputFd); } catch {}
    process.exit(exitCode);
  }

  #closeTransport(exitCode: number): void {
    this.#clearCleanupWatchdog();
    if (!this.#input.destroyed) this.#input.destroy();
    if (!this.#output.destroyed) this.#output.destroy();
    try { closeSync(this.#inputFd); } catch {}
    try { closeSync(this.#outputFd); } catch {}
    process.exit(exitCode);
  }

  async #failProtocol(error: unknown): Promise<void> {
    process.stderr.write(`${errorMessage(error)}\n`);
    if (this.#closing) {
      this.#forceKillOwnedGroups();
      this.#matcher.close();
      this.#closeTransport(1);
      return;
    }
    this.#closing = true;
    const correlationId = randomUUID();
    try {
      if (this.#ready) this.#send({
        version: 1,
        hostNonce: this.#hostNonce,
        supervisorGeneration: this.#generation,
        type: "protocolFailure",
        eventSequence: ++this.#eventSequence,
        payload: { code: errorCode(error), message: errorMessage(error), correlationId },
      });
    } catch {}
    for (const record of this.#records.values()) {
      record.stopRequested = true;
      try { this.#signalRecord(record, "SIGTERM"); }
      catch (failure) { process.stderr.write(`${errorMessage(failure)}\n`); }
    }
    setTimeout(() => {
      this.#forceKillOwnedGroups();
      this.#closeTransport(1);
    }, 1_000).unref?.();
  }
}
