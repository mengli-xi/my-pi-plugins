import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canonicalJson } from "../capabilities/canonical.js";
import { isDomainId } from "../domain/ids.js";
import {
  ensurePrivateDirectory,
  inspectPrivateDirectory,
  inspectPrivateFile,
  syncDirectory,
  type SafeFsOptionsV1,
} from "./fs-safe.js";
import { diagnosticBaseName, isDiagnosticName, PRIVATE_FILE_MODE } from "./layout.js";

const ROTATE_BYTES = 1_048_576;
const MAX_DIRECTORY_BYTES = 33_554_432;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 4096;
const MAX_MESSAGE_BYTES = 1024;
const ABSOLUTE_PATH = /(?:^|\s)(?:\/[A-Za-z0-9._~-][^\s]*|[A-Za-z]:[\\/][^\s]*)/u;
const SENSITIVE = /\b(?:authorization|cookie|credential|password|prompt|role[_ -]?body|mailbox|tool[_ -]?result|nonce|token|owner[_ -]?frame|rpc[_ -]?frame)\b/iu;
const CONTROL_TEST = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const CONTROL_REPLACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

export type DiagnosticSeverityV1 = "debug" | "info" | "warning" | "error";

export interface DiagnosticRecordInputV1 {
  readonly severity: DiagnosticSeverityV1;
  readonly code: string;
  readonly correlation_id?: string;
  readonly main_key_prefix?: string;
  readonly agent_id?: string;
  readonly runtime_generation?: number;
  readonly message: string;
}

export interface DiagnosticWriterOptionsV1 {
  readonly pid?: number;
  readonly processNonce16: string;
  readonly now?: () => Date;
  readonly fs?: SafeFsOptionsV1;
}

export interface DiagnosticHealthV1 {
  readonly degraded: boolean;
  readonly code?: "diagnostics-unavailable";
}

export class DiagnosticWriterV1 {
  readonly directory: string;
  readonly basePath: string;
  readonly options: DiagnosticWriterOptionsV1;
  #lastMaintenanceMs = 0;
  #health: DiagnosticHealthV1 = Object.freeze({ degraded: false });

  constructor(directory: string, options: DiagnosticWriterOptionsV1) {
    this.directory = directory;
    this.options = options;
    this.basePath = join(directory, diagnosticBaseName(options.pid ?? process.pid, options.processNonce16));
  }

  health(): DiagnosticHealthV1 { return this.#health; }

  async initialize(): Promise<void> {
    try {
      await ensurePrivateDirectory(this.directory, this.options.fs);
      await this.maintain(true);
    } catch {
      this.#degrade();
    }
  }

  async write(input: DiagnosticRecordInputV1): Promise<void> {
    // 记录本身不合规（含绝对路径、敏感词、超界）是调用方的问题，丢掉这一条即可。
    // 把它算成 I/O 故障会让整个 writer 永久停在 diagnostics-unavailable，之后所有诊断都写不出来。
    let line: Buffer;
    try { line = this.#encode(input); } catch { return; }
    try {
      await inspectPrivateDirectory(this.directory, this.options.fs);
      await this.#rotateIfNeeded(line.byteLength);
      await this.options.fs?.fault?.("before-open", this.basePath);
      const handle = await open(this.basePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.uid !== (this.options.fs?.uid ?? process.getuid?.()) || (stats.mode & 0o777) !== PRIVATE_FILE_MODE || stats.nlink !== 1) {
          throw new Error("diagnostic file identity is unsafe");
        }
        await this.options.fs?.fault?.("after-open", this.basePath);
        await this.options.fs?.fault?.("before-write", this.basePath);
        let offset = 0;
        while (offset < line.length) {
          const result = await handle.write(line, offset, line.length - offset, null);
          if (result.bytesWritten <= 0) throw new Error("diagnostic short write");
          offset += result.bytesWritten;
        }
        await this.options.fs?.fault?.("after-write", this.basePath);
      } finally { await handle.close(); }
      await this.maintain(false);
    } catch {
      this.#degrade();
    }
  }

  async maintain(force: boolean): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (!force && now - this.#lastMaintenanceMs < MAINTENANCE_INTERVAL_MS) return;
    this.#lastMaintenanceMs = now;
    try {
      await inspectPrivateDirectory(this.directory, this.options.fs);
      const safe: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
      let total = 0;
      for (const name of await readdir(this.directory)) {
        const path = join(this.directory, name);
        if (!isDiagnosticName(name)) throw new Error("unexpected diagnostics entry");
        const stats = await inspectPrivateFile(path, this.options.fs);
        const bytes = Number(stats.size);
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("diagnostic size is invalid");
        total += bytes;
        safe.push({ path, bytes, mtimeMs: stats.mtimeMs });
      }
      safe.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
      for (const entry of safe) {
        if (entry.path === this.basePath) continue;
        if (entry.mtimeMs < now - MAX_AGE_MS || total > MAX_DIRECTORY_BYTES) {
          await rm(entry.path);
          total -= entry.bytes;
        }
      }
      await syncDirectory(this.directory, this.options.fs);
    } catch {
      this.#degrade();
    }
  }

  #degrade(): void {
    if (!this.#health.degraded) this.#health = Object.freeze({ degraded: true, code: "diagnostics-unavailable" });
  }

  #encode(input: DiagnosticRecordInputV1): Buffer {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["severity", "code", "correlation_id", "main_key_prefix", "agent_id", "runtime_generation", "message"].includes(key))) {
      throw new Error("diagnostic input is invalid");
    }
    if (!["debug", "info", "warning", "error"].includes(input.severity)) throw new Error("diagnostic severity is invalid");
    const code = singleLine(input.code, "code", 128);
    const message = sanitizeMessage(input.message);
    if (input.correlation_id !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.correlation_id)) throw new Error("diagnostic correlation id is invalid");
    if (input.main_key_prefix !== undefined && !/^[A-Za-z0-9_-]{1,16}$/u.test(input.main_key_prefix)) throw new Error("diagnostic Main prefix is invalid");
    if (input.agent_id !== undefined && !isDomainId(input.agent_id, "agt")) throw new Error("diagnostic Agent id is invalid");
    if (input.runtime_generation !== undefined && (!Number.isSafeInteger(input.runtime_generation) || input.runtime_generation <= 0)) throw new Error("diagnostic runtime generation is invalid");
    const record = {
      version: 1,
      timestamp: exactTimestamp((this.options.now ?? (() => new Date()))()),
      severity: input.severity,
      code,
      ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
      ...(input.main_key_prefix === undefined ? {} : { main_key_prefix: input.main_key_prefix }),
      ...(input.agent_id === undefined ? {} : { agent_id: input.agent_id }),
      ...(input.runtime_generation === undefined ? {} : { runtime_generation: input.runtime_generation }),
      message,
    };
    const result = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (result.byteLength > MAX_RECORD_BYTES) throw new Error("diagnostic record exceeds 4096 bytes");
    return result;
  }

  async #rotateIfNeeded(nextBytes: number): Promise<void> {
    let currentBytes = 0;
    try {
      const stats = await inspectPrivateFile(this.basePath, this.options.fs);
      currentBytes = Number(stats.size);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentBytes + nextBytes <= ROTATE_BYTES) return;
    for (let index = 3; index >= 1; index--) {
      const target = `${this.basePath}.${index}`;
      const source = index === 1 ? this.basePath : `${this.basePath}.${index - 1}`;
      try {
        await inspectPrivateFile(source, this.options.fs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        await inspectPrivateFile(target, this.options.fs);
        await rm(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(source, target);
    }
    await syncDirectory(this.directory, this.options.fs);
  }
}

function exactTimestamp(date: Date): string {
  const timestamp = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) throw new Error("diagnostic timestamp is invalid");
  return timestamp;
}

function singleLine(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\n") || value.includes("\r") || CONTROL_TEST.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`diagnostic ${label} is invalid`);
  }
  return value;
}

function sanitizeMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error("diagnostic message must be a string");
  let result = value.normalize("NFC").replace(CONTROL_REPLACE, "").replace(/[\r\n]+/gu, " ").trim();
  if (!result || ABSOLUTE_PATH.test(result) || SENSITIVE.test(result)) throw new Error("diagnostic message contains forbidden content");
  while (Buffer.byteLength(result, "utf8") > MAX_MESSAGE_BYTES) result = result.slice(0, -1);
  return result;
}
