import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import type { Attention, NotifyPolicy } from "./domain/types.js";
import { assertRequiredExecutionIsolation, readRequiredExecutionIsolation, validateExecutionIsolation, type ExecutionIsolationV1 } from "./execution-isolation.js";
import { parseStrictJson } from "./strict-json.js";

const MAX_FILE_BYTES = 65_536;
const ATTENTIONS = new Set<Attention>(["turn", "context", "ignore"]);

export interface ManagedProcessesPolicy {
  readonly requireTimeout: boolean;
  readonly maxTimeoutSeconds: number;
  readonly terminalWake: "required";
}

export interface ProcessesConfig {
  readonly schemaVersion: 1;
  readonly managed?: ManagedProcessesPolicy;
  readonly execution: { readonly shell: string; readonly helperRuntime: "auto" | string; readonly stopGraceMs: number; readonly isolation?: ExecutionIsolationV1 };
  readonly limits: { readonly maxLiveProcesses: number; readonly maxTerminalRecords: number; readonly perProcessLogBytes: number; readonly sessionLogBytes: number };
  readonly notifications: NotifyPolicy;
  readonly presentation: { readonly stripInitiallyCollapsed: boolean };
}

export interface ConfigDiagnostic {
  readonly source: "global" | "project" | "merged";
  readonly path: string;
  readonly message: string;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: ProcessesConfig; readonly sources: readonly string[] }
  | { readonly ok: false; readonly diagnostic: ConfigDiagnostic };

function defaultShell(platform = process.platform): string {
  if (platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

export function defaultProcessesConfig(): ProcessesConfig {
  return {
    schemaVersion: 1,
    execution: { shell: defaultShell(), helperRuntime: "auto", stopGraceMs: 3_000 },
    limits: { maxLiveProcesses: 32, maxTerminalRecords: 500, perProcessLogBytes: 67_108_864, sessionLogBytes: 536_870_912 },
    notifications: { onSuccess: "turn", onFailure: "turn", onKilled: "context", onCrash: "turn" },
    presentation: { stripInitiallyCollapsed: false },
  };
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) fail(`${path}.${key}`, "unknown key");
}

function integer(value: unknown, min: number, max: number, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(path, `must be an integer ${min}..${max}`);
  return value as number;
}

function attention(value: unknown, path: string): Attention {
  if (!ATTENTIONS.has(value as Attention)) fail(path, "must be turn, context, or ignore");
  return value as Attention;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be boolean");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(path, "must be a non-empty string without NUL");
  return value;
}

function mergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergeConfig(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else out[key] = value;
  }
  return out;
}

function managedPolicy(value: unknown, path: string): ManagedProcessesPolicy {
  const managed = objectAt(value, path);
  exactKeys(managed, ["requireTimeout", "maxTimeoutSeconds", "terminalWake"], path);
  const requireTimeout = boolean(managed.requireTimeout, `${path}.requireTimeout`);
  const maxTimeoutSeconds = integer(managed.maxTimeoutSeconds, 1, 7_200, `${path}.maxTimeoutSeconds`);
  if (managed.terminalWake !== "required") fail(`${path}.terminalWake`, "must equal required");
  return { requireTimeout, maxTimeoutSeconds, terminalWake: "required" };
}

export function validateProcessesConfig(value: unknown): ProcessesConfig {
  const root = objectAt(value, "$config");
  exactKeys(root, ["schemaVersion", "managed", "execution", "limits", "notifications", "presentation"], "$config");
  if (root.schemaVersion !== 1) fail("$config.schemaVersion", "must equal 1");
  const defaults = defaultProcessesConfig();
  const execution = objectAt(root.execution ?? defaults.execution, "$config.execution");
  exactKeys(execution, ["shell", "helperRuntime", "stopGraceMs", "isolation"], "$config.execution");
  const limits = objectAt(root.limits ?? defaults.limits, "$config.limits");
  exactKeys(limits, ["maxLiveProcesses", "maxTerminalRecords", "perProcessLogBytes", "sessionLogBytes"], "$config.limits");
  const notifications = objectAt(root.notifications ?? defaults.notifications, "$config.notifications");
  exactKeys(notifications, ["onSuccess", "onFailure", "onKilled", "onCrash"], "$config.notifications");
  const presentation = objectAt(root.presentation ?? defaults.presentation, "$config.presentation");
  exactKeys(presentation, ["stripInitiallyCollapsed"], "$config.presentation");

  const perProcessLogBytes = integer(limits.perProcessLogBytes ?? defaults.limits.perProcessLogBytes, 1_048_576, 268_435_456, "$config.limits.perProcessLogBytes");
  const sessionLogBytes = integer(limits.sessionLogBytes ?? defaults.limits.sessionLogBytes, 16_777_216, 2_147_483_648, "$config.limits.sessionLogBytes");
  if (sessionLogBytes < perProcessLogBytes) fail("$config.limits.sessionLogBytes", "must be >= perProcessLogBytes");
  const shell = string(execution.shell ?? defaults.execution.shell, "$config.execution.shell");
  const helper = execution.helperRuntime ?? defaults.execution.helperRuntime;
  if (helper !== "auto" && typeof helper !== "string") fail("$config.execution.helperRuntime", "must be auto or absolute executable path");
  if (shell !== defaults.execution.shell && !isAbsolute(shell)) fail("$config.execution.shell", "must be absolute");
  if (helper !== "auto" && !isAbsolute(helper)) fail("$config.execution.helperRuntime", "must be auto or absolute");

  const managed = Object.hasOwn(root, "managed") ? managedPolicy(root.managed, "$config.managed") : undefined;
  const isolation = Object.hasOwn(execution, "isolation") ? validateExecutionIsolation(execution.isolation, "$config.execution.isolation") : undefined;
  if (managed && !isolation) fail("$config.execution.isolation", "is required while managed");
  return {
    schemaVersion: 1,
    ...(managed ? { managed } : {}),
    execution: {
      shell,
      helperRuntime: helper,
      stopGraceMs: integer(execution.stopGraceMs ?? defaults.execution.stopGraceMs, 100, 30_000, "$config.execution.stopGraceMs"),
      ...(isolation ? { isolation } : {}),
    },
    limits: {
      maxLiveProcesses: integer(limits.maxLiveProcesses ?? defaults.limits.maxLiveProcesses, 1, 128, "$config.limits.maxLiveProcesses"),
      maxTerminalRecords: integer(limits.maxTerminalRecords ?? defaults.limits.maxTerminalRecords, 10, 5_000, "$config.limits.maxTerminalRecords"),
      perProcessLogBytes,
      sessionLogBytes,
    },
    notifications: {
      onSuccess: attention(notifications.onSuccess ?? defaults.notifications.onSuccess, "$config.notifications.onSuccess"),
      onFailure: attention(notifications.onFailure ?? defaults.notifications.onFailure, "$config.notifications.onFailure"),
      onKilled: attention(notifications.onKilled ?? defaults.notifications.onKilled, "$config.notifications.onKilled"),
      onCrash: attention(notifications.onCrash ?? defaults.notifications.onCrash, "$config.notifications.onCrash"),
    },
    presentation: { stripInitiallyCollapsed: boolean(presentation.stripInitiallyCollapsed ?? defaults.presentation.stripInitiallyCollapsed, "$config.presentation.stripInitiallyCollapsed") },
  };
}

const jsonCache = new Map<string, { version: string; value: Promise<Record<string, unknown>> }>();
const authorities = new WeakMap<ProcessesConfig, { globalPath: string; projectPath?: string; security: string; required: string | undefined }>();

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fileVersion(value: Stats): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

async function readStrictJson(path: string): Promise<Record<string, unknown> | undefined> {
  let metadata: Stats;
  try { metadata = await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { jsonCache.delete(path); return undefined; }
    throw error;
  }
  const version = fileVersion(metadata);
  const cached = jsonCache.get(path);
  if (cached?.version === version) return cached.value;
  const value = (async () => {
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error(`${path}: must be a file of at most ${MAX_FILE_BYTES} bytes`);
    const buffer = await readFile(path);
    if (fileVersion(await stat(path)) !== version) throw new Error(`${path}: changed while reading`);
    if (buffer.length > MAX_FILE_BYTES) throw new Error(`${path}: exceeds ${MAX_FILE_BYTES} bytes`);
    return freeze(objectAt(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer), path), path));
  })();
  jsonCache.set(path, { version, value });
  if (jsonCache.size > 64) jsonCache.delete(jsonCache.keys().next().value!);
  return value;
}

function securityProjection(global: Record<string, unknown> | undefined, path: string): string {
  const execution = global && Object.hasOwn(global, "execution") ? objectAt(global.execution, `${path}.execution`) : undefined;
  return JSON.stringify({
    managed: global && Object.hasOwn(global, "managed") ? managedPolicy(global.managed, `${path}.managed`) : null,
    helperRuntime: execution?.helperRuntime ?? null,
    isolation: execution && Object.hasOwn(execution, "isolation") ? validateExecutionIsolation(execution.isolation, `${path}.execution.isolation`) : null,
  });
}

function assertProjectAuthority(project: Record<string, unknown> | undefined, path: string, lockedHelper: boolean): void {
  if (!project) return;
  if (Object.hasOwn(project, "managed")) fail(`${path}.managed`, "is only allowed in agentDir config");
  if (Object.hasOwn(project, "execution")) {
    const execution = objectAt(project.execution, `${path}.execution`);
    if (Object.hasOwn(execution, "isolation")) fail(`${path}.execution.isolation`, "is only allowed in agentDir config");
    if (lockedHelper && Object.hasOwn(execution, "helperRuntime")) fail(`${path}.execution.helperRuntime`, "cannot override agentDir config while managed or isolated");
  }
}

export function processesExecutionAuthority(config: ProcessesConfig): string {
  return JSON.stringify({ managed: config.managed ?? null, helperRuntime: config.execution.helperRuntime,
    isolation: config.execution.isolation ?? null, required: readRequiredExecutionIsolation() ?? null });
}

/** Recheck cheap file versions, never accept a new authority inside an existing scope. */
export function assertProcessesExecutionIsolationCurrent(config: ProcessesConfig): Promise<void> | undefined {
  const required = readRequiredExecutionIsolation();
  assertRequiredExecutionIsolation(config.execution.isolation, required);
  if (config.managed && !config.execution.isolation) fail("execution.isolation", "is required while managed");
  const authority = authorities.get(config);
  if (!authority) return undefined;
  if (JSON.stringify(required) !== authority.required) fail("execution.isolation", "required launch declaration drifted; start a fresh session");
  return (async () => {
    const global = await readStrictJson(authority.globalPath);
    if (securityProjection(global, authority.globalPath) !== authority.security) fail("execution.isolation", "agentDir execution authority drifted; start a fresh session");
    if (authority.projectPath) assertProjectAuthority(await readStrictJson(authority.projectPath), authority.projectPath, config.managed !== undefined || config.execution.isolation !== undefined || required !== undefined);
    if (JSON.stringify(readRequiredExecutionIsolation()) !== authority.required) fail("execution.isolation", "required launch declaration drifted during validation");
  })();
}

async function validateExecutable(path: string, allowedBasenames?: Set<string>): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${path}: must be absolute`);
  const resolved = await realpath(path);
  const stat = await lstat(resolved);
  if (!stat.isFile()) throw new Error(`${path}: resolved target is not a regular file`);
  await access(resolved, constants.X_OK);
  if (allowedBasenames && !allowedBasenames.has(basename(resolved))) throw new Error(`${path}: unsupported executable basename`);
  return path;
}

export async function loadProcessesConfig(input: { readonly agentDir: string; readonly cwd: string; readonly projectTrusted: boolean }): Promise<ConfigLoadResult> {
  const globalPath = join(input.agentDir, "pi-processes", "config.json");
  const projectPath = join(input.cwd, ".pi", "pi-processes.json");
  try {
    const required = readRequiredExecutionIsolation();
    const global = await readStrictJson(globalPath);
    if (global && global.schemaVersion !== 1) fail(`${globalPath}.schemaVersion`, "must equal 1");
    const managed = global && Object.hasOwn(global, "managed") ? managedPolicy(global.managed, `${globalPath}.managed`) : undefined;
    const project = input.projectTrusted ? await readStrictJson(projectPath) : undefined;
    if (project && project.schemaVersion !== 1) fail(`${projectPath}.schemaVersion`, "must equal 1");
    const isolated = global && Object.hasOwn(global, "execution") && Object.hasOwn(objectAt(global.execution, `${globalPath}.execution`), "isolation");
    assertProjectAuthority(project, projectPath, managed !== undefined || isolated === true || required !== undefined);
    const merged = mergeConfig(defaultProcessesConfig() as unknown as Record<string, unknown>, mergeConfig(global ?? {}, project ?? {}));
    const config = freeze(validateProcessesConfig(merged));
    assertRequiredExecutionIsolation(config.execution.isolation, required);
    authorities.set(config, { globalPath, ...(input.projectTrusted ? { projectPath } : {}), security: securityProjection(global, globalPath), required: JSON.stringify(required) });
    await validateExecutable(config.execution.shell, new Set(["sh", "dash", "bash", "zsh"]));
    if (config.execution.helperRuntime !== "auto") await validateExecutable(config.execution.helperRuntime);
    await assertProcessesExecutionIsolationCurrent(config);
    return { ok: true, config, sources: [global ? globalPath : "", project ? projectPath : ""].filter(Boolean) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, diagnostic: { source: message.includes(projectPath) ? "project" : message.includes(globalPath) ? "global" : "merged", path: message.split(":", 1)[0] ?? "$config", message } };
  }
}
