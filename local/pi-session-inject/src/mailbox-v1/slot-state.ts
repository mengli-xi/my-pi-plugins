import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SlotStorage } from "./storage.js";
import type { Binding, Hub } from "./runtime.js";
import { MailboxError } from "./errors.js";
import { recordKey } from "./json.js";
import type {
  BindMailboxOptions,
  CurrentDecision,
  LegacyFulfilledProof,
  LiveSubmitted,
  Mail,
  MailboxBinding,
  MailboxCallbackFence,
  MailboxCommandRouter,
  MailboxDeliveryOwner,
  MailboxHolder,
  MailboxRecoveryTarget,
  MailboxRunMember,
  MailboxSessionIdentity,
  MailboxSessionSlot,
  MailboxSnapshot,
  MailboxTarget,
  NativeEntryRef,
  PendingRecord,
  ProducerEndpoint,
  ProducerRegistration,
  PutResult,
  RecordedNotification,
  TerminalEvidence,
  TerminalRecord,
} from "./types.js";
export interface Registration {
  readonly token: symbol;
  readonly callbacks: ProducerRegistration;
  readonly binding: Binding;
  closed: boolean;
}

export interface Run {
  readonly controls: Set<string>;
  readonly observed: Map<string, MailboxRunMember>;
  request: Map<string, MailboxRunMember>;
  readonly heldSources: Set<string>;
  assistantEntryId: string | null;
  outcome: "completed" | "aborted" | "error";
  projectionReadRace: boolean;
}

export function diagnostic(ctx: ExtensionContext | null, error: unknown): void {
  try {
    ctx?.ui.notify(`Mailbox: ${error instanceof Error ? error.message : String(error)}`, "warning");
  } catch {
    /* retired UI must not reach a replacement */
  }
}

/** One identity/state object survives cold activation; no producer or native fact is copied. */
export class SlotState {
  readonly key: string;
  readonly agentDir: string;
  readonly session: MailboxSessionIdentity;
  readonly sessionManager: ExtensionContext["sessionManager"];
  bindingGeneration = 1;
  ownerEpoch = 0;
  owner: MailboxDeliveryOwner | null = null;
  readonly recoveryHeldKeys = new Set<string>();
  readonly liveAccepted = new Map<string, Mail>();
  recoveryReleased = false;
  retired = false;
  readonly submitted: LiveSubmitted = { falseBodies: new Map(), activeControls: new Map(), idleControls: new Map() };
  declare store: SlotStorage;
  ready: Promise<void>;
  readonly hub: Hub;
  readonly registrations: Registration[] = [];
  readonly incoming = new Map<number, Promise<unknown>>();
  readonly acceptedSequence = new Map<string, number>();
  readonly failedIngress = new Set<string>();
  readonly admissionAnchors = new Map<number, string>();
  ingress = 0;
  runOrdinal = 0;
  run: Run | null = null;
  critical = 0;
  compacting = false;
  draining = false;
  scheduled: ReturnType<typeof setImmediate> | null = null;
  scheduleRequested = false;
  noticesScheduled: ReturnType<typeof setImmediate> | null = null;
  readonly noticeFlights = new Map<string, Promise<void>>();
  readonly sourceErrors = new Map<string, string>();
  readonly proofErrors = new Map<string, string>();
  rebuildError: string | null = null;
  readonly proofFlights = new Map<string, Promise<readonly NativeEntryRef[]>>();
  inputCandidate: "empty" | "ambiguous" | "external" | "extension" = "empty";
  acceptedUser = false;
  terminalTail: Promise<void> = Promise.resolve();
  retiring: Promise<void> | null = null;
  restoredFromDisk = false;
  readonly emptySnapshot: MailboxSnapshot;
  constructor(hub: Hub, agentDir: string, ctx: ExtensionContext, previous?: Pick<SlotState, "liveAccepted" | "recoveryReleased">) {
    this.hub = hub;
    this.agentDir = agentDir;
    this.session = Object.freeze({
      id: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile() ?? null,
      cwd: ctx.cwd,
    });
    this.sessionManager = ctx.sessionManager;
    this.key = JSON.stringify([agentDir, this.session.id]);
    for (const [key, mail] of previous?.liveAccepted ?? []) this.liveAccepted.set(key, mail);
    this.recoveryReleased = previous?.recoveryReleased ?? false;
    this.emptySnapshot = { version: 1, session: this.session, revision: 0, suspended: null, pending: [], terminal: [] };
    this.ready = Promise.resolve();
  }
  get snapshot(): MailboxSnapshot {
    return this.store?.snapshot ?? this.emptySnapshot;
  }
  get recoveryHeld(): boolean {
    return this.snapshot.pending.some((record) => this.recoveryHeldKeys.has(recordKey(record)));
  }
  current(registration?: Registration, epoch = this.ownerEpoch, generation = this.bindingGeneration): boolean {
    if (this.retired || !this.owner || epoch !== this.ownerEpoch || generation !== this.bindingGeneration) return false;
    if (
      registration &&
      (registration.closed || (registration.binding.current as SlotState | null) !== this || !this.registrations.includes(registration))
    )
      return false;
    try {
      return this.owner.ctx.sessionManager === this.sessionManager && this.owner.ctx.sessionManager.getSessionId() === this.session.id;
    } catch {
      return false;
    }
  }
  fence(registration: Registration, attemptId = this.snapshot.attempt?.id ?? null): MailboxCallbackFence {
    return {
      slotKey: this.key,
      session: this.session,
      bindingGeneration: this.bindingGeneration,
      ownerEpoch: this.ownerEpoch,
      producerToken: registration.token,
      attemptId,
    };
  }
  validFence(registration: Registration, fence: MailboxCallbackFence): boolean {
    return registration.token === fence.producerToken && this.current(registration, fence.ownerEpoch, fence.bindingGeneration);
  }
  registration(producer: string): Registration | undefined {
    return this.registrations.find(
      (registration) =>
        !registration.closed && (registration.binding.current as SlotState | null) === this && registration.callbacks.id === producer,
    );
  }
  updateContext(ctx: ExtensionContext): void {
    if (this.owner) this.owner = { ...this.owner, ctx };
  }
  assertTarget(registration: Registration, target: MailboxTarget): void {
    if (
      target.slotKey !== this.key ||
      target.session.id !== this.session.id ||
      target.session.file !== this.session.file ||
      target.producerToken !== registration.token ||
      target.bindingGeneration !== this.bindingGeneration ||
      !this.current(registration)
    )
      throw new MailboxError("stale-binding", "mailbox producer target is stale");
  }
}
