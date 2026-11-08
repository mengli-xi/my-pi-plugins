import { validateTaskTimeoutMs } from "../domain/task-policy.js";
import { parseForkTurns, type ForkTurns } from "pi-session-runtime/fork-turns";
export type { ForkTurns } from "pi-session-runtime/fork-turns";

const encoder = new TextEncoder();
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SpawnAgentInput {
  task_name: string;
  message: string;
  fork_turns?: ForkTurns;
  agent_type?: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  service_tier?: string;
  task_timeout_ms?: number;
}
export interface TargetMessageInput { target: string; message: string }
export interface WaitAgentsInput { targets: string[] }
export interface TargetInput { target: string }
export interface ListSubagentModelsInput { query: string }
export interface ListSubagentRolesInput { query: string }
export interface ListAgentsInput { path_prefix?: string }

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function plainObject(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("input must be a plain object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(input, key) || !allowed.includes(key)) {
      throw new Error(`unknown or non-enumerable input key: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new Error(`input key '${key}' must be a data property`);
  }
  for (const key of required) if (!Object.hasOwn(input, key)) throw new Error(`missing required input key: ${key}`);
  return input;
}

function boundedString(value: unknown, label: string, min: number, max: number, controls = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFC");
  if (normalized !== value) throw new Error(`${label} must be NFC normalized`);
  const bytes = byteLength(value);
  if (bytes < min || bytes > max) throw new Error(`${label} must be ${min}..${max} UTF-8 bytes`);
  if (!controls && CONTROLS.test(value)) throw new Error(`${label} must not contain control characters`);
  return value;
}

function message(value: unknown): string {
  const accepted = boundedString(value, "message", 1, 65_536, true);
  if (accepted.trim().length === 0) throw new Error("message must not be blank");
  return accepted;
}

function target(value: unknown, label = "target"): string {
  return boundedString(value, label, 1, 512);
}

function searchQuery(value: unknown): string {
  const accepted = boundedString(value, "query", 1, 256, true);
  if (CONTROLS.test(accepted.replace(/[\t\n\r]/gu, ""))) throw new Error("query must not contain control characters other than tab, newline or carriage return");
  return accepted;
}

function optionalProfileString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, 1, 256);
}

export function validateSpawnAgentInput(value: unknown): SpawnAgentInput {
  const input = plainObject(value, ["task_name", "message", "fork_turns", "agent_type", "model", "reasoning_effort", "service_tier", "task_timeout_ms"], ["task_name", "message"]);
  const taskName = boundedString(input.task_name, "task_name", 1, 64);
  if (!TASK_NAME.test(taskName)) throw new Error("task_name has invalid characters");
  const rawFork = input.fork_turns === undefined ? undefined : boundedString(input.fork_turns, "fork_turns", 1, 6);
  // 模型很自然会用 "0" 表示不继承；按 none 处理，别为这个打回整次 spawn。
  const fork = rawFork === "0" ? "none" : rawFork;
  if (fork !== undefined) parseForkTurns(fork);
  const effort = input.reasoning_effort;
  if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.has(effort))) throw new Error("reasoning_effort is invalid");
  return {
    task_name: taskName,
    message: message(input.message),
    ...(fork !== undefined ? { fork_turns: fork as ForkTurns } : {}),
    ...(input.agent_type !== undefined ? { agent_type: optionalProfileString(input.agent_type, "agent_type")! } : {}),
    ...(input.model !== undefined ? { model: optionalProfileString(input.model, "model")! } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort as ReasoningEffort } : {}),
    ...(input.task_timeout_ms !== undefined ? { task_timeout_ms: validateTaskTimeoutMs(input.task_timeout_ms) } : {}),
    ...(input.service_tier !== undefined ? { service_tier: optionalProfileString(input.service_tier, "service_tier")! } : {}),
  };
}

export function validateTargetMessageInput(value: unknown): TargetMessageInput {
  const input = plainObject(value, ["target", "message"], ["target", "message"]);
  return { target: target(input.target), message: message(input.message) };
}

export function validateSendInput(value: unknown): TargetMessageInput & { interrupt?: boolean } {
  const input = plainObject(value, ["target", "message", "interrupt"], ["target", "message"]);
  if (input.interrupt !== undefined && typeof input.interrupt !== "boolean") throw new Error("interrupt must be boolean");
  return { target: target(input.target), message: message(input.message), ...(input.interrupt !== undefined ? { interrupt: input.interrupt } : {}) };
}
export function validateCloseAgentInput(value: unknown): TargetInput & { force?: boolean } {
  const input = plainObject(value, ["target", "force"], ["target"]);
  if (input.force !== undefined && typeof input.force !== "boolean") throw new Error("force must be boolean");
  return { target: target(input.target), ...(input.force !== undefined ? { force: input.force } : {}) };
}

export function validateWaitAgentsInput(value: unknown): WaitAgentsInput {
  const input = plainObject(value, ["targets"], ["targets"]);
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 32) {
    throw new Error("targets must contain 1..32 entries");
  }
  const targets = input.targets.map((item, index) => target(item, `targets[${index}]`));
  if (new Set(targets).size !== targets.length) throw new Error("targets must be unique");
  return { targets };
}

export function validateTargetInput(value: unknown): TargetInput {
  const input = plainObject(value, ["target"], ["target"]);
  return { target: target(input.target) };
}

export function validateListSubagentModelsInput(value: unknown): ListSubagentModelsInput {
  const input = plainObject(value, ["query"], ["query"]);
  return { query: searchQuery(input.query) };
}

export function validateListSubagentRolesInput(value: unknown): ListSubagentRolesInput {
  const input = plainObject(value, ["query"], ["query"]);
  return { query: searchQuery(input.query) };
}

export function validateListAgentsInput(value: unknown): ListAgentsInput {
  const input = plainObject(value, ["path_prefix"], []);
  return input.path_prefix === undefined ? {} : { path_prefix: target(input.path_prefix, "path_prefix") };
}
