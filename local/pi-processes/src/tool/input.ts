import { visibleWidth } from "@earendil-works/pi-tui";

import type { ManagedProcessesPolicy } from "../config.js";
import type { Attention, ContinuationPolicy, MatchMode, NotifyPolicy, ProcessAction, ProcessKind, ProcessState, StreamSelection, WatchDefinition } from "../domain/types.js";

export type WatchUpdate =
  | { readonly operation: "upsert" | "replace"; readonly items: readonly WatchDefinition[] }
  | { readonly operation: "remove"; readonly keys: readonly string[] }
  | { readonly operation: "clear" };

export type ToolInput =
  | { readonly action: "start"; readonly name: string; readonly kind: ProcessKind; readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; readonly watches: readonly WatchDefinition[]; readonly continuation: ContinuationPolicy; readonly notify?: Partial<NotifyPolicy> }
  | { readonly action: "list"; readonly states?: readonly ProcessState[]; readonly sort: "started-desc" | "started-asc" | "name-asc" | "state"; readonly limit: number; readonly cursor?: string }
  | { readonly action: "logs"; readonly target: string; readonly stream: StreamSelection; readonly tailLines: number; readonly pattern?: string; readonly mode: MatchMode }
  | { readonly action: "input"; readonly target: string; readonly data?: string; readonly eof: boolean }
  | { readonly action: "configure"; readonly target: string; readonly name?: string; readonly kind?: ProcessKind; readonly watchUpdate?: WatchUpdate; readonly continuation?: ContinuationPolicy; readonly notify?: Partial<Record<keyof NotifyPolicy, Attention | null>> }
  | { readonly action: "stop"; readonly target: string }
  | { readonly action: "clear" };

const ACTIONS = new Set<ProcessAction>(["start", "list", "logs", "input", "configure", "stop", "clear"]);
const ATTENTIONS = new Set<Attention>(["turn", "context", "ignore"]);
const STREAMS = new Set<StreamSelection>(["stdout", "stderr", "both"]);
const MODES = new Set<MatchMode>(["literal", "regex"]);
const KINDS = new Set<ProcessKind>(["process", "monitor", "service"]);
const STATES = new Set<ProcessState>(["starting", "running", "stopping", "succeeded", "failed", "stopped", "killed", "crashed"]);
const WATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ALLOWED_KEYS: Record<ProcessAction, readonly string[]> = {
  start: ["action", "name", "kind", "command", "cwd", "timeout", "watches", "continuation", "notify"],
  list: ["action", "states", "sort", "limit", "cursor"],
  logs: ["action", "target", "stream", "tailLines", "pattern", "mode"],
  input: ["action", "target", "data", "eof"],
  configure: ["action", "target", "name", "kind", "watchUpdate", "continuation", "notify"],
  stop: ["action", "target"],
  clear: ["action"],
};

export class ProcessInputError extends Error {
  readonly code = "process/invalid-arguments";
  constructor(message: string) { super(`[process/invalid-arguments] ${message}`); this.name = "ProcessInputError"; }
}

function fail(path: string, message: string): never { throw new ProcessInputError(`${path} ${message}`); }

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(path, "must be a plain object with no inherited keys");
  if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "must not contain symbol keys");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) fail(`${path}.${key}`, "must not be an accessor");
    if (!descriptor.enumerable) fail(`${path}.${key}`, "must be enumerable");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "is not valid for this action");
}

function own(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function required(value: Record<string, unknown>, key: string, path: string): unknown { if (!own(value, key)) fail(`${path}.${key}`, "is required"); return value[key]; }
function enumValue<T extends string>(value: unknown, values: Set<T>, path: string): T { if (typeof value !== "string" || !values.has(value as T)) fail(path, `has unsupported value ${JSON.stringify(value)}`); return value as T; }
function integer(value: unknown, min: number, max: number, path: string): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(path, `must be an integer ${min}..${max}`); return value as number; }
function bool(value: unknown, path: string): boolean { if (typeof value !== "boolean") fail(path, "must be boolean"); return value; }
function utf8(value: unknown, path: string, minBytes: number, maxBytes: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minBytes || bytes > maxBytes) fail(path, `must be ${minBytes}..${maxBytes} UTF-8 bytes`);
  if (value.includes("\0")) fail(path, "must not contain NUL");
  return value;
}
function codePoints(value: unknown, path: string, max: number): string { const text = utf8(value, path, 1, 2_048); if ([...text].length > max) fail(path, `must be at most ${max} Unicode code points`); return text; }
function target(value: unknown, path: string): string { const text = utf8(value, path, 1, 512); if ([...text].length > 128) fail(path, "must be at most 128 Unicode code points"); return text; }
function name(value: unknown, path: string): string { const text = utf8(value, path, 1, 512).trim(); if (!text) fail(path, "must not be blank"); const width = visibleWidth(text); if (width < 1 || width > 16) fail(path, "must be 1..16 terminal columns"); return text; }
function pattern(value: unknown, path: string): string { const text = codePoints(value, path, 500); if (Buffer.byteLength(text, "utf8") > 2_048) fail(path, "must be at most 2048 UTF-8 bytes"); return text; }

function watch(value: unknown, path: string): WatchDefinition {
  const item = plainObject(value, path); exact(item, ["key", "pattern", "mode", "stream", "repeat", "attention"], path);
  const key = utf8(required(item, "key", path), `${path}.key`, 1, 128);
  if (key.length > 32 || !WATCH_KEY.test(key)) fail(`${path}.key`, "has invalid format");
  return {
    key,
    pattern: pattern(required(item, "pattern", path), `${path}.pattern`),
    mode: own(item, "mode") ? enumValue(item.mode, MODES, `${path}.mode`) : "literal",
    stream: own(item, "stream") ? enumValue(item.stream, STREAMS, `${path}.stream`) : "both",
    repeat: own(item, "repeat") ? bool(item.repeat, `${path}.repeat`) : false,
    attention: own(item, "attention") ? enumValue(item.attention, ATTENTIONS, `${path}.attention`) : "turn",
  };
}

function watches(value: unknown, path: string, allowEmpty: boolean): WatchDefinition[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if ((!allowEmpty && value.length === 0) || value.length > 20) fail(path, allowEmpty ? "must contain at most 20 items" : "must contain 1..20 items");
  const items = value.map((item, index) => watch(item, `${path}[${index}]`));
  const keys = new Set<string>(); for (const item of items) { if (keys.has(item.key)) fail(path, `contains duplicate watch key ${item.key}`); keys.add(item.key); }
  return items;
}

function continuation(value: unknown, path: string): ContinuationPolicy {
  const item = plainObject(value, path); exact(item, ["mode", "until"], path);
  const mode = required(item, "mode", path);
  if (mode === "detached") { if (own(item, "until")) fail(`${path}.until`, "is invalid for detached mode"); return { mode: "detached" }; }
  if (mode !== "wait") fail(`${path}.mode`, "must be detached or wait");
  const until = plainObject(required(item, "until", path), `${path}.until`); exact(until, ["kind", "key"], `${path}.until`);
  if (until.kind === "exit") { if (own(until, "key")) fail(`${path}.until.key`, "is invalid for exit"); return { mode: "wait", until: { kind: "exit" } }; }
  if (until.kind !== "watch") fail(`${path}.until.kind`, "must be exit or watch");
  const key = utf8(required(until, "key", `${path}.until`), `${path}.until.key`, 1, 128);
  if (!WATCH_KEY.test(key) || key.length > 32) fail(`${path}.until.key`, "has invalid format");
  return { mode: "wait", until: { kind: "watch", key } };
}

function notify(value: unknown, path: string, nullable: boolean): Partial<Record<keyof NotifyPolicy, Attention | null>> {
  const item = plainObject(value, path); exact(item, ["onSuccess", "onFailure", "onKilled", "onCrash"], path);
  if (Object.keys(item).length === 0) fail(path, "must contain at least one policy");
  const out: Partial<Record<keyof NotifyPolicy, Attention | null>> = {};
  for (const key of Object.keys(item) as (keyof NotifyPolicy)[]) {
    if (nullable && item[key] === null) out[key] = null;
    else out[key] = enumValue(item[key], ATTENTIONS, `${path}.${key}`);
  }
  return out;
}

function watchUpdate(value: unknown, path: string): WatchUpdate {
  const item = plainObject(value, path); const operation = item.operation;
  if (operation === "clear") { exact(item, ["operation"], path); return { operation }; }
  if (operation === "remove") {
    exact(item, ["operation", "keys"], path); const raw = required(item, "keys", path);
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) fail(`${path}.keys`, "must contain 1..20 keys");
    const keys = raw.map((key, i) => { const text = utf8(key, `${path}.keys[${i}]`, 1, 128); if (!WATCH_KEY.test(text) || text.length > 32) fail(`${path}.keys[${i}]`, "has invalid format"); return text; });
    if (new Set(keys).size !== keys.length) fail(`${path}.keys`, "contains duplicates"); return { operation, keys };
  }
  if (operation === "upsert" || operation === "replace") { exact(item, ["operation", "items"], path); return { operation, items: watches(required(item, "items", path), `${path}.items`, operation === "replace") }; }
  fail(`${path}.operation`, "must be upsert, replace, remove, or clear");
}

export function parseToolInput(value: unknown, managed?: ManagedProcessesPolicy): ToolInput {
  const root = plainObject(value, "$input");
  const action = enumValue(required(root, "action", "$input"), ACTIONS, "$input.action"); exact(root, ALLOWED_KEYS[action], "$input");
  switch (action) {
    case "start": {
      if (managed?.requireTimeout) required(root, "timeout", "$input");
      const timeoutMs = own(root, "timeout")
        ? integer(root.timeout, 1, Math.min(managed?.maxTimeoutSeconds ?? Infinity, Math.floor(Number.MAX_SAFE_INTEGER / 1_000)), "$input.timeout") * 1_000
        : undefined;
      const result: ToolInput = {
        action,
        name: name(required(root, "name", "$input"), "$input.name"),
        kind: own(root, "kind") ? enumValue(root.kind, KINDS, "$input.kind") : "process",
        command: utf8(required(root, "command", "$input"), "$input.command", 1, 32_768),
        watches: own(root, "watches") ? watches(root.watches, "$input.watches", true) : [],
        continuation: own(root, "continuation") ? continuation(root.continuation, "$input.continuation") : { mode: "detached" },
        ...(own(root, "cwd") ? { cwd: utf8(root.cwd, "$input.cwd", 1, 4_096) } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(own(root, "notify") ? { notify: notify(root.notify, "$input.notify", false) as Partial<NotifyPolicy> } : {}),
      };
      const waitPolicy = result.continuation.mode === "wait" ? result.continuation : undefined;
      const waitKey = waitPolicy?.until.kind === "watch" ? waitPolicy.until.key : undefined;
      if (waitKey && !result.watches.some((item) => item.key === waitKey)) fail("$input.continuation.until.key", "must reference a configured watch");
      return result;
    }
    case "list": {
      let states: ProcessState[] | undefined;
      if (own(root, "states")) { if (!Array.isArray(root.states) || root.states.length === 0) fail("$input.states", "must be a non-empty array"); states = root.states.map((state, i) => enumValue(state, STATES, `$input.states[${i}]`)); if (new Set(states).size !== states.length) fail("$input.states", "contains duplicates"); }
      const sortValues = new Set(["started-desc", "started-asc", "name-asc", "state"] as const);
      return { action, ...(states ? { states } : {}), sort: own(root, "sort") ? enumValue(root.sort, sortValues, "$input.sort") : "started-desc", limit: own(root, "limit") ? integer(root.limit, 1, 200, "$input.limit") : 50, ...(own(root, "cursor") ? { cursor: utf8(root.cursor, "$input.cursor", 1, 4_096) } : {}) };
    }
    case "logs": {
      if (own(root, "mode") && !own(root, "pattern")) fail("$input.mode", "requires pattern");
      return { action, target: target(required(root, "target", "$input"), "$input.target"), stream: own(root, "stream") ? enumValue(root.stream, STREAMS, "$input.stream") : "both", tailLines: own(root, "tailLines") ? integer(root.tailLines, 1, 2_000, "$input.tailLines") : 100, ...(own(root, "pattern") ? { pattern: pattern(root.pattern, "$input.pattern") } : {}), mode: own(root, "mode") ? enumValue(root.mode, MODES, "$input.mode") : "literal" };
    }
    case "input": {
      const data = own(root, "data") ? utf8(root.data, "$input.data", 1, 65_536) : undefined; const eof = own(root, "eof") ? bool(root.eof, "$input.eof") : false;
      if (!data && !eof) fail("$input", "requires non-empty data or eof:true"); return { action, target: target(required(root, "target", "$input"), "$input.target"), ...(data ? { data } : {}), eof };
    }
    case "configure": {
      const mutationKeys = ["name", "kind", "watchUpdate", "continuation", "notify"].filter((key) => own(root, key)); if (mutationKeys.length === 0) fail("$input", "requires at least one mutation");
      return { action, target: target(required(root, "target", "$input"), "$input.target"), ...(own(root, "name") ? { name: name(root.name, "$input.name") } : {}), ...(own(root, "kind") ? { kind: enumValue(root.kind, KINDS, "$input.kind") } : {}), ...(own(root, "watchUpdate") ? { watchUpdate: watchUpdate(root.watchUpdate, "$input.watchUpdate") } : {}), ...(own(root, "continuation") ? { continuation: continuation(root.continuation, "$input.continuation") } : {}), ...(own(root, "notify") ? { notify: notify(root.notify, "$input.notify", true) } : {}) };
    }
    case "stop": return { action, target: target(required(root, "target", "$input"), "$input.target") };
    case "clear": return { action };
  }
}
