import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TextPanelContent } from "pi-li-uikit/text-panel";
import { formatTokenCount } from "../format.ts";
import {
  CACHE_MISS_NOISE_FLOOR,
  type CacheHistorySnapshot,
  type CacheRequestSample,
} from "./cache-history.ts";
import type { ClaudeLikeStatusLineInput } from "./types.ts";

const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const CACHE_PANEL_MAX_VISIBLE = 24;
const CACHE_TTL_MS = 5 * 60_000;

function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function token(value: number | undefined): string {
  return value === undefined ? "—" : formatTokenCount(value);
}

function compactToken(value: number): string {
  const absolute = Math.max(0, value);
  if (absolute < 1_000) return `${Math.floor(absolute)}`;
  if (absolute < 1_000_000) {
    const amount = absolute / 1_000;
    return `${amount >= 100 ? Math.floor(amount) : amount.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(absolute / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function modelLabel(sample: CacheRequestSample): string {
  const model = sample.model ?? "unknown";
  const provider = sample.provider?.replace(/^openai-codex$/, "codex")
    .replace(/-gateway$/, "");
  return provider ? `${model}(${provider})` : model;
}

function note(sample: CacheRequestSample): string {
  const notes: string[] = [];
  if (sample.baselineReset === "compaction") notes.push("after compact");
  else if (sample.baselineReset === "branch-summary") notes.push("after branch summary");
  if (sample.modelChanged) notes.push("model changed");
  if ((sample.idleMs ?? 0) > CACHE_TTL_MS) {
    notes.push(`idle ${formatIdle(sample.idleMs!)}`);
  }
  return notes.join(", ");
}

function formatIdle(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function pad(value: string, width: number, align: "left" | "right" = "right"): string {
  const clipped = truncateToWidth(value, width, "…");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return align === "left" ? `${clipped}${padding}` : `${padding}${clipped}`;
}

function spark(value: number): string {
  const bounded = Math.max(0, Math.min(100, value));
  return SPARKS[Math.min(SPARKS.length - 1, Math.floor(bounded / 12.5))]!;
}

function chTone(value: number): "accent" | "warning" | "error" {
  if (value < 20) return "error";
  if (value < 50) return "warning";
  return "accent";
}

function reuseTone(value: number): "success" | "accent" | "warning" | "error" {
  if (value < 90) return "error";
  if (value < 95) return "warning";
  if (value < 99) return "accent";
  return "success";
}

function paintedReuse(value: number | undefined, theme: Theme, width?: number): string {
  const text = width === undefined ? percent(value) : pad(percent(value), width);
  return value === undefined
    ? theme.fg("muted", text)
    : theme.fg(reuseTone(value), text);
}

function trend(
  samples: readonly CacheRequestSample[],
  width: number,
  value: (sample: CacheRequestSample) => number | undefined,
  tone: (value: number) => "success" | "accent" | "warning" | "error",
  theme: Theme,
): string {
  const visible = samples.slice(-Math.max(1, width));
  return visible.map((sample) => {
    const current = value(sample);
    if (current === undefined) {
      return sample.baselineReset
        ? theme.fg("muted", "│")
        : theme.fg("dim", "·");
    }
    return theme.fg(tone(current), spark(current));
  }).join("");
}

function summaryLines(snapshot: CacheHistorySnapshot, theme: Theme): string[] {
  const latest = snapshot.latest;
  if (!latest) {
    return [theme.fg("muted", "No successful assistant request with prompt usage on the active branch.")];
  }
  const weighted = [
    `Weighted CH ${percent(snapshot.summary.weightedHitPercent)}`,
    `RU ${percent(snapshot.summary.weightedReusePercent)}`,
    `significant misses ${snapshot.summary.significantMissCount} / ${token(snapshot.summary.significantMissTokens)}`,
  ].join(" · ");
  return [
    theme.fg("muted", "Latest"),
    [
      theme.fg(chTone(latest.hitPercent), `CH ${percent(latest.hitPercent)}`),
      latest.reusePercent === undefined
        ? theme.fg("muted", "RU —")
        : theme.fg(reuseTone(latest.reusePercent), `RU ${percent(latest.reusePercent)}`),
      theme.fg(latest.significantMiss ? "warning" : "muted", `Miss ${token(latest.missTokens)}`),
    ].join(theme.fg("dim", " · ")),
    `Prompt ${token(latest.promptTokens)} = Input ${token(latest.inputTokens)} + Read ${token(latest.cacheReadTokens)} + Write ${token(latest.cacheWriteTokens)}`,
    theme.fg("muted", weighted),
  ];
}

function wideRows(samples: readonly CacheRequestSample[], width: number, theme: Theme): string[] {
  const rows = samples.slice(-20).reverse();
  const includeWrite = width >= 96;
  const modelWidth = Math.max(12, Math.min(24, width - (includeWrite ? 61 : 51)));
  const header = includeWrite
    ? `${pad("Req", 4, "left")} ${pad("Model", modelWidth, "left")} ${pad("Prompt", 7)} ${pad("Read", 7)} ${pad("Write", 7)} ${pad("CH", 7)} ${pad("RU", 7)} ${pad("Miss", 7)}  Note`
    : `${pad("Req", 4, "left")} ${pad("Model", modelWidth, "left")} ${pad("Prompt", 7)} ${pad("Read", 7)} ${pad("CH", 7)} ${pad("RU", 7)} ${pad("Miss", 7)}  Note`;
  return [theme.fg("muted", header), ...rows.map((sample) => {
    const prefix = `${pad(`#${sample.ordinal}`, 4, "left")} ${pad(modelLabel(sample), modelWidth, "left")} ${pad(token(sample.promptTokens), 7)} ${pad(token(sample.cacheReadTokens), 7)}`;
    const write = includeWrite ? ` ${pad(token(sample.cacheWriteTokens), 7)}` : "";
    const metrics = ` ${pad(percent(sample.hitPercent), 7)} ${paintedReuse(sample.reusePercent, theme, 7)} ${pad(token(sample.missTokens), 7)}`;
    return truncateToWidth(`${prefix}${write}${metrics}  ${note(sample)}`, width, "…");
  })];
}

function narrowRows(samples: readonly CacheRequestSample[], width: number, theme: Theme): string[] {
  return samples.slice(-12).reverse().flatMap((sample) => {
    const first = `#${sample.ordinal} ${modelLabel(sample)} · CH ${percent(sample.hitPercent)} · RU ${paintedReuse(sample.reusePercent, theme)} · M ${token(sample.missTokens)}`;
    const detail = `  P ${token(sample.promptTokens)} · I ${token(sample.inputTokens)} · R ${token(sample.cacheReadTokens)} · W ${token(sample.cacheWriteTokens)}${note(sample) ? ` · ${note(sample)}` : ""}`;
    return [
      truncateToWidth(first, width, "…"),
      theme.fg("muted", truncateToWidth(detail, width, "…")),
    ];
  });
}

export function renderCacheHistory(
  snapshot: CacheHistorySnapshot,
  width: number,
  theme: Theme,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const latest = snapshot.samples.slice(-Math.max(1, safeWidth - 4));
  const lines = [
    theme.fg(
      "muted",
      truncateToWidth(
        `Active branch · ${snapshot.summary.requestCount} request${snapshot.summary.requestCount === 1 ? "" : "s"}`,
        safeWidth,
        "…",
      ),
    ),
    "",
    ...summaryLines(snapshot, theme).map((line) => truncateToWidth(line, safeWidth, "…")),
  ];
  if (snapshot.samples.length === 0) return lines;
  lines.push(
    "",
    theme.fg(
      "muted",
      truncateToWidth("Trends · oldest → latest · fixed 0–100% scale", safeWidth, "…"),
    ),
    `${theme.fg("muted", "CH ")} ${trend(latest, safeWidth - 4, (sample) => sample.hitPercent, chTone, theme)}`,
    `${theme.fg("muted", "RU ")} ${trend(latest, safeWidth - 4, (sample) => sample.reusePercent, reuseTone, theme)}`,
    "",
    theme.fg("muted", truncateToWidth("Request details · latest first", safeWidth, "…")),
  );
  lines.push(...(safeWidth >= 76
    ? wideRows(snapshot.samples, safeWidth, theme)
    : narrowRows(snapshot.samples, safeWidth, theme)));
  return lines;
}

export function formatCacheHistoryPlain(snapshot: CacheHistorySnapshot): string {
  const plainTheme = { fg: (_tone: string, text: string) => text } as Theme;
  return renderCacheHistory(snapshot, 120, plainTheme).join("\n");
}

export function cacheHistoryPanelContent(snapshot: CacheHistorySnapshot): TextPanelContent {
  return {
    title: "Prompt cache",
    body: formatCacheHistoryPlain(snapshot),
    format: "plain",
    glyph: "◈",
    maxVisible: CACHE_PANEL_MAX_VISIBLE,
    renderBody: (width, theme) => renderCacheHistory(snapshot, width, theme),
  };
}

export function emptyCacheHistory(): CacheHistorySnapshot {
  return {
    samples: [],
    latest: null,
    summary: {
      requestCount: 0,
      retainedCount: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      significantMissCount: 0,
      significantMissTokens: 0,
    },
  };
}

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function ansi(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

export function formatCacheQualitySegment(
  cache: ClaudeLikeStatusLineInput["context_window"]["cache"],
): string | undefined {
  const hit = cache?.hit_percent;
  if (hit === null || hit === undefined || !Number.isFinite(hit)) return undefined;
  const hitColor = hit < 20 ? RED : hit < 50 ? MAGENTA : CYAN;
  const segments = [ansi(hitColor, `CH:${hit.toFixed(1)}%`)];
  const reuse = cache?.reuse_percent;
  if (reuse !== null && reuse !== undefined && Number.isFinite(reuse)) {
    const reuseColor = reuse < 90 ? RED : reuse < 95 ? YELLOW : reuse < 99 ? CYAN : GREEN;
    segments.push(ansi(reuseColor, `RU:${reuse.toFixed(1)}%`));
  }
  const miss = cache?.miss_tokens;
  if (miss !== null && miss !== undefined && Number.isFinite(miss)) {
    const missColor = miss > 10_000 ? RED : miss > CACHE_MISS_NOISE_FLOOR ? YELLOW : GRAY;
    segments.push(ansi(missColor, `M:${compactToken(miss)}`));
  }
  return segments.join(ansi(GRAY, "·"));
}
