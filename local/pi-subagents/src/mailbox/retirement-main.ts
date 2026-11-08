import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAILBOX_ABI_VERSION, MAILBOX_CUSTOM_TYPES, MAILBOX_HOLDER_KEY, MAILBOX_TRANSPORT_BUILD_ID,
  type Mail, type MailboxDeliveryReceipt, type MailboxHolder, type MailboxSessionSlot, type MailboxSnapshot, type TerminalEvidence } from "pi-session-inject/mailbox-v1/light";
import { canonicalJsonV1 } from "../persistence/canonical.js";
import type { NormalizedStoreStateV1, OutboxRecordV1 } from "../persistence/types.js";
import type { SubagentMailboxTransport } from "./transport.js";

export interface MainMailboxReadContextV1 {
  readonly agentDirectory: string;
  readonly session: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getEntries">;
  readonly transport?: Pick<SubagentMailboxTransport, "knownMails" | "hasAccepted">;
}
export type MailRetirementKind = "handoff-needed" | "handed-off" | "retired" | "unknown";
export interface MainMailFact { readonly kind: MailRetirementKind; readonly mail: Mail; readonly evidence?: TerminalEvidence; readonly reason?: string }
export interface MainOutboxMailFact {
  readonly kind: MailRetirementKind; readonly mails: readonly MainMailFact[]; readonly reason?: string;
  readonly cards: ReadonlyMap<string, { readonly message: Mail["messages"][number]; readonly entryId: string }>;
}
interface ReceiptIndex {
  readonly receipts: ReadonlyMap<string, { readonly mail: Mail; readonly evidence: TerminalEvidence }>;
  readonly conflicts: ReadonlySet<string>;
}
interface ReadCache { readonly directoryInput: string; readonly directory: string; readonly file: string; readonly sessionId: string;
  readonly slot: MailboxSessionSlot; readonly generation: number; readonly length: number; readonly lastId: string | undefined; readonly index: ReceiptIndex }
// Only immutable, disk-validated A receipts are cached, never a D completion or
// ACK decision. Checkpoint/deletion always bypass this read cache and reread disk.
const receiptReads = new WeakMap<object, ReadCache>();
const identity = (mail: Pick<Mail, "producer" | "key">) => JSON.stringify([mail.producer, mail.key]);
const same = (a: unknown, b: unknown) => a === b || canonicalJsonV1(a) === canonicalJsonV1(b);
const cardDetails = (message: Mail["messages"][number]) => message.customType === "subagent-completion-v1"
  ? message.details as { inbox_id?: string; completion_id?: string; projection_sha256?: string } | undefined : undefined;
function nativeMessage(entry: Extract<SessionEntry, { type: "custom_message" }>) {
  return { customType: entry.customType, content: entry.content, display: entry.display, ...(entry.details === undefined ? {} : { details: entry.details }) };
}
async function readReceipts(file: string, sessionId: string): Promise<ReceiptIndex> {
  const { parseMailboxSnapshot } = await import("pi-session-inject/mailbox-v1");
  const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (rows[0]?.type !== "session" || rows[0]?.id !== sessionId) throw new Error("原会话身份无法验证");
  const entries = rows.slice(1) as SessionEntry[], byId = new Map(entries.map(entry => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error("会话条目身份冲突");
  const ancestor = (id: string | null, leaf: string) => {
    if (id === null) return true;
    const seen = new Set<string>(); let current: string | null = leaf;
    while (current !== null) {
      if (seen.has(current)) throw new Error("原 receipt 分支存在循环");
      seen.add(current); const entry = byId.get(current);
      if (!entry) throw new Error("原 receipt 分支无法验证");
      if (current === id) return true;
      current = entry.parentId;
    }
    return false;
  };
  const receipts = new Map<string, { mail: Mail; evidence: TerminalEvidence }>(), conflicts = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MAILBOX_CUSTOM_TYPES.delivery) continue;
    const data = entry.data as MailboxDeliveryReceipt;
    if (data?.sessionId !== sessionId) continue;
    if (data.version !== 1 || !Array.isArray(data.terminals)) throw new Error("原 receipt 格式无法验证");
    for (const item of data.terminals) {
      const evidence = item.evidence.outcome === "fulfilled" ? { ...item.evidence, receiptEntryId: entry.id } : item.evidence;
      // Shape validation only; ACK/GC comes from absence in the committed live
      // and disk snapshots, never from these parser scaffolding fields.
      const record = parseMailboxSnapshot({ version: 1, session: { id: sessionId, file }, revision: 0, suspended: null, pending: [], terminal: [{
        mail: item.mail, branchEntryId: item.branchEntryId, evidence, requiredCallbacks: { recorded: false, terminal: false },
        recorded: null, terminalAck: "acknowledged", backingReceiptEntryId: entry.id,
      }] }).terminal[0]!;
      if (!ancestor(record.branchEntryId ?? record.mail.anchorEntryId, entry.id)) throw new Error("原 receipt scope 不一致");
      if (record.evidence.outcome === "fulfilled") {
        const proof = record.evidence, assistant = byId.get(proof.assistantEntryId);
        if (assistant?.type !== "message" || assistant.message.role !== "assistant" || ["error", "aborted"].includes(assistant.message.stopReason)
          || !ancestor(assistant.id, entry.id) || !ancestor(record.mail.anchorEntryId, assistant.id)) throw new Error("原请求机会无法验证");
        for (const [index, id] of proof.nativeEntryIds.entries()) {
          const native = byId.get(id);
          if (native?.type !== "custom_message" || !ancestor(id, assistant.id) || !same(nativeMessage(native), record.mail.messages[index])) throw new Error("原 native 证明不一致");
        }
      }
      const key = identity(record.mail), previous = receipts.get(key);
      if (previous && (!same(previous.mail, record.mail) || !same(previous.evidence, record.evidence))) conflicts.add(key);
      else receipts.set(key, { mail: record.mail, evidence: record.evidence });
    }
  }
  return { receipts, conflicts };
}

export class MainMailboxRetirement {
  readonly #context?: MainMailboxReadContextV1;
  readonly #slot?: MailboxSessionSlot;
  readonly #generation?: number;
  readonly #index: ReceiptIndex;
  readonly #disk?: MailboxSnapshot;
  readonly #initial?: MailboxSnapshot;
  readonly #reason?: string;
  constructor(input: { context?: MainMailboxReadContextV1; slot?: MailboxSessionSlot; index?: ReceiptIndex; disk?: MailboxSnapshot; reason?: string }) {
    this.#context = input.context; this.#slot = input.slot; this.#generation = input.slot?.bindingGeneration;
    this.#index = input.index ?? { receipts: new Map(), conflicts: new Set() }; this.#disk = input.disk; this.#initial = input.slot?.snapshot; this.#reason = input.reason;
  }
  private live(): MailboxSnapshot | undefined {
    try {
    const context = this.#context, slot = this.#slot;
    const holder = (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for(MAILBOX_HOLDER_KEY)] as MailboxHolder | undefined;
    if (this.#reason || !context || !slot || slot.retired || !slot.owner || slot.bindingGeneration !== this.#generation
      || !holder || holder.version !== MAILBOX_ABI_VERSION || holder.transportBuildId !== MAILBOX_TRANSPORT_BUILD_ID
      || !(holder.slots instanceof Map) || holder.slots.get(slot.key) !== slot
      || slot.sessionManager !== context.session || slot.owner.ctx.sessionManager !== context.session
      || slot.session.id !== context.session.getSessionId() || slot.session.file !== context.session.getSessionFile()
      || slot.snapshot.session.id !== slot.session.id || slot.snapshot.session.file !== slot.session.file || slot.snapshot.suspended?.reason === "blocked") return;
    return slot.snapshot;
    } catch { return undefined; }
  }
  private snapshots(): readonly MailboxSnapshot[] { const live = this.live(); return live ? [this.#initial!, ...(this.#disk ? [this.#disk] : []), live] : []; }
  private known(): readonly Mail[] { return this.#context?.transport?.knownMails() ?? []; }
  key(producer: Mail["producer"], key: string): MainMailFact | undefined {
    const id = identity({ producer, key }), snapshots = this.snapshots();
    const mail = this.known().find(item => identity(item) === id)
      ?? snapshots.flatMap(snapshot => snapshot.terminal).find(item => identity(item.mail) === id)?.mail
      ?? snapshots.flatMap(snapshot => snapshot.pending).find(item => identity(item) === id)
      ?? this.#index.receipts.get(id)?.mail;
    return mail && this.mail(mail);
  }
  mail(mail: Mail): MainMailFact {
    const snapshots = this.snapshots(), key = identity(mail);
    if (!snapshots.length) return { kind: "unknown", mail, reason: this.#reason ?? "原 Main/Mailbox scope 尚未就绪" };
    const pending = snapshots.flatMap(snapshot => snapshot.pending).filter(item => identity(item) === key);
    const terminal = snapshots.flatMap(snapshot => snapshot.terminal).filter(item => identity(item.mail) === key);
    const receipt = this.#index.receipts.get(key), known = this.known().find(item => identity(item) === key);
    const frozen = (item: Mail): Mail => "acceptedRevision" in item ? { producer: item.producer, key: item.key, anchorEntryId: item.anchorEntryId, policy: item.policy, wake: item.wake, messages: item.messages } : item;
    if (this.#index.conflicts.has(key) || [...pending.map(frozen), ...terminal.map(item => item.mail), ...(receipt ? [receipt.mail] : []), ...(known ? [known] : [])].some(item => !same(item, frozen(mail))))
      return { kind: "unknown", mail, reason: "原 Mailbox key/payload/scope 冲突" };
    if (terminal.length) {
      const evidence = terminal[0]!.evidence;
      if (terminal.some(item => !same(item.evidence, evidence)) || receipt && !same(receipt.evidence, evidence)) return { kind: "unknown", mail, reason: "原 Mailbox 终态身份冲突" };
      return { kind: "handed-off", mail, evidence };
    }
    if (pending.length) return { kind: "handoff-needed", mail };
    if (receipt) return { kind: "retired", mail, evidence: receipt.evidence };
    if (known && mail.producer === "pi-subagents" && this.#context?.transport?.hasAccepted(mail.key)) return { kind: "unknown", mail, reason: "原 admission 缺少 snapshot/receipt 见证" };
    return { kind: "handoff-needed", mail };
  }
  outbox(state: NormalizedStoreStateV1, outbox: OutboxRecordV1): MainOutboxMailFact {
    const cards = new Map<string, { message: Mail["messages"][number]; entryId: string }>();
    if (!this.live() || outbox.recipient.kind !== "main" || outbox.recipient.session_id !== this.#context?.session.getSessionId())
      return { kind: "unknown", mails: [], cards, reason: this.#reason ?? "原 Main/Mailbox 尚未附着或 scope 不一致" };
    const ids = new Set<string>(outbox.completion_ids), inboxes = state.root.inbox.filter(inbox => ids.has(inbox.completion_id));
    const inboxIds = new Set<string>([...inboxes.map(inbox => inbox.inbox_id), ...(outbox.handling_proof?.cards.map(card => card.inbox_id) ?? [])]);
    const nativeIds = new Set([...inboxes.flatMap(inbox => inbox.model_entry_id ? [inbox.model_entry_id] : []), ...(outbox.handling_proof?.cards.map(card => card.entry_id) ?? [])]);
    let conflict: string | undefined;
    for (const [key, receipt] of this.#index.receipts) {
      if (receipt.mail.producer !== "pi-subagents" || receipt.evidence.outcome !== "fulfilled" || this.#index.conflicts.has(key)) continue;
      for (const [index, message] of receipt.mail.messages.entries()) {
        const details = cardDetails(message); if (!details?.completion_id || !ids.has(details.completion_id)) continue;
        const entryId = receipt.evidence.nativeEntryIds[index]!, inbox = inboxes.find(item => item.completion_id === details.completion_id);
        const handling = outbox.handling_proof?.cards.find(item => item.completion_id === details.completion_id);
        const expected = inbox && { customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
          details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } };
        if (inbox && (entryId !== inbox.model_entry_id || !same(message, expected)) || handling && (handling.entry_id !== entryId || handling.inbox_id !== details.inbox_id || handling.projection_sha256 !== details.projection_sha256)) {
          conflict = "原 source card 与 receipt 不一致"; continue;
        }
        const prior = cards.get(details.completion_id);
        if (prior && (prior.entryId !== entryId || !same(prior.message, message))) { conflict = "同一 Completion 的原 card 证据冲突"; continue; }
        cards.set(details.completion_id, { message, entryId }); if (details.inbox_id) inboxIds.add(details.inbox_id); nativeIds.add(entryId);
      }
    }
    const all = new Map<string, { mail: Mail; nativeIds: readonly string[] }>();
    const add = (mail: Mail, refs: readonly string[] = []) => { const key = identity(mail), old = all.get(key); all.set(key, { mail, nativeIds: [...(old?.nativeIds ?? []), ...refs] }); };
    for (const receipt of this.#index.receipts.values()) add(receipt.mail, receipt.evidence.outcome === "fulfilled" ? receipt.evidence.nativeEntryIds : []);
    for (const snapshot of this.snapshots()) {
      for (const pending of snapshot.pending) add(pending, pending.nativeEntries.map(item => item.entryId));
      for (const terminal of snapshot.terminal) add(terminal.mail, [...(terminal.recorded?.notice.entries.map(item => item.entryId) ?? []), ...(terminal.evidence.outcome === "fulfilled" ? terminal.evidence.nativeEntryIds : [])]);
    }
    for (const known of this.known()) add(known);
    const related = [...all.values()].filter(({ mail, nativeIds: refs }) => mail.producer === "pi-subagents" && (mail.key.startsWith(`outbox:${outbox.outbox_id}:`) || [...inboxIds].some(id => mail.key === `card:${id}`))
      || refs.some(id => nativeIds.has(id)) || mail.messages.some(message => { const details = cardDetails(message); return details && (ids.has(details.completion_id ?? "") || inboxIds.has(details.inbox_id as never)); }));
    const mails = related.map(item => this.mail(item.mail));
    const unknown = mails.find(item => item.kind === "unknown");
    if (conflict || unknown) return { kind: "unknown", mails, cards, reason: conflict ?? unknown!.reason };
    if (mails.some(item => item.kind === "handoff-needed")) return { kind: "handoff-needed", mails, cards };
    if (mails.some(item => item.kind === "handed-off")) return { kind: "handed-off", mails, cards };
    if (outbox.completion_ids.every(id => cards.has(id)) && mails.length) return { kind: "retired", mails, cards };
    return { kind: inboxes.length === outbox.completion_ids.length ? "handoff-needed" : "unknown", mails, cards, reason: "原 card 缺少可验证的退休 receipt" };
  }
  retiredOutboxes(state: NormalizedStoreStateV1): ReadonlySet<string> {
    return new Set([state.root, ...state.agents].flatMap(partition => partition.outbox).filter(outbox => outbox.recipient.kind === "main" && this.outbox(state, outbox).kind === "retired").map(outbox => outbox.outbox_id));
  }
}

/** One read per checkpoint/pass. Only public A holder/slot fields are observed. */
export async function readMainMailboxRetirement(context: MainMailboxReadContextV1 | undefined, fresh = false): Promise<MainMailboxRetirement> {
  if (!context) return new MainMailboxRetirement({ reason: "原 Main 尚未附着" });
  try {
    const sessionId = context.session.getSessionId(), file = context.session.getSessionFile();
    if (!file) throw new Error("原会话没有持久文件");
    const previous = receiptReads.get(context.session);
    const directory = previous?.directoryInput === context.agentDirectory ? previous.directory : await realpath(context.agentDirectory);
    const holder = (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for(MAILBOX_HOLDER_KEY)] as MailboxHolder | undefined;
    if (!holder || holder.version !== MAILBOX_ABI_VERSION || holder.transportBuildId !== MAILBOX_TRANSPORT_BUILD_ID || !(holder.slots instanceof Map) || typeof holder.bind !== "function") throw new Error("Mailbox holder 不可验证");
    const slot = holder.slots.get(JSON.stringify([directory, sessionId]));
    if (!slot || slot.retired || !slot.owner || slot.sessionManager !== context.session || slot.owner.ctx.sessionManager !== context.session
      || slot.session.id !== sessionId || slot.session.file !== file || slot.snapshot.session.id !== sessionId || slot.snapshot.session.file !== file
      || slot.snapshot.suspended?.reason === "blocked") throw new Error("Mailbox slot/session 尚未就绪");
    const generation = slot.bindingGeneration, entries = context.session.getEntries(), length = entries.length, lastId = entries.at(-1)?.id;
    const reusable = !fresh && previous?.slot === slot && previous.generation === generation && previous.file === file && previous.sessionId === sessionId && previous.length === length && previous.lastId === lastId;
    let disk: MailboxSnapshot | undefined;
    if (fresh || !reusable) {
      const { parseMailboxSnapshot } = await import("pi-session-inject/mailbox-v1");
      try { disk = parseMailboxSnapshot(JSON.parse(await readFile(join(directory, "mailbox/v1", sessionId, "pending.json"), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (disk && (disk.session.id !== sessionId || disk.session.file !== file || slot.snapshot.revision === 0 && disk.revision > 0)) throw new Error("Mailbox snapshot 恢复尚未完成或身份冲突");
    }
    const index = reusable ? previous.index : await readReceipts(file, sessionId);
    if (holder.slots.get(slot.key) !== slot || slot.retired || slot.bindingGeneration !== generation || context.session.getSessionId() !== sessionId || context.session.getSessionFile() !== file) throw new Error("Mailbox scope 在读取期间变化");
    receiptReads.set(context.session, { directoryInput: context.agentDirectory, directory, file, sessionId, slot, generation, length, lastId, index });
    return new MainMailboxRetirement({ context, slot, index, disk });
  } catch (error) { return new MainMailboxRetirement({ context, reason: error instanceof Error ? error.message : String(error) }); }
}
