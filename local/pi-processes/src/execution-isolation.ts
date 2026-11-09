import { parseStrictJson } from "./strict-json.js";

export const REQUIRED_EXECUTION_ISOLATION_ENV = "PI_PROCESSES_REQUIRED_ISOLATION";
export const SUPERVISOR_EXECUTION_ISOLATION_ENV = "PI_PROCESSES_SUPERVISOR_EXECUTION_ISOLATION";

export interface RequiredExecutionIsolationV1 {
  readonly version: 1;
  readonly owner: string;
  readonly revision: number;
}

export interface ExecutionIsolationV1 extends RequiredExecutionIsolationV1 {
  readonly removeEnv: readonly string[];
}

export interface ExecutionIsolationBootstrapV1 {
  readonly version: 1;
  readonly policy: ExecutionIsolationV1 | null;
  readonly required: RequiredExecutionIsolationV1 | null;
}

function fail(path: string, message: string): never {
  throw new Error(`[process/execution-isolation] ${path}: ${message}`);
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(path, "must be an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, "unknown key");
  return value as Record<string, unknown>;
}

function identity(value: Record<string, unknown>, path: string): RequiredExecutionIsolationV1 {
  if (value.version !== 1) fail(`${path}.version`, "must equal 1");
  if (typeof value.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.owner)) fail(`${path}.owner`, "must be a bounded identity token");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) fail(`${path}.revision`, "must be a positive safe integer");
  return Object.freeze({ version: 1, owner: value.owner, revision: value.revision as number });
}

export function validateExecutionIsolation(value: unknown, path = "execution.isolation"): ExecutionIsolationV1 {
  const object = record(value, ["version", "owner", "revision", "removeEnv"], path);
  const owner = identity(object, path);
  if (!Array.isArray(object.removeEnv) || object.removeEnv.length > 256) fail(`${path}.removeEnv`, "must be an array of at most 256 environment keys");
  const keys = new Set<string>();
  for (const key of object.removeEnv) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || keys.has(key)) fail(`${path}.removeEnv`, "must contain unique environment keys");
    keys.add(key);
  }
  return Object.freeze({ ...owner, removeEnv: Object.freeze([...keys].sort()) });
}

let requiredCache: { raw: string; ok: true; value: RequiredExecutionIsolationV1 } | { raw: string; ok: false; error: unknown } | undefined;

export function readRequiredExecutionIsolation(env: NodeJS.ProcessEnv = process.env): RequiredExecutionIsolationV1 | undefined {
  const raw = env[REQUIRED_EXECUTION_ISOLATION_ENV];
  if (raw === undefined) return undefined;
  if (requiredCache?.raw === raw) {
    if (requiredCache.ok) return requiredCache.value;
    throw requiredCache.error;
  }
  try {
    if (raw.length > 4096) fail(REQUIRED_EXECUTION_ISOLATION_ENV, "exceeds 4096 characters");
    const value = identity(record(parseStrictJson(raw, REQUIRED_EXECUTION_ISOLATION_ENV), ["version", "owner", "revision"], REQUIRED_EXECUTION_ISOLATION_ENV), REQUIRED_EXECUTION_ISOLATION_ENV);
    requiredCache = { raw, ok: true, value };
    return value;
  } catch (error) {
    requiredCache = { raw, ok: false, error };
    throw error;
  }
}

export function assertRequiredExecutionIsolation(policy: ExecutionIsolationV1 | undefined, required: RequiredExecutionIsolationV1 | undefined): void {
  if (required && (!policy || policy.owner !== required.owner || policy.revision !== required.revision)) {
    fail("execution.isolation", "required policy is missing or owner/revision does not match the launch declaration");
  }
}

export function executionIsolationBootstrap(policy: ExecutionIsolationV1 | undefined): ExecutionIsolationBootstrapV1 {
  const frozen = policy === undefined ? undefined : validateExecutionIsolation(policy);
  const required = readRequiredExecutionIsolation();
  assertRequiredExecutionIsolation(frozen, required);
  return Object.freeze({ version: 1, policy: frozen ?? null, required: required ?? null });
}

export function parseExecutionIsolationBootstrap(raw: string | undefined): ExecutionIsolationBootstrapV1 {
  if (raw === undefined) {
    // Standalone supervisors retain transport-key cleanup; a required declaration
    // cannot bypass its frozen policy through this ordinary-execution path.
    assertRequiredExecutionIsolation(undefined, readRequiredExecutionIsolation());
    return Object.freeze({ version: 1, policy: null, required: null });
  }
  if (raw.length > 65536) fail(SUPERVISOR_EXECUTION_ISOLATION_ENV, "exceeds 65536 characters");
  const value = record(parseStrictJson(raw, SUPERVISOR_EXECUTION_ISOLATION_ENV), ["version", "policy", "required"], SUPERVISOR_EXECUTION_ISOLATION_ENV);
  if (value.version !== 1) fail(SUPERVISOR_EXECUTION_ISOLATION_ENV, "version must equal 1");
  const policy = value.policy === null ? undefined : validateExecutionIsolation(value.policy);
  const required = value.required === null ? undefined : identity(record(value.required, ["version", "owner", "revision"], "bootstrap.required"), "bootstrap.required");
  const actual = readRequiredExecutionIsolation();
  if (JSON.stringify(actual) !== JSON.stringify(required)) fail(SUPERVISOR_EXECUTION_ISOLATION_ENV, "required launch declaration drifted");
  assertRequiredExecutionIsolation(policy, required);
  return Object.freeze({ version: 1, policy: policy ?? null, required: required ?? null });
}
