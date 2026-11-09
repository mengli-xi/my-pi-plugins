import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ManagedProcessesPolicy, ProcessesConfig } from "../config.js";
import type { ProcessHost } from "../host/process-host.js";
import { parseToolInput, type ToolInput } from "./input.js";
import { ProcessToolExecutor, type V2SuccessEnvelope } from "./executor.js";

const WatchSchema = Type.Object({
  key: Type.Optional(Type.String({ description: "Stable watch key: 1-32 characters matching [A-Za-z0-9][A-Za-z0-9._:-]*" })),
  pattern: Type.Optional(Type.String({ description: "Required literal or regex pattern, at most 500 Unicode code points" })),
  mode: Type.Optional(Type.String({ description: "literal or regex; defaults to literal" })),
  stream: Type.Optional(Type.String({ description: "stdout, stderr, or both; defaults to both" })),
  repeat: Type.Optional(Type.Boolean({ description: "Whether this watch may match repeatedly; defaults to false" })),
  attention: Type.Optional(Type.String({ description: "turn, context, or ignore; defaults to turn" })),
}, { additionalProperties: true, description: "Start-only watch definition. key and pattern are required at runtime." });

// Configure accepts null to clear an override. Keep these values broad rather
// than using Type.Union so the provider-facing schema remains Google-compatible;
// parseToolInput() performs the exact action-specific validation.
const NotifySchema = Type.Object({
  onSuccess: Type.Optional(Type.Any({ description: "turn, context, or ignore; configure also accepts null to restore the default" })),
  onFailure: Type.Optional(Type.Any({ description: "turn, context, or ignore; configure also accepts null to restore the default" })),
  onKilled: Type.Optional(Type.Any({ description: "turn, context, or ignore; configure also accepts null to restore the default" })),
  onCrash: Type.Optional(Type.Any({ description: "turn, context, or ignore; configure also accepts null to restore the default" })),
}, { additionalProperties: true, description: "Notification policy object. Do not pass a boolean or string in place of this object." });

const ContinuationSchema = Type.Object({
  mode: Type.Optional(Type.String({ description: "detached or wait" })),
  until: Type.Optional(Type.Object({
    kind: Type.Optional(Type.String({ description: "exit or watch" })),
    key: Type.Optional(Type.String({ description: "Required only when kind=watch; must reference a configured watch key" })),
  }, { additionalProperties: true, description: "Required when mode=wait; omit for detached mode" })),
}, { additionalProperties: true, description: "Continuation policy: {mode:'detached'} or {mode:'wait',until:{kind:'exit'|'watch',key?}}" });

const WatchUpdateSchema = Type.Object({
  operation: Type.Optional(Type.String({ description: "upsert, replace, remove, or clear" })),
  items: Type.Optional(Type.Array(WatchSchema, { description: "Required by upsert; used by replace; omit for remove/clear" })),
  keys: Type.Optional(Type.Array(Type.String(), { description: "Required by remove; omit for upsert/replace/clear" })),
}, { additionalProperties: true, description: "Configure-only atomic watch mutation" });

export function createProcessToolSchema(managed?: ManagedProcessesPolicy) {
  return Type.Object({
    action: Type.String({ description: "Required action: start, list, logs, input, configure, stop, or clear. Only pass fields documented for that action." }),
    name: Type.Optional(Type.String({ description: "start/configure only: unique live-process name, 1-16 terminal columns" })),
    kind: Type.Optional(Type.String({ description: "start/configure only: process, monitor, or service; start defaults to process" })),
    command: Type.Optional(Type.String({ description: "start only: foreground shell source, including multiline source; do not use &, nohup, setsid, or disown" })),
    cwd: Type.Optional(Type.String({ description: "start only: existing working directory; defaults to the current tool cwd" })),
    timeout: Type.Optional(Type.Integer({
      minimum: 1,
      ...(managed ? { maximum: managed.maxTimeoutSeconds } : {}),
      description: managed?.requireTimeout
        ? `start only: required timeout in positive integer seconds, at most ${managed.maxTimeoutSeconds}; cannot be changed after start`
        : "start only: optional timeout in positive integer seconds; omit for no deadline; cannot be changed after start",
    })),
    watches: Type.Optional(Type.Array(WatchSchema, { description: "start only: at most 20 watch definitions" })),
    notify: Type.Optional(NotifySchema),
    continuation: Type.Optional(ContinuationSchema),
    target: Type.Optional(Type.String({ description: "logs/input/configure/stop only: process name or canonical proc_* ID" })),
    states: Type.Optional(Type.Array(Type.String(), { description: "list only: non-empty subset of starting, running, stopping, succeeded, failed, stopped, killed, crashed" })),
    sort: Type.Optional(Type.String({ description: "list only: started-desc, started-asc, name-asc, or state; defaults to started-desc" })),
    limit: Type.Optional(Type.Number({ description: "list only: integer 1-200; defaults to 50" })),
    cursor: Type.Optional(Type.String({ description: "list only: opaque nextCursor from a prior result" })),
    stream: Type.Optional(Type.String({ description: "logs only: stdout, stderr, or both; defaults to both" })),
    tailLines: Type.Optional(Type.Number({ description: "logs only: integer 1-2000; defaults to 100" })),
    pattern: Type.Optional(Type.String({ description: "logs only: optional literal or regex filter over the bounded tail window" })),
    mode: Type.Optional(Type.String({ description: "logs only: literal or regex; may be passed only with pattern" })),
    data: Type.Optional(Type.String({ description: "input only: non-empty UTF-8 text, at most 65536 bytes" })),
    eof: Type.Optional(Type.Boolean({ description: "input only: close stdin; input requires data or eof=true" })),
    watchUpdate: Type.Optional(WatchUpdateSchema),
  }, {
    additionalProperties: true,
    description: "Version 2 process tool. Runtime performs strict action-specific validation and rejects unrelated fields.",
    ...(managed?.requireTimeout ? {
      if: { properties: { action: { const: "start" } }, required: ["action"] },
      then: { required: ["timeout"] },
    } : {}),
  });
}

export const PROCESS_TOOL_SCHEMA = createProcessToolSchema();

const MAX_MODEL_CONTENT_BYTES = 131_072;
const TRUNCATION_NOTICE = "\n… process log content truncated to 128 KiB";

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end--) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* incomplete trailing code point */ }
  }
  throw new Error("unable to truncate process log content at a UTF-8 boundary");
}

export function processToolModelContent(envelope: V2SuccessEnvelope): string {
  const headline = summary(envelope);
  if (envelope.action === "start" && "process" in envelope.data) {
    const { continuation } = envelope.data.process;
    if (continuation?.mode === "wait" && continuation.state === "blocking") {
      const until = continuation.until?.kind === "watch" ? `watch '${continuation.until.key}' matches` : "the process exits";
      return `${headline}. Waiting is armed. End this turn now; you will be woken when ${until}.`;
    }
  }
  if (envelope.action !== "logs") return headline;
  const data = envelope.data as Record<string, unknown>;
  const lines = Array.isArray(data.lines) ? data.lines : [];
  if (lines.length === 0) return headline;
  const body = lines.map((value) => {
    const line = value as { stream?: unknown; text?: unknown };
    const stream = line.stream === "stdout" || line.stream === "stderr" ? line.stream : "unknown";
    return `[${stream}] ${typeof line.text === "string" ? line.text : ""}`;
  }).join("\n");
  const full = `${headline}\n${body}`;
  if (Buffer.byteLength(full, "utf8") <= MAX_MODEL_CONTENT_BYTES) return full;
  const budget = MAX_MODEL_CONTENT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  return `${boundedUtf8(full, budget)}${TRUNCATION_NOTICE}`;
}

function summary(envelope: V2SuccessEnvelope): string {
  const data = envelope.data as Record<string, unknown>;
  if (envelope.action === "start" && data.process && typeof data.process === "object") {
    const process = data.process as { name?: unknown; id?: unknown };
    return `Process '${String(process.name ?? process.id ?? "unknown")}' started`;
  }
  if (envelope.action === "list") return `Listed ${Array.isArray(data.items) ? data.items.length : 0} processes`;
  if (envelope.action === "logs") {
    const count = Array.isArray(data.lines) ? data.lines.length : 0;
    return `Read ${count} process log ${count === 1 ? "line" : "lines"}`;
  }
  if (envelope.action === "input") return `Wrote ${String(data.bytesAccepted ?? 0)} bytes to process`;
  if (envelope.action === "configure") return `Updated process${Array.isArray(data.changed) && data.changed.length ? `: ${data.changed.join(", ")}` : ""}`;
  if (envelope.action === "stop") return "Process stop requested";
  if (envelope.action === "clear") return `Cleared ${String(data.clearedCount ?? 0)} process records`;
  return `Process ${envelope.action} completed`;
}

export interface ProcessToolRuntime {
  host: ProcessHost;
  config: ProcessesConfig;
  configError?: Error;
  cwd: string;
}

export function registerProcessTool(
  pi: ExtensionAPI,
  getRuntime: () => ProcessToolRuntime | undefined,
  recoverRuntime?: () => Promise<ProcessToolRuntime | undefined>,
): () => void {
  const definition: ToolDefinition<typeof PROCESS_TOOL_SCHEMA, V2SuccessEnvelope> = {
    name: "process",
    label: "Process",
    description: "Start and manage background processes. Use action=start/list/logs/input/configure/stop/clear.",
    promptSnippet: "Manage background processes with stable names, logs, watches, input, and cleanup",
    promptGuidelines: [
      "Use process start for background commands instead of shell &, nohup, setsid, or disown.",
      "Keep process names concise and unique among live processes.",
      "When process start returns waiting armed for continuation.mode=wait, end this turn; you will be woken when the process exits or the until condition is met.",
      "The process exit wakes you automatically, so do not give wait or monitor commands short timeouts just to poll status. If such a command needs its own timeout, size it to the expected work (usually at least 15-20 minutes) and treat it only as a fallback.",
    ],
    parameters: PROCESS_TOOL_SCHEMA,
    executionMode: "parallel",
    prepareArguments(args) {
      parseToolInput(args, getRuntime()?.config.managed);
      return args as never;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let runtime = getRuntime();
      if ((!runtime || runtime.host.disposed) && recoverRuntime) runtime = await recoverRuntime();
      if (!runtime) throw new Error("[process/runtime-unavailable] process runtime is not bound to a session");
      const action = typeof params === "object" && params !== null && Object.hasOwn(params, "action")
        ? (params as { action?: unknown }).action
        : undefined;
      if (runtime.configError && (action === "start" || action === "configure")) throw runtime.configError;
      // start registers its pending record before its first Supervisor await.
      if (action !== "start") await runtime.host.ensureStarted();
      const executor = new ProcessToolExecutor({
        host: runtime.host,
        config: () => runtime.config,
        defaultCwd: () => ctx.cwd || runtime.cwd,
      });
      const result = await executor.execute(params);
      return {
        content: [{ type: "text", text: processToolModelContent(result) }],
        details: result,
      };
    },
    renderCall(args, theme) {
      let input: ToolInput | undefined;
      try { input = parseToolInput(args); } catch { /* partial arguments */ }
      return new Text(theme.fg("muted", input ? `Process ${input.action}` : "Process"), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as V2SuccessEnvelope | undefined;
      return new Text(theme.fg("muted", details ? summary(details) : "Process operation completed"), 0, 0);
    },
  };
  let previousPolicy: string | undefined;
  // Pi snapshots parameters when wrapping tools. Call this after binding the
  // current config; unchanged timeout policy keeps the existing declaration.
  const refreshSchema = (): void => {
    const managed = getRuntime()?.config.managed;
    const policy = managed ? `${managed.requireTimeout}:${managed.maxTimeoutSeconds}` : "";
    if (policy === previousPolicy) return;
    pi.registerTool({ ...definition, parameters: createProcessToolSchema(managed) });
    previousPolicy = policy;
  };
  refreshSchema();
  return refreshSchema;
}
