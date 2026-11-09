import { isAbsolute } from "node:path";

export type TerminalOutcome = "succeeded" | "failed" | "stopped" | "killed" | "crashed";
export type CleanupReason = "scope-ended" | "package-removed" | "reclaim-timeout" | "pi-exit" | "protocol-failure";

export interface WatchDefinition {
  key: string;
  pattern: string;
  mode: "literal" | "regex";
  stream: "stdout" | "stderr" | "both";
  repeat: boolean;
}

export interface ShellProbeRequest { shell: string }
export interface SpawnRequest {
  operationId: string;
  id: string;
  name: string;
  command: string;
  cwd: string;
  shell: string;
  stopGraceMs: number;
  timeoutMs?: number;
  logLimits: { perProcessBytes: number; sessionBytes: number; lineBytes: number };
  watches: WatchDefinition[];
}
export interface InputRequest { operationId: string; id: string; dataBase64?: string; eof: boolean }
export interface StopRequest { operationId: string; id: string }
export interface LogPageRequest {
  id: string;
  stream: "stdout" | "stderr" | "both";
  tailLines: number;
  pattern?: string;
  mode?: "literal" | "regex";
  cursor?: string;
  expectedLogRevision?: number;
}
export interface WatchSetRequest {
  operationId: string;
  id: string;
  expectedWatchRevision: number;
  definitions: WatchDefinition[];
}
export interface LogSearchRequest {
  id: string;
  stream: "stdout" | "stderr" | "both";
  pattern: string;
  mode: "literal" | "regex";
  cursor?: string;
  pageSize: number;
}
export interface CancelRequest { requestIdToCancel: string }
export interface ClearRecordsRequest { operationId: string; ids: string[] }
export interface CleanupRequest { operationId: string; reason: CleanupReason }
export interface EventAckRequest { eventSequence: number }

const PROCESS_ID = /^proc_[0-9a-z]{12}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SHELL_BASENAME = /^(?:ba|z)?sh$/;

function fail(message: string): never {
  throw new Error(`[process/protocol-invalid] ${message}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`unknown payload key ${JSON.stringify(key)}`);
  for (const key of required) if (!(key in value)) fail(`missing payload key ${JSON.stringify(key)}`);
}

function string(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${name} is invalid`);
  return value;
}

function shellSource(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 65_536 || value.includes("\0")) fail("command is invalid");
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`${name} is outside ${minimum}..${maximum}`);
  return value as number;
}

function operationId(value: unknown): string {
  const id = string(value, "operationId", 64);
  if (!OPERATION_ID.test(id)) fail("operationId must be a UUID v4");
  return id;
}

function processId(value: unknown): string {
  const id = string(value, "id", 64);
  if (!PROCESS_ID.test(id)) fail("id is not a canonical process ID");
  return id;
}

function absolutePath(value: unknown, name: string): string {
  const path = string(value, name, 4096);
  if (!isAbsolute(path)) fail(`${name} must be absolute`);
  return path;
}

function shellPath(value: unknown): string {
  const path = absolutePath(value, "shell");
  const base = path.split("/").at(-1) ?? "";
  if (!SHELL_BASENAME.test(base)) fail("shell basename is unsupported");
  return path;
}

function watchDefinition(value: unknown): WatchDefinition {
  const input = object(value, "watch definition");
  exact(input, ["key", "pattern", "mode", "stream", "repeat"]);
  const key = string(input.key, "watch key", 128);
  if (!WATCH_KEY.test(key)) fail("watch key is invalid");
  const pattern = string(input.pattern, "watch pattern", 2048);
  if ([...pattern].length > 500) fail("watch pattern exceeds 500 code points");
  if (input.mode !== "literal" && input.mode !== "regex") fail("watch mode is invalid");
  if (input.stream !== "stdout" && input.stream !== "stderr" && input.stream !== "both") fail("watch stream is invalid");
  if (typeof input.repeat !== "boolean") fail("watch repeat must be boolean");
  return { key, pattern, mode: input.mode, stream: input.stream, repeat: input.repeat };
}

export function parseShellProbe(value: unknown): ShellProbeRequest {
  const input = object(value, "shellProbe payload");
  exact(input, ["shell"]);
  return { shell: shellPath(input.shell) };
}

export function parseSpawn(value: unknown): SpawnRequest {
  const input = object(value, "spawn payload");
  exact(input, ["operationId", "id", "name", "command", "cwd", "shell", "stopGraceMs", "logLimits", "watches"], ["timeoutMs"]);
  const limits = object(input.logLimits, "logLimits");
  exact(limits, ["perProcessBytes", "sessionBytes", "lineBytes"]);
  const perProcessBytes = integer(limits.perProcessBytes, "perProcessBytes", 1_048_576, 268_435_456);
  const sessionBytes = integer(limits.sessionBytes, "sessionBytes", 16_777_216, 2_147_483_648);
  if (sessionBytes < perProcessBytes) fail("sessionBytes must be >= perProcessBytes");
  if (limits.lineBytes !== 65_536) fail("lineBytes must equal 65536");
  if (!Array.isArray(input.watches) || input.watches.length > 20) fail("watches must contain at most 20 definitions");
  const watches = input.watches.map(watchDefinition);
  if (new Set(watches.map((watch) => watch.key)).size !== watches.length) fail("watch keys must be unique");
  const name = string(input.name, "name", 128);
  if ([...name].length > 32) fail("name exceeds protocol limit");
  return {
    operationId: operationId(input.operationId),
    id: processId(input.id),
    name,
    command: shellSource(input.command),
    cwd: absolutePath(input.cwd, "cwd"),
    shell: shellPath(input.shell),
    stopGraceMs: integer(input.stopGraceMs, "stopGraceMs", 100, 30_000),
    ...("timeoutMs" in input ? { timeoutMs: integer(input.timeoutMs, "timeoutMs", 1, Number.MAX_SAFE_INTEGER) } : {}),
    logLimits: { perProcessBytes, sessionBytes, lineBytes: 65_536 },
    watches,
  };
}

export function parseInput(value: unknown): InputRequest {
  const input = object(value, "input payload");
  exact(input, ["operationId", "id", "eof"], ["dataBase64"]);
  if (typeof input.eof !== "boolean") fail("eof must be boolean");
  let dataBase64: string | undefined;
  if (input.dataBase64 !== undefined) {
    if (typeof input.dataBase64 !== "string" || input.dataBase64.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)) fail("dataBase64 is invalid");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.length > 65_536 || bytes.toString("base64") !== input.dataBase64) fail("dataBase64 is not canonical or exceeds 65536 bytes");
    dataBase64 = input.dataBase64;
  }
  if (!input.eof && !dataBase64) fail("input requires dataBase64 or eof=true");
  return { operationId: operationId(input.operationId), id: processId(input.id), dataBase64, eof: input.eof };
}

export function parseStop(value: unknown): StopRequest {
  const input = object(value, "stop payload");
  exact(input, ["operationId", "id"]);
  return { operationId: operationId(input.operationId), id: processId(input.id) };
}

export function parseLogPage(value: unknown): LogPageRequest {
  const input = object(value, "logPage payload");
  exact(input, ["id", "stream", "tailLines"], ["pattern", "mode", "cursor", "expectedLogRevision"]);
  if (input.stream !== "stdout" && input.stream !== "stderr" && input.stream !== "both") fail("stream is invalid");
  const result: LogPageRequest = {
    id: processId(input.id),
    stream: input.stream,
    tailLines: integer(input.tailLines, "tailLines", 1, 2_000),
  };
  if (input.pattern !== undefined) {
    const pattern = string(input.pattern, "pattern", 2048);
    if ([...pattern].length > 500) fail("pattern exceeds 500 code points");
    result.pattern = pattern;
    if (input.mode !== undefined && input.mode !== "literal" && input.mode !== "regex") fail("mode is invalid");
    result.mode = (input.mode as "literal" | "regex" | undefined) ?? "literal";
  } else if (input.mode !== undefined) fail("mode requires pattern");
  if (input.cursor !== undefined) result.cursor = string(input.cursor, "cursor", 4096);
  if (input.expectedLogRevision !== undefined) result.expectedLogRevision = integer(input.expectedLogRevision, "expectedLogRevision", 0, Number.MAX_SAFE_INTEGER);
  return result;
}

export function parseWatchSet(value: unknown): WatchSetRequest {
  const input = object(value, "watchSet payload");
  exact(input, ["operationId", "id", "expectedWatchRevision", "definitions"]);
  if (!Array.isArray(input.definitions) || input.definitions.length > 20) fail("definitions must contain at most 20 watches");
  const definitions = input.definitions.map(watchDefinition);
  if (new Set(definitions.map((watch) => watch.key)).size !== definitions.length) fail("watch keys must be unique");
  return {
    operationId: operationId(input.operationId),
    id: processId(input.id),
    expectedWatchRevision: integer(input.expectedWatchRevision, "expectedWatchRevision", 0, Number.MAX_SAFE_INTEGER),
    definitions,
  };
}

export function parseLogSearch(value: unknown): LogSearchRequest {
  const input = object(value, "logSearch payload");
  exact(input, ["id", "stream", "pattern", "mode", "pageSize"], ["cursor"]);
  if (input.stream !== "stdout" && input.stream !== "stderr" && input.stream !== "both") fail("stream is invalid");
  if (input.mode !== "literal" && input.mode !== "regex") fail("mode is invalid");
  const pattern = string(input.pattern, "pattern", 2048);
  if ([...pattern].length > 500) fail("pattern exceeds 500 code points");
  const result: LogSearchRequest = {
    id: processId(input.id),
    stream: input.stream,
    pattern,
    mode: input.mode,
    pageSize: integer(input.pageSize, "pageSize", 1, 500),
  };
  if (input.cursor !== undefined) result.cursor = string(input.cursor, "cursor", 4096);
  return result;
}

export function parseCancel(value: unknown): CancelRequest {
  const input = object(value, "cancel payload");
  exact(input, ["requestIdToCancel"]);
  return { requestIdToCancel: string(input.requestIdToCancel, "requestIdToCancel", 128) };
}

export function parseClearRecords(value: unknown): ClearRecordsRequest {
  const input = object(value, "clearRecords payload");
  exact(input, ["operationId", "ids"]);
  if (!Array.isArray(input.ids) || input.ids.length > 5_000) fail("ids must contain at most 5000 values");
  const ids = input.ids.map(processId);
  if (new Set(ids).size !== ids.length) fail("ids must be unique");
  return { operationId: operationId(input.operationId), ids };
}

export function parseCleanup(value: unknown): CleanupRequest {
  const input = object(value, "cleanup payload");
  exact(input, ["operationId", "reason"]);
  const reasons: CleanupReason[] = ["scope-ended", "package-removed", "reclaim-timeout", "pi-exit", "protocol-failure"];
  if (!reasons.includes(input.reason as CleanupReason)) fail("cleanup reason is invalid");
  return { operationId: operationId(input.operationId), reason: input.reason as CleanupReason };
}

export function parseEventAck(value: unknown): EventAckRequest {
  const input = object(value, "eventAck payload");
  exact(input, ["eventSequence"]);
  return { eventSequence: integer(input.eventSequence, "eventSequence", 0, Number.MAX_SAFE_INTEGER) };
}

export function parseEmpty(value: unknown): Record<string, never> {
  const input = object(value, "empty payload");
  exact(input, []);
  return {};
}
