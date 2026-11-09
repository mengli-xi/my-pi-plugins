import type { RunMetricsSnapshot, WorkingConfig } from "./types.ts";

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds) / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const seconds = Math.floor(totalSeconds % 60);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) return `${hours}h${pad(minutes)}m${pad(seconds)}s`;
  return `${totalMinutes}m${pad(seconds)}s`;
}

/**
 * Keep one decimal while the compact value is below 100k, where a tenth is
 * still useful at spinner width. Compact values are truncated downward so a
 * display counter never claims tokens that have not actually been observed.
 */
export function formatCompletionTime(at: number, now = Date.now()): string {
  const when = new Date(at);
  const today = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  if (
    when.getFullYear() === today.getFullYear()
    && when.getMonth() === today.getMonth()
    && when.getDate() === today.getDate()
  ) return time;
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}

export function formatTokenCount(value: number): string {
  const absolute = Math.max(0, value);
  if (absolute < 1_000) return `${Math.floor(absolute)}`;
  if (absolute < 100_000) {
    return `${(Math.floor(absolute / 100) / 10).toFixed(1)}k`;
  }
  if (absolute < 1_000_000) return `${Math.floor(absolute / 1_000)}k`;
  return `${(Math.floor(absolute / 100_000) / 10).toFixed(1)}M`;
}

export function formatTps(value: number): string {
  return value >= 99.95 ? `${Math.round(value)}t/s` : `${value.toFixed(1)}t/s`;
}

export function formatRunSegments(
  snapshot: RunMetricsSnapshot,
  config: WorkingConfig,
): string[] {
  const segments = [formatDuration(snapshot.elapsedMs)];
  const tokens: string[] = [];
  if (config.showInputTokens && snapshot.inputTokens !== undefined) {
    tokens.push(`↑${formatTokenCount(snapshot.inputTokens)}`);
  }
  if (config.showOutputTokens && snapshot.outputTokens !== undefined) {
    tokens.push(
      `↓${snapshot.outputEstimated ? "~" : ""}${formatTokenCount(snapshot.outputTokens)}`,
    );
  }
  if (tokens.length) segments.push(tokens.join(" "));
  if (config.showTps && snapshot.tps !== undefined) {
    segments.push(
      `${snapshot.tpsEstimated ? "~" : ""}${formatTps(snapshot.tps)}`,
    );
  }
  if (config.showTtft && snapshot.ttftMs !== undefined) {
    segments.push(`first ${formatDuration(snapshot.ttftMs)}`);
  }
  if (config.showThinkingTime && snapshot.thinkingMs !== undefined) {
    segments.push(`thought ${formatDuration(snapshot.thinkingMs)}`);
  }
  if (config.showTurns && snapshot.turnCount > 0) {
    segments.push(`${snapshot.turnCount} turn${snapshot.turnCount === 1 ? "" : "s"}`);
  }
  return segments;
}

export function truncateText(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n… truncated by pi-claude-transcript`,
    truncated: true,
  };
}

export function stringifyUnknown(value: unknown, maxChars: number): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return truncateText(text, maxChars).text;
}
