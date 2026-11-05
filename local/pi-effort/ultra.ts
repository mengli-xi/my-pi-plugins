/**
 * The `ultra` rung: everything about it that can be decided without a running
 * pi. Kept separate from levels.ts because ultra is the one rung that is not a
 * pi thinking level — pi's `ThinkingLevel` is a closed union, so ultra is
 * presented by this package, pins the model's top real level underneath, and
 * adds a prompt fragment on top.
 *
 * This mirrors Codex's `Ultra`, which is likewise an extra rung above the
 * model's maximum that sends the max effort on the wire and switches the agent
 * into proactive delegation. Picking `max` and picking `ultra` are deliberately
 * different: only ultra injects.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Custom session entry carrying the per-session ultra flag. */
export const ULTRA_STATE_ENTRY_TYPE = "pi-effort:ultra-v1";
/** Key this package contributes under on `prompt:fragments-v1`. */
export const ULTRA_FRAGMENT_KEY = "effort:ultra";
/** Overridable prompt text and settings, both under the agent dir. */
export const ULTRA_PROMPT_FILE = "ultra-prompt.md";
export const ULTRA_CONFIG_FILE = "pi-effort.json";

/**
 * The mode switch is contributed as a fragment; delegation instructions stay
 * in the on-demand skill. This mode never grants permissions or overrides
 * user instructions and approval requirements.
 */
export const DEFAULT_ULTRA_PROMPT = `## Delegation mode

Proactive multi-agent delegation is active. Use sub-agents when permitted by current user instructions and tool permissions, and when parallel work would materially improve speed or quality. This mode does not override approval requirements or grant additional permissions.

Before delegating, read the \`subagents\` skill for task decomposition, roles, and waiting.`;

export interface UltraConfig {
  /** Tool that must be registered for the fragment to be injected. */
  subagentTool: string;
  /** Package expected to provide it; used only for the friendlier warning. */
  subagentPackage?: string;
}

export const DEFAULT_ULTRA_CONFIG: UltraConfig = { subagentTool: "spawn_agent" };

interface FileSnapshot {
  version: string;
  value?: unknown;
  error?: Error;
}

// Cache filesystem snapshots, not session state. Each fixed filename has one
// parser; separate bundles may cache independently without coordinating state.
const fileSnapshots = new Map<string, FileSnapshot>();

function readCached<T>(path: string, parse: (raw: string) => T, missing: T): T {
  let version: string;
  let statError: unknown;
  try {
    const stat = statSync(path, { bigint: true });
    version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    version = `stat:${code ?? "UNKNOWN"}`;
    if (code !== "ENOENT") statError = error;
  }
  let snapshot = fileSnapshots.get(path);
  if (!snapshot || snapshot.version !== version) {
    snapshot = { version };
    try {
      if (statError) throw statError;
      snapshot.value = version === "stat:ENOENT" ? missing : parse(readFileSync(path, "utf8"));
    } catch (error) {
      const detail = (error as NodeJS.ErrnoException)?.code
        ?? (error instanceof Error ? error.message : "Unknown file error");
      snapshot.error = new Error(`${path}: ${detail}`, { cause: error });
    }
    fileSnapshots.set(path, snapshot);
  }
  if (snapshot.error) throw snapshot.error;
  return snapshot.value as T;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    // JSON.parse messages can contain source bytes. Retain the cause, but only
    // expose a position, never config/prompt contents, in the user diagnostic.
    const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
    throw new Error(`Invalid JSON${position ? ` at position ${position}` : ""}`, { cause: error });
  }
}

/** Missing config uses defaults; invalid/unreadable config must not enable a fragment. */
export function readUltraConfig(agentDir: string): UltraConfig {
  const config = readCached(join(agentDir, ULTRA_CONFIG_FILE), (raw): UltraConfig => {
    const parsed = parseJson(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Expected a configuration object");
    }
    const ultra = (parsed as { ultra?: unknown }).ultra;
    if (ultra === undefined) return { ...DEFAULT_ULTRA_CONFIG };
    if (typeof ultra !== "object" || ultra === null || Array.isArray(ultra)) {
      throw new Error("ultra must be an object");
    }
    const { subagentTool, subagentPackage } = ultra as Record<string, unknown>;
    if (subagentTool !== undefined && (typeof subagentTool !== "string" || !subagentTool.trim())) {
      throw new Error("ultra.subagentTool must be a non-empty string");
    }
    if (subagentPackage !== undefined && typeof subagentPackage !== "string") {
      throw new Error("ultra.subagentPackage must be a string");
    }
    return {
      subagentTool: typeof subagentTool === "string" ? subagentTool.trim() : DEFAULT_ULTRA_CONFIG.subagentTool,
      subagentPackage: typeof subagentPackage === "string" ? subagentPackage.trim() || undefined : undefined,
    };
  }, DEFAULT_ULTRA_CONFIG);
  return { ...config };
}

/** Missing/blank override uses the default; other failures disable contribution. */
export function loadUltraPrompt(agentDir: string): string {
  return readCached(join(agentDir, ULTRA_PROMPT_FILE),
    (raw) => raw.trim() || DEFAULT_ULTRA_PROMPT, DEFAULT_ULTRA_PROMPT);
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Latest ultra flag on this branch; false when never set. */
export function restoreUltra(entries: readonly SessionEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== ULTRA_STATE_ENTRY_TYPE) continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const enabled = (data as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") return enabled;
  }
  return false;
}

export type UltraGate =
  | { inject: true; text: string }
  | { inject: false; reason: "off" | "missing-tool" };

/**
 * Decide whether to contribute the fragment this run.
 *
 * The tool check is the load-bearing one: instructing a model to spawn
 * sub-agents when no such tool is registered is exactly how a run derails, so
 * an ultra session without confirmed tools injects nothing and says why.
 * Missing or malformed selectedTools cannot prove permission to delegate.
 */
export function ultraGate(options: {
  enabled: boolean;
  selectedTools: readonly string[] | undefined;
  config: UltraConfig;
  text: string;
}): UltraGate {
  if (!options.enabled) return { inject: false, reason: "off" };
  const tools = options.selectedTools;
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")
    || !tools.includes(options.config.subagentTool)) {
    return { inject: false, reason: "missing-tool" };
  }
  const text = options.text.trim();
  if (!text) return { inject: false, reason: "off" };
  return { inject: true, text };
}

/** Human-readable warning for a gate that refused to inject. */
export function missingToolWarning(config: UltraConfig): string {
  const where = config.subagentPackage
    ? ` Enable ${config.subagentPackage} (or point ultra.subagentPackage at the package that registers it).`
    : " Enable a sub-agent package, or set ultra.subagentTool in pi-effort.json.";
  return `ultra: no confirmed \`${config.subagentTool}\` tool in this turn, so the delegation prompt was not injected.${where}`;
}


/**
 * Best-effort check, at the moment ultra is switched on, that the configured
 * sub-agent package is registered in settings. Returns undefined when the
 * question cannot be answered — no package configured, or settings unreadable
 * — because a warning we are not sure about is worse than none. The
 * authoritative check is `ultraGate` on the tool itself at run time.
 */
export function subagentPackageEnabled(
  agentDir: string,
  config: UltraConfig,
): boolean | undefined {
  if (!config.subagentPackage) return undefined;
  let parsed: unknown;
  try {
    parsed = readCached(join(agentDir, "settings.json"),
      (raw) => parseJson(raw.replace(/^\s*\/\/.*$/gm, "")), undefined);
  } catch {
    // This is advisory only: unknown settings cannot authorize contribution.
    // The confirmed per-turn tool gate remains authoritative.
    return undefined;
  }
  const packages =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { packages?: unknown }).packages
      : undefined;
  if (!Array.isArray(packages)) return undefined;
  const needle = config.subagentPackage;
  return packages.some((entry) => {
    const source = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
    if (typeof source !== "string" || !source.includes(needle)) return false;
    // An entry present but explicitly not autoloaded is not "enabled".
    return typeof entry === "string" || (entry as { autoload?: unknown }).autoload !== false;
  });
}
