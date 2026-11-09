import type { ToolActivity } from "./types.ts";

export interface CapturedEditDiff {
  diff: string;
  filePath?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

export function getCapturedEditDiff(
  activity: ToolActivity,
): CapturedEditDiff | undefined {
  if (activity.toolName.toLowerCase() !== "edit" || activity.result?.isError) {
    return undefined;
  }
  const details = record(activity.result?.details);
  if (typeof details?.diff !== "string" || !details.diff) return undefined;
  const args = record(activity.args);
  const rawPath = args?.path ?? args?.file_path;
  return {
    diff: details.diff,
    filePath: typeof rawPath === "string" ? rawPath : undefined,
  };
}
