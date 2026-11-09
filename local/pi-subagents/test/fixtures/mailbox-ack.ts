import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MAILBOX_HOLDER_KEY } from "pi-session-inject/mailbox-v1/light";
import { harness, tick, until } from "../../../pi-session-inject/test/mailbox-harness.ts";
import { mainKey, encodeDomainId } from "../../src/domain/ids.js";
import { AgentHostCoreV1 } from "../../src/host/core.js";
import { DeliveryEngineV1, driveOutboxDeliveryV1, reconcileMainDeliveryV1 } from "../../src/host/delivery-engine.js";
import { MainSessionAppendPortV1 } from "../../src/host/main-append-port.js";
import { MainTurnSettlementV1 } from "../../src/host/main-turn-settlement.js";
import type { ProcessMainBindingV1 } from "../../src/host/process-service.js";
import { checkMainMail, recordMainMail, terminalMainMail } from "../../src/mailbox/main-source.js";
import { finishMainOutboxMail, importMainMailbox } from "../../src/mailbox/import-main.js";
import { SubagentMailboxTransport } from "../../src/mailbox/transport.js";
import { rootHeaderV1 } from "../../src/persistence/codecs.js";
import { collectInboxTranscriptProofsV1 } from "../../src/persistence/inbox-proofs.js";
import { planTaskSettlementV1 } from "../../src/persistence/settlement.js";
import { openMainStoreV1, type MainStoreV1 } from "../../src/persistence/store.js";
import type { AgentRecordV1, TaskRecordV1 } from "../../src/persistence/types.js";

const at = "2026-10-29T00:00:00.000Z", sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function seed(store: MainStoreV1, sessionId: string) {
  const agentId = encodeDomainId("agt", Buffer.alloc(16, 71)), taskId = encodeDomainId("tsk", Buffer.alloc(16, 72));
  const main = { kind: "main" as const, session_id: sessionId };
  const agent: AgentRecordV1 = { version: 1, record_revision: 1, lifecycle: "open", lifecycle_revision: 1, runtime_generation: 0,
    agent_id: agentId, parent_conversation: main, task_name: "ack", task_path: "/root/ack", depth: 1, created_at: at, created_revision: 1,
    availability: "unavailable", unavailable_reason: "runtime-unavailable", current_task_id: taskId, queued_task_ids: [], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0,
    profile: { version: 1, settings_snapshot: {}, delegation_max_depth: 2, role: { name: "default", source: "built-in", provenance: "builtin", body: "role", sha256: sha("role") },
      provider: "faux", model: "faux", model_scope: ["faux/faux"], reasoning_effort: "off", task_timeout_ms: 60000, cwd: store.mainRoot, project_trusted: true,
      system_prompt_options_sha256: sha("options"), prompt_assembler_version: 1, system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`, system_prompt_bytes: 1, system_prompt_sha256: sha("p"),
      capabilities: { version: 1, fingerprint: sha("caps"), active_tools: [], tool_definitions: [], entries: [] }, created_at: at },
    conversation: { session_id: "faux-child", relative_path: `conversations/${agentId}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 } };
  const task: TaskRecordV1 = { version: 1, record_revision: 1, task_id: taskId, agent_id: agentId, origin: "initial", admission_order: 1, message: "result", phase: "running",
    initiator: { kind: "main-model", conversation: main }, owner_conversation: main, admitted_at: at, started_at: at, deadline_at_ms: 1, runtime_generation: 1,
    lease_intent: { api_version: 1, session_id: sessionId, owner_id: "pi-subagents", logical_key: taskId, reason: "faux Task" }, lease_disposition: "required" };
  const tx = encodeDomainId("txn", Buffer.alloc(16, 73));
  await store.commit({ transactionId: tx, operation: "fixture-admission", mutations: [
    { version: 1, type: "put", transaction_id: tx, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(store.snapshot().root), host_revision: 1, next_admission_order: 2, agent_ids: [agentId] } },
    { version: 1, type: "put", transaction_id: tx, entity_type: "agent", entity_id: agentId, value: agent },
    { version: 1, type: "put", transaction_id: tx, entity_type: "task", entity_id: taskId, value: task },
  ] });
  const settlement = planTaskSettlementV1(store.snapshot(), { transactionId: encodeDomainId("txn", Buffer.alloc(16, 74)), taskId,
    completedAt: at, outcome: "completed", reason: "normal-final", finalText: "faux result", summary: "faux result" });
  await store.commit({ transactionId: encodeDomainId("txn", Buffer.alloc(16, 74)), operation: "settle-task", mutations: settlement.mutations });
}
export async function mainMailboxFixture(options: { directory?: string; recover?: boolean; beforeReady?: (binding: ProcessMainBindingV1) => Promise<void> } = {}) {
  const meta = options.recover ? JSON.parse(await readFile(join(options.directory!, "main-meta.json"), "utf8")) : undefined;
  const h = await harness({ directory: options.directory, ...(meta ? { manager: SessionManager.open(meta.file) } : { persist: true }) });
  const sessionId = h.manager.getSessionId(), mainRoot = join(h.agentDir, "pi-subagents/store-v2/mains", mainKey(sessionId));
  const store = await openMainStoreV1({ agentDirectory: h.agentDir, mainSessionId: sessionId, mailboxImport: true, mainMailboxReadContext: { agentDirectory: h.agentDir, session: h.manager },
    inboxProofProvider: state => collectInboxTranscriptProofsV1({ state, mainRoot, mainSessionManager: h.manager }) });
  const counts = { transactions: 0, offers: 0, recorded: [] as string[], terminal: [] as string[] };
  const commit = store.commit.bind(store); store.commit = async input => { const result = await commit(input); counts.transactions++; return result; };
  const host = new AgentHostCoreV1({ mainSessionId: sessionId, instanceGeneration: 1, bindingGeneration: 1, store,
    config: { maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 }, leases: { async acquire() { throw new Error("unexpected fixture lease"); } },
    runtime: { residency: () => undefined, async interrupt() {} }, scheduler: { taskAdmitted() {} } });
  let binding!: ProcessMainBindingV1, ready!: () => void;
  const gate = new Promise<void>(resolve => { ready = resolve; }), pi = h.piFor("main-ack");
  const transport = new SubagentMailboxTransport(pi, h.agentDir, {
    checkCurrent: mail => binding ? checkMainMail(binding, mail) : { kind: "hold", reason: "source opening" },
    onRecorded: async notice => { await gate; counts.recorded.push(notice.recordedToken); await recordMainMail(binding, notice); },
    onTerminal: async evidence => { await gate; counts.terminal.push(evidence.terminalId); await terminalMainMail(binding, evidence); },
  });
  await h.emit("session_start", { reason: options.recover ? "startup" : "new" });
  const turn = new MainTurnSettlementV1(), append = new MainSessionAppendPortV1(h.manager, transport);
  const current = () => host.snapshot().agents[0]!.outbox[0]!;
  binding = { mainSessionId: sessionId, bindingGeneration: 1, mailboxImportPending: true, host, store, turn, append } as ProcessMainBindingV1;
  const engine = new DeliveryEngineV1({ host, resolveAppendPort: () => append,
    tryHandleOutbox: outboxId => turn.settleHandled({ host, mainSessionId: sessionId, outboxId, branch: () => h.manager.getBranch(), at }),
    offerWake: input => { counts.offers++; return { snapshot: () => ({ ...input, offerId: randomUUID(), offerGeneration: 1, ownerId: "pi-subagents", state: "open" }),
      hasClaim: () => false, commit: () => ({ ok: true, value: { state: "committed", delivery: "delivered" } }), abort: () => ({ ok: true, value: { state: "aborted" } }) } as never; } });
  binding.delivery = engine;
  host.mainMailboxReadContext = store.mainMailboxReadContext = { agentDirectory: h.agentDir, session: h.manager, transport };
  await options.beforeReady?.(binding);
  await importMainMailbox(pi, h.ctx, binding, transport);
  binding.mailboxImportPending = false; ready();
  if (!options.recover) await seed(store, sessionId);
  const slot = () => [...((globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)]).slots.values()][0];
  const inbox = () => host.snapshot().root.inbox[0]!;
  const message = () => ({ customType: "subagent-completion-v1", content: inbox().projection.content, display: true,
    details: { version: 1, inbox_id: inbox().inbox_id, completion_id: inbox().completion_id, projection_sha256: inbox().projection.projection_sha256, details_json: inbox().projection.details_json } });
  async function drain() {
    if (slot().store) await slot().reconcileProofs();
    for (let pass = 0; pass < 100; pass++) {
      await new Promise(resolve => setTimeout(resolve, 5)); await slot().store?.barrier();
      if (!slot().scheduled && !slot().noticesScheduled && !slot().noticeFlights.size && !slot().proofFlights.size && !slot().draining
        && !slot().snapshot.pending.some((record: any) => record.recorded?.ack === "pending") && !slot().snapshot.terminal.length) { await tick(); return; }
    }
    assert.fail("real Mailbox scheduler did not reach a fixed point");
  }
  async function success() {
    const card = message();
    if (!h.manager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === card.customType))
      h.manager.appendCustomMessageEntry(card.customType, card.content, card.display, card.details);
    h.manager.appendMessage(fauxAssistantMessage("handled"));
    turn.runStarted(); turn.observeContext([{ role: "custom", ...card }]);
    await turn.recordRunEnded({ failed: false, pi, ctx: h.ctx, state: host.snapshot() });
  }
  async function deliverCards() {
    const result = await engine.deliverOutbox(current().outbox_id);
    if (result.state === "skipped") { await until(() => inbox().state === "appended", "source native commit"); await engine.deliverOutbox(current().outbox_id); }
    await drain();
  }
  async function handle() {
    await driveOutboxDeliveryV1(current().outbox_id, async () => {
      await turn.settleHandled({ host, mainSessionId: sessionId, outboxId: current().outbox_id, branch: () => h.manager.getBranch(), at });
      await finishMainOutboxMail(binding, current(), transport, h.manager.getBranch());
    });
  }
  await writeFile(join(h.directory, "main-meta.json"), JSON.stringify({ file: h.manager.getSessionFile(), sessionId, outboxId: current().outbox_id, inboxId: inbox()?.inbox_id ?? current().handling_proof?.cards[0]?.inbox_id ?? meta?.inboxId }));
  return { h, store, host, turn, binding, transport, engine, counts, current, inbox, message, success, deliverCards, handle, drain, slot,
    reconcile: () => reconcileMainDeliveryV1({ host, delivery: engine, mainSessionId: sessionId }),
    close: async () => { await drain(); await store.close(); await h.cleanup(); } };
}
