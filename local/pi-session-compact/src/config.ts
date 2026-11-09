import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Throughput } from "./budget.ts";
import type{ModelThinkingLevel}from"@earendil-works/pi-ai";
export const COMPACTION_MODES = ["auto", "main", "small"] as const;
export type CompactionMode = (typeof COMPACTION_MODES)[number];
export interface Config {
  mode: CompactionMode;
  autoIdleMinutes: number;
  totalTimeoutMinutes: number;
  queuePauseCapMinutes: number;
  mainMemory: "digest" | "full";
  smallModel?: { provider: string; id: string; effort: ModelThinkingLevel };
  shadow: { enabled: boolean; adopt: "main" | "small" };
  outputTokens: number; summaryTokens?: number; deprecatedSettings?: string[];
  retry: { invalidOutput: number; network: "pi" | number };
  calibration: boolean;
  throughput: Record<string, Throughput>;
}
export const DEFAULT_CONFIG: Config = {
  mode: "main", autoIdleMinutes: 20, totalTimeoutMinutes: 10, queuePauseCapMinutes: 30, mainMemory: "digest",
  shadow: { enabled: false, adopt: "main" }, outputTokens: 16384,
  retry: { invalidOutput: 1, network: "pi" }, calibration: false, throughput: {},
};
export async function readConfig(agentDir: string): Promise<Config> {
  let raw: Partial<Config> = {};
  try { raw = JSON.parse(await readFile(join(agentDir, "pi-session-compact/config.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (raw.retry !== undefined && (!raw.retry || typeof raw.retry !== "object" || Array.isArray(raw.retry))) throw new Error("Invalid retry: must be an object");
  const config = { ...DEFAULT_CONFIG, ...raw, retry: { ...DEFAULT_CONFIG.retry, ...raw.retry }, shadow: { ...DEFAULT_CONFIG.shadow, ...raw.shadow }, smallModel: raw.smallModel === undefined ? undefined : { ...raw.smallModel, effort: raw.smallModel?.effort ?? "off" as const } };
  if (!COMPACTION_MODES.includes(config.mode) || !["main", "small"].includes(config.shadow.adopt) || typeof config.shadow.enabled !== "boolean" || typeof config.calibration !== "boolean") throw new Error("Invalid compactor mode/shadow/calibration");
  if (typeof config.autoIdleMinutes !== "number" || !Number.isFinite(config.autoIdleMinutes) || config.autoIdleMinutes <= 0) throw new Error("Invalid autoIdleMinutes: must be a finite positive number");
  if (typeof config.totalTimeoutMinutes !== "number" || !Number.isFinite(config.totalTimeoutMinutes) || config.totalTimeoutMinutes < 0) throw new Error("Invalid totalTimeoutMinutes: must be a finite non-negative number");
  if (typeof config.queuePauseCapMinutes !== "number" || !Number.isFinite(config.queuePauseCapMinutes) || config.queuePauseCapMinutes <= 0) throw new Error("Invalid queuePauseCapMinutes: must be a finite positive number");
  if (!["digest", "full"].includes(config.mainMemory)) throw new Error("Invalid mainMemory");
  if (raw.smallModel !== undefined && (!raw.smallModel || typeof raw.smallModel !== "object" || Array.isArray(raw.smallModel) || typeof config.smallModel?.provider !== "string" || !config.smallModel.provider.trim() || typeof config.smallModel.id !== "string" || !config.smallModel.id.trim() || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.smallModel.effort))) throw new Error("Invalid smallModel: specify provider, id and a supported effort (default off)");
  config.deprecatedSettings = Object.hasOwn(raw, "summaryTokens") ? ["summaryTokens 已停用：不再限制或裁剪摘要，按完整恢复上下文核对窗口。"] : [];
  for (const key of ["outputTokens"] as const) if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 100000) throw new Error(`Invalid ${key}`);
  if (!Number.isSafeInteger(config.retry.invalidOutput) || config.retry.invalidOutput < 0) throw new Error("Invalid retry.invalidOutput: must be a non-negative integer");
  if (config.retry.network !== "pi" && (!Number.isSafeInteger(config.retry.network) || config.retry.network < 0)) throw new Error('Invalid retry.network: must be "pi" or a non-negative integer');
  return config;
}
