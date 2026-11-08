import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { NativeMailMessage } from "pi-session-inject/mailbox-v1";
import { canonicalJsonV1 } from "../persistence/canonical.js";
import type { ProcessMainBindingV1 } from "../host/process-service.js";
import type { SubagentMailboxTransport } from "./transport.js";
import { proveSubagentMail } from "./transport.js";
import { driveOutboxDeliveryV1 } from "../host/delivery-engine.js";
import { readMainMailboxRetirement, type MainMailboxRetirement } from "./retirement-main.js";
import type { OutboxRecordV1 } from "../persistence/types.js";
export interface SubagentImportItem {
  readonly key: string;
  readonly state: "accepted" | "fulfilled" | "cancelled" | "visible-unknown";
  readonly reason?: string;
}
function successAfter(branch: readonly SessionEntry[], ids: readonly string[]) {
  const last = Math.max(-1, ...ids.map(id => branch.findIndex(entry => entry.id === id)));
  return branch.slice(last + 1).find(entry => entry.type === "message" && entry.message.role === "assistant" && !["aborted", "error"].includes(entry.message.stopReason));
}
/** Same completion on hot boundaries and cold import. Success preserves cards;
 * only an already accepted, now unnecessary continuation is cancelled. */
export async function finishMainOutboxMail(binding: ProcessMainBindingV1, outbox: OutboxRecordV1,
  transport: SubagentMailboxTransport, branch: readonly SessionEntry[], retirement?: MainMailboxRetirement): Promise<readonly SubagentImportItem[]> {
  if (outbox.state !== "handled" && outbox.turn_settlement?.state !== "settled") return [];
  const key = `outbox:${outbox.outbox_id}:${outbox.wake_epoch}`, state = binding.host.snapshot();
  const facts = retirement ?? await readMainMailboxRetirement({ agentDirectory: transport.agentDir, session: transport.capture().ctx.sessionManager, transport });
  const fact = facts.outbox(state, outbox);
  const item = (key: string): SubagentImportItem | undefined => {
    const mail = facts.key("pi-subagents", key);
    return mail?.evidence && (mail.kind === "handed-off" || mail.kind === "retired") ? { key, state: mail.evidence.outcome } : undefined;
  };
  const sort = (items: SubagentImportItem[]) => items.sort((a, b) => a.key.localeCompare(b.key));
  if (fact.kind === "retired") return sort(fact.mails.filter(mail => mail.mail.producer === "pi-subagents").map(mail => ({ key: mail.mail.key, state: mail.evidence!.outcome })));
  if (fact.kind === "unknown" && !fact.mails.length) return [{ key, state: "visible-unknown", reason: fact.reason }];
  const cards = outbox.completion_ids.map(id => state.root.inbox.find(item => item.completion_id === id));
  const messages: NativeMailMessage[] = cards.filter(item => !!item).map(inbox => ({ customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
    details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } }));
  if (messages.length !== cards.length || !messages.length) return [{ key, state: "visible-unknown", reason: "original handled cards are unavailable" }];
  const handling = outbox.state === "handled" ? binding.turn.handlingProof({ state, mainSessionId: binding.mainSessionId, branch, outbox }) : undefined;
  if (outbox.state === "handled" && (!handling || canonicalJsonV1(handling) !== canonicalJsonV1(outbox.handling_proof)))
    return [{ key, state: "visible-unknown", reason: "original Main handling proof is not on this branch" }];
  const candidates = [
    ...(outbox.wake_epoch > 0 || transport.frozen(key) ? [{ key, messages, wake: true }] : []),
    ...cards.filter(inbox => inbox && (outbox.wake_epoch === 0 || transport.frozen(`card:${inbox.inbox_id}`))).map(inbox => ({ key: `card:${inbox!.inbox_id}`,
      messages: [messages[cards.indexOf(inbox)]!], wake: false })),
  ];
  const results: SubagentImportItem[] = [];
  for (const candidate of candidates) {
    const previous = item(candidate.key);
    if (previous) { results.push(previous); continue; }
    const current = facts.key("pi-subagents", candidate.key);
    if (current?.kind === "unknown") { results.push({ key: candidate.key, state: "visible-unknown", reason: current.reason }); continue; }
    const proof = proveSubagentMail({ producer: "pi-subagents", anchorEntryId: null, policy: "next-request", ...candidate }, branch);
    const latest = handling?.cards.reduce((left, right) => branch.findIndex(entry => entry.id === left.assistant_entry_id) > branch.findIndex(entry => entry.id === right.assistant_entry_id) ? left : right);
    const assistant = latest ? branch.find(entry => entry.id === latest.assistant_entry_id) : successAfter(branch, proof.map(item => item.entryId));
    if (proof.length !== candidate.messages.length || !assistant) {
      results.push({ key: candidate.key, state: "visible-unknown", reason: "handled Outbox lacks original carrier/successful assistant proof" }); continue;
    }
    await transport.importFulfilled(candidate, { sourceReceiptEntryId: latest?.run_entry_id ?? proof[0]!.entryId, assistantEntryId: assistant.id });
    results.push(item(candidate.key) ?? { key: candidate.key, state: "fulfilled" });
  }
  const continuationKey = `${key}:continuation`;
  if (transport.hasAccepted(continuationKey)) {
    const previous = item(continuationKey);
    if (previous) results.push(previous);
    else try {
      await transport.cancel(continuationKey, "original Main successful-run settlement already handled these cards");
      results.push(item(continuationKey) ?? { key: continuationKey, state: "cancelled" });
    } catch (error) {
      if ((error as { code?: string }).code !== "stale-binding") throw error;
      results.push({ key: continuationKey, state: "visible-unknown", reason: "original continuation scope is not active" });
    }
  }
  for (const related of fact.mails) {
    if (related.mail.producer !== "pi-subagents" || results.some(result => result.key === related.mail.key)) continue;
    results.push(item(related.mail.key) ?? { key: related.mail.key, state: "visible-unknown", reason: related.reason ?? "原关联 key 仍需收尾" });
  }
  return sort(results);
}
/** Acceptance precedes the durable import revision and source activation. */
export async function importMainMailbox(pi: ExtensionAPI, ctx: ExtensionContext, binding: ProcessMainBindingV1,
  transport: SubagentMailboxTransport): Promise<readonly SubagentImportItem[]> {
  // Restore owner success before classifying legacy carriers. This is the same
  // guarded source transaction as live delivery; it does not open a Wake.
  const initial = binding.host.snapshot();
  for (const outbox of [initial.root, ...initial.agents].flatMap(partition => partition.outbox)) {
    if (outbox.recipient.kind === "main" && outbox.recipient.session_id === binding.mainSessionId
      && ["pending", "delivering", "cards-appended"].includes(outbox.state))
      await driveOutboxDeliveryV1(outbox.outbox_id, async () => { await binding.turn.settleHandled({ host: binding.host,
        mainSessionId: binding.mainSessionId, outboxId: outbox.outbox_id, branch: () => ctx.sessionManager.getBranch(), at: new Date().toISOString() }); });
  }
  const state = binding.host.snapshot(), branch = ctx.sessionManager.getBranch(), results: SubagentImportItem[] = [];
  const retirement = await readMainMailboxRetirement({ agentDirectory: transport.agentDir, session: ctx.sessionManager, transport });
  for (const source of state.root.mailbox) {
    const key = `mail:${source.message_id}`;
    if (source.state === "cancelled") {
      if (transport.frozen(key)) { await transport.cancel(key, "source input cancelled"); results.push({ key, state: "cancelled" }); }
      continue;
    }
    const native = branch.find(entry => entry.id === source.session_entry_id && entry.type === "custom_message" && entry.customType === "subagent-mailbox-v1");
    const body = source.body ?? (native?.type === "custom_message" && typeof native.content === "string" ? native.content : undefined);
    if (!body || createHash("sha256").update(body).digest("hex") !== source.body_sha256) {
      results.push({ key, state: "visible-unknown", reason: "legacy mailbox body/hash is unavailable" }); continue;
    }
    const unknownWake = transport.legacyWakeUnknown(key);
    await transport.put({ key, wake: false, recovered: true, legacyWakeUnknown: unknownWake, messages: [{ customType: "subagent-mailbox-v1", content: body, display: true,
      details: { message_id: source.message_id, body_sha256: source.body_sha256, injected_into: { kind: "idle-conversation" } } }] });
    results.push(!unknownWake ? { key, state: "accepted" } : { key, state: "visible-unknown", reason: "legacy input has no durable running/idle wake authority; retained as context" });
  }
  for (const outbox of [state.root, ...state.agents].flatMap(partition => partition.outbox)) {
    if (outbox.recipient.kind !== "main" || outbox.recipient.session_id !== binding.mainSessionId) continue;
    // Even a legacy pending Outbox with no allocated epoch is old ingress.
    // Its first reconciliation can create card/continuation keys after import.
    transport.markRecoveredPrefix(`outbox:${outbox.outbox_id}:`);
    for (const id of outbox.completion_ids) {
      const inbox = state.root.inbox.find(item => item.completion_id === id);
      if (inbox) transport.markRecoveredPrefix(`card:${inbox.inbox_id}`);
    }
    if (outbox.state === "handled" || outbox.turn_settlement?.state === "settled") {
      results.push(...await finishMainOutboxMail(binding, outbox, transport, branch, retirement)); continue;
    }
    if (outbox.wake_epoch < 1) continue;
    const key = `outbox:${outbox.outbox_id}:${outbox.wake_epoch}`;
    if (outbox.state === "delivery-failed") {
      for (const cancelledKey of [key, `${key}:continuation`]) if (transport.frozen(cancelledKey)) {
        await transport.cancel(cancelledKey, outbox.last_error_code ?? "source delivery failed"); results.push({ key: cancelledKey, state: "cancelled" });
      }
      continue;
    }
    if (outbox.state === "delivered" && !outbox.turn_settlement && !transport.frozen(key)) {
      results.push({ key, state: "visible-unknown", reason: "legacy delivered Outbox has no successful-run settlement" }); continue;
    }
    const messages: NativeMailMessage[] = [];
    for (const id of outbox.completion_ids) {
      const inbox = state.root.inbox.find(item => item.completion_id === id);
      if (inbox) messages.push({ customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
        details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } });
    }
    if (messages.length !== outbox.completion_ids.length || !messages.length) {
      results.push({ key, state: "visible-unknown", reason: "original Outbox cards are unavailable" }); continue;
    }
    const details = { version: 1, outbox_id: outbox.outbox_id, wake_epoch: outbox.wake_epoch, completion_ids: outbox.completion_ids };
    const content = `Subagent results ${outbox.completion_ids.join(", ")} are ready. Continue from the delivered completion cards.`;
    const continuation = { customType: "subagent-continuation-v1", content, display: false, details };
    const mails = [{ key, messages }, ...(outbox.settlement_kind === "producer-fallback" ? [{ key: `${key}:continuation`, messages: [continuation] }] : [])];
    for (const candidate of mails) {
      await transport.put({ ...candidate, wake: true, recovered: true }); results.push({ key: candidate.key, state: "accepted" });
    }
  }
  const revision = { version: 1, sessionId: binding.mainSessionId, sourceRevision: state.root.host_revision, items: results };
  const previous = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "subagent-mailbox-import-v1");
  if (!previous || previous.type !== "custom" || canonicalJsonV1(previous.data) !== canonicalJsonV1(revision)) pi.appendEntry("subagent-mailbox-import-v1", revision);
  return results;
}
