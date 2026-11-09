import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { COMPACTION_MODES, type CompactionMode, type Config } from "./config.ts";

export const FOCUS_SCAFFOLD = "请保留当前任务的约束和待办";
export function parseNow(text: string): { mode?: CompactionMode; customInstructions?: string } {
  const value = text.trim();
  const first = value.split(/\s+/, 1)[0];
  const mode = COMPACTION_MODES.find((m) => m === first);
  return { mode, customInstructions: (mode ? value.slice(first.length).trim() : value) || undefined };
}
export interface ModeSelection {
  requestedMode: CompactionMode; selectedMode: "main" | "small";
  source: "manual" | "config"; reason: string;
  autoIdleMinutes?: number; idleMs?: number; lastAssistantTimestamp?: number;
}
/** Only the active ancestry counts; use the assistant message timestamp, not its entry time. */
export function selectMode(config: Config, branch: SessionEntry[], manual?: CompactionMode, now = Date.now()): ModeSelection {
  const requestedMode = manual ?? config.mode;
  const selection: ModeSelection = {
    requestedMode, selectedMode: "main", source: manual ? "manual" : "config", reason: "",
  };
  const prefix = manual ? `手动指定 ${manual}；` : "";
  if (requestedMode !== "auto") {
    // Preserve existing explicit shadow adoption for configured main/small. An override always wins.
    selection.selectedMode = manual ? requestedMode : config.shadow.enabled ? config.shadow.adopt : requestedMode;
    selection.reason = manual ? `手动指定 ${manual}` : `配置 ${requestedMode}${config.shadow.enabled ? `；影子配置采用 ${selection.selectedMode}` : ""}`;
    return selection;
  }
  selection.autoIdleMinutes = config.autoIdleMinutes;
  const last = branch.findLast((e) => e.type === "message" && e.message.role === "assistant");
  const timestamp = last?.type === "message" && last.message.role === "assistant" ? last.message.timestamp : undefined;
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    selection.reason = `${prefix}自动：没有历史 assistant 消息时间 → 主模型`;
    return selection;
  }
  const idleMs = Math.max(0, now - timestamp);
  selection.idleMs = idleMs;
  selection.lastAssistantTimestamp = timestamp;
  selection.selectedMode = idleMs / 60000 < config.autoIdleMinutes ? "main" : "small";
  const minutes = idleMs / 60000;
  const rounded = Number(minutes.toFixed(3));
  const display = (rounded < config.autoIdleMinutes) === (selection.selectedMode === "main") ? rounded : minutes;
  selection.reason = `${prefix}自动：距上次请求 ${display} 分钟 ${selection.selectedMode === "main" ? "<" : "≥"} ${config.autoIdleMinutes} 分钟 → ${selection.selectedMode === "main" ? "主模型" : "小模型"}`;
  return selection;
}

export function fallbackDescription(reason: string): string {
  if (/effective-prefix-unavailable(?:$|:)/.test(reason)) return `旧记录：主模型缺少已确认的有效请求前缀 → 小模型（${reason}）；当前版本会先按当前会话历史重建主模型请求。`;
  return reason === "main-budget-overflow" ? "主模型准入超预算 → 小模型" : `主模型回退 → 小模型（${reason}）`;
}
