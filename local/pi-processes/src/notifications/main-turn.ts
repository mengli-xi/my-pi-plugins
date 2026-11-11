import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CurrentDecision, Mail, MailboxRunEnd, MailboxRunStart, RecordedNotice, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import { queryGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import type { WakeConsumerReceiptV1 } from "pi-runtime-contracts/continuation-v1";
import type { ProcessHost } from "../host/process-host.js";
import { PromptBoundaryCandidateV1, type PromptInputSourceV1 } from "./prompt-boundary.js";
import { canonicalProcessNotificationValueV1, isProcessNotificationBatchMessageV1, validProcessNotificationBatchCarrierV1 } from "./main-context.js";
import { PROCESS_NOTIFICATION_STATUS_TYPE, processNotificationStatusV1, proveProcessMailV1, scanLegacyProcessBatchesV1 } from "./mailbox-proof.js";
import { readProcessMailIntentsV1, type ProcessMailboxSourceV1 } from "./mailbox-source.js";
import type { ProcessNotificationBatchV1 } from "./types.js";
export { PROCESS_NOTIFICATION_STATUS_TYPE, PROCESS_NOTIFICATION_TRIGGER_TYPE } from "./mailbox-proof.js";
export type { ProcessNotificationStatusV1, ProcessNotificationStatusStateV1 } from "./mailbox-proof.js";
const PARKING_TYPE = "process-notification-parking-v1";

export function mainTurnRunFailedV1(messages: readonly unknown[], signalAborted: boolean): boolean {
  if (signalAborted) return true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string } | undefined;
    if (m?.role === "assistant") return m.stopReason === "aborted" || m.stopReason === "error";
  }
  return false;
}

type MainHost = Pick<ProcessHost, "disposed" | "prepareNotificationBatch" | "preparedNotificationBatch" | "preparedNotificationBatches" | "ensureStandaloneNotificationWake" | "notificationBatchClaimed" | "notificationBatchClaimReceipt" | "commitNotificationBatch" | "notificationRunAbortFence" | "setNotificationRunAbortFence" | "beginNotificationUserEpoch" | "setNotificationTurnEpochSealed" | "mainTurnNotificationPending" | "setMainTurnNotificationPending" | "mainTurnNotificationReceipt" | "setMainTurnNotificationReceipt" | "mainTurnPendingBatches" | "setMainTurnPendingBatch" | "clearMainTurnPendingBatch">;

/** Broker epochs and business settlement only. Mailbox owns all native transport. */
export class MainTurnNotificationCoordinatorV1 {
  readonly #host: MainHost;
  readonly #pi: ExtensionAPI;
  readonly #sessionScopeId: string;
  readonly #getContext: () => ExtensionContext | undefined;
  readonly #mailbox: Pick<ProcessMailboxSourceV1, "submit" | "ownsCurrentIntent">;
  readonly #report: (message: string) => void;
  readonly #nextId: () => string;
  readonly #now: () => number;
  readonly #candidate = new PromptBoundaryCandidateV1();
  readonly #accepted = new Set<string>();
  readonly #cancelled = new Set<string>();
  readonly #projected = new Set<string>();
  #active = false;
  #sessionManager?: ExtensionContext["sessionManager"];
  #failed = false;
  #revision = 0;
  #flushing?: Promise<void>;
  #parking = false;
  #closing = false;

  constructor(options: { sessionScopeId: string; host: MainHost; pi: ExtensionAPI; getContext(): ExtensionContext | undefined; mailbox: Pick<ProcessMailboxSourceV1, "submit" | "ownsCurrentIntent">; nextId?(): string; now?(): number; report?(message: string): void }) {
    this.#host = options.host; this.#pi = options.pi; this.#sessionScopeId = options.sessionScopeId;
    this.#getContext = options.getContext; this.#mailbox = options.mailbox;
    this.#nextId = options.nextId ?? randomUUID; this.#now = options.now ?? Date.now; this.#report = options.report ?? (() => {});
  }
  activate(ctx: ExtensionContext): void { this.#sessionManager ??= ctx.sessionManager; this.#active = true; }
  active(): boolean { return this.#active; }
  captureInput(input: { source: PromptInputSourceV1; streamingBehavior?: "steer" | "followUp" }): void { this.#candidate.capture(input); }

  async beforeRun(start: MailboxRunStart): Promise<void> {
    if (!this.#usable(start.ctx)) return;
    this.#projected.clear(); this.#failed = false;
    const boundary = this.#candidate.takeExternalBoundary();
    // A handled input can leave a candidate without starting a user run. A
    // later mailbox/custom control must not spend it or release the abort fence.
    if (!boundary || start.automatic || start.event.messageType !== "user" || !this.#host.beginNotificationUserEpoch()) return;
    // put may have failed or its response may have been lost. The source keeps
    // the original prepared identity until mailbox's recorded ACK commits it.
    const retry = this.#host.preparedNotificationBatches().find(p => p.batch.reason === "user-boundary");
    if (retry) { await this.#submit(retry.batch, "next-user", false); return; }
    const id = this.#nextId();
    const prepared = this.#host.prepareNotificationBatch({ target: { strategy: "main", scopeToken: this.#sessionScopeId }, lane: "context", batchId: `process-batch-${id}`, epochId: `user-${boundary.inputOrdinal}-${id}`, reason: "user-boundary", createdAt: new Date(this.#now()).toISOString() });
    if (prepared) await this.#submit(prepared.batch, "next-user", false);
  }
  afterRun(end: MailboxRunEnd): void {
    if (!this.#usable(end.ctx)) return;
    this.#failed = end.outcome !== "completed";
    if (end.outcome === "aborted") this.#host.setNotificationRunAbortFence();
    for (const member of end.members) this.#projected.add(member.mail.key.slice("batch:".length));
  }
  async accept(): Promise<{ readonly deferWake: true }> {
    this.#revision++;
    const receipt = this.#host.mainTurnNotificationReceipt();
    this.#host.setMainTurnNotificationPending(receipt ? { afterBatchId: receipt.batch.batchId } : {});
    const ctx = this.#getContext();
    if (ctx?.isIdle()) await this.turnEnded(ctx);
    return { deferWake: true };
  }
  async turnEnded(ctx: ExtensionContext): Promise<void> {
    if (!this.#usable(ctx) || this.#host.notificationRunAbortFence()) return;
    if (this.#flushing) return this.#flushing;
    const work = this.#flush(ctx);
    this.#flushing = work;
    try { await work; } finally { if (this.#flushing === work) this.#flushing = undefined; }
  }
  async #flush(ctx: ExtensionContext): Promise<void> {
    const receipt = this.#host.mainTurnNotificationReceipt();
    if (receipt) {
      if (!this.#accepted.has(receipt.batch.batchId)) await this.#submit(receipt.batch, "next-request", true);
      return;
    }
    const pending = this.#host.mainTurnNotificationPending();
    if (!pending) return;
    if (pending.afterBatchId && !scanLegacyProcessBatchesV1(ctx.sessionManager.getBranch(), this.#sessionScopeId).some(v => v.batch.batchId === pending.afterBatchId)) return;
    const revision = this.#revision;
    const id = this.#nextId();
    const prepared = this.#host.prepareNotificationBatch({ target: { strategy: "main", scopeToken: this.#sessionScopeId }, lane: "turn", batchId: `process-turn-${id}`, epochId: `background-${id}`, reason: "main-admission", createdAt: new Date(this.#now()).toISOString() });
    if (!prepared) { if (revision === this.#revision) this.#host.setMainTurnNotificationPending(undefined); return; }
    this.#host.ensureStandaloneNotificationWake(prepared.batch.batchId);
    this.#host.setMainTurnNotificationReceipt({ batch: prepared.batch, persisted: false, wakeSettled: false });
    this.#host.setNotificationTurnEpochSealed(true);
    await this.#submit(prepared.batch, "next-request", true);
    if (revision === this.#revision) this.#host.setMainTurnNotificationPending(undefined);
  }
  async #submit(batch: ProcessNotificationBatchV1, policy: "next-request" | "next-user", wake: boolean): Promise<void> {
    if (this.#closing) return;
    if (this.#parking) this.#pi.appendEntry(PARKING_TYPE, { version: 1, sessionScopeId: this.#sessionScopeId, batchId: batch.batchId });
    const result = await this.#mailbox.submit(batch, policy, wake);
    if (!this.#active) return;
    if (result.kind === "terminal" && result.evidence.outcome === "cancelled") { this.terminal(result.evidence); return; }
    this.#accepted.add(batch.batchId);
    if (this.#mailbox.ownsCurrentIntent(`batch:${batch.batchId}`)) this.#host.setMainTurnPendingBatch(batch);
  }
  checkCurrent(mail: Mail): CurrentDecision {
    const ctx = this.#getContext();
    if (!ctx || !this.#usable(ctx)) return { kind: "hold", reason: "Process source is not attached to this session" };
    if (this.#closing) return { kind: "cancel", reason: "Side Process scope is being destroyed" };
    const carrier = mail.messages[0];
    if (!carrier || !validProcessNotificationBatchCarrierV1(carrier, this.#sessionScopeId)) return { kind: "cancel", reason: "Invalid process batch" };
    const id = carrier.details.batchId;
    if (this.#cancelled.has(id)) return { kind: "cancel", reason: "Process batch was already cancelled" };
    const states = ctx.sessionManager.getBranch().map(e => processNotificationStatusV1(e, this.#sessionScopeId)).filter(Boolean);
    const marked = states.some(s => s?.batchId === id && s.state === "pending");
    const parked = ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === PARKING_TYPE && (e.data as { batchId?: string; sessionScopeId?: string })?.batchId === id && (e.data as { sessionScopeId?: string }).sessionScopeId === this.#sessionScopeId);
    let claim = this.#host.notificationBatchClaimReceipt(id);
    if (!claim) for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "process-notification-claim-v1") continue;
      const data = entry.data as { sessionScopeId?: string; batchId?: string; receipt?: WakeConsumerReceiptV1 };
      if (data.sessionScopeId === this.#sessionScopeId && data.batchId === id && data.receipt?.version === 1 && typeof data.receipt.continuationId === "string") claim = data.receipt;
    }
    const obligation = claim ? queryGoalContinuationObligationV1({ sessionId: this.#sessionScopeId, continuationId: claim.continuationId }) : "none";
    if (obligation === "unknown") return { kind: "hold", reason: "Goal continuation obligation is unknown; Process fallback wake is suspended" };
    // The immutable mail keeps its wake obligation, including Goal-claimed mail.
    // Before the canonical proof/marker ACK, only body projection is admitted.
    return { kind: "allow", project: true, wake: mail.wake && marked && !parked && !this.#host.notificationRunAbortFence() && !this.#host.notificationBatchClaimed(id) && obligation !== "owed" };
  }
  recorded(notice: RecordedNotice): void {
    const ctx = this.#getContext();
    if (!ctx || !this.#usable(ctx) || notice.scope.sessionId !== this.#sessionScopeId) throw new Error("Process ACK belongs to another binding");
    const mail = readProcessMailIntentsV1(ctx.sessionManager.getBranch(), this.#sessionScopeId).get(notice.key);
    if (!mail) throw new Error("Process source identity is unavailable for ACK");
    const proof = proveProcessMailV1(mail, ctx.sessionManager.getBranch(), this.#sessionScopeId);
    if (proof.kind !== "observed" || proof.entries.length !== mail.messages.length || canonicalProcessNotificationValueV1(proof.entries) !== canonicalProcessNotificationValueV1(notice.entries)) throw new Error("Process recorded proof mismatch");
    this.#ackBatch(ctx, mail);
  }
  #ackBatch(ctx: ExtensionContext, mail: Mail): void {
    const id = mail.key.slice("batch:".length);
    if (this.#cancelled.has(id)) { this.#host.clearMainTurnPendingBatch(id); return; }
    // A replay after terminal settlement must not reopen the legacy status.
    const settled = scanLegacyProcessBatchesV1(ctx.sessionManager.getBranch(), this.#sessionScopeId).some(e => e.batch.batchId === id && e.state === "turn-settled");
    if (!settled) this.#appendStatus(ctx, id, "pending");
    const receipt = this.#host.mainTurnNotificationReceipt();
    if (receipt?.batch.batchId === id) this.#host.setMainTurnNotificationReceipt({ ...receipt, persisted: true });
    if (settled) { this.#host.clearMainTurnPendingBatch(id); this.#accepted.delete(id); }
    else this.#host.setMainTurnPendingBatch(mail.messages[0]!.details as ProcessNotificationBatchV1);
    if (this.#host.preparedNotificationBatch(id)) this.#host.commitNotificationBatch(id);
    const claim = this.#host.notificationBatchClaimReceipt(id);
    if (claim && !ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "process-notification-claim-v1" && (e.data as { batchId?: string; sessionScopeId?: string }).batchId === id && (e.data as { sessionScopeId?: string }).sessionScopeId === this.#sessionScopeId)) this.#pi.appendEntry("process-notification-claim-v1", { version: 1, sessionScopeId: this.#sessionScopeId, batchId: id, receipt: claim });
  }
  reconcile(ctx: ExtensionContext): void {
    if (!this.#usable(ctx)) return;
    for (const mail of readProcessMailIntentsV1(ctx.sessionManager.getBranch(), this.#sessionScopeId).values()) {
      if (!this.#accepted.has(mail.key.slice("batch:".length))) continue;
      const proof = proveProcessMailV1(mail, ctx.sessionManager.getBranch(), this.#sessionScopeId);
      if (proof.kind === "observed" && proof.entries.length === mail.messages.length) this.#ackBatch(ctx, mail);
    }
  }
  terminal(evidence: TerminalEvidence): void {
    const ctx = this.#getContext();
    if (!ctx || !this.#ownsScope(ctx) || (evidence.outcome !== "cancelled" && this.#host.disposed) || evidence.scope.sessionId !== this.#sessionScopeId) throw new Error("Process terminal ACK belongs to another binding");
    if (evidence.outcome !== "cancelled") return;
    const id = evidence.key.slice("batch:".length);
    this.#cancelled.add(id);
    const entries = ctx.sessionManager.getEntries();
    if (!this.#cancellationFromEntries(entries, id)) this.#pi.appendEntry("process-notification-migration-v1", {
      version: 1, sessionScopeId: this.#sessionScopeId, batchId: id, classification: "cancelled", reason: evidence.reason,
    });
    // Durable cancellation replaces delivery. This settles the source's broker
    // obligation as skipped; it never writes a successful-run status marker.
    if (!this.#host.disposed && this.#host.preparedNotificationBatch(id)) this.#host.commitNotificationBatch(id, "skipped");
    this.#host.clearMainTurnPendingBatch(id);
    this.#accepted.delete(id);
    const successor = this.#host.mainTurnNotificationPending();
    if (successor?.afterBatchId === id) this.#host.setMainTurnNotificationPending(this.#host.disposed ? undefined : {});
    if (this.#host.mainTurnNotificationReceipt()?.batch.batchId === id) {
      this.#host.setMainTurnNotificationReceipt(undefined);
      this.#host.setNotificationTurnEpochSealed(false);
    }
  }
  async agentSettled(aborted = false): Promise<void> {
    const ctx = this.#getContext();
    if (!ctx || !this.#usable(ctx)) return;
    this.reconcile(ctx);
    if (aborted) { this.#failed = true; this.#host.setNotificationRunAbortFence(); }
    if (!this.#failed) {
      const branch = scanLegacyProcessBatchesV1(ctx.sessionManager.getBranch(), this.#sessionScopeId);
      for (const id of this.#projected) {
        if (this.#cancelled.has(id)) continue;
        if (!branch.some(v => v.batch.batchId === id)) continue;
        this.#appendStatus(ctx, id, "pending");
        this.#appendStatus(ctx, id, "turn-settled");
        this.#host.clearMainTurnPendingBatch(id);
        this.#accepted.delete(id);
      }
    }
    this.#projected.clear();
    const receipt = this.#host.mainTurnNotificationReceipt();
    if (receipt?.wakeSettled) { this.#host.setMainTurnNotificationReceipt(undefined); this.#host.setNotificationTurnEpochSealed(false); }
    await this.turnEnded(ctx);
  }
  #appendStatus(ctx: ExtensionContext, id: string, state: "pending" | "turn-settled"): void {
    if (ctx.sessionManager.getBranch().some(e => { const s = processNotificationStatusV1(e, this.#sessionScopeId); return s?.batchId === id && s.state === state; })) return;
    this.#pi.appendEntry(PROCESS_NOTIFICATION_STATUS_TYPE, { version: 1, sessionScopeId: this.#sessionScopeId, batchId: id, state });
  }
  filterContext(messages: readonly unknown[]): readonly unknown[] {
    // Observe the original business run settlement even when transport already
    // fulfilled in an earlier request. Never inject or resend a carrier here.
    const pending = new Set(this.pendingBatchIds());
    return messages.filter(m => {
      if (!m || typeof m !== "object" || (m as { customType?: string }).customType !== "process-notification-batch-v1") return true;
      if (!isProcessNotificationBatchMessageV1(m, this.#sessionScopeId)) return false;
      if (pending.has(m.details.batchId)) this.#projected.add(m.details.batchId);
      return true;
    });
  }
  async beforeTree(ctx: ExtensionContext, runActive = false): Promise<{ readonly cancel: true } | undefined> {
    if (!this.#usable(ctx)) return;
    if (runActive) return { cancel: true };
    for (const prepared of this.#host.preparedNotificationBatches()) if (prepared.batch.reason === "user-boundary" && !this.#accepted.has(prepared.batch.batchId)) await this.#submit(prepared.batch, "next-user", false);
    this.reconcile(ctx);
    if (this.#host.preparedNotificationBatches().some(p => p.batch.reason === "user-boundary")) {
      this.#report("Process context batch is waiting for its mailbox native proof before navigation");
      return { cancel: true };
    }
    const receipt = this.#host.mainTurnNotificationReceipt();
    if (receipt && !receipt.wakeSettled) {
      this.#report("Process batch is waiting for its mailbox native proof and pending marker before navigation");
      return { cancel: true };
    }
    if (receipt) { this.#host.setMainTurnNotificationReceipt(undefined); this.#host.setNotificationTurnEpochSealed(false); }
    // A late explicit wait is a distinct parked mail on the outgoing branch.
    this.#parking = true;
    try { await this.turnEnded(ctx); } finally { this.#parking = false; }
    this.reconcile(ctx);
    const parked = this.#host.mainTurnNotificationReceipt();
    if (parked && !parked.wakeSettled) return { cancel: true };
    if (parked) { this.#host.setMainTurnNotificationReceipt(undefined); this.#host.setNotificationTurnEpochSealed(false); }
  }
  rebranch(entries: readonly unknown[]): void {
    this.#projected.clear(); this.#failed = false; this.#candidate.reset();
    for (const batch of this.#host.mainTurnPendingBatches()) this.#host.clearMainTurnPendingBatch(batch.batchId);
    const receipt = this.#host.mainTurnNotificationReceipt();
    if (receipt?.wakeSettled && !scanLegacyProcessBatchesV1(entries, this.#sessionScopeId).some(v => v.batch.batchId === receipt.batch.batchId)) { this.#host.setMainTurnNotificationReceipt(undefined); this.#host.setNotificationTurnEpochSealed(false); }
    this.restoreFromBranch(entries);
  }
  restoreFromBranch(entries: readonly unknown[]): void {
    // Cancellation is source state for this stable key, including when a tree
    // move goes to a leaf before its cancellation ACK. Success still needs the
    // active branch's own run proof; only known cancellations use the whole tree.
    for (const raw of [...(this.#getContext()?.sessionManager.getEntries() ?? []), ...entries]) {
      const id = this.#cancellationFromEntries([raw]);
      if (id) this.#cancelled.add(id);
    }
    for (const id of this.#cancelled) { this.#accepted.delete(id); this.#host.clearMainTurnPendingBatch(id); }
    for (const entry of scanLegacyProcessBatchesV1(entries, this.#sessionScopeId)) if (entry.state !== "turn-settled" && !this.#cancelled.has(entry.batch.batchId)) this.#host.setMainTurnPendingBatch(entry.batch);
  }
  #cancellationFromEntries(entries: readonly unknown[], batchId?: string): string | undefined {
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry.type !== "custom" || entry.customType !== "process-notification-migration-v1" || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as Record<string, unknown>;
      if (data.version === 1 && data.sessionScopeId === this.#sessionScopeId && data.classification === "cancelled" && typeof data.reason === "string" && typeof data.batchId === "string" && data.batchId && (batchId === undefined || batchId === data.batchId)) return data.batchId;
    }
    return undefined;
  }
  async importLegacy(ctx: ExtensionContext, source: ProcessMailboxSourceV1): Promise<void> {
    const branch = [...ctx.sessionManager.getBranch()];
    this.restoreFromBranch(branch);
    const intents = readProcessMailIntentsV1(branch, this.#sessionScopeId);
    const legacy = scanLegacyProcessBatchesV1(branch, this.#sessionScopeId);
    const settled = new Set(legacy.filter(e => e.state === "turn-settled").map(e => `batch:${e.batch.batchId}`));
    const target = source.endpoint.target(ctx);
    for (const mail of intents.values()) {
      if (settled.has(mail.key)) continue;
      if (!source.ownsCurrentIntent(mail.key)) continue;
      const result = await source.endpoint.put(mail, target, { recovered: true });
      if (!this.#usable(ctx)) return;
      if (result.kind === "terminal" && result.evidence.outcome === "cancelled") { this.terminal(result.evidence); continue; }
      this.#accepted.add(mail.key.slice("batch:".length));
      this.#host.setMainTurnPendingBatch(mail.messages[0]!.details as ProcessNotificationBatchV1);
    }
    for (const entry of legacy) {
      if (this.#cancelled.has(entry.batch.batchId)) continue;
      if (intents.has(`batch:${entry.batch.batchId}`) && entry.state !== "turn-settled") continue;
      if (entry.batch.reason === "subagent-admission") {
        source.recordMigration(entry.batch.batchId, "visible-unknown", "Child batch requires surviving Task/grant authority");
        this.#report(`Process migration visible-unknown: child batch ${entry.batch.batchId} requires its Task grant owner`);
        continue;
      }
      if (entry.state === "turn-settled") {
        const markerIndex = branch.findIndex(e => { const status = processNotificationStatusV1(e, this.#sessionScopeId); return status?.batchId === entry.batch.batchId && status.state === "turn-settled"; });
        const carrierIndex = branch.findIndex(e => e.id === entry.entryId);
        const marker = branch[markerIndex];
        const assistant = branch.slice(carrierIndex + 1, markerIndex).reverse().find(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason !== "error" && e.message.stopReason !== "aborted");
        if (!marker || !assistant) { source.recordMigration(entry.batch.batchId, "visible-unknown", "Settled batch has no successful assistant proof"); this.#report(`Process migration visible-unknown: settled batch ${entry.batch.batchId} has no successful assistant proof`); continue; }
        const prepared = source.prepare(entry.batch, entry.batch.reason === "user-boundary" ? "next-user" : "next-request", entry.batch.reason === "main-admission", entry.entryId);
        await source.endpoint.importFulfilled(prepared.mail, { sourceReceiptEntryId: marker.id, assistantEntryId: assistant.id }, prepared.target);
        this.#host.clearMainTurnPendingBatch(entry.batch.batchId);
        source.recordMigration(entry.batch.batchId, "fulfilled", "Original successful run and turn-settled proof imported");
        continue;
      }
      // A pending status proves the old sender admitted wake. An orphan has no
      // surviving wait authority: keep it as context and expose the discrepancy.
      const wake = entry.state === "pending" && entry.batch.reason === "main-admission";
      const prepared = source.prepare(entry.batch, wake ? "next-request" : "next-user", wake, entry.entryId);
      const result = await source.endpoint.put(prepared.mail, prepared.target, { recovered: true });
      if (!this.#usable(ctx)) return;
      if (result.kind === "terminal" && result.evidence.outcome === "cancelled") { this.terminal(result.evidence); continue; }
      this.#accepted.add(entry.batch.batchId);
      this.#host.setMainTurnPendingBatch(entry.batch);
      source.recordMigration(entry.batch.batchId, entry.state === "orphan" ? "visible-unknown" : result.kind === "terminal" ? result.evidence.outcome : "accepted", "Original branch batch imported without changing its carrier");
      if (entry.state === "orphan") this.#report(`Process migration visible-unknown: orphan ${entry.batch.batchId} retained as context; completion/wait authority was not reconstructed`);
    }
    this.restoreFromBranch(ctx.sessionManager.getBranch());
  }
  pendingBatchIds(): readonly string[] { return this.#host.mainTurnPendingBatches().map(b => b.batchId).sort(); }
  async cancelPending(ctx: ExtensionContext, source: ProcessMailboxSourceV1): Promise<void> {
    // Execution containment retires the Host, not this conversation's durable source ownership.
    if (!this.#ownsScope(ctx)) throw new Error("Process scope cancellation belongs to a stale runtime");
    this.#closing = true;
    await source.cancelOwned(ctx, "Side scope destroyed");
  }
  dispose(): void { this.#active = false; this.#candidate.reset(); }
  #ownsScope(ctx: ExtensionContext): boolean { return this.#active && ctx.sessionManager === this.#sessionManager && ctx.sessionManager === this.#getContext()?.sessionManager && ctx.sessionManager.getSessionId() === this.#sessionScopeId; }
  #usable(ctx: ExtensionContext): boolean { return this.#ownsScope(ctx) && !this.#host.disposed; }
}
