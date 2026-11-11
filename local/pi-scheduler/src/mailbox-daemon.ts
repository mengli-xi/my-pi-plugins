/** Source-only daemon transactions. No Pi API, sends, model calls or A-private IO. */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { MailboxInjectionRequest, SchedulerResponse } from "./protocol.ts";
import type { OccupancyRegistry } from "./occupancy.ts";
import { assertInjectionReceiptMatchesMarker } from "./mailbox-identity.ts";
import { injectionMail } from "./mailbox-adapter.ts";
import { legacyInjectionIdentity } from "./store.ts";
import { validateTask } from "./create-task.ts";
import type { InjectionMarker, InjectionTerminalReceipt, SchedulerStore } from "./store.ts";
import type { RunRecord, Task } from "./task.ts";

export class SchedulerMailboxDaemon {
  private readonly store: SchedulerStore;
  private readonly occupancy: OccupancyRegistry;
  private readonly now: () => number;
  private readonly onFailure?: (task: Task, record: RunRecord) => void;

  constructor(options: { store: SchedulerStore; occupancy: OccupancyRegistry; now: () => number;
      onFailure?: (task: Task, record: RunRecord) => void }) {
    this.store = options.store;
    this.occupancy = options.occupancy;
    this.now = options.now;
    this.onFailure = options.onFailure;
  }

  apply(request: MailboxInjectionRequest): SchedulerResponse {
    if (request.type === "injection.offers") {
      const checked = this.occupancy.checkHolder(request);
      if (!checked.ok) return { ok: false, error: "not unique live session holder", holderRejection: checked.reason };
      const { holder } = checked;
      const offers = [];
      const unknown = [];
      for (let marker of this.store.listInjections()) {
        if (marker.sessionId !== request.sessionId || (marker.phase === "settled" && marker.terminalOutcome === "failure")) continue;
        if (this.reconcile(marker)) continue;
        // Do not steal an append lease from a still-current legacy writer.
        if (!marker.mailbox && marker.phase === "leased" && marker.leaseExpiresAt! > this.now() &&
            marker.holderPid === holder.pid && marker.holderToken === holder.holderToken) {
          unknown.push({ injectionId: marker.injectionId, reason: "legacy append lease still active" });
          continue;
        }
        const proofs = request.nativeProofs.filter((n) => n.injectionId === marker.injectionId);
        const native = proofs[0];
        const message = injectionMail({ ...marker, anchorEntryId: null,
          contentDigest: createHash("sha256").update(marker.prompt).digest("hex") }).messages[0];
        const verified = proofs.length === 1 && !!native?.entryId && isDeepStrictEqual(native.message, message) &&
          (!marker.mailbox || (native.anchorEntryId === marker.mailbox.anchorEntryId &&
            (!marker.mailbox.entryId || native.entryId === marker.mailbox.entryId)));
        // Uncertain old append facts never acquire origin from the current leaf.
        if ((!marker.mailbox || marker.mailbox.legacy) &&
            ((proofs.length > 0 && !verified) || marker.phase !== "pending" || marker.mailbox?.legacy)) {
          if (!verified) {
            unknown.push({ injectionId: marker.injectionId, reason: "original native carrier/scope unavailable or conflicting" });
            continue;
          }
        }
        if (!marker.mailbox) {
          marker = { ...marker, mailbox: { legacy: verified, anchorEntryId: verified ? native!.anchorEntryId : request.anchorEntryId,
            ...(verified ? { entryId: native!.entryId } : {}) } };
          // Pending is the only positive no-append state. Its reservation is
          // durable before reply; legacy phase/proof category remains intact.
          if (!verified) marker.phase = "append-uncertain";
          this.store.putInjection(marker);
        }
        offers.push({ injectionId: marker.injectionId, taskId: marker.taskId, title: marker.title,
          prompt: marker.prompt, contentDigest: createHash("sha256").update(marker.prompt).digest("hex"),
          scheduledTime: marker.scheduledTime, staleAt: marker.staleAt,
          anchorEntryId: marker.mailbox!.anchorEntryId, legacy: marker.mailbox!.legacy,
          recovered: !!marker.mailbox!.legacy || !marker.createdForHolder ||
            marker.createdForHolder.pid !== holder.pid || marker.createdForHolder.holderToken !== holder.holderToken ||
            marker.createdForHolder.bindingGen !== holder.bindingGen });
      }
      return { ok: true, type: "injection-offers", offers, unknown };
    }
    if (request.type === "injection.terminal") return this.terminal(request);
    const marker = this.store.getInjection(request.injectionId);
    if (marker && marker.sessionId !== request.sessionId) return { ok: false, error: "source-scope-conflict" };
    if (!marker) {
      if (request.type === "injection.current") {
        const legacy = this.store.getLegacyInjectionReceipt(request.injectionId);
        if (legacy ? legacyInjectionIdentity(legacy).scope.sessionId === request.sessionId : this.legacyDelivered(request.injectionId, request.sessionId)) {
          return { ok: true, type: "injection-current", marker: null, now: this.now(), legacyDelivered: true };
        }
      }
      // Legacy delivered was an append receipt. Only A's proven import can
      // produce these ACK callbacks; it never creates another execution record.
      const legacy = this.store.getLegacyInjectionReceipt(request.injectionId);
      if (request.type === "injection.handoff") {
        const notice = { producer: "pi-scheduler" as const, key: `injection:${request.injectionId}`,
          scope: { sessionId: request.sessionId, anchorEntryId: request.anchorEntryId }, recordedToken: request.recordedToken,
          entries: [{ messageIndex: 0, entryId: request.entryId }] };
        if (legacy) {
          if (this.store.getInjectionReceipt(request.injectionId)) throw new Error("receipt-marker-conflict: duplicate terminal identity; unknown");
          const identity = legacyInjectionIdentity(legacy);
          if (identity.scope.sessionId !== request.sessionId || identity.scope.anchorEntryId !== request.anchorEntryId ||
              legacy.evidence && legacy.evidence.nativeEntryIds[0] !== request.entryId ||
              legacy.recorded && !isDeepStrictEqual(legacy.recorded, notice) ||
              legacy.recordedToken && legacy.recordedToken !== request.recordedToken) return { ok: false, error: "legacy-handoff-conflict" };
          if (!legacy.recorded) this.store.putLegacyInjectionReceipt({ ...legacy, recorded: notice });
          return { ok: true, type: "ack" };
        }
        if (this.legacyDelivered(request.injectionId, request.sessionId)) {
          this.store.putLegacyInjectionReceipt({ version: 1, legacy: true, recorded: notice });
          return { ok: true, type: "ack" };
        }
      }
      const receipt = this.store.getInjectionReceipt(request.injectionId);
      if (request.type === "injection.handoff" && receipt?.marker.sessionId === request.sessionId && receipt.marker.mailbox?.anchorEntryId === request.anchorEntryId &&
          receipt.marker.mailbox?.recordedToken === request.recordedToken && receipt.marker.mailbox.entryId === request.entryId) {
        return { ok: true, type: "ack" };
      }
      return { ok: false, error: "unknown-injection" };
    }
    if (request.type === "injection.current") return { ok: true, type: "injection-current", marker, now: this.now() };
    if (!marker.mailbox || (marker.phase === "settled" && !marker.mailbox.legacy)) return { ok: false, error: "not-mailbox-intent" };
    if (request.type === "injection.failed") {
      // Actual afterRun.members is itself positive start/projection evidence.
      // Late ingress can join A's final seal after this source's beforeRun.
      if (request.outcome !== "aborted" && request.outcome !== "error") return { ok: false, error: "invalid-run-outcome" };
      const reason = request.outcome === "aborted" ? "run-aborted" : "run-error";
      if (marker.mailbox.failureReason && marker.mailbox.failureReason !== reason) return { ok: false, error: "run-outcome-conflict" };
      this.store.putInjection({ ...marker, mailbox: { ...marker.mailbox, failureReason: reason } });
      return { ok: true, type: "ack" };
    }
    if (request.type === "injection.start") {
      if (marker.mailbox.startedAt !== undefined) return { ok: true, type: "ack" };
      if (this.now() > marker.staleAt) return { ok: false, error: "injection-stale" };
      this.store.putInjection({ ...marker, mailbox: { ...marker.mailbox, startedAt: this.now() } });
      return { ok: true, type: "ack" };
    }
    if (request.anchorEntryId !== marker.mailbox.anchorEntryId) return { ok: false, error: "source-scope-conflict" };
    if (!request.recordedToken || !request.entryId) return { ok: false, error: "invalid-native-proof" };
    if ((marker.mailbox.recordedToken && marker.mailbox.recordedToken !== request.recordedToken) ||
        (marker.mailbox.entryId && marker.mailbox.entryId !== request.entryId)) return { ok: false, error: "handoff-conflict" };
    this.store.putInjection({ ...marker, phase: "mailbox-owned", terminalOutcome: undefined, terminalDetail: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
      mailbox: { ...marker.mailbox, recordedToken: request.recordedToken, entryId: request.entryId } });
    return { ok: true, type: "ack" };
  }

  private terminal(request: Extract<MailboxInjectionRequest, { type: "injection.terminal" }>): SchedulerResponse {
    const e = request.evidence;
    if (e.producer !== "pi-scheduler" || !e.key.startsWith("injection:") || !e.terminalId) {
      return { ok: false, error: "invalid-terminal-evidence" };
    }
    const injectionId = e.key.slice("injection:".length);
    const receipt = this.store.getInjectionReceipt(injectionId);
    const legacy = this.store.getLegacyInjectionReceipt(injectionId);
    const active = this.store.getInjection(injectionId);
    if (legacy) {
      if (active) assertInjectionReceiptMatchesMarker(active, legacy);
      if (receipt) return { ok: false, error: "terminal-conflict" };
      if (legacy.evidence) {
        if (!isDeepStrictEqual(legacy.evidence, e)) return { ok: false, error: "terminal-conflict" };
      } else {
        const recorded = legacy.recorded!;
        if (e.outcome !== "fulfilled" || e.scope.sessionId !== recorded.scope.sessionId || e.scope.anchorEntryId !== recorded.scope.anchorEntryId ||
            e.nativeEntryIds.length !== 1 || e.nativeEntryIds[0] !== recorded.entries[0]!.entryId) return { ok: false, error: "terminal-conflict" };
        this.store.putLegacyInjectionReceipt({ ...legacy, evidence: e });
      }
      return { ok: true, type: "ack" };
    }
    if (receipt) {
      if (!isDeepStrictEqual(receipt.evidence, e)) return { ok: false, error: "terminal-conflict" };
      this.finish(receipt);
      return { ok: true, type: "ack" };
    }
    const marker = this.store.getInjection(injectionId);
    if (!marker && e.outcome === "fulfilled" && this.legacyDelivered(injectionId, e.scope.sessionId)) {
      this.store.putLegacyInjectionReceipt({ version: 1, legacy: true, evidence: e });
      return { ok: true, type: "ack" };
    }
    if (!marker?.mailbox || marker.sessionId !== e.scope.sessionId || marker.mailbox.anchorEntryId !== e.scope.anchorEntryId) {
      return { ok: false, error: "unknown-mailbox-injection" };
    }
    if (e.outcome === "fulfilled" && (marker.phase !== "mailbox-owned" ||
        !e.assistantEntryId || !e.receiptEntryId || e.nativeEntryIds.length !== 1 ||
        e.nativeEntryIds[0] !== marker.mailbox.entryId)) return { ok: false, error: "missing-handoff-proof" };
    const committed: InjectionTerminalReceipt = { version: 1, marker, evidence: e, finishedAt: this.now() };
    // Permanent dedup survives run-history pruning and a lost IPC reply.
    this.store.putInjectionReceipt(committed);
    this.finish(committed);
    return { ok: true, type: "ack" };
  }

  reconcile(marker: InjectionMarker): boolean {
    const receipt = this.store.getInjectionReceipt(marker.injectionId);
    const legacy = this.store.getLegacyInjectionReceipt(marker.injectionId);
    if (legacy) assertInjectionReceiptMatchesMarker(marker, legacy);
    if (!receipt) return false;
    assertInjectionReceiptMatchesMarker(marker, receipt);
    this.finish(receipt);
    return true;
  }

  private legacyDelivered(injectionId: string, sessionId: string): boolean {
    if (this.store.getInjectionReceipt(injectionId)) return false;
    const taskId = injectionId.slice(0, injectionId.lastIndexOf(":"));
    const task = this.store.getTask(taskId);
    if (!task || task.id !== taskId) return false;
    try { validateTask(task, this.now()); } catch { return false; }
    if (task.target.kind !== "session" || task.target.sessionId !== sessionId) return false;
    return this.store.listRuns(taskId).some((r) => r.taskId === taskId && r.injectionId === injectionId &&
      injectionId === `${taskId}:${r.scheduledTime}` && r.target === "session" && r.outcome === "delivered" && r.detail !== "mailbox-fulfilled");
  }

  private finish(receipt: InjectionTerminalReceipt): void {
    const { marker, evidence, finishedAt } = receipt;
    const active = this.store.getInjection(marker.injectionId);
    if (active) assertInjectionReceiptMatchesMarker(active, receipt);
    if (!receipt.runRecorded && !this.store.listRuns(marker.taskId).some((r) => r.injectionId === marker.injectionId)) {
      const record: RunRecord = { taskId: marker.taskId, scheduledTime: marker.scheduledTime, finishedAt,
        ...(marker.mailbox?.startedAt === undefined ? {} : { startedAt: marker.mailbox.startedAt }),
        target: "session", injectionId: marker.injectionId,
        outcome: evidence.outcome === "fulfilled" ? "delivered" : "failure",
        ...(evidence.outcome === "fulfilled" ? { detail: "mailbox-fulfilled" } : {}),
        ...(evidence.outcome === "cancelled" ? { detail: `mailbox-cancelled:${evidence.reason}`, acknowledged: false } : {}) };
      this.store.appendRun(record, finishedAt);
      if (record.outcome === "failure") {
        const task = this.store.getTask(marker.taskId);
        if (task) this.onFailure?.(task, record);
      }
    }
    if (!receipt.runRecorded) this.store.putInjectionReceipt({ ...receipt, runRecorded: true });
    this.store.clearInjection(marker.injectionId);
  }
}
