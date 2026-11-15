import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionWindow, windowThreshold } from "./window.ts";

/** Owned by pi-claude-style (src/integration-contracts.ts); copied per 根 AGENTS.md 的能力协议表, no package import. */
export const STATUS_LINE_ROW_CHANNEL = "statusline:row";
export const COMPACTION_STATUS_KEY = "compaction";
export interface StatusLineRowPayload {
  key: string;
  line?: string;
  placement?: "row" | "inline" | "slot";
  row?: number;
  align?: "left" | "right";
  /** Optional segment priority; owned by pi-claude-style. */
  order?: number;
  onClick?: () => boolean;
  reply?: (accepted: true) => void;
}

export type Tone = "dim" | "warning";
/** Completed compactions on the active branch, whether the latest is Pi's native format, and 90% of the session window. */
export interface CompactionStatus { count: number; native: boolean; threshold?: number }

/** The active branch alone decides the segment: its compaction entries and its latest window entry. */
export function compactionStatus(branch: SessionEntry[], modelWindow: number | undefined): CompactionStatus {
  const compactions = branch.filter((e) => e.type === "compaction");
  const configured = sessionWindow(branch);
  const window = configured === undefined ? undefined : Math.min(configured, modelWindow ?? configured);
  // Native: this plugin fell back to it, or Pi summarized by itself (e.g. the hook threw before answering).
  const latest = compactions.at(-1);
  const native = !!latest && ((latest.details as { generator?: unknown } | undefined)?.generator === "pi-native" || latest.fromHook !== true);
  return { count: compactions.length, native, ...(window === undefined ? {} : { threshold: windowThreshold(window) }) };
}

/** `235800` → `236k`, `1350000` → `1.4m`; k = 1,000, as `/compaction window` reads it. */
export function shortTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** `CP:2·CT:236k`; a native compaction paints `CP:2!` in warning. Nothing to show gives undefined, which withdraws the segment. */
export function compactionStatusLine(status: CompactionStatus, paint: (tone: Tone, text: string) => string): string | undefined {
  const parts: string[] = [];
  if (status.count > 0) parts.push(status.native ? paint("warning", `CP:${status.count}!`) : paint("dim", `CP:${status.count}`));
  if (status.threshold !== undefined) parts.push(paint("dim", `CT:${shortTokens(status.threshold)}`));
  return parts.length ? parts.join(paint("dim", "·")) : undefined;
}

/** Inline on the command's row 2, after its left column. */
export function compactionStatusPayload(line: string | undefined, onClick?: () => boolean): StatusLineRowPayload {
  return { key: COMPACTION_STATUS_KEY, line, placement: "inline", row: 2, align: "left", order: 10, onClick };
}
