import type { CurrentDecision, Mail, RecordedNotice, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import { readProcessMailIntentsV1, type ProcessMailboxSourceV1 } from "./mailbox-source.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotificationLaneV1, NotificationTargetV1, PreparedNotificationBatchV1 } from "./types.js";
import {
  isProcessNotificationBatchMessageV1,
} from "./main-context.js";

export interface ChildTurnHostV1 {
  prepareNotificationContinuation(input: {
    target: NotificationTargetV1;
    lane: NotificationLaneV1;
    batchId: string;
    epochId: string;
    reason: "subagent-admission";
    createdAt: string;
  }): PreparedNotificationBatchV1 | undefined;
  preparedNotificationBatch(batchId: string): PreparedNotificationBatchV1 | undefined;
  preparedNotificationContinuations(): readonly Readonly<{ target: NotificationTargetV1; lane: NotificationLaneV1; prepared: PreparedNotificationBatchV1 }>[];
  openNotificationContinuations(): readonly Readonly<{ target: NotificationTargetV1; lane: NotificationLaneV1 }>[];
  commitNotificationBatch(batchId: string, delivery?: "delivered" | "skipped"): void;
  settleNotificationBatchRecordOnly(batchId: string): boolean;
  discardNotificationWindow(processId: string, lane: NotificationLaneV1): void;
}

export interface ChildTurnAdmissionBridgeV1 {
  captureOwnerToken(): string;
  admitContinuation(input: { readonly admissionId: string; readonly ownerToken: string; readonly continuationSignal: boolean }): Promise<"trigger" | "record-only">;
}

interface PendingLane {
  readonly lane: NotificationLaneV1;
  processId?: string;
}

interface Receipt {
  readonly target: NotificationTargetV1;
  readonly lane: NotificationLaneV1;
  readonly processId?: string;
  readonly batch: PreparedNotificationBatchV1["batch"];
  readonly continuationSignal: boolean;
  state: "admitting" | "admission-held" | "handoff-pending" | "record-only-waiting" | "accepted";
}

interface TargetState {
  readonly target: NotificationTargetV1;
  current?: Receipt;
  readonly queued: Map<NotificationLaneV1, PendingLane>;
}

export class ChildTurnNotificationCoordinatorV1 {
  readonly #sessionScopeId: string;
  readonly #host: ChildTurnHostV1;
  readonly #mailbox: Pick<ProcessMailboxSourceV1, "prepare" | "endpoint">;
  readonly #getContext: () => ExtensionContext | undefined;
  readonly #getBridge: () => ChildTurnAdmissionBridgeV1 | undefined;
  readonly #now: () => number;
  readonly #nextId: () => string;
  readonly #report?: (message: string) => void;
  readonly #targets = new Map<string, TargetState>();
  readonly #closingOwners = new Set<string>();
  #generation = 1;
  #disposed = false;

  constructor(options: {
    sessionScopeId: string;
    host: ChildTurnHostV1;
    mailbox: Pick<ProcessMailboxSourceV1, "prepare" | "endpoint">;
    getContext(): ExtensionContext | undefined;
    getBridge(): ChildTurnAdmissionBridgeV1 | undefined;
    now?(): number;
    nextId?(): string;
    report?(message: string): void;
  }) {
    this.#sessionScopeId = options.sessionScopeId;
    this.#host = options.host;
    this.#mailbox = options.mailbox;
    this.#getContext = options.getContext;
    this.#getBridge = options.getBridge;
    this.#now = options.now ?? Date.now;
    this.#nextId = options.nextId ?? (() => crypto.randomUUID());
    this.#report = options.report;
  }

  accept(input: {
    target: NotificationTargetV1;
    processId: string;
    lane: NotificationLaneV1;
  }): void {
    if (this.#disposed) return;
    const key = this.#targetKey(input.target);
    let state = this.#targets.get(key);
    if (!state) {
      state = { target: input.target, queued: new Map() };
      this.#targets.set(key, state);
    }
    const queued = state.queued.get(input.lane);
    if (queued) {
      queued.processId = input.processId;
    } else {
      state.queued.set(input.lane, {
        lane: input.lane,
        processId: input.processId,
      });
    }
    this.#drain(key, state);
  }

  notificationEntriesPersisted(): void {
    if (this.#disposed) return;
    this.#retryPendingHandoffs();
    for (const [key, state] of this.#targets) {
      if (state.current?.state === "record-only-waiting") this.#recordOnly(key, state, state.current);
    }
    this.recoverPrepared();
  }

  recoverPrepared(): void {
    if (this.#disposed) return;
    this.#retryPendingHandoffs();
    const prepared = this.#host.preparedNotificationContinuations();
    for (const recovered of prepared) {
      const key = this.#targetKey(recovered.target);
      let state = this.#targets.get(key);
      if (!state) {
        state = { target: recovered.target, queued: new Map() };
        this.#targets.set(key, state);
      }
      if (state.current) continue;
      this.#beginAdmission(key, state, recovered.prepared, recovered.lane);
    }
    for (const open of this.#host.openNotificationContinuations()) {
      const key = this.#targetKey(open.target);
      let state = this.#targets.get(key);
      if (!state) {
        state = { target: open.target, queued: new Map() };
        this.#targets.set(key, state);
      }
      if (state.current || state.queued.has(open.lane)) continue;
      state.queued.set(open.lane, { lane: open.lane });
      this.#drain(key, state);
    }
  }

  retryPendingTriggers(): void {
    if (!this.#disposed) this.#retryPendingHandoffs();
  }

  filterContext(messages: readonly unknown[], branchEntries: readonly unknown[]): readonly unknown[] {
    const filtered = messages.filter((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message) || (message as { customType?: unknown }).customType !== "process-notification-batch-v1") return true;
      return isProcessNotificationBatchMessageV1(message, this.#sessionScopeId);
    });
    return filtered;
  }

  async checkCurrent(mail: Mail): Promise<CurrentDecision> {
    const intent = this.#intent(mail.key);
    if (!intent) return { kind: "hold", reason: "Child Process owner identity is unavailable" };
    if (this.#closingOwners.has(intent.ownerToken)) return { kind: "cancel", reason: "Child Task is being finalized" };
    const bridge = this.#getBridge();
    if (!bridge) return { kind: "hold", reason: "Child Process admission owner is unavailable" };
    let token: string | undefined;
    try { token = bridge.captureOwnerToken(); } catch { /* Ask the admission owner for an explicit final/record-only decision. */ }
    if (token !== undefined && token !== intent.ownerToken) return { kind: "cancel", reason: "Child Process Task/generation changed" };
    const generation = this.#generation;
    const admission = await bridge.admitContinuation({ admissionId: mail.key.slice("batch:".length), ownerToken: intent.ownerToken, continuationSignal: intent.continuationSignal });
    if (this.#disposed || generation !== this.#generation) return { kind: "hold", reason: "Child Process binding was retired" };
    if (admission !== "trigger") return { kind: "cancel", reason: "Child execution grant was revoked or Task finalized" };
    // Recheck identity after asynchronous grant validation as well.
    try { if (bridge.captureOwnerToken() !== intent.ownerToken) return { kind: "cancel", reason: "Child Task changed during admission" }; }
    catch { return { kind: "hold", reason: "Child Task detached during admission" }; }
    return { kind: "allow", project: true, wake: true };
  }

  recorded(notice: RecordedNotice): void {
    const id = notice.key.slice("batch:".length);
    if (this.#disposed) throw new Error("Child Process binding was retired");
    if (this.#host.preparedNotificationBatch(id)) this.#host.commitNotificationBatch(id, "delivered");
    for (const [key, state] of this.#targets) if (state.current?.batch.batchId === id) this.#finish(key, state, state.current);
  }
  terminal(evidence: TerminalEvidence): void {
    const id = evidence.key.slice("batch:".length);
    if (evidence.outcome === "cancelled" && this.#host.preparedNotificationBatch(id) && !this.#host.settleNotificationBatchRecordOnly(id)) throw new Error("Child Process cancellation is waiting for its durable TUI receipt");
    for (const [key, state] of this.#targets) if (state.current?.batch.batchId === id) this.#finish(key, state, state.current);
  }
  async cancelPending(ctx: ExtensionContext, source: ProcessMailboxSourceV1): Promise<void> {
    if (this.#disposed || ctx.sessionManager !== this.#getContext()?.sessionManager) throw new Error("Child Process cancellation belongs to a stale scope");
    const ownerToken = this.#getBridge()?.captureOwnerToken();
    if (!ownerToken) throw new Error("Cancel Process mail before revoking the child Task owner token");
    this.#closingOwners.add(ownerToken);
    await source.cancelOwned(ctx, "Child Task finalized", ownerToken);
    for (const [key, state] of this.#targets) if (state.target.scopeToken === ownerToken && state.current) this.#recordOnly(key, state, state.current);
  }
  #intent(key: string): { ownerToken: string; continuationSignal: boolean } | undefined {
    for (const state of this.#targets.values()) if (state.current && `batch:${state.current.batch.batchId}` === key) return { ownerToken: state.current.target.scopeToken, continuationSignal: state.current.continuationSignal };
    const branch = this.#getContext()?.sessionManager.getBranch() ?? [];
    if (!readProcessMailIntentsV1(branch, this.#sessionScopeId).has(key)) return undefined;
    for (const entry of branch) if (entry.type === "custom" && entry.customType === "process-notification-intent-v1") {
      const intent = entry.data as { sessionScopeId?: string; mail?: { key?: string }; child?: { ownerToken: string; continuationSignal: boolean } };
      if (intent?.sessionScopeId === this.#sessionScopeId && intent.mail?.key === key) return intent.child;
    }
    return undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#targets.clear();
  }

  #drain(key: string, state: TargetState): void {
    if (state.current) return;
    const next = state.queued.values().next().value as PendingLane | undefined;
    if (!next) { this.#targets.delete(key); return; }
    state.queued.delete(next.lane);
    let prepared: PreparedNotificationBatchV1 | undefined;
    try {
      prepared = this.#host.prepareNotificationContinuation({
        target: state.target,
        lane: next.lane,
        batchId: `batch-${this.#nextId()}`,
        epochId: `subagent-${this.#nextId()}`,
        reason: "subagent-admission",
        createdAt: new Date(this.#now()).toISOString(),
      });
    } catch (error) {
      this.#report?.(`Subagent Process notification prepare failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!prepared) {
      if (next.processId) {
        try { this.#host.discardNotificationWindow(next.processId, next.lane); }
        catch (error) { this.#report?.(`Subagent Process record-only discard failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      this.#drain(key, state);
      return;
    }
    this.#beginAdmission(key, state, prepared, next.lane, next.processId);
  }

  #beginAdmission(key: string, state: TargetState, prepared: PreparedNotificationBatchV1, lane: NotificationLaneV1, processId?: string): void {
    const receipt: Receipt = {
      target: state.target,
      lane,
      ...(processId ? { processId } : {}),
      batch: prepared.batch,
      continuationSignal: prepared.leaseWakeTransactionIds.length > 0,
      state: "admitting",
    };
    state.current = receipt;
    this.#requestAdmission(key, state, receipt);
  }

  #requestAdmission(key: string, state: TargetState, receipt: Receipt): void {
    if (this.#closingOwners.has(receipt.target.scopeToken)) { this.#recordOnly(key, state, receipt); return; }
    const generation = this.#generation;
    const ctx = this.#getContext();
    if (!ctx) return;
    let prepared: ReturnType<ProcessMailboxSourceV1["prepare"]>;
    try { prepared = this.#mailbox.prepare(receipt.batch, "next-request", true, undefined, { ownerToken: receipt.target.scopeToken, continuationSignal: receipt.continuationSignal }); }
    catch (error) { receipt.state = "admission-held"; this.#report?.(`Subagent Process origin held: ${String(error)}`); return; }
    const bridge = this.#getBridge();
    if (!bridge) {
      if (receipt.state !== "admission-held") this.#report?.(`Subagent Process admission held: bridge unavailable for batch '${receipt.batch.batchId}'`);
      receipt.state = "admission-held";
      return;
    }
    receipt.state = "admitting";
    void bridge.admitContinuation({ admissionId: receipt.batch.batchId, ownerToken: state.target.scopeToken, continuationSignal: receipt.continuationSignal }).then(async (admission) => {
      if (this.#disposed || this.#generation !== generation || state.current !== receipt) return;
      if (this.#closingOwners.has(receipt.target.scopeToken)) { this.#recordOnly(key, state, receipt); return; }
      if (admission !== "trigger") { this.#recordOnly(key, state, receipt); return; }
      try {
        if (this.#getContext() !== ctx) return;
        const result = await this.#mailbox.endpoint.put(prepared.mail, prepared.target);
        if (this.#disposed || this.#generation !== generation || state.current !== receipt) return;
        receipt.state = "accepted";
        if (result.kind === "terminal") this.terminal(result.evidence);
      } catch (error) {
        receipt.state = "handoff-pending";
        this.#report?.(`Subagent Process trigger send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch((error) => {
      if (this.#disposed || this.#generation !== generation || state.current !== receipt) return;
      this.#report?.(`Subagent Process admission failed: ${error instanceof Error ? error.message : String(error)}`);
      receipt.state = "admission-held";
    });
  }

  #retryPendingHandoffs(): void {
    for (const [key, state] of this.#targets) {
      const receipt = state.current;
      if (receipt?.state === "handoff-pending" || receipt?.state === "admission-held") this.#requestAdmission(key, state, receipt);
    }
  }

  #recordOnly(key: string, state: TargetState, receipt: Receipt): void {
    if (state.current !== receipt) return;
    try {
      if (!this.#host.settleNotificationBatchRecordOnly(receipt.batch.batchId)) {
        receipt.state = "record-only-waiting";
        return;
      }
      this.#finish(key, state, receipt);
    } catch (error) {
      this.#report?.(`Subagent Process record-only settlement failed: ${error instanceof Error ? error.message : String(error)}`);
      receipt.state = "record-only-waiting";
    }
  }

  #finish(key: string, state: TargetState, receipt: Receipt): void {
    if (state.current !== receipt) return;
    state.current = undefined;
    this.#drain(key, state);
  }

  #targetKey(target: NotificationTargetV1): string { return `${target.strategy}\0${target.scopeToken}`; }
}
