import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  getContinuationRegistryV1,
  type BlockingLeaseHandleV1,
  type ContinuationRegistryV1,
  type WakeProducerTransactionV1,
  type WakeConsumerReceiptV1,
} from "pi-runtime-contracts/continuation-v1";

import { assertProcessesExecutionIsolationCurrent, processesExecutionAuthority, type ProcessesConfig } from "../config.js";
import type { ProcessNotificationBatchV1 } from "../notifications/types.js";
import {
  summarizeProcess,
  type Attention,
  type ContinuationPolicy,
  type NotifyPolicy,
  type ProcessRecord,
  type ProcessState,
  type ProcessSummary,
  type WatchDefinition,
} from "../domain/types.js";
import type { ToolInput, WatchUpdate } from "../tool/input.js";
import { createNotificationBrokerV1, type NotificationBrokerV1 } from "../notifications/broker.js";
import { NotificationBrokerErrorV1 } from "../notifications/types.js";
import { projectNotificationV1 } from "../notifications/projection.js";
import type {
  NotificationTargetV1,
  PreparedNotificationBatchV1,
  PrepareNotificationBatchInputV1,
  ProcessNotificationSnapshotV1,
  TuiDeliveryRecordSnapshotV1,
} from "../notifications/types.js";
import type { SupervisorEvent } from "./supervisor-client.js";
import type { ManagedProcessGroupV1, ProcessesManagedSnapshotV1 } from "../integrations/status-protocol.js";

export const RECLAIM_WINDOW_MS = 15_000;
/** Terminal cause for a record the Host itself contained after its Supervisor was lost. */
export const RUNTIME_CONTAINED_ERROR_CODE = "runtime-contained";
export const RUNTIME_CONTAINED_MESSAGE = "supervisor channel lost; runtime containment stopped this process group";
const TERMINAL_STRIP_RETENTION_MS = 5_000;
const PROCESS_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const TERMINAL_STATES = new Set<ProcessState>(["succeeded", "failed", "stopped", "killed", "crashed"]);

export type BindingRetireReason = "reload" | "scope-ended" | "package-removed" | "pi-exit";
export type CleanupReason = "scope-ended" | "package-removed" | "reclaim-timeout" | "pi-exit" | "protocol-failure";

export interface RuntimeBindingCallbacks {
  deliver(event: SupervisorEvent, state?: { readonly tuiOwned: boolean; readonly tuiPersisted: boolean; readonly tuiDeliveryId?: string; readonly modelOwned: boolean; readonly modelLane?: "context" | "turn"; readonly wakeTransactionId?: string; readonly wakeClaimed?: boolean }): void | { readonly deferWake: true } | Promise<void | { readonly deferWake: true }>;
  appendNotificationEntry?(entry: { readonly deliveryId: string; readonly customType: "process-event-v2" | "process-notification-receipt-v1"; readonly data: unknown; readonly dataSha256: string }): void | Promise<void>;
  notificationEntriesPersisted?(): void;
  currentRunAborted?(): boolean;
  requestRender?(): void;
  report?(message: string): void;
}

export interface HostTransport {
  readonly root?: string;
  readonly supervisorPid: number;
  readonly hostNonce?: string;
  readonly generation?: number;
  readonly closed: boolean;
  request(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  cleanup(reason: CleanupReason, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForExit(timeoutMs?: number): Promise<void>;
  terminate(signal?: NodeJS.Signals): void;
  close(): void;
}

export interface TransportCallbacks {
  onEvent(event: SupervisorEvent): void;
  onChannelLost(error: Error): void;
}

export interface HostClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: HostClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface HostProcessControl {
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean;
  groupAlive(pgid: number): boolean;
}

const REAL_PROCESS_CONTROL: HostProcessControl = {
  signalGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  },
  groupAlive: (pgid) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

const CLEANUP_REQUEST_TIMEOUT_MS = 35_000;
const EMERGENCY_TERM_GRACE_MS = 1_000;
const EMERGENCY_KILL_REAP_MS = 1_000;
const EMERGENCY_SUPERVISOR_EXIT_MS = 2_000;

export interface ProcessHostOptions {
  sessionScopeId: string;
  executionAuthority?: string;
  launch(callbacks: TransportCallbacks): Promise<HostTransport>;
  clock?: HostClock;
  processControl?: HostProcessControl;
  continuationRegistry?: ContinuationRegistryV1;
  notificationBroker?: NotificationBrokerV1;
  now?: () => number;
  captureNotificationTarget?(): NotificationTargetV1;
  onDisposed?(host: ProcessHost): void;
}

export interface ProcessBindingLease {
  readonly generation: number;
  markReady(): Promise<void>;
  retire(reason: BindingRetireReason): Promise<void>;
}

interface RuntimeBindingState {
  readonly generation: number;
  ready: boolean;
  readonly callbacks: RuntimeBindingCallbacks;
}

/** Scope-owned drain intent; a successor stays on the branch carrying its preceding batch. */
export interface MainTurnNotificationPendingV1 {
  readonly afterBatchId?: string;
}

export interface MainTurnNotificationReceiptV1 {
  readonly batch: ProcessNotificationBatchV1;
  /** Active-run messages become durable only after Pi flushes the turn queue. */
  readonly persisted: boolean;
  readonly wakeSettled: boolean;
}

interface RecordOnlyNotificationReceiptV1 {
  readonly batchId: string;
  readonly target: NotificationTargetV1;
  readonly lane: "context" | "turn";
  readonly wakeTransactionIds: readonly string[];
  readonly settledTransactionIds: Set<string>;
}

interface PendingDelivery {
  readonly event: SupervisorEvent;
  readonly wake?: WakeProducerTransactionV1;
  readonly notificationLeaseTransactionId?: string;
  readonly tuiDisposition: "append" | "aggregate-only" | "none";
  readonly tuiDeliveryId?: string;
  readonly modelOwned: boolean;
  readonly modelLane?: "context" | "turn";
}

interface PendingStart {
  readonly input: Extract<ToolInput, { action: "start" }>;
  readonly config: ProcessesConfig;
  readonly id: string;
  readonly cwd: string;
  readonly startOrder: number;
  readonly notificationTarget: NotificationTargetV1;
  readonly events: SupervisorEvent[];
}

interface ListCursorPayload {
  readonly version: 1;
  readonly hostRevision: number;
  readonly offset: number;
  readonly states: readonly ProcessState[];
  readonly sort: Extract<ToolInput, { action: "list" }>["sort"];
}

/**
 * `disposed` alone never proves the runtime is contained: `#prepareDisposal()`
 * sets it before cleanup runs, and a failed cleanup leaves the Host in
 * quarantine. Readers that present state to a human need the four cases apart.
 *
 * - `active`: the Host still owns a live runtime.
 * - `pending`: disposal started; containment has not settled yet.
 * - `failed`: cleanup failed (`cleanupError`); the Host is quarantined and the
 *   next process call is rejected until cleanup resolves.
 * - `contained`: containment completed and left no error behind.
 */
export type HostContainment = "active" | "pending" | "failed" | "contained";

export interface ProcessListResult {
  readonly processes: readonly ProcessSummary[];
  readonly nextCursor?: string;
}

export interface ProcessLogsResult {
  readonly process: ProcessSummary;
  readonly revision: number;
  readonly lines: readonly { readonly sequence: number; readonly stream: "stdout" | "stderr"; readonly text: string }[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
  readonly droppedBytes: number;
  readonly droppedLines: number;
}

export interface ProcessInputResult {
  readonly process: ProcessSummary;
  readonly bytesAccepted: number;
  readonly stdinOpen: boolean;
}

export interface ProcessConfigureResult {
  readonly process: ProcessSummary;
  readonly changed: readonly string[];
}

export interface ProcessStopResult {
  readonly process: ProcessSummary;
  readonly signal: string;
  readonly delivered: boolean;
}

export interface ProcessClearResult {
  readonly cleared: readonly string[];
  readonly failed: readonly { readonly id: string; readonly message: string }[];
}

function processError(code: string, message: string): Error {
  return new Error(`[process/${code}] ${message}`);
}

function cloneEvent(event: SupervisorEvent): SupervisorEvent {
  return {
    type: event.type,
    eventSequence: event.eventSequence,
    payload: { ...event.payload },
  };
}

function queueKey(event: SupervisorEvent): string | undefined {
  if (event.type === "logCursorAdvanced" || event.type === "capacityChanged") {
    const id = typeof event.payload.id === "string" ? event.payload.id : "unknown";
    return `${event.type}:${id}`;
  }
  return undefined;
}

function generateProcessId(existing: ReadonlyMap<string, ProcessRecord>, pending: ReadonlyMap<string, PendingStart>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(12);
    let suffix = "";
    for (const byte of bytes) suffix += PROCESS_ID_ALPHABET[byte % PROCESS_ID_ALPHABET.length];
    const id = `proc_${suffix}`;
    if (!existing.has(id) && !pending.has(id)) return id;
  }
  throw processError("capacity", "could not allocate a unique process ID");
}

function live(record: ProcessRecord): boolean {
  return !TERMINAL_STATES.has(record.state);
}

function resultObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw processError("protocol-invalid", `${name} response is invalid`);
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw processError("protocol-invalid", `${name} is invalid`);
  return value as number;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : safeInteger(value, name);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw processError("protocol-invalid", `${name} is invalid`);
  return value;
}

function resolveNotify(config: ProcessesConfig, override?: Partial<NotifyPolicy>): NotifyPolicy {
  return {
    onSuccess: override?.onSuccess ?? config.notifications.onSuccess,
    onFailure: override?.onFailure ?? config.notifications.onFailure,
    onKilled: override?.onKilled ?? config.notifications.onKilled,
    onCrash: override?.onCrash ?? config.notifications.onCrash,
  };
}

function updateNotify(current: NotifyPolicy, defaults: NotifyPolicy, update: Partial<Record<keyof NotifyPolicy, Attention | null>>): NotifyPolicy {
  return {
    onSuccess: update.onSuccess === null ? defaults.onSuccess : update.onSuccess ?? current.onSuccess,
    onFailure: update.onFailure === null ? defaults.onFailure : update.onFailure ?? current.onFailure,
    onKilled: update.onKilled === null ? defaults.onKilled : update.onKilled ?? current.onKilled,
    onCrash: update.onCrash === null ? defaults.onCrash : update.onCrash ?? current.onCrash,
  };
}

function applyWatchUpdate(current: ReadonlyMap<string, WatchDefinition>, update: WatchUpdate): Map<string, WatchDefinition> {
  if (update.operation === "clear") return new Map();
  if (update.operation === "replace") return new Map(update.items.map((item) => [item.key, item]));
  const next = new Map(current);
  if (update.operation === "remove") {
    for (const key of update.keys) {
      if (!next.delete(key)) throw processError("not-found", `watch '${key}' was not found`);
    }
    return next;
  }
  for (const item of update.items) next.set(item.key, item);
  if (next.size > 20) throw processError("capacity", "a process may have at most 20 watches");
  return next;
}

function supervisorWatch(watch: WatchDefinition): { key: string; pattern: string; mode: "literal" | "regex"; stream: "stdout" | "stderr" | "both"; repeat: boolean } {
  return { key: watch.key, pattern: watch.pattern, mode: watch.mode, stream: watch.stream, repeat: watch.repeat };
}

function terminalState(payload: Record<string, unknown>): ProcessState {
  const classification = payload.classification;
  const exitCode = payload.exitCode;
  const signal = payload.signal;
  if (classification === "timeout") return "failed";
  if (classification === "stopped") return "stopped";
  if (classification === "error") return "crashed";
  if (classification === "natural" && exitCode === 0) return "succeeded";
  if (classification === "failed") return signal ? "killed" : "failed";
  return signal ? "killed" : exitCode === 0 ? "succeeded" : "failed";
}

function cursorJson(value: ListCursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export class ProcessHost {
  readonly sessionScopeId: string;

  #clock: HostClock;
  #processControl: HostProcessControl;
  #launch: ProcessHostOptions["launch"];
  #now: () => number;
  #continuationRegistry: ContinuationRegistryV1;
  #captureNotificationTarget: () => NotificationTargetV1;
  #notificationBroker: NotificationBrokerV1;
  #hostIncarnationId = `host-${randomUUID()}`;
  #notificationSequence = 0;
  #notificationRunAbortFence = false;
  #notificationTurnEpochSealed = false;
  #mainTurnNotificationPending?: MainTurnNotificationPendingV1;
  #mainTurnNotificationReceipt?: MainTurnNotificationReceiptV1;
  readonly #mainTurnPendingBatches = new Map<string, ProcessNotificationBatchV1>();
  readonly #notificationClaimReceipts = new Map<string, WakeConsumerReceiptV1>();
  readonly #deferredNotificationWakes = new Map<string, WakeProducerTransactionV1>();
  readonly #settledDeferredNotificationWakes = new Set<string>();
  readonly #notificationBatchWakeIds = new Map<string, readonly string[]>();
  readonly #recordOnlyNotificationReceipts = new Map<string, RecordOnlyNotificationReceiptV1>();
  #transport?: HostTransport;
  #launching?: Promise<HostTransport>;
  #bindingGeneration = 0;
  #binding?: RuntimeBindingState;
  #reclaimTimer?: unknown;
  #stripExpiryTimers = new Map<string, unknown>();
  #pending: PendingDelivery[] = [];
  #disposed = false;
  #disposePromise?: Promise<void>;
  #emergencyCleanupPromise?: Promise<{ unresolvedGroups: number; supervisorExited: boolean }>;
  #runtimeContainmentComplete = false;
  #registryOwnershipReleased = false;
  #flushPromise?: Promise<void>;
  #flushRequested = false;
  #cleanupError?: Error;
  #records = new Map<string, ProcessRecord>();
  #pendingStarts = new Map<string, PendingStart>();
  #leases = new Map<string, BlockingLeaseHandleV1>();
  #hostRevision = 0;
  #managedRevision = -1;
  #managedCanonical = "";
  readonly #managedGroups = new Map<string, ManagedProcessGroupV1>();
  readonly #managedListeners = new Set<() => void>();
  #startOrder = 0;
  #cursorSecret = randomBytes(32);
  #stripCollapsed = false;
  #stripPreferenceInitialized = false;
  #onDisposed?: (host: ProcessHost) => void;

  readonly executionAuthority?: string;

  constructor(options: ProcessHostOptions) {
    this.sessionScopeId = options.sessionScopeId;
    this.executionAuthority = options.executionAuthority;
    this.#clock = options.clock ?? REAL_CLOCK;
    this.#processControl = options.processControl ?? REAL_PROCESS_CONTROL;
    this.#launch = options.launch;
    this.#now = options.now ?? Date.now;
    this.#continuationRegistry = options.continuationRegistry ?? getContinuationRegistryV1();
    this.#captureNotificationTarget = options.captureNotificationTarget ?? (() => ({ strategy: "main", scopeToken: this.sessionScopeId }));
    this.#notificationBroker = options.notificationBroker ?? createNotificationBrokerV1({ sessionScopeId: this.sessionScopeId });
    this.#onDisposed = options.onDisposed;
  }

  get disposed(): boolean { return this.#disposed; }
  get cleanupError(): Error | undefined { return this.#cleanupError; }
  /** Set only after dispose() confirms every owned group and the Supervisor are gone. */
  get runtimeContainmentComplete(): boolean { return this.#runtimeContainmentComplete; }
  get containment(): HostContainment {
    if (!this.#disposed) return "active";
    if (this.#cleanupError) return "failed";
    return this.#runtimeContainmentComplete ? "contained" : "pending";
  }
  get pendingDeliveryCount(): number { return this.#pending.length; }
  get supervisorPid(): number | undefined { return this.#transport?.supervisorPid; }
  get hostRevision(): number { return this.#hostRevision; }
  get stripCollapsed(): boolean { return this.#stripCollapsed; }

  subscribeManagedState(listener: () => void): () => void {
    this.#managedListeners.add(listener);
    return () => { this.#managedListeners.delete(listener); };
  }

  managedSnapshot(): ProcessesManagedSnapshotV1 {
    const closed = this.#runtimeContainmentComplete;
    const processes: ProcessesManagedSnapshotV1["processes"][number][] = closed ? [] : [
      ...[...this.#pendingStarts.values()].map(({ id, input }) => ({
        id, state: "starting" as const, timeoutMs: input.timeoutMs ?? null, deadlineAt: null, group_key: null,
      })),
      ...[...this.#records.values()].filter(live).map(record => ({
        id: record.id, state: record.state as "starting" | "running" | "stopping",
        timeoutMs: record.timeoutMs ?? null, deadlineAt: record.deadlineAt ?? null,
        group_key: this.#managedGroupKey(record.id),
      })),
    ];
    const broker = this.#notificationBroker.exportState();
    // Project the existing managed broker/receipt handoff,
    // including pre-put work and recorded-but-not-consumed mailbox batches.
    // No transport ACK or absent carrier is treated as model consumption.
    const wakePending = broker.openWindows.some(window => window.lane === "turn")
      || broker.items.some(item => item.identity.kind === "terminal")
      || broker.prepared.some(window => window.lane === "turn" || window.batch.items.some(item => item.kind === "terminal"))
      || broker.overflows.some(overflow => [...overflow.open, ...overflow.prepared].some(window => window.lane === "turn" || (window.byKind.terminal ?? 0) > 0))
      || this.#mainTurnNotificationPending !== undefined
      || this.#mainTurnNotificationReceipt !== undefined
      || [...this.#mainTurnPendingBatches.values()].some(batch => batch.reason === "main-admission" || batch.items.some(item => item.kind === "terminal") || (batch.overflow?.byKind.terminal ?? 0) > 0);
    const supervisorKey = [...this.#managedGroups.values()].find(group => group.kind === "supervisor")?.key ?? null;
    const liveGroups = new Set([...this.#records.values()].filter(live).map(record => this.#managedGroupKey(record.id)));
    const state = {
      version: 1 as const, scope_id: this.sessionScopeId, host_generation: this.#hostIncarnationId,
      starting_count: processes.filter(record => record.state === "starting").length,
      running_count: processes.filter(record => record.state === "running").length,
      stopping_count: processes.filter(record => record.state === "stopping").length,
      processes, supervisor_key: supervisorKey, groups: [...this.#managedGroups.values()],
      release_groups: [...this.#managedGroups.values()].filter(group => closed || (group.kind === "command" && !liveGroups.has(group.key))).map(group => group.key),
      wakePending,
      cleanup: !this.#disposed ? "open" as const : this.#cleanupError ? "unknown" as const : closed ? "closed" as const : "closing" as const,
    };
    const canonical = JSON.stringify(state);
    if (canonical !== this.#managedCanonical) { this.#managedCanonical = canonical; this.#managedRevision += 1; }
    return { ...state, revision: this.#managedRevision };
  }

  #managedGroupKey(id: string): string { return `${this.#hostIncarnationId}:${id}`; }
  #managedStateChanged(): void { for (const listener of this.#managedListeners) listener(); }

  notificationSnapshot(): ProcessNotificationSnapshotV1 { return this.#notificationBroker.notificationSnapshot(); }
  notificationTarget(processId: string): NotificationTargetV1 | undefined {
    const record = this.#records.get(processId);
    return record ? { strategy: record.notificationStrategy, scopeToken: record.notificationOwnerToken } : undefined;
  }
  notificationRunAbortFence(): boolean { return this.#notificationRunAbortFence; }
  setNotificationRunAbortFence(): void { this.#notificationRunAbortFence = true; }
  clearNotificationRunAbortFence(): void { this.#notificationRunAbortFence = false; }
  beginNotificationUserEpoch(): boolean {
    this.#notificationRunAbortFence = false;
    const receipt = this.#mainTurnNotificationReceipt;
    if (!receipt) {
      this.#notificationTurnEpochSealed = false;
      this.#notificationBroker.demoteOpenTurnWindow({ strategy: "main", scopeToken: this.sessionScopeId });
      this.#mainTurnNotificationPending = undefined;
      return true;
    }
    if (receipt.persisted === false) return false;
    if (!receipt.wakeSettled) this.commitNotificationBatch(receipt.batch.batchId, "skipped");
    const current = this.#mainTurnNotificationReceipt;
    if (current && !current.wakeSettled) return false;
    this.#mainTurnNotificationReceipt = undefined;
    this.#notificationTurnEpochSealed = false;
    this.#notificationBroker.demoteOpenTurnWindow({ strategy: "main", scopeToken: this.sessionScopeId });
    this.#mainTurnNotificationPending = undefined;
    return true;
  }
  setNotificationTurnEpochSealed(sealed: boolean): void { this.#notificationTurnEpochSealed = sealed; }
  notificationTurnEpochSealed(): boolean { return this.#notificationTurnEpochSealed; }
  mainTurnNotificationPending(): MainTurnNotificationPendingV1 | undefined { return this.#mainTurnNotificationPending ? { ...this.#mainTurnNotificationPending } : undefined; }
  setMainTurnNotificationPending(pending: MainTurnNotificationPendingV1 | undefined): void { this.#mainTurnNotificationPending = pending ? { ...pending } : undefined; this.#managedStateChanged(); }
  mainTurnNotificationReceipt(): MainTurnNotificationReceiptV1 | undefined { return this.#mainTurnNotificationReceipt ? structuredClone(this.#mainTurnNotificationReceipt) : undefined; }
  setMainTurnNotificationReceipt(receipt: MainTurnNotificationReceiptV1 | undefined): void { this.#mainTurnNotificationReceipt = receipt ? structuredClone(receipt) : undefined; this.#managedStateChanged(); }
  /**
   * Main-turn batches whose durable `pending` status marker has not yet been
   * covered by a `turn-settled` marker. Restored from the session branch by the
   * turn coordinator on session start, so a replacement host still knows the
   * batch is unhandled; cleared only after a run that projected the batch
   * settled without abort or error.
   */
  mainTurnPendingBatches(): readonly ProcessNotificationBatchV1[] { return [...this.#mainTurnPendingBatches.values()].map((batch) => structuredClone(batch)); }
  setMainTurnPendingBatch(batch: ProcessNotificationBatchV1): void { this.#mainTurnPendingBatches.set(batch.batchId, structuredClone(batch)); this.#managedStateChanged(); }
  clearMainTurnPendingBatch(batchId: string): void { this.#mainTurnPendingBatches.delete(batchId); this.#notificationClaimReceipts.delete(batchId); this.#managedStateChanged(); }
  discardNotificationWindow(processId: string, lane: "context" | "turn"): void {
    const record = this.#records.get(processId);
    if (!record) throw processError("not-found", `process '${processId}' was not found`);
    this.#notificationBroker.discardOpenWindow({ strategy: record.notificationStrategy, scopeToken: record.notificationOwnerToken }, lane);
  }
  discardNotificationTurnWindow(processId: string): void { this.discardNotificationWindow(processId, "turn"); }
  demoteNotificationTurnToContext(processId: string): void {
    const record = this.#records.get(processId);
    if (!record) throw processError("not-found", `process '${processId}' was not found`);
    this.#notificationBroker.demoteOpenTurnWindow({ strategy: record.notificationStrategy, scopeToken: record.notificationOwnerToken });
  }
  discardMainNotificationTurnWindow(): void {
    this.#notificationBroker.discardOpenTurnWindow({ strategy: "main", scopeToken: this.sessionScopeId });
  }
  pendingNotificationEntries(): readonly TuiDeliveryRecordSnapshotV1[] { return this.#notificationBroker.pendingTuiDeliveries(); }
  prepareNotificationBatch(input: PrepareNotificationBatchInputV1): PreparedNotificationBatchV1 | undefined { return this.#notificationBroker.prepare(input); }
  prepareMinimalNotificationContinuation(input: import("../notifications/types.js").PrepareMinimalContinuationInputV1): PreparedNotificationBatchV1 { return this.#notificationBroker.prepareMinimalContinuation(input); }
  prepareNotificationContinuation(input: PrepareNotificationBatchInputV1): PreparedNotificationBatchV1 | undefined {
    if ([...this.#recordOnlyNotificationReceipts.values()].some((receipt) => receipt.target.strategy === input.target.strategy
      && receipt.target.scopeToken === input.target.scopeToken)) return undefined;
    try {
      const prepared = this.#notificationBroker.prepare(input);
      if (prepared) return prepared;
    } catch (error) {
      if (!(error instanceof NotificationBrokerErrorV1) || error.code !== "capacity") throw error;
    }
    const brokerState = this.#notificationBroker.exportState();
    const alreadyPrepared = new Set(brokerState.prepared.flatMap((entry) => entry.leaseWakeTransactionIds));
    const leaseWakeTransactionIds = brokerState.leaseWakeBindings
      .filter((binding) => binding.target.strategy === input.target.strategy
        && binding.target.scopeToken === input.target.scopeToken
        && !alreadyPrepared.has(binding.transactionId))
      .map((binding) => binding.transactionId);
    if (leaseWakeTransactionIds.length === 0) return undefined;
    return this.#notificationBroker.prepareMinimalContinuation({
      target: input.target, batchId: input.batchId, epochId: input.epochId,
      reason: "subagent-admission", createdAt: input.createdAt,
      leaseWakeTransactionIds,
    });
  }
  preparedNotificationBatch(batchId: string): PreparedNotificationBatchV1 | undefined { return this.#notificationBroker.getPrepared(batchId); }
  preparedNotificationBatches(): readonly PreparedNotificationBatchV1[] {
    return this.#notificationBroker.exportState().prepared.map((entry) => ({ batch: entry.batch, leaseWakeTransactionIds: entry.leaseWakeTransactionIds }));
  }
  preparedNotificationContinuations(): readonly Readonly<{ target: NotificationTargetV1; lane: "context" | "turn"; prepared: PreparedNotificationBatchV1 }>[] {
    return this.#notificationBroker.exportState().prepared
      .filter((entry) => entry.reason === "subagent-admission")
      .map((entry) => ({
        target: entry.target,
        lane: entry.lane,
        prepared: { batch: entry.batch, leaseWakeTransactionIds: entry.leaseWakeTransactionIds },
      }));
  }
  openNotificationContinuations(): readonly Readonly<{ target: NotificationTargetV1; lane: "context" | "turn" }>[] {
    const state = this.#notificationBroker.exportState();
    const entries = [
      ...state.openWindows.map(({ target, lane }) => ({ target, lane })),
      ...state.overflows.flatMap(({ target, open }) => open.map(({ lane }) => ({ target, lane }))),
    ].filter(({ target }) => target.strategy === "child");
    return [...new Map(entries.map((entry) => [`${entry.target.strategy}\0${entry.target.scopeToken}\0${entry.lane}`, entry])).values()];
  }
  ensureStandaloneNotificationWake(batchId: string): { readonly transactionId: string; readonly claimed: boolean } | undefined {
    const prepared = this.#notificationBroker.getPrepared(batchId);
    if (!prepared || prepared.batch.reason !== "main-admission" || prepared.batch.items.length === 0 || prepared.leaseWakeTransactionIds.length > 0) return undefined;
    const existing = this.#notificationBroker.exportState().standaloneWakeBindings.find((binding) => binding.batchId === batchId);
    if (existing) return { transactionId: existing.transactionId, claimed: existing.claimed };
    const offered = this.#continuationRegistry.offerWake({
      sessionId: this.sessionScopeId,
      ownerId: "pi-processes",
      logicalKey: `notification:${batchId}`,
      reason: "A background process notification is ready",
      outcome: "ready",
    });
    if (!offered.ok) throw processError("continuation-unavailable", offered.message);
    const snapshot = offered.value.snapshot();
    const transactionId = `standalone:${snapshot.offerId}:${snapshot.offerGeneration}`;
    this.#deferredNotificationWakes.set(transactionId, offered.value);
    try {
      this.#notificationBroker.bindStandaloneWake(batchId, { transactionId, claimed: offered.value.hasClaim() });
      return { transactionId, claimed: offered.value.hasClaim() };
    } catch (error) {
      offered.value.abort("notification standalone wake binding failed");
      this.#deferredNotificationWakes.delete(transactionId);
      throw error;
    }
  }
  notificationBatchClaimed(batchId: string): boolean {
    const prepared = this.#notificationBroker.getPrepared(batchId);
    if (!prepared) return false;
    const state = this.#notificationBroker.exportState();
    const standalone = state.standaloneWakeBindings.find((binding) => binding.batchId === batchId);
    if (standalone && (standalone.claimed || this.#deferredNotificationWakes.get(standalone.transactionId)?.hasClaim() === true)) return true;
    return prepared.leaseWakeTransactionIds.some((transactionId) => this.#deferredNotificationWakes.get(transactionId)?.hasClaim() === true);
  }
  notificationBatchClaimReceipt(batchId: string): WakeConsumerReceiptV1 | undefined { return this.#notificationClaimReceipts.get(batchId); }
  commitNotificationBatch(batchId: string, delivery: "delivered" | "skipped" = "delivered"): void {
    const prepared = this.#notificationBroker.getPrepared(batchId);
    const brokerState = this.#notificationBroker.exportState();
    if (prepared) {
      for (const transactionId of prepared.leaseWakeTransactionIds) {
        const binding = brokerState.leaseWakeBindings.find((entry) => entry.transactionId === transactionId);
        if (binding?.artifact.state !== "recorded") {
          throw processError("continuation-unavailable", `notification receipt for lease '${transactionId}' is not durable`);
        }
      }
    }
    const standalone = brokerState.standaloneWakeBindings.find((binding) => binding.batchId === batchId);
    const wakeIds = prepared
      ? [...prepared.leaseWakeTransactionIds, ...(standalone ? [standalone.transactionId] : [])]
      : [...(this.#notificationBatchWakeIds.get(batchId) ?? [])];
    if (prepared) {
      this.#notificationBatchWakeIds.set(batchId, wakeIds);
      this.#notificationBroker.commit(batchId);
    }
    for (const transactionId of wakeIds) {
      const receipt = this.#settleNotificationWake(transactionId, transactionId.startsWith("lease:") ? "delivered" : delivery);
      if (receipt) this.#notificationClaimReceipts.set(batchId, receipt);
    }
    this.#notificationBatchWakeIds.delete(batchId);
    if (this.#mainTurnNotificationReceipt?.batch.batchId === batchId) {
      this.#mainTurnNotificationReceipt = { ...this.#mainTurnNotificationReceipt, wakeSettled: true };
    }
  }
  rollbackNotificationBatch(batchId: string, reason: string): void {
    this.#notificationBroker.rollback(batchId, reason);
    this.#notificationBatchWakeIds.delete(batchId);
  }
  discardPreparedNotificationBatch(batchId: string, reason: string): void {
    this.#notificationBroker.discardPreparedWindow(batchId, reason);
    this.#notificationBatchWakeIds.delete(batchId);
  }
  notificationTuiRecorded(deliveryId: string): boolean {
    return this.#notificationBroker.exportState().tuiDeliveries.some((entry) => entry.deliveryId === deliveryId && entry.state === "recorded");
  }
  settleNotificationBatchRecordOnly(batchId: string): boolean {
    let receipt = this.#recordOnlyNotificationReceipts.get(batchId);
    if (!receipt) {
      const prepared = this.#notificationBroker.getPrepared(batchId);
      if (!prepared) return true;
      const preparedState = this.#notificationBroker.exportState().prepared.find((entry) => entry.batchId === batchId);
      if (!preparedState) return true;
      receipt = {
        batchId,
        target: preparedState.target,
        lane: preparedState.lane,
        wakeTransactionIds: [...prepared.leaseWakeTransactionIds],
        settledTransactionIds: new Set(),
      };
      this.#recordOnlyNotificationReceipts.set(batchId, receipt);
      this.#notificationBroker.discardPreparedWindow(batchId, "subagent-record-only");
      this.#notificationBatchWakeIds.delete(batchId);
    }
    const brokerState = this.#notificationBroker.exportState();
    for (const transactionId of receipt.wakeTransactionIds) {
      if (receipt.settledTransactionIds.has(transactionId)) continue;
      const binding = brokerState.leaseWakeBindings.find((entry) => entry.transactionId === transactionId);
      if (binding?.artifact.state !== "recorded") return false;
      this.#settleNotificationWake(transactionId, "delivered");
      receipt.settledTransactionIds.add(transactionId);
    }
    this.#recordOnlyNotificationReceipts.delete(batchId);
    return true;
  }

  initializeStripPreference(collapsed: boolean): void {
    if (this.#stripPreferenceInitialized) return;
    this.#stripPreferenceInitialized = true;
    this.#stripCollapsed = collapsed;
  }

  setStripCollapsed(collapsed: boolean): void {
    if (this.#stripCollapsed === collapsed) return;
    this.#stripPreferenceInitialized = true;
    this.#stripCollapsed = collapsed;
    this.#binding?.callbacks.requestRender?.();
  }

  toggleStripCollapsed(): void {
    this.setStripCollapsed(!this.#stripCollapsed);
  }

  records(): readonly ProcessSummary[] {
    return [...this.#records.values()].map((record) => summarizeProcess(record, this.#now()));
  }

  stripRecords(): readonly ProcessSummary[] {
    const cutoff = this.#now() - TERMINAL_STRIP_RETENTION_MS;
    return [...this.#records.values()]
      .filter((record) => live(record) || (record.endedAt !== undefined && Date.parse(record.endedAt) > cutoff))
      .map((record) => summarizeProcess(record, this.#now()));
  }

  summary(id: string): ProcessSummary | undefined {
    const record = this.#records.get(id);
    return record ? summarizeProcess(record, this.#now()) : undefined;
  }

  lifecycleAttention(event: SupervisorEvent): Attention | undefined {
    const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
    const record = id ? this.#records.get(id) : undefined;
    if (!record) return undefined;
    if (event.type === "watchMatch" || event.type === "matcherError") {
      const key = typeof event.payload.key === "string" ? event.payload.key : undefined;
      return key ? record.watches.get(key)?.attention : undefined;
    }
    if (event.type !== "terminal") return undefined;
    if (record.terminalWakeRequired) return "turn";
    if (record.state === "succeeded") return record.notify.onSuccess;
    if (record.state === "failed") return record.notify.onFailure;
    if (record.state === "stopped" || record.state === "killed") return record.notify.onKilled;
    if (record.state === "crashed") return record.notify.onCrash;
    return undefined;
  }

  /** Full script for trusted local UI; list/tool summaries stay preview-bounded. */
  command(id: string): string | undefined {
    return this.#records.get(id)?.command;
  }

  /** Supervisor-owned rolling segment paths, without starting a helper or reading logs. */
  logPath(id: string): string | undefined {
    return this.#records.has(id) && this.#transport?.root ? join(this.#transport.root, "records", `${id}.*.jsonl`) : undefined;
  }

  async ensureStarted(): Promise<void> {
    if (this.#disposed) throw this.#cleanupError ?? processError("supervisor-unavailable", "process host is disposed");
    if (this.#transport && !this.#transport.closed) return;
    if (!this.#launching) {
      this.#launching = this.#launch({
        onEvent: (event) => this.#onEvent(event),
        onChannelLost: (error) => this.#onChannelLost(error),
      }).then(async (transport) => {
        if (this.#disposed || transport.closed) {
          transport.close();
          try { await transport.waitForExit(CLEANUP_REQUEST_TIMEOUT_MS); }
          catch {
            try { transport.terminate("SIGKILL"); } catch {}
            try { await transport.waitForExit(EMERGENCY_SUPERVISOR_EXIT_MS); } catch {}
          }
          throw this.#cleanupError ?? processError("supervisor-unavailable", "supervisor channel closed during launch");
        }
        this.#transport = transport;
        const key = this.#managedGroupKey("supervisor");
        this.#managedGroups.set(key, { key, kind: "supervisor", pid: transport.supervisorPid, pgid: transport.supervisorPid, parent_pid: process.pid });
        this.#managedStateChanged();
        this.#launching = undefined;
        return transport;
      }, (error) => {
        this.#launching = undefined;
        throw error;
      });
    }
    await this.#launching;
  }

  bind(callbacks: RuntimeBindingCallbacks): ProcessBindingLease {
    if (this.#disposed) throw this.#cleanupError ?? processError("supervisor-unavailable", "process host is disposed");
    const generation = ++this.#bindingGeneration;
    this.#binding = { generation, ready: false, callbacks };
    this.#clearReclaimTimer();
    let retired = false;
    return {
      generation,
      markReady: async () => {
        if (retired || this.#binding?.generation !== generation) return;
        if (this.#disposed) throw this.#cleanupError ?? processError("supervisor-unavailable", "process host is disposed");
        // Empty bindings are ready without creating a helper. Rebind active or
        // in-flight runtimes immediately; first tool use still awaits the full handshake.
        if (this.#transport || this.#launching || this.#records.size > 0) await this.ensureStarted();
        if (this.#binding?.generation !== generation) return;
        this.#binding.ready = true;
        await this.#flush();
      },
      retire: async (reason) => {
        if (retired) return;
        retired = true;
        if (this.#binding?.generation !== generation) return;
        const report = this.#binding.callbacks.report;
        this.#binding = undefined;
        if (reason === "reload") {
          this.#reclaimTimer = this.#clock.setTimeout(() => {
            this.#reclaimTimer = undefined;
            void this.dispose("reclaim-timeout").catch(() => undefined);
          }, RECLAIM_WINDOW_MS);
          return;
        }
        await this.dispose(reason, report);
      },
    };
  }

  async request(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    if (!this.#transport || this.#transport.closed) throw processError("supervisor-unavailable", "supervisor transport is unavailable");
    return await this.#transport.request(type, payload, timeoutMs);
  }

  resolveTarget(target: string, options: { liveOnly?: boolean } = {}): ProcessRecord {
    const direct = this.#records.get(target);
    if (direct) {
      if (options.liveOnly && !live(direct)) throw processError("not-found", `live process '${target}' was not found`);
      return direct;
    }
    const named = [...this.#records.values()].filter((record) => record.name === target);
    const liveMatches = named.filter(live);
    if (liveMatches.length === 1) return liveMatches[0]!;
    if (liveMatches.length > 1) throw processError("conflict", `live process name '${target}' is ambiguous`);
    if (options.liveOnly) throw processError("not-found", `live process '${target}' was not found`);
    const terminalMatches = named.filter((record) => !live(record));
    if (terminalMatches.length === 1) return terminalMatches[0]!;
    if (terminalMatches.length > 1) throw processError("conflict", `terminal process name '${target}' is ambiguous; use a process id`);
    throw processError("not-found", `process '${target}' was not found`);
  }

  async start(input: Extract<ToolInput, { action: "start" }>, config: ProcessesConfig, defaultCwd: string): Promise<ProcessSummary> {
    const isolationCheck = assertProcessesExecutionIsolationCurrent(config);
    if (isolationCheck) await isolationCheck;
    if (this.executionAuthority !== undefined && this.executionAuthority !== processesExecutionAuthority(config)) {
      throw processError("execution-isolation", "Host execution authority drifted; start a fresh session");
    }
    if (this.#disposed) throw this.#cleanupError ?? processError("supervisor-unavailable", "process host is disposed");
    const currentLive = [...this.#records.values()].filter(live).length + this.#pendingStarts.size;
    if (currentLive >= config.limits.maxLiveProcesses) throw processError("capacity", `live process limit ${config.limits.maxLiveProcesses} reached`);
    const terminalCount = [...this.#records.values()].filter((record) => !live(record)).length;
    if (terminalCount >= config.limits.maxTerminalRecords) throw processError("capacity", `terminal record limit ${config.limits.maxTerminalRecords} reached; clear records first`);
    if ([...this.#records.values()].some((record) => live(record) && record.name === input.name) || [...this.#pendingStarts.values()].some((item) => item.input.name === input.name)) {
      throw processError("conflict", `live process name '${input.name}' already exists`);
    }
    const id = generateProcessId(this.#records, this.#pendingStarts);
    const cwd = input.cwd ?? defaultCwd;
    const notificationTarget = this.#captureNotificationTarget();
    const pending: PendingStart = { input, config, id, cwd, startOrder: ++this.#startOrder, notificationTarget, events: [] };
    this.#pendingStarts.set(id, pending);
    this.#managedStateChanged();
    try {
      await this.ensureStarted();
      await assertProcessesExecutionIsolationCurrent(config);
      if (this.executionAuthority !== undefined && this.executionAuthority !== processesExecutionAuthority(config)) {
        throw processError("execution-isolation", "Host execution authority drifted during Supervisor startup");
      }
      const response = await this.request("spawn", {
        operationId: randomUUID(),
        id,
        name: input.name,
        command: input.command,
        cwd,
        shell: config.execution.shell,
        stopGraceMs: config.execution.stopGraceMs,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        logLimits: {
          perProcessBytes: config.limits.perProcessLogBytes,
          sessionBytes: config.limits.sessionLogBytes,
          lineBytes: 65_536,
        },
        watches: input.watches.map(supervisorWatch),
      });
      const record: ProcessRecord = {
        id,
        name: input.name,
        kind: input.kind,
        command: input.command,
        cwd,
        startedAt: optionalString(response.startedAt, "spawn.startedAt") ?? new Date(this.#now()).toISOString(),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(optionalString(response.deadlineAt, "spawn.deadlineAt") ? { deadlineAt: response.deadlineAt as string } : {}),
        ...(config.managed?.terminalWake === "required" ? { terminalWakeRequired: true } : {}),
        state: "running",
        pid: safeInteger(response.pid, "spawn.pid", 1),
        pgid: safeInteger(response.pgid, "spawn.pgid", 1),
        stdinOpen: response.stdinOpen === true,
        logRevision: safeInteger(response.logRevision, "spawn.logRevision"),
        earliestSequence: 0,
        nextSequence: 0,
        droppedBytes: 0,
        droppedLines: 0,
        watchRevision: safeInteger(response.watchRevision, "spawn.watchRevision"),
        watches: new Map(input.watches.map((watch) => [watch.key, watch])),
        failedWatchKeys: new Set(),
        continuation: input.continuation,
        ...(input.continuation.mode === "wait" ? { continuationState: "blocking" as const } : {}),
        notify: resolveNotify(config, input.notify),
        configDefaults: config.notifications,
        startOrder: pending.startOrder,
        notificationStrategy: pending.notificationTarget.strategy,
        notificationOwnerToken: pending.notificationTarget.scopeToken,
      };
      this.#records.set(id, record);
      this.#pendingStarts.delete(id);
      const groupKey = this.#managedGroupKey(id);
      if (config.managed) this.#managedGroups.set(groupKey, { key: groupKey, kind: "command", pid: record.pid!, pgid: record.pgid!, parent_pid: this.#transport!.supervisorPid });
      this.#hostRevision += 1;
      if (input.continuation.mode === "wait") this.#acquireLease(record);
      for (const event of pending.events) this.#applyEvent(event);
      this.#managedStateChanged();
      this.#binding?.callbacks.requestRender?.();
      return summarizeProcess(record, this.#now());
    } catch (error) {
      this.#pendingStarts.delete(id);
      this.#managedStateChanged();
      throw error;
    }
  }

  list(input: Extract<ToolInput, { action: "list" }>): ProcessListResult {
    const states = input.states ? [...input.states].sort() : [];
    let offset = 0;
    if (input.cursor) {
      const decoded = this.#decodeListCursor(input.cursor);
      if (decoded.hostRevision !== this.#hostRevision) throw processError("stale-cursor", "process list changed; restart pagination");
      if (decoded.sort !== input.sort || JSON.stringify(decoded.states) !== JSON.stringify(states)) throw processError("invalid-cursor", "cursor does not match list filters");
      offset = decoded.offset;
    }
    let records = [...this.#records.values()];
    if (states.length > 0) records = records.filter((record) => states.includes(record.state));
    records.sort((a, b) => {
      if (input.sort === "started-asc") return a.startOrder - b.startOrder;
      if (input.sort === "name-asc") return a.name.localeCompare(b.name) || a.startOrder - b.startOrder;
      if (input.sort === "state") return a.state.localeCompare(b.state) || b.startOrder - a.startOrder;
      return b.startOrder - a.startOrder;
    });
    const page = records.slice(offset, offset + input.limit).map((record) => summarizeProcess(record, this.#now()));
    const nextOffset = offset + page.length;
    return {
      processes: page,
      ...(nextOffset < records.length ? { nextCursor: this.#encodeListCursor({ version: 1, hostRevision: this.#hostRevision, offset: nextOffset, states, sort: input.sort }) } : {}),
    };
  }

  async logs(input: Extract<ToolInput, { action: "logs" }>): Promise<ProcessLogsResult> {
    const record = this.resolveTarget(input.target);
    const response = await this.request("logPage", {
      id: record.id,
      stream: input.stream,
      tailLines: input.tailLines,
      ...(input.pattern ? { pattern: input.pattern, mode: input.mode } : {}),
    });
    const lines = Array.isArray(response.lines) ? response.lines.map((line, index) => {
      const item = resultObject(line, `logPage.lines[${index}]`);
      const stream = item.stream;
      if (stream !== "stdout" && stream !== "stderr") throw processError("protocol-invalid", `logPage.lines[${index}].stream is invalid`);
      if (typeof item.text !== "string") throw processError("protocol-invalid", `logPage.lines[${index}].text is invalid`);
      return { sequence: safeInteger(item.sequence, `logPage.lines[${index}].sequence`), stream: stream as "stdout" | "stderr", text: item.text };
    }) : [];
    record.logRevision = safeInteger(response.revision, "logPage.revision");
    record.earliestSequence = optionalInteger(response.earliestSequence, "logPage.earliestSequence") ?? record.earliestSequence;
    record.nextSequence = optionalInteger(response.nextSequence, "logPage.nextSequence") ?? record.nextSequence;
    record.droppedBytes = safeInteger(response.droppedBytes, "logPage.droppedBytes");
    record.droppedLines = safeInteger(response.droppedLines, "logPage.droppedLines");
    return {
      process: summarizeProcess(record, this.#now()),
      revision: record.logRevision,
      lines,
      ...(optionalString(response.nextCursor, "logPage.nextCursor") ? { nextCursor: response.nextCursor as string } : {}),
      truncated: response.truncated === true,
      droppedBytes: record.droppedBytes,
      droppedLines: record.droppedLines,
    };
  }

  async input(input: Extract<ToolInput, { action: "input" }>): Promise<ProcessInputResult> {
    const record = this.resolveTarget(input.target, { liveOnly: true });
    const data = input.data ? Buffer.from(input.data, "utf8") : Buffer.alloc(0);
    const response = await this.request("input", {
      operationId: randomUUID(),
      id: record.id,
      ...(data.length > 0 ? { dataBase64: data.toString("base64") } : {}),
      eof: input.eof,
    });
    record.stdinOpen = response.stdinOpen === true;
    this.#hostRevision += 1;
    return { process: summarizeProcess(record, this.#now()), bytesAccepted: safeInteger(response.bytesAccepted, "input.bytesAccepted"), stdinOpen: record.stdinOpen };
  }

  async configure(input: Extract<ToolInput, { action: "configure" }>): Promise<ProcessConfigureResult> {
    const record = this.resolveTarget(input.target, { liveOnly: true });
    const changed: string[] = [];
    if (input.name && input.name !== record.name) {
      if ([...this.#records.values()].some((item) => item !== record && live(item) && item.name === input.name)) throw processError("conflict", `live process name '${input.name}' already exists`);
      record.name = input.name;
      changed.push("name");
    }
    if (input.kind && input.kind !== record.kind) {
      record.kind = input.kind;
      changed.push("kind");
    }
    if (input.watchUpdate) {
      const next = applyWatchUpdate(record.watches, input.watchUpdate);
      if (input.continuation?.mode === "wait" && input.continuation.until.kind === "watch" && !next.has(input.continuation.until.key)) {
        throw processError("invalid-arguments", `continuation watch '${input.continuation.until.key}' is not configured`);
      }
      const response = await this.request("watchSet", {
        operationId: randomUUID(),
        id: record.id,
        expectedWatchRevision: record.watchRevision,
        definitions: [...next.values()].map(supervisorWatch),
      });
      record.watchRevision = safeInteger(response.watchRevision, "watchSet.watchRevision");
      record.watches = next;
      record.failedWatchKeys.clear();
      changed.push("watches");
    }
    if (input.continuation) {
      if (input.continuation.mode === "wait" && input.continuation.until.kind === "watch" && !record.watches.has(input.continuation.until.key)) {
        throw processError("invalid-arguments", `continuation watch '${input.continuation.until.key}' is not configured`);
      }
      this.#releaseLeaseWithoutWake(record, "cancelled");
      record.continuation = input.continuation;
      record.continuationState = input.continuation.mode === "wait" ? "blocking" : undefined;
      if (input.continuation.mode === "wait") this.#acquireLease(record);
      changed.push("continuation");
    }
    if (input.notify) {
      record.notify = updateNotify(record.notify, record.configDefaults, input.notify);
      changed.push("notify");
    }
    if (changed.length > 0) {
      this.#hostRevision += 1;
      this.#binding?.callbacks.requestRender?.();
    }
    return { process: summarizeProcess(record, this.#now()), changed };
  }

  async stop(input: Extract<ToolInput, { action: "stop" }>): Promise<ProcessStopResult> {
    const record = this.resolveTarget(input.target, { liveOnly: true });
    const previousState = record.state;
    record.state = "stopping";
    this.#hostRevision += 1;
    this.#managedStateChanged();
    this.#binding?.callbacks.requestRender?.();
    let response: Record<string, unknown>;
    try {
      response = await this.request("stop", { operationId: randomUUID(), id: record.id });
    } catch (error) {
      if (record.state === "stopping" && !record.endedAt) {
        record.state = previousState;
        this.#hostRevision += 1;
        this.#managedStateChanged();
        this.#binding?.callbacks.requestRender?.();
      }
      throw error;
    }
    return {
      process: summarizeProcess(record, this.#now()),
      signal: typeof response.signal === "string" ? response.signal : "SIGTERM",
      delivered: response.delivered === true,
    };
  }

  async clear(): Promise<ProcessClearResult> {
    const terminal = [...this.#records.values()].filter((record) => !live(record));
    if (terminal.length === 0) return { cleared: [], failed: [] };
    const response = await this.request("clearRecords", { operationId: randomUUID(), ids: terminal.map((record) => record.id) }, 30_000);
    const outcomes = resultObject(response.outcomes, "clearRecords.outcomes");
    const cleared: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const record of terminal) {
      const outcome = resultObject(outcomes[record.id], `clearRecords.outcomes.${record.id}`);
      if (outcome.cleared === true) {
        this.#records.delete(record.id);
        this.#clearStripExpiryTimer(record.id);
        try { this.#notificationBroker.clearProcess(record.id); }
        catch (error) { this.#binding?.callbacks.report?.(`Process notification clear failed: ${error instanceof Error ? error.message : String(error)}`); }
        cleared.push(record.id);
      } else {
        failed.push({ id: record.id, message: typeof outcome.message === "string" ? outcome.message : "record could not be cleared" });
      }
    }
    if (cleared.length > 0) {
      this.#hostRevision += 1;
      this.#binding?.callbacks.requestRender?.();
    }
    return { cleared, failed };
  }

  async dispose(reason: CleanupReason, report = this.#binding?.callbacks.report): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#runtimeContainmentComplete && !this.#registryOwnershipReleased) {
      try {
        this.#retireNotificationScope(reason);
        this.#cleanupError = undefined;
        this.#managedStateChanged();
        this.#releaseRegistryOwnership();
        return;
      } catch (error) {
        this.#cleanupError = error instanceof Error ? error : new Error(String(error));
        throw this.#cleanupError;
      }
    }
    let notificationRetirementError: Error | undefined;
    try { this.#retireNotificationScope(reason); }
    catch (error) { notificationRetirementError = error instanceof Error ? error : new Error(String(error)); }
    this.#prepareDisposal();
    const running = Promise.resolve().then(async () => {
      const transport = this.#transport ?? (this.#launching ? await this.#launching.catch(() => undefined) : undefined);
      try {
        if (transport) {
          try {
            if (reason === "protocol-failure") {
              throw processError("supervisor-unavailable", "supervisor channel lost before runtime containment");
            } else {
              if (transport.closed) throw processError("supervisor-unavailable", "supervisor channel closed before cleanup");
              const result = await transport.cleanup(reason, CLEANUP_REQUEST_TIMEOUT_MS);
              const unresolved = Number(result.unresolved ?? 0);
              if (unresolved > 0) throw processError("cleanup-incomplete", `${unresolved} process groups remain after cleanup`);
              await transport.waitForExit(5_000);
            }
          } catch (error) {
            const recovery = await this.#emergencyCleanup(transport);
            if (recovery.unresolvedGroups > 0 || !recovery.supervisorExited) {
              const original = error instanceof Error ? error.message : String(error);
              throw processError("cleanup-incomplete", `${original}; emergency cleanup left ${recovery.unresolvedGroups} process groups and supervisorExited=${recovery.supervisorExited}`);
            }
            report?.(`Process supervisor cleanup failed; runtime containment completed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.#runtimeContainmentComplete = true;
        if (notificationRetirementError) throw notificationRetirementError;
        this.#cleanupError = undefined;
        this.#managedStateChanged();
        this.#releaseRegistryOwnership();
      } finally {
        transport?.close();
      }
    });
    this.#disposePromise = running;
    try { await running; }
    catch (error) {
      this.#cleanupError = error instanceof Error ? error : new Error(String(error));
      this.#managedStateChanged();
      throw this.#cleanupError;
    } finally {
      if (this.#disposePromise === running && this.#runtimeContainmentComplete && !this.#registryOwnershipReleased) this.#disposePromise = undefined;
    }
  }

  async endScope(reason: "pi-exit" | "package-removed" | "scope-ended" = "scope-ended"): Promise<void> {
    await this.dispose(reason);
  }

  #acquireLease(record: ProcessRecord): void {
    const acquired = this.#continuationRegistry.acquireBlocking({
      sessionId: this.sessionScopeId,
      ownerId: "pi-processes",
      logicalKey: record.id,
      reason: `Process '${record.name}' is waiting for ${record.continuation.mode === "wait" && record.continuation.until.kind === "watch" ? `watch '${record.continuation.until.key}'` : "exit"}`,
    });
    if (!acquired.ok) throw processError("continuation-unavailable", acquired.message);
    this.#leases.set(record.id, acquired.value);
  }

  #releaseLeaseWithoutWake(record: ProcessRecord, outcome: "ready" | "failed" | "cancelled"): void {
    const lease = this.#leases.get(record.id);
    if (!lease) return;
    this.#leases.delete(record.id);
    lease.releaseWithoutWake({ outcome, reason: `Process '${record.name}' continuation changed` });
    record.continuationState = outcome === "failed" ? "failed" : "released";
  }

  #releaseLeaseAndWake(record: ProcessRecord, outcome: "ready" | "failed" | "cancelled", reason: string): WakeProducerTransactionV1 | undefined {
    const lease = this.#leases.get(record.id);
    if (!lease) return undefined;
    this.#leases.delete(record.id);
    const released = lease.releaseAndOfferWake({ outcome, reason });
    if (!released.ok) {
      record.continuationState = "failed";
      this.#binding?.callbacks.report?.(released.message);
      return undefined;
    }
    record.continuationState = outcome === "failed" ? "failed" : "satisfied";
    const snapshot = released.value.snapshot();
    this.#deferredNotificationWakes.set(`lease:${snapshot.offerId}:${snapshot.offerGeneration}`, released.value);
    return released.value;
  }

  #onEvent(event: SupervisorEvent): void {
    const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
    if (id && !this.#records.has(id)) {
      const pending = this.#pendingStarts.get(id);
      if (pending) {
        pending.events.push(cloneEvent(event));
        return;
      }
    }
    this.#applyEvent(event);
  }

  #applyEvent(event: SupervisorEvent): void {
    const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
    const record = id ? this.#records.get(id) : undefined;
    let wake: WakeProducerTransactionV1 | undefined;
    if (record && event.type === "terminal") {
      if (!live(record)) return;
      record.state = terminalState(event.payload);
      record.stdinOpen = false;
      record.endedAt = typeof event.payload.endedAt === "string" ? event.payload.endedAt : new Date(this.#now()).toISOString();
      record.exitCode = event.payload.exitCode === null ? null : optionalInteger(event.payload.exitCode, "terminal.exitCode");
      record.signal = event.payload.signal === null ? null : optionalString(event.payload.signal, "terminal.signal");
      if (event.payload.classification === "timeout") record.terminalErrorCode = "timeout";
      if (typeof event.payload.message === "string") record.terminalMessagePreview = event.payload.message;
      record.logRevision = optionalInteger(event.payload.logRevision, "terminal.logRevision") ?? record.logRevision;
      this.#hostRevision += 1;
      this.#scheduleStripExpiry(record);
      if (record.continuation.mode === "wait" && record.continuation.until.kind === "exit") {
        const outcome = record.state === "succeeded" || record.state === "stopped" ? "ready" : record.state === "killed" ? "cancelled" : "failed";
        wake = this.#releaseLeaseAndWake(record, outcome, `Process '${record.name}' ${record.state}`);
      } else if (record.continuation.mode === "wait") {
        this.#releaseLeaseWithoutWake(record, "cancelled");
      }
    } else if (record && event.type === "watchMatch") {
      const key = typeof event.payload.key === "string" ? event.payload.key : undefined;
      if (key && record.continuation.mode === "wait" && record.continuation.until.kind === "watch" && record.continuation.until.key === key) {
        wake = this.#releaseLeaseAndWake(record, "ready", `Process '${record.name}' matched watch '${key}'`);
      }
    } else if (record && event.type === "matcherError") {
      const key = typeof event.payload.key === "string" ? event.payload.key : undefined;
      if (key) record.failedWatchKeys.add(key);
      if (key && record.continuation.mode === "wait" && record.continuation.until.kind === "watch" && record.continuation.until.key === key) {
        wake = this.#releaseLeaseAndWake(record, "failed", `Process '${record.name}' watch '${key}' failed`);
      }
    } else if (record && event.type === "logCursorAdvanced") {
      record.logRevision = optionalInteger(event.payload.logRevision, "logCursorAdvanced.logRevision") ?? record.logRevision;
      record.nextSequence = optionalInteger(event.payload.nextSequence, "logCursorAdvanced.nextSequence") ?? record.nextSequence;
    }
    try {
      if (this.#binding?.callbacks.currentRunAborted?.() === true) this.#notificationRunAbortFence = true;
    } catch (error) {
      try { this.#binding?.callbacks.report?.(`Process abort probe failed: ${error instanceof Error ? error.message : String(error)}`); } catch {}
    }
    const notification = record ? this.#observeNotification(event, record, wake) : undefined;
    this.#enqueue(event, wake, notification);
    // Publish only after both terminal facts and their broker wake are visible.
    this.#managedStateChanged();
    if (record) this.#binding?.callbacks.requestRender?.();
  }

  #observeNotification(
    event: SupervisorEvent,
    record: ProcessRecord,
    wake?: WakeProducerTransactionV1,
  ): { readonly leaseTransactionId?: string; readonly tuiDisposition: "append" | "aggregate-only" | "none"; readonly tuiDeliveryId?: string; readonly modelOwned: boolean; readonly modelLane?: "context" | "turn" } | undefined {
    const attention = this.lifecycleAttention(event);
    if (!attention) return undefined;
    // Each explicitly armed wait owns one continuation wake. A previous batch
    // in this run must not demote that wake to context: Main drains it after
    // the current run settles. Unsolicited/repeat facts keep the epoch limit.
    const requiredTerminalWake = event.type === "terminal" && record.terminalWakeRequired;
    const modelLane = attention === "turn" && (this.#notificationRunAbortFence || (this.#notificationTurnEpochSealed && !wake && !requiredTerminalWake)) ? "context" : attention;
    const leaseTransactionId = wake ? `lease:${wake.snapshot().offerId}:${wake.snapshot().offerGeneration}` : undefined;
    const fallback = (): { readonly leaseTransactionId?: string; readonly tuiDisposition: "none"; readonly modelOwned: false } => ({
      ...(leaseTransactionId ? { leaseTransactionId } : {}),
      tuiDisposition: "none",
      modelOwned: false,
    });
    try {
      const projected = projectNotificationV1({
        sessionScopeId: this.sessionScopeId,
        hostIncarnationId: this.#hostIncarnationId,
        notificationSequence: this.#notificationSequence + 1,
        target: { strategy: record.notificationStrategy, scopeToken: record.notificationOwnerToken },
        event,
        process: summarizeProcess(record, this.#now()),
        attention: modelLane,
        observedAt: new Date(this.#now()).toISOString(),
        ...(event.type === "watchMatch" && typeof event.payload.key === "string"
          ? { watchRepeat: record.watches.get(event.payload.key)?.repeat === true }
          : {}),
        ...(this.#transport?.hostNonce && this.#transport.generation
          ? { supervisor: { nonce: this.#transport.hostNonce, generation: this.#transport.generation } }
          : {}),
        ...(leaseTransactionId ? { leaseWakeTransactionId: leaseTransactionId } : {}),
      });
      if (!projected) return fallback();
      const result = this.#notificationBroker.observe(projected.observe);
      this.#notificationSequence += 1;
      return {
        ...(leaseTransactionId ? { leaseTransactionId } : {}),
        tuiDisposition: result.tuiDisposition,
        ...(result.tuiDeliveryId ? { tuiDeliveryId: result.tuiDeliveryId } : {}),
        modelOwned: result.modelDisposition !== "ignored",
        ...(modelLane === "context" || modelLane === "turn" ? { modelLane } : {}),
      };
    } catch (error) {
      try {
        this.#binding?.callbacks.report?.(`Process notification shadow failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {}
      return fallback();
    }
  }

  #enqueue(
    event: SupervisorEvent,
    wake?: WakeProducerTransactionV1,
    notification?: { readonly leaseTransactionId?: string; readonly tuiDisposition: "append" | "aggregate-only" | "none"; readonly tuiDeliveryId?: string; readonly modelOwned: boolean; readonly modelLane?: "context" | "turn" },
  ): void {
    const item: PendingDelivery = {
      event: cloneEvent(event),
      ...(wake ? { wake } : {}),
      ...(notification?.leaseTransactionId ? { notificationLeaseTransactionId: notification.leaseTransactionId } : {}),
      tuiDisposition: notification?.tuiDisposition ?? "none",
      ...(notification?.tuiDeliveryId ? { tuiDeliveryId: notification.tuiDeliveryId } : {}),
      modelOwned: notification?.modelOwned === true,
      ...(notification?.modelLane ? { modelLane: notification.modelLane } : {}),
    };
    const key = queueKey(event);
    if (key) {
      const index = this.#pending.findIndex((candidate) => queueKey(candidate.event) === key);
      if (index >= 0) this.#pending[index] = item;
      else this.#pending.push(item);
    } else {
      this.#pending.push(item);
    }
    if (this.#pending.length > 512) {
      const replaceable = this.#pending.findIndex((candidate) => queueKey(candidate.event) !== undefined);
      if (replaceable >= 0) this.#pending.splice(replaceable, 1);
      else this.#binding?.callbacks.report?.("process delivery queue exceeded 512 unique events");
    }
    void this.#flush();
  }

  #onChannelLost(error: Error): void {
    // Disposal clears the binding, so keep the presentation callbacks alive here:
    // strip, /ps and the statusline snapshot must see the contained terminal records.
    const callbacks = this.#binding?.callbacks;
    const report = callbacks?.report;
    report?.(`Process supervisor channel lost: ${error.message}`);
    void this.dispose("protocol-failure", report).catch((cleanupError) => {
      report?.(`Process emergency cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }).finally(() => { callbacks?.requestRender?.(); });
  }

  #settleNotificationWake(transactionId: string, outcome: "delivered" | "skipped" | "delivery-failed"): WakeConsumerReceiptV1 | undefined {
    let receipt: WakeConsumerReceiptV1 | undefined;
    const wake = this.#deferredNotificationWakes.get(transactionId);
    if (wake && !this.#settledDeferredNotificationWakes.has(transactionId)) {
      const committed = wake.commit(outcome);
      if (!committed.ok) throw processError("continuation-unavailable", committed.message);
      receipt = committed.value.consumerReceipt;
      this.#settledDeferredNotificationWakes.add(transactionId);
    }
    const brokerState = this.#notificationBroker.exportState();
    if (transactionId.startsWith("lease:")) {
      if (brokerState.leaseWakeBindings.some((binding) => binding.transactionId === transactionId)) this.#notificationBroker.ackLeaseWakeTransaction(transactionId);
    } else if (brokerState.standaloneWakeBindings.some((binding) => binding.transactionId === transactionId)) {
      this.#notificationBroker.settleStandaloneWake(transactionId, outcome === "delivered" ? "delivered" : "skipped");
    }
    this.#deferredNotificationWakes.delete(transactionId);
    this.#settledDeferredNotificationWakes.delete(transactionId);
    return receipt;
  }

  #retireNotificationScope(reason: CleanupReason): void {
    for (const prepared of this.#notificationBroker.exportState().prepared) {
      this.#notificationBroker.rollback(prepared.batchId, `scope-${reason}`);
    }
    const existing = this.#notificationBroker.pendingRetirements().find((plan) => plan.kind === "scope");
    const plan = existing ?? this.#notificationBroker.beginDisposeScope(`notification-scope-${randomUUID()}`);
    const transactionIds = [...new Set([...plan.leaseWakeTransactionIds, ...plan.standaloneWakeTransactionIds, ...this.#deferredNotificationWakes.keys()])];
    for (const transactionId of transactionIds) {
      if (this.#settledDeferredNotificationWakes.has(transactionId)) continue;
      const wake = this.#deferredNotificationWakes.get(transactionId);
      if (!wake) throw processError("cleanup-incomplete", `notification wake '${transactionId}' has no live producer handle`);
      const aborted = wake.abort(`Process notification scope ended: ${reason}`);
      if (!aborted.ok) throw processError("cleanup-incomplete", aborted.message);
      this.#settledDeferredNotificationWakes.add(transactionId);
    }
    this.#notificationBroker.ackRetirement(plan.retirementId);
    for (const transactionId of transactionIds) {
      this.#deferredNotificationWakes.delete(transactionId);
      this.#settledDeferredNotificationWakes.delete(transactionId);
    }
    this.#notificationBatchWakeIds.clear();
    this.#recordOnlyNotificationReceipts.clear();
    this.#mainTurnNotificationPending = undefined;
    this.#mainTurnNotificationReceipt = undefined;
  }

  #releaseRegistryOwnership(): void {
    if (this.#registryOwnershipReleased) return;
    this.#registryOwnershipReleased = true;
    this.#onDisposed?.(this);
  }

  #prepareDisposal(): void {
    this.#disposed = true;
    this.#clearReclaimTimer();
    this.#clearStripExpiryTimers();
    this.#binding = undefined;
    for (const record of this.#records.values()) this.#releaseLeaseWithoutWake(record, "cancelled");
    this.#managedStateChanged();
  }

  async #emergencyCleanup(transport: HostTransport): Promise<{ unresolvedGroups: number; supervisorExited: boolean }> {
    if (this.#emergencyCleanupPromise) return this.#emergencyCleanupPromise;
    this.#emergencyCleanupPromise = (async () => {
      const groups = [...new Set(
        [...this.#records.values()]
          .filter(live)
          .map((record) => record.pgid)
          .filter((pgid): pgid is number => pgid !== undefined),
      )];
      for (const pgid of groups) {
        try { this.#processControl.signalGroup(pgid, "SIGTERM"); } catch {}
      }
      if (groups.length > 0) await this.#delay(EMERGENCY_TERM_GRACE_MS);
      for (const pgid of groups) {
        try {
          if (this.#processControl.groupAlive(pgid)) this.#processControl.signalGroup(pgid, "SIGKILL");
        } catch {}
      }
      if (groups.length > 0) await this.#delay(EMERGENCY_KILL_REAP_MS);
      transport.close();
      let supervisorExited = false;
      try {
        await transport.waitForExit(CLEANUP_REQUEST_TIMEOUT_MS);
        supervisorExited = true;
      } catch {
        try { transport.terminate("SIGKILL"); } catch {}
        try {
          await transport.waitForExit(EMERGENCY_SUPERVISOR_EXIT_MS);
          supervisorExited = true;
        } catch {}
      }
      const unresolved = new Set(groups.filter((pgid) => {
        try { return this.#processControl.groupAlive(pgid); } catch { return true; }
      }));
      this.#terminalizeContainedRecords(unresolved, supervisorExited);
      return { unresolvedGroups: unresolved.size, supervisorExited };
    })();
    return this.#emergencyCleanupPromise;
  }

  /**
   * A lost Supervisor can never send the terminal event for a group this Host
   * just contained, so the record must stop claiming it is live. The outcome is
   * `crashed` per ADR-0018: containment proves the group is gone but never the
   * command's own exit status, so exitCode/signal stay null and the terminal
   * carries the `runtime-contained` cause instead.
   */
  #terminalizeContainedRecords(unresolvedGroups: ReadonlySet<number>, supervisorExited: boolean): void {
    const endedAt = new Date(this.#now()).toISOString();
    let changed = false;
    for (const record of this.#records.values()) {
      if (!live(record)) continue;
      if (record.pgid === undefined ? !supervisorExited : unresolvedGroups.has(record.pgid)) continue;
      record.state = "crashed";
      record.stdinOpen = false;
      record.endedAt = endedAt;
      record.exitCode = null;
      record.signal = null;
      record.terminalErrorCode = RUNTIME_CONTAINED_ERROR_CODE;
      record.terminalMessagePreview = RUNTIME_CONTAINED_MESSAGE;
      changed = true;
    }
    if (changed) this.#hostRevision += 1;
  }

  async #delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => this.#clock.setTimeout(resolve, ms));
  }

  async #flushNotificationEntries(binding: RuntimeBindingState): Promise<void> {
    if (!binding.callbacks.appendNotificationEntry) return;
    let persisted = false;
    for (const pending of this.#notificationBroker.pendingLeaseArtifacts()) {
      const entry = pending.artifact.entry;
      if (!entry) continue;
      try {
        await binding.callbacks.appendNotificationEntry({
          deliveryId: pending.artifact.deliveryId,
          customType: entry.customType,
          data: JSON.parse(entry.dataJson) as unknown,
          dataSha256: entry.dataSha256,
        });
        this.#notificationBroker.ackLeaseArtifact(pending.transactionId);
        persisted = true;
      } catch (error) {
        binding.callbacks.report?.(`Process notification receipt append failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const pending of this.#notificationBroker.pendingTuiDeliveries()) {
      const entry = pending.entry;
      if (!entry) continue;
      try {
        await binding.callbacks.appendNotificationEntry({
          deliveryId: pending.deliveryId,
          customType: entry.customType,
          data: JSON.parse(entry.dataJson) as unknown,
          dataSha256: entry.dataSha256,
        });
        this.#notificationBroker.ackTuiDelivery(pending.deliveryId);
        persisted = true;
      } catch (error) {
        binding.callbacks.report?.(`Process TUI notification append failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let recordOnlyCompleted = false;
    for (const batchId of [...this.#recordOnlyNotificationReceipts.keys()]) {
      if (this.settleNotificationBatchRecordOnly(batchId)) recordOnlyCompleted = true;
    }
    if (persisted || recordOnlyCompleted) binding.callbacks.notificationEntriesPersisted?.();
  }

  async #flush(): Promise<void> {
    this.#flushRequested = true;
    if (this.#flushPromise) return this.#flushPromise;
    const running = (async () => {
      do {
        this.#flushRequested = false;
        const binding = this.#binding;
        if (!binding?.ready) return;
        await this.#flushNotificationEntries(binding);
        while (this.#pending.length > 0 && this.#binding?.generation === binding.generation && binding.ready) {
          const item = this.#pending.shift()!;
          try {
            await this.#flushNotificationEntries(binding);
            if (item.notificationLeaseTransactionId) {
              const leaseBinding = this.#notificationBroker.exportState().leaseWakeBindings.find((entry) => entry.transactionId === item.notificationLeaseTransactionId);
              if (!leaseBinding) {
                this.#settleNotificationWake(item.notificationLeaseTransactionId, "delivery-failed");
                binding.callbacks.report?.(`Process notification lease '${item.notificationLeaseTransactionId}' has no durable broker receipt; settled delivery-failed`);
                continue;
              }
              if (leaseBinding.artifact.state !== "recorded") {
                this.#pending.unshift(item);
                return;
              }
            }
            const delivery = await binding.callbacks.deliver(item.event, {
              tuiOwned: item.tuiDeliveryId !== undefined,
              tuiPersisted: item.tuiDeliveryId ? this.notificationTuiRecorded(item.tuiDeliveryId) : false,
              ...(item.tuiDeliveryId ? { tuiDeliveryId: item.tuiDeliveryId } : {}),
              modelOwned: item.modelOwned,
              ...(item.modelLane ? { modelLane: item.modelLane } : {}),
              ...(item.notificationLeaseTransactionId ? { wakeTransactionId: item.notificationLeaseTransactionId, wakeClaimed: item.wake?.hasClaim() === true } : {}),
            });
            if (delivery?.deferWake === true) continue;
            if (item.notificationLeaseTransactionId) {
              const leaseBound = this.#notificationBroker.exportState().leaseWakeBindings.some((entry) => entry.transactionId === item.notificationLeaseTransactionId);
              if (!leaseBound) {
                binding.callbacks.report?.(`Process notification lease '${item.notificationLeaseTransactionId}' has no durable broker receipt; settling delivery-failed`);
                this.#settleNotificationWake(item.notificationLeaseTransactionId, "delivery-failed");
                continue;
              }
              this.#settleNotificationWake(item.notificationLeaseTransactionId, "delivered");
            }
            else if (item.wake) {
              const committed = item.wake.commit("delivered");
              if (!committed.ok) throw processError("continuation-unavailable", committed.message);
            }
          } catch (error) {
            if (item.notificationLeaseTransactionId) {
              try {
                const leaseBinding = this.#notificationBroker.exportState().leaseWakeBindings.find((entry) => entry.transactionId === item.notificationLeaseTransactionId);
                this.#settleNotificationWake(item.notificationLeaseTransactionId, leaseBinding?.artifact.state === "recorded" ? "delivered" : "delivery-failed");
              } catch {}
            } else if (item.wake) {
              try { item.wake.commit("delivery-failed"); } catch {}
            }
            binding.callbacks.report?.(`Process event delivery failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } while (this.#flushRequested);
    })();
    this.#flushPromise = running;
    try { await running; }
    finally { if (this.#flushPromise === running) this.#flushPromise = undefined; }
  }

  #encodeListCursor(payload: ListCursorPayload): string {
    const body = cursorJson(payload);
    const signature = createHmac("sha256", this.#cursorSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  #decodeListCursor(cursor: string): ListCursorPayload {
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra !== undefined) throw processError("invalid-cursor", "list cursor is malformed");
    const expected = createHmac("sha256", this.#cursorSecret).update(body).digest("base64url");
    if (signature !== expected) throw processError("invalid-cursor", "list cursor signature is invalid");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch { throw processError("invalid-cursor", "list cursor payload is invalid"); }
    const input = resultObject(value, "list cursor");
    if (input.version !== 1 || !Array.isArray(input.states) || typeof input.sort !== "string") throw processError("invalid-cursor", "list cursor payload is invalid");
    return {
      version: 1,
      hostRevision: safeInteger(input.hostRevision, "list cursor hostRevision"),
      offset: safeInteger(input.offset, "list cursor offset"),
      states: input.states as ProcessState[],
      sort: input.sort as ListCursorPayload["sort"],
    };
  }

  #scheduleStripExpiry(record: ProcessRecord): void {
    this.#clearStripExpiryTimer(record.id);
    const endedAt = record.endedAt ? Date.parse(record.endedAt) : this.#now();
    const delay = Math.max(0, endedAt + TERMINAL_STRIP_RETENTION_MS - this.#now());
    this.#stripExpiryTimers.set(record.id, this.#clock.setTimeout(() => {
      this.#stripExpiryTimers.delete(record.id);
      this.#binding?.callbacks.requestRender?.();
    }, delay));
  }

  #clearStripExpiryTimer(id: string): void {
    const timer = this.#stripExpiryTimers.get(id);
    if (timer === undefined) return;
    this.#clock.clearTimeout(timer);
    this.#stripExpiryTimers.delete(id);
  }

  #clearStripExpiryTimers(): void {
    for (const timer of this.#stripExpiryTimers.values()) this.#clock.clearTimeout(timer);
    this.#stripExpiryTimers.clear();
  }

  #clearReclaimTimer(): void {
    if (this.#reclaimTimer === undefined) return;
    this.#clock.clearTimeout(this.#reclaimTimer);
    this.#reclaimTimer = undefined;
  }
}
