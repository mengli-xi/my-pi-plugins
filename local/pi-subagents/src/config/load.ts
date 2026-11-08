import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertProjectPatchAuthority,
  clampProjectPatchV1,
  defaultSubagentsConfig,
  mergeConfigPatches,
  validateConfigPatch,
  validateSubagentsConfig,
} from "./schema.js";
import type {
  ConfigDiagnosticV1,
  ConfigLoadResultV1,
  ConfigSourceKind,
  SubagentsConfigPatchV1,
} from "./types.js";

const MAX_CONFIG_BYTES = 65_536;

interface ConfigInputV1 {
  readonly agentDirectory: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

class ConfigSourceError extends Error {
  readonly source: ConfigSourceKind;
  readonly path: string;

  constructor(source: ConfigSourceKind, path: string, message: string) {
    super(`${path}: ${message}`);
    this.source = source;
    this.path = path;
  }
}

function sourceFail(source: ConfigSourceKind, path: string, message: string): never {
  throw new ConfigSourceError(source, path, message);
}

export function parseStrictJsonObject(source: string, path = "$config"): Record<string, unknown> {
  let index = 0;

  function fail(message: string): never {
    return sourceFail("merged", path, message);
  }

  function whitespace(): void {
    while (/\s/u.test(source[index] ?? "")) index += 1;
  }

  function string(): string {
    const start = index;
    if (source[index++] !== '"') fail("expected JSON string");
    while (index < source.length) {
      const character = source[index++];
      if (character === "\\") {
        if (index >= source.length) fail("unterminated JSON escape");
        index += 1;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          return fail("invalid JSON string");
        }
      }
      if (character !== undefined && character.charCodeAt(0) <= 0x1f) {
        fail("unescaped control character in JSON string");
      }
    }
    return fail("unterminated JSON string");
  }

  function primitive(): void {
    const start = index;
    while (index < source.length && !/[\s,}\]]/u.test(source[index] ?? "")) index += 1;
    if (start === index) fail("invalid JSON value");
    const token = source.slice(start, index);
    try {
      JSON.parse(token);
    } catch {
      fail("invalid JSON value");
    }
  }

  function array(): void {
    index += 1;
    whitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      value();
      whitespace();
      const separator = source[index++];
      if (separator === "]") return;
      if (separator !== ",") fail("invalid JSON array");
      whitespace();
    }
  }

  function object(): void {
    index += 1;
    const keys = new Set<string>();
    whitespace();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (true) {
      whitespace();
      const key = string();
      if (keys.has(key)) sourceFail("merged", `${path}.${key}`, "duplicate key");
      keys.add(key);
      whitespace();
      if (source[index++] !== ":") fail("invalid JSON object");
      value();
      whitespace();
      const separator = source[index++];
      if (separator === "}") return;
      if (separator !== ",") fail("invalid JSON object");
      whitespace();
    }
  }

  function value(): void {
    whitespace();
    const character = source[index];
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') {
      string();
      return;
    }
    primitive();
  }

  value();
  whitespace();
  if (index !== source.length) fail("trailing JSON content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("top level must be an object");
  }
  return parsed as Record<string, unknown>;
}

async function readPatch(
  source: Exclude<ConfigSourceKind, "merged">,
  path: string,
): Promise<SubagentsConfigPatchV1 | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    sourceFail(source, path, error instanceof Error ? error.message : String(error));
  }
  if (buffer.byteLength > MAX_CONFIG_BYTES) {
    sourceFail(source, path, `exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    sourceFail(source, path, "must be valid UTF-8");
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseStrictJsonObject(text, path);
  } catch (error) {
    if (error instanceof ConfigSourceError) {
      sourceFail(source, error.path, error.message.slice(error.message.indexOf(":") + 2));
    }
    sourceFail(source, path, error instanceof Error ? error.message : String(error));
  }
  try {
    return validateConfigPatch(raw, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sourceFail(source, path, message.startsWith(`${path}: `) ? message.slice(path.length + 2) : message);
  }
}

function diagnostic(error: unknown): ConfigDiagnosticV1 {
  if (error instanceof ConfigSourceError) {
    return { source: error.source, path: error.path, message: error.message };
  }
  return {
    source: "merged",
    path: "$config",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function loadSubagentsConfig(input: ConfigInputV1): Promise<ConfigLoadResultV1> {
  const userPath = join(input.agentDirectory, "pi-subagents", "config.json");
  const projectPath = join(input.cwd, ".pi", "pi-subagents.json");
  try {
    const user = await readPatch("user", userPath);
    let userConfig;
    try { userConfig = validateSubagentsConfig(mergeConfigPatches(defaultSubagentsConfig(), user ?? { schemaVersion: 2 })); } catch (error) { sourceFail("user", userPath, String(error).replaceAll("$config", userPath)); }
    const project = input.projectTrusted ? await readPatch("project", projectPath) : undefined;
    if (project) {
      try {
        validateSubagentsConfig(mergeConfigPatches(defaultSubagentsConfig(), project));
        assertProjectPatchAuthority(project, projectPath);
      } catch (error) {
        sourceFail("project", projectPath, error instanceof Error ? error.message : String(error));
      }
    }
    let config;
    try { config = validateSubagentsConfig(mergeConfigPatches(userConfig, project ? clampProjectPatchV1(userConfig, project) : { schemaVersion: 2 })); } catch (error) { sourceFail("project", projectPath, String(error).replaceAll("$config", projectPath)); }
    return {
      ok: true,
      config,
      userConfig,
      sources: [user ? userPath : "", project ? projectPath : ""].filter(Boolean),
    };
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error) };
  }
}
