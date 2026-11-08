import type { AgentHostCoreV1 } from "./core.js";
import type { MainHandledCardV1, NormalizedStoreStateV1, OutboxHandlingProofV1, OutboxRecordV1 } from "../persistence/types.js";
import { open, readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseMailboxSnapshot } from "pi-session-inject/mailbox-v1";
import { MAILBOX_CUSTOM_TYPES, type MailboxDeliveryReceipt } from "pi-session-inject/mailbox-v1/light";
import { canonicalJsonV1, sha256CanonicalV1 } from "../persistence/canonical.js";

/** Main transcript 里 completion card 的 custom message 类型（DELIVERY_PROTOCOL §6.1）。 */
export const COMPLETION_CARD_CUSTOM_TYPE = "subagent-completion-v1";
export const MAIN_RUN_COMPLETED_CUSTOM_TYPE = "subagent-main-run-completed-v1";
interface ObservedCard { readonly inboxId: string; readonly completionId: string; readonly entryId: string; readonly projectionSha256: string }
interface CompletedMainRun { readonly version: 1; readonly sessionId: string; readonly assistantEntryId: string; readonly cards: readonly ObservedCard[] }
function cardMessage(inbox: NormalizedStoreStateV1["root"]["inbox"][number]) {
  return { customType: COMPLETION_CARD_CUSTOM_TYPE, content: inbox.projection.content, display: true,
    details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } };
}
function successfulAssistant(entry: SessionEntry | undefined): boolean {
  return entry?.type === "message" && entry.message.role === "assistant" && !["error", "aborted"].includes(entry.message.stopReason);
}
function nativeCard(entry: SessionEntry | undefined, expected: ReturnType<typeof cardMessage>): boolean {
  return entry?.type === "custom_message" && entry.customType === expected.customType
    && canonicalJsonV1({ customType: entry.customType, content: entry.content, display: entry.display, details: entry.details }) === canonicalJsonV1(expected);
}

/** 收件人是这一 Main、已 delivered 且 turn 仍 pending 的 Outbox（DELIVERY_PROTOCOL §7.9）。 */
export function pendingTurnOutboxesV1(state: NormalizedStoreStateV1, mainSessionId: string): readonly OutboxRecordV1[] {
  return [state.root, ...state.agents].flatMap((partition) => partition.outbox).filter((outbox) => outbox.recipient.kind === "main" && outbox.recipient.session_id === mainSessionId && outbox.state === "delivered" && outbox.turn_settlement?.state === "pending");
}

/** 一次 provider context 里出现的 completion card 的 inbox_id：只认 role custom + 本包 customType + details.inbox_id。 */
export function completionCardInboxIdsV1(messages: readonly unknown[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; customType?: unknown; details?: unknown };
    if (record.role !== "custom" || record.customType !== COMPLETION_CARD_CUSTOM_TYPE || !record.details || typeof record.details !== "object") continue;
    const inboxId = (record.details as { inbox_id?: unknown }).inbox_id;
    if (typeof inboxId === "string" && inboxId.length > 0) found.add(inboxId);
  }
  return found;
}

/** `agent_end` 的 run 是否失败：最后一条 assistant 是 aborted/error、没有 assistant、或 signal 已 abort。 */
export function mainRunFailedV1(messages: readonly unknown[], signalAborted: boolean): boolean {
  if (signalAborted) return true;
  let last: { stopReason?: unknown } | undefined;
  for (const message of messages) { if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") last = message as { stopReason?: unknown }; }
  if (!last) return true;
  return last.stopReason === "aborted" || last.stopReason === "error";
}

/**
 * Main 侧的 turn settlement owner（DELIVERY_PROTOCOL §7.9）。它只记三件事：本轮 context 里出现过哪些 card
 * （`context` 可能一轮多次，取并集）、本轮是否失败、以及成功轮次已经处理过的 card。结算发生在既有边界
 * （`agent_settled`、投递终态、reconcile）：pending Outbox 的全部 card 都在「成功轮次处理过」集合里才翻成
 * settled；abort、error、没带 card 的轮次都不结算。没有 poller、不发消息、不触发模型请求。
 *
 * 处理过的 card 跨 run 保留，而不是只看当前轮：终态事务（写 pending）与它触发的那一轮模型 run 是并发的，
 * 那一轮先于终态提交 settled 时，pending 还不存在，只能留到下一个边界再结算。
 */
export class MainTurnSettlementV1 {
  readonly #seen = new Set<string>();
  readonly #opportunities = new Set<string>();
  readonly #handled = new Set<string>();
  readonly #unpersistedRuns = new Set<string>();
  #running = false;
  #serial: Promise<void> = Promise.resolve();
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(operation);
    // Each caller keeps its own failure; the scheduling tail remains usable.
    this.#serial = next.then(() => undefined, () => undefined);
    return next;
  }
  runStarted(): void { this.#seen.clear(); this.#running = true; }
  observeContext(messages: readonly unknown[]): void { for (const inboxId of completionCardInboxIdsV1(messages)) this.#seen.add(inboxId); }
  runEnded(failed: boolean): void {
    this.#running = false;
    // Wake suppression is synchronous; Host commit authority is published only
    // after the observation is durable inside the shared serial boundary.
    if (!failed) for (const inboxId of this.#seen) this.#opportunities.add(inboxId);
    this.#seen.clear();
  }
  /** 已持久化整轮成功依据、还没结算掉的 card（回归与诊断用）。 */
  handledInboxIds(): readonly string[] { return [...this.#handled].sort(); }
  hasActiveRun(): boolean { return this.#running; }
  /** Called only from the real public agent_end, never from transport receipts.
   * Preserve this source observation before any dependent source turn commit. */
  recordRunEnded(input: { readonly failed: boolean; readonly pi: Pick<ExtensionAPI, "appendEntry">; readonly ctx: Pick<ExtensionContext, "sessionManager">; readonly state: NormalizedStoreStateV1 }): Promise<void> {
    const observed = [...this.#seen].sort();
    this.runEnded(input.failed);
    if (input.failed || !observed.length) return this.serialize(async () => {});
    const session = input.ctx.sessionManager, branch = session.getBranch(), sessionId = session.getSessionId(), file = session.getSessionFile();
    const assistant = [...branch].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
    return this.serialize(async () => {
      if (!assistant || !successfulAssistant(assistant)) throw new Error("Main successful-run assistant proof is unavailable");
      const previouslyHandled = this.completedRunCards({ state: input.state, mainSessionId: sessionId, branch });
      for (const inboxId of previouslyHandled) this.#handled.add(inboxId);
      const cards: ObservedCard[] = [];
      for (const inboxId of observed) {
        if (previouslyHandled.has(inboxId)) continue; // Ordinary later prompts reuse the original durable success.
        const inbox = input.state.root.inbox.find(item => item.inbox_id === inboxId);
        if (!inbox) continue; // Inherited/reference cards are not this source's obligations.
        const matches = branch.filter(entry => nativeCard(entry, cardMessage(inbox)));
        if (matches.length !== 1 || branch.indexOf(matches[0]!) >= branch.indexOf(assistant)
          || inbox.model_entry_id && inbox.model_entry_id !== matches[0]!.id) throw new Error("Main successful-run card proof is unavailable");
        cards.push({ inboxId, completionId: inbox.completion_id, entryId: matches[0]!.id, projectionSha256: inbox.projection.projection_sha256 });
      }
      if (!cards.length) return;
      const data: CompletedMainRun = { version: 1, sessionId, assistantEntryId: assistant.id, cards };
      // A delayed source write may finish only on its original branch.
      if (session.getSessionId() !== sessionId || session.getSessionFile() !== file || !session.getBranch().some(entry => entry.id === assistant.id)) throw new Error("Main successful-run origin is no longer active");
      let marker = session.getBranch().find(entry => entry.type === "custom" && entry.customType === MAIN_RUN_COMPLETED_CUSTOM_TYPE
        && (entry.data as CompletedMainRun | undefined)?.assistantEntryId === assistant.id);
      if (marker && canonicalJsonV1((marker as { data?: unknown }).data) !== canonicalJsonV1(data)) throw new Error("conflicting Main successful-run observation");
      // appendEntry may leave a visible marker even when append/readback/sync
      // fails. It cannot become authority through a later branch-only replay.
      this.#unpersistedRuns.add(assistant.id);
      if (!marker) {
        input.pi.appendEntry(MAIN_RUN_COMPLETED_CUSTOM_TYPE, data);
        marker = session.getBranch().find(entry => entry.type === "custom" && entry.customType === MAIN_RUN_COMPLETED_CUSTOM_TYPE
          && canonicalJsonV1(entry.data) === canonicalJsonV1(data));
      }
      if (!file || !marker) throw new Error("Main successful-run observation has no persistent transcript proof");
      const disk = (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (disk[0]?.type !== "session" || disk[0]?.id !== data.sessionId || !disk.some(entry => entry.id === marker!.id && canonicalJsonV1(entry.data) === canonicalJsonV1(data))) throw new Error("Main successful-run observation is absent from its original file");
      const handle = await open(file, "r"); try { await handle.sync(); } finally { await handle.close(); }
      this.#unpersistedRuns.delete(assistant.id);
      for (const card of cards) this.#handled.add(card.inboxId);
    });
  }
  /** Domain success and transport opportunity have different authority. A
   * fulfilled receipt can suppress another wake, but only this owner's durable
   * whole-run observation may restore business turn settlement. */
  hasCardOpportunity(input: { readonly state: NormalizedStoreStateV1; readonly mainSessionId: string; readonly branch: readonly SessionEntry[]; readonly completionIds: readonly string[] }): boolean {
    const cards = input.completionIds.map(id => input.state.root.inbox.find(inbox => inbox.completion_id === id));
    if (!cards.length || cards.some(card => !card)) return false;
    const handled = new Set([...this.#handled, ...this.#opportunities, ...this.completedRunCards(input)]), positions = new Map(input.branch.map((entry, index) => [entry.id, index]));
    const receipts = new Map<string, { identity: string; cards: string[] }>(), conflicts = new Set<string>();
    for (const entry of input.branch) {
      if (entry.type !== "custom" || entry.customType !== MAILBOX_CUSTOM_TYPES.delivery) continue;
      const data = entry.data as MailboxDeliveryReceipt | undefined;
      if (data?.version !== 1 || data.sessionId !== input.mainSessionId || !Array.isArray(data.terminals)) continue;
      for (const raw of data.terminals) {
        // An unrelated, valid receipt is not a member of this card set. Invalid
        // receipts confer no authority; canonical JSON remains strict.
        try {
        const rawEvidence = raw.evidence.outcome === "fulfilled" ? { ...raw.evidence, receiptEntryId: entry.id } : raw.evidence;
        // Validate the public Mail/evidence schema; the scaffolding ACK fields
        // are shape-only and confer neither source ACK nor business success.
        const terminal = parseMailboxSnapshot({ version: 1, session: { id: input.mainSessionId, file: null }, revision: 0,
          suspended: null, pending: [], terminal: [{ mail: raw.mail, branchEntryId: raw.branchEntryId, evidence: rawEvidence,
            requiredCallbacks: { recorded: false, terminal: false }, recorded: null, terminalAck: "acknowledged", backingReceiptEntryId: entry.id }] }).terminal[0]!;
        const evidence = terminal.evidence;
        if (terminal.mail.producer !== "pi-subagents" || evidence.outcome !== "fulfilled"
          || (terminal.mail.anchorEntryId !== null && !positions.has(terminal.mail.anchorEntryId))) continue;
        const assistantIndex = positions.get(evidence.assistantEntryId);
        if (assistantIndex === undefined || !successfulAssistant(input.branch[assistantIndex]) || assistantIndex >= positions.get(entry.id)!) continue;
        if (evidence.nativeEntryIds.some((id: string, index: number) => {
          const at = positions.get(id), native = at === undefined ? undefined : input.branch[at];
          return typeof id !== "string" || at === undefined || at >= assistantIndex || native?.type !== "custom_message"
            || canonicalJsonV1({ customType: native.customType, content: native.content, display: native.display,
              ...(native.details !== undefined ? { details: native.details } : {}) }) !== canonicalJsonV1(terminal.mail.messages[index]);
        })) continue;
        const matched: string[] = [];
        for (const card of cards) {
          if (!card?.model_entry_id) continue;
          const messageIndex = evidence.nativeEntryIds.indexOf(card.model_entry_id), nativeIndex = positions.get(card.model_entry_id);
          if (messageIndex >= 0 && nativeIndex !== undefined && nativeIndex < assistantIndex && nativeCard(input.branch[nativeIndex], cardMessage(card))
            && canonicalJsonV1(terminal.mail.messages[messageIndex]) === canonicalJsonV1(cardMessage(card))) matched.push(card.inbox_id);
        }
        const key = terminal.mail.key, identity = canonicalJsonV1({ mail: terminal.mail, evidence });
        if (receipts.has(key) && receipts.get(key)!.identity !== identity) conflicts.add(key);
        else receipts.set(key, { identity, cards: matched });
        } catch { /* A malformed receipt cannot grant even a partial opportunity. */ }
      }
    }
    for (const [key, receipt] of receipts) if (!conflicts.has(key)) for (const id of receipt.cards) handled.add(id);
    return cards.every(card => handled.has(card!.inbox_id));
  }
  private completedRunCards(input: { readonly state: NormalizedStoreStateV1; readonly mainSessionId: string; readonly branch: readonly SessionEntry[] }): ReadonlySet<string> {
    return new Set(this.completedRunProofs(input).keys());
  }
  private completedRunProofs(input: { readonly state: NormalizedStoreStateV1; readonly mainSessionId: string; readonly branch: readonly SessionEntry[] }): ReadonlyMap<string, MainHandledCardV1> {
    const positions = new Map(input.branch.map((entry, index) => [entry.id, index]));
    const restored = new Map<string, MainHandledCardV1>();
    for (const entry of input.branch) {
      if (entry.type !== "custom" || entry.customType !== MAIN_RUN_COMPLETED_CUSTOM_TYPE) continue;
      const data = entry.data as CompletedMainRun | undefined;
      if (typeof data?.sessionId === "string" && data.sessionId !== input.mainSessionId) continue;
      if (data && this.#unpersistedRuns.has(data.assistantEntryId)) continue;
      if (data?.version !== 1 || data.sessionId !== input.mainSessionId || typeof data.assistantEntryId !== "string" || !Array.isArray(data.cards)) throw new Error("invalid Main successful-run observation");
      const assistantIndex = positions.get(data.assistantEntryId);
      if (assistantIndex === undefined || !successfulAssistant(input.branch[assistantIndex]) || assistantIndex >= positions.get(entry.id)!) throw new Error("Main successful-run assistant is not on its original branch");
      const validated: MainHandledCardV1[] = [];
      for (const proof of data.cards) {
        if (!proof || typeof proof.inboxId !== "string" || typeof proof.entryId !== "string") throw new Error("invalid Main successful-run card observation");
        const inbox = input.state.root.inbox.find(item => item.inbox_id === proof.inboxId);
        if (!inbox) continue;
        const nativeIndex = positions.get(proof.entryId);
        if (proof.completionId !== inbox.completion_id || proof.projectionSha256 !== inbox.projection.projection_sha256
          || inbox.model_entry_id && inbox.model_entry_id !== proof.entryId || nativeIndex === undefined || nativeIndex >= assistantIndex
          || !nativeCard(input.branch[nativeIndex], cardMessage(inbox))) throw new Error("Main successful-run card differs from its source projection");
        validated.push({ inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, entry_id: proof.entryId,
          projection_sha256: proof.projectionSha256, run_entry_id: entry.id, run_sha256: sha256CanonicalV1(data), assistant_entry_id: data.assistantEntryId });
      }
      for (const card of validated) if (!restored.has(card.inbox_id)) restored.set(card.inbox_id, card);
    }
    return restored;
  }
  /** Read-only exact successful-run evidence; live/transport opportunities are excluded. */
  handlingProof(input: { readonly state: NormalizedStoreStateV1; readonly mainSessionId: string; readonly branch: readonly SessionEntry[]; readonly outbox: OutboxRecordV1 }): OutboxHandlingProofV1 | undefined {
    if (input.outbox.recipient.kind !== "main" || input.outbox.recipient.session_id !== input.mainSessionId) return;
    const proofs = this.completedRunProofs(input);
    const cards = input.outbox.completion_ids.map(id => {
      const inbox = input.state.root.inbox.find(item => item.completion_id === id);
      return inbox && proofs.get(inbox.inbox_id);
    });
    if (!cards.length || cards.some(card => !card)) return;
    return { version: 1, session_id: input.mainSessionId, wake_epoch: input.outbox.wake_epoch, cards: cards as MainHandledCardV1[] };
  }
  /** Caller owns the per-Outbox driver. This FIFO also waits for observation fsync. */
  settleHandled(input: { readonly host: Pick<AgentHostCoreV1, "snapshot" | "binding_generation" | "recordOutboxNative" | "settleOutboxHandled">;
    readonly mainSessionId: string; readonly outboxId: string; readonly branch: () => readonly SessionEntry[]; readonly at: string }): Promise<boolean> {
    const generation = input.host.binding_generation;
    return this.serialize(async () => {
      const state = input.host.snapshot(), outbox = [state.root, ...state.agents].flatMap(partition => partition.outbox).find(item => item.outbox_id === input.outboxId);
      if (!outbox) return false;
      if (outbox.state === "handled") return true;
      if (!["pending", "delivering", "cards-appended"].includes(outbox.state)) return false;
      const proof = this.handlingProof({ state, mainSessionId: input.mainSessionId, branch: input.branch(), outbox });
      if (!proof) return false;
      // Old epoch-zero source can observe already-native cards without opening a Wake.
      const recorded = await input.host.recordOutboxNative({ outboxId: outbox.outbox_id, wakeEpoch: outbox.wake_epoch,
        sessionId: input.mainSessionId, bindingGeneration: generation, at: input.at,
        cards: proof.cards.map(card => ({ inboxId: card.inbox_id, completionId: card.completion_id, entryId: card.entry_id, projectionSha256: card.projection_sha256 })) });
      if (!recorded.ok) throw new Error(recorded.error.message);
      // Recheck the original active branch after the source writer yielded.
      const currentProof = this.handlingProof({ state: input.host.snapshot(), mainSessionId: input.mainSessionId, branch: input.branch(), outbox });
      if (!currentProof || canonicalJsonV1(currentProof) !== canonicalJsonV1(proof)) throw new Error("Main handling proof scope changed");
      const result = await input.host.settleOutboxHandled({ outboxId: outbox.outbox_id, expectedEpoch: outbox.wake_epoch,
        bindingGeneration: generation, proof, at: input.at });
      if (!result.ok) throw new Error(result.error.message);
      return true;
    });
  }
  settle(input: { readonly host: Pick<AgentHostCoreV1, "snapshot" | "settleOutboxTurn">; readonly mainSessionId: string; readonly at: string; readonly branch?: readonly SessionEntry[]; readonly report?: (error: unknown) => void }): Promise<readonly string[]> {
    return this.serialize(async () => {
      const state = input.host.snapshot();
      if (input.branch) for (const inboxId of this.completedRunCards({ state, mainSessionId: input.mainSessionId, branch: input.branch })) this.#handled.add(inboxId);
      if (this.#handled.size === 0) return [];
      const inboxByCompletion = new Map([state.root, ...state.agents].flatMap((partition) => partition.inbox).map((inbox) => [inbox.completion_id, inbox] as const));
      const settled: string[] = [];
      for (const outbox of pendingTurnOutboxesV1(state, input.mainSessionId)) {
        const turn = outbox.turn_settlement!;
        const cards = outbox.completion_ids.map((completionId) => inboxByCompletion.get(completionId)?.inbox_id);
        if (cards.some((inboxId) => inboxId === undefined || !this.#handled.has(inboxId))) continue;
        const result = await input.host.settleOutboxTurn({ outboxId: outbox.outbox_id, wakeEpoch: turn.wake_epoch, continuationIdentity: turn.continuation_identity, at: input.at });
        if (!result.ok) { input.report?.(new Error(result.error.message)); continue; }
        settled.push(outbox.outbox_id);
        for (const inboxId of cards) if (inboxId !== undefined) { this.#handled.delete(inboxId); this.#opportunities.delete(inboxId); }
      }
      return settled;
    });
  }
}
