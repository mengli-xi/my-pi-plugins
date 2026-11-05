import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Conf from "conf";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const NAMING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type NamingEffort = (typeof NAMING_EFFORTS)[number];

export interface SessionNamingConfig {
  enabled: boolean;
  model: string;
  effort: NamingEffort;
  maxChars: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

export const DEFAULT_CONFIG: SessionNamingConfig = {
  enabled: true,
  model: "session",
  effort: "off",
  maxChars: 24,
  timeoutMs: 15_000,
  maxOutputTokens: 128,
};

export type ConfigKey = keyof SessionNamingConfig;

interface MigrationReceipt {
  at: string;
  sourcePath: string;
  sha256: string;
}

interface StoredConfig {
  schemaVersion: 2;
  revision: number;
  overrides: Partial<SessionNamingConfig>;
  migration?: MigrationReceipt;
}

export interface ConfigServiceOptions {
  agentDir?: string;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(key: ConfigKey, value: unknown): SessionNamingConfig[ConfigKey] {
  if (key === "enabled") {
    if (typeof value !== "boolean") throw new TypeError(`${key} expects boolean`);
    return value;
  }
  if (key === "model") {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("model expects a non-empty string");
    }
    return value.trim();
  }
  if (key === "effort") {
    if (typeof value !== "string" || !NAMING_EFFORTS.includes(value as NamingEffort)) {
      throw new RangeError(`effort expects one of ${NAMING_EFFORTS.join(", ")}`);
    }
    return value as NamingEffort;
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${key} expects an integer`);
  }
  if (key === "maxChars" && ((value as number) < 8 || (value as number) > 64)) {
    throw new RangeError("maxChars expects an integer in 8..64");
  }
  if (key === "timeoutMs" && ((value as number) < 1_000 || (value as number) > 60_000)) {
    throw new RangeError("timeoutMs expects an integer in 1000..60000");
  }
  if (key === "maxOutputTokens" && ((value as number) < 32 || (value as number) > 2_048)) {
    throw new RangeError("maxOutputTokens expects an integer in 32..2048");
  }
  return value as number;
}

function sanitizeOverrides(value: unknown): Partial<SessionNamingConfig> {
  if (!isRecord(value)) return {};
  const result: Partial<SessionNamingConfig> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as ConfigKey[]) {
    if (value[key] === undefined) continue;
    try {
      Object.assign(result, { [key]: validate(key, value[key]) });
    } catch {
      // A bad legacy field must not poison the independent store.
    }
  }
  return result;
}

function parseStored(raw: string): { stored: StoredConfig; migrated: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("invalid JSON in session naming config", { cause: error });
  }
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error("expected schemaVersion 1 or 2");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("expected a non-negative revision");
  }
  if (!isRecord(value.overrides)) throw new Error("expected object overrides");
  const rawOverrides = value.overrides as Record<string, unknown>;
  const overrides = sanitizeOverrides(rawOverrides);
  const acceptedKeys = Object.keys(rawOverrides).filter((key) =>
    value.schemaVersion === 1 && key === "showInEditorBorder" ? false : true
  );
  if (Object.keys(overrides).length !== acceptedKeys.length) {
    throw new Error("stored config contains invalid fields");
  }
  let migration: MigrationReceipt | undefined;
  if (value.migration !== undefined) {
    if (!isRecord(value.migration) ||
      typeof value.migration.at !== "string" ||
      typeof value.migration.sourcePath !== "string" ||
      typeof value.migration.sha256 !== "string") {
      throw new Error("expected a valid migration receipt");
    }
    migration = value.migration as unknown as MigrationReceipt;
  }
  return {
    stored: {
      schemaVersion: 2,
      revision: value.revision as number,
      overrides,
      ...(migration ? { migration } : {}),
    },
    migrated: value.schemaVersion === 1,
  };
}

function readLegacy(agentDir: string, now: Date): Pick<StoredConfig, "overrides" | "migration"> {
  const core = join(agentDir, "extensions", "pi-claude-style", "config.json");
  const candidates = [
    core,
    `${core}.schema-v2.bak`,
    `${core}.schema-v1.bak`,
    join(agentDir, "extensions", "pi-claude-transcript", "config.json"),
  ];
  for (const sourcePath of candidates) {
    if (!existsSync(sourcePath)) continue;
    try {
      const raw = readFileSync(sourcePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) continue;
      const source = isRecord(parsed.overrides)
        ? (parsed.overrides as Record<string, unknown>).transcript
        : parsed;
      const naming = isRecord(source)
        ? (source as Record<string, unknown>).sessionNaming
        : undefined;
      if (!isRecord(naming)) continue;
      return {
        overrides: sanitizeOverrides(naming),
        migration: {
          at: now.toISOString(),
          sourcePath,
          sha256: createHash("sha256").update(raw).digest("hex"),
        },
      };
    } catch {
      // Try the next read-only source or backup.
    }
  }
  return { overrides: {} };
}

export class SessionNamingConfigService {
  readonly path: string;
  degradedError: string | undefined;
  private readonly now: () => Date;
  private conf: Conf<StoredConfig> | undefined;
  private stored: StoredConfig;
  private observedMtimeMs: number | undefined;

  constructor(options: ConfigServiceOptions = {}) {
    const configuredAgentDir = options.agentDir ?? getAgentDir();
    const agentDir = isAbsolute(configuredAgentDir)
      ? configuredAgentDir
      : resolve(process.cwd(), configuredAgentDir);
    this.now = options.now ?? (() => new Date());
    const cwd = join(agentDir, "extensions", "pi-session-naming");
    this.path = join(cwd, "config.json");
    let migrated = false;
    if (existsSync(this.path)) {
      try {
        const parsed = parseStored(readFileSync(this.path, "utf8"));
        this.stored = parsed.stored;
        migrated = parsed.migrated;
        this.observedMtimeMs = statSync(this.path).mtimeMs;
      } catch (error) {
        this.degradedError = error instanceof Error ? error.message : String(error);
        this.stored = { schemaVersion: 2, revision: 0, overrides: {} };
        return;
      }
    } else {
      this.stored = {
        schemaVersion: 2,
        revision: 0,
        ...readLegacy(agentDir, this.now()),
      };
    }
    try {
      mkdirSync(cwd, { recursive: true });
      this.conf = new Conf<StoredConfig>({ cwd, configName: "config", clearInvalidConfig: false });
      if (!existsSync(this.path) || migrated) this.conf.store = this.stored;
      this.observedMtimeMs = statSync(this.path).mtimeMs;
    } catch (error) {
      this.conf = undefined;
      this.degradedError = `store unavailable: ${(error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "unknown")}`;
    }
  }

  get revision(): number {
    return this.stored.revision;
  }

  get active(): SessionNamingConfig {
    return {
      ...DEFAULT_CONFIG,
      ...structuredClone(this.stored.overrides),
      ...(this.degradedError !== undefined ? { enabled: false } : {}),
    };
  }

  get migration(): MigrationReceipt | undefined {
    return this.stored.migration ? structuredClone(this.stored.migration) : undefined;
  }

  get(key: ConfigKey): { active: SessionNamingConfig[ConfigKey]; stored: unknown } {
    return { active: this.active[key], stored: this.stored.overrides[key] };
  }

  set(key: ConfigKey, value: unknown, expectedRevision = this.revision): void {
    const next = { ...this.stored.overrides, [key]: validate(key, value) };
    this.commit(next, expectedRevision);
  }

  reset(key: ConfigKey, expectedRevision = this.revision): void {
    const next = { ...this.stored.overrides };
    delete next[key];
    this.commit(next, expectedRevision);
  }

  resetAll(expectedRevision = this.revision): void {
    this.commit({}, expectedRevision);
  }

  recoverResetAll(): string | undefined {
    if (!this.degradedError) {
      this.resetAll();
      return undefined;
    }
    const suffix = this.now().toISOString().replace(/[:.]/g, "-");
    const backup = `${this.path}.invalid-${suffix}.bak`;
    if (existsSync(this.path)) renameSync(this.path, backup);
    const cwd = dirname(this.path);
    mkdirSync(cwd, { recursive: true });
    this.conf = new Conf<StoredConfig>({ cwd, configName: "config", clearInvalidConfig: false });
    this.stored = { schemaVersion: 2, revision: 0, overrides: {} };
    this.conf.store = this.stored;
    this.observedMtimeMs = statSync(this.path).mtimeMs;
    this.degradedError = undefined;
    return existsSync(backup) ? backup : undefined;
  }

  private commit(overrides: Partial<SessionNamingConfig>, expectedRevision: number): void {
    if (!this.conf || this.degradedError) {
      throw new Error(`config is read-only: ${this.degradedError ?? "store unavailable"}`);
    }
    if (expectedRevision !== this.stored.revision) {
      throw new Error(`revision conflict: expected ${expectedRevision}, active ${this.stored.revision}`);
    }
    if (existsSync(this.path)) {
      const stat = statSync(this.path);
      const disk = parseStored(readFileSync(this.path, "utf8")).stored;
      if (disk.revision !== this.stored.revision ||
        (this.observedMtimeMs !== undefined && stat.mtimeMs !== this.observedMtimeMs)) {
        throw new Error("config changed in another pi session; rerun the command");
      }
    }
    const next: StoredConfig = {
      ...this.stored,
      revision: this.stored.revision + 1,
      overrides,
    };
    this.conf.store = next;
    this.stored = next;
    this.observedMtimeMs = statSync(this.path).mtimeMs;
  }
}

export function isConfigKey(value: string): value is ConfigKey {
  return Object.hasOwn(DEFAULT_CONFIG, value);
}

export function parseConfigValue(input: string): unknown {
  const value = input.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
