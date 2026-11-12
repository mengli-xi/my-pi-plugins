import { VERSION } from "@earendil-works/pi-coding-agent";
import { TaskDeadlines } from "../../src/host/task-deadlines.js";
import { ProcessAdmissionOwner } from "../../src/host/process-admission.js";
import { SdkRuntimeControllerV1 } from "../../src/runtime/sdk-controller.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHostCoreV1 } from "../../src/host/core.js";
import { encodeDomainId, generateDomainId } from "../../src/domain/ids.js";
import { applyJournalMutationsV1 } from "../../src/persistence/state-reducer.js";
import type { AgentCheckpointV1, AgentRecordV1, FrozenProfileV1, NormalizedStoreStateV1, TaskRecordV1 } from "../../src/persistence/types.js";
import type { MainStoreCommitInputV1 } from "../../src/persistence/store.js";
import { EffectiveContextUnavailableError } from "pi-session-runtime/native-child-context";

const T = "2026-08-18T00:00:00.000Z"; const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const A = encodeDomainId("agt", Buffer.alloc(16, 1)); const B = encodeDomainId("agt", Buffer.alloc(16, 2)); const TA = encodeDomainId("tsk", Buffer.alloc(16, 3)); const TB = encodeDomainId("tsk", Buffer.alloc(16, 4));
const profile = {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin", body: "role", sha256: sha("role") }, provider: "openai-codex", model: "gpt-5.4", model_scope: ["openai-codex/gpt-5.4"], reasoning_effort: "high" as const, task_timeout_ms: 1_800_000, cwd: "/repo", project_trusted: true, system_prompt_options_sha256: sha("options"), prompt_assembler_version: 1 as const, system_prompt_relative_path: "", system_prompt_bytes: 1, system_prompt_sha256: sha("p"), capabilities: { version: 1 as const, fingerprint: sha("cap"), active_tools: [], tool_definitions: [], entries: [] }, created_at: T };
function agent(id: typeof A | typeof B, name: string, task: typeof TA | typeof TB, active: boolean): AgentCheckpointV1 { const p = { ...profile, system_prompt_relative_path: `conversations/${id}/system-prompt.txt` }; const record: AgentRecordV1 = {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1, record_revision: 1, agent_id: id, parent_conversation: { kind: "main", session_id: "main" }, task_name: name, task_path: `/root/${name}`, depth: 1, created_at: T, created_revision: 1, profile: p, conversation: { session_id: `session-${name}`, relative_path: `conversations/${id}/session.jsonl`, initial_bytes: 1, initial_sha256: sha("s"), last_validated_bytes: 1, last_validated_mtime_ms: 1 }, availability: "available", ...(active ? { current_task_id: task } : {}), queued_task_ids: active ? [] : [task], next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 }; const taskRecord: TaskRecordV1 = {initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main"}}, owner_conversation: {kind: "main" as const, session_id: "main"},  version: 1, record_revision: 1, task_id: task, agent_id: id, origin: "initial", admission_order: id === A ? 1 : 2, message: "work", phase: active ? "running" : "admitted", admitted_at: T, ...(active ? { started_at: T, deadline_at_ms: Date.parse(T) + 60_000, runtime_generation: 1 } : {}), lease_intent: { api_version: 1, session_id: "main", owner_id: "pi-subagents", logical_key: task, reason: "work" }, lease_disposition: "required" }; return { version: 1, host_revision: 1, agent: record, tasks: [taskRecord], mailbox: [], completions: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [] }; }
function initial(): NormalizedStoreStateV1 { return { root: { version: 1, main_key: `main_${"A".repeat(32)}`, host_revision: 1, next_admission_order: 3, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [A, B].sort() as any, mailbox: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] }, agents: [agent(A, "a", TA, true), agent(B, "b", TB, false)].sort((x, y) => x.agent.agent_id.localeCompare(y.agent.agent_id)) }; }
function uuid(n: number): string { const hex = n.toString(16).padStart(12, "0"); return `00000000-0000-4000-8000-${hex}`; }

async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-host-"))); await chmod(base, 0o700); const mainRoot = join(base, "main"); await mkdir(join(mainRoot, "prepared"), { recursive: true, mode: 0o700 }); await mkdir(join(mainRoot, "conversations"), { mode: 0o700 }); t.after(() => rm(base, { recursive: true, force: true }));
  let state = initial(); const commits: MainStoreCommitInputV1[] = []; const leases: string[] = []; const releases: string[] = []; const scheduled: string[] = []; const interrupts: string[] = []; let runtimeFailure = false; let schedulerFailure = false;let executionReady=true;
  const store = { mainRoot, snapshot: () => structuredClone(state), commit: async (input: MainStoreCommitInputV1) => { commits.push(input); state = applyJournalMutationsV1(state, state.root.host_revision + 1, input.mutations, input.operation); return { revision: state.root.host_revision, proof: "sync" as const, transactionId: input.transactionId }; } };
  const host = new AgentHostCoreV1({ mainSessionId: "main", instanceGeneration: 1, bindingGeneration: 1, managerGeneration: 1, spawnPreparation: { prepare: async ({ agentId }) => { const prompt = Buffer.from("prompt\n"); return { sessionId: `session-${agentId}`, sessionJsonl: Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: `session-${agentId}`, timestamp: T, cwd: "/repo" })}\n`), systemPrompt: prompt, profile: { ...profile, system_prompt_relative_path: `conversations/${agentId}/system-prompt.txt`, system_prompt_bytes: prompt.byteLength, system_prompt_sha256: sha("prompt\n") } }; } }, config: { maxDepth: 2, maxTasksPerAgent: 256, maxTasksPerMain: 4096, maxMailboxRecordsPerConversation: 1024 }, store, leases: { acquire: async ({ owner, taskId }) => { assert.ok(owner.kind === "main" || owner.kind === "agent"); leases.push(taskId); return { leaseId: `lease-${taskId}`, generation: 1, releaseWithoutWake: async () => { releases.push(taskId); } }; } }, runtime: { residency: (id) => id === A ? { runtimeGeneration: 1, state: "active" as const,executionReady } : undefined, interrupt: async ({ taskId }) => { interrupts.push(taskId); if (runtimeFailure) throw new Error("rpc down"); } }, scheduler: { taskAdmitted: ({ taskId }) => { scheduled.push(taskId); if (schedulerFailure) throw new Error("scheduler down"); } }, now: () => new Date(T) });
  const caller = { kind: "main-model" as const, conversation: { kind: "main" as const, session_id: "main" }, binding_generation: 1 };
  return { host, caller, state: () => state, commits, leases, releases, scheduled, interrupts, failRuntime: () => { runtimeFailure = true; }, failScheduler: () => { schedulerFailure = true; },degradeRuntime:()=>{executionReady=false;} };
}

test("all/N effective-context failure preserves its structured code before any admission", async (t) => {
  const fx = await fixture(t);
  const host = new AgentHostCoreV1({ ...fx.host.options, spawnPreparation: { async prepare() { throw new EffectiveContextUnavailableError("no-capture"); } } });
  for (const [index, fork_turns] of (["all", "1"] as const).entries()) {
    const result = await host.spawnAgent({ request_id: uuid(180 + index), caller: fx.caller, input: { task_name: `missing_${index}`, message: "delegate", fork_turns } });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, "effective-context-unavailable"); assert.match(result.error.message, /fork_turns=none/); }
  }
  assert.deepEqual(fx.leases, []); assert.deepEqual(fx.commits, []); assert.deepEqual(fx.scheduled, []);
});

async function prepareNested(fx:Awaited<ReturnType<typeof fixture>>,caller:any,clientOperationId:string,name:string,message:string,frozen?:FrozenProfileV1){const agentId=generateDomainId("agt"),taskId=generateDomainId("tsk"),sessionId=`nested-${agentId}`;const prompt=Buffer.from("prompt\n");const nestedProfile={...(frozen??profile),system_prompt_relative_path:`conversations/${agentId}/system-prompt.txt`,system_prompt_bytes:prompt.length,system_prompt_sha256:sha("prompt\n")};return fx.host.prepareOwnerTask({ caller, clientOperationId, expectedHostRevision: fx.host.host_revision, kind: "spawn", payload: { task_name: name, message, fork_turns: "none" }, preparedArtifacts: { agentId, taskId, preparation: { sessionId, sessionJsonl: Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: T, cwd: "/repo" })}\n`), systemPrompt: prompt, profile: nestedProfile } } }); }


test("nested spawn refuses execution proof and builtin provenance tampering before staging", async t => {
  for (const kind of ["factory-path", "factory-hash", "factory-export", "factory-missing", "builtin-version", "builtin-owner", "tool-owner"]) {
    const fx = await fixture(t), parent = fx.state().agents.find(item => item.agent.agent_id === A)!.agent.profile;
    parent.capabilities = { version: 1, fingerprint: sha("caps"), active_tools: ["codemode"], tool_definitions: [{ name: "codemode", owner_id: "builtin:codemode", definition_sha256: sha("codemode") }], entries: [
      { owner: "pi-native-search", main_entrypoint: "/search/extensions/index.ts", child_entrypoint: "/search/extensions/child.ts", tools: [], providers: [], hooks: [], sha256: sha("wrapper"), execution_factory: { version: 1, canonical_path: "/search/extensions/index.ts", sha256: sha("factory"), exports: ["createSearchChildFactory", "loadSearchConfig"] } },
      { owner: "builtin:codemode", main_entrypoint: "builtin:codemode", child_entrypoint: "builtin:codemode", tools: ["codemode"], providers: [], hooks: [], sha256: sha("codemode"), builtin_proof: { version: 1, pi_version: VERSION } },
    ] };
    const nested = structuredClone(parent), factory = nested.capabilities.entries[0]!, builtin = nested.capabilities.entries[1]!;
    if (kind === "factory-path") factory.execution_factory!.canonical_path = "/elsewhere.ts";
    if (kind === "factory-hash") factory.execution_factory!.sha256 = sha("different");
    if (kind === "factory-export") factory.execution_factory!.exports = ["arbitraryLoader"];
    if (kind === "factory-missing") delete factory.execution_factory;
    if (kind === "builtin-version") builtin.builtin_proof!.pi_version = "other";
    if (kind === "builtin-owner") builtin.owner = "builtin:tool-search";
    if (kind === "tool-owner") nested.capabilities.tool_definitions[0]!.owner_id = "builtin:tool-search";
    const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(790) };
    const result = await prepareNested(fx, caller, uuid(791), "tampered", "work", nested);
    assert.equal(result.ok, false, kind); if (!result.ok) assert.equal(result.error.code, "permission-denied", kind);
    assert.equal(fx.commits.length, 0); assert.equal(fx.host.host_revision, 1);
  }
});

test("nested builtin tools may narrow without replacing the frozen proof", async t => {
  const fx = await fixture(t), parent = fx.state().agents.find(item => item.agent.agent_id === A)!.agent.profile;
  parent.capabilities = { version: 1, fingerprint: sha("caps"), active_tools: ["codemode", "tool_search"], tool_definitions: ["codemode", "tool_search"].map(name => ({ name, owner_id: name === "codemode" ? "builtin:codemode" : "builtin:tool-search", definition_sha256: sha(name) })), entries: [["builtin:codemode", "codemode"], ["builtin:tool-search", "tool_search"]].map(([owner, name]) => ({ owner: owner!, main_entrypoint: owner!, child_entrypoint: owner!, tools: [name!], providers: [], hooks: [], sha256: sha(name!), builtin_proof: { version: 1, pi_version: VERSION } })) };
  const nested = structuredClone(parent); nested.capabilities.active_tools = ["codemode"]; nested.capabilities.tool_definitions = nested.capabilities.tool_definitions.filter(tool => tool.name === "codemode"); nested.capabilities.entries = nested.capabilities.entries.filter(entry => entry.owner === "builtin:codemode");
  const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(792) };
  const result = await prepareNested(fx, caller, uuid(793), "narrowed", "work", nested);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("spawn promotes native session/prompt and atomically commits Agent, Task, receipt and lease", async (t) => { const fx = await fixture(t); const result = await fx.host.spawnAgent({ request_id: uuid(9), caller: fx.caller, expected_host_revision: 1, input: { task_name: "new_agent", message: "delegate" } }); assert.equal(result.ok, true); if (!result.ok) return; assert.equal(result.value.fork_turns, "none"); const partition = fx.state().agents.find((item) => item.agent.agent_id === result.value.agent_id)!; assert.equal(partition.tasks[0]!.task_id, result.value.task_id); assert.equal(partition.agent.profile.system_prompt_relative_path, `conversations/${result.value.agent_id}/system-prompt.txt`); assert.deepEqual(fx.leases, [result.value.task_id]); assert.deepEqual(fx.scheduled, [result.value.task_id]); assert.equal(fx.state().root.operation_receipts.length, 1); });

test("child-local staged spawn stays non-addressable until lease-proved commit", async (t) => { const fx = await fixture(t); const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(20) }; const prepare = await prepareNested(fx,caller,uuid(21),"nested","nested work"); assert.equal(prepare.ok, true, prepare.ok ? "" : JSON.stringify(prepare)); if (!prepare.ok) return; assert.equal(fx.state().agents.some((item) => item.agent.task_name === "nested"), false); const prepared = prepare.value.prepared as Record<string, unknown>; const taskId = prepared.taskId as string; const committed = await fx.host.commitOwnerTask({ caller, clientOperationId: uuid(21), preparedToken: prepared.preparedToken as string, taskId, lease: { leaseId: "child-lease", generation: 1, logicalKey: taskId } }); assert.equal(committed.ok, true); if (!committed.ok) return; const child = fx.state().agents.find((item) => item.agent.task_name === "nested")!; assert.equal(child.agent.parent_agent_id, A); assert.equal(child.tasks[0]!.message, "nested work"); const parent = fx.state().agents.find((item) => item.agent.agent_id === A)!; assert.equal(parent.owner_events.length, 1); assert.equal(parent.owner_events[0]!.kind, "confirm_task_commit"); assert.equal(parent.operation_receipts.length, 1); assert.deepEqual(fx.scheduled, [taskId]); });

test("confirm_task_commit owner event is sent, application-proven and ACKed contiguously", async (t) => { const fx = await fixture(t); const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(24) }; const prepare = await prepareNested(fx,caller,uuid(25),"evented","work"); assert.equal(prepare.ok, true, prepare.ok ? "" : JSON.stringify(prepare)); if (!prepare.ok) return; const prepared = prepare.value.prepared as Record<string, unknown>; const taskId = prepared.taskId as string; const committed = await fx.host.commitOwnerTask({ caller, clientOperationId: uuid(25), preparedToken: prepared.preparedToken as string, taskId, lease: { leaseId: "lease-event", generation: 1, logicalKey: taskId } }); assert.equal(committed.ok, true); const sent = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T }); assert.equal(sent.ok, true); if (!sent.ok) return; const event = sent.value.events[0]!; assert.equal(event.state, "sent"); const payload = JSON.parse(event.payload_json); const applied = await fx.host.persistOwnerEventApplication({ caller, requestId: uuid(26), eventId: event.event_id, eventSequence: event.event_sequence, eventPayloadSha256: event.payload_sha256, runtimeGeneration: 1, result: { eventId: event.event_id, eventSequence: event.event_sequence, eventPayloadSha256: event.payload_sha256, runtimeGeneration: 1, kind: "confirm_task_commit_result", taskId, logicalKey: taskId, lease: { leaseId: "lease-event", generation: 1, logicalKey: taskId } }, at: T }); assert.equal(applied.ok, true); assert.equal(payload.taskId, taskId); const acked = await fx.host.ackOwnerEvents({ caller, eventSequence: event.event_sequence, appliedEventIds: [event.event_id], at: T }); assert.equal(acked.ok, true); const parent = fx.state().agents.find((item) => item.agent.agent_id === A)!; assert.equal(parent.owner_events[0]!.state, "acked"); assert.equal(parent.agent.last_owner_event_acked_sequence, event.event_sequence); });

test("child abort before lease proof commits an aborted receipt without publishing Task", async (t) => { const fx = await fixture(t); const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(22) }; const prepare = await prepareNested(fx,caller,uuid(23),"cancelled","work"); assert.equal(prepare.ok, true, prepare.ok ? "" : JSON.stringify(prepare)); if (!prepare.ok) return; const prepared = prepare.value.prepared as Record<string, unknown>; const aborted = await fx.host.abortOwnerTask({ caller, clientOperationId: uuid(23), preparedToken: prepared.preparedToken as string, taskId: prepared.taskId as string, reason: "caller-aborted" }); assert.equal(aborted.ok, true); assert.equal(fx.state().agents.some((item) => item.agent.task_name === "cancelled"), false); assert.equal(fx.state().agents.find((item) => item.agent.agent_id === A)!.operation_receipts.at(-1)!.state, "aborted"); });

test("Agent-parent completion delivery appends cards then terminalizes child-owned Wake before contiguous ACK", async (t) => { const fx = await fixture(t); const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(40) }; const prepare = await prepareNested(fx,caller,uuid(41),"worker","nested"); assert.equal(prepare.ok, true, prepare.ok ? "" : JSON.stringify(prepare)); if (!prepare.ok) return; const prepared = prepare.value.prepared as Record<string, unknown>; const childTask = prepared.taskId as string; const committed = await fx.host.commitOwnerTask({ caller, clientOperationId: uuid(41), preparedToken: String(prepared.preparedToken), taskId: childTask, lease: { leaseId: "child-lease", generation: 1, logicalKey: childTask } }); assert.equal(committed.ok, true); if (!committed.ok) return; const childAgent = committed.value.agent_id as typeof A; const confirmSent = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T }); assert.equal(confirmSent.ok, true); if (!confirmSent.ok) return; const confirm = confirmSent.value.events[0]!; const confirmApplied = await fx.host.persistOwnerEventApplication({ caller, requestId: uuid(42), eventId: confirm.event_id, eventSequence: confirm.event_sequence, eventPayloadSha256: confirm.payload_sha256, runtimeGeneration: 1, result: { eventId: confirm.event_id, eventSequence: confirm.event_sequence, eventPayloadSha256: confirm.payload_sha256, runtimeGeneration: 1, kind: "confirm_task_commit_result", taskId: childTask, logicalKey: childTask, lease: { leaseId: "child-lease", generation: 1, logicalKey: childTask } }, at: T }); assert.equal(confirmApplied.ok, true); assert.equal((await fx.host.ackOwnerEvents({ caller, eventSequence: confirm.event_sequence, appliedEventIds: [confirm.event_id], at: T })).ok, true); assert.equal((await fx.host.startTask({ agentId: childAgent, taskId: childTask as never, runtimeGeneration: 2, startedAt: T })).ok, true); const settled = await fx.host.settleTask({ agentId: childAgent, taskId: childTask as never, runtimeGeneration: 2, completedAt: T, outcome: "completed", reason: "normal-final", finalText: "nested result", summary: "nested result" }); assert.equal(settled.ok, true); if (!settled.ok || !settled.value.outbox_id) return; const outboxId = settled.value.outbox_id; assert.equal((await fx.host.synthesizeCompletionDelivery({ outboxId, at: T })).ok, true); const cardSent = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T }); assert.equal(cardSent.ok, true); if (!cardSent.ok) return; const card = cardSent.value.events[0]!; const cardPayload = JSON.parse(card.payload_json) as { chunkSha256: string; items: { inboxId: string; completionId: string; projectionSha256: string }[] }; const cardApplied = await fx.host.persistOwnerEventApplication({ caller, requestId: uuid(43), eventId: card.event_id, eventSequence: card.event_sequence, eventPayloadSha256: card.payload_sha256, runtimeGeneration: 1, result: { eventId: card.event_id, eventSequence: card.event_sequence, eventPayloadSha256: card.payload_sha256, runtimeGeneration: 1, kind: "completion_delivery_result", chunkSha256: cardPayload.chunkSha256, cardProofs: cardPayload.items.map((item) => ({ ...item, entryId: `entry-${item.inboxId}` })) }, at: T }); assert.equal(cardApplied.ok, true); const receipts=cardPayload.items.map(item=>({inbox_id:item.inboxId,completion_id:item.completionId,projection_sha256:item.projectionSha256,entry_id:`entry-${item.inboxId}`}));
const originalCommit=fx.host.options.store.commit;(fx.host.options.store as any).commit=async()=>{throw new Error("disk unavailable");};
assert.equal((await fx.host.markCompletionsRead({receipts,at:T})).ok,false);assert.ok(fx.state().agents.find(item=>item.agent.agent_id===A)!.inbox.every(inbox=>!inbox.ui_read_at));(fx.host.options.store as any).commit=originalCommit;
assert.equal((await fx.host.markCompletionsRead({receipts:[...receipts,{...receipts[0]!,entry_id:"hidden"}],at:T})).ok,false);
const read=await fx.host.markCompletionsRead({receipts,at:T});assert.equal(read.ok,true);if(read.ok)assert.equal(read.value.marked,1);const reread=await fx.host.markCompletionsRead({receipts:cardPayload.items.map(item=>({inbox_id:item.inboxId,completion_id:item.completionId,projection_sha256:item.projectionSha256,entry_id:`entry-${item.inboxId}`})),at:T});assert.equal(reread.ok,true);if(reread.ok)assert.equal(reread.value.marked,0); assert.equal((await fx.host.ackOwnerEvents({ caller, eventSequence: card.event_sequence, appliedEventIds: [card.event_id], at: T })).ok, true); assert.equal((await fx.host.synthesizeSettledLeaseRelease({ outboxId, at: T })).ok, true); const releaseSent = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T }); assert.equal(releaseSent.ok, true); if (!releaseSent.ok) return; const release = releaseSent.value.events[0]!; const releasePayload = JSON.parse(release.payload_json) as { wakeEpoch: number }; const releaseApplied = await fx.host.persistOwnerEventApplication({ caller, requestId: uuid(44), eventId: release.event_id, eventSequence: release.event_sequence, eventPayloadSha256: release.payload_sha256, runtimeGeneration: 1, result: { eventId: release.event_id, eventSequence: release.event_sequence, eventPayloadSha256: release.payload_sha256, runtimeGeneration: 1, kind: "settled_task_release_result", taskId: childTask, logicalKey: childTask, outboxId, wakeEpoch: releasePayload.wakeEpoch, state: "released-wake-settled", settlementKind: "producer-fallback", runtimeDelivery: "delivered", continuationIdentity: "child-continuation", continuationSha256: "d".repeat(64), leaseId: "child-lease", leaseGeneration: 1, offerId: "offer", offerGeneration: 1 }, at: T }); assert.equal(releaseApplied.ok, true); assert.equal((await fx.host.ackOwnerEvents({ caller, eventSequence: release.event_sequence, appliedEventIds: [release.event_id], at: T })).ok, true); const child = fx.state().agents.find((item) => item.agent.agent_id === childAgent)!; assert.equal(child.tasks[0]!.lease_disposition, "released"); assert.equal(child.outbox[0]!.state, "delivered"); assert.equal(child.wake_receipts[0]!.kind, "producer-fallback"); assert.equal(fx.state().agents.find((item) => item.agent.agent_id === A)!.agent.last_owner_event_acked_sequence, release.event_sequence); });

test("mailbox admission commits record and receipt; identical replay is stable", async (t) => { const fx = await fixture(t); const command = { request_id: uuid(1), caller: fx.caller, input: { target: "/root/a", message: "note" } }; const first = await fx.host.sendInput(command); assert.equal(first.ok, true); assert.equal(fx.state().agents.find((p) => p.agent.agent_id === A)!.mailbox.length, 1); assert.equal(fx.state().root.operation_receipts.length, 1); const revision = fx.host.host_revision; const replay = await fx.host.sendInput(command); assert.deepEqual(replay, first); assert.equal(fx.host.host_revision, revision); const conflict = await fx.host.sendInput({ ...command, input: { ...command.input, message: "different" } }); assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, "protocol-error"); });

test("history-only resident rejects Follow-up before durable admission",async t=>{const fx=await fixture(t);fx.degradeRuntime();const revision=fx.host.host_revision,tasks=fx.state().agents.find(p=>p.agent.agent_id===A)!.tasks.length;const result=await fx.host.followupTask({request_id:uuid(52),caller:fx.caller,input:{target:"/root/a",message:"must not run on fallback"}});assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,"model-unavailable");assert.equal(fx.host.host_revision,revision);assert.equal(fx.state().agents.find(p=>p.agent.agent_id===A)!.tasks.length,tasks);});

test("follow-up acquires structural-parent lease, commits FIFO Task, and schedules after commit", async (t) => { const fx = await fixture(t); const result = await fx.host.followupTask({ request_id: uuid(2), caller: fx.caller, expected_host_revision: 1, input: { target: "/root/a", message: "next" } }); assert.equal(result.ok, true); if (!result.ok) return; const partition = fx.state().agents.find((p) => p.agent.agent_id === A)!; assert.deepEqual(partition.agent.queued_task_ids, [result.value.task_id]); assert.equal(partition.tasks.at(-1)!.message, "next"); assert.deepEqual(fx.leases, [result.value.task_id]); assert.deepEqual(fx.scheduled, []); assert.equal(fx.commits.length, 1); });

test("wait snapshots direct-child current/queued Tasks and arms one durable barrier", async (t) => { const fx = await fixture(t); const result = await fx.host.waitAgents({ request_id: uuid(3), caller: fx.caller, expected_host_revision: 1, input: { targets: ["/root/a", "/root/b"] } }); assert.equal(result.ok, true); if (!result.ok) return; assert.equal(result.value.state, "armed"); if (result.value.state === "armed") { assert.deepEqual(result.value.task_ids, [TA, TB]); assert.deepEqual(result.value.remaining_task_ids, [TA, TB]); } assert.equal(fx.state().root.barrier?.state, "armed"); });

test("wait returns the latest settled completion when active and queued task pointers are already cleared", async (t) => { const fx=await fixture(t); const state=fx.state(); const partition=state.agents.find(item=>item.agent.agent_id===A)!; const task=partition.tasks[0]!; const completionId=encodeDomainId("cmp",Buffer.alloc(16,9)); partition.agent.current_task_id=undefined; task.phase="settled"; task.outcome="completed"; task.reason="normal-final"; task.settled_at=T; task.completion_id=completionId; partition.completions.push({version:1,record_revision:1,completion_id:completionId,task_id:task.task_id,agent_id:A,recipient:{kind:"main",session_id:"main"},outcome:"completed",reason:"normal-final",final_text:"done",summary:"done",usage:{input_tokens:1,output_tokens:2,cache_read_tokens:0,cache_write_tokens:0,total_tokens:3},task_admitted_at:T,task_started_at:T,completed_at:T}); state.root.inbox.push({version:1,record_revision:1,inbox_id:encodeDomainId("inb",Buffer.alloc(16,10)),completion_id:completionId,recipient:{kind:"main",session_id:"main"},projection:{content:"done",content_sha256:sha("done"),details_json:"{}",details_sha256:sha("{}"),result_truncated:false,original_result_bytes:4,rendered_result_bytes:4,projection_sha256:sha("projection")},state:"pending-append",created_at:T,append_attempts:0}); const result=await fx.host.waitAgents({request_id:uuid(31),caller:fx.caller,input:{targets:["/root/a"]}}); assert.equal(result.ok,true); if(result.ok){assert.equal(result.value.state,"already_settled");if(result.value.state==="already_settled")assert.deepEqual(result.value.completions.map(item=>item.completion_id),[completionId]);} });

test("interrupt commits intent before RPC and post-commit transport failure does not erase success", async (t) => { const fx = await fixture(t); fx.failRuntime(); const result = await fx.host.interruptAgent({ request_id: uuid(4), caller: fx.caller, input: { target: "/root/a" } }); assert.equal(result.ok, true); assert.equal(fx.state().agents.find((p) => p.agent.agent_id === A)!.tasks[0]!.interrupt_generation, 1); assert.deepEqual(fx.interrupts, [TA]); });

test("list is bounded to same binding and follow-up scheduler failure cannot turn committed success into error", async (t) => { const fx = await fixture(t); const listed = await fx.host.listAgents({ request_id: uuid(5), caller: fx.caller, input: {} }); assert.equal(listed.ok, true); if (listed.ok) assert.deepEqual(listed.value.agents.map((a) => a.task_path), ["/root/a", "/root/b"]); fx.failScheduler(); const follow = await fx.host.followupTask({ request_id: uuid(6), caller: fx.caller, input: { target: "/root/b", message: "next" } }); assert.equal(follow.ok, true); });

test("a declared finish or a requested interrupt stops the Task from parking on a Process wait", async (t) => {
  const fx = await fixture(t); const blocking = [{ leaseId: "lease-proc", generation: 1, logicalKey: "proc" }];
  const declared = await fx.host.recordFinishDeclaration({ agentId: A, taskId: TA, runtimeGeneration: 1, declaration: { outcome: "partial", text: "partial", text_sha256: sha("partial"), declared_at: T, tool_call_id: "call", request_id: uuid(60) } });
  assert.equal(declared.ok, true, declared.ok ? "" : JSON.stringify(declared));
  const afterFinish = await fx.host.recordProcessWaitState({ agentId: A, taskId: TA, runtimeGeneration: 1, blocking, at: T });
  assert.equal(afterFinish.ok, true, afterFinish.ok ? "" : JSON.stringify(afterFinish));
  if (afterFinish.ok) assert.equal(afterFinish.value.waiting, false);
  assert.equal(fx.state().agents.find((item) => item.agent.agent_id === A)!.tasks[0]!.phase, "running");

  const other = await fixture(t);
  const interrupted = await other.host.interruptAgent({ request_id: uuid(61), caller: other.caller, input: { target: "/root/a" } });
  assert.equal(interrupted.ok, true);
  const afterInterrupt = await other.host.recordProcessWaitState({ agentId: A, taskId: TA, runtimeGeneration: 1, blocking, at: T });
  assert.equal(afterInterrupt.ok, true, afterInterrupt.ok ? "" : JSON.stringify(afterInterrupt));
  if (afterInterrupt.ok) assert.equal(afterInterrupt.value.waiting, false);
  assert.equal(other.state().agents.find((item) => item.agent.agent_id === A)!.tasks[0]!.phase, "running");
});

test("a replacement runtime generation replays owner events that were sent but never ACKed", async (t) => {
  const fx = await fixture(t);
  const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(70) };
  const first = await prepareNested(fx, caller, uuid(71), "replay_one", "work");
  assert.equal(first.ok, true); if (!first.ok) return;
  const firstPrepared = first.value.prepared as Record<string, unknown>;
  assert.equal((await fx.host.commitOwnerTask({ caller, clientOperationId: uuid(71), preparedToken: String(firstPrepared.preparedToken), taskId: String(firstPrepared.taskId), lease: { leaseId: "lease-one", generation: 1, logicalKey: String(firstPrepared.taskId) } })).ok, true);
  const sent = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T });
  assert.equal(sent.ok, true); if (!sent.ok) return;
  assert.equal(sent.value.events.length, 1);

  const nextCaller = { ...caller, owner_request_id: uuid(73) };
  const second = await prepareNested(fx, nextCaller, uuid(72), "replay_two", "work");
  assert.equal(second.ok, true); if (!second.ok) return;
  const secondPrepared = second.value.prepared as Record<string, unknown>;
  assert.equal((await fx.host.commitOwnerTask({ caller: nextCaller, clientOperationId: uuid(72), preparedToken: String(secondPrepared.preparedToken), taskId: String(secondPrepared.taskId), lease: { leaseId: "lease-two", generation: 1, logicalKey: String(secondPrepared.taskId) } })).ok, true);
  const gapped = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 2, at: T });
  assert.equal(gapped.ok, false);
  if (!gapped.ok) assert.equal(gapped.error.code, "stale-runtime");
  (fx.host.options.runtime as any).residency = () => ({ runtimeGeneration: 2, state: "active", executionReady: true });

  const reset = await fx.host.resetSentOwnerEvents({ agentId: A, runtimeGeneration: 2, at: T });
  assert.equal(reset.ok, true, reset.ok ? "" : JSON.stringify(reset)); if (!reset.ok) return;
  assert.equal(reset.value.reset, 1);
  const replayed = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 2, at: T });
  assert.equal(replayed.ok, true, replayed.ok ? "" : JSON.stringify(replayed));
  if (replayed.ok) assert.deepEqual(replayed.value.events.map((event) => event.event_sequence), [1, 2]);
});

test("a child that cannot prove its mailbox entry leaves the message pending for the next delivery", async (t) => {
  const fx = await fixture(t);
  assert.equal((await fx.host.sendInput({ request_id: uuid(84), caller: fx.caller, input: { target: "/root/a", message: "note" } })).ok, true);
  assert.equal((await fx.host.synthesizeMailboxDelivery({ agentId: A, at: T })).ok, true);
  const sent = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T });
  assert.equal(sent.ok, true); if (!sent.ok) return;
  const event = sent.value.events[0]!;
  const payload = JSON.parse(event.payload_json) as { chunkSha256: string; items: { messageId: string; bodySha256: string; injectedInto: unknown }[] };
  const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(85) };
  const fence = { eventId: event.event_id, eventSequence: event.event_sequence, eventPayloadSha256: event.payload_sha256, runtimeGeneration: 1 };
  const proof = (state: "pending" | "injected") => ({ ...fence, kind: "mailbox_delivery_result", chunkSha256: payload.chunkSha256, messageProofs: [{ messageId: payload.items[0]!.messageId, bodySha256: payload.items[0]!.bodySha256, injectedInto: payload.items[0]!.injectedInto, state, ...(state === "injected" ? { entryId: "entry-1" } : {}) }] });
  const pending = await fx.host.persistOwnerEventApplication({ caller, requestId: uuid(86), ...fence, result: proof("pending"), at: T });
  assert.equal(pending.ok, true, pending.ok ? "" : JSON.stringify(pending));
  assert.equal(fx.state().agents.find((item) => item.agent.agent_id === A)!.mailbox[0]!.state, "pending");
  const injected = await fx.host.persistOwnerEventApplication({ caller, requestId: uuid(87), ...fence, result: proof("injected"), at: T });
  assert.equal(injected.ok, true, injected.ok ? "" : JSON.stringify(injected));
  const record = fx.state().agents.find((item) => item.agent.agent_id === A)!.mailbox[0]!;
  assert.equal(record.state, "injected");
  assert.equal(record.session_entry_id, "entry-1");
});

test("a second nested spawn in the same turn is not reported as an owner event gap while the first confirm is still in flight", async (t) => {
  const fx = await fixture(t); const caller = { kind: "agent-model" as const, conversation: { kind: "agent" as const, session_id: "session-a", agent_id: A }, runtime_generation: 1, owner_request_id: uuid(91) };
  const first = await prepareNested(fx, caller, uuid(91), "parallel_one", "work"); assert.equal(first.ok, true); if (!first.ok) return;
  const firstPrepared = first.value.prepared as Record<string, unknown>;
  assert.equal((await fx.host.commitOwnerTask({ caller, clientOperationId: uuid(91), preparedToken: String(firstPrepared.preparedToken), taskId: String(firstPrepared.taskId), lease: { leaseId: "lease-one", generation: 1, logicalKey: String(firstPrepared.taskId) } })).ok, true);
  const sentFirst = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T }); assert.equal(sentFirst.ok, true); if (!sentFirst.ok) return;
  assert.deepEqual(sentFirst.value.events.map((event) => event.event_sequence), [1]);
  const nextCaller = { ...caller, owner_request_id: uuid(93) };
  const second = await prepareNested(fx, nextCaller, uuid(92), "parallel_two", "work"); assert.equal(second.ok, true); if (!second.ok) return;
  const secondPrepared = second.value.prepared as Record<string, unknown>;
  assert.equal((await fx.host.commitOwnerTask({ caller: nextCaller, clientOperationId: uuid(92), preparedToken: String(secondPrepared.preparedToken), taskId: String(secondPrepared.taskId), lease: { leaseId: "lease-two", generation: 1, logicalKey: String(secondPrepared.taskId) } })).ok, true);
  // seq 1 还是 sent（没 ACK），同一代 runtime 再发 seq 2 必须成功，而不是 protocol-error。
  const sentSecond = await fx.host.sendOwnerEvents({ agentId: A, runtimeGeneration: 1, at: T }); assert.equal(sentSecond.ok, true, sentSecond.ok ? "" : JSON.stringify(sentSecond)); if (!sentSecond.ok) return;
  assert.deepEqual(sentSecond.value.events.map((event) => event.event_sequence), [2]);
  assert.equal(fx.state().agents.filter((item) => item.agent.parent_agent_id === A).length, 2);
});

test("name-conflict explains which Agent holds the name and how to continue it", async (t) => {
  const fx = await fixture(t);
  const conflict = await fx.host.spawnAgent({ request_id: uuid(94), caller: fx.caller, expected_host_revision: 1, input: { task_name: "a", message: "again" } });
  assert.equal(conflict.ok, false); if (conflict.ok) return;
  assert.equal(conflict.error.code, "name-conflict");
  assert.match(conflict.error.message, /an Agent named a already exists under \/root/);
  assert.match(conflict.error.message, /send_input on \/root\/a/);
});

test("timeout intent is durable before abort, waiting keeps its deadline, and settlement records failed/timeout", async t => {
  const fx = await fixture(t);
  const early = await fx.host.requestTaskTimeout({ agentId: A, taskId: TA, runtimeGeneration: 1, at: T });
  assert.equal(early.ok && early.value.interrupt, false);
  const deadline = fx.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.deadline_at_ms!;
  const waited = await fx.host.recordProcessWaitState({ agentId: A, taskId: TA, runtimeGeneration: 1, blocking: [{ leaseId: "process-1", generation: 1, logicalKey: "process" }], at: T });
  assert.equal(waited.ok, true);
  const at = new Date(deadline).toISOString();
  const timeout = await fx.host.requestTaskTimeout({ agentId: A, taskId: TA, runtimeGeneration: 1, at });
  assert.equal(timeout.ok && timeout.value.interrupt, true);
  const task = fx.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!;
  assert.equal(task.deadline_at_ms, deadline); assert.equal(task.interrupt_requested_at, at);
  assert.equal(fx.commits.at(-1)!.operation, "timeout-task"); assert.deepEqual(fx.interrupts, []);
  const settled = await fx.host.settleTask({ agentId: A, taskId: TA, runtimeGeneration: 1, completedAt: at, outcome: "interrupted", reason: "user-interrupt", finalText: "aborted", summary: "aborted" });
  assert.equal(settled.ok, true);
  const completion = fx.state().agents.find(item => item.agent.agent_id === A)!.completions[0]!;
  assert.equal(completion.outcome, "failed"); assert.equal(completion.reason, "timeout");
});

test("an early deadline timer rechecks the same Task and revokes its cached Process grant", async t => {
  const f = await fixture(t);
  const deadline = f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.deadline_at_ms!;
  let clock = deadline - 10;
  const errors: unknown[] = [];
  const host = new AgentHostCoreV1({ ...f.host.options, now: () => new Date(clock), reportOperationalError: ({ error }) => errors.push(error) });
  const task = () => host.snapshot().agents.find(item => item.agent.agent_id === A)!.tasks[0]!;
  const admission = new ProcessAdmissionOwner({ task, phase: () => task().phase,
    resume: async () => { throw new Error("unexpected resume"); }, requestGrant: () => { throw new Error("unexpected grant"); } });
  // Process admission has its own wall-clock guard; only the timer uses the
  // separately controlled host clock so it can wake 1ms before the deadline.
  t.mock.method(Date, "now", () => clock);
  const input = { admissionId: uuid(810), taskId: TA, childIdle: false, continuationSignal: false, settledBoundary: false };
  assert.equal(await admission.admit(input), "trigger");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborts = 0;
  const deadlines = new TaskDeadlines(host, async identity => {
    aborts++;
    assert.equal(task().interrupt_requested_at, new Date(deadline).toISOString(), "persist timeout intent before abort");
    assert.equal(await admission.admit(input), "record-only");
    assert.equal((await host.settleTask({ ...identity, completedAt: new Date(clock).toISOString(),
      outcome: "interrupted", reason: "user-interrupt", finalText: "aborted", summary: "aborted" })).ok, true);
  });
  t.after(() => deadlines.dispose());
  deadlines.arm({ agentId: A, taskId: TA, runtimeGeneration: 1 });
  clock = deadline - 1;
  t.mock.timers.tick(10);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(task().phase, "running"); assert.equal(task().interrupt_requested_at, undefined); assert.equal(aborts, 0);
  clock = deadline;
  t.mock.timers.tick(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(task().phase, "settled", "the first early callback must not discard deadline enforcement");
  assert.equal(task().deadline_at_ms, deadline); assert.equal(task().outcome, "failed"); assert.equal(task().reason, "timeout");
  assert.equal(aborts, 1); assert.deepEqual(errors, []);
  assert.deepEqual(f.commits.map(commit => commit.operation), ["timeout-task", "settle-task"]);
  t.mock.timers.tick(100); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(aborts, 1);
});

test("an in-flight early deadline check cannot revive a cancelled or replaced timer", async t => {
  const f = await fixture(t);
  const deadline = f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.deadline_at_ms!;
  for (const action of ["cancel", "dispose", "replace"] as const) await t.test(action, async t => {
    let clock = deadline - 10, release!: () => void, checks = 0, aborts = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const host = new AgentHostCoreV1({ ...f.host.options, now: () => new Date(clock) });
    t.mock.method(host, "requestTaskTimeout", async () => {
      checks++;
      if (checks === 1) { await pending; return { ok: true, value: { interrupt: false } }; }
      return { ok: true, value: { interrupt: true } };
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const deadlines = new TaskDeadlines(host, async () => { aborts++; });
    t.after(() => deadlines.dispose());
    const identity = { agentId: A, taskId: TA, runtimeGeneration: 1 };
    deadlines.arm(identity); clock = deadline - 1; t.mock.timers.tick(10);
    assert.equal(checks, 1);
    if (action === "dispose") deadlines.dispose();
    else if (action === "cancel") deadlines.cancel(A, TA);
    else deadlines.arm(identity);
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    clock = deadline; t.mock.timers.tick(100); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(checks, action === "replace" ? 2 : 1);
    assert.equal(aborts, action === "replace" ? 1 : 0);
  });
});

test("a deadline check does not retry a Task already interrupted before its deadline", async t => {
  const f = await fixture(t);
  const deadline = f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.deadline_at_ms!;
  let clock = deadline - 10, aborts = 0;
  const host = new AgentHostCoreV1({ ...f.host.options, now: () => new Date(clock) });
  const check = t.mock.method(host, "requestTaskTimeout");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deadlines = new TaskDeadlines(host, async () => { aborts++; });
  t.after(() => deadlines.dispose());
  deadlines.arm({ agentId: A, taskId: TA, runtimeGeneration: 1 });
  assert.equal((await host.interruptAgent({ request_id: uuid(811), caller: f.caller, input: { target: A } })).ok, true);
  clock = deadline; t.mock.timers.tick(10); await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(100); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(check.mock.callCount(), 1); assert.equal(aborts, 0);
  const task = host.snapshot().agents.find(item => item.agent.agent_id === A)!.tasks[0]!;
  assert.equal(task.interrupt_requested_at, new Date(deadline - 10).toISOString());
});

test("open cap counts queued and closing Agents, excludes closed, and concurrent resumes reserve one slot", async t => {
  const fx = await fixture(t);
  let assemblies = 0;
  const runtime = { ...fx.host.options.runtime, resumeAgent: async () => { assemblies++; }, closeAgent: async () => {} };
  const host = new AgentHostCoreV1({ ...fx.host.options, runtime });
  for (let index=0;index<30;index++) assert.equal((await host.spawnAgent({request_id:uuid(500+index),caller:fx.caller,input:{task_name:`cap_${index}`,message:"work"}})).ok,true);
  const full=await host.spawnAgent({request_id:uuid(531),caller:fx.caller,input:{task_name:"over",message:"work"}});assert.equal(full.ok,false);if(!full.ok)assert.equal(full.error.code,"open-agent-capacity");
  for (const target of [B,fx.state().agents.find(i=>i.agent.task_name==="cap_0")!.agent.agent_id]) assert.equal((await host.closeAgent({request_id:uuid(target===B?540:541),caller:fx.caller,input:{target,force:true}})).ok,true);
  const closed=fx.state().agents.filter(i=>i.agent.lifecycle==="closed");assert.equal(closed.length,2);
  assert.equal((await host.spawnAgent({request_id:uuid(542),caller:fx.caller,input:{task_name:"one_vacancy",message:"work"}})).ok,true);
  const results=await Promise.all(closed.map((i,n)=>host.resumeAgent({request_id:uuid(550+n),caller:fx.caller,input:{target:i.agent.agent_id}})));
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(assemblies,1);assert.equal(fx.state().agents.filter(i=>i.agent.lifecycle!=="closed").length,32);
  const opened=closed.find(i=>fx.state().agents.find(p=>p.agent.agent_id===i.agent.agent_id)!.agent.lifecycle==="open")!;
  assert.equal((await host.resumeAgent({request_id:uuid(559),caller:fx.caller,input:{target:opened.agent.agent_id}})).ok,true);assert.equal(assemblies,1);
});

test("durable input retry binds to one current Task and settle-first routes to a new Task", async t => {
  const fx=await fixture(t),input={request_id:uuid(600),caller:fx.caller,input:{target:A,message:"steer"}};
  const first=await fx.host.sendInput(input),again=await fx.host.sendInput(input);assert.deepEqual(first,again);assert.equal(fx.state().agents.find(p=>p.agent.agent_id===A)!.mailbox.length,1);
  const pending=await fx.host.settleTask({agentId:A,taskId:TA,runtimeGeneration:1,completedAt:T,outcome:"completed",reason:"normal-final",finalText:"done",summary:"done"});assert.equal(pending.ok,false);if(!pending.ok)assert.equal(pending.error.code,"input-pending");
  await fx.host.closeAgent({request_id:uuid(601),caller:fx.caller,input:{target:A,force:true}});
  for(const interrupt of [false,true]){const rejected=await fx.host.sendInput({request_id:uuid(interrupt?603:602),caller:fx.caller,input:{target:A,message:"must not queue",interrupt}});assert.equal(rejected.ok,false);if(!rejected.ok)assert.equal(rejected.error.code,"agent-closed");}
  assert.equal(fx.state().agents.find(p=>p.agent.agent_id===A)!.mailbox[0]!.state,"cancelled");
});

test("interrupt replaces an unstarted queue head, preserving other tasks and never assigning started usage",async t=>{
 const fx=await fixture(t);const result=await fx.host.sendInput({request_id:uuid(710),caller:fx.caller,input:{target:B,message:"replacement",interrupt:true}});assert.equal(result.ok,true);
 await new Promise(r=>setTimeout(r,40));const item=fx.state().agents.find(i=>i.agent.agent_id===B)!;
 assert.equal(item.tasks[0]!.outcome,"interrupted");assert.equal(item.tasks[0]!.started_at,undefined);assert.equal(item.completions[0]!.usage.total_tokens,0);assert.equal(item.tasks[1]!.phase,"admitted");assert.equal(item.agent.queued_task_ids[0],item.tasks[1]!.task_id);
});

test("config error rejects new work but close and list still release resources",async t=>{
 const fx=await fixture(t);fx.host.setWorkDiagnostic("/tmp/profile/config.json: capacity.typo 未知配置键；请移除此键。");
 const rejected=await fx.host.sendInput({request_id:uuid(720),caller:fx.caller,input:{target:A,message:"go"}});assert.equal(rejected.ok,false);if(!rejected.ok)assert.equal(rejected.error.code,"config-invalid");
 assert.equal((await fx.host.listAgents({request_id:uuid(721),caller:fx.caller,input:{}})).ok,true);
 assert.equal((await fx.host.closeAgent({request_id:uuid(722),caller:fx.caller,input:{target:A,force:true}})).ok,true);
 assert.equal(fx.state().agents.find(i=>i.agent.agent_id===A)!.agent.lifecycle,"closed");
});

test("child-origin new input freezes the direct child's owner and rejects cross-Main generation",async t=>{
 const fx=await fixture(t),caller={kind:"agent-model" as const,conversation:{kind:"agent" as const,session_id:"session-a",agent_id:A},runtime_generation:1,owner_request_id:uuid(800)};
 const prepared=await prepareNested(fx,caller,uuid(801),"grand", "work");assert.equal(prepared.ok,true);if(!prepared.ok)return;const token=prepared.value.prepared as any;
 assert.equal((await fx.host.commitOwnerTask({caller,clientOperationId:uuid(801),preparedToken:token.preparedToken,taskId:token.taskId,lease:{leaseId:"child-lease",generation:1,logicalKey:token.taskId}})).ok,true);
 const grand=fx.state().agents.find(i=>i.agent.task_name==="grand")!;const result=await fx.host.sendInput({request_id:uuid(802),caller,input:{target:grand.agent.agent_id,message:"child next",interrupt:true}});assert.equal(result.ok,true);
 await new Promise(r=>setTimeout(r,40));const task=fx.state().agents.find(i=>i.agent.task_name==="grand")!.tasks[1]!;assert.equal(task.owner_conversation.agent_id,A);assert.equal(task.initiator.kind,"agent-model");assert.equal(task.lease_intent.session_id,"session-a");
 const cross=await fx.host.sendInput({request_id:uuid(803),caller:{...fx.caller,conversation:{kind:"main",session_id:"other-main"}},input:{target:grand.agent.agent_id,message:"foreign"}});assert.equal(cross.ok,false);
});

test("view receipts reject mismatched projection/entry/recipient with no ui_read mutation",async t=>{
 const fx=await fixture(t);
 const settled=await fx.host.settleTask({agentId:A,taskId:TA,runtimeGeneration:1,completedAt:T,outcome:"completed",reason:"normal-final",finalText:"answer",summary:"answer"});assert.equal(settled.ok,true);
 const inbox=fx.state().root.inbox[0]!;
 const result=await fx.host.markCompletionsRead({receipts:[{inbox_id:inbox.inbox_id,completion_id:inbox.completion_id,projection_sha256:inbox.projection.projection_sha256,entry_id:"fake"}],at:T});
 assert.equal(result.ok,false);assert.equal(fx.state().root.inbox[0]!.ui_read_at,undefined);
 assert.deepEqual((await fx.host.markCompletionsRead({receipts:[],at:T})).ok,true);
});

test("mailbox cancellation must commit before Task interrupt authority is revoked", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const cancelling = new Promise<void>(resolve => { entered = resolve; });
  const order: string[] = [];
  const host = new AgentHostCoreV1({ ...f.host.options, runtime: { ...f.host.options.runtime,
    async cancelTaskMail() { order.push("processes"); entered(); await pending; order.push("subagents"); },
  } });
  const result = host.interruptAgent({ request_id: uuid(240), caller: f.caller, input: { target: "/root/a" } });
  await cancelling;
  assert.equal(f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.interrupt_requested_at, undefined);
  assert.equal(f.commits.length, 0);
  release();
  assert.equal((await result).ok, true);
  assert.deepEqual(order, ["processes", "subagents"]);
  assert.ok(f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.interrupt_requested_at);
});
test("failed durable mailbox cancel preserves Task authority and its rollback point", async t => {
  const f = await fixture(t);
  const host = new AgentHostCoreV1({ ...f.host.options, runtime: { ...f.host.options.runtime,
    async cancelTaskMail() { throw new Error("mailbox fsync failed"); },
  } });
  assert.equal((await host.interruptAgent({ request_id: uuid(241), caller: f.caller, input: { target: "/root/a" } })).ok, false);
  assert.equal(f.commits.length, 0);
  assert.equal(f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.phase, "running");
  assert.equal(f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.interrupt_requested_at, undefined);
});

test("external runtime loss cancels pending input inside the Host settlement transaction", async t => {
  const f = await fixture(t);
  assert.equal((await f.host.sendInput({ request_id: uuid(248), caller: f.caller, input: { target: "/root/a", message: "pending at runtime loss" } })).ok, true);
  assert.equal((await f.host.synthesizeMailboxDelivery({ agentId: A, at: T })).ok, true);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), durable = new Promise<void>(resolve => { release = resolve; });
  const host = new AgentHostCoreV1({ ...f.host.options, runtime: { ...f.host.options.runtime, async cancelTaskMail() { entered(); await durable; } } });
  const ending = host.settleTask({ agentId: A, taskId: TA, runtimeGeneration: 1, completedAt: T, outcome: "failed", reason: "host-lost", finalText: "runtime disposed", summary: "runtime disposed" });
  await started;
  assert.equal(f.state().agents.find(item => item.agent.agent_id === A)!.tasks[0]!.phase, "running");
  let replied = false;
  const late = host.sendInput({ request_id: uuid(249), caller: f.caller, input: { target: "/root/a", message: "after runtime loss" } }).then(value => { replied = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(replied, false);
  release(); assert.equal((await ending).ok, true); const next = await late;
  const partition = f.state().agents.find(item => item.agent.agent_id === A)!;
  assert.equal(partition.tasks[0]!.phase, "settled"); assert.equal(partition.tasks[0]!.outcome, "failed"); assert.equal(partition.tasks[0]!.reason, "host-lost");
  assert.equal(partition.mailbox.filter(mail => mail.task_id === TA).every(mail => mail.state === "cancelled"), true);
  assert.equal(partition.owner_events.filter(event => event.kind === "mailbox_delivery").every(event => event.state === "cancelled"), true);
  assert.equal(next.ok, true); if (next.ok) assert.equal(next.value.disposition, "new-task");
});

async function sdkSettlement(t: test.TestContext, host: AgentHostCoreV1, cancel: () => Promise<void>) {
  const file = join(host.options.store.mainRoot, `conversations/${A}/session.jsonl`);
  await mkdir(join(host.options.store.mainRoot, "conversations", A), { recursive: true });
  await writeFile(file, [
    { type: "session", version: 3, id: "session-a", timestamp: T, cwd: "/repo" },
    { type: "message", id: "input", parentId: null, timestamp: T, message: { role: "user", content: "work", timestamp: Date.parse(T) } },
    { type: "message", id: "final", parentId: "input", timestamp: T, message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.parse(T) } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const sdk = new SdkRuntimeControllerV1({ host, agentDir: host.options.store.mainRoot, skillPath: "unused", taskTimeoutMs: 1_000,
    settings: () => ({}), registry: () => ({}) as never,
    scheduler: { requestActive() {}, confirmRuntime() {}, releaseGrant() {} },
  });
  // Supply the child cancellation port directly, as in the review reproducer;
  // execute the real SDK settlement and real Host writer/reducer below.
  sdk.cancelTaskMail = cancel;
  sdk.flushAgent = async () => false;
  t.after(() => sdk.deadlines.dispose());
  const resident = { agentId: A, runtimeGeneration: 1, phase: "running", closed: false,
    grant: { agentId: A, taskId: TA, runtimeGeneration: 1, grantId: "grant", coordinatorGeneration: 1 },
    admission: { reset() {} }, child: {} };
  return { resident, settle: () => (sdk as unknown as { settled(state: unknown, aborted: boolean): Promise<void> }).settled(resident, false) };
}

test("input arriving while B cancellation waits is serialized after successful SDK settlement", async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void, cancelCount = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const durable = new Promise<void>(resolve => { release = resolve; });
  const cancelledTasks: string[] = [];
  const cancel = async () => { cancelCount++; cancelledTasks.push(TA); entered(); await durable; };
  const host = new AgentHostCoreV1({ ...f.host.options, runtime: { ...f.host.options.runtime, cancelTaskMail: cancel } });
  const sdk = await sdkSettlement(t, host, cancel);
  const settling = sdk.settle();
  await started;
  let inputCompleted = false;
  const sending = host.sendInput({ request_id: uuid(242), caller: f.caller, input: { target: "/root/a", message: "arrived during B cancel" } })
    .then(result => { inputCompleted = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const completedBeforeCancel = inputCompleted;
  release();
  await settling;
  const sent = await sending;
  assert.equal(completedBeforeCancel, false, "B cancel must hold the authoritative Host transaction");
  assert.equal(cancelCount, 1, "SDK must not cancel once before the Host cancellation hook");
  assert.deepEqual(cancelledTasks, [TA]);
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(sent.value.disposition, "new-task");
  assert.notEqual(sent.value.task_id, TA);
  const partition = f.state().agents.find(item => item.agent.agent_id === A)!;
  assert.equal(partition.tasks.find(task => task.task_id === TA)!.phase, "settled");
  assert.equal(partition.tasks.find(task => task.task_id === sent.value.task_id)!.message, "arrived during B cancel");
  assert.equal(partition.mailbox.some(mail => mail.state === "pending"), false);
  assert.equal(partition.completions.length, 1);
  assert.equal(sdk.resident.phase, "idle");
});

test("finish declaration rejects late steer and durably settles legacy late input with its owner event", async t => {
  const f = await fixture(t);
  const admitted = await f.host.sendInput({ request_id: uuid(243), caller: f.caller, input: { target: "/root/a", message: "legacy late input" } });
  assert.equal(admitted.ok, true);
  assert.equal((await f.host.synthesizeMailboxDelivery({ agentId: A, at: T })).ok, true);
  const prior = structuredClone(f.state().agents.find(item => item.agent.agent_id === A)!);
  const declaration = { outcome: "partial" as const, text: "final", text_sha256: sha("final"), declared_at: T, tool_call_id: "finish", request_id: uuid(244) };
  assert.equal((await f.host.recordFinishDeclaration({ agentId: A, taskId: TA, runtimeGeneration: 1, declaration })).ok, true);
  const revision = f.host.host_revision;
  const late = await f.host.sendInput({ request_id: uuid(245), caller: f.caller, input: { target: "/root/a", message: "after finish declaration" } });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.error.code, "agent-busy");
  assert.equal(f.host.host_revision, revision, "rejected final-Task steer must not write source state");

  // Restore the review's persisted legacy shape: declaration already exists,
  // but its later input/event are still pending. No new admission uses this path.
  const legacy = f.state().agents.find(item => item.agent.agent_id === A)!;
  legacy.mailbox = prior.mailbox;
  legacy.owner_events = prior.owner_events;
  legacy.agent.last_owner_event_acked_sequence = prior.agent.last_owner_event_acked_sequence;
  let cancelCount = 0;
  const cancel = async () => { cancelCount++; };
  const host = new AgentHostCoreV1({ ...f.host.options, runtime: { ...f.host.options.runtime, cancelTaskMail: cancel } });
  const sdk = await sdkSettlement(t, host, cancel);
  await sdk.settle();
  const settled = f.state().agents.find(item => item.agent.agent_id === A)!;
  assert.equal(cancelCount, 1);
  assert.equal(settled.tasks[0]!.phase, "settled");
  assert.equal(settled.tasks[0]!.outcome, "partial");
  assert.equal(settled.tasks[0]!.reason, "finish-task");
  assert.equal(settled.mailbox[0]!.state, "cancelled");
  assert.equal(settled.owner_events[0]!.state, "cancelled");
  assert.equal(settled.agent.last_owner_event_acked_sequence, settled.owner_events[0]!.event_sequence);
  assert.equal(settled.completions.length, 1);
  const commit = f.commits.at(-1)!;
  assert.equal(commit.operation, "settle-task");
  const writes = commit.mutations.filter(mutation => mutation.type === "put");
  assert.ok(writes.some(mutation => mutation.entity_type === "mailbox"));
  assert.ok(writes.some(mutation => mutation.entity_type === "owner-event"));
  assert.ok(writes.some(mutation => mutation.entity_type === "completion"));
});
