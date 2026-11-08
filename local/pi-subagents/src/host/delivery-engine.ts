import { createHash } from "node:crypto";
import type { AgentHostCoreV1 } from "./core.js";
import { canonicalJsonV1 } from "../persistence/canonical.js";
import { DeliveryPending } from "../mailbox/transport.js";
import { getOrCreateProducerProofRegistryV1, type ProducerContinuationProofRegistryV1, type ProducerProofReservationV1 } from "./producer-proof.js";
import type { HostWakeTransactionV1 } from "./types.js";
import type { CompletionCardProjectionV1, ConversationRefV1, InboxRecordV1, OutboxRecordV1, WakeSettlementReceiptV1 } from "../persistence/types.js";

export interface CompletionAppendProofV1 { readonly entryId: string; readonly completionId: string; readonly projectionSha256: string }
export interface DeliveryAppendPortV1 {
  readonly conversation: ConversationRefV1;
  appendCompletion(input: { readonly inboxId: string; readonly completionId: string; readonly projection: CompletionCardProjectionV1 }): Promise<void>;
  proveCompletion(input: { readonly inboxId: string; readonly completionId: string; readonly projectionSha256: string }): Promise<CompletionAppendProofV1>;
  appendContinuation?(input: { readonly outboxId: string; readonly wakeEpoch: number; readonly content: string; readonly details: Readonly<Record<string, unknown>> }): Promise<void>;
  acceptOutbox?(input: { readonly outboxId: string; readonly wakeEpoch: number; readonly inboxes: readonly InboxRecordV1[] }): Promise<void>;
  acceptContinuation?(input: { readonly outboxId: string; readonly wakeEpoch: number; readonly content: string; readonly details: Readonly<Record<string, unknown>> }): Promise<void>;
  hasAcceptedContinuation?(input: { readonly outboxId: string; readonly wakeEpoch: number }): boolean;
  proveContinuation?(input: { readonly outboxId: string; readonly wakeEpoch: number; readonly continuationSha256: string }): Promise<{ readonly entryId: string; readonly continuationSha256: string }>;
  /**
   * 按原 entry 身份（outbox_id + wake_epoch）认已经物理 append 过的 continuation：prove 失败之后靠它去重。
   * `wakeEpoch` 是调用方当前的 durable epoch：重开 store 归一重投之后，同一条 Outbox 在 branch 上可以合法
   * 留下多个 epoch 的 continuation，取证必须精确到这一个，不许拿旧 epoch 冒充，也不许因为存在旧 epoch 就报重复。
   */
  findContinuation?(input: { readonly outboxId: string; readonly wakeEpoch: number }): Promise<Readonly<{ entryId: string; wakeEpoch: number; continuationSha256: string }> | undefined>;
}
export interface DeliveryEngineOptionsV1 { readonly host: AgentHostCoreV1; readonly tryHandleOutbox?: (outboxId: string) => Promise<boolean>; readonly resolveAppendPort: (recipient: ConversationRefV1) => DeliveryAppendPortV1 | undefined; readonly releaseWake?: (input: { taskId: string; outcome: "ready" | "failed" | "cancelled"; reason: string }) => HostWakeTransactionV1; readonly offerWake?: (input: { sessionId: string; logicalKey: string; outcome: "ready" | "failed" | "cancelled"; reason: string }) => HostWakeTransactionV1; readonly producerProofRegistry?: ProducerContinuationProofRegistryV1; readonly ownerToken?: string; readonly ownerGeneration?: number; readonly now?: () => Date }
export type SettleWakeResultV1 = Readonly<{ state: "delivered"; kind: "goal-claimed" | "producer-fallback" }> | Readonly<{ state: "handled" }> | Readonly<{ state: "skipped"; reason: "waiting-native" }>;
type DeliverOutboxResultV1 = Readonly<{ state: "cards-appended"; inboxIds: readonly string[] }> | Readonly<{ state: "skipped"; reason: "delivering" | "waiting-native" }>;
interface ProducerContinuationV1 { readonly proofHandle: ProducerProofReservationV1; readonly continuationIdentity: string; readonly continuationSha256: string }
function same(left: ConversationRefV1, right: ConversationRefV1): boolean { return left.kind === right.kind && left.session_id === right.session_id && left.agent_id === right.agent_id; }
/**
 * 一条 Outbox 的结算责任，只有两件事：
 * - `settling`：谁在结算。deliver（Task settle）与 reconcile（binding 替换、session_start、agent_settled）
 *   是同一条 Outbox 的两个入口，open 期间谁都不许再起第二个 offer。
 * - `proof`：这一 epoch 已经 activate、终态事务还没收走的 producer proof reservation。§7.5 要求它活到
 *   receipt 落盘或这一 epoch 被显式 reconcile，offer 期间的 late claim 靠它同步查到 owner。
 *
 * 结算证据本身不在这里：pending 事务已经把 `WakeSettlementReceiptV1` 落盘，那一份才是跨重启唯一的事实，
 * 进程内不再留第二份 Goal receipt 去反推 owner。outbox_id 全局唯一，按 id 记就够，不需要全局锁；
 * proof registry 本身就是 process-global，所以这张表也跟着 process 走：一次 Main binding 替换不能把
 * 还没收尾的 proof 丢掉，替换后的 consumer 要看到同一份 active proof。
 */
interface OutboxSettlementV1 { settling: boolean; proof?: { readonly wakeEpoch: number; readonly handle: ProducerProofReservationV1 } }
const OUTBOX_SETTLEMENTS_V1 = new Map<string, OutboxSettlementV1>();
/** Task settle 与 Main reconcile（含 binding 替换）共用整轮投递所有权，覆盖卡片与随后 Wake 步骤。 */
const OUTBOX_DELIVERIES_V1 = new Set<string>();
/** 驱动方在第一次 await 前占位；异常或取消都释放，不随 engine dispose/binding 替换提前交接。 */
export async function driveOutboxDeliveryV1(outboxId: string, run: () => Promise<void>): Promise<Readonly<{ state: "completed" }> | Readonly<{ state: "skipped"; reason: "delivering" }>> {
  if (OUTBOX_DELIVERIES_V1.has(outboxId)) return Object.freeze({ state: "skipped", reason: "delivering" });
  OUTBOX_DELIVERIES_V1.add(outboxId);
  try { await run(); return Object.freeze({ state: "completed" }); }
  finally { OUTBOX_DELIVERIES_V1.delete(outboxId); }
}
function settlementSlotV1(outboxId: string): OutboxSettlementV1 { const existing = OUTBOX_SETTLEMENTS_V1.get(outboxId); if (existing) return existing; const created: OutboxSettlementV1 = { settling: false }; OUTBOX_SETTLEMENTS_V1.set(outboxId, created); return created; }
/** 既不在结算、也没有留存 proof 的槽位立刻回收：这张表不留 TTL，也不靠 poller 清理。 */
function collectSettlementSlotV1(outboxId: string): void { const slot = OUTBOX_SETTLEMENTS_V1.get(outboxId); if (slot && !slot.settling && !slot.proof) OUTBOX_SETTLEMENTS_V1.delete(outboxId); }

export class DeliveryEngineV1 {
  readonly options: DeliveryEngineOptionsV1;
  /** 本 engine 还占着 proof 容量的那批 Outbox：dispose 时按它精确归还，不去动别的 Main 的槽位。 */
  readonly #retained = new Set<string>();
  constructor(options: DeliveryEngineOptionsV1) { this.options = options; }
  private detachedOffer(input: { sessionId: string; logicalKey: string; outcome: "ready" | "failed" | "cancelled"; reason: string }): HostWakeTransactionV1 { const offer = this.options.offerWake; if (!offer) throw new Error("detached Wake offer authority is unavailable"); return offer(input); }
  /** §6.2 的冻结 continuation projection：内容与 details 完全由 (outbox, wake_epoch) 决定，去重时按同一份重算。 */
  private continuationProjection(outbox: OutboxRecordV1, wakeEpoch: number): Readonly<{ content: string; details: Readonly<Record<string, unknown>>; sha256: string }> {
    const details = Object.freeze({ version: 1, outbox_id: outbox.outbox_id, wake_epoch: wakeEpoch, completion_ids: outbox.completion_ids }); const content = `Subagent results ${outbox.completion_ids.join(", ")} are ready. Continue from the delivered completion cards.`;
    return Object.freeze({ content, details, sha256: createHash("sha256").update(canonicalJsonV1({ custom_type: "subagent-continuation-v1", content, details })).digest("hex") });
  }
  /**
   * Producer fallback reserves the offer's proof slot before handoff. Only exact
   * native proof activates it. Main acceptance without native is waiting-native:
   * release this reservation/offer and retain A's responsibility for the same key.
   * Real append/proof failures also release capacity; only unaccepted work may re-offer.
   */
  private async appendProducerContinuation(input: { readonly outbox: OutboxRecordV1; readonly offer: ReturnType<HostWakeTransactionV1["snapshot"]>; readonly wakeEpoch: number; readonly abort: (message: string) => void }): Promise<ProducerContinuationV1> {
    const registry = this.options.producerProofRegistry ?? getOrCreateProducerProofRegistryV1(); const key = { session_id: input.offer.sessionId, offer_id: input.offer.offerId, offer_generation: input.offer.offerGeneration };
    const reservation = registry.reserve({ key, owner_token: this.options.ownerToken ?? "pi-subagents", owner_generation: this.options.ownerGeneration ?? 1 });
    if (!reservation.ok) { input.abort(`producer proof reservation failed: ${reservation.code}`); throw new Error(`producer proof reservation failed: ${reservation.code}`); }
    try {
      const port = this.options.resolveAppendPort(input.outbox.recipient); if (!port?.appendContinuation || !port.proveContinuation) throw new Error("producer continuation append authority is unavailable");
      const { content, details, sha256: continuationSha256 } = this.continuationProjection(input.outbox, input.wakeEpoch);
      await port.appendContinuation({ outboxId: input.outbox.outbox_id, wakeEpoch: input.wakeEpoch, content, details });
      const proof = await port.proveContinuation({ outboxId: input.outbox.outbox_id, wakeEpoch: input.wakeEpoch, continuationSha256 }); if (!proof.entryId || proof.continuationSha256 !== continuationSha256) throw new Error("producer continuation proof mismatch");
      const active = reservation.handle.activate({ version: 1, ...key, outbox_id: input.outbox.outbox_id, wake_epoch: input.wakeEpoch, continuation_entry_id: proof.entryId, continuation_sha256: continuationSha256 }); if (!active.ok) throw new Error(`producer proof activation failed: ${active.code}`);
      return Object.freeze({ proofHandle: reservation.handle, continuationIdentity: proof.entryId, continuationSha256 });
    } catch (error) {
      // append/prove/activate 抛出时，reservation 和 runtime offer 都必须释放，否则 proof 表被占住、
      // offer 永远停在 claimed/open，durable Outbox 也就再没有第二次机会。
      reservation.handle.clear(); input.abort(error instanceof Error ? error.message : String(error)); throw error;
    }
  }

  /** 调用方用 driveOutboxDeliveryV1 持有整轮所有权，直到随后的 Wake 步骤结束。 */
  async deliverOutbox(outboxId: string): Promise<DeliverOutboxResultV1> {
    const now = () => (this.options.now ?? (() => new Date()))().toISOString(); const state = this.options.host.snapshot(); const partitions = [state.root, ...state.agents]; const outbox = partitions.flatMap((item) => item.outbox).find((item) => item.outbox_id === outboxId); if (!outbox) throw new Error("Outbox is missing"); const port = this.options.resolveAppendPort(outbox.recipient); if (!port || !same(port.conversation, outbox.recipient)) throw new Error("recipient append authority is unavailable");
    if(outbox.state!=="pending"&&outbox.state!=="delivering")throw new Error("Outbox is not ready for card delivery");if(outbox.state==="pending"){const started = await this.options.host.beginOutboxDelivery({ outboxId, at: now() }); if (!started.ok) throw new Error(started.error.message);} const snapshot = this.options.host.snapshot(); const inboxes = [snapshot.root, ...snapshot.agents].flatMap((item) => item.inbox).filter((inbox) => outbox.completion_ids.includes(inbox.completion_id)); const byCompletion = new Map(inboxes.map((inbox) => [inbox.completion_id, inbox])); const ordered: InboxRecordV1[] = outbox.completion_ids.map((id) => { const inbox = byCompletion.get(id); if (!inbox) throw new Error("Outbox Inbox is missing"); return inbox; });
    try {
    for (const inbox of ordered) { if (inbox.state === "appended") continue; await port.appendCompletion({ inboxId: inbox.inbox_id, completionId: inbox.completion_id, projection: inbox.projection }); const proof = await port.proveCompletion({ inboxId: inbox.inbox_id, completionId: inbox.completion_id, projectionSha256: inbox.projection.projection_sha256 }); if (proof.completionId !== inbox.completion_id || proof.projectionSha256 !== inbox.projection.projection_sha256 || !proof.entryId) throw new Error("native Completion proof mismatch"); const persisted = await this.options.host.proveInboxAppended({ inboxId: inbox.inbox_id, entryId: proof.entryId, projectionSha256: proof.projectionSha256, at: now() }); if (!persisted.ok) throw new Error(persisted.error.message); }
    } catch (error) { if (error instanceof DeliveryPending) return { state: "skipped", reason: "waiting-native" }; throw error; }
    const cards = await this.options.host.markOutboxCardsAppended({ outboxId, at: now() }); if (!cards.ok) throw new Error(cards.error.message); return Object.freeze({ state: "cards-appended", inboxIds: Object.freeze(ordered.map((item) => item.inbox_id)) });
  }

  private findOutbox(outboxId: string): OutboxRecordV1 | undefined { const state = this.options.host.snapshot(); return [state.root, ...state.agents].flatMap((item) => item.outbox).find((item) => item.outbox_id === outboxId); }
  /** 这一 (Outbox, epoch) 已经落盘的结算 receipt：pending 事务写下的那一份跨重启唯一证据。 */
  private findSettlementReceipt(outboxId: string, wakeEpoch: number): WakeSettlementReceiptV1 | undefined { const state = this.options.host.snapshot(); return [state.root, ...state.agents].flatMap((item) => item.wake_receipts).find((receipt) => receipt.outbox_id === outboxId && receipt.wake_epoch === wakeEpoch); }
  private isSettling(outboxId: string): boolean { return OUTBOX_SETTLEMENTS_V1.get(outboxId)?.settling === true; }
  /** 一条 Outbox 同时只有一个结算者：拿不到所有权就不许自己再开 offer。 */
  private async ownSettlement<T>(outboxId: string, run: () => Promise<T>): Promise<T> { const slot = settlementSlotV1(outboxId); if (slot.settling) throw new Error("Outbox Wake settlement is already in progress"); slot.settling = true; try { return await run(); } finally { slot.settling = false; collectSettlementSlotV1(outboxId); } }

  async settleWake(outboxId: string): Promise<SettleWakeResultV1> {
    return this.ownSettlement(outboxId, async () => {
      if (await this.options.tryHandleOutbox?.(outboxId)) return { state: "handled" };
      try { return await this.settleOutboxWake({ outboxId, retry: false }); }
      catch (error) { if (error instanceof DeliveryPending) return { state: "skipped", reason: "waiting-native" }; throw error; }
    });
  }
  /** §7.5：proof 从 activate 一直留到终态事务提交、或这一 epoch 被显式 reconcile/abort。 */
  private retainProducerProof(outboxId: string, wakeEpoch: number, handle: ProducerProofReservationV1): void { const slot = settlementSlotV1(outboxId); slot.proof?.handle.clear(); slot.proof = { wakeEpoch, handle }; this.#retained.add(outboxId); }
  /** 终态事务落盘、或这一 epoch 被显式 reconcile/abort 掉之后，才归还 proof 容量（§7.5）。 */
  private releaseSettlementEvidence(outboxId: string, wakeEpoch: number): void { const slot = OUTBOX_SETTLEMENTS_V1.get(outboxId); if (slot?.proof && slot.proof.wakeEpoch !== wakeEpoch) return; if (slot?.proof) { slot.proof.handle.clear(); delete slot.proof; } this.#retained.delete(outboxId); collectSettlementSlotV1(outboxId); }
  /**
   * Main binding 替换、Goal pause/clear 都不释放证据：durable Outbox 还没终态，替换后的 consumer 要看到
   * 同一份 active proof。只有整个 process service close（Pi 退出）才把本 engine 还占着的 proof 容量交回去。
   */
  dispose(): void { for (const outboxId of [...this.#retained]) { const slot = OUTBOX_SETTLEMENTS_V1.get(outboxId); if (slot?.proof) { slot.proof.handle.clear(); delete slot.proof; } this.#retained.delete(outboxId); collectSettlementSlotV1(outboxId); } }

  /**
   * §7.6/§9.2 的 `wake-settlement-pending`：这一 epoch 的 continuation owner 在 `wake.commit(...)` 时就定了，
   * pending 事务已经把它连同 `WakeSettlementReceiptV1` 落盘，只差最后那一笔链接。这个边界不重投也不重新
   * append，只把落盘的那份 receipt 链接成终态。
   *
   * 老 store（这条 pending 记录写在 receipt 随 pending 事务落盘之前）没有 receipt：producer 分支还能认原
   * (outbox_id, wake_epoch) 的 native continuation entry——那条 entry 已经 append 落盘并请求过一次 trigger；
   * Goal 分支的 receipt 只在 registry 的 commit 内部产生一次，进程一死就没有第二份，只能原样留着交给重开
   * store 的 §7.6 归一重投，绝不伪造 proof。
   */
  async settlePendingWake(outboxId: string): Promise<SettleWakeResultV1 | Readonly<{ state: "skipped"; reason: "settling" | "not-pending" | "unavailable" | "unproven" }>> {
    const outbox = this.findOutbox(outboxId);
    const kind = outbox?.settlement_kind;
    if (!outbox || outbox.state !== "wake-settlement-pending" || !kind) return Object.freeze({ state: "skipped" as const, reason: "not-pending" as const });
    // 同一条 Outbox 的 settleWake 正在跑：它自己的终态事务还没结束，由它收尾。
    if (this.isSettling(outboxId)) return Object.freeze({ state: "skipped" as const, reason: "settling" as const });
    return this.ownSettlement(outboxId, async () => {
      const now = () => (this.options.now ?? (() => new Date()))().toISOString();
      const persisted = this.findSettlementReceipt(outboxId, outbox.wake_epoch);
      let proof: Readonly<{ runtimeDelivery: "delivered" | "skipped"; continuationIdentity: string; continuationSha256: string; claimantOwnerId?: string; claimantGeneration?: number }>;
      if (persisted) {
        if (persisted.kind !== kind) throw new Error("persisted Wake settlement receipt conflicts with the durable settlement kind");
        proof = Object.freeze({ runtimeDelivery: persisted.runtime_delivery, continuationIdentity: persisted.continuation_identity, continuationSha256: persisted.continuation_sha256, ...(persisted.claimant_owner_id !== undefined && persisted.claimant_generation !== undefined ? { claimantOwnerId: persisted.claimant_owner_id, claimantGeneration: persisted.claimant_generation } : {}) });
      } else if (kind === "producer-fallback") {
        const port = this.options.resolveAppendPort(outbox.recipient);
        if (!port?.findContinuation) return Object.freeze({ state: "skipped" as const, reason: "unavailable" as const });
        const appended = await port.findContinuation({ outboxId, wakeEpoch: outbox.wake_epoch });
        if (!appended) return Object.freeze({ state: "skipped" as const, reason: "unproven" as const });
        if (appended.wakeEpoch !== outbox.wake_epoch) throw new Error("Main continuation entry does not match the durable Wake epoch");
        if (appended.continuationSha256 !== this.continuationProjection(outbox, appended.wakeEpoch).sha256) throw new Error("Main continuation native entry conflicts with the frozen projection");
        proof = Object.freeze({ runtimeDelivery: "delivered" as const, continuationIdentity: appended.entryId, continuationSha256: appended.continuationSha256 });
      } else return Object.freeze({ state: "skipped" as const, reason: "unproven" as const });
      const terminal = await this.options.host.terminalizeOutbox({ outboxId, kind, ...proof, at: now() }); if (!terminal.ok) throw new Error(terminal.error.message);
      this.releaseSettlementEvidence(outboxId, outbox.wake_epoch);
      return Object.freeze({ state: "delivered" as const, kind });
    });
  }

  /**
   * An open Main Outbox first checks durable success, then exact native proof.
   * Accepted fallback without native remains waiting on the original key/epoch;
   * no new offer or open transaction is needed. Only work not yet accepted can
   * retry a detached offer. A persisted receipt still owns its original settlement.
   */
  async retryOpenWake(outboxId: string): Promise<SettleWakeResultV1 | Readonly<{ state: "skipped"; reason: "settling" | "not-open" | "unavailable" }>> {
    const outbox = this.findOutbox(outboxId);
    if (!outbox || outbox.state !== "cards-appended" || outbox.wake_state !== "open") return Object.freeze({ state: "skipped" as const, reason: "not-open" as const });
    // 同一条 Outbox 的 settleWake 正在跑：这一 epoch 的 offer 还活着，由它自己收尾。
    if (this.isSettling(outboxId)) return Object.freeze({ state: "skipped" as const, reason: "settling" as const });
    return this.ownSettlement(outboxId, async () => {
      if (await this.options.tryHandleOutbox?.(outboxId)) return { state: "handled" as const };
      const now = () => (this.options.now ?? (() => new Date()))().toISOString();
      const port = this.options.resolveAppendPort(outbox.recipient);
      if (!port) return Object.freeze({ state: "skipped" as const, reason: "unavailable" as const });
      // 只认当前 durable epoch 的那条 entry：更早的 epoch 是上一轮归一留下的合法历史，不是这一 epoch 的证据。
      const appended = port.findContinuation ? await port.findContinuation({ outboxId, wakeEpoch: outbox.wake_epoch }) : undefined;
      if (!appended) {
        // Mailbox acceptance already owns this exact epoch. A guard recheck or
        // ACK replay cannot create a new offer/journal transaction while waiting.
        if (port.hasAcceptedContinuation?.({ outboxId, wakeEpoch: outbox.wake_epoch })) return { state: "skipped" as const, reason: "waiting-native" as const };
        try { return await this.settleOutboxWake({ outboxId, retry: true }); }
        catch (error) { if (error instanceof DeliveryPending) return { state: "skipped" as const, reason: "waiting-native" as const }; throw error; }
      }
      if (appended.wakeEpoch !== outbox.wake_epoch) throw new Error("Main continuation entry does not match the durable Wake epoch");
      if (appended.continuationSha256 !== this.continuationProjection(outbox, appended.wakeEpoch).sha256) throw new Error("Main continuation native entry conflicts with the frozen projection");
      const proof = { runtimeDelivery: "delivered" as const, continuationIdentity: appended.entryId, continuationSha256: appended.continuationSha256 };
      const pending = await this.options.host.markOutboxWakeSettled({ outboxId, kind: "producer-fallback", ...proof, at: now() }); if (!pending.ok) throw new Error(pending.error.message);
      const terminal = await this.options.host.terminalizeOutbox({ outboxId, kind: "producer-fallback", ...proof, at: now() }); if (!terminal.ok) throw new Error(terminal.error.message);
      this.releaseSettlementEvidence(outboxId, appended.wakeEpoch);
      return Object.freeze({ state: "delivered" as const, kind: "producer-fallback" as const });
    });
  }

  private async settleOutboxWake(input: { readonly outboxId: string; readonly retry: boolean }): Promise<SettleWakeResultV1> {
    const outboxId = input.outboxId; const now = () => (this.options.now ?? (() => new Date()))().toISOString(); const state = this.options.host.snapshot(); const partitions = [state.root, ...state.agents]; const outbox = partitions.flatMap((item) => item.outbox).find((item) => item.outbox_id === outboxId); if (!outbox || outbox.state !== "cards-appended" || outbox.wake_state !== (input.retry ? "open" : "not-offered")) throw new Error("Outbox is not ready for Wake"); const completions = state.agents.flatMap((item) => item.completions); const lastCompletion = completions.find((item) => item.completion_id === outbox.completion_ids.at(-1)); if (!lastCompletion) throw new Error("Outbox Completion is missing"); const release = this.options.releaseWake ?? ((value: { taskId: string; outcome: "ready" | "failed" | "cancelled"; reason: string }) => this.options.host.releaseRootTaskLease(value)); const priorCompletions = outbox.completion_ids.slice(0, -1).map((id) => completions.find((item) => item.completion_id === id)).filter((item): item is NonNullable<typeof item> => item !== undefined); for (const completion of priorCompletions) await this.options.host.releaseRootTaskLeaseWithoutWake({ taskId: completion.task_id, outcome: completion.outcome === "failed" ? "failed" : completion.outcome === "interrupted" ? "cancelled" : "ready", reason: `Barrier completion ${completion.completion_id} is ready` }); const outcome = lastCompletion.outcome === "failed" ? "failed" : lastCompletion.outcome === "interrupted" ? "cancelled" : "ready"; const reason = `Subagent completion ${lastCompletion.completion_id} is ready`;
    // wake_epoch 只在 openOutboxWake 里递增，而那笔 transaction 同时把 Task lease 提交成 released。
    // 因此 epoch>0 表示 lease 已经没了，重新 offer 只能用 §7.2 的 detached offer。
    // epoch 还是 0 但本进程已经不握这个 lease，说明上一次 releaseAndOfferWake 已经把它释放掉、随后那笔
    // open transaction 没提交成功：易失 handle 不会自己回来，重放它只会永久抛 authority unavailable，
    // 这一条 durable 的 release-pending 同样只能用 detached offer 补投（PERSISTENCE_FORMAT §10）。
    const leaseHeld = this.options.releaseWake !== undefined || this.options.host.hasRootTaskLease(lastCompletion.task_id);
    const wake = outbox.wake_epoch > 0 || !leaseHeld ? this.detachedOffer({ sessionId: outbox.recipient.session_id, logicalKey: lastCompletion.task_id, outcome, reason }) : release({ taskId: lastCompletion.task_id, outcome, reason });
    const offer = wake.snapshot();
    // hasClaim() 在 commit 之后必然翻成 false（registry 把 record.state 置 committed 并把 offer 移出 session
    // 表），所以 claim 事实必须在 commit 之前取。
    const claimed = wake.hasClaim();
    const opened = await this.options.host.openOutboxWake({ outboxId, offer: { sessionId: offer.sessionId, offerId: offer.offerId, offerGeneration: offer.offerGeneration, ownerId: offer.ownerId, logicalKey: offer.logicalKey }, ...(input.retry ? { retry: true as const } : {}), preserveEpoch: this.options.resolveAppendPort(outbox.recipient)?.acceptOutbox !== undefined, at: now() }); if (!opened.ok) { wake.abort("Outbox open commit failed"); throw new Error(opened.error.message); }
    const wakeEpoch = opened.value.wake_epoch;
    const port = this.options.resolveAppendPort(outbox.recipient);
    if (port?.acceptOutbox) {
      const inboxes = outbox.completion_ids.map(id => partitions.flatMap(item => item.inbox).find(inbox => inbox.completion_id === id));
      if (inboxes.some(item => !item)) throw new Error("Outbox cards are unavailable for mailbox handoff");
      await port.acceptOutbox({ outboxId, wakeEpoch, inboxes: inboxes as InboxRecordV1[] });
    }
    let kind: "goal-claimed" | "producer-fallback"; let continuationIdentity: string; let continuationSha256: string; let claimantOwnerId: string | undefined; let claimantGeneration: number | undefined;
    if (claimed) {
      // consumer receipt 只在 registry 的 commit 内部产生，因此被 claim 的 epoch 必须先 commit，才知道
      // claimant 到底交没交出 continuation。
      const committed = wake.commit("delivered"); if (!committed.ok) throw new Error(`Wake commit failed: ${JSON.stringify(committed.error)}`);
      const receipt = committed.value.consumerReceipt as Record<string, unknown> | undefined;
      if (receipt && receipt.version === 1 && receipt.consumerId === "pi-goal-local" && Number.isSafeInteger(receipt.consumerGeneration) && typeof receipt.continuationId === "string" && ["scheduled", "coalesced"].includes(String(receipt.scheduling))) {
        kind = "goal-claimed"; claimantOwnerId = receipt.consumerId as string; claimantGeneration = receipt.consumerGeneration as number; continuationIdentity = receipt.continuationId as string; continuationSha256 = createHash("sha256").update(canonicalJsonV1(receipt)).digest("hex");
      } else {
        // D-007：claim 拿走了这一 epoch 却没交出 receipt（Goal 被 pause/clear/complete 都会这样）。暂停只停
        // Goal 自己的推进，后台结果照样要通知原会话：不伪造 receipt，也不等 Goal 恢复，由 producer 自己补
        // 这一条通知 turn。commit 已经把 offer 终态化并移出 registry，之后没有人能再 claim，因此这里补
        // proof 不会出现第二个 continuation owner。
        kind = "producer-fallback"; const produced = await this.appendProducerContinuation({ outbox, offer, wakeEpoch, abort: () => {} }); this.retainProducerProof(outboxId, wakeEpoch, produced.proofHandle); continuationIdentity = produced.continuationIdentity; continuationSha256 = produced.continuationSha256;
      }
    } else {
      // 未被 claim：proof 必须在 commit 之前 active，这一窗口里出现的 late claim 才能同步查到它而不再 schedule。
      kind = "producer-fallback"; const produced = await this.appendProducerContinuation({ outbox, offer, wakeEpoch, abort: (message) => { wake.abort(message); } }); this.retainProducerProof(outboxId, wakeEpoch, produced.proofHandle); continuationIdentity = produced.continuationIdentity; continuationSha256 = produced.continuationSha256;
      // commit 失败这一 epoch 就没了：offer 不会再被 claim，durable 记录停在 cards-appended/open，下一个
      // 边界按 §7.6 重试。这条 offer key 的 proof 必须现在还回去，否则 registry 的 256 格被死 offer 占住。
      let committed: ReturnType<typeof wake.commit>;
      try { committed = wake.commit("delivered"); } catch (error) { this.releaseSettlementEvidence(outboxId, wakeEpoch); throw error; }
      if (!committed.ok) { this.releaseSettlementEvidence(outboxId, wakeEpoch); throw new Error(`Wake commit failed: ${JSON.stringify(committed.error)}`); }
    }
    // commit 已经定了这一 epoch 的 continuation owner。pending 事务把这份 owner 连同 receipt 一起落盘：
    // 这一笔之后的任何失败（终态事务失败，甚至进程死亡）都靠那份 receipt 诚实收尾，既不重新 offer 一次，
    // 也不伪造 proof。
    const proof = { runtimeDelivery: "delivered" as const, continuationIdentity, continuationSha256, ...(claimantOwnerId !== undefined && claimantGeneration !== undefined ? { claimantOwnerId, claimantGeneration } : {}) };
    const pending = await this.options.host.markOutboxWakeSettled({ outboxId, kind, ...proof, at: now() }); if (!pending.ok) throw new Error(pending.error.message); const terminal = await this.options.host.terminalizeOutbox({ outboxId, kind, ...proof, at: now() }); if (!terminal.ok) throw new Error(terminal.error.message); this.releaseSettlementEvidence(outboxId, wakeEpoch); return Object.freeze({ state: "delivered", kind });
  }
}

/** 一次 reconcile 边界的结果：投递掉哪些、哪些是暂时推迟、哪些这一轮出了错。 */
export interface ReconcileMainDeliveryResultV1 { readonly delivered: readonly string[]; readonly deferred: readonly Readonly<{ outboxId: string; reason: string }>[]; readonly failed: readonly string[] }
/**
 * DELIVERY_PROTOCOL §7.6 的 reconciliation 入口：Main binding 替换、session_start 与 agent_settled
 * 这些既有 lifecycle 边界都走这一条路径，绝不轮询。
 *
 * 逐条 Outbox 隔离异常：一条 Outbox 的证据冲突不能饿死同一轮里其它 Outbox 的投递。真正的冲突交给
 * `report` 进 bounded diagnostics，不静默吞掉；`unavailable`（暂时没有前台 append authority）与
 * `unproven`（这一 epoch 还证不出 owner）是推迟，不是故障，只记进返回值，等下一个边界再来。
 */
export async function reconcileMainDeliveryV1(input: { readonly host: Pick<AgentHostCoreV1, "snapshot">; readonly delivery: Pick<DeliveryEngineV1, "deliverOutbox" | "settleWake" | "retryOpenWake" | "settlePendingWake">; readonly mainSessionId: string; readonly report?: (value: { readonly operation: string; readonly error: unknown }) => void }): Promise<ReconcileMainDeliveryResultV1> {
  const scan = () => { const state = input.host.snapshot(); return [state.root, ...state.agents].flatMap((item) => item.outbox); };
  const outboxes = scan().filter((outbox) => outbox.recipient.kind === "main" && outbox.recipient.session_id === input.mainSessionId && outbox.state !== "delivered" && outbox.state !== "handled" && outbox.state !== "delivery-failed");
  const delivered: string[] = []; const deferred: Readonly<{ outboxId: string; reason: string }>[] = []; const failed: string[] = [];
  for (const outbox of outboxes) {
    try {
      const driven = await driveOutboxDeliveryV1(outbox.outbox_id, async () => {
        const before = scan().find(item => item.outbox_id === outbox.outbox_id);
        if (before?.state === "pending" || before?.state === "delivering") {
          const cards = await input.delivery.deliverOutbox(outbox.outbox_id);
          if (cards.state === "skipped") { deferred.push(Object.freeze({ outboxId: outbox.outbox_id, reason: cards.reason })); return; }
        }
        const current = scan().find((item) => item.outbox_id === outbox.outbox_id);
        let result: SettleWakeResultV1 | Readonly<{ state: "skipped"; reason: string }> | undefined;
        if (current?.state === "cards-appended" && current.wake_state === "not-offered") result = await input.delivery.settleWake(current.outbox_id);
        // append/prove 失败留下的 open：这个边界重试一次，不重启也不轮询。
        else if (current?.state === "cards-appended" && current.wake_state === "open") result = await input.delivery.retryOpenWake(current.outbox_id);
        // runtime 已经结算完、终态事务没落盘留下的 wake-settlement-pending：用落盘的 receipt 补终态。
        else if (current?.state === "wake-settlement-pending") result = await input.delivery.settlePendingWake(current.outbox_id);
        if (result?.state === "delivered") delivered.push(outbox.outbox_id);
        else if (result?.state === "skipped") deferred.push(Object.freeze({ outboxId: outbox.outbox_id, reason: result.reason }));
      });
      if (driven.state === "skipped") deferred.push(Object.freeze({ outboxId: outbox.outbox_id, reason: driven.reason }));
    } catch (error) {
      failed.push(outbox.outbox_id);
      input.report?.({ operation: `reconcile-main-delivery:${outbox.outbox_id}`, error });
    }
  }
  return Object.freeze({ delivered: Object.freeze(delivered), deferred: Object.freeze(deferred), failed: Object.freeze(failed) });
}
