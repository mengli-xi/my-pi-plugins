import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ProcessSummary } from "../domain/types.js";
import type { SupervisorEvent } from "../host/supervisor-client.js";
import { createCustomEntryDelegate } from "./custom-entry-delegate.js";

export const PROCESS_EVENT_TYPE = "process-event-v2";
export const PROCESS_NOTIFICATION_RECEIPT_TYPE = "process-notification-receipt-v1";
export const PROCESS_NOTIFICATION_STATUS_TYPE = "process-notification-status-v1";

export type ProcessTerminalCause =
  | "completed"
  | "exit-code"
  | "signal"
  | "runtime-error"
  | "stopped"
  | "killed"
  | "timeout";

export interface ProcessTerminalPresentationV2 {
  readonly outcome: "succeeded" | "failed" | "stopped" | "killed" | "crashed";
  readonly cause: ProcessTerminalCause;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timeoutMs?: number;
}

export interface ProcessLifecycleMessageV2 {
  version: 2;
  kind: "terminal" | "watch-match" | "matcher-error";
  process: ProcessSummary;
  text: string;
  eventSequence: number;
  terminal?: ProcessTerminalPresentationV2;
  stdout?: string[];
  stderr?: string[];
  details?: Record<string, unknown>;
}

function terminalPresentation(
  event: SupervisorEvent,
  process: ProcessSummary,
): ProcessTerminalPresentationV2 {
  const outcome = process.terminal?.outcome ?? process.state as ProcessTerminalPresentationV2["outcome"];
  const exitCode = process.terminal?.exitCode;
  const signal = process.terminal?.signal;
  const classification = event.payload.classification;
  const timeoutMs = typeof event.payload.timeoutMs === "number" && Number.isFinite(event.payload.timeoutMs)
    ? Math.max(0, Math.trunc(event.payload.timeoutMs))
    : undefined;
  const cause: ProcessTerminalCause = classification === "timeout"
    ? "timeout"
    : outcome === "succeeded"
      ? "completed"
      : outcome === "stopped"
        ? "stopped"
        : outcome === "killed"
          ? "killed"
          : typeof exitCode === "number"
            ? "exit-code"
            : typeof signal === "string" && signal.length > 0
              ? "signal"
              : "runtime-error";
  return {
    outcome,
    cause,
    durationMs: process.runtimeMs,
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof signal === "string" && signal.length > 0 ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function terminalStatusText(terminal: ProcessTerminalPresentationV2): string {
  const duration = terminal.durationMs > 0 ? ` after ${formatDuration(terminal.durationMs)}` : "";
  switch (terminal.cause) {
    case "completed": return `succeeded${duration}`;
    case "exit-code": return `failed${duration} due to exit code ${terminal.exitCode ?? "unknown"}`;
    case "signal": return `failed${duration} due to signal ${terminal.signal ?? "unknown"}`;
    case "timeout": {
      const limit = terminal.timeoutMs !== undefined ? ` (limit ${formatDuration(terminal.timeoutMs)})` : "";
      return `timed out${duration}${limit}`;
    }
    case "stopped": return `stopped${duration}`;
    case "killed": return `was killed${duration}${terminal.signal ? ` by ${terminal.signal}` : ""}`;
    default: return `crashed${duration}`;
  }
}

export function lifecycleMessage(event: SupervisorEvent, process: ProcessSummary): ProcessLifecycleMessageV2 | undefined {
  if (event.type === "terminal") {
    const terminal = terminalPresentation(event, process);
    const text = `Process '${process.name}' ${terminalStatusText(terminal)}.`;
    return {
      version: 2,
      kind: "terminal",
      process,
      text,
      eventSequence: event.eventSequence,
      terminal,
      details: { ...event.payload },
    };
  }
  if (event.type === "watchMatch") {
    const key = typeof event.payload.key === "string" ? event.payload.key : "watch";
    return { version: 2, kind: "watch-match", process, text: `Process '${process.name}' matched watch '${key}'.`, eventSequence: event.eventSequence, details: { ...event.payload } };
  }
  if (event.type === "matcherError") {
    const key = typeof event.payload.key === "string" ? event.payload.key : "watch";
    return { version: 2, kind: "matcher-error", process, text: `Process '${process.name}' watch '${key}' failed.`, eventSequence: event.eventSequence, details: { ...event.payload } };
  }
  return undefined;
}

function lifecycleComponent(
  details: ProcessLifecycleMessageV2,
  expanded: boolean,
  theme: Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2],
) {
  const lines = [`  ${details.text}`];
  if (details.stdout?.length) lines.push(...details.stdout.map((line, index) => `  ${index === 0 ? "stdout: " : ""}${line}`));
  if (details.stderr?.length) lines.push(...details.stderr.map((line, index) => `  ${index === 0 ? "stderr: " : ""}${line}`));
  if (expanded && details.details) lines.push(`  ${JSON.stringify(details.details)}`);
  const fallback = new Text(theme.fg("muted", lines.join("\n")), 0, 0);
  return createCustomEntryDelegate(PROCESS_EVENT_TYPE, {
    version: 1,
    customType: PROCESS_EVENT_TYPE,
    data: details,
    options: { expanded },
    theme,
  }, fallback);
}

/** Owner status markers are durable state, not transcript content: render nothing. */
export function registerNotificationStatusRenderer(pi: ExtensionAPI): void {
  for (const type of [PROCESS_NOTIFICATION_STATUS_TYPE, "process-notification-intent-v1", "process-notification-claim-v1", "process-notification-parking-v1", "process-notification-migration-v1"]) pi.registerEntryRenderer(type, () => undefined);
}

export function registerNotificationReceiptRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(PROCESS_NOTIFICATION_RECEIPT_TYPE, () => undefined);
}

export function registerLifecycleRenderer(pi: ExtensionAPI): void {
  // Historical sessions may still contain model-message entries from before
  // Notification Broker cutover. Keep this read-only renderer; current runtime
  // production uses process-event-v2 only through appendEntry().
  pi.registerMessageRenderer<ProcessLifecycleMessageV2>(PROCESS_EVENT_TYPE, (message, { expanded }, theme) => {
    const details = message.details;
    if (!details || details.version !== 2) {
      const fallback = typeof message.content === "string" ? message.content : "Process event";
      return new Text(theme.fg("muted", fallback), 0, 0);
    }
    return lifecycleComponent(details, expanded, theme);
  });
  pi.registerEntryRenderer<ProcessLifecycleMessageV2>(PROCESS_EVENT_TYPE, (entry, { expanded }, theme) => {
    const details = entry.data;
    if (!details || details.version !== 2) return new Text(theme.fg("muted", "Process event"), 0, 0);
    return lifecycleComponent(details, expanded, theme);
  });
  registerNotificationReceiptRenderer(pi);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}
