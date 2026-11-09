import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config/agent-dir.ts";
import type { StatusLineCommandConfig, StatusLineSettings } from "./types.ts";

const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");

export function globalStatusLineSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

const configCache = new Map<string, StatusLineCommandConfig | null>();

export function clearConfigCache(cwd?: string): void {
  if (cwd) {
    configCache.delete(cwd);
  } else {
    configCache.clear();
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function mergeStatusLineSettings(
  base: Partial<StatusLineCommandConfig>,
  next: Partial<StatusLineCommandConfig> | undefined,
): Partial<StatusLineCommandConfig> {
  if (!next) return base;
  return { ...base, ...next };
}

export function readStatusLineConfig(cwd: string): StatusLineCommandConfig | null {
  if (configCache.has(cwd)) {
    return configCache.get(cwd) ?? null;
  }

  const candidates = [globalStatusLineSettingsPath(), PROJECT_SETTINGS_PATH];
  const cwdSettingsPath = join(cwd, ".pi", "settings.json");
  if (!candidates.includes(cwdSettingsPath)) {
    candidates.push(cwdSettingsPath);
  }

  let merged: Partial<StatusLineCommandConfig> = {};

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    try {
      const parsed = readJson(path) as StatusLineSettings;
      merged = mergeStatusLineSettings(merged, parsed.statusLine);
    } catch {
      continue;
    }
  }

  const value =
    merged.type !== "command" || !merged.command
      ? null
      : {
          type: "command" as const,
          command: merged.command,
          placement: merged.placement ?? "footer",
          padding: normalizeOptionalNumber(merged.padding) ?? 0,
          widgetPlacement: merged.widgetPlacement ?? "belowEditor",
          debounceMs: normalizeOptionalNumber(merged.debounceMs) ?? 300,
          timeoutMs: normalizeOptionalNumber(merged.timeoutMs),
        };

  configCache.set(cwd, value);
  return value;
}
