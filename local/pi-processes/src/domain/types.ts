export type Attention = "turn" | "context" | "ignore";
export type ProcessAction = "start" | "list" | "logs" | "input" | "configure" | "stop" | "clear";
export type ProcessKind = "process" | "monitor" | "service";
export type ProcessState = "starting" | "running" | "stopping" | "succeeded" | "failed" | "stopped" | "killed" | "crashed";
export type StreamSelection = "stdout" | "stderr" | "both";
export type MatchMode = "literal" | "regex";

export interface NotifyPolicy {
  readonly onSuccess: Attention;
  readonly onFailure: Attention;
  readonly onKilled: Attention;
  readonly onCrash: Attention;
}

export interface WatchDefinition {
  readonly key: string;
  readonly pattern: string;
  readonly mode: MatchMode;
  readonly stream: StreamSelection;
  readonly repeat: boolean;
  readonly attention: Attention;
}

export type ContinuationPolicy =
  | { readonly mode: "detached" }
  | { readonly mode: "wait"; readonly until: { readonly kind: "exit" } }
  | { readonly mode: "wait"; readonly until: { readonly kind: "watch"; readonly key: string } };

export interface ProcessRecord {
  readonly id: string;
  name: string;
  kind: ProcessKind;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly timeoutMs?: number;
  readonly deadlineAt?: string;
  readonly terminalWakeRequired?: boolean;
  state: ProcessState;
  pid?: number;
  pgid?: number;
  stdinOpen: boolean;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  terminalErrorCode?: string;
  terminalMessagePreview?: string;
  logRevision: number;
  earliestSequence: number;
  nextSequence: number;
  droppedBytes: number;
  droppedLines: number;
  watchRevision: number;
  watches: Map<string, WatchDefinition>;
  failedWatchKeys: Set<string>;
  continuation: ContinuationPolicy;
  continuationState?: "blocking" | "satisfied" | "released" | "failed";
  notify: NotifyPolicy;
  readonly configDefaults: NotifyPolicy;
  readonly startOrder: number;
  readonly notificationStrategy: "main" | "child";
  readonly notificationOwnerToken: string;
}

export interface ProcessSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: ProcessKind;
  readonly state: ProcessState;
  readonly commandPreview: string;
  readonly commandTruncated: boolean;
  readonly cwd: string;
  readonly startedAt: string;
  readonly timeoutMs?: number;
  readonly deadlineAt?: string;
  readonly endedAt?: string;
  readonly runtimeMs: number;
  readonly pid?: number;
  readonly pgid?: number;
  readonly stdinOpen: boolean;
  readonly continuation: {
    readonly mode: "detached" | "wait";
    readonly until?: { readonly kind: "exit" } | { readonly kind: "watch"; readonly key: string };
    readonly state?: "blocking" | "satisfied" | "released" | "failed";
  };
  readonly watches: { readonly count: number; readonly keys: string[]; readonly failedKeys: string[] };
  readonly logs: {
    readonly revision: number;
    readonly earliestSequence: number;
    readonly nextSequence: number;
    readonly droppedBytes: number;
    readonly droppedLines: number;
  };
  readonly terminal?: {
    readonly outcome: "succeeded" | "failed" | "stopped" | "killed" | "crashed";
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly errorCode?: string;
    readonly cause?: "timeout";
    readonly timeoutMs?: number;
    readonly messagePreview?: string;
  };
}

export interface ProcessResultV2<A extends ProcessAction = ProcessAction, D = unknown> {
  readonly version: 2;
  readonly action: A;
  readonly outcome: "success";
  readonly hostRevision: number;
  readonly data: D;
  readonly warnings?: readonly { readonly code: string; readonly message: string }[];
}

export function previewCommand(command: string, maxCodePoints = 160): { text: string; truncated: boolean } {
  const points = [...command];
  if (points.length <= maxCodePoints) return { text: command, truncated: false };
  return { text: `${points.slice(0, maxCodePoints - 1).join("")}…`, truncated: true };
}

export function summarizeProcess(record: ProcessRecord, now = Date.now()): ProcessSummary {
  const preview = previewCommand(record.command);
  const started = Date.parse(record.startedAt);
  const ended = record.endedAt ? Date.parse(record.endedAt) : now;
  const terminal = ["succeeded", "failed", "stopped", "killed", "crashed"].includes(record.state)
    ? {
        outcome: record.state as "succeeded" | "failed" | "stopped" | "killed" | "crashed",
        exitCode: record.exitCode ?? null,
        signal: record.signal ?? null,
        ...(record.terminalErrorCode ? { errorCode: record.terminalErrorCode } : {}),
        ...(record.terminalErrorCode === "timeout" ? { cause: "timeout" as const, timeoutMs: record.timeoutMs } : {}),
        ...(record.terminalMessagePreview ? { messagePreview: record.terminalMessagePreview } : {}),
      }
    : undefined;
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    state: record.state,
    commandPreview: preview.text,
    commandTruncated: preview.truncated,
    cwd: record.cwd,
    startedAt: record.startedAt,
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.deadlineAt !== undefined ? { deadlineAt: record.deadlineAt } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    runtimeMs: Math.max(0, Number.isFinite(started) && Number.isFinite(ended) ? Math.trunc(ended - started) : 0),
    ...(record.pid ? { pid: record.pid } : {}),
    ...(record.pgid ? { pgid: record.pgid } : {}),
    stdinOpen: record.stdinOpen,
    continuation: {
      mode: record.continuation.mode,
      ...(record.continuation.mode === "wait" ? { until: record.continuation.until } : {}),
      ...(record.continuationState ? { state: record.continuationState } : {}),
    },
    watches: {
      count: record.watches.size,
      keys: [...record.watches.keys()].sort(),
      failedKeys: [...record.failedWatchKeys].sort(),
    },
    logs: {
      revision: record.logRevision,
      earliestSequence: record.earliestSequence,
      nextSequence: record.nextSequence,
      droppedBytes: record.droppedBytes,
      droppedLines: record.droppedLines,
    },
    ...(terminal ? { terminal } : {}),
  };
}
