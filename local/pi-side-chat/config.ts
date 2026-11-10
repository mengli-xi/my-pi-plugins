import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SideConfig {
  shortcut: string;
}

export const DEFAULT_CONFIG: SideConfig = { shortcut: "alt+/" };
export const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-side-chat", "config.json");

export function assertSdkOnlyEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PI_SIDE_BACKEND !== undefined) {
    throw new Error("Side Chat 现在只支持同进程运行。请移除环境变量 PI_SIDE_BACKEND 后重启 pi。");
  }
}

export function parseConfig(value: unknown, path: string = CONFIG_PATH): SideConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Side Chat 配置 ${path} 必须包含 JSON 对象。请修改后重启 pi。`);
  }
  const record = value as Record<string, unknown>;
  for (const key of ["defaultBackend", "extensionCommands"]) {
    if (Object.hasOwn(record, key)) {
      throw new Error(`请从 ${path} 删除 ${key}；Side Chat 现在只支持同进程运行，不再使用这项配置。修改后请重启 pi。`);
    }
  }
  const shortcut = record.shortcut === undefined ? DEFAULT_CONFIG.shortcut : record.shortcut;
  if (typeof shortcut !== "string" || shortcut.trim().length === 0) {
    throw new Error(`Side Chat 配置 ${path} 中的 shortcut 必须是非空快捷键。请修改后重启 pi。`);
  }
  return { shortcut: shortcut.trim() };
}

export function loadConfig(path: string = CONFIG_PATH): SideConfig {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 Side Chat 配置 ${path}：${error instanceof Error ? error.message : String(error)}。请检查文件内容并重启 pi。`);
  }
  return parseConfig(value, path);
}
