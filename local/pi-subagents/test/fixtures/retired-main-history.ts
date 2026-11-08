import { createHash } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { encodeDomainId, generateDomainId } from "../../src/domain/ids.js";
import { rootHeaderV1 } from "../../src/persistence/codecs.js";
import { sha256CanonicalV1 } from "../../src/persistence/canonical.js";
import { freezeCompletionProjectionV1 } from "../../src/persistence/settlement.js";
import type { MainStoreV1 } from "../../src/persistence/store.js";
import type { AgentCheckpointV1, InboxRecordV1, NormalizedStoreStateV1 } from "../../src/persistence/types.js";
import type { Mail } from "pi-session-inject/mailbox-v1/light";
export interface HistoryRow { readonly agent: AgentCheckpointV1; readonly inbox: InboxRecordV1; readonly mail: Mail; readonly run: Record<string, unknown> }
const domain = <P extends "agt" | "tsk" | "cmp" | "inb" | "out" | "rcp">(prefix: P, n: number) => { const bytes = createHash("sha256").update(`history:${prefix}:${n}`).digest().subarray(0, 16); return encodeDomainId(prefix, bytes); };
/** Historical fixture identities are cloned; every carrier/receipt is then
 * independently validated by the production reader. No provider is invoked. */
export function historyRow(template: NormalizedStoreStateV1, n: number, bytes: number): HistoryRow {
  const source = template.agents[0]!, original = template.root.inbox[0]!, box = source.outbox[0]!;
  const mapping = [[source.agent.agent_id, domain("agt", n)], [source.tasks[0]!.task_id, domain("tsk", n)],
    [source.completions[0]!.completion_id, domain("cmp", n)], [original.inbox_id, domain("inb", n)], [box.outbox_id, domain("out", n)],
    ...source.wake_receipts.map(receipt => [receipt.receipt_id, domain("rcp", n)])];
  let text = JSON.stringify(source); for (const [old, next] of mapping) text = text.replaceAll(old!, next!);
  const agent = JSON.parse(text) as AgentCheckpointV1;
  agent.agent.lifecycle = "closed"; agent.agent.lifecycle_revision = 2; agent.agent.task_path = `/root/history${n}`; agent.agent.task_name = `history${n}`;
  agent.agent.closed_at = agent.agent.created_at; agent.agent.close_reason = "historical fixture";
  agent.agent.conversation.session_id = `history-child-${n}`; agent.outbox[0]!.source.session_id = agent.agent.conversation.session_id;
  agent.tasks[0]!.admission_order = n; agent.completions[0]!.final_text = "x".repeat(bytes);
  const projection = freezeCompletionProjectionV1({ completion: agent.completions[0]!, taskPath: agent.agent.task_path });
  const inbox: InboxRecordV1 = { ...structuredClone(original), inbox_id: domain("inb", n), completion_id: domain("cmp", n), projection,
    model_entry_id: `history-card-${n}`, ui_read_at: agent.completions[0]!.completed_at, ui_read_revision: 1 };
  const run = { version: 1, sessionId: inbox.recipient.session_id, assistantEntryId: `history-assistant-${n}`,
    cards: [{ inboxId: inbox.inbox_id, completionId: inbox.completion_id, entryId: inbox.model_entry_id, projectionSha256: projection.projection_sha256 }] };
  const outbox = agent.outbox[0]!;
  if (outbox.handling_proof) outbox.handling_proof = { version: 1, session_id: inbox.recipient.session_id, wake_epoch: outbox.wake_epoch,
    cards: [{ inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, entry_id: inbox.model_entry_id!, projection_sha256: projection.projection_sha256,
      run_entry_id: `history-run-${n}`, run_sha256: sha256CanonicalV1(run), assistant_entry_id: `history-assistant-${n}` }] };
  for (const receipt of agent.wake_receipts) {
    receipt.continuation_identity = `history-continuation-${n}`;
    const details = { version: 1, outbox_id: outbox.outbox_id, wake_epoch: outbox.wake_epoch, completion_ids: outbox.completion_ids };
    const content = `Subagent results ${outbox.completion_ids.join(", ")} are ready. Continue from the delivered completion cards.`;
    receipt.continuation_sha256 = sha256CanonicalV1({ custom_type: "subagent-continuation-v1", content, details });
    const { record_revision: _revision, ...proof } = receipt; outbox.settlement_proof_sha256 = sha256CanonicalV1(proof);
    if (outbox.turn_settlement) outbox.turn_settlement.continuation_identity = receipt.continuation_identity;
  }
  const mail: Mail = { producer: "pi-subagents", key: `card:${inbox.inbox_id}`, anchorEntryId: null, policy: "next-request", wake: false, messages: [{
    customType: "subagent-completion-v1", content: projection.content, display: true,
    details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: projection.projection_sha256, details_json: projection.details_json },
  }] };
  return { agent, inbox, mail, run };
}
export async function commitHistory(store: MainStoreV1, rows: readonly HistoryRow[]): Promise<void> {
  const state = store.snapshot(), revision = state.root.host_revision + 1, transactionId = generateDomainId("txn");
  const put = (type: string, id: string, value: unknown) => ({ version: 1 as const, type: "put" as const, transaction_id: transactionId, entity_type: type as never, entity_id: id, value });
  const ids = [...state.root.agent_ids, ...rows.map(row => row.agent.agent.agent_id)].sort();
  const mutations = [put("root", "root", { ...rootHeaderV1(state.root), host_revision: revision, agent_ids: ids,
    next_admission_order: Math.max(state.root.next_admission_order, ...rows.map(row => row.agent.tasks[0]!.admission_order + 1)) })];
  for (const row of rows) {
    const a = row.agent; a.host_revision = revision; a.agent.record_revision = revision; a.agent.created_revision = Math.min(a.agent.created_revision, revision);
    row.inbox.record_revision = revision; row.inbox.ui_read_revision = revision;
    mutations.push(put("agent", a.agent.agent_id, a.agent), put("inbox", row.inbox.inbox_id, row.inbox));
    for (const [type, records, field] of [["task", a.tasks, "task_id"], ["completion", a.completions, "completion_id"], ["outbox", a.outbox, "outbox_id"], ["wake-receipt", a.wake_receipts, "receipt_id"]] as const) {
      for (const record of records) { record.record_revision = revision; mutations.push(put(type, (record as unknown as Record<string, string>)[field]!, record)); }
    }
  }
  await store.commit({ transactionId, operation: "fixture-completed-history", mutations, maintenance: true });
}
export function historyEntries(rows: readonly HistoryRow[], parentId: string | null, withReceipts: boolean): object[] {
  const entries: object[] = [], timestamp = new Date().toISOString();
  for (const row of rows) {
    const n = row.agent.tasks[0]!.admission_order, nativeId = row.inbox.model_entry_id!, assistantId = `history-assistant-${n}`;
    const message = row.mail.messages[0]!, anchor = parentId, outbox = row.agent.outbox[0]!;
    const mails = [{ mail: { ...row.mail, anchorEntryId: anchor }, native: nativeId }];
    entries.push({ type: "custom_message", id: nativeId, parentId, timestamp, ...message }); parentId = nativeId;
    if (outbox.wake_epoch > 0) {
      mails.push({ mail: { ...row.mail, key: `outbox:${outbox.outbox_id}:${outbox.wake_epoch}`, anchorEntryId: anchor, wake: true }, native: nativeId });
      if (outbox.settlement_kind === "producer-fallback") {
        const continuation = { customType: "subagent-continuation-v1", content: `Subagent results ${outbox.completion_ids.join(", ")} are ready. Continue from the delivered completion cards.`, display: false,
          details: { version: 1, outbox_id: outbox.outbox_id, wake_epoch: outbox.wake_epoch, completion_ids: outbox.completion_ids } };
        const id = `history-continuation-${n}`;
        entries.push({ type: "custom_message", id, parentId, timestamp, ...continuation }); parentId = id;
        mails.push({ mail: { ...row.mail, key: `outbox:${outbox.outbox_id}:${outbox.wake_epoch}:continuation`, anchorEntryId: anchor, wake: true, messages: [continuation] }, native: id });
      }
    }
    entries.push({ type: "message", id: assistantId, parentId, timestamp, message: fauxAssistantMessage("historical success") }); parentId = assistantId;
    entries.push({ type: "custom", id: `history-run-${n}`, parentId, timestamp, customType: "subagent-main-run-completed-v1", data: row.run }); parentId = `history-run-${n}`;
    if (withReceipts) {
      const id = `history-receipt-${n}`;
      entries.push({ type: "custom", id, parentId, timestamp, customType: "agent-mailbox-delivery-v1", data: { version: 1, sessionId: row.inbox.recipient.session_id,
        terminals: mails.map(({ mail, native }, index) => ({ mail, branchEntryId: native,
          evidence: { producer: mail.producer, key: mail.key, terminalId: `history-terminal-${n}-${index}`, scope: { sessionId: row.inbox.recipient.session_id, anchorEntryId: anchor },
            outcome: "fulfilled", assistantEntryId: assistantId, nativeEntryIds: [native] } })),
      } }); parentId = id;
    }
  }
  return entries;
}
