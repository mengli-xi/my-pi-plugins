import { mainMailImportHold } from "./main-import-scope.js";
import { canonicalJsonV1 } from "../persistence/canonical.js";
import { queryGoalContinuationObligationV1 } from "pi-runtime-contracts/goal-continuation-obligation-v1";
import { createHash } from "node:crypto";
import type { CurrentDecision, Mail, NativeEntryRef, RecordedNotice, TerminalEvidence } from "pi-session-inject/mailbox-v1";
import type { ProcessMainBindingV1 } from "../host/process-service.js";
import { continuationDigest } from "../host/main-append-port.js";
import { proveSubagentMail } from "./transport.js";

function outboxes(binding: ProcessMainBindingV1) {
  const state = binding.host.snapshot(); return [state.root, ...state.agents].flatMap(partition => partition.outbox);
}
function outboxFor(binding: ProcessMainBindingV1, key: string) {
  return outboxes(binding).find(item => `outbox:${item.outbox_id}:${item.wake_epoch}` === key || `outbox:${item.outbox_id}:${item.wake_epoch}:continuation` === key);
}
function mainHasCardOpportunity(binding: ProcessMainBindingV1, completionIds: readonly string[]): boolean {
  return binding.turn.hasCardOpportunity({ state: binding.host.snapshot(), mainSessionId: binding.mainSessionId,
    branch: binding.append?.session.getBranch() ?? [], completionIds });
}
/** This is identity validation, independent of delivery permission or sibling holds. */
function validateSourceMail(binding: ProcessMainBindingV1, mail: Mail): void {
  if (mail.producer !== "pi-subagents") throw new Error("Subagent producer mismatch");
  const state = binding.host.snapshot();
  const equal = (messages: readonly unknown[]) => canonicalJsonV1(mail.messages) === canonicalJsonV1(messages);
  const card = (inbox: typeof state.root.inbox[number]) => ({ customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
    details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } });
  if (mail.key.startsWith("mail:")) {
    const source = state.root.mailbox.find(item => `mail:${item.message_id}` === mail.key), content = mail.messages[0]?.content;
    if (!source || typeof content !== "string" || createHash("sha256").update(content).digest("hex") !== source.body_sha256
      || source.body && source.body !== content || !equal([{ customType: "subagent-mailbox-v1", content, display: true,
        details: { message_id: source.message_id, body_sha256: source.body_sha256, injected_into: { kind: "idle-conversation" } } }])) throw new Error("root mailbox body/hash/identity mismatch");
  } else if (mail.key.startsWith("card:")) {
    const source = state.root.inbox.find(item => `card:${item.inbox_id}` === mail.key);
    if (!source || !equal([card(source)])) throw new Error("Main Completion source projection conflict");
  } else if (mail.key.startsWith("outbox:")) {
    const source = outboxFor(binding, mail.key);
    if (!source || source.recipient.kind !== "main" || source.recipient.session_id !== binding.mainSessionId) throw new Error("Outbox source/epoch is unavailable");
    if (mail.key.endsWith(":continuation")) {
      if (!equal([{ customType: "subagent-continuation-v1", content: `Subagent results ${source.completion_ids.join(", ")} are ready. Continue from the delivered completion cards.`, display: false,
        details: { version: 1, outbox_id: source.outbox_id, wake_epoch: source.wake_epoch, completion_ids: source.completion_ids } }])) throw new Error("Main continuation source projection conflict");
    } else {
      const cards = source.completion_ids.map(id => state.root.inbox.find(item => item.completion_id === id));
      if (cards.some(item => !item) || !equal(cards.map(inbox => card(inbox!)))) throw new Error("Main Outbox source card projection conflict");
    }
  } else throw new Error("unknown Subagent Main source key");
}
export function checkMainMail(binding: ProcessMainBindingV1, mail: Mail): CurrentDecision {
  if (binding.mailboxImportPending) return { kind: "hold", reason: "Subagent source import is not committed" };
  const importHold = mainMailImportHold(binding, mail.key);
  if (importHold) return { kind: "hold", reason: importHold };
  if (mail.key.startsWith("mail:")) {
    const source = binding.host.snapshot().root.mailbox.find(item => `mail:${item.message_id}` === mail.key);
    if (!source || source.state === "cancelled") return { kind: "cancel", reason: "root mailbox input ended" };
  }
  if (mail.key.startsWith("outbox:") && !outboxFor(binding, mail.key)) return { kind: "hold", reason: "Outbox source/epoch is unavailable" };
  if (mail.key.startsWith("card:") && !binding.host.snapshot().root.inbox.some(item => `card:${item.inbox_id}` === mail.key)) return { kind: "hold", reason: "Inbox source is unavailable" };
  if (!["mail:", "card:", "outbox:"].some(prefix => mail.key.startsWith(prefix))) return { kind: "hold", reason: "unknown Subagent Main source key" };
  validateSourceMail(binding, mail);
  if (mail.key.startsWith("outbox:")) {
    const source = outboxFor(binding, mail.key)!;
    if (source.state === "handled" || source.turn_settlement?.state === "settled") return mail.key.endsWith(":continuation")
      ? { kind: "cancel", reason: "original Main successful-run settlement already handled these cards" }
      : { kind: "allow", project: true, wake: false };
    if (source.state === "delivery-failed") return { kind: "cancel", reason: source.last_error_code ?? "Outbox delivery cancelled" };
    if (mainHasCardOpportunity(binding, source.completion_ids)) return { kind: "allow", project: true, wake: false };
    if (source.state !== "delivered") return { kind: "allow", project: true, wake: false };
    if (source.settlement_kind === "goal-claimed") {
      const state = binding.host.snapshot();
      const receipt = [state.root, ...state.agents].flatMap(item => item.wake_receipts).find(item => item.outbox_id === source.outbox_id && item.wake_epoch === source.wake_epoch);
      if (!receipt) return { kind: "hold", reason: "Goal claimant receipt is unavailable" };
      const obligation = queryGoalContinuationObligationV1({ sessionId: source.recipient.session_id, continuationId: receipt.continuation_identity });
      if (obligation === "unknown") return { kind: "hold", reason: "Goal continuation obligation is unknown" };
      if (obligation === "owed" || binding.turn.hasActiveRun()) return { kind: "allow", project: true, wake: false };
      if (!mail.key.endsWith(":continuation") && !binding.append?.transport.hasAccepted(`outbox:${source.outbox_id}:${source.wake_epoch}:continuation`))
        return { kind: "hold", reason: "producer fallback handoff is pending" };
    }
  }
  return { kind: "allow", project: true, wake: mail.wake };
}
function nativeMail(binding: ProcessMainBindingV1, proof: Pick<RecordedNotice, "producer" | "key" | "scope" | "entries">): Mail {
  if (binding.mailboxImportPending) throw new Error("Subagent source import is not committed");
  const mail = binding.append?.transport.frozen(proof.key);
  if (!mail || proof.producer !== "pi-subagents" || proof.scope.sessionId !== binding.mainSessionId || proof.scope.anchorEntryId !== mail.anchorEntryId) throw new Error("Subagent native proof scope mismatch");
  validateSourceMail(binding, mail);
  const actual = proveSubagentMail(mail, binding.append!.session.getBranch());
  if (actual.length !== mail.messages.length || canonicalJsonV1(actual) !== canonicalJsonV1(proof.entries)) throw new Error("Subagent native proof is incomplete or conflicts with its original carrier");
  return mail;
}
function nativeObserved(binding: ProcessMainBindingV1, mail: Mail, entries: readonly NativeEntryRef[]): boolean {
  const state = binding.host.snapshot(), entryId = entries[0]!.entryId;
  if (mail.key.startsWith("mail:")) return state.root.mailbox.some(item => `mail:${item.message_id}` === mail.key && item.state !== "pending" && item.session_entry_id === entryId);
  if (mail.key.startsWith("card:")) return state.root.inbox.some(item => `card:${item.inbox_id}` === mail.key && item.state === "appended" && item.model_entry_id === entryId);
  const source = outboxFor(binding, mail.key)!;
  if (!mail.key.endsWith(":continuation")) return source.completion_ids.every((id, index) => state.root.inbox.some(item => item.completion_id === id && item.state === "appended" && item.model_entry_id === entries[index]?.entryId));
  const message = mail.messages[0]!, sha256 = continuationDigest(message.content as string, message.details);
  return source.continuation_native?.entry_id === entryId && source.continuation_native.sha256 === sha256
    || [state.root, ...state.agents].flatMap(partition => partition.wake_receipts).some(receipt => receipt.outbox_id === source.outbox_id && receipt.wake_epoch === source.wake_epoch
      && receipt.kind === "producer-fallback" && receipt.continuation_identity === entryId && receipt.continuation_sha256 === sha256);
}
export async function recordMainMail(binding: ProcessMainBindingV1, notice: RecordedNotice): Promise<void> {
  const mail = nativeMail(binding, notice), at = new Date().toISOString(), state = binding.host.snapshot();
  if (nativeObserved(binding, mail, notice.entries)) return;
  const entryId = notice.entries[0]!.entryId;
  if (mail.key.startsWith("mail:")) {
    const source = state.root.mailbox.find(item => `mail:${item.message_id}` === mail.key)!;
    const result = await binding.host.commitRootMailboxInjectionV1({ messageId: source.message_id, entryId, at });
    if (!result.ok) throw new Error(result.error.message);
  } else if (mail.key.startsWith("card:")) {
    const source = state.root.inbox.find(item => `card:${item.inbox_id}` === mail.key)!;
    const result = await binding.host.proveInboxAppended({ inboxId: source.inbox_id, entryId, projectionSha256: source.projection.projection_sha256, at });
    if (!result.ok) throw new Error(result.error.message);
  } else {
    const source = outboxFor(binding, mail.key)!;
    const result = await binding.host.recordOutboxNative({ outboxId: source.outbox_id, wakeEpoch: source.wake_epoch,
      sessionId: binding.mainSessionId, bindingGeneration: binding.host.binding_generation, at,
      ...(mail.key.endsWith(":continuation") ? { continuation: { wake_epoch: source.wake_epoch, entry_id: entryId,
        sha256: continuationDigest(mail.messages[0]!.content as string, mail.messages[0]!.details) } }
        : { cards: source.completion_ids.map((id, index) => {
          const inbox = state.root.inbox.find(item => item.completion_id === id)!;
          return { inboxId: inbox.inbox_id, completionId: id, entryId: notice.entries[index]!.entryId, projectionSha256: inbox.projection.projection_sha256 };
        }) }) });
    if (!result.ok) throw new Error(result.error.message);
  }
}
export async function terminalMainMail(binding: ProcessMainBindingV1, evidence: TerminalEvidence): Promise<void> {
  if (evidence.producer !== "pi-subagents" || evidence.scope.sessionId !== binding.mainSessionId) throw new Error("Subagent terminal scope mismatch");
  const frozen = binding.append?.transport.frozen(evidence.key);
  if (!frozen || frozen.anchorEntryId !== evidence.scope.anchorEntryId) throw new Error("Subagent terminal source identity is unavailable");
  validateSourceMail(binding, frozen);
  if (evidence.outcome === "cancelled") {
    const state = binding.host.snapshot(), source = outboxFor(binding, evidence.key);
    if (evidence.key.startsWith("mail:") && state.root.mailbox.some(item => `mail:${item.message_id}` === evidence.key && item.state === "cancelled")) return;
    if (source?.state === "delivery-failed" || source && evidence.key.endsWith(":continuation") && (source.state === "handled" || source.turn_settlement?.state === "settled")) return;
    throw new Error("source cancellation has not durably completed");
  }
  const entries = evidence.nativeEntryIds.map((entryId, messageIndex) => ({ entryId, messageIndex }));
  const mail = nativeMail(binding, { ...evidence, entries });
  if (!nativeObserved(binding, mail, entries)) throw new Error("Subagent source has not durably received its native proof");
}
