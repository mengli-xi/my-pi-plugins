import { formatCompletionTime, formatRunSegments } from "./format.ts";
import type { RunMetricsSnapshot, WorkingConfig } from "./types.ts";

export function formatRunDividerText(
  snapshot: RunMetricsSnapshot,
  working: WorkingConfig,
  now = Date.now(),
): string {
  const status =
    snapshot.status === "done"
      ? "done"
      : snapshot.status === "failed"
        ? "failed"
        : "cancelled";
  const glyph =
    snapshot.status === "done" ? "✓" : snapshot.status === "failed" ? "✗" : "○";
  const [elapsed = "0.0s", ...statistics] = formatRunSegments(
    snapshot,
    working,
  );
  const completedAt = working.showFinishedAt && snapshot.endedAt !== undefined
    ? ` at ${formatCompletionTime(snapshot.endedAt, now)}`
    : "";
  return [
    `${glyph} ${status}${completedAt}`,
    `took ${elapsed}`,
    ...statistics,
  ].join(" · ");
}

export function formatTurnDividerText(
  nextTurn: number,
  showTurnNumber: boolean,
): string {
  return showTurnNumber ? `Turn ${Math.max(1, nextTurn)}` : "";
}
