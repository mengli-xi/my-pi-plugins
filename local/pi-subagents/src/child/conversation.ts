import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getContinuationRegistryV1, type BlockingLeaseHandleV1 } from "pi-runtime-contracts/continuation-v1";
import { canonicalDeliveryJsonV1 } from "../persistence/canonical.js";
import { getOrCreateProducerProofRegistryV1 } from "../host/producer-proof.js";
import type { MailboxDeliveryItemV1, MailboxInjectionTargetV1, MailboxDeliveryProofV1 } from "./mailbox-injection.js";
import { DeliveryPending, SubagentMailboxTransport } from "../mailbox/transport.js";
import type { CurrentDecision, Mail, MailboxRunEnd, RecordedNotice, TerminalEvidence } from "pi-session-inject/mailbox-v1";
export interface ChildConversationDeliveryV1 {
  acquireTaskLease(taskId: string): Readonly<{ leaseId: string; generation: number; logicalKey: string }>;
  taskLease(taskId: string): Readonly<{ leaseId: string; generation: number; logicalKey: string }> | undefined;
  releaseTaskLease(taskId: string, outcome: "ready" | "failed" | "cancelled"): Readonly<{ leaseId: string; generation: number }>;
  releaseTaskLeaseWithWake(input: { taskId: string; outcome: "ready" | "failed" | "cancelled"; outboxId: string; wakeEpoch: number; completionIds: readonly string[] }): Promise<Readonly<Record<string, unknown>>>;
  finalizeWakeProof(outboxId: string, wakeEpoch: number): void;
  activeLeaseTaskIds(): readonly string[];
  appendCompletionCards(items: readonly { inboxId: string; completionId: string; projectionSha256: string; content: string; detailsJson: string }[]): Promise<readonly { inboxId: string; completionId: string; projectionSha256: string; entryId: string }[]>;
  appendMailboxMessages(items: readonly { messageId: string; body: string; bodySha256: string; injectedInto: MailboxInjectionTargetV1; source?: string }[]): Promise<readonly MailboxDeliveryProofV1[]>;
}
/** Native append, dedup and lease/wake receipts for the SDK owner. */
export function createChildConversationV1(pi: ExtensionAPI,
  identity: () => { parentConversationSessionId: string; agentId: string; taskId: string; runtimeGeneration: number },
  options: { agentDir: string; assertInput(items: readonly MailboxDeliveryItemV1[]): void;
    check(mail: Mail): CurrentDecision; recorded(notice: RecordedNotice): Promise<void>; terminal(evidence: TerminalEvidence): Promise<void>; afterRun(end: MailboxRunEnd): void },
): ChildConversationDeliveryV1 & { bind(ctx: ExtensionContext): void; dispose(): void; reloadRefusalReason(): string | undefined; resumeTask(): Promise<void>; activateNewExecution(): Promise<void>; cancelTaskMail(taskId: string, generation: number): Promise<void> } {
  let context: ExtensionContext | undefined;
  let sessionManager: ExtensionContext["sessionManager"] | undefined;
  const leaseHandles = new Map<string, BlockingLeaseHandleV1>();
  const wakeProofReservations = new Map<string, { clear(): void }>();
  const pendingWakes = new Map<string, { wake: Extract<ReturnType<BlockingLeaseHandleV1["releaseAndOfferWake"]>, { ok: true }>["value"]; leaseId: string; leaseGeneration: number; result?: Readonly<Record<string, unknown>> }>();
  const mailbox: SubagentMailboxTransport = new SubagentMailboxTransport(pi, options.agentDir, {
    checkCurrent: (mail, _point, fence) => mailbox.current(fence) ? options.check(mail) : { kind: "hold", reason: "child binding changed" },
    onRecorded: (notice, fence) => { if (!mailbox.current(fence)) throw new Error("stale child recorded callback"); return options.recorded(notice); },
    onTerminal: (evidence, fence) => { if (!mailbox.current(fence)) throw new Error("stale child terminal callback"); return options.terminal(evidence); },
    beforeRun: async start => { if (mailbox.current(start.fence)) await mailbox.cancelRecovered(options.check); },
    afterRun: end => { if (mailbox.current(end.fence)) options.afterRun(end); },
  });
  const taskKey = (messageId: string) => { const owner = identity(); return `agent:${owner.agentId}:task:${owner.taskId || "idle"}:gen:${owner.runtimeGeneration}:${messageId}`; };
  return {
    bind(ctx) { context = ctx; sessionManager = ctx.sessionManager; mailbox.bindContext(ctx); },
    reloadRefusalReason() {
      if (leaseHandles.size) return "the child holds a blocking Task lease";
      if (wakeProofReservations.size) return "a Wake proof is unfinished";
      if ([...pendingWakes.values()].some(pending => !pending.result)) return "a Wake is unfinished";
      return undefined;
    },
    acquireTaskLease(taskId: string): Readonly<{ leaseId: string; generation: number; logicalKey: string }> {
      const existing = leaseHandles.get(taskId); if (existing) { const snapshot = existing.snapshot(); return Object.freeze({ leaseId: snapshot.leaseId, generation: snapshot.generation, logicalKey: snapshot.logicalKey }); }
      const bootstrap = identity(); const result = getContinuationRegistryV1().acquireBlocking({ sessionId: bootstrap.parentConversationSessionId, ownerId: "pi-subagents", logicalKey: taskId, reason: `Subagent task ${taskId} is running in the background` });
      if (!result.ok) throw new Error(`could not acquire Task lease: ${result.error}`); const snapshot = result.value.snapshot();
      if (snapshot.sessionId !== bootstrap.parentConversationSessionId || snapshot.ownerId !== "pi-subagents" || snapshot.logicalKey !== taskId) throw new Error("Task lease identity mismatch"); leaseHandles.set(taskId, result.value);
      return Object.freeze({ leaseId: snapshot.leaseId, generation: snapshot.generation, logicalKey: snapshot.logicalKey });
    },
    taskLease(taskId: string): Readonly<{ leaseId: string; generation: number; logicalKey: string }> | undefined { const handle = leaseHandles.get(taskId); if (!handle) return undefined; const snapshot = handle.snapshot(); return Object.freeze({ leaseId: snapshot.leaseId, generation: snapshot.generation, logicalKey: snapshot.logicalKey }); },
    releaseTaskLease(taskId: string, outcome: "ready" | "failed" | "cancelled"): Readonly<{ leaseId: string; generation: number }> { const handle = leaseHandles.get(taskId); if (!handle) throw new Error("Task lease is absent"); const before = handle.snapshot(); const result = handle.releaseWithoutWake({ outcome, reason: `Subagent task ${taskId} settled` }); if (!result.ok) throw new Error(`could not release Task lease: ${result.error}`); leaseHandles.delete(taskId); return Object.freeze({ leaseId: before.leaseId, generation: before.generation }); },
    async appendMailboxMessages(items): Promise<readonly MailboxDeliveryProofV1[]> {
      options.assertInput(items);
      if (!sessionManager) throw new Error("child session is unavailable");
      const proofs: MailboxDeliveryProofV1[] = [];
      for (const item of items) {
        const accepted = await mailbox.put({ key: taskKey(item.messageId), wake: item.injectedInto.kind === "task",
          messages: [{ customType: "subagent-mailbox-v1", content: item.body, display: true,
            details: { message_id: item.messageId, body_sha256: item.bodySha256, injected_into: item.injectedInto, ...(item.source ? { source: item.source } : {}) } }] });
        const entry = accepted.entries[0];
        const base = { messageId: item.messageId, bodySha256: item.bodySha256, injectedInto: item.injectedInto };
        if (!entry) throw new DeliveryPending();
        proofs.push({ ...base, state: "injected", entryId: entry.entryId });
      }
      return proofs;
    },
    async releaseTaskLeaseWithWake(input): Promise<Readonly<Record<string, unknown>>> {
      if (!sessionManager) throw new Error("child session is unavailable");
      const key = taskKey(`outbox:${input.outboxId}:${input.wakeEpoch}`);
      let pending = pendingWakes.get(key);
      if (!pending) {
        const handle = leaseHandles.get(input.taskId);
        if (!handle) throw new Error("Task lease is absent");
        const snapshot = handle.snapshot();
        const result = handle.releaseAndOfferWake({ outcome: input.outcome, reason: `Subagent completion ${input.completionIds.join(",")} is ready` });
        if (!result.ok) throw new Error(`could not offer Task Wake: ${result.error}`);
        leaseHandles.delete(input.taskId);
        pending = { wake: result.value, leaseId: snapshot.leaseId, leaseGeneration: snapshot.generation };
        pendingWakes.set(key, pending);
      }
      if (pending.result) return pending.result;
      const wake = pending.wake, offer = wake.snapshot();
      const details = { version: 1, outbox_id: input.outboxId, wake_epoch: input.wakeEpoch, completion_ids: input.completionIds };
      const content = `Subagent results ${input.completionIds.join(", ")} are ready. Continue from the delivered completion cards.`;
      const continuationSha256 = createHash("sha256").update(canonicalDeliveryJsonV1({ custom_type: "subagent-continuation-v1", content, details })).digest("hex");
      const cards = input.completionIds.map(completionId => {
        const matches = sessionManager!.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-completion-v1"
          && (entry.details as Record<string, unknown>)?.completion_id === completionId);
        if (matches.length !== 1 || matches[0]?.type !== "custom_message") throw new Error("child Outbox card native proof is unavailable");
        const entry = matches[0];
        return { customType: entry.customType, content: entry.content, display: entry.display, details: entry.details };
      });
      await mailbox.put({ key, wake: true, messages: cards });
      const accepted = await mailbox.put({ key: `${key}:continuation`, wake: true, messages: [{ customType: "subagent-continuation-v1", content, display: false, details }] });
      const native = accepted.entries[0];
      if (!native) throw new DeliveryPending();
      const reservation = getOrCreateProducerProofRegistryV1().reserve({ key: { session_id: offer.sessionId, offer_id: offer.offerId, offer_generation: offer.offerGeneration },
        owner_token: `child:${identity().runtimeGeneration}`, owner_generation: identity().runtimeGeneration });
      if (!reservation.ok) throw new Error(`producer proof reservation failed: ${reservation.code}`);
      const active = reservation.handle.activate({ version: 1, session_id: offer.sessionId, offer_id: offer.offerId, offer_generation: offer.offerGeneration,
        outbox_id: input.outboxId, wake_epoch: input.wakeEpoch, continuation_entry_id: native.entryId, continuation_sha256: continuationSha256 });
      if (!active.ok) { reservation.handle.clear(); throw new Error(`producer proof activation failed: ${active.code}`); }
      const committed = wake.commit("delivered");
      if (!committed.ok) { reservation.handle.clear(); throw new Error(`Wake commit failed: ${committed.error}`); }
      wakeProofReservations.set(`${input.outboxId}:${input.wakeEpoch}`, reservation.handle);
      pending.result = { state: "released-wake-settled", leaseId: pending.leaseId, leaseGeneration: pending.leaseGeneration,
        offerId: offer.offerId, offerGeneration: offer.offerGeneration, wakeEpoch: input.wakeEpoch, settlementKind: "producer-fallback",
        runtimeDelivery: "delivered", continuationIdentity: native.entryId, continuationSha256 };
      return pending.result;
    },
    finalizeWakeProof(outboxId, wakeEpoch): void { wakeProofReservations.get(`${outboxId}:${wakeEpoch}`)?.clear(); wakeProofReservations.delete(`${outboxId}:${wakeEpoch}`); },
    activeLeaseTaskIds(): readonly string[] { return Object.freeze([...leaseHandles.keys()].sort()); },
    async appendCompletionCards(items) {
      if (!sessionManager) throw new Error("child session is unavailable");
      const proofs = [];
      for (const item of items) {
        const details = JSON.parse(item.detailsJson) as unknown;
        if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("child Completion details are invalid");
        const accepted = await mailbox.put({ key: `card:${item.inboxId}`, wake: false,
          messages: [{ customType: "subagent-completion-v1", content: item.content, display: true,
            details: { inbox_id: item.inboxId, completion_id: item.completionId, projection_sha256: item.projectionSha256, completion_details: details } }] });
        const native = accepted.entries[0];
        if (!native) throw new DeliveryPending();
        proofs.push({ inboxId: item.inboxId, completionId: item.completionId, projectionSha256: item.projectionSha256, entryId: native.entryId });
      }
      return proofs;
    },
    activateNewExecution: () => mailbox.activateNewExecution(),
    cancelTaskMail: (taskId, generation) => mailbox.cancelPrefix(`agent:${identity().agentId}:task:${taskId}:gen:${generation}:`, "Task authority ended"),
    async resumeTask() {
      // A new execution grant rechecks the same accepted Task intents. Source
      // ACK may already have retired the owner event before the grant arrived.
      // There is no second SDK resume message or native trigger.
      const owner = identity();
      if (owner.taskId) await mailbox.recheckPrefix(`agent:${owner.agentId}:task:${owner.taskId}:gen:${owner.runtimeGeneration}:`);
    },
    dispose() {
      for (const [taskId, handle] of leaseHandles) handle.releaseWithoutWake({ outcome: "cancelled", reason: `Subagent runtime closed: ${taskId}` });
      leaseHandles.clear();
      for (const reservation of wakeProofReservations.values()) reservation.clear();
      wakeProofReservations.clear(); pendingWakes.clear(); mailbox.close(); context = undefined; sessionManager = undefined;
    },
  };
}
