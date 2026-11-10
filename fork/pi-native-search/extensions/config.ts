import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";

/** "native" keeps the provider default, "ddg" uses DuckDuckGo, other IDs select a registered backend. */
export type SearchBackendOverride = string;
export interface SearchConfig {
  enabled: boolean;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  providerOverrides: Record<string, { searchEnabled?: boolean; fetchEnabled?: boolean; searchBackend?: SearchBackendOverride }>;
}

const defaults = (): SearchConfig => ({ enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} });
type CachedConfig = { version: string; config?: SearchConfig; canonical?: string; error?: Error };
const cache = new Map<string, CachedConfig>();

function fileVersion(s: BigIntStats): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

function version(path: string): string {
  try {
    const s = statSync(path, { bigint: true });
    if (!s.isFile()) throw new Error("Search config must be a regular file");
    return fileVersion(s);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { lstatSync(path); }
      catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw new Error(`Cannot inspect search config ${path}`, { cause: linkError });
      }
    }
    throw new Error(`Cannot inspect search config ${path}`, { cause: error });
  }
}

function readConfig(path: string, expected: string): SearchConfig {
  // Nonblocking open plus fstat also rejects a FIFO swapped in after the path stat.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd, { bigint: true });
    if (!s.isFile()) throw new Error("Search config must be a regular file");
    if (fileVersion(s) !== expected) throw new Error("Config changed while opening; retry the operation");
    return validate(JSON.parse(readFileSync(fd, "utf-8")));
  } finally { closeSync(fd); }
}

function rejectSymlink(path: string): void {
  let s;
  try { s = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Cannot save search config ${path}`, { cause: error });
  }
  if (s.isSymbolicLink()) throw new Error(`Cannot save search config ${path}: refusing to replace a symlink`);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validate(value: unknown): SearchConfig {
  if (!object(value) || Object.keys(value).some(key => !["enabled", "searchEnabled", "fetchEnabled", "providerOverrides"].includes(key)) ||
      !["enabled", "searchEnabled", "fetchEnabled"].every(key => typeof value[key] === "boolean") || !object(value.providerOverrides)) {
    throw new Error("Expected enabled/searchEnabled/fetchEnabled booleans and providerOverrides object");
  }
  for (const [provider, override] of Object.entries(value.providerOverrides)) {
    if (!object(override) || Object.entries(override).some(([key, setting]) =>
      key === "searchBackend" ? typeof setting !== "string" || !setting.trim() :
        !["searchEnabled", "fetchEnabled"].includes(key) || typeof setting !== "boolean")) {
      throw new Error(`Invalid provider override: ${provider}`);
    }
  }
  return value as unknown as SearchConfig;
}

function canonical(config: SearchConfig): string {
  return JSON.stringify({
    enabled: config.enabled, searchEnabled: config.searchEnabled, fetchEnabled: config.fetchEnabled,
    providerOverrides: Object.fromEntries(Object.entries(config.providerOverrides).sort(([a], [b]) => a.localeCompare(b)).map(([provider, override]) => [provider, {
      ...(override.searchEnabled === undefined ? {} : { searchEnabled: override.searchEnabled }),
      ...(override.fetchEnabled === undefined ? {} : { fetchEnabled: override.fetchEnabled }),
      ...(override.searchBackend === undefined ? {} : { searchBackend: override.searchBackend }),
    }])),
  }, null, 2);
}

export function loadSearchConfig(agentDir: string): SearchConfig {
  const path = resolve(agentDir, "search-config.json");
  const current = version(path);
  let entry = cache.get(path);
  if (!entry || entry.version !== current) {
    try {
      const config = current === "missing" ? defaults() : readConfig(path, current);
      if (version(path) !== current) throw new Error("Config changed while reading; retry the operation");
      entry = { version: current, config, canonical: canonical(config) };
    } catch (error) {
      entry = { version: current, error: new Error(`Cannot load search config ${path}`, { cause: error }) };
    }
    cache.set(path, entry);
  }
  if (entry.error) throw entry.error;
  return structuredClone(entry.config!);
}

export function saveSearchConfig(config: SearchConfig, agentDir: string): void {
  const path = resolve(agentDir, "search-config.json");
  const bytes = canonical(validate(config));
  rejectSymlink(path);
  // Never replace an unreadable or malformed source, even for an explicit /search on.
  loadSearchConfig(agentDir);
  const previous = cache.get(path)!;
  if (previous.version !== "missing" && previous.canonical === bytes) return;
  const temp = join(resolve(agentDir), `.search-config.${randomUUID()}.tmp`);
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(temp, bytes, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    if (version(path) !== previous.version) throw new Error("Config changed before saving; retry the operation");
    rejectSymlink(path);
    renameSync(temp, path);
    cache.set(path, { version: version(path), config: structuredClone(config), canonical: bytes });
  } catch (error) {
    try { rmSync(temp, { force: true }); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Cannot save search config ${path}; temporary file cleanup also failed`, { cause: error });
    }
    throw new Error(`Cannot save search config ${path}`, { cause: error });
  }
}
