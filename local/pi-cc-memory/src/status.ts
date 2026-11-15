/** Owned by pi-claude-style (src/integration-contracts.ts); copied per 根 AGENTS.md 的能力协议表, no package import. */
export const STATUS_LINE_ROW_CHANNEL = "statusline:row";
export const MEMORY_STATUS_KEY = "memory";
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
/**
 * `topics` counts topic files on disk (MEMORY.md excluded); undefined when the directory could not
 * be listed. `warn`: the injected index was truncated or unreadable, a topic exceeds 12 KiB, or nothing was injected.
 */
export interface MemoryStatus { topics?: number; warn: boolean }

/** `MEM:5`, or `MEM:5!` in warning; an unknown count reads `MEM:?!`. */
export function memoryStatusLine(status: MemoryStatus, paint: (tone: Tone, text: string) => string): string {
  return paint(status.warn ? "warning" : "dim", `MEM:${status.topics ?? "?"}${status.warn ? "!" : ""}`);
}

/** Inline on the command's row 2, after its left column. */
export function memoryStatusPayload(line: string | undefined, onClick?: () => boolean): StatusLineRowPayload {
  return { key: MEMORY_STATUS_KEY, line, placement: "inline", row: 2, align: "left", order: 20, onClick };
}
