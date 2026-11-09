import type { ToolActivity } from "./types.ts";

export type WebPresentationKind = "web-search" | "web-fetch";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function quoted(value: unknown): string {
  return JSON.stringify(typeof value === "string" ? value : "");
}

export function formatWebHeader(
  kind: WebPresentationKind,
  args: unknown,
): string {
  const source = record(args);
  return kind === "web-search"
    ? `Web Search(${quoted(source?.query)})`
    : `Web Fetch(${quoted(source?.url)})`;
}

export function formatWebDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0s";
  return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
}

function conciseError(text: string | undefined): string {
  const first = text
    ?.split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() ?? "";
  return first.length > 180 ? `${first.slice(0, 179)}…` : first;
}

export function formatWebStatus(
  kind: WebPresentationKind,
  activity: ToolActivity,
): string {
  if (activity.status === "running") {
    return kind === "web-search" ? "Searching…" : "Fetching…";
  }
  const duration = formatWebDuration(
    Math.max(0, (activity.endedAt ?? activity.startedAt) - activity.startedAt),
  );
  if (activity.status === "completed") {
    return kind === "web-search"
      ? `Did 1 search in ${duration}`
      : `Fetched in ${duration}`;
  }
  const action = kind === "web-search" ? "Search" : "Fetch";
  const suffix = conciseError(activity.result?.text);
  return `${action} ${activity.status === "failed" ? "failed" : "cancelled"} in ${duration}${
    suffix ? ` · ${suffix}` : ""
  }`;
}
