/**
 * Local-socket request/response protocol between the Pi side (tool, command,
 * extension) and the daemon (decision #16). Newline-delimited JSON frames over
 * a Unix domain socket. This module is transport-agnostic: it defines the
 * message shapes and a line codec; the socket itself lives in the daemon and
 * client modules.
 *
 * The daemon is the single writer (decision #15): every mutation is a request
 * here, never a direct file write from the Pi side.
 */

import type { NativeMailMessage, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import type { InjectionMarker } from "./store.ts";
import type { HolderRejection } from "./occupancy.ts";
import type { RunRecord, Task } from "./task.ts";

/** Extension → daemon session-occupancy registration (decision #17). */
export interface OccupancyRegister {
  type: "occupancy.register";
  sessionId: string;
  pid: number;
  /** Random identity for this exact session binding. Omitted by legacy clients. */
  holderToken?: string;
  /** Monotonic per-extension binding generation; prevents late old register. */
  bindingGen?: number;
}

export interface OccupancyUnregister {
  type: "occupancy.unregister";
  sessionId: string;
  pid: number;
  /** Must match a tokenful registration; omitted for legacy pid-only entries. */
  holderToken?: string;
  /** Must match the tokenful registration generation. */
  bindingGen?: number;
}

export interface InjectionPollRequest {
  type: "injection.poll";
  sessionId: string;
  pid: number;
  holderToken: string;
  bindingGen: number;
}

export interface InjectionAckRequest {
  type: "injection.ack";
  injectionId: string;
  /** Required for append offers; omitted when proving append-uncertain state. */
  leaseToken?: string;
  entryId: string;
}

export type InjectionNackReason =
  | "not-appended"
  | "append-unknown"
  | "content-conflict";

export interface InjectionNackRequest {
  type: "injection.nack";
  injectionId: string;
  /** Required for append offers; omitted when proving append-uncertain state. */
  leaseToken?: string;
  reason: InjectionNackReason;
}

interface InjectionOfferBase {
  injectionId: string;
  taskId: string;
  title: string;
  prompt: string;
  contentDigest: string;
  scheduledTime: number;
}

/** A new append may be attempted exactly once under this bounded lease. */
export interface InjectionAppendOffer extends InjectionOfferBase {
  mode: "append";
  leaseToken: string;
  expiresAt: number;
}

/** Proof-only recovery: inspect the branch, but never append the prompt again. */
export interface InjectionProofOffer extends InjectionOfferBase {
  mode: "prove";
  leaseToken?: never;
  expiresAt?: never;
}

export type InjectionOffer = InjectionAppendOffer | InjectionProofOffer;

export type InjectionMutationResult =
  | { ok: true }
  | { ok: false; error: string };

export type InjectionPollCallback = (
  request: InjectionPollRequest,
) => InjectionOffer | undefined;

export type InjectionAckCallback = (
  request: InjectionAckRequest,
) => InjectionMutationResult;

export type InjectionNackCallback = (
  request: InjectionNackRequest,
) => InjectionMutationResult;

/** Durable source protocol for mailbox-v1. Old append ACK is never a handoff. */
export interface MailboxInjectionOffer {
  legacy?: boolean;
  /** Source work inherited from another holder or an old source format. */
  recovered?: boolean;
  injectionId: string;
  taskId: string;
  title: string;
  prompt: string;
  contentDigest: string;
  scheduledTime: number;
  staleAt: number;
  anchorEntryId: string | null;
}
export type MailboxInjectionRequest =
  | (Omit<InjectionPollRequest, "type"> & { type: "injection.offers";
      anchorEntryId: string | null;
      nativeProofs: { injectionId: string; anchorEntryId: string | null; entryId: string; message: NativeMailMessage }[] })
  | { type: "injection.current"; injectionId: string; sessionId: string }
  | { type: "injection.handoff"; injectionId: string; sessionId: string;
      recordedToken: string; entryId: string; anchorEntryId: string | null }
  | { type: "injection.start"; injectionId: string; sessionId: string }
  | { type: "injection.failed"; injectionId: string; sessionId: string; outcome: "aborted" | "error" }
  | { type: "injection.terminal"; evidence: TerminalEvidence };
export type MailboxInjectionResponse =
  | { ok: true; type: "injection-offers"; offers: MailboxInjectionOffer[]; unknown: { injectionId: string; reason: string }[] }
  | { ok: true; type: "injection-current"; marker: InjectionMarker | null; now: number; legacyDelivered?: boolean };

export type SchedulerRequest =
  | MailboxInjectionRequest
  | { type: "task.create"; task: Task }
  | { type: "task.update"; id: string; patch: Partial<Task> }
  | { type: "task.delete"; id: string }
  | { type: "task.pause"; id: string }
  | { type: "task.resume"; id: string }
  | { type: "task.runNow"; id: string }
  | { type: "task.list" }
  | { type: "task.runs"; id: string }
  | { type: "failures.list" }
  | { type: "failures.acknowledge"; through: number }
  | OccupancyRegister
  | OccupancyUnregister
  | InjectionPollRequest
  | InjectionAckRequest
  | InjectionNackRequest
  | { type: "daemon.status" }
  | { type: "daemon.update" }
  | { type: "ping" };

export type SchedulerResponse =
  | MailboxInjectionResponse
  | { ok: true; type: "ack" }
  | { ok: true; type: "task"; task: Task }
  | { ok: true; type: "tasks"; tasks: Task[] }
  | { ok: true; type: "runs"; runs: RunRecord[] }
  | { ok: true; type: "failures"; failures: RunRecord[] }
  | { ok: true; type: "injection"; injection?: InjectionOffer }
  | { ok: true; type: "daemon-status"; buildId: string; draining: boolean }
  | { ok: true; type: "pong" }
  | { ok: false; error: string; currentGeneration?: number; holderRejection?: HolderRejection };

export interface Envelope<T> {
  /** Correlates a response with its request over a shared connection. */
  id: number;
  body: T;
}

/** Encode one envelope as a single newline-terminated JSON line. */
export function encodeFrame<T>(envelope: Envelope<T>): string {
  return `${JSON.stringify(envelope)}\n`;
}

/**
 * Incremental newline-delimited JSON decoder. Push received chunks; get back
 * whole envelopes. A frame larger than `maxFrameBytes` is a protocol error, so
 * a stuck/garbage peer cannot grow the buffer without bound.
 */
export class FrameDecoder<T> {
  private buffer = "";
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = 1_000_000) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: string): Array<Envelope<T>> {
    this.buffer += chunk;
    if (this.buffer.length > this.maxFrameBytes && !this.buffer.includes("\n")) {
      this.buffer = "";
      throw new Error("scheduler frame exceeded max size before a newline");
    }
    const out: Array<Envelope<T>> = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        const parsed = JSON.parse(line) as Envelope<T>;
        if (typeof parsed?.id !== "number" || !("body" in parsed)) {
          throw new Error("scheduler frame missing id/body");
        }
        out.push(parsed);
      }
      newline = this.buffer.indexOf("\n");
    }
    return out;
  }
}
