// npx-resolver.ts - Resolve npx/npm exec binaries to avoid npm parent processes
import { existsSync, realpathSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import { canonicalJson, createFileReader, describeFileError } from "./file-version-cache.ts";
import { join, dirname, extname, resolve, sep } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { throwIfAborted } from "./abort.ts";
import crossSpawn from "cross-spawn";

const CACHE_VERSION = 2;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EXACT_PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

interface NpxCacheEntry {
  resolvedBin: string;
  resolvedAt: number;
  packageVersion?: string;
  isJs: boolean;
}

interface NpxCache {
  version: number;
  entries: Record<string, NpxCacheEntry>;
}

export interface NpxResolution {
  binPath: string;
  extraArgs: string[];
  isJs: boolean;
}

interface ParsedInvocation {
  packageSpec: string;
  binName?: string;
  extraArgs: string[];
}

interface ParsedPackageSpec {
  packageName: string;
  exactVersion?: string;
}

export async function resolveNpxBinary(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<NpxResolution | null> {
  throwIfAborted(signal);
  const parsed = command === "npx"
    ? parseNpxArgs(args)
    : command === "npm"
      ? parseNpmExecArgs(args)
      : null;

  if (!parsed) return null;

  const packageSpec = parsePackageSpec(parsed.packageSpec);
  const cacheKey = JSON.stringify([command, parsed.packageSpec, parsed.binName ?? ""]);
  const cache = loadCache();
  const cached = cache?.entries?.[cacheKey];

  if (
    cached
    && Date.now() - cached.resolvedAt < CACHE_TTL_MS
    && existsSync(cached.resolvedBin)
    && (!packageSpec?.exactVersion || cached.packageVersion === packageSpec.exactVersion)
  ) {
    return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs };
  }

  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolved) {
    saveCacheEntry(cacheKey, resolved);
    return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs };
  }

  // Slow path: force npx cache population
  await forceNpxCache(parsed.packageSpec, signal);
  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolvedAfterInstall) {
    saveCacheEntry(cacheKey, resolvedAfterInstall);
    return { binPath: resolvedAfterInstall.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolvedAfterInstall.isJs };
  }

  return null;
}

function parseNpxArgs(args: string[]): ParsedInvocation | null {
  const separatorIndex = args.indexOf("--");
  const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  const positionals: string[] = [];
  let packageSpec: string | undefined;
  let sawPackageFlag = false;
  let foundFirstPositional = false;

  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (arg === undefined) return null;
    if (foundFirstPositional) {
      positionals.push(arg);
      continue;
    }
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "-p" || arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    positionals.push(arg);
    foundFirstPositional = true;
  }

  const separatedAfter = separatorIndex >= 0 && after.length > 0 ? ["--", ...after] : after;

  if (sawPackageFlag) {
    const binName = positionals[0];
    if (!packageSpec || !binName) return null;
    const extraArgs = positionals.slice(1).concat(separatedAfter);
    return { packageSpec, binName, extraArgs };
  }

  const packagePositional = positionals[0];
  if (!packagePositional) return null;
  const extraArgs = positionals.slice(1).concat(separatedAfter);
  return { packageSpec: packagePositional, extraArgs };
}

function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
  if (args[0] !== "exec") return null;
  const execArgs = args.slice(1);
  const separatorIndex = execArgs.indexOf("--");
  if (separatorIndex < 0) return null;

  const before = execArgs.slice(0, separatorIndex);
  const after = execArgs.slice(separatorIndex + 1);

  let packageSpec: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (arg === undefined) return null;
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      if (!packageSpec) packageSpec = value;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
  }

  const binName = after[0];
  if (!packageSpec || !binName) return null;
  const extraArgs = after.slice(1);
  return { packageSpec, binName, extraArgs };
}

function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {
  const cacheDir = getNpmCacheDir();
  if (!cacheDir) return null;

  const parsedSpec = parsePackageSpec(packageSpec);
  if (!parsedSpec) return null;

  const { packageName, exactVersion } = parsedSpec;
  const packageDir = findCachedPackageDir(cacheDir, packageName, exactVersion);
  if (!packageDir) return null;

  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  let pkg: { bin?: string | Record<string, string>; version?: string } | null = null;
  try {
    pkg = readPackageFile(packageJsonPath).value ?? null;
  } catch {
    return null;
  }

  const binField = pkg?.bin;
  if (!binField) return null;

  const candidates = buildBinCandidates(packageName, binName);
  let chosenBinName: string | undefined;
  let binRel: string | undefined;

  if (typeof binField === "string") {
    chosenBinName = defaultBinName(packageName);
    binRel = binField;
  } else {
    for (const candidate of candidates) {
      if (binField[candidate]) {
        chosenBinName = candidate;
        binRel = binField[candidate];
        break;
      }
    }
    if (!binRel) {
      const firstEntry = Object.entries(binField)[0];
      if (firstEntry) {
        chosenBinName = firstEntry[0];
        binRel = firstEntry[1];
      }
    }
  }

  if (!binRel) return null;

  const nodeModulesDir = findNodeModulesDir(packageDir);
  const binLink = chosenBinName ? join(nodeModulesDir, ".bin", chosenBinName) : null;
  let resolvedBin = binLink && existsSync(binLink) ? safeRealpath(binLink) : "";
  if (!resolvedBin) {
    resolvedBin = resolve(packageDir, binRel);
    if (!existsSync(resolvedBin)) return null;
  }

  const isJs = detectJsBinary(resolvedBin);
  return {
    resolvedBin,
    resolvedAt: Date.now(),
    ...(pkg?.version !== undefined ? { packageVersion: pkg.version } : {}),
    isJs,
  };
}

const FORCE_CACHE_TIMEOUT_MS = 30_000;

async function forceNpxCache(packageSpec: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = crossSpawn(
        "npm",
        ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"],
        { stdio: "ignore" }
      );
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("timeout"));
      }, FORCE_CACHE_TIMEOUT_MS);
      const abort = () => {
        proc.kill();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("MCP request aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer.unref();
      proc.on("close", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(err);
      });
    });
  } catch {
    if (signal?.aborted) throwIfAborted(signal);
    // Ignore failures, resolution will fall back to original command
  }
  throwIfAborted(signal);
}

function buildBinCandidates(packageName: string, explicitBin?: string): string[] {
  const candidates: string[] = [];
  if (explicitBin) candidates.push(explicitBin);

  if (packageName.startsWith("@")) {
    const namePart = packageName.split("/")[1] ?? "";
    const scopePart = packageName.split("/")[0]?.replace("@", "") ?? "";
    if (namePart) candidates.push(namePart);
    if (scopePart && namePart) candidates.push(`${scopePart}-${namePart}`);
  } else {
    candidates.push(packageName);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function parsePackageSpec(spec: string): ParsedPackageSpec | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  let packageName: string;
  let requestedVersion: string | undefined;
  if (trimmed.startsWith("@")) {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex < 0) return null;
    const atIndex = trimmed.lastIndexOf("@");
    if (atIndex > slashIndex) {
      packageName = trimmed.slice(0, atIndex);
      requestedVersion = trimmed.slice(atIndex + 1);
    } else {
      packageName = trimmed;
    }
  } else {
    const atIndex = trimmed.indexOf("@");
    if (atIndex >= 0) {
      packageName = trimmed.slice(0, atIndex);
      requestedVersion = trimmed.slice(atIndex + 1);
    } else {
      packageName = trimmed;
    }
  }

  if (!packageName) return null;
  const normalizedVersion = requestedVersion?.replace(/^=/, "").replace(/^v/i, "");
  return {
    packageName,
    ...(normalizedVersion && EXACT_PACKAGE_VERSION_RE.test(normalizedVersion)
      ? { exactVersion: normalizedVersion }
      : {}),
  };
}

function defaultBinName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const parts = packageName.split("/");
    return parts[1] ?? packageName.replace("@", "").replace("/", "-");
  }
  return packageName;
}

function findCachedPackageDir(cacheDir: string, packageName: string, exactVersion?: string): string | null {
  const npxDir = join(cacheDir, "_npx");
  if (!existsSync(npxDir)) return null;

  const packagePathParts = packageName.startsWith("@")
    ? packageName.split("/")
    : [packageName];

  const candidates = readdirSync(npxDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const full = join(npxDir, entry.name);
      const mtime = safeStatMtime(full);
      return { name: entry.name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of candidates) {
    const pkgDir = join(npxDir, entry.name, "node_modules", ...packagePathParts);
    const packageJsonPath = join(pkgDir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    if (exactVersion) {
      try {
        const pkg = readPackageFile(packageJsonPath).value;
        if (pkg?.version !== exactVersion) continue;
      } catch {
        continue;
      }
    }
    return pkgDir;
  }

  return null;
}

function findNodeModulesDir(packageDir: string): string {
  const parts = packageDir.split(sep);
  const idx = parts.lastIndexOf("node_modules");
  if (idx >= 0) {
    return parts.slice(0, idx + 1).join(sep);
  }
  return join(packageDir, "..");
}

function detectJsBinary(binPath: string): boolean {
  const ext = extname(binPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true;
  try {
    const fd = openSync(binPath, "r");
    try {
      const buf = Buffer.alloc(256);
      readSync(fd, buf, 0, 256, 0);
      const firstLine = buf.toString("utf-8").split("\n")[0] ?? "";
      return firstLine.startsWith("#!") && firstLine.includes("node");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

const readPackageFile = createFileReader(text => JSON.parse(text) as { bin?: string | Record<string, string>; version?: string });
let npmCacheDirCached: string | null | undefined;
let npmCacheEnvironment: string | undefined;

function getNpmCacheDir(): string | null {
  const identity = JSON.stringify([process.env.NPM_CONFIG_CACHE, process.env.npm_config_cache, process.env.HOME, process.env.PATH,
    process.env.NPM_CONFIG_USERCONFIG, process.env.npm_config_userconfig, process.cwd()]);
  if (identity !== npmCacheEnvironment) {
    npmCacheEnvironment = identity;
    npmCacheDirCached = undefined;
  }
  if (npmCacheDirCached !== undefined) return npmCacheDirCached;
  const configured = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (configured) {
    npmCacheDirCached = resolve(configured);
    return npmCacheDirCached;
  }
  try {
    const result = crossSpawn.sync("npm", ["config", "get", "cache"], { encoding: "utf-8" });
    if (result.status === 0) {
      const path = String(result.stdout).trim();
      npmCacheDirCached = path || null;
      return npmCacheDirCached;
    }
  } catch {
    npmCacheDirCached = null;
    return null;
  }
  npmCacheDirCached = null;
  return null;
}

function getNpxCachePath(): string {
  return getAgentPath("mcp-npx-cache.json");
}

const readNpxCacheFile = createFileReader((text): NpxCache | null => {
  const raw: unknown = JSON.parse(text);
  // Version 1's key did not encode invocation identity; migrate only after a successful resolution.
  if (asRecord(raw)?.version === 1) return null;
  const cache = toNpxCache(raw);
  if (!cache) throw new Error("invalid npx cache format");
  return cache;
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function createCacheEntries(): Record<string, NpxCacheEntry> {
  return Object.create(null) as Record<string, NpxCacheEntry>;
}

function toNpxCacheEntry(value: unknown): NpxCacheEntry | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (typeof raw.resolvedBin !== "string") return null;
  if (typeof raw.resolvedAt !== "number" || !Number.isFinite(raw.resolvedAt)) return null;
  if (typeof raw.isJs !== "boolean") return null;
  if (raw.packageVersion !== undefined && typeof raw.packageVersion !== "string") return null;
  return {
    resolvedBin: raw.resolvedBin,
    resolvedAt: raw.resolvedAt,
    ...(raw.packageVersion !== undefined ? { packageVersion: raw.packageVersion } : {}),
    isJs: raw.isJs,
  };
}

function toNpxCache(value: unknown): NpxCache | null {
  const raw = asRecord(value);
  if (!raw || raw.version !== CACHE_VERSION) return null;
  const rawEntries = asRecord(raw.entries);
  if (!rawEntries) return null;

  const entries = createCacheEntries();
  for (const [key, rawEntry] of Object.entries(rawEntries)) {
    const entry = toNpxCacheEntry(rawEntry);
    if (!entry) throw new Error("invalid npx cache entry");
    entries[key] = entry;
  }
  return { version: CACHE_VERSION, entries };
}

function loadCache(): NpxCache | null {
  try {
    return readNpxCacheFile(getNpxCachePath()).value ?? null;
  } catch (error) {
    console.warn(`MCP npx cache unavailable: ${describeFileError(error)}`);
    return null;
  }
}

function saveCacheEntry(key: string, entry: NpxCacheEntry): void {
  try {
    const cachePath = getNpxCachePath();
    const existing = readNpxCacheFile(cachePath).value;
    const entries = createCacheEntries();
    if (existing) Object.assign(entries, existing.entries);
    const merged: NpxCache = { version: CACHE_VERSION, entries };

    merged.entries[key] = entry;
    if (existing && canonicalJson(existing) === canonicalJson(merged)) return;
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
    renameSync(tmpPath, cachePath);
  } catch (error) {
    // Resolution can proceed, but a failed read never replaces the existing cache.
    console.warn(`MCP npx cache not saved: ${describeFileError(error)}`);
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function safeStatMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
