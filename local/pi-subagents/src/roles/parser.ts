import { validateTaskTimeoutMs } from "../domain/task-policy.js";
import { createHash } from "node:crypto";
import { REASONING_EFFORTS, type AgentRoleFrontmatterV1, type ResolvedAgentRoleV1, type RoleSourceKind } from "./types.js";

const encoder = new TextEncoder();
const ROLE_NAME = /^[a-z][a-z0-9_-]*$/u;
const CAPABILITY = /^[a-z][a-z0-9._-]{0,63}\/[a-z][a-z0-9._-]{0,63}(?:\/[a-z][a-z0-9._-]{0,63})*$/u;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "tools",
  "required_capabilities",
  "model",
  "reasoning_effort",
  "service_tier",
  "task_timeout_ms",
]);
const ARRAY_KEYS = new Set(["tools", "required_capabilities"]);

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function fail(message: string): never {
  throw new Error(message);
}

function cleanString(value: string, label: string, min: number, max: number, singleLine = true): string {
  if (value.normalize("NFC") !== value) fail(`${label} must be NFC normalized`);
  if (CONTROLS.test(value)) fail(`${label} contains control characters`);
  if (singleLine && /[\r\n]/u.test(value)) fail(`${label} must be one line`);
  const size = bytes(value);
  if (size < min || size > max) fail(`${label} must be ${min}..${max} UTF-8 bytes`);
  return value;
}

function scalar(raw: string, label: string): string | number | string[] {
  const value = raw.trim();
  if (value === "") fail(`${label} requires a value`);
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!(value.startsWith("[") && value.endsWith("]"))) fail(`${label} has invalid inline sequence`);
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item, index) => stringScalar(item.trim(), `${label}[${index}]`));
  }
  if (/^[0-9]+$/u.test(value)) return Number(value);
  return stringScalar(value, label);
}

function stringScalar(raw: string, label: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    if (raw.length < 2 || raw.at(-1) !== quote) fail(`${label} has unterminated quote`);
    if (quote === '"') {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "string") fail(`${label} must be a string`);
        return parsed;
      } catch {
        fail(`${label} has invalid quoted string`);
      }
    }
    const body = raw.slice(1, -1);
    if (body.includes("'") && !body.includes("''")) fail(`${label} has invalid single-quoted string`);
    return body.replaceAll("''", "'");
  }
  if (/[#{}\[\],&*!|>@`]/u.test(raw)) fail(`${label} must quote YAML indicator characters`);
  if (/^(?:null|true|false|~)$/iu.test(raw)) fail(`${label} must be a string`);
  return raw;
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = source.split("\n");
  let currentArray: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    const list = /^\s{2}-\s+(.+)$/u.exec(line);
    if (list) {
      if (!currentArray) fail(`frontmatter line ${index + 1}: sequence item has no key`);
      (result[currentArray] as string[]).push(stringScalar(list[1]!.trim(), currentArray));
      continue;
    }
    if (/^\s/u.test(line)) fail(`frontmatter line ${index + 1}: unsupported indentation`);
    const match = /^([a-z_]+):(.*)$/u.exec(line);
    if (!match) fail(`frontmatter line ${index + 1}: expected key: value`);
    const key = match[1]!;
    if (!ALLOWED_KEYS.has(key)) fail(`unknown frontmatter key '${key}'`);
    if (Object.hasOwn(result, key)) fail(`duplicate frontmatter key '${key}'`);
    const remainder = match[2]!.trim();
    if (remainder === "") {
      if (!ARRAY_KEYS.has(key)) fail(`${key} requires a scalar value`);
      result[key] = [];
      currentArray = key;
    } else {
      result[key] = scalar(remainder, key);
      currentArray = undefined;
    }
  }
  return result;
}

function stringArray(value: unknown, label: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array with at most ${max} items`);
  const values = value.map((item, index) => {
    if (typeof item !== "string") fail(`${label}[${index}] must be a string`);
    return cleanString(item, `${label}[${index}]`, 1, 256);
  });
  if (new Set(values).size !== values.length) fail(`${label} must contain unique values`);
  return Object.freeze(values);
}

function frontmatter(value: Record<string, unknown>): AgentRoleFrontmatterV1 {
  const name = typeof value.name === "string" ? cleanString(value.name, "name", 1, 64) : fail("name is required");
  if (!ROLE_NAME.test(name)) fail("name has invalid characters");
  const description = typeof value.description === "string"
    ? cleanString(value.description, "description", 1, 256)
    : fail("description is required");
  let tools: "*" | readonly string[];
  if (value.tools === "*") tools = "*";
  else tools = stringArray(value.tools, "tools", 128);
  const required = value.required_capabilities === undefined
    ? undefined
    : stringArray(value.required_capabilities, "required_capabilities", 128);
  if (required?.some((item) => !CAPABILITY.test(item))) fail("required_capabilities contains an invalid owner/capability");
  const model = value.model === undefined ? undefined : typeof value.model === "string" ? cleanString(value.model, "model", 1, 256) : fail("model must be a string");
  const serviceTier = value.service_tier === undefined ? undefined : typeof value.service_tier === "string" ? cleanString(value.service_tier, "service_tier", 1, 256) : fail("service_tier must be a string");
  const effort = value.reasoning_effort;
  if (effort !== undefined && (typeof effort !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(effort))) fail("reasoning_effort is invalid");
  const timeout = value.task_timeout_ms;
  if (timeout !== undefined) { try { validateTaskTimeoutMs(timeout); } catch (error) { fail((error as Error).message); } }
  return Object.freeze({
    name,
    description,
    tools,
    ...(required ? { required_capabilities: required } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { reasoning_effort: effort as AgentRoleFrontmatterV1["reasoning_effort"] } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(timeout !== undefined ? { task_timeout_ms: timeout as number } : {}),
  });
}

export function parseRoleMarkdown(input: {
  content: string;
  fileName: string;
  sourceKind: RoleSourceKind;
  sourceIdentity: string;
  privateSourcePath?: string;
  resolvedAt?: string;
}): ResolvedAgentRoleV1 {
  const normalized = input.content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.startsWith("---\n")) fail("role must start with YAML frontmatter");
  const close = normalized.indexOf("\n---\n", 4);
  if (close < 0) fail("role frontmatter is not closed");
  const parsed = frontmatter(parseFrontmatter(normalized.slice(4, close)));
  if (input.fileName !== `${parsed.name}.md`) fail("file basename must equal role name");
  const body = normalized.slice(close + 5).replace(/\n+$/u, "");
  if (bytes(body) < 1 || bytes(body) > 60_000) fail("role body must be 1..60000 UTF-8 bytes");
  if (body.normalize("NFC") !== body) fail("role body must be NFC normalized");
  const canonical = `${normalized.slice(0, close + 5)}${body}\n`;
  return Object.freeze({
    version: 1,
    source_kind: input.sourceKind,
    source_identity: input.sourceIdentity,
    ...(input.privateSourcePath ? { private_source_path: input.privateSourcePath } : {}),
    frontmatter: parsed,
    body,
    content_sha256: createHash("sha256").update(canonical).digest("hex"),
    resolved_at: input.resolvedAt ?? new Date().toISOString(),
  });
}
