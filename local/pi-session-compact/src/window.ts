import { COMPACTION_MODES } from "./config.ts";
import { FOCUS_SCAFFOLD } from "./mode.ts";
import { findCutPoint, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { RESERVE_ACTIONS } from "./reserve.ts";

/** Session-scoped effective window. A custom entry is persisted but never enters model context. */
export const WINDOW_ENTRY = "pi-session-compact:window-v1";
export const COMPACTION_SUBCOMMANDS = ["window", "show", "now", "reserve"] as const;
/** Real values the window parser accepts; free sizes have no finite candidate set. */
export const WINDOW_SCAFFOLDS = ["262k", "off"] as const;
const SUBCOMMAND_HELP: Record<(typeof COMPACTION_SUBCOMMANDS)[number], string> = {
  now: "立即压缩：[auto|main|small] [聚焦说明…]；省略模式按配置",
  window: "本会话有效窗口：<tokens>（如 262k、262144、1m）或 off",
  show: "查看最近一次压缩后模型看到的摘要和这次压缩的要点",
  reserve: "按模型窗口校对 90% 阈值；write 确认后写入全局覆盖",
};
const SCAFFOLD_HELP: Record<(typeof WINDOW_SCAFFOLDS)[number], string> = { "262k": "262,000 tokens", off: "取消本会话有效窗口" };

export function compactionCompletions(prefix: string): Array<{ value: string; label: string; description: string }> | null {
  const query = prefix.trimStart().toLowerCase();
  const space = query.search(/\s/);
  if (space < 0) {
    const items = COMPACTION_SUBCOMMANDS.filter((s) => s.startsWith(query)).map((s) => ({ value: s === "show" ? s : `${s} `, label: s, description: SUBCOMMAND_HELP[s] }));
    return items.length ? items : null;
  }
  if (query.slice(0, space) === "now") {
    const raw = prefix.trimStart().slice(space).trimStart();
    const modeSpace = raw.search(/\s/);
    if (modeSpace >= 0) {
      const mode = COMPACTION_MODES.find((m) => m === raw.slice(0, modeSpace));
      const focus = raw.slice(modeSpace).trimStart();
      return mode && FOCUS_SCAFFOLD.startsWith(focus) ? [{ value: `now ${mode} ${FOCUS_SCAFFOLD}`, label: FOCUS_SCAFFOLD, description: "本次压缩的聚焦说明（自由文本）" }] : null;
    }
    const modes = COMPACTION_MODES.filter((m) => m.startsWith(raw)).map((m) => ({ value: `now ${m} `, label: m, description: `本次指定 ${m}，不修改配置` }));
    const scaffold = FOCUS_SCAFFOLD.startsWith(raw) ? [{ value: `now ${FOCUS_SCAFFOLD}`, label: FOCUS_SCAFFOLD, description: "按配置压缩，并附本次聚焦说明" }] : [];
    return modes.length || scaffold.length ? [...modes, ...scaffold] : null;
  }
  if (query.slice(0, space) === "reserve") {
    const value = query.slice(space).trimStart();
    const items = RESERVE_ACTIONS.filter((s) => s.startsWith(value)).map((s) => ({ value: `reserve ${s}`, label: s, description: "确认后备份并写入全局 modelOverrides" }));
    return items.length ? items : null;
  }
  if (query.slice(0, space) !== "window") return null;
  const value = query.slice(space).trim();
  const items = WINDOW_SCAFFOLDS.filter((s) => s.startsWith(value)).map((s) => ({ value: `window ${s}`, label: s, description: SCAFFOLD_HELP[s] }));
  return items.length ? items : null;
}

/** `262k`, `262144`, `1m`, `1.5m` (k = 1,000) or `off`; anything else is undefined. */
export function parseWindow(text: string): number | "off" | undefined {
  const value = text.trim().toLowerCase();
  if (value === "off") return "off";
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(value);
  if (!match) return undefined;
  const tokens = Math.round(Number(match[1]) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1000 : 1));
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** The latest window entry on the active branch wins; `null` data means it was turned off. */
export function sessionWindow(branch: SessionEntry[]): number | undefined {
  const entry = branch.findLast((e) => e.type === "custom" && e.customType === WINDOW_ENTRY);
  const tokens = entry?.type === "custom" ? (entry.data as { tokens?: unknown } | undefined)?.tokens : undefined;
  return typeof tokens === "number" && tokens > 0 ? tokens : undefined;
}

export const windowThreshold = (window: number): number => Math.floor(window * 0.9);
export const keepRecentFor = (window: number): number => Math.min(20000, Math.floor(window * 0.2));
/** The two 512-token margins the summary budget already reserves for recovery text and rounding. */
const COMPACTION_MARGIN = 1024;
/** A compacted context (fixed prompt, full summary, kept tail, recovery) must land under the trigger again. */
export const holdsCompaction = (window: number, fixedTokens: number, currentSummaryTokens: number, outputReserve = 0): boolean =>
  fixedTokens + currentSummaryTokens + outputReserve + Math.min(20000, window * 0.2) + COMPACTION_MARGIN <= window * 0.9;
export function minimumWindow(fixedTokens: number, currentSummaryTokens: number, outputReserve = 0): number {
  let low = 1, high = 2 ** 31;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (holdsCompaction(mid, fixedTokens, currentSummaryTokens, outputReserve)) high = mid; else low = mid + 1; }
  return low;
}

/**
 * Over 90% compacts. A window-triggered attempt that leaves usage above the threshold only warns
 * once; triggering resumes after usage falls back below it or another compaction appears.
 */
export interface WindowGuard { compactionId: string | null; warned: boolean }
export function windowAction(used: number | null, window: number, latestCompactionId: string | null, guard: WindowGuard | undefined): "unknown" | "below" | "compact" | "warn" | "suppressed" {
  if (used === null) return "unknown";
  if (used <= windowThreshold(window)) return "below";
  if (guard && guard.compactionId === latestCompactionId) return guard.warned ? "suppressed" : "warn";
  return "compact";
}

/** Kept tail for the effective window, cut with Pi's public algorithm after the latest compaction. */
export function windowFirstKept(branch: SessionEntry[], keepRecentTokens: number): string | undefined {
  const start = branch.findLastIndex((e) => e.type === "compaction") + 1;
  if (start >= branch.length) return undefined;
  return branch[findCutPoint(branch, start, branch.length, keepRecentTokens).firstKeptEntryIndex]?.id;
}
