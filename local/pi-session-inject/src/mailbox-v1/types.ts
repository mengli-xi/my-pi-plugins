import {
  MAILBOX_ABI_VERSION,
  MAILBOX_TRANSPORT_BUILD_ID,
  MAILBOX_HOLDER_KEY,
  MAILBOX_POLICIES,
  MAILBOX_COMMANDS,
  MAILBOX_CUSTOM_TYPES,
} from "./constants.js";
export {
  MAILBOX_ABI_VERSION,
  MAILBOX_TRANSPORT_BUILD_ID,
  MAILBOX_HOLDER_KEY,
  MAILBOX_POLICIES,
  MAILBOX_COMMANDS,
  MAILBOX_CUSTOM_TYPES,
} from "./constants.js";
/** Frozen mailbox-v1 contract (design-agent-mailbox.md, round 3).
 * A0 declares the interface; A1 implements the source-only shared transport.
 * See ../../docs/mailbox-v1.md for persistence, replay and lifecycle ordering.
 */
import type {
  AgentActivityOutcome,
  AgentEndEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Recovery admission needs this runtime; an older holder would silently ignore
 * put's third argument. Mixed compiled bundles must fail closed until rebuilt. */

export type ProducerId = string;

export type MailPolicy = (typeof MAILBOX_POLICIES)[number];

export type MailboxCommandName = (typeof MAILBOX_COMMANDS)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Same public text/image carrier as Pi; details must be plain JSON at acceptance.
 * No mailbox metadata is added to producer-owned messages/details. */
export type NativeMailMessage = Omit<CustomMessageEntryDraft, "type">;
export interface Mail {
  readonly producer: ProducerId;
  readonly key: string;
  readonly anchorEntryId: string | null;
  readonly policy: MailPolicy;
  readonly wake: boolean;
  readonly messages: readonly NativeMailMessage[];
}
export interface MailScope {
  readonly sessionId: string;
  readonly anchorEntryId: string | null;
}
export interface MailboxSessionIdentity {
  readonly id: string;
  /** Null for a new session with no session file yet. Never replace with cwd. */
  readonly file: string | null;
  /** Public original ctx.cwd, written by all A1 runtimes. Optional only for the
   * frozen A0/legacy shape; missing-file recovery without this locator refuses
   * to guess a project. Recovery requires the same canonical public cwd. */
  readonly cwd?: string;
}
/** Canonical JSON tuple [canonicalAgentDir, sessionId], not a slash-joined key. */
export type MailboxSlotKey = string;
/** Once at first session_start on a retired slot, and once per real session_tree
 * by its unique owner. Tree invalidates old targets even for a shared ancestor;
 * it does not change owner epoch, producer token or durable Mail identity. */
export type BindingGeneration = number;
export type OwnerEpoch = number;
/** Unique live registration identity; never serialized or reused after close. */
export type ProducerToken = symbol;
/** Stable persisted terminalId; not a request/run/Task identity. */
export type TerminalToken = string;
export interface MailboxTarget {
  readonly slotKey: MailboxSlotKey;
  readonly session: MailboxSessionIdentity;
  readonly bindingGeneration: BindingGeneration;
  readonly producerToken: ProducerToken;
}
/** Every async callback gets the original scope's fence. A rechecks all fields
 * after await. A stale completion may finish its source transaction but cannot
 * ACK a new registration, release a new attempt, or wake a replacement binding. */
export interface MailboxCallbackFence extends MailboxTarget {
  readonly ownerEpoch: OwnerEpoch;
  readonly attemptId: string | null;
}
export interface NativeEntryRef {
  readonly messageIndex: number;
  readonly entryId: string;
}
export type TerminalEvidence = {
  readonly producer: ProducerId;
  readonly key: string;
  readonly terminalId: TerminalToken;
  readonly scope: MailScope;
} & (
  | {
      readonly outcome: "fulfilled";
      readonly receiptEntryId: string;
      readonly assistantEntryId: string;
      readonly nativeEntryIds: readonly string[];
    }
  | { readonly outcome: "cancelled"; readonly reason: string }
);
export type PutResult =
  | { readonly kind: "accepted"; readonly key: string; readonly revision: number }
  | { readonly kind: "terminal"; readonly evidence: TerminalEvidence };
export interface RecordedNotice {
  readonly producer: ProducerId;
  readonly key: string;
  readonly scope: MailScope;
  /** Stable for the complete ordered set of native proofs, including replay. */
  readonly recordedToken: string;
  readonly entries: readonly NativeEntryRef[];
}
export type CheckPoint = "before-seal" | "before-native-send";
export type CurrentDecision =
  | { readonly kind: "allow"; readonly project: boolean; readonly wake: boolean }
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "cancel"; readonly reason: string };
export type NativeProofResult =
  | { readonly kind: "observed"; readonly entries: readonly NativeEntryRef[] }
  | { readonly kind: "conflict"; readonly reason: string };
export type MaybePromise<T> = T | Promise<T>;
export interface MailboxRunMember {
  /** Frozen mail: producer derives its own marker; A does not parse authority. */
  readonly mail: Mail;
  readonly entries: readonly NativeEntryRef[];
}
export interface MailboxRunStart {
  readonly event: BeforeAgentStartEvent;
  readonly ctx: ExtensionContext;
  readonly fence: MailboxCallbackFence;
  /** This producer's admitted keys/markers for this actual run only. */
  readonly members: readonly MailboxRunMember[];
  readonly automatic: boolean;
}
export interface MailboxRunEnd {
  readonly event: AgentEndEvent;
  readonly ctx: ExtensionContext;
  readonly fence: MailboxCallbackFence;
  readonly outcome: AgentActivityOutcome;
  /** This producer's keys actually observed in this run's request projection. */
  readonly members: readonly MailboxRunMember[];
  readonly assistantEntryId: string | null;
}
export interface ProducerCallbacks {
  /** Awaited before sealing AND immediately before native send. Throw => hold
   * plus diagnostic. cancel => durable cancel transaction, never silent deletion.
   * wake cannot bypass project=false or business/branch permission. */
  checkCurrent(mail: Mail, point: CheckPoint, fence: MailboxCallbackFence): MaybePromise<CurrentDecision>;
  /** Read-only original active branch proof. Missing indexes mean observation
   * absent, never permission to resend a live submission. Throw => unknown;
   * explicit conflict => blocked. Partial proofs never ACK an entire mail. */
  proveNative(mail: Mail, branch: readonly SessionEntry[], fence: MailboxCallbackFence): MaybePromise<NativeProofResult>;
  /** Durable notice first, then awaited OUTSIDE writer/lifecycle critical sections.
   * Resolve only after source durable ACK. Throw/reject/lost reply retains debt.
   * Attach/reconcile/resume replays the SAME recordedToken, without native send. */
  onRecorded?(notice: RecordedNotice, fence: MailboxCallbackFence): MaybePromise<void>;
  /** Stable fulfilled/cancelled evidence only. Resolve after source durable final
   * ACK/cancellation. Replayed even with pending=[]; never starts a model run.
   * fulfilled waits for recorded ACK; cancel supersedes unstarted recorded debt.
   * Source commit -> A fsync ACK -> verified disk receipt -> snapshot GC. */
  onTerminal?(evidence: TerminalEvidence, fence: MailboxCallbackFence): MaybePromise<void>;
  /** Awaited only at an actual public before_agent_start. No replay for ACK repair.
   * Participants may await put for this SAME run: owner awaits their admission,
   * then captures final ingress cutoff and seals. Fixed 5s bound per participant;
   * timeout/throw holds this source's uncommitted work and records a diagnostic.
   * Late continuation's mail is successor; submitted control is irrevocable. */
  beforeRun?(start: MailboxRunStart): MaybePromise<void>;
  /** Awaited only for an actual public agent_end. Source retains settlement debt
   * on throw; fulfilled transport never becomes runnable again. Never replayed. */
  afterRun?(end: MailboxRunEnd): MaybePromise<void>;
  /** Transport fence updated first, then awaited live callbacks. This is NOT an
   * all-extension-handler barrier. Throw preserves source intent; no new unguarded
   * wake. Actual custom before_agent_start seals the deferred batch. No replay. */
  settled?(event: AgentSettledEvent, ctx: ExtensionContext, fence: MailboxCallbackFence): MaybePromise<void>;
}
export interface ProducerRegistration extends ProducerCallbacks {
  readonly id: ProducerId;
  readonly capabilities?: { readonly activateNewExecution?: boolean };
}
/** Source validates its legacy business receipt; A separately verifies both IDs
 * on the original persisted branch, a successful assistant and all native mail
 * proofs. Used by every producer importer, never as permission for a model run.
 * If a source lacks either proof, retain visible-unknown; do not invent IDs.
 * Additional proof forms require owner/coordinator approval, not private source
 * JSON parsing or producer-specific optional fields added ad hoc. */
export interface LegacyFulfilledProof {
  /** For a legacy format without separate source receipt (Scheduler injection,
   * MC nudge), use the ORIGINAL native carrier entry.id. A requires it to be
   * this producer mail's own exact customType/content/identity proof on the same
   * branch, followed by the successful assistant below. An intervening edit or
   * compaction removing that carrier makes the claim unverifiable, not fulfilled. */
  readonly sourceReceiptEntryId: string;
  readonly assistantEntryId: string;
}
export interface ProducerEndpoint {
  readonly id: ProducerId;
  readonly token: ProducerToken;
  /** Synchronous capture of the ctx's current binding; rejects stale ctx. Capture
   * before starting async source work and pass to put/cancel to prevent rehoming. */
  target(ctx: ExtensionContext): MailboxTarget;
  /** Only a registration declaring capabilities.activateNewExecution=true may attest a newly
   * created SDK execution, before its first real run and without a restored
   * mailbox snapshot. Retained as an explicit owner check; newly accepted live
   * keys already bypass recovery hold. Creates no control/grant.
   * Restored/previously-run slots and undeclared registrations reject with a diagnostic. */
  activateNewExecution(target: MailboxTarget): Promise<void>;
  /** Clones/validates plain JSON at synchronous ingress, then serializes fsync
   * acceptance. Resolve never waits for model/source ACK. Same scope/key/payload
   * returns original acceptance or terminal; changed payload/origin is conflict.
   * Omitted target captures the current binding at CALL time, before any await.
   * Legacy/recovery importers pass {recovered:true}: its FIRST acceptance is held
   * until trusted accepted interactive/rpc input or /mailbox resume. Ordinary
   * live acceptance, same-key rebind/tree replay, or an already released recovery
   * is never held again by this option. No source-owned permanent guard needed. */
  put(mail: Mail, target?: MailboxTarget, options?: { readonly recovered: true }): Promise<PutResult>;
  /** Import a legacy fulfilled key without acceptance/wake/native resend.
   * Verify disk/native proof -> append/read back shared delivery receipt -> one
   * terminal snapshot with frozen mail/required ACK debt. Idempotent; identical
   * existing terminal wins, identity/proof conflicts reject. No lifecycle replay. */
  importFulfilled(mail: Mail, proof: LegacyFulfilledProof, target?: MailboxTarget): Promise<TerminalEvidence>;
  /** Resolve only after tombstone + notification debt commit in ONE snapshot.
   * Unknown key rejects; existing terminal returns unchanged. Does not wait for
   * source ACK and cannot retract native queue/frozen provider request. */
  cancel(key: string, reason: string, target?: MailboxTarget): Promise<TerminalEvidence>;
  /** Sync release of this registration only. Pending/debt/submitted tokens and
   * runner command facade survive. Stale release cannot remove a replacement. */
  close(): void;
}
export interface MailboxBinding {
  /** Synchronous lightweight lifecycle bridge; no file IO/model call. Producer
   * attach rebuilds terminal index and drains owed ACKs before its new delivery.
   * Required ACK callbacks are frozen per accepted record, not inferred later. */
  registerProducer(registration: ProducerRegistration): ProducerEndpoint;
  /** Sync release of this binding's registrations, not of another bundle's. */
  close(): void;
}
export interface BindMailboxOptions {
  /** Defaults to public getAgentDir(); canonicalized before indexing/locking. */
  readonly agentDir?: string;
}

/** Exact persisted JSON shape. Live native-submitted facts are NEVER serialized. */
export interface RequiredCallbacks {
  readonly recorded: boolean;
  readonly terminal: boolean;
}
export interface RecordedNotification {
  readonly notice: RecordedNotice;
  readonly ack: "pending" | "acknowledged";
}
export interface TerminalRecordedNotification {
  readonly notice: RecordedNotice;
  readonly ack: RecordedNotification["ack"] | "superseded-by-cancel";
}
export interface PendingRecord extends Mail {
  /** First acceptance revision; duplicate put returns this revision. */
  readonly acceptedRevision: number;
  readonly requiredCallbacks: RequiredCallbacks;
  /** Origin lineage anchor, including a durable empty-session anchor if needed. */
  readonly branchEntryId: string | null;
  readonly nativeEntries: readonly NativeEntryRef[];
  readonly recorded: RecordedNotification | null;
  /** Durable importer intent, committed with frozen callbacks/recorded token
   * BEFORE its first delivery receipt. Never eligible for projection or wake.
   * receiptEntryId is generated by the later public append and is not invented. */
  readonly legacyImport?: {
    readonly proof: LegacyFulfilledProof;
    readonly evidence: Omit<Extract<TerminalEvidence, { outcome: "fulfilled" }>, "receiptEntryId">;
  };
}
export interface TerminalRecord {
  /** Retains frozen identity material for post-GC conflict verification. */
  readonly mail: Mail;
  readonly branchEntryId: string | null;
  readonly evidence: TerminalEvidence;
  readonly requiredCallbacks: RequiredCallbacks;
  readonly recorded: TerminalRecordedNotification | null;
  readonly terminalAck: "pending" | "acknowledged";
  /** Cancel's later receipt is backing only, never a mutation of evidence. */
  readonly backingReceiptEntryId: string | null;
}
export interface MailboxMember {
  readonly producer: ProducerId;
  readonly key: string;
  readonly anchorEntryId: string | null;
}
export interface PersistedAttempt {
  readonly id: string;
  readonly members: readonly MailboxMember[];
  readonly sealedRevision: number;
}
export interface MailboxSuspension {
  readonly reason: "aborted" | "error" | "blocked";
  readonly detail: string;
}
export interface MailboxSnapshot {
  readonly version: 1;
  readonly session: MailboxSessionIdentity;
  readonly revision: number;
  readonly suspended: MailboxSuspension | null;
  readonly pending: readonly PendingRecord[];
  readonly terminal: readonly TerminalRecord[];
  readonly attempt?: PersistedAttempt;
}
export interface MailboxTriggerDetails {
  readonly version: 1;
  readonly sessionId: string;
  readonly attemptId: string;
}
export interface MailboxAttemptReceipt extends PersistedAttempt {
  readonly version: 1;
  readonly sessionId: string;
}
/** The containing Pi entry supplies receiptEntryId when reconstructing fulfilled
 * evidence; it cannot be known before public appendEntry generates that ID. */
export type DeliveryTerminalEvidence =
  | Omit<Extract<TerminalEvidence, { outcome: "fulfilled" }>, "receiptEntryId">
  | Extract<TerminalEvidence, { outcome: "cancelled" }>;
export interface MailboxDeliveryReceipt {
  readonly version: 1;
  readonly sessionId: string;
  /** Frozen mail + original evidence retained in history for terminal index GC. */
  readonly terminals: readonly {
    readonly mail: Mail;
    readonly branchEntryId: string | null;
    readonly evidence: DeliveryTerminalEvidence;
  }[];
}

/** Process-local facts survive owner handoff and same-AgentSession reload. No
 * timeout, unrelated run, idle/pending count or clear_queue proves their absence. */
export interface FalseBodySubmission {
  readonly producer: ProducerId;
  readonly key: string;
  readonly messageIndex: number;
  readonly scope: MailScope;
  readonly submittedBy: MailboxCallbackFence;
  readonly nativeEntryId: string | null;
}
export interface ActiveControlSubmission {
  readonly details: MailboxTriggerDetails;
  readonly submittedBy: MailboxCallbackFence;
  /** Only THIS sessionId/attemptId at its own message boundary confirms start. */
  readonly start: { readonly boundary: "message_start" | "message_end" } | null;
  readonly nativeEntryId: string | null;
}
export interface IdleControlSubmission {
  readonly details: MailboxTriggerDetails;
  readonly submittedBy: MailboxCallbackFence;
  /** Includes deferred control. Only its matching before_agent_start confirms. */
  readonly start: { readonly boundary: "before_agent_start" } | null;
  readonly nativeEntryId: string | null;
}
export interface LiveSubmitted {
  /** Key = JSON.stringify([producer,key,messageIndex]); never ambiguous joining. */
  readonly falseBodies: Map<string, FalseBodySubmission>;
  readonly activeControls: Map<string, ActiveControlSubmission>;
  readonly idleControls: Map<string, IdleControlSubmission>;
}
export interface MailboxDeliveryOwner {
  readonly producerToken: ProducerToken;
  readonly epoch: OwnerEpoch;
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  /** Delivery hooks only: registrar and command facade are stored separately. */
  readonly hookDisposers: readonly (() => void)[];
}
export interface MailboxSessionSlot {
  readonly key: MailboxSlotKey;
  readonly agentDir: string;
  readonly session: MailboxSessionIdentity;
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly bindingGeneration: BindingGeneration;
  readonly ownerEpoch: OwnerEpoch;
  readonly owner: MailboxDeliveryOwner | null;
  readonly snapshot: MailboxSnapshot;
  readonly submitted: LiveSubmitted;
  readonly recoveryHeld: boolean;
  readonly retired: boolean;
}
/** globalThis[Symbol.for(MAILBOX_HOLDER_KEY)]; validate ABI, build ID AND methods.
 * Never replace an existing incompatible holder or fall back to private sends. */
export interface MailboxHolder {
  readonly version: 1;
  readonly transportBuildId: typeof MAILBOX_TRANSPORT_BUILD_ID;
  readonly slots: Map<MailboxSlotKey, MailboxSessionSlot>;
  bind(pi: ExtensionAPI, options?: BindMailboxOptions): MailboxBinding;
}

export type MailboxCommand =
  | { readonly kind: "status" }
  | { readonly kind: "resume" }
  | { readonly kind: "recover"; readonly sessionId: string };
export interface MailboxStatus {
  readonly session: MailboxSessionIdentity;
  readonly hasOwner: boolean;
  readonly recoveryHeld: boolean;
  readonly suspended: MailboxSuspension | null;
  readonly pending: readonly MailboxMember[];
  readonly sourceAckPending: number;
}
export interface MailboxRecoveryTarget {
  readonly agentDir: string;
  readonly session: MailboxSessionIdentity;
  readonly pendingCount: number;
}
export interface MailboxCommandRoute {
  readonly slotKey: MailboxSlotKey;
  /** Read-only, no model request; IO failure rejects for visible diagnostics. */
  status(): Promise<MailboxStatus>;
  /** No owner => visible refusal, never elect/create a new owner/control. */
  resume(): Promise<void>;
}
export interface MailboxCommandRouter {
  /** Sync resolve at invocation from THIS ctx; never capture old pi/ctx/epoch.
   * Throw fails visibly, never falls back to a private send. No callback replay. */
  current(ctx: ExtensionCommandContext): MailboxCommandRoute | null;
  /** Sync pure cache maintained by facade lifecycle, not delivery owner.
   * Unavailable/throw => no completion, never synthetic resource IDs. */
  completionScope(): { readonly agentDir: string; readonly slotKey: MailboxSlotKey } | null;
  /** Sync; null means unavailable. IDs come from real orphan/pending resources.
   * Throw fails visibly for commands / returns no candidates for completion. */
  recoveryTargets(agentDir: string): readonly MailboxRecoveryTarget[] | null;
  /** Awaited after displaying exact target, using public newSession/setup.
   * Reject preserves original pending and reports error; no current-session send
   * or automatic replay/GC of source facts. */
  recover(target: MailboxRecoveryTarget, ctx: ExtensionCommandContext): Promise<void>;
}
/** Installed once per runner on first session_start after synchronous public
 * getCommands inventory + provenance check. Owner.close never unregisters it.
 * Parser and completions share MAILBOX_COMMANDS; unknown grammar fails closed. */
export type MailboxCommandFacade = Required<Pick<RegisteredCommand, "description" | "handler" | "getArgumentCompletions">>;

export type MailboxErrorCode =
  | "not-implemented"
  | "not-ready"
  | "unknown-key"
  | "conflict"
  | "stale-binding"
  | "writer-conflict"
  | "holder-incompatible"
  | "command-collision"
  | "io-error"
  /** No stable read within the bounded attempt; retry only at a later boundary. */
  | "read-race"
  | "unverifiable-proof";
