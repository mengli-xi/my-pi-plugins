import type { ProcessSummary } from "../domain/types.js";
import type { SupervisorEvent } from "../host/supervisor-client.js";
import {
  createProcessTuiEntryEnvelopeV1,
} from "./broker.js";
import type {
  NotificationFactV1,
  NotificationTargetV1,
  ObserveNotificationInputV1,
  ProcessTuiEntryEnvelopeV1,
} from "./types.js";
import {
  lifecycleMessage,
  type ProcessLifecycleMessageV2,
} from "../integrations/lifecycle-entry.js";

export interface NotificationProjectionInputV1 {
  readonly sessionScopeId: string;
  readonly hostIncarnationId: string;
  readonly notificationSequence: number;
  readonly target: NotificationTargetV1;
  readonly event: SupervisorEvent;
  readonly process: ProcessSummary;
  readonly attention: "turn" | "context" | "ignore";
  readonly observedAt: string;
  readonly watchRepeat?: boolean;
  readonly supervisor?: Readonly<{ nonce: string; generation: number }>;
  readonly leaseWakeTransactionId?: string;
}

export interface NotificationProjectionV1 {
  readonly observe: ObserveNotificationInputV1;
  readonly lifecycle: ProcessLifecycleMessageV2;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function terminalFact(message: ProcessLifecycleMessageV2): NonNullable<NotificationFactV1["terminal"]> {
  const terminal = message.terminal;
  if (!terminal) throw new Error("terminal lifecycle message lacks terminal semantics");
  return {
    outcome: terminal.outcome,
    cause: terminal.cause,
    durationMs: terminal.durationMs,
    ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
    ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
    ...(terminal.timeoutMs === undefined ? {} : { timeoutMs: terminal.timeoutMs }),
  };
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const suffix = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let bytes = 0;
  let text = "";
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > budget) break;
    text += codePoint;
    bytes += size;
  }
  return { text: `${text}${suffix}`, truncated: true };
}

function boundedTuiMessage(message: ProcessLifecycleMessageV2): ProcessLifecycleMessageV2 {
  if (message.kind !== "watch-match" || !message.details) return message;
  const { text, ...details } = message.details;
  if (typeof text !== "string") return message;
  const excerpt = truncateUtf8(text, 2_000);
  return {
    ...message,
    details: {
      ...details,
      textExcerpt: excerpt.text,
      textBytes: Buffer.byteLength(text, "utf8"),
      textTruncated: excerpt.truncated,
    },
  };
}

function tuiEntry(message: ProcessLifecycleMessageV2, fact: NotificationFactV1): ProcessTuiEntryEnvelopeV1 | undefined {
  if (fact.kind === "watch-suppressed" || (fact.kind === "terminal" && fact.terminal?.cause === "stopped")) return undefined;
  return createProcessTuiEntryEnvelopeV1(boundedTuiMessage(message) as unknown as Readonly<Record<string, unknown>>);
}

/**
 * Process-specific projection adapter. It relies on Supervisor eventSequence
 * ordering and the process-event-v2 lifecycle contract. Unknown event types
 * fail closed by returning undefined and never mutate broker state.
 */
export function projectNotificationV1(input: NotificationProjectionInputV1): NotificationProjectionV1 | undefined {
  const lifecycle = lifecycleMessage(input.event, input.process);
  if (!lifecycle) return undefined;
  let kind: NotificationFactV1["kind"];
  let stableCode: string | undefined;
  let watch: NotificationFactV1["watch"] | undefined;
  let terminal: NotificationFactV1["terminal"] | undefined;
  if (input.event.type === "terminal") {
    kind = "terminal";
    terminal = terminalFact(lifecycle);
  } else if (input.event.type === "watchMatch") {
    const key = typeof input.event.payload.key === "string" ? input.event.payload.key : undefined;
    if (!key) return undefined;
    const definition = input.process.watches.keys.includes(key);
    if (!definition) return undefined;
    const sequence = positiveInteger(input.event.payload.sequence);
    const generation = positiveInteger(input.event.payload.generation);
    if (!sequence || !generation) return undefined;
    kind = "watch-match";
    watch = { key, generation, repeat: input.watchRepeat === true, firstSequence: sequence, lastSequence: sequence, count: 1 };
  } else if (input.event.type === "matcherError") {
    const key = typeof input.event.payload.key === "string" ? input.event.payload.key : undefined;
    const code = typeof input.event.payload.code === "string" ? input.event.payload.code : undefined;
    if (!key || !code) return undefined;
    const sequence = positiveInteger(input.event.payload.sequence);
    const generation = positiveInteger(input.event.payload.generation);
    if (!sequence || !generation) return undefined;
    kind = "matcher-error";
    stableCode = code;
    watch = { key, generation, repeat: false, firstSequence: sequence, lastSequence: sequence, count: 1 };
  } else return undefined;
  const fact: NotificationFactV1 = {
    version: 1,
    factId: `${input.sessionScopeId}:${input.hostIncarnationId}:${input.notificationSequence}`,
    sessionScopeId: input.sessionScopeId,
    source: {
      hostIncarnationId: input.hostIncarnationId,
      notificationSequence: input.notificationSequence,
      ...(input.supervisor ? { supervisor: {
        nonce: input.supervisor.nonce,
        generation: input.supervisor.generation,
        eventSequence: input.event.eventSequence,
      } } : {}),
    },
    observedAt: input.observedAt,
    process: { id: input.process.id, name: input.process.name, kind: input.process.kind },
    kind,
    ...(stableCode ? { stableCode } : {}),
    attention: input.attention,
    ...(watch ? { watch } : {}),
    ...(terminal ? { terminal } : {}),
  };
  const entry = tuiEntry(lifecycle, fact);
  return {
    lifecycle,
    observe: {
      target: input.target,
      fact,
      ...(entry ? { tuiEntry: entry } : {}),
      ...(input.leaseWakeTransactionId ? { leaseWakeTransactionId: input.leaseWakeTransactionId } : {}),
    },
  };
}
