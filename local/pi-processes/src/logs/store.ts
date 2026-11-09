import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LogStream, NormalizedLogRecord } from "./normalizer.js";

export interface StoredLogRecordV1 {
  version: 1;
  sequence: number;
  stream: LogStream;
  timestamp: string;
  text: string;
  terminated: boolean;
  truncated: boolean;
  utf8ReplacementBytes: number;
}

export interface SegmentMetaV1 {
  generation: number;
  file: string;
  bytes: number;
  firstSequence: number;
  lastSequence: number;
  stdoutRecords: number;
  stderrRecords: number;
  truncatedRecords: number;
  createdOrder: number;
}

export interface LogIndexV1 {
  version: 1;
  processId: string;
  revision: number;
  earliestSequence: number;
  nextSequence: number;
  retainedBytes: number;
  droppedBytes: number;
  droppedLines: number;
  droppedTruncatedPrefixes: number;
  segments: SegmentMetaV1[];
}

export interface LogPage {
  revision: number;
  earliestSequence: number;
  nextSequence: number;
  lines: StoredLogRecordV1[];
  nextCursor?: string;
  truncated: boolean;
  droppedBytes: number;
  droppedLines: number;
}

export interface LogReadOptions {
  stream: "stdout" | "stderr" | "both";
  limit: number;
  direction?: "forward" | "backward";
  cursor?: string;
  expectedRevision?: number;
  pattern?: string;
  mode?: "literal" | "regex";
}

export interface SessionLogStoreOptions {
  root: string;
  sessionScopeId: string;
  hostNonce: string;
  sessionBytes: number;
  now?: () => Date;
  segmentTargetBytes?: number;
}

export interface ProcessLogOptions {
  processId: string;
  perProcessBytes: number;
}

interface CursorV1 {
  version: 1;
  sessionScopeId: string;
  processId: string;
  revision: number;
  nextSequence: number;
  direction: "forward" | "backward";
  fingerprint: string;
}

const INDEX_VERSION = 1 as const;
const INDEX_ALLOWANCE_BYTES = 2 * 1024 * 1024;
const MIN_PROCESS_BYTES = 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_CURSOR_BYTES = 4096;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function storageError(code: string, message: string): Error {
  return new Error(`[process/${code}] ${message}`);
}

function assertProcessId(id: string): void {
  if (!/^proc_[0-9a-z]{12}$/.test(id)) throw storageError("storage-invalid", `invalid process ID ${JSON.stringify(id)}`);
}

function segmentName(id: string, generation: number): string {
  return `${id}.${generation.toString(16).padStart(8, "0")}.jsonl`;
}

function canonicalJsonLine(record: StoredLogRecordV1): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validateRecord(value: unknown): StoredLogRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storageError("storage-corrupt", "stored log record is not an object");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["version", "sequence", "stream", "timestamp", "text", "terminated", "truncated", "utf8ReplacementBytes"])
    || record.version !== 1
    || !isSafeInteger(record.sequence, 1)
    || (record.stream !== "stdout" && record.stream !== "stderr")
    || typeof record.timestamp !== "string"
    || !Number.isFinite(Date.parse(record.timestamp))
    || typeof record.text !== "string"
    || Buffer.byteLength(record.text, "utf8") > 65_536
    || typeof record.terminated !== "boolean"
    || typeof record.truncated !== "boolean"
    || !isSafeInteger(record.utf8ReplacementBytes)) {
    throw storageError("storage-corrupt", "stored log record has an invalid shape");
  }
  return record as unknown as StoredLogRecordV1;
}

function validateSegment(value: unknown, processId: string): SegmentMetaV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storageError("storage-corrupt", "segment metadata is not an object");
  const segment = value as Record<string, unknown>;
  if (!exactKeys(segment, ["generation", "file", "bytes", "firstSequence", "lastSequence", "stdoutRecords", "stderrRecords", "truncatedRecords", "createdOrder"])
    || !isSafeInteger(segment.generation, 1)
    || segment.file !== segmentName(processId, segment.generation as number)
    || !isSafeInteger(segment.bytes)
    || !isSafeInteger(segment.firstSequence, 1)
    || !isSafeInteger(segment.lastSequence, segment.firstSequence as number)
    || !isSafeInteger(segment.stdoutRecords)
    || !isSafeInteger(segment.stderrRecords)
    || !isSafeInteger(segment.truncatedRecords)
    || !isSafeInteger(segment.createdOrder, 1)) {
    throw storageError("storage-corrupt", "segment metadata has an invalid shape");
  }
  return segment as unknown as SegmentMetaV1;
}

function validateIndex(value: unknown, processId: string): LogIndexV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storageError("storage-corrupt", "log index is not an object");
  const index = value as Record<string, unknown>;
  if (!exactKeys(index, ["version", "processId", "revision", "earliestSequence", "nextSequence", "retainedBytes", "droppedBytes", "droppedLines", "droppedTruncatedPrefixes", "segments"])
    || index.version !== 1
    || index.processId !== processId
    || !isSafeInteger(index.revision)
    || !isSafeInteger(index.earliestSequence, 1)
    || !isSafeInteger(index.nextSequence, index.earliestSequence as number)
    || !isSafeInteger(index.retainedBytes)
    || !isSafeInteger(index.droppedBytes)
    || !isSafeInteger(index.droppedLines)
    || !isSafeInteger(index.droppedTruncatedPrefixes)
    || !Array.isArray(index.segments)) {
    throw storageError("storage-corrupt", "log index has an invalid shape");
  }
  const segments = index.segments.map((segment) => validateSegment(segment, processId));
  let lastSequence = 0;
  let lastGeneration = 0;
  let lastOrder = 0;
  let retainedBytes = 0;
  for (const segment of segments) {
    if (segment.generation <= lastGeneration || segment.createdOrder <= lastOrder || segment.firstSequence <= lastSequence) {
      throw storageError("storage-corrupt", "log index segment ordering is invalid");
    }
    lastGeneration = segment.generation;
    lastOrder = segment.createdOrder;
    lastSequence = segment.lastSequence;
    retainedBytes += segment.bytes;
  }
  if (retainedBytes !== index.retainedBytes) throw storageError("storage-corrupt", "log index retained byte count does not match segments");
  return { ...(index as unknown as LogIndexV1), segments };
}

function fingerprint(options: Pick<LogReadOptions, "stream" | "pattern" | "mode">): string {
  return JSON.stringify({ stream: options.stream, pattern: options.pattern ?? null, mode: options.mode ?? "literal" });
}

function compileFilter(options: Pick<LogReadOptions, "pattern" | "mode">): ((record: StoredLogRecordV1) => boolean) | undefined {
  if (options.pattern === undefined) return undefined;
  if (options.pattern.length === 0 || [...options.pattern].length > 500) throw storageError("invalid-arguments", "pattern must contain 1..500 characters");
  if (options.mode === "regex") {
    const regex = new RegExp(options.pattern, "u");
    return (record) => {
      regex.lastIndex = 0;
      return regex.test(record.text);
    };
  }
  return (record) => record.text.includes(options.pattern!);
}

class ProcessLogStore {
  readonly processId: string;
  readonly perProcessBytes: number;
  readonly #recordsDir: string;
  readonly #indexPath: string;
  readonly #segmentTargetBytes: number;
  readonly #now: () => Date;
  readonly #nextCreatedOrder: () => number;
  #index: LogIndexV1;
  #ready = false;

  constructor(options: {
    recordsDir: string;
    processId: string;
    perProcessBytes: number;
    segmentTargetBytes: number;
    now: () => Date;
    nextCreatedOrder: () => number;
  }) {
    assertProcessId(options.processId);
    if (!isSafeInteger(options.perProcessBytes, MIN_PROCESS_BYTES)) throw storageError("storage-invalid", "perProcessBytes is outside the supported range");
    this.processId = options.processId;
    this.perProcessBytes = options.perProcessBytes;
    this.#recordsDir = options.recordsDir;
    this.#indexPath = join(options.recordsDir, `${options.processId}.index`);
    this.#segmentTargetBytes = Math.min(options.segmentTargetBytes, options.perProcessBytes);
    this.#now = options.now;
    this.#nextCreatedOrder = options.nextCreatedOrder;
    this.#index = this.#emptyIndex();
  }

  get snapshot(): Readonly<LogIndexV1> {
    return structuredClone(this.#index);
  }

  async initialize(): Promise<void> {
    if (this.#ready) return;
    try {
      const source = await readFile(this.#indexPath, "utf8");
      this.#index = validateIndex(JSON.parse(source) as unknown, this.processId);
      await this.#verifySegments();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#writeIndex();
    }
    this.#ready = true;
  }

  async append(stream: LogStream, normalized: NormalizedLogRecord): Promise<StoredLogRecordV1> {
    await this.initialize();
    const record: StoredLogRecordV1 = {
      version: 1,
      sequence: this.#index.nextSequence,
      stream,
      timestamp: this.#now().toISOString(),
      text: normalized.text,
      terminated: normalized.terminated,
      truncated: normalized.truncated,
      utf8ReplacementBytes: normalized.utf8ReplacementBytes,
    };
    const bytes = canonicalJsonLine(record);
    let active = this.#index.segments.at(-1);
    if (!active || (active.bytes > 0 && active.bytes + bytes.length > this.#segmentTargetBytes)) {
      const generation = (active?.generation ?? 0) + 1;
      active = {
        generation,
        file: segmentName(this.processId, generation),
        bytes: 0,
        firstSequence: record.sequence,
        lastSequence: record.sequence,
        stdoutRecords: 0,
        stderrRecords: 0,
        truncatedRecords: 0,
        createdOrder: this.#nextCreatedOrder(),
      };
      this.#index.segments.push(active);
    }
    const path = this.#segmentPath(active.file);
    const handle = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | NOFOLLOW, 0o600);
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    active.bytes += bytes.length;
    active.lastSequence = record.sequence;
    if (stream === "stdout") active.stdoutRecords += 1;
    else active.stderrRecords += 1;
    if (record.truncated) active.truncatedRecords += 1;
    this.#index.nextSequence += 1;
    this.#index.retainedBytes += bytes.length;
    this.#index.revision += 1;
    await this.evictToProcessLimit();
    await this.#writeIndex();
    return record;
  }

  async addDropped(droppedBytes: number, droppedLines: number): Promise<void> {
    await this.initialize();
    if (!isSafeInteger(droppedBytes) || !isSafeInteger(droppedLines)) throw storageError("storage-invalid", "dropped counters must be non-negative integers");
    if (droppedBytes === 0 && droppedLines === 0) return;
    this.#index.droppedBytes += droppedBytes;
    this.#index.droppedLines += droppedLines;
    this.#index.revision += 1;
    await this.#writeIndex();
  }

  async read(options: LogReadOptions, cursorCodec: CursorCodec): Promise<LogPage> {
    await this.initialize();
    if (!isSafeInteger(options.limit, 1) || options.limit > MAX_READ_LINES) throw storageError("invalid-arguments", `limit must be 1..${MAX_READ_LINES}`);
    const direction = options.direction ?? "backward";
    const expectedFingerprint = fingerprint(options);
    let startSequence = direction === "backward" ? this.#index.nextSequence - 1 : this.#index.earliestSequence;
    if (options.expectedRevision !== undefined && options.expectedRevision !== this.#index.revision) throw storageError("cursor-stale", "log revision changed");
    if (options.cursor) {
      const cursor = cursorCodec.decode(options.cursor);
      if (cursor.processId !== this.processId || cursor.revision !== this.#index.revision || cursor.direction !== direction || cursor.fingerprint !== expectedFingerprint) {
        throw storageError("cursor-stale", "cursor does not match this log query");
      }
      startSequence = cursor.nextSequence;
    }
    if (startSequence < this.#index.earliestSequence - 1 || startSequence >= this.#index.nextSequence) throw storageError("cursor-stale", "cursor points outside retained logs");
    const filter = compileFilter(options);
    const records = await this.#readAllRecords();
    const ordered = direction === "backward" ? [...records].reverse() : records;
    const lines: StoredLogRecordV1[] = [];
    let lastVisited: number | undefined;
    for (const record of ordered) {
      if (direction === "backward" ? record.sequence > startSequence : record.sequence < startSequence) continue;
      lastVisited = record.sequence;
      if ((options.stream === "both" || record.stream === options.stream) && (!filter || filter(record))) lines.push(record);
      if (lines.length >= options.limit) break;
    }
    if (direction === "backward") lines.reverse();
    const nextSequence = lastVisited === undefined ? undefined : direction === "backward" ? lastVisited - 1 : lastVisited + 1;
    const hasMore = nextSequence !== undefined && (direction === "backward" ? nextSequence >= this.#index.earliestSequence : nextSequence < this.#index.nextSequence);
    return {
      revision: this.#index.revision,
      earliestSequence: this.#index.earliestSequence,
      nextSequence: this.#index.nextSequence,
      lines,
      nextCursor: hasMore ? cursorCodec.encode({
        version: 1,
        sessionScopeId: cursorCodec.sessionScopeId,
        processId: this.processId,
        revision: this.#index.revision,
        nextSequence,
        direction,
        fingerprint: expectedFingerprint,
      }) : undefined,
      truncated: this.#index.earliestSequence > 1 || this.#index.droppedLines > 0,
      droppedBytes: this.#index.droppedBytes,
      droppedLines: this.#index.droppedLines,
    };
  }

  async evictOldestSegment(): Promise<SegmentMetaV1 | undefined> {
    await this.initialize();
    const oldest = this.#index.segments.shift();
    if (!oldest) return undefined;
    await rm(this.#segmentPath(oldest.file), { force: true });
    this.#index.retainedBytes -= oldest.bytes;
    this.#index.earliestSequence = oldest.lastSequence + 1;
    this.#index.droppedLines += oldest.stdoutRecords + oldest.stderrRecords;
    this.#index.droppedBytes += oldest.bytes;
    this.#index.droppedTruncatedPrefixes += oldest.truncatedRecords;
    this.#index.revision += 1;
    await this.#writeIndex();
    return oldest;
  }

  async evictToProcessLimit(): Promise<void> {
    while (this.#index.retainedBytes > this.perProcessBytes && this.#index.segments.length > 0) await this.evictOldestSegment();
  }

  oldestSegment(): SegmentMetaV1 | undefined {
    return this.#index.segments[0];
  }

  async clear(): Promise<{ cleared: boolean; errorCode?: string }> {
    await this.initialize();
    try {
      for (const segment of [...this.#index.segments]) await rm(this.#segmentPath(segment.file));
      await rm(this.#indexPath);
      this.#index = { ...this.#emptyIndex(), revision: this.#index.revision + 1, earliestSequence: this.#index.nextSequence, nextSequence: this.#index.nextSequence };
      this.#ready = false;
      return { cleared: true };
    } catch (error) {
      return { cleared: false, errorCode: (error as NodeJS.ErrnoException).code ?? "delete-failed" };
    }
  }

  async retainedPhysicalBytes(): Promise<number> {
    await this.initialize();
    let total = 0;
    for (const segment of this.#index.segments) total += (await stat(this.#segmentPath(segment.file))).size;
    try { total += (await stat(this.#indexPath)).size; } catch {}
    return total;
  }

  #emptyIndex(): LogIndexV1 {
    return {
      version: INDEX_VERSION,
      processId: this.processId,
      revision: 0,
      earliestSequence: 1,
      nextSequence: 1,
      retainedBytes: 0,
      droppedBytes: 0,
      droppedLines: 0,
      droppedTruncatedPrefixes: 0,
      segments: [],
    };
  }

  async #readAllRecords(): Promise<StoredLogRecordV1[]> {
    const result: StoredLogRecordV1[] = [];
    let expected = this.#index.earliestSequence;
    for (const segment of this.#index.segments) {
      const source = await readFile(this.#segmentPath(segment.file), "utf8");
      if (source.length > 0 && !source.endsWith("\n")) throw storageError("storage-corrupt", "log segment contains a truncated JSON line");
      for (const line of source.split("\n")) {
        if (!line) continue;
        const record = validateRecord(JSON.parse(line) as unknown);
        if (record.sequence !== expected) throw storageError("storage-corrupt", "stored log sequence is not contiguous");
        result.push(record);
        expected += 1;
      }
    }
    return result;
  }

  async #verifySegments(): Promise<void> {
    for (const segment of this.#index.segments) {
      const path = this.#segmentPath(segment.file);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== segment.bytes) throw storageError("storage-corrupt", "segment file evidence does not match index");
    }
    await this.#readAllRecords();
  }

  #segmentPath(file: string): string {
    if (basename(file) !== file || !/^proc_[0-9a-z]{12}\.[0-9a-f]{8}\.jsonl$/.test(file)) throw storageError("storage-corrupt", "unsafe segment path");
    return join(this.#recordsDir, file);
  }

  async #writeIndex(): Promise<void> {
    const temp = `${this.#indexPath}.tmp`;
    const body = Buffer.from(JSON.stringify(this.#index), "utf8");
    if (body.length > INDEX_ALLOWANCE_BYTES) throw storageError("storage-unavailable", "log index exceeds maintenance allowance");
    const handle = await open(temp, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | NOFOLLOW, 0o600);
    try {
      await handle.write(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.#indexPath);
  }
}

class CursorCodec {
  readonly sessionScopeId: string;
  readonly #nonce: string;

  constructor(sessionScopeId: string, nonce: string) {
    this.sessionScopeId = sessionScopeId;
    this.#nonce = nonce;
  }

  encode(cursor: CursorV1): string {
    const body = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#nonce).update(body).digest("base64url");
    const encoded = `${body}.${signature}`;
    if (Buffer.byteLength(encoded) > MAX_CURSOR_BYTES) throw storageError("storage-invalid", "cursor exceeds maximum size");
    return encoded;
  }

  decode(encoded: string): CursorV1 {
    if (Buffer.byteLength(encoded) > MAX_CURSOR_BYTES) throw storageError("cursor-stale", "cursor exceeds maximum size");
    const [body, signature, extra] = encoded.split(".");
    if (!body || !signature || extra !== undefined) throw storageError("cursor-stale", "cursor is malformed");
    const expected = createHmac("sha256", this.#nonce).update(body).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, "base64url"); } catch { throw storageError("cursor-stale", "cursor signature is malformed"); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw storageError("cursor-stale", "cursor signature is invalid");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown; } catch { throw storageError("cursor-stale", "cursor body is malformed"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw storageError("cursor-stale", "cursor body is invalid");
    const cursor = value as Record<string, unknown>;
    if (!exactKeys(cursor, ["version", "sessionScopeId", "processId", "revision", "nextSequence", "direction", "fingerprint"])
      || cursor.version !== 1 || cursor.sessionScopeId !== this.sessionScopeId || typeof cursor.processId !== "string"
      || !isSafeInteger(cursor.revision) || !isSafeInteger(cursor.nextSequence)
      || (cursor.direction !== "forward" && cursor.direction !== "backward") || typeof cursor.fingerprint !== "string") {
      throw storageError("cursor-stale", "cursor body is invalid");
    }
    return cursor as unknown as CursorV1;
  }
}

export class SessionLogStore {
  readonly #root: string;
  readonly #recordsDir: string;
  readonly #sessionBytes: number;
  readonly #segmentTargetBytes: number;
  readonly #now: () => Date;
  readonly #cursorCodec: CursorCodec;
  readonly #stores = new Map<string, ProcessLogStore>();
  #createdOrder = 0;
  #ready = false;
  #degraded = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: SessionLogStoreOptions) {
    if (!isSafeInteger(options.sessionBytes, MIN_PROCESS_BYTES)) throw storageError("storage-invalid", "sessionBytes is outside the supported range");
    if (!/^[0-9a-f]{64}$/.test(options.hostNonce)) throw storageError("storage-invalid", "host nonce is invalid");
    this.#root = options.root;
    this.#recordsDir = join(options.root, "records");
    this.#sessionBytes = options.sessionBytes;
    this.#segmentTargetBytes = options.segmentTargetBytes ?? 4 * 1024 * 1024;
    this.#now = options.now ?? (() => new Date());
    this.#cursorCodec = new CursorCodec(options.sessionScopeId, options.hostNonce);
  }

  get degraded(): boolean { return this.#degraded; }

  async initialize(): Promise<void> {
    if (this.#ready) return;
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await mkdir(this.#recordsDir, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.#root);
    const recordsInfo = await lstat(this.#recordsDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !recordsInfo.isDirectory() || recordsInfo.isSymbolicLink()) throw storageError("storage-unavailable", "log root is not a safe directory");
    this.#ready = true;
  }

  async openProcess(options: ProcessLogOptions): Promise<void> {
    return this.#serialized(async () => {
      await this.initialize();
      if (this.#degraded) throw storageError("storage-unavailable", "log storage is degraded");
      if (this.#stores.has(options.processId)) throw storageError("conflict", `log store ${options.processId} already exists`);
      const store = this.#newStore(options);
      await store.initialize();
      this.#stores.set(options.processId, store);
      this.#createdOrder = Math.max(this.#createdOrder, ...store.snapshot.segments.map((segment) => segment.createdOrder), 0);
      await this.#evictSessionOldest();
    });
  }

  async append(processId: string, stream: LogStream, record: NormalizedLogRecord): Promise<StoredLogRecordV1> {
    let result!: StoredLogRecordV1;
    await this.#serialized(async () => {
      if (this.#degraded) throw storageError("storage-unavailable", "log storage is degraded");
      const store = this.#requireStore(processId);
      try {
        result = await store.append(stream, record);
        await this.#evictSessionOldest();
      } catch (error) {
        this.#degraded = true;
        throw error;
      }
    });
    return result;
  }

  async addDropped(processId: string, droppedBytes: number, droppedLines: number): Promise<void> {
    return this.#serialized(async () => this.#requireStore(processId).addDropped(droppedBytes, droppedLines));
  }

  async read(processId: string, options: LogReadOptions): Promise<LogPage> {
    return this.#serialized(async () => this.#requireStore(processId).read(options, this.#cursorCodec));
  }

  async clear(processIds: readonly string[]): Promise<Record<string, { cleared: boolean; errorCode?: string }>> {
    const result: Record<string, { cleared: boolean; errorCode?: string }> = {};
    await this.#serialized(async () => {
      for (const processId of processIds) {
        const store = this.#stores.get(processId);
        if (!store) {
          result[processId] = { cleared: false, errorCode: "not-found" };
          continue;
        }
        const outcome = await store.clear();
        result[processId] = outcome;
        if (outcome.cleared) this.#stores.delete(processId);
      }
    });
    return result;
  }

  async cleanup(): Promise<void> {
    await this.#serialized(async () => {
      await rm(this.#root, { recursive: true, force: true });
      this.#stores.clear();
      this.#ready = false;
    });
  }

  async health(): Promise<{ processCount: number; retainedBytes: number; degraded: boolean }> {
    return this.#serialized(async () => ({ processCount: this.#stores.size, retainedBytes: await this.#retainedBytes(), degraded: this.#degraded }));
  }

  #newStore(options: ProcessLogOptions): ProcessLogStore {
    return new ProcessLogStore({
      recordsDir: this.#recordsDir,
      processId: options.processId,
      perProcessBytes: options.perProcessBytes,
      segmentTargetBytes: this.#segmentTargetBytes,
      now: this.#now,
      nextCreatedOrder: () => ++this.#createdOrder,
    });
  }

  #requireStore(processId: string): ProcessLogStore {
    const store = this.#stores.get(processId);
    if (!store) throw storageError("not-found", `process ${processId} has no log store`);
    return store;
  }

  async #retainedBytes(): Promise<number> {
    let total = 0;
    for (const store of this.#stores.values()) total += await store.retainedPhysicalBytes();
    return total;
  }

  async #evictSessionOldest(): Promise<void> {
    while (await this.#retainedBytes() > this.#sessionBytes) {
      let candidate: ProcessLogStore | undefined;
      let order = Number.POSITIVE_INFINITY;
      for (const store of this.#stores.values()) {
        const oldest = store.oldestSegment();
        if (oldest && oldest.createdOrder < order) {
          order = oldest.createdOrder;
          candidate = store;
        }
      }
      if (!candidate) break;
      await candidate.evictOldestSegment();
    }
  }

  async #serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}
