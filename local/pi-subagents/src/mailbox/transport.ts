import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  bindMailbox, MAILBOX_CUSTOM_TYPES, MailboxError,
  type Mail, type MailboxBinding, type MailboxCallbackFence, type MailboxTarget,
  type NativeEntryRef, type NativeMailMessage, type ProducerEndpoint, type LegacyFulfilledProof,
  type ProducerRegistration, type PutResult, type CurrentDecision,
} from "pi-session-inject/mailbox-v1/light";
import { canonicalJsonV1 } from "../persistence/canonical.js";

export class DeliveryPending extends Error {
  constructor() { super("Subagent delivery is durably owned by mailbox; native proof is pending"); }
}

/** Compare the original carrier, including its original ID/hash, without adding metadata. */
export function proveSubagentMail(mail: Mail, branch: readonly SessionEntry[]): readonly NativeEntryRef[] {
  const entries: NativeEntryRef[] = [];
  for (const [messageIndex, message] of mail.messages.entries()) {
    const details = message.details as Record<string, unknown>;
    const matches = branch.filter(entry => {
      if (entry.type !== "custom_message" || entry.customType !== message.customType || !entry.details || typeof entry.details !== "object") return false;
      const actual = entry.details as Record<string, unknown>;
      if (message.customType === "subagent-mailbox-v1") return actual.message_id === details.message_id;
      if (message.customType === "subagent-completion-v1") return actual.inbox_id === details.inbox_id;
      if (message.customType === "subagent-continuation-v1") return actual.outbox_id === details.outbox_id && actual.wake_epoch === details.wake_epoch;
      throw new Error("unsupported Subagent mailbox carrier");
    });
    if (matches.length > 1) throw new Error("duplicate Subagent native carrier");
    const entry = matches[0];
    if (!entry || entry.type !== "custom_message") continue;
    if (canonicalJsonV1(entry.content) !== canonicalJsonV1(message.content)
      || canonicalJsonV1(entry.details) !== canonicalJsonV1(message.details) || entry.display !== message.display)
      throw new Error("Subagent native carrier conflicts with frozen ID/hash/content");
    entries.push({ messageIndex, entryId: entry.id });
  }
  return entries;
}

interface SourceOrigin { entryId: string | null; anchorEntryId: string | null; generation?: number; witness: "anchor" | "intent" | "accepted" }

type Callbacks = Omit<ProducerRegistration, "id" | "proveNative">;
export interface MailboxSubmit {
  readonly key: string;
  readonly messages: readonly NativeMailMessage[];
  readonly wake: boolean;
  readonly policy?: Mail["policy"];
  readonly legacyWakeUnknown?: boolean;
  readonly recovered?: boolean;
}

/** One registration per runner; Main and SDK child have distinct session slots.
 * Source loops may repeat put, but never own a native queue or a resend timer.
 */
export class SubagentMailboxTransport {
  readonly endpoint: ProducerEndpoint;
  readonly binding: MailboxBinding;
  readonly agentDir: string;
  readonly pi: ExtensionAPI;
  #ctx?: ExtensionContext;
  #sessionId?: string;
  #unknownWake = new Set<string>();
  #sourceIntents = new Set<string>();
  #origins = new Map<string, SourceOrigin>();
  #mails = new Map<string, Mail>();
  #accepted = new Set<string>();
  #recovered = new Set<string>();
  #recoveredPending = new Set<string>();
  #recoveredPrefixes = new Set<string>();
  #ingress = new Set<{ key: string; target: MailboxTarget; promise: Promise<unknown> }>();
  #ready: Promise<void> = Promise.resolve();
  constructor(pi: ExtensionAPI, agentDir: string, callbacks: Callbacks,
    bind: typeof bindMailbox = bindMailbox) {
    this.agentDir = agentDir;
    this.pi = pi;
    this.binding = bind(pi, { agentDir });
    this.endpoint = this.binding.registerProducer({ id: "pi-subagents", capabilities: { activateNewExecution: true }, ...callbacks,
      proveNative: (mail, branch) => {
        try { return { kind: "observed", entries: proveSubagentMail(mail, branch) }; }
        catch (error) { return { kind: "conflict", reason: String(error) }; }
      },
    });
    pi.on("session_start", (_event, ctx) => { this.bindContext(ctx); return this.#ready; });
    pi.on("session_shutdown", () => { this.#ctx = undefined; });
  }
  bindContext(ctx: ExtensionContext): Promise<void> {
    if (this.#ctx?.sessionManager === ctx.sessionManager && this.#sessionId === ctx.sessionManager.getSessionId()) { this.#ctx = ctx; return this.#ready; }
    this.#ctx = ctx;
    this.#sessionId = ctx.sessionManager.getSessionId();
    this.#mails = new Map();
    this.#accepted = new Set();
    this.#unknownWake = new Set(); this.#sourceIntents = new Set(); this.#origins = new Map(); this.#recovered = new Set(); this.#recoveredPrefixes = new Set(); this.#recoveredPending = new Set();
    this.#ready = this.restore(ctx, this.#mails, this.#accepted, this.#unknownWake, this.#sourceIntents, this.#origins, this.#recovered, this.#recoveredPending);
    return this.#ready;
  }
  private async restore(ctx: ExtensionContext, mails: Map<string, Mail>, accepted: Set<string>, unknownWake: Set<string>, sourceIntents: Set<string>, origins: Map<string, SourceOrigin>, recovered: Set<string>, pending: Set<string>): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId(), entries = ctx.sessionManager.getEntries();
    const remember = (mail: Mail): void => {
      if (mail.producer !== "pi-subagents") return;
      const frozen: Mail = { producer: mail.producer, key: mail.key, anchorEntryId: mail.anchorEntryId, policy: mail.policy, wake: mail.wake, messages: mail.messages };
      const old = mails.get(mail.key);
      if (old && canonicalJsonV1(old) !== canonicalJsonV1(frozen)) throw new Error("conflicting Subagent mailbox history");
      mails.set(mail.key, frozen); recovered.add(mail.key);
    };
    // This is the public persisted schema, read-only. It preserves the original
    // anchor when put succeeded but the source never received its response.
    try {
      const snapshot = await readFile(join(this.agentDir, "mailbox", "v1", sessionId, "pending.json"), "utf8");
      const { parseMailboxSnapshot } = await import("pi-session-inject/mailbox-v1");
      const value = parseMailboxSnapshot(JSON.parse(snapshot));
      if (value.session.id !== sessionId) throw new Error("Subagent mailbox snapshot session mismatch");
      for (const record of value.pending) { remember(record); if (record.producer === "pi-subagents") pending.add(record.key); accepted.add(record.key); origins.set(record.key, { entryId: record.branchEntryId ?? record.anchorEntryId, anchorEntryId: record.anchorEntryId, witness: "accepted" }); }
      for (const record of value.terminal) { remember(record.mail); accepted.add(record.mail.key); origins.set(record.mail.key, { entryId: record.branchEntryId ?? record.mail.anchorEntryId, anchorEntryId: record.mail.anchorEntryId, witness: "accepted" }); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Intent identity survives tree/runner replacement even off the active
    // branch. Restoring it is not projection permission: assertOrigin and A
    // still require its original scope before any unaccepted admission.
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "subagent-mailbox-intent-v1") {
        const intent = entry.data as { version?: unknown; sessionId?: unknown; mail?: Mail; legacyWakeUnknown?: boolean };
        if (typeof intent?.sessionId === "string" && intent.sessionId !== sessionId) continue;
        if (intent.version !== 1 || intent.sessionId !== sessionId || !intent.mail) throw new Error("invalid Subagent mailbox source intent");
        remember(intent.mail); sourceIntents.add(intent.mail.key); origins.set(intent.mail.key, { entryId: entry.id, anchorEntryId: intent.mail.anchorEntryId, witness: "intent" });
        if (intent.legacyWakeUnknown) unknownWake.add(intent.mail.key);
      }
      if (entry.type !== "custom" || entry.customType !== MAILBOX_CUSTOM_TYPES.delivery) continue;
      const receipt = entry.data as { version?: unknown; sessionId?: unknown; terminals?: { mail: Mail }[] };
      if (typeof receipt?.sessionId === "string" && receipt.sessionId !== sessionId) continue;
      if (receipt?.version !== 1 || receipt.sessionId !== sessionId || !Array.isArray(receipt.terminals)) throw new Error("invalid mailbox delivery history");
      for (const terminal of receipt.terminals) { remember(terminal.mail); accepted.add(terminal.mail.key); pending.delete(terminal.mail.key); }
    }
  }
  capture(): { ctx: ExtensionContext; target: MailboxTarget } {
    if (!this.#ctx) throw new Error("Subagent mailbox session is unavailable");
    return { ctx: this.#ctx, target: this.endpoint.target(this.#ctx) };
  }
  current(fence: MailboxCallbackFence): boolean {
    if (!this.#ctx) return false;
    const target = this.endpoint.target(this.#ctx);
    return target.slotKey === fence.slotKey && target.bindingGeneration === fence.bindingGeneration
      && target.producerToken === fence.producerToken;
  }
  put(input: MailboxSubmit): Promise<{ result: PutResult; mail: Mail; entries: readonly NativeEntryRef[] }> {
    const captured = this.capture();
    if (!this.#origins.has(input.key)) this.#origins.set(input.key, { entryId: captured.ctx.sessionManager.getLeafId(),
      anchorEntryId: this.legacyAnchor(captured.ctx, input.messages), generation: captured.target.bindingGeneration, witness: "anchor" });
    const promise = this.putCaptured(input, captured);
    const ingress = { key: input.key, target: captured.target, promise };
    this.#ingress.add(ingress);
    void promise.then(() => this.#ingress.delete(ingress), () => this.#ingress.delete(ingress));
    return promise;
  }
  private async putCaptured(input: MailboxSubmit, { ctx, target }: { ctx: ExtensionContext; target: MailboxTarget }): Promise<{ result: PutResult; mail: Mail; entries: readonly NativeEntryRef[] }> {
    await this.#ready;
    const current = this.capture();
    if (current.ctx !== ctx || current.target.slotKey !== target.slotKey || current.target.bindingGeneration !== target.bindingGeneration)
      throw new Error("Subagent mailbox scope changed during source preparation");
    const old = this.#mails.get(input.key);
    if (!this.#accepted.has(input.key)) this.assertOrigin(input.key, ctx, target);
    const messages = JSON.parse(JSON.stringify(input.messages)) as NativeMailMessage[];
    const mail: Mail = old ?? { producer: "pi-subagents", key: input.key,
      anchorEntryId: this.#origins.get(input.key)!.anchorEntryId, policy: input.policy ?? "next-request", wake: input.wake, messages };
    if (old && (canonicalJsonV1(old.messages) !== canonicalJsonV1(messages) || old.policy !== (input.policy ?? "next-request")))
      throw new Error("Subagent mailbox key conflicts with frozen source payload");
    this.#mails.set(mail.key, mail);
    const persistIntent = () => {
      if (this.#sourceIntents.has(mail.key)) return;
      this.pi.appendEntry("subagent-mailbox-intent-v1", { version: 1, sessionId: target.session.id, mail, ...(input.legacyWakeUnknown ? { legacyWakeUnknown: true } : {}) });
      this.#sourceIntents.add(mail.key);
      this.#origins.set(mail.key, { entryId: ctx.sessionManager.getLeafId(), anchorEntryId: mail.anchorEntryId, witness: "intent" });
    };
    // A null anchor must be accepted while the branch is still empty. The
    // durable A snapshot then backs the source intent if its append reply is lost.
    if (mail.anchorEntryId !== null && this.ownsOrigin(mail.key, ctx, target)) persistIntent();
    if (input.legacyWakeUnknown) this.#unknownWake.add(mail.key);
    if (input.recovered) this.#recovered.add(mail.key);
    const result = this.isRecovered(mail.key)
      ? await this.endpoint.put(mail, target, { recovered: true }) : await this.endpoint.put(mail, target);
    if (this.#ctx === ctx && this.#sessionId === target.session.id) {
      this.#accepted.add(mail.key);
      const current = this.capture();
      if (mail.anchorEntryId === null && current.target.bindingGeneration === target.bindingGeneration) persistIntent();
    }
    return { result, mail, entries: proveSubagentMail(mail, ctx.sessionManager.getBranch()) };
  }
  private ownsOrigin(key: string, ctx: ExtensionContext, target: MailboxTarget): boolean {
    const origin = this.#origins.get(key);
    if (!origin) return false;
    const branch = ctx.sessionManager.getBranch();
    if (origin.witness === "anchor" && origin.generation !== target.bindingGeneration)
      return ctx.sessionManager.getLeafId() === origin.entryId;
    if (origin.entryId === null) return branch.length === 0;
    return branch.some(entry => entry.id === origin.entryId);
  }
  private assertOrigin(key: string, ctx: ExtensionContext, target: MailboxTarget): void {
    if (!this.ownsOrigin(key, ctx, target)) throw new MailboxError("stale-binding", "Subagent mailbox origin scope is not active; retain the original intent");
  }
  private legacyAnchor(ctx: ExtensionContext, messages: readonly NativeMailMessage[]): string | null {
    const branch = ctx.sessionManager.getBranch();
    const proof = proveSubagentMail({ producer: "pi-subagents", key: "legacy", anchorEntryId: null, policy: "next-request", wake: false, messages }, branch);
    const first = proof[0] && branch.find(entry => entry.id === proof[0]!.entryId);
    return first ? first.parentId : ctx.sessionManager.getLeafId();
  }
  async cancelPrefix(prefix: string, reason: string): Promise<void> {
    const { ctx, target } = this.capture();
    await Promise.allSettled([...this.#ingress].filter(item => item.target.slotKey === target.slotKey && item.key.startsWith(prefix)).map(item => item.promise));
    for (const key of this.#mails.keys()) if (key.startsWith(prefix)) {
      this.assertOrigin(key, ctx, target);
      try { await this.endpoint.cancel(key, reason, target); }
      catch (error) {
        if ((error as { code?: string }).code !== "unknown-key") throw error;
        // A lost put reply is not absence. Even a never-accepted source intent
        // gets the same durable tombstone before its Task authority is revoked.
        if (this.isRecovered(key)) await this.endpoint.put(this.#mails.get(key)!, target, { recovered: true });
        else await this.endpoint.put(this.#mails.get(key)!, target);
        await this.endpoint.cancel(key, reason, target);
      }
    }
  }
  async activateNewExecution(): Promise<void> {
    const { target } = this.capture();
    await this.#ready;
    await this.endpoint.activateNewExecution(target);
  }
  /** Cold hold suppresses A's selection guard. Retire only our restored pending
   * keys whose original source authority has ended; never release that hold. */
  async cancelRecovered(check: (mail: Mail) => CurrentDecision): Promise<void> {
    const { ctx, target } = this.capture(), pending = this.#recoveredPending, mails = this.#mails;
    await this.#ready;
    for (const key of pending) {
      const current = this.capture();
      if (current.ctx !== ctx || current.target.bindingGeneration !== target.bindingGeneration) throw new Error("Subagent mailbox binding changed during recovery cancellation");
      const mail = mails.get(key)!;
      const decision = check(mail);
      if (decision.kind !== "cancel") continue;
      this.assertOrigin(key, ctx, target);
      await this.endpoint.cancel(key, decision.reason, target);
      pending.delete(key);
    }
  }
  legacyWakeUnknown(key: string): boolean { return this.#unknownWake.has(key) || !this.#sourceIntents.has(key) && this.#mails.get(key)?.wake !== true; }
  hasAccepted(key: string): boolean { return this.#accepted.has(key); }
  /** A recovered source may not have allocated its first Wake epoch yet. */
  markRecoveredPrefix(prefix: string): void { this.#recoveredPrefixes.add(prefix); }
  private isRecovered(key: string): boolean { return this.#recovered.has(key) || [...this.#recoveredPrefixes].some(prefix => key.startsWith(prefix)); }
  frozen(key: string): Mail | undefined { return this.#mails.get(key); }
  knownMails(): readonly Mail[] { return [...this.#mails.values()]; }
  async recheckPrefix(prefix: string): Promise<void> {
    await this.#ready;
    for (const mail of this.#mails.values()) if (mail.key.startsWith(prefix)) await this.put(mail);
  }
  async importFulfilled(input: MailboxSubmit, proof: LegacyFulfilledProof): Promise<void> {
    const { ctx, target } = this.capture();
    await this.#ready;
    const mail = this.#mails.get(input.key) ?? { producer: "pi-subagents" as const, key: input.key,
      anchorEntryId: this.legacyAnchor(ctx, input.messages), policy: input.policy ?? "next-request", wake: input.wake, messages: input.messages };
    this.#mails.set(mail.key, mail);
    await this.endpoint.importFulfilled(mail, proof, target);
    if (this.#ctx === ctx && this.#sessionId === target.session.id) this.#accepted.add(mail.key);
  }
  async cancel(key: string, reason: string): Promise<void> {
    const { ctx, target } = this.capture();
    await this.#ready;
    this.assertOrigin(key, ctx, target);
    await this.endpoint.cancel(key, reason, target);
  }
  close(): void { this.endpoint.close(); this.binding.close(); this.#ctx = undefined; }
}
