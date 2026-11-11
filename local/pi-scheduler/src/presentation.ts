import type { RunRecord, Task, TaskTarget } from "./task.ts";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/gu;
const UNSAFE_TERMINAL_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function resolvedLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Render an absolute instant in the viewer's local time zone. */
export function formatLocalTime(
  epochMs: number,
  timeZone = resolvedLocalTimeZone(),
  locale = "en-CA",
): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`;
}

function formatInterval(everyMs: number): string {
  const minutes = everyMs / 60_000;
  if (Number.isInteger(minutes / 60)) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

export function describeSchedule(task: Task): string {
  const { schedule } = task;
  switch (schedule.kind) {
    case "once":
      return `一次 · ${formatLocalTime(schedule.at)}`;
    case "daily":
      return `每天 ${schedule.at}（${task.timeZone}）`;
    case "weekly":
      return `每${WEEKDAYS[schedule.dayOfWeek]} ${schedule.at}（${task.timeZone}）`;
    case "interval":
      return `${formatInterval(schedule.everyMs)}（从 ${formatLocalTime(schedule.anchor)} 起）`;
  }
}

function describeTarget(target: TaskTarget): string {
  return target.kind === "agent"
    ? `独立 Agent · ${target.provider}/${target.model} · ${target.cwd}`
    : `会话 · ${target.sessionId.slice(0, 8)} · ${target.cwd}`;
}

export function describeTask(task: Task): string {
  const status = task.status === "active" ? "运行中" : task.status === "paused" ? "已暂停" : "已完成";
  return [
    `${task.title}  [${status}]`,
    `  ID: ${task.id}`,
    `  计划: ${describeSchedule(task)}`,
    `  目标: ${describeTarget(task.target)}`,
  ].join("\n");
}

export function describeFailure(record: RunRecord): string {
  const outcome = record.outcome === "skipped" ? "已跳过" : record.outcome === "delivered" ? "已投递" : "失败";
  return `${formatLocalTime(record.finishedAt)}  ${record.taskId.slice(0, 8)}  ${outcome}${record.detail ? ` · ${record.detail}` : ""}`;
}

export interface InjectionPromptDisplay {
  summary: string;
  preview?: string[];
}

function sanitizeDisplayText(value: string): string {
  return value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_TERMINAL_TEXT, "�");
}

export function describeInjectionPrompt(
  content: string,
  details?: { title?: unknown },
): InjectionPromptDisplay {
  const title = typeof details?.title === "string"
    ? sanitizeDisplayText(details.title).replace(/\s+/gu, " ").trim()
    : undefined;
  const usableTitle = title && title.length > 0 ? title : undefined;
  const promptLines = sanitizeDisplayText(content)
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const subject = usableTitle ?? promptLines[0] ?? "Scheduled task";
  const preview = usableTitle ? promptLines : promptLines.slice(1);
  return {
    summary: `task · ${subject}`,
    preview: preview.length > 0 ? preview : undefined,
  };
}
