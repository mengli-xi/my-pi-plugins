import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { rootHeaderV1 } from "../../src/persistence/codecs.ts";
import { PRIVATE_DIR_MODE } from "../../src/persistence/layout.ts";
import { canonicalJsonV1 } from "../../src/persistence/canonical.ts";
import { runPreparedAdmissionV1, reconcilePreparedDirectoriesV1, type PreparedLeaseHandleV1, type PrepareAdmissionStepV1 } from "../../src/persistence/prepared.ts";
import { openMainStoreV1 } from "../../src/persistence/store.ts";
import { CommitUncertainError } from "../../src/persistence/transaction.ts";
import type { PrepareRecordV1 } from "../../src/persistence/types.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const TX = encodeDomainId("txn", Buffer.alloc(16, 11));
const AGENT = encodeDomainId("agt", Buffer.alloc(16, 12));
const TASK = encodeDomainId("tsk", Buffer.alloc(16, 13));
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "pi-subagents-admission-")); await chmod(root, PRIVATE_DIR_MODE); return root; }
function artifacts() {
  const session = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: NOW, cwd: "/repo" })}\n`);
  const prompt = Buffer.from("prompt\n");
  return { session, prompt };
}
function profile() { const { prompt } = artifacts(); return {settings_snapshot: {}, delegation_max_depth: 2 as const,  version: 1 as const, role: { name: "default", source: "built-in" as const, provenance: "builtin:default:v1", body: "role", sha256: sha("role") }, provider: "anthropic", model: "claude", model_scope: ["anthropic/claude"], reasoning_effort: "high" as const, task_timeout_ms: 1_800_000, cwd: "/repo", project_trusted: true, system_prompt_options_sha256: sha("options"), prompt_assembler_version: 1 as const, system_prompt_relative_path: `conversations/${AGENT}/system-prompt.txt`, system_prompt_bytes: prompt.length, system_prompt_sha256: sha(prompt), capabilities: { version: 1 as const, fingerprint: sha("caps"), active_tools: [], tool_definitions: [], entries: [] }, created_at: NOW }; }
function record(baseRevision = 0): PrepareRecordV1 { const { session, prompt } = artifacts(); return { version: 1, transaction_id: TX, operation: "spawn-agent", base_revision: baseRevision, proposed_revision: baseRevision + 1, created_at: NOW, prepared_operation: {lease_owner: { kind: "main", session_id: "main-admission" },  kind: "local-admission", request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", caller: { kind: "main", session_id: "main-admission" }, operation_digest: sha("operation"), reserved_agent_id: AGENT, reserved_task_id: TASK, reserved_task_path: "/root/review", structural_parent: { kind: "main", session_id: "main-admission" }, logical_lease_key: TASK, public_result_json: "{}", public_result_sha256: sha("{}"), phase: "prepared" }, lease_intents: [{ api_version: 1, session_id: "main-admission", owner_id: "pi-subagents", logical_key: TASK, reason: "spawn" }], artifacts: [{ temporary_path: `prepared/${TX}/artifacts/session.jsonl`, final_path: `conversations/${AGENT}/session.jsonl`, bytes: session.length, sha256: sha(session), kind: "conversation" }, { temporary_path: `prepared/${TX}/artifacts/system-prompt.txt`, final_path: `conversations/${AGENT}/system-prompt.txt`, bytes: prompt.length, sha256: sha(prompt), kind: "system-prompt" }] }; }
function mutations(store: Awaited<ReturnType<typeof openMainStoreV1>>, running = false) { const root = store.snapshot().root; const { session } = artifacts(); const agent = {lifecycle: "open" as const, lifecycle_revision: 1, runtime_generation: 0,  version: 1 as const, record_revision: 1, agent_id: AGENT, parent_conversation: { kind: "main" as const, session_id: "main-admission" }, task_name: "review", task_path: "/root/review", depth: 1 as const, created_at: NOW, created_revision: 1, profile: profile(), conversation: { session_id: "child-session", relative_path: `conversations/${AGENT}/session.jsonl`, initial_bytes: session.length, initial_sha256: sha(session), last_validated_bytes: session.length, last_validated_mtime_ms: 1 }, availability: "available" as const, ...(running ? { current_task_id: TASK, queued_task_ids: [] } : { queued_task_ids: [TASK] }), next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0 };
  const task = {initiator: {kind: "main-model" as const, conversation: {kind: "main" as const, session_id: "main-admission"}}, owner_conversation: {kind: "main" as const, session_id: "main-admission"},  version: 1 as const, record_revision: 1, task_id: TASK, agent_id: AGENT, origin: "initial" as const, admission_order: 1, message: "review", phase: running ? "running" as const : "admitted" as const, admitted_at: NOW, ...(running ? { started_at: NOW, deadline_at_ms: Date.parse(NOW) + 60_000, runtime_generation: 1 } : {}), lease_intent: { api_version: 1 as const, session_id: "main-admission", owner_id: "pi-subagents" as const, logical_key: TASK, reason: "spawn" }, lease_disposition: "required" as const };
  const receiptId = encodeDomainId("rcp", Buffer.alloc(16, 14));
  const receipt = { version: 1 as const, record_revision: 1, receipt_id: receiptId, request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operation_digest: sha("operation"), caller: { kind: "main" as const, session_id: "main-admission" }, runtime_generation: 1, operation: "spawn-agent", state: "committed" as const, transaction_id: TX, result_sha256: sha("{}"), result_json: "{}", created_at: NOW, settled_at: NOW };
  return [{ version: 1 as const, type: "put" as const, transaction_id: TX, entity_type: "root" as const, entity_id: "root", value: { ...rootHeaderV1(root), host_revision: 1, next_admission_order: 2, agent_ids: [AGENT] } }, { version: 1 as const, type: "put" as const, transaction_id: TX, entity_type: "agent" as const, entity_id: AGENT, value: agent }, { version: 1 as const, type: "put" as const, transaction_id: TX, entity_type: "task" as const, entity_id: TASK, value: task }, { version: 1 as const, type: "put" as const, transaction_id: TX, entity_type: "operation-receipt" as const, entity_id: receiptId, value: receipt }]; }

class LeasePort {
  acquired = 0; released = 0; retained = 0;
  async acquire(): Promise<PreparedLeaseHandleV1> { this.acquired++; let released = false; return { releaseWithoutWake: async () => { if (!released) { released = true; this.released++; } } }; }
  async releaseIntent(): Promise<void> { this.released++; }
  retainUncertain(): void { this.retained++; }
}

test("prepared local admission promotes both artifacts and commits identity only after lease", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-admission", now: () => new Date(NOW) }); const lease = new LeasePort(); const bytes = artifacts();
  const result = await runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: record(), artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store), leasePort: lease, commit: (input) => store.commit(input), now: () => new Date(NOW) });
  assert.equal(result.revision, 1); assert.equal(lease.acquired, 1); assert.equal(lease.released, 0); assert.equal(store.snapshot().agents[0]!.agent.agent_id, AGENT); assert.deepEqual(await readFile(join(store.paths.mainRoot, `conversations/${AGENT}/system-prompt.txt`)), bytes.prompt); await store.close();
});

test("fault injection at every admission phase preserves the commit visibility boundary", async (t) => {
  const preCommit: PrepareAdmissionStepV1[] = ["prepare-synced", "artifacts-synced", "lease-acquired", "lease-phase-synced", "artifacts-promoted", "commit-phase-synced"];
  for (const [index, step] of preCommit.entries()) {
    const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const session = `main-admission-fault-${index}`; const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: session, now: () => new Date(NOW) }); const lease = new LeasePort(); const bytes = artifacts(); const prepared = record(); (prepared.prepared_operation as { caller: { session_id: string }; structural_parent: { session_id: string } }).caller.session_id = session; (prepared.prepared_operation as { structural_parent: { session_id: string } }).structural_parent.session_id = session; (prepared.prepared_operation as { lease_owner: { session_id: string } }).lease_owner.session_id = session; prepared.lease_intents[0]!.session_id = session;
    const fault = new Error(`fault:${step}`) as NodeJS.ErrnoException; fault.code = step === "artifacts-synced" ? "ENOSPC" : "EIO";
    await assert.rejects(runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: prepared, artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store), leasePort: lease, commit: (input) => store.commit(input), now: () => new Date(NOW), fault(current) { if (current === step) throw fault; } }), /fault:/);
    assert.equal(store.snapshot().agents.length, 0, step); assert.equal(lease.released, lease.acquired, step); await assert.rejects(readFile(join(store.paths.mainRoot, `conversations/${AGENT}/session.jsonl`)), { code: "ENOENT" }); await store.close();
  }
});

test("pre-commit failure releases lease and exposes neither identity nor artifacts", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-admission", now: () => new Date(NOW) }); const lease = new LeasePort(); const bytes = artifacts();
  await assert.rejects(runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: record(), artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store), leasePort: lease, commit: async () => { const error = new Error("disk full") as NodeJS.ErrnoException; error.code = "ENOSPC"; throw error; }, now: () => new Date(NOW) }), /disk full/);
  assert.equal(lease.acquired, 1); assert.equal(lease.released, 1); assert.equal(store.snapshot().agents.length, 0); await assert.rejects(readFile(join(store.paths.mainRoot, `conversations/${AGENT}/session.jsonl`)), { code: "ENOENT" }); await store.close();
});

test("unknown commit state preserves lease, prepare evidence and promoted artifacts for recovery", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-admission", now: () => new Date(NOW) }); const lease = new LeasePort(); const bytes = artifacts();
  await assert.rejects(runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: record(), artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store), leasePort: lease, commit: async () => { throw new CommitUncertainError("uncertain", new Error("EIO"), "unknown"); }, now: () => new Date(NOW) }), CommitUncertainError);
  assert.equal(lease.acquired, 1); assert.equal(lease.released, 0); assert.equal(lease.retained, 1); assert.deepEqual(await readFile(join(store.paths.mainRoot, `conversations/${AGENT}/session.jsonl`)), bytes.session); assert.ok((await readFile(join(store.paths.prepared, TX, "prepare.json"))).length > 0); await store.close();
});

test("owner prepared recovery preserves live unexpired prepare and aborts expired/lease-proved with release authority", async (t) => {
  for (const [phase, live, expected, generation, token] of [["prepared", true, "pending", 7, true], ["prepared", true, "aborted", 8, true], ["prepared", true, "aborted", 7, false], ["prepared", false, "aborted", 7, true], ["lease-proved", false, "aborted", 7, true]] as const) {
    const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: `main-owner-${phase}-${live}`, now: () => new Date(NOW) });
    const ownerRecord = structuredClone(record()); const op = ownerRecord.prepared_operation as any; op.kind = "spawn"; op.caller = { kind: "agent", session_id: "parent-session", agent_id: AGENT }; op.caller_runtime_generation = 7; op.prepared_token_sha256 = sha("token"); op.expires_at = new Date(Date.parse(NOW) + 30_000).toISOString(); op.lease_owner = op.caller; op.phase = phase; ownerRecord.lease_intents[0]!.session_id = "parent-session";
    const dir = join(store.paths.prepared, TX); await mkdir(dir, { mode: 0o700 }); await mkdir(join(dir, "artifacts"), { mode: 0o700 }); await writeFile(join(dir, "prepare.json"), `${canonicalJsonV1(ownerRecord)}\n`, { mode: 0o600 }); const lease = new LeasePort();
    const result = await reconcilePreparedDirectoriesV1(store.paths.mainRoot, new Set(), { now: () => new Date(live ? NOW : new Date(Date.parse(NOW) + 31_000)), liveRuntimeGenerations: live ? new Map([[AGENT, { runtimeGeneration: generation, preparedTokenDigests: new Set(token ? [sha("token")] : []) }]]) : new Map(), leasePort: lease });
    assert.equal(result[expected].includes(TX), true); if (phase === "lease-proved") assert.equal(lease.released, 1); await store.close();
  }
});

test("reopen settles a lost running Task through the normal Completion/Inbox/Outbox transaction", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const options = { agentDirectory: root, mainSessionId: "main-admission", now: () => new Date(NOW) }; const store = await openMainStoreV1(options); const lease = new LeasePort(); const bytes = artifacts();
  await runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: record(), artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store, true), leasePort: lease, commit: (input) => store.commit(input), now: () => new Date(NOW) });
  await store.close();
  const reopened = await openMainStoreV1({ ...options, liveRuntimeGenerations: new Map() }); const snapshot = reopened.snapshot();
  assert.equal(snapshot.agents[0]!.tasks[0]!.reason, "host-lost"); assert.equal(snapshot.agents[0]!.tasks[0]!.phase, "settled"); assert.equal(snapshot.agents[0]!.completions.length, 1); assert.equal(snapshot.root.inbox.length, 1); assert.equal(snapshot.agents[0]!.outbox.length, 1); await reopened.close();
});

test("prompt drift marks only its Agent unavailable while Main metadata remains readable", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const options = { agentDirectory: root, mainSessionId: "main-admission", now: () => new Date(NOW) }; const store = await openMainStoreV1(options); const lease = new LeasePort(); const bytes = artifacts();
  await runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: record(), artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store), leasePort: lease, commit: (input) => store.commit(input), now: () => new Date(NOW) }); const promptPath = join(store.paths.mainRoot, `conversations/${AGENT}/system-prompt.txt`); await store.close();
  await writeFile(promptPath, "changed\n", { mode: 0o600 });
  const reopened = await openMainStoreV1(options); assert.equal(reopened.snapshot().agents[0]!.agent.availability, "unavailable"); assert.equal(reopened.snapshot().agents[0]!.agent.unavailable_reason, "capability-drift"); await reopened.close();
});

test("checkpointed OperationReceipt remains commit-wins evidence for a leftover prepared directory", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const options = { agentDirectory: root, mainSessionId: "main-admission", now: () => new Date(NOW) }; const store = await openMainStoreV1(options); const lease = new LeasePort(); const bytes = artifacts(); const prepareRecord = record();
  await runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: prepareRecord, artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store), leasePort: lease, commit: (input) => store.commit(input), now: () => new Date(NOW) });
  await store.checkpoint();
  const leftover = join(store.paths.prepared, TX); await mkdir(leftover, { mode: 0o700 }); await mkdir(join(leftover, "artifacts"), { mode: 0o700 }); await writeFile(join(leftover, "prepare.json"), `${canonicalJsonV1(prepareRecord)}\n`, { mode: 0o600 }); await store.close();
  const reopened = await openMainStoreV1(options); assert.equal(reopened.snapshot().agents.length, 1); assert.deepEqual(await readFile(join(reopened.paths.mainRoot, `conversations/${AGENT}/session.jsonl`)), bytes.session); await assert.rejects(readFile(join(leftover, "prepare.json")), { code: "ENOENT" }); await reopened.close();
});

test("committed prepared directory is cleanup-only and recovery never aborts public artifacts", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-admission", now: () => new Date(NOW) }); const lease = new LeasePort(); const bytes = artifacts();
  await runPreparedAdmissionV1({ mainRoot: store.paths.mainRoot, record: record(), artifactBytes: new Map([[`prepared/${TX}/artifacts/session.jsonl`, bytes.session], [`prepared/${TX}/artifacts/system-prompt.txt`, bytes.prompt]]), mutations: mutations(store), leasePort: lease, commit: (input) => store.commit(input), now: () => new Date(NOW), fs: { fault(step) { if (step === "before-remove") throw new Error("cleanup fault"); } } });
  assert.equal(store.snapshot().agents.length, 1); assert.deepEqual(await readFile(join(store.paths.mainRoot, `conversations/${AGENT}/session.jsonl`)), bytes.session);
  const reconciled = await reconcilePreparedDirectoriesV1(store.paths.mainRoot, new Set([TX])); assert.deepEqual(reconciled.committed, [TX]); assert.equal(reconciled.aborted.length, 0); await store.close();
});
