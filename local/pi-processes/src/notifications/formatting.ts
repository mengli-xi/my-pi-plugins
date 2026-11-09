import {
  NOTIFICATION_BROKER_LIMITS_V1,
  type NotificationKindV1,
  type ProcessNotificationBatchItemV1,
  type ProcessNotificationBatchV1,
} from "./types.js";

const encoder = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export interface FormatProcessNotificationBatchOptionsV1 {
  readonly maxBytes?: number;
  readonly maxExcerptBytes?: number;
}

export interface FormattedProcessNotificationBatchV1 {
  readonly text: string;
  readonly bytes: number;
  readonly excerptBytes: number;
  readonly excerptsIncluded: number;
  readonly excerptsTruncated: number;
  readonly excerptsOmitted: number;
}

export class NotificationFormattingErrorV1 extends Error {
  readonly code = "mandatory-content-too-large";

  constructor(message: string) {
    super(message);
    this.name = "NotificationFormattingErrorV1";
  }
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: value.length > 0 };
  if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false };
  const ellipsis = "…";
  const ellipsisBytes = utf8Bytes(ellipsis);
  const contentBudget = maxBytes >= ellipsisBytes ? maxBytes - ellipsisBytes : maxBytes;
  let text = "";
  let bytes = 0;
  for (const codePoint of value) {
    const width = utf8Bytes(codePoint);
    if (bytes + width > contentBudget) break;
    text += codePoint;
    bytes += width;
  }
  if (maxBytes >= ellipsisBytes) text += ellipsis;
  return { text, truncated: true };
}

function cleanInline(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const cleaned = value.replace(CONTROL_CHARACTERS, "").replace(/[\r\n\t]+/gu, " ").trim();
  return cleaned || fallback;
}

function cleanExcerpt(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function quote(value: string | undefined, fallback: string): string {
  return `'${cleanInline(value, fallback).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}

function processSubject(item: ProcessNotificationBatchItemV1): string {
  return item.processName ? `Process ${quote(item.processName, "process")}` : item.processId ? `Process ${quote(item.processId, "process")}` : "Process runtime";
}

function countSuffix(count: number): string {
  return count > 1 ? ` ${count} times` : "";
}

function formatTerminal(item: ProcessNotificationBatchItemV1): string {
  const terminal = item.terminal;
  if (!terminal) return `${processSubject(item)} reached a terminal state.`;
  const duration = terminal.durationMs > 0 ? ` after ${formatDuration(terminal.durationMs)}` : "";
  switch (terminal.cause) {
    case "completed": return `${processSubject(item)} succeeded${duration}.`;
    case "exit-code": return `${processSubject(item)} failed${duration} due to exit code ${terminal.exitCode ?? "unknown"}.`;
    case "signal": return `${processSubject(item)} failed${duration} due to signal ${cleanInline(terminal.signal, "unknown")}.`;
    case "timeout": {
      const limit = terminal.timeoutMs === undefined ? "" : ` (limit ${formatDuration(terminal.timeoutMs)})`;
      return `${processSubject(item)} timed out${duration}${limit}.`;
    }
    case "stopped": return `${processSubject(item)} stopped${duration}.`;
    case "killed": return `${processSubject(item)} was killed${duration}${terminal.signal ? ` by ${cleanInline(terminal.signal, "unknown")}` : ""}.`;
    case "runtime-error": return `${processSubject(item)} crashed${duration}.`;
  }
}

function formatWatch(item: ProcessNotificationBatchItemV1): string {
  const total = item.count;
  const matched = item.matchedCount ?? total;
  const suppressed = item.suppressedCount ?? 0;
  const detail = suppressed > 0
    ? matched > 0
      ? ` (${matched} reported, ${suppressed} suppressed)`
      : ` (${suppressed} suppressed)`
    : "";
  return `${processSubject(item)} matched watch ${quote(item.watchKey, "watch")}${countSuffix(total)}${detail}.`;
}

function formatSummary(item: ProcessNotificationBatchItemV1): string {
  switch (item.kind) {
    case "terminal": return formatTerminal(item);
    case "watch-match":
    case "watch-suppressed": return formatWatch(item);
    case "matcher-error": return `${processSubject(item)} watch ${quote(item.watchKey, "watch")} matcher failed${countSuffix(item.count)}${item.stableCode ? ` (${cleanInline(item.stableCode, "matcher-error")})` : ""}.`;
    case "operational": return `${processSubject(item)} reported ${quote(item.stableCode, "operational-error")}${countSuffix(item.count)}.`;
  }
}

function formatRange(item: ProcessNotificationBatchItemV1): string {
  return `  [facts ${cleanInline(item.firstFactId, "unknown")}..${cleanInline(item.lastFactId, "unknown")}; source ${cleanInline(item.hostIncarnationId, "unknown")}; notifications ${item.firstNotificationSequence}..${item.lastNotificationSequence}; observed ${cleanInline(item.firstObservedAt, "unknown")}..${cleanInline(item.lastObservedAt, "unknown")}]`;
}

function formatOverflow(batch: ProcessNotificationBatchV1): string | undefined {
  if (!batch.overflow || batch.overflow.omittedItems <= 0) return undefined;
  const kinds = Object.entries(batch.overflow.byKind)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${cleanInline(kind, "update")}: ${count}`)
    .join(", ");
  return `${batch.overflow.omittedItems} additional updates${kinds ? ` (${kinds})` : ""} are available through process list/logs.`;
}

function minimumLines(batch: ProcessNotificationBatchV1): { itemBlocks: string[][]; footer: string[] } {
  const itemBlocks = batch.items.map((item) => [`- ${formatSummary(item)}`, formatRange(item)]);
  const footer: string[] = [];
  const overflow = formatOverflow(batch);
  if (overflow) footer.push(overflow);
  if (batch.mode === "minimal-continuation") {
    footer.push("The process wait condition is satisfied. Use process list or process logs to inspect the complete current state.");
  }
  return { itemBlocks, footer };
}

function compose(itemBlocks: readonly (readonly string[])[], footer: readonly string[]): string {
  const lines = ["Background process updates:"];
  for (const block of itemBlocks) lines.push(...block);
  lines.push(...footer);
  return lines.join("\n");
}

export function formatProcessNotificationBatchV1(
  batch: ProcessNotificationBatchV1,
  options: FormatProcessNotificationBatchOptionsV1 = {},
): FormattedProcessNotificationBatchV1 {
  const maxBytes = options.maxBytes ?? NOTIFICATION_BROKER_LIMITS_V1.batchBytes;
  const maxExcerptBytes = options.maxExcerptBytes ?? NOTIFICATION_BROKER_LIMITS_V1.excerptBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxExcerptBytes) || maxExcerptBytes < 0) {
    throw new NotificationFormattingErrorV1("notification formatting limits are invalid");
  }
  if (batch.version !== 1) throw new NotificationFormattingErrorV1("notification batch version is invalid");
  if (batch.mode === "minimal-continuation" && (batch.items.length < 1 || batch.items.length > 50)) {
    throw new NotificationFormattingErrorV1("minimal continuation requires between one and fifty items");
  }

  const { itemBlocks, footer } = minimumLines(batch);
  const mandatory = compose(itemBlocks, footer);
  const mandatoryBytes = utf8Bytes(mandatory);
  if (mandatoryBytes > maxBytes) {
    throw new NotificationFormattingErrorV1(`mandatory notification content requires ${mandatoryBytes} bytes, exceeding ${maxBytes}`);
  }

  let remaining = maxBytes - mandatoryBytes;
  let excerptBytes = 0;
  let excerptsIncluded = 0;
  let excerptsTruncated = 0;
  let excerptsOmitted = 0;
  let excerptClosed = false;

  for (let index = 0; index < batch.items.length; index++) {
    const excerpt = batch.items[index]?.latestExcerpt;
    if (!excerpt) continue;
    if (excerptClosed) { excerptsOmitted++; continue; }
    const cleaned = cleanExcerpt(excerpt.text);
    const itemLimit = truncateUtf8(cleaned, maxExcerptBytes);
    const prefix = `  [${excerpt.stream}] `;
    const framingBytes = 1 + utf8Bytes(prefix);
    if (remaining <= framingBytes) {
      excerptsOmitted++;
      excerptClosed = true;
      continue;
    }
    const availableTextBytes = remaining - framingBytes;
    const fitted = truncateUtf8(itemLimit.text, availableTextBytes);
    if (fitted.text.length === 0 && cleaned.length > 0) {
      excerptsOmitted++;
      excerptClosed = true;
      continue;
    }
    const line = `${prefix}${fitted.text}`;
    itemBlocks[index]!.push(line);
    const addedBytes = 1 + utf8Bytes(line);
    remaining -= addedBytes;
    excerptBytes += utf8Bytes(fitted.text);
    excerptsIncluded++;
    if (excerpt.truncated || itemLimit.truncated || fitted.truncated) excerptsTruncated++;
    if (fitted.truncated) excerptClosed = true;
  }

  const text = compose(itemBlocks, footer);
  const bytes = utf8Bytes(text);
  if (bytes > maxBytes) throw new NotificationFormattingErrorV1("formatted notification exceeded its byte budget");
  return Object.freeze({ text, bytes, excerptBytes, excerptsIncluded, excerptsTruncated, excerptsOmitted });
}

export function notificationKindLabelV1(kind: NotificationKindV1): string {
  switch (kind) {
    case "terminal": return "terminal";
    case "watch-match": return "watch match";
    case "watch-suppressed": return "suppressed watch match";
    case "matcher-error": return "matcher error";
    case "operational": return "operational update";
  }
}
