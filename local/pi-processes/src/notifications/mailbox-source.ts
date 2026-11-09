import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindMailbox, type Mail, type MailPolicy, type MailboxCallbackFence, type ProducerCallbacks, type ProducerEndpoint, type PutResult, type RecordedNotice, type TerminalEvidence } from "pi-session-inject/mailbox-v1/light";
import { canonicalProcessNotificationValueV1, processNotificationBatchMessageV1, validProcessNotificationBatchCarrierV1 } from "./main-context.js";
import { PROCESS_NOTIFICATION_STATUS_TYPE, processNotificationStatusV1, proveProcessMailV1 } from "./mailbox-proof.js";
import type { ProcessNotificationBatchV1 } from "./types.js";

/** Source identity only. Transport retries remain exclusively owned by mailbox. */
export const PROCESS_NOTIFICATION_INTENT_TYPE = "process-notification-intent-v1" as const;
export interface ProcessNotificationIntentV1 {
  readonly version: 1;
  readonly sessionScopeId: string;
  readonly mail: Mail;
  readonly child?: { readonly ownerToken: string; readonly continuationSignal: boolean };
}

export function readProcessMailIntentsV1(entries: readonly unknown[], sessionId: string): Map<string, Mail> {
  const result = new Map<string, Mail>();
  const identities = new Map<string, string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== PROCESS_NOTIFICATION_INTENT_TYPE) continue;
    const intent = entry.data as ProcessNotificationIntentV1 | undefined;
    if (intent?.sessionScopeId !== sessionId) continue;
    const mail = intent.mail;
    if (intent.version !== 1 || mail?.producer !== "pi-processes" || !Array.isArray(mail.messages) || mail.messages.length !== 1
      || !validProcessNotificationBatchCarrierV1(mail.messages[0]!, sessionId) || mail.key !== `batch:${mail.messages[0]!.details.batchId}`
      || !["next-request", "next-user"].includes(mail.policy) || typeof mail.wake !== "boolean"
      || (mail.anchorEntryId !== null && typeof mail.anchorEntryId !== "string")) throw new Error("Invalid process mailbox source intent");
    if (intent.child !== undefined && (!intent.child || typeof intent.child.ownerToken !== "string" || !intent.child.ownerToken || Buffer.byteLength(intent.child.ownerToken) > 512 || typeof intent.child.continuationSignal !== "boolean" || mail.messages[0]!.details.reason !== "subagent-admission")) throw new Error("Invalid child Process mailbox authority");
    const existing = result.get(mail.key);
    const identity = canonicalProcessNotificationValueV1({ mail, child: intent.child ?? null });
    if (existing && identities.get(mail.key) !== identity) throw new Error("Conflicting process mailbox source intents");
    identities.set(mail.key, identity);
    result.set(mail.key, mail);
  }
  return result;
}

export class ProcessMailboxSourceV1 {
  readonly endpoint: ProducerEndpoint;
  readonly #pi: ExtensionAPI;
  readonly #getContext: () => ExtensionContext | undefined;
  readonly #binding: ReturnType<typeof bindMailbox>;
  readonly #recoveredChildren = new Map<string, { readonly mail: Mail; readonly ownerToken: string; readonly sessionId: string }>();
  #closed = false;

  constructor(options: {
    pi: ExtensionAPI;
    agentDir: string;
    getContext(): ExtensionContext | undefined;
    callbacks: Omit<ProducerCallbacks, "proveNative">;
    /** Test seam supplies the frozen public endpoint, never a native-send fallback. */
    bind?: typeof bindMailbox;
  }) {
    this.#pi = options.pi;
    this.#getContext = options.getContext;
    this.#binding = (options.bind ?? bindMailbox)(options.pi, { agentDir: options.agentDir });
    this.endpoint = this.#binding.registerProducer({
      id: "pi-processes", ...options.callbacks,
      ...(options.callbacks.onTerminal ? { onTerminal: async (evidence: TerminalEvidence, fence: MailboxCallbackFence) => {
        await options.callbacks.onTerminal!(evidence, fence);
        const recovered = this.#recoveredChildren.get(evidence.key);
        if (recovered?.sessionId === evidence.scope.sessionId && recovered.mail.producer === evidence.producer) this.#recoveredChildren.delete(evidence.key);
      } } : {}),
      proveNative: (mail, branch, fence) => proveProcessMailV1(mail, branch, fence.session.id),
    });
  }

  prepare(batch: ProcessNotificationBatchV1, policy: MailPolicy, wake: boolean, anchorEntryId?: string, child?: ProcessNotificationIntentV1["child"]): { mail: Mail; target: ReturnType<ProducerEndpoint["target"]> } {
    const ctx = this.#getContext();
    if (this.#closed || !ctx || ctx.sessionManager.getSessionId() !== batch.sessionScopeId) throw new Error("Process mailbox source is stale");
    const key = `batch:${batch.batchId}`;
    const intents = readProcessMailIntentsV1(ctx.sessionManager.getBranch(), batch.sessionScopeId);
    let mail = intents.get(key);
    if (!mail && readProcessMailIntentsV1(ctx.sessionManager.getEntries(), batch.sessionScopeId).has(key)) throw new Error("Process mailbox intent belongs to another branch; retry on its original branch");
    if (mail) {
      if (canonicalProcessNotificationValueV1(mail.messages) !== canonicalProcessNotificationValueV1([processNotificationBatchMessageV1(batch)])) throw new Error("Process batch changed after mailbox handoff");
      if (child) {
        const origin = ctx.sessionManager.getBranch().find(e => e.type === "custom" && e.customType === PROCESS_NOTIFICATION_INTENT_TYPE && (e.data as ProcessNotificationIntentV1)?.mail.key === key);
        if (!origin || origin.type !== "custom" || canonicalProcessNotificationValueV1((origin.data as ProcessNotificationIntentV1).child) !== canonicalProcessNotificationValueV1(child)) throw new Error("Process child owner changed after mailbox handoff");
      }
      if (!this.ownsCurrentIntent(key)) throw new Error("Process mailbox carrier belongs to another branch; retry on its original branch");
    } else {
      mail = { producer: "pi-processes", key, anchorEntryId: anchorEntryId ?? ctx.sessionManager.getLeafId(), policy, wake, messages: [processNotificationBatchMessageV1(batch)] };
      this.#pi.appendEntry(PROCESS_NOTIFICATION_INTENT_TYPE, { version: 1, sessionScopeId: batch.sessionScopeId, mail, ...(child ? { child } : {}) } satisfies ProcessNotificationIntentV1);
    }
    // Re-capture only after the original source intent was found on this branch
    // (or durably created here), before any asynchronous admission work.
    const target = this.endpoint.target(ctx);
    return { mail, target };
  }

  async submit(batch: ProcessNotificationBatchV1, policy: MailPolicy, wake: boolean, anchorEntryId?: string): Promise<PutResult> {
    const { mail, target } = this.prepare(batch, policy, wake, anchorEntryId);
    return this.endpoint.put(mail, target);
  }

  /** Cold hold limits automatic delivery, not the source owner's cancellation.
   * A held record skips checkCurrent, so retire positively stale Task authority
   * here using the same frozen mail/key and original child scope. Unknown owner
   * identity stays held; admission and business execution are never retried here.
   */
  async restoreChildIntents(ctx: ExtensionContext, captureOwnerToken: () => string | undefined, report: (message: string) => void): Promise<Map<string, Mail>> {
    if (this.#closed || ctx !== this.#getContext()) throw new Error("Child Process recovery belongs to a stale source");
    const sessionId = ctx.sessionManager.getSessionId(), branch = ctx.sessionManager.getBranch();
    const intents = readProcessMailIntentsV1(branch, sessionId);
    const children = new Map<string, ProcessNotificationIntentV1["child"]>();
    for (const entry of branch) if (entry.type === "custom" && entry.customType === PROCESS_NOTIFICATION_INTENT_TYPE) {
      const intent = entry.data as ProcessNotificationIntentV1 | undefined;
      if (intent?.sessionScopeId === sessionId) children.set(intent.mail.key, intent.child);
    }
    const target = this.endpoint.target(ctx);
    for (const mail of intents.values()) {
      const restored = await this.endpoint.put(mail, target, { recovered: true });
      if (this.#closed || ctx !== this.#getContext()) throw new Error("Child Process source retired during recovery");
      const child = children.get(mail.key);
      if (restored.kind === "terminal") { this.#recoveredChildren.delete(mail.key); continue; }
      if (child) this.#recoveredChildren.set(mail.key, { mail, ownerToken: child.ownerToken, sessionId });
    }
    await this.reconcileRecoveredChildOwners(ctx, captureOwnerToken, report);
    return intents;
  }

  /** An idle child can attach before its next Task/grant exists. Recheck only
   * saved recovery authority once a run starts; never re-put or release hold.
   */
  async reconcileRecoveredChildOwners(ctx: ExtensionContext, captureOwnerToken: () => string | undefined, report: (message: string) => void): Promise<void> {
    if (this.#closed || ctx !== this.#getContext()) throw new Error("Child Process recovery belongs to a stale source");
    if (!this.#recoveredChildren.size) return;
    const target = this.endpoint.target(ctx);
    for (const [key, child] of this.#recoveredChildren) {
      if (this.#closed || ctx !== this.#getContext()) throw new Error("Child Process source retired during recovery");
      if (child.sessionId !== target.session.id) continue;
      let ownerToken: string | undefined;
      try { ownerToken = captureOwnerToken(); } catch { /* Unavailable is not evidence of an ended Task. */ }
      if (!ownerToken) { report(`Child Process recovery held: ${key} has no current Task owner identity`); continue; }
      if (ownerToken !== child.ownerToken) {
        await this.endpoint.cancel(child.mail.key, "Child Process Task/generation changed during recovery", target);
        this.#recoveredChildren.delete(key);
      }
    }
  }

  ownsCurrentIntent(key: string): boolean {
    const ctx = this.#getContext();
    if (this.#closed || !ctx) return false;
    const branch = ctx.sessionManager.getBranch(), sessionId = ctx.sessionManager.getSessionId();
    const mail = readProcessMailIntentsV1(branch, sessionId).get(key);
    if (!mail) return false;
    // An intent may be a shared ancestor. Once its first native body exists,
    // only that body's lineage can regain source admission. Whole-tree proof
    // is used solely to refuse another branch, never to declare fulfillment.
    const proof = proveProcessMailV1(mail, ctx.sessionManager.getEntries(), sessionId);
    return proof.kind === "observed" && proof.entries.every(ref => branch.some(entry => entry.id === ref.entryId));
  }

  recorded(notice: RecordedNotice): void {
    const ctx = this.#getContext();
    if (this.#closed || !ctx || notice.scope.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Process ACK belongs to a retired binding");
    const mail = readProcessMailIntentsV1(ctx.sessionManager.getBranch(), notice.scope.sessionId).get(notice.key);
    if (!mail) throw new Error("Process source intent missing for native ACK");
    const proof = proveProcessMailV1(mail, ctx.sessionManager.getBranch(), notice.scope.sessionId);
    if (proof.kind !== "observed" || proof.entries.length !== mail.messages.length || canonicalProcessNotificationValueV1(proof.entries) !== canonicalProcessNotificationValueV1(notice.entries)) throw new Error("Process native ACK proof mismatch");
    this.mark(notice.key, "pending");
  }

  mark(key: string, state: "pending" | "turn-settled"): void {
    const ctx = this.#getContext();
    if (this.#closed || !ctx) throw new Error("Process source is not attached");
    const sessionScopeId = ctx.sessionManager.getSessionId(), batchId = key.slice("batch:".length);
    const statuses = ctx.sessionManager.getBranch().map(e => processNotificationStatusV1(e, sessionScopeId));
    if (statuses.some(s => s?.batchId === batchId && (s.state === state || s.state === "turn-settled"))) return;
    this.#pi.appendEntry(PROCESS_NOTIFICATION_STATUS_TYPE, { version: 1, sessionScopeId, batchId, state });
  }

  recordMigration(batchId: string, classification: "accepted" | "fulfilled" | "cancelled" | "visible-unknown", reason: string): void {
    const ctx = this.#getContext();
    if (this.#closed || !ctx) throw new Error("Process migration source is stale");
    const data = { version: 1, sessionScopeId: ctx.sessionManager.getSessionId(), batchId, classification, reason };
    if (ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "process-notification-migration-v1" && canonicalProcessNotificationValueV1(e.data) === canonicalProcessNotificationValueV1(data))) return;
    this.#pi.appendEntry("process-notification-migration-v1", data);
  }

  /** Called only after the domain coordinator synchronously fences new intent.
   * Scan this public session tree so off-branch mail in the same retired scope
   * is cancelled too. Child callers pass their still-live Task owner token. */
  async cancelOwned(ctx: ExtensionContext, reason: string, ownerToken?: string): Promise<void> {
    const current = this.#getContext();
    if (this.#closed || !current || ctx.sessionManager !== current.sessionManager) throw new Error("Process cancellation belongs to a stale scope");
    const target = this.endpoint.target(ctx);
    const entries = ctx.sessionManager.getEntries();
    const mails = readProcessMailIntentsV1(entries, target.session.id);
    const ownedKeys = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== PROCESS_NOTIFICATION_INTENT_TYPE) continue;
      const intent = entry.data as ProcessNotificationIntentV1;
      if (intent.sessionScopeId === target.session.id && (ownerToken === undefined || intent.child?.ownerToken === ownerToken)) ownedKeys.add(intent.mail.key);
    }
    for (const key of ownedKeys) {
      try { await this.endpoint.cancel(key, reason, target); }
      catch (error) {
        // The owner can live in another bundle; Error constructor identity is
        // not shared. Match the frozen public error code instead.
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "unknown-key") throw error;
        // An intent whose put never succeeded still belongs to the source. Its
        // closing guard forbids native delivery while acceptance + tombstone
        // are established durably; an in-flight earlier put serializes first.
        await this.endpoint.put(mails.get(key)!, target);
        await this.endpoint.cancel(key, reason, target);
      }
    }
  }

  close(): void { this.#closed = true; this.#recoveredChildren.clear(); this.#binding.close(); }
}
