import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bindMailbox } from "pi-session-inject/mailbox-v1/light";
import { harness } from "../../../pi-session-inject/test/mailbox-harness.ts";
import type { MainMailboxReadContextV1 } from "../../src/mailbox/retirement-main.ts";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AgentHostCoreV1 } from "../../src/host/core.ts";
import { checkpointDirectoryName, journalFileName } from "../../src/persistence/checkpoint.ts";
import { MAX_JOURNAL_PAYLOAD_BYTES, scanJournalV1 } from "../../src/persistence/journal.ts";
import { estimateNormalizedMetadataBytesV1, measureMainStoreUsageV1 } from "../../src/persistence/maintenance.ts";
import { generateDomainId } from "../../src/domain/ids.ts";
import { rootHeaderV1 } from "../../src/persistence/codecs.ts";
import { openMainStoreV1, type MainStoreOpenOptionsV1, type MainStoreV1 } from "../../src/persistence/store.ts";
import type { NormalizedStoreStateV1 } from "../../src/persistence/types.ts";

const T = "2026-10-17T00:00:00.000Z"; const MAIN = "main-root-growth";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const profile = { settings_snapshot: {}, delegation_max_depth: 2 as const, version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin", body: "role", sha256: sha("role") }, provider: "openai-codex", model: "gpt-5.4", model_scope: ["openai-codex/gpt-5.4"], reasoning_effort: "high" as const, task_timeout_ms: 1_800_000, cwd: "/repo", project_trusted: true, system_prompt_options_sha256: sha("options"), prompt_assembler_version: 1 as const, system_prompt_relative_path: "", system_prompt_bytes: 1, system_prompt_sha256: sha("p"), capabilities: { version: 1 as const, fingerprint: sha("cap"), active_tools: [], tool_definitions: [], entries: [] }, created_at: T };
const caller = { kind: "main-model" as const, conversation: { kind: "main" as const, session_id: MAIN }, binding_generation: 1 };

// 像真实审查报告的结果：中文 Markdown、代码块、引号和换行，凑到 65,536 字节的 final_text 上限。
function finalText(index: number): string {
  const unit = `## 第 ${index} 段：发现\n- 位置 \`src/persistence/store.ts:231\`，"journal payload" 超过上限后 commit 抛错。\n\`\`\`ts\nconst x = { "a": 1, 'b': "<tag>" };\n\`\`\`\n`;
  let text = ""; while (Buffer.byteLength(text + unit) <= 65_536) text += unit;
  return text + "x".repeat(65_536 - Buffer.byteLength(text));
}

async function fixture(t: test.TestContext): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-root-growth-"))); await chmod(base, 0o700); t.after(() => rm(base, { recursive: true, force: true }));
  t.after(async () => { await readers.get(base)?.close(); readers.delete(base); });
  return base;
}
const readers = new Map<string, { context: MainMailboxReadContextV1; close(): Promise<void> }>();
async function readContext(agentDirectory: string): Promise<MainMailboxReadContextV1 | undefined> {
  const previous = readers.get(agentDirectory); if (previous) return previous.context;
  const file = join(agentDirectory, "main-receipts.jsonl"); if (!existsSync(file)) return;
  // A real public holder/slot owns this read facade; the historical receipt
  // fixture is append-only and reread through SessionManager when it grows.
  const session = { getSessionId: () => MAIN, getSessionFile: () => file,
    getEntries: () => SessionManager.open(file).getEntries(), getBranch: () => SessionManager.open(file).getBranch(), getLeafId: () => SessionManager.open(file).getLeafId() };
  const h = await harness({ directory: agentDirectory, manager: session as never });
  const binding = bindMailbox(h.piFor("retired-source-history"), { agentDir: agentDirectory });
  binding.registerProducer({ id: "pi-subagents", checkCurrent: () => ({ kind: "hold", reason: "history only" }), proveNative: () => ({ kind: "observed", entries: [] }) });
  await h.emit("session_start", { reason: "startup" });
  const context = { agentDirectory, session };
  readers.set(agentDirectory, { context, close: () => h.cleanup() }); return context;
}
// The transcript proof provider is a storage fixture; retirement itself uses
// actual public A snapshot/receipt validation, including the native disk bytes.
async function open(agentDirectory: string, extra: Partial<MainStoreOpenOptionsV1> = {}): Promise<MainStoreV1> {
  return openMainStoreV1({ agentDirectory, mainSessionId: MAIN, now: () => new Date(T), mainMailboxReadContext: await readContext(agentDirectory),
    inboxProofProvider: async (state: NormalizedStoreStateV1) => new Map([state.root, ...state.agents].flatMap((partition) => partition.inbox).filter((inbox) => inbox.state === "appended").map((inbox) => [inbox.inbox_id, inbox.projection.projection_sha256])), ...extra });
}
function host(store: MainStoreV1): AgentHostCoreV1 {
  const core = new AgentHostCoreV1({ mainSessionId: MAIN, instanceGeneration: 1, bindingGeneration: 1, managerGeneration: 1,
    spawnPreparation: { prepare: async ({ agentId }) => { const prompt = Buffer.from("prompt\n"); return { sessionId: `session-${agentId}`, sessionJsonl: Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: `session-${agentId}`, timestamp: T, cwd: "/repo" })}\n`), systemPrompt: prompt, profile: { ...profile, system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`, system_prompt_bytes: prompt.byteLength, system_prompt_sha256: sha("prompt\n") } }; } },
    config: { maxDepth: 2, maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024, openAgentsPerMain: 10_000 },
    store, leases: { acquire: async ({ taskId }) => ({ leaseId: `lease-${taskId}`, generation: 1, releaseWithoutWake: async () => undefined }) },
    runtime: { residency: () => undefined, interrupt: async () => undefined }, scheduler: { taskAdmitted: () => undefined }, now: () => new Date(T) });
  core.mainMailboxReadContext = store.mainMailboxReadContext;
  return core;
}
function ok<V>(result: { ok: true; value: V } | { ok: false; error: unknown }, label: string): V { if (!result.ok) assert.fail(`${label}: ${JSON.stringify(result.error)}`); return result.value; }

async function closeSettled(core: AgentHostCoreV1, agentId: string): Promise<void> {
  const closed = ok(await core.closeAgent({ request_id: randomUUID(), caller, input: { target: agentId, force: false } }), "close settled subtree");
  assert.equal(closed.lifecycle, "closed");
}

async function spawnRunning(core: AgentHostCoreV1, index: number, name: string): Promise<{ agent_id: `agt_${string}`; task_id: `tsk_${string}` }> {
  const spawned = ok(await core.spawnAgent({ request_id: uuid(index), caller, input: { task_name: name, message: "delegate", fork_turns: "none" } } as never), `spawn ${name}`) as { agent_id: `agt_${string}`; task_id: `tsk_${string}` };
  ok(await core.startTask({ agentId: spawned.agent_id, taskId: spawned.task_id, runtimeGeneration: 1, startedAt: T } as never), `start ${name}`);
  return spawned;
}
const receiptLeaves = new Map<string, string>();
/** settle 一个 Task，再走完 Main 投递：卡片 appended、wake 结算、Outbox delivered，这样子树满足删除前提。 */
async function settleAndDeliver(core: AgentHostCoreV1, store: MainStoreV1, task: { agent_id: `agt_${string}`; task_id: `tsk_${string}` }, index: number, text: string): Promise<void> {
  const settled = ok(await core.settleTask({ agentId: task.agent_id, taskId: task.task_id, runtimeGeneration: 1, completedAt: T, outcome: "completed", reason: "normal-final", finalText: text, summary: `done ${index}` } as never), `settle ${index}`) as { outbox_id: string; completion_id: string };
  const outboxId = settled.outbox_id; const continuation = { continuationIdentity: `cont-${index}`, continuationSha256: sha(`cont-${index}`) };
  ok(await core.beginOutboxDelivery({ outboxId, at: T } as never), `begin ${index}`);
  const inbox = store.snapshot().root.inbox.find((item) => item.completion_id === settled.completion_id)!;
  ok(await core.proveInboxAppended({ inboxId: inbox.inbox_id, entryId: `entry-${index}`, projectionSha256: inbox.projection.projection_sha256, at: T } as never), `prove ${index}`);
  ok(await core.markOutboxCardsAppended({ outboxId, at: T } as never), `cards ${index}`);
  ok(await core.openOutboxWake({ outboxId, offer: { sessionId: MAIN, offerId: `offer-${index}`, offerGeneration: 1, ownerId: "pi-subagents", logicalKey: task.task_id }, at: T } as never), `wake ${index}`);
  ok(await core.markOutboxWakeSettled({ outboxId, kind: "producer-fallback", runtimeDelivery: "skipped", ...continuation, at: T } as never), `wake-settled ${index}`);
  ok(await core.terminalizeOutbox({ outboxId, kind: "producer-fallback", runtimeDelivery: "skipped", ...continuation, at: T } as never), `terminal ${index}`);
  // These storage-focused fixtures now include the public A disk replacement
  // required by the real deletion entrance, including after Inbox retention.
  const file = join(store.options.agentDirectory, "main-receipts.jsonl"), parentId = receiptLeaves.get(file) ?? null;
  const message = { customType: "subagent-completion-v1", content: inbox.projection.content, display: true,
    details: { version: 1, inbox_id: inbox.inbox_id, completion_id: inbox.completion_id, projection_sha256: inbox.projection.projection_sha256, details_json: inbox.projection.details_json } };
  const key = `outbox:${outboxId}:1`, nativeId = `entry-${index}`, assistantId = `assistant-${index}`, receiptId = `receipt-${index}`;
  const rows = [
    ...(parentId === null ? [{ type: "session", version: 3, id: MAIN, timestamp: T, cwd: store.options.agentDirectory }] : []),
    { type: "custom_message", id: nativeId, parentId, timestamp: T, ...message },
    { type: "message", id: assistantId, parentId: nativeId, timestamp: T, message: fauxAssistantMessage("handled") },
    { type: "custom", id: receiptId, parentId: assistantId, timestamp: T, customType: "agent-mailbox-delivery-v1", data: { version: 1, sessionId: MAIN, terminals: [{
      mail: { producer: "pi-subagents", key, anchorEntryId: parentId, policy: "next-request", wake: true, messages: [message] }, branchEntryId: nativeId,
      evidence: { producer: "pi-subagents", key, terminalId: `terminal-${index}`, scope: { sessionId: MAIN, anchorEntryId: parentId }, outcome: "fulfilled", assistantEntryId: assistantId, nativeEntryIds: [nativeId] },
    }] } },
  ];
  await appendFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); receiptLeaves.set(file, receiptId);
  core.mainMailboxReadContext = store.mainMailboxReadContext = await readContext(store.options.agentDirectory);
}
async function currentJournal(store: MainStoreV1) {
  const pointer = JSON.parse(await readFile(store.paths.currentFile, "utf8"));
  const manifest = JSON.parse(await readFile(join(store.paths.checkpoints, checkpointDirectoryName(pointer.checkpoint_generation), "manifest.json"), "utf8"));
  const scan = scanJournalV1(await readFile(join(store.paths.journals, journalFileName(pointer.journal_generation))), manifest.last_journal_sequence, manifest.host_revision);
  assert.equal(scan.status, "valid"); return scan.status === "valid" ? scan : assert.fail("journal is not valid");
}

test("one Main keeps committing past 100 delivered 64 KiB completions, reopens with an unsettled Task and deletes a subtree", { timeout: 300_000 }, async (t) => {
  const agentDirectory = await fixture(t);
  let store = await open(agentDirectory); let core = host(store);
  const held = await spawnRunning(core, 100_000, "held");
  const workers: string[] = [];
  for (let index = 1; index <= 100; index++) {
    const task = await spawnRunning(core, index, `w${index}`); workers.push(task.agent_id);
    await settleAndDeliver(core, store, task, index, finalText(index));
  }
  const root = store.snapshot().root;
  assert.equal(root.inbox.length, 100); assert.equal(store.health().storage, "healthy");
  // 旧格式每笔事务都写整份 Root：这里的 Root 早超过单帧上限好几倍。
  assert.ok(Buffer.byteLength(JSON.stringify(root)) > 6 * MAX_JOURNAL_PAYLOAD_BYTES);
  const journal = await currentJournal(store);
  const rootPuts = journal.frames.filter((frame) => frame.payload.type === "put" && frame.payload.entity_type === "root");
  assert.ok(rootPuts.length > 50);
  assert.ok(Math.max(...rootPuts.map((frame) => frame.payloadBytes.byteLength)) < 8192, "Root put carries only the Root header");
  assert.ok(Math.max(...journal.frames.map((frame) => frame.payloadBytes.byteLength)) < 256 * 1024, "every frame stays the size of one entity");
  await closeSettled(core, workers[0]!);
  await store.close();

  // 生产冷启动时 SDK 给的是「当前没有活着的 runtime」：空 Map，recovery 把没结算的 Task 收尾成一笔事务。
  store = await open(agentDirectory, { liveRuntimeGenerations: new Map() }); core = host(store);
  const recovered = store.snapshot();
  const heldTask = recovered.agents.find((partition) => partition.agent.agent_id === held.agent_id)!.tasks[0]!;
  assert.equal(heldTask.phase, "settled"); assert.equal(heldTask.reason, "host-lost");
  assert.equal(recovered.root.inbox.length, 101); assert.equal(store.health().storage, "healthy");

  const deleted = ok(await core.deleteSettledSubtree({ agentId: workers[0] as never, expectedRevision: recovered.root.host_revision, allowUnread: true, at: T }), "delete subtree");
  assert.equal(deleted.deleted_agents, 1);
  const afterDelete = store.snapshot();
  assert.equal(afterDelete.root.inbox.length, 100); assert.ok(!afterDelete.root.agent_ids.includes(workers[0] as never)); assert.equal(afterDelete.root.tombstones.length, 1);
  await spawnRunning(core, 200_000, "after_delete");
  assert.equal(store.health().storage, "healthy");
  const expected = store.snapshot(); await store.close();
  const reopened = await open(agentDirectory);
  assert.deepEqual(reopened.snapshot(), expected);
  await reopened.close();
});

test("at the metadata ceiling the open still succeeds and deleting a settled subtree frees space", async (t) => {
  const agentDirectory = await fixture(t);
  let store = await open(agentDirectory); let core = host(store);
  const held = await spawnRunning(core, 1, "held");
  const worker = await spawnRunning(core, 2, "worker"); await settleAndDeliver(core, store, worker, 2, finalText(2));
  await closeSettled(core, worker.agent_id);
  await store.checkpoint(); const limit = estimateNormalizedMetadataBytesV1(store.snapshot()) + 64; await store.close();

  // recovery 要给 held 补一条 Completion/Inbox，超过 metadata 硬上限：照常打开，health 标容量降级。
  store = await open(agentDirectory, { liveRuntimeGenerations: new Map(), limits: { maxMetadataBytesPerMain: limit } }); core = host(store);
  assert.equal(store.health().storage, "degraded-capacity"); assert.match(store.health().detail ?? "", /recover-runtime-state/u);
  assert.notEqual(store.snapshot().agents.find((partition) => partition.agent.agent_id === held.agent_id)!.tasks[0]!.phase, "settled");
  ok(await core.deleteSettledSubtree({ agentId: worker.agent_id, expectedRevision: store.snapshot().root.host_revision, allowUnread: true, at: T }), "delete at ceiling");
  assert.equal(store.snapshot().agents.length, 1); assert.equal(store.snapshot().root.inbox.length, 0);
  await store.close();

  // 腾出空间后重开：recovery 补上 held 的结算，health 回到 healthy。
  store = await open(agentDirectory, { liveRuntimeGenerations: new Map(), limits: { maxMetadataBytesPerMain: limit } });
  assert.equal(store.health().storage, "healthy");
  assert.equal(store.snapshot().agents[0]!.tasks[0]!.reason, "host-lost");
  await store.close();
});

/** 直接往 Main 的 operation_receipts 里塞一批 receipt（一笔事务），模拟 Main 连续调写类工具。 */
async function addMainReceipts(store: MainStoreV1, count: number, result: (index: number) => Record<string, unknown>): Promise<string[]> {
  const snapshot = store.snapshot(); const revision = snapshot.root.host_revision + 1; const transactionId = generateDomainId("txn"); const ids: string[] = [];
  const puts = Array.from({ length: count }, (_, index) => { const resultJson = JSON.stringify(result(index)); const receipt: Record<string, unknown> & { receipt_id: string } = { version: 1, record_revision: revision, receipt_id: generateDomainId("rcp"), request_id: randomUUID(), operation_digest: sha("op"), caller: { kind: "main", session_id: MAIN }, runtime_generation: 1, operation: "send-input", state: "committed", transaction_id: transactionId, result_json: resultJson, result_sha256: sha(resultJson), created_at: T, settled_at: T }; ids.push(receipt.receipt_id); return { version: 1 as const, type: "put" as const, transaction_id: transactionId, entity_type: "operation-receipt" as const, entity_id: receipt.receipt_id, value: receipt }; });
  await store.commit({ transactionId, operation: "seed-receipts", mutations: [{ version: 1, type: "put", transaction_id: transactionId, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(snapshot.root), host_revision: revision } }, ...puts] });
  return ids;
}

test("Main operation receipts beyond 4,096 are retained to the newest 1,024 at checkpoint and the store keeps opening", async (t) => {
  const agentDirectory = await fixture(t);
  let store = await open(agentDirectory); const added: string[] = [];
  for (let batch = 0; batch < 60; batch++) {
    added.push(...await addMainReceipts(store, 100, (index) => ({ batch, index })));
    assert.ok(store.snapshot().root.operation_receipts.length <= 4096); assert.equal(store.health().storage, "healthy");
  }
  const receipts: string[] = store.snapshot().root.operation_receipts.map((receipt) => receipt.receipt_id);
  assert.ok(receipts.length < 2200, `retention kept ${receipts.length}`);
  for (const id of added.slice(-1024)) assert.ok(receipts.includes(id), "the newest 1,024 receipts stay for idempotent replay");
  await store.checkpoint(); const expected = store.snapshot(); await store.close();
  store = await open(agentDirectory);
  assert.deepEqual(store.snapshot(), expected); assert.ok(store.snapshot().root.operation_receipts.length <= 1024 + 100);
  await store.close();
});

test("receipts still tied to an unsettled Task are never pruned; past 4,096 the commit is a clean capacity rejection", async (t) => {
  const agentDirectory = await fixture(t);
  let store = await open(agentDirectory); const core = host(store);
  const held = await spawnRunning(core, 1, "held");
  while (store.snapshot().root.operation_receipts.length < 4096) await addMainReceipts(store, Math.min(1000, 4096 - store.snapshot().root.operation_receipts.length), (index) => ({ task_id: held.task_id, index }));
  const revision = store.snapshot().root.host_revision;
  await assert.rejects(addMainReceipts(store, 1, () => ({ task_id: held.task_id })), (error: Error) => error.message.startsWith("[subagent/storage-capacity]") && error.message.includes("operation_receipts 有 4097 条，超过 4096 条上限") && error.message.includes("删除已结算的子 Agent 子树"));
  assert.equal(store.snapshot().root.host_revision, revision); assert.equal(store.health().storage, "degraded-capacity");
  await store.checkpoint(); assert.equal(store.snapshot().root.operation_receipts.length, 4096);
  await store.close();
  store = await open(agentDirectory, { liveRuntimeGenerations: new Map([[held.agent_id, { runtimeGeneration: 1, preparedTokenDigests: new Set<string>() }]]) });
  assert.equal(store.snapshot().root.operation_receipts.length, 4096); assert.equal(store.health().storage, "healthy");
  await store.close();
});

test("settlement and delivery still commit when the Main store is over its soft capacity, while new work is refused", async (t) => {
  const agentDirectory = await fixture(t);
  let store = await open(agentDirectory); let core = host(store);
  const worker = await spawnRunning(core, 1, "worker");
  const usage = await measureMainStoreUsageV1(store.mainRoot); await store.close();
  // 整个 Main 只剩 2 KB 余量：任何新工作都被准入拒绝，Task 的真实结果仍然要写得进去。
  store = await open(agentDirectory, { liveRuntimeGenerations: new Map([[worker.agent_id, { runtimeGeneration: 1, preparedTokenDigests: new Set<string>() }]]), limits: { maxStoreBytesPerMain: usage.totalBytes + 2048 } }); core = host(store);
  const refused = await core.spawnAgent({ request_id: uuid(2), caller, input: { task_name: "refused", message: "more work", fork_turns: "none" } } as never) as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(refused.ok, false); assert.equal(refused.error?.code, "storage-capacity"); assert.match(refused.error?.message ?? "", /删除已结算的子 Agent 子树/u);
  const text = finalText(1);
  await settleAndDeliver(core, store, worker, 1, text);
  const state = store.snapshot(); const partition = state.agents.find((item) => item.agent.agent_id === worker.agent_id)!;
  assert.equal(partition.tasks[0]!.outcome, "completed"); assert.equal(partition.tasks[0]!.reason, "normal-final"); assert.equal(partition.completions[0]!.final_text, text);
  assert.ok(state.root.inbox[0]!.projection.content.includes("第 1 段：发现")); assert.equal(state.root.inbox[0]!.state, "appended");
  assert.equal(store.health().storage, "healthy");
  await store.close();
});

test("Main read cards retire after A ACK/GC and survive cold reopen through their receipts", async (t) => {
  const agentDirectory = await fixture(t);
  let store = await open(agentDirectory); let core = host(store);
  const read = await spawnRunning(core, 1, "read"); await settleAndDeliver(core, store, read, 1, "read result");
  const unread = await spawnRunning(core, 2, "unread"); await settleAndDeliver(core, store, unread, 2, "unread result");
  const card = store.snapshot().root.inbox.find((inbox) => inbox.completion_id === store.snapshot().agents.find((item) => item.agent.agent_id === read.agent_id)!.completions[0]!.completion_id)!;
  const receipt = { inbox_id: card.inbox_id, completion_id: card.completion_id, projection_sha256: card.projection.projection_sha256, entry_id: card.model_entry_id! };
  assert.equal((ok(await core.markCompletionsRead({ receipts: [receipt], at: T }), "mark read") as { marked: number }).marked, 1);
  await store.checkpoint();
  assert.equal(store.snapshot().root.inbox.length, 2, "a delivered card whose Main turn has not settled stays");
  // Main 处理过这批卡片的那一轮结算后，投递才算彻底结束（DELIVERY_PROTOCOL §7.9）。
  const vehicle = store.snapshot().agents.find((item) => item.agent.agent_id === read.agent_id)!.outbox[0]!;
  ok(await core.settleOutboxTurn({ outboxId: vehicle.outbox_id, wakeEpoch: vehicle.wake_epoch, continuationIdentity: vehicle.turn_settlement!.continuation_identity, at: T }), "settle turn");
  await store.checkpoint();
  assert.equal(store.snapshot().root.inbox.length, 1, "only the read, business-retired card with a verified A replacement may go");
  // 卡片还在 Main transcript 里，再点一次只是没事可做。
  assert.equal((ok(await core.markCompletionsRead({ receipts: [receipt], at: T }), "repeat click") as { marked: number }).marked, 0);
  await closeSettled(core, read.agent_id);
  await store.close();
  store = await open(agentDirectory); core = host(store);
  assert.equal(store.snapshot().root.inbox.length, 1); assert.equal(store.snapshot().agents.find((item) => item.agent.agent_id === read.agent_id)!.completions[0]!.final_text, "read result");
  ok(await core.deleteSettledSubtree({ agentId: read.agent_id as never, expectedRevision: store.snapshot().root.host_revision, allowUnread: false, at: T }), "delete retained-card subtree");
  assert.equal(store.snapshot().agents.length, 1);
  await store.close();
});
