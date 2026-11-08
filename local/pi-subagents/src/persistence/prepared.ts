import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { canonicalJsonV1, parseStrictJsonV1 } from "./canonical.js";
import { atomicReplacePrivateFile, inspectPrivateDirectory, inspectPrivateFile, listPrivateDirectory, readPrivateFile, removeValidatedPrivateTree, syncDirectory, writePrivateFileExclusive, type SafeFsOptionsV1 } from "./fs-safe.js";
import { isDomainId } from "../domain/ids.js";
import type { AbortRecordV1, LeaseIntentV1, PrepareRecordV1, PreparedArtifactV1, PreparedOperationV1 } from "./types.js";
import type { MainStoreCommitInputV1, MainStoreCommitResultV1 } from "./store.js";
import { CommitUncertainError } from "./transaction.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

export interface PreparedLeaseHandleV1 { releaseWithoutWake(reason: "cancelled"): Promise<void> }
export interface PreparedLeasePortV1 {
  acquire(intent: LeaseIntentV1): Promise<PreparedLeaseHandleV1>;
  releaseIntent?(intent: LeaseIntentV1): Promise<void>;
  retainUncertain?(transactionId: string, intents: readonly LeaseIntentV1[], handles: readonly PreparedLeaseHandleV1[]): void;
}
export type PrepareAdmissionStepV1 = "prepare-synced" | "artifacts-synced" | "lease-acquired" | "lease-phase-synced" | "artifacts-promoted" | "commit-phase-synced" | "journal-committed" | "cleanup-complete";
export interface PrepareAdmissionInputV1 {
  readonly mainRoot: string;
  readonly record: PrepareRecordV1;
  readonly artifactBytes: ReadonlyMap<string, Uint8Array>;
  readonly mutations: MainStoreCommitInputV1["mutations"];
  readonly leasePort: PreparedLeasePortV1;
  readonly commit: (input: MainStoreCommitInputV1) => Promise<MainStoreCommitResultV1>;
  readonly now?: () => Date;
  readonly fs?: SafeFsOptionsV1;
  readonly fault?: (step: PrepareAdmissionStepV1) => void | Promise<void>;
}

function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function timestamp(value: unknown, label: string): string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value) throw new Error(`${label} timestamp is invalid`); return value; }
function safeRelative(value: unknown, prefix?: string): string { if (typeof value !== "string" || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("prepared path is unsafe"); if (prefix && !value.startsWith(prefix)) throw new Error("prepared path has wrong prefix"); return value; }
function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("prepared record must be plain object"); const object = value as Record<string, unknown>; const allowed = new Set([...required, ...optional]); if (Object.keys(object).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(object, key))) throw new Error("prepared record has unknown or missing keys"); return object; }
function conversation(value: unknown) { const object = exactObject(value, ["kind", "session_id"], ["agent_id"]); if (object.kind !== "main" && object.kind !== "agent") throw new Error("prepared conversation kind is invalid"); if (typeof object.session_id !== "string" || Buffer.byteLength(object.session_id) < 1 || Buffer.byteLength(object.session_id) > 512) throw new Error("prepared session id invalid"); if ((object.kind === "agent") !== (typeof object.agent_id === "string" && isDomainId(object.agent_id, "agt"))) throw new Error("prepared Agent ref invalid"); return object as unknown as { kind: "main" | "agent"; session_id: string; agent_id?: `agt_${string}` }; }
function lease(value: unknown): LeaseIntentV1 { const object = exactObject(value, ["api_version", "session_id", "owner_id", "logical_key", "reason"]); if (object.api_version !== 1 || object.owner_id !== "pi-subagents" || typeof object.session_id !== "string" || !isDomainId(object.logical_key, "tsk") || typeof object.reason !== "string" || /[\r\n]/u.test(object.reason) || Buffer.byteLength(object.reason) > 512) throw new Error("prepared lease intent invalid"); return object as unknown as LeaseIntentV1; }
function artifact(value: unknown, transactionId: string): PreparedArtifactV1 { const object = exactObject(value, ["temporary_path", "final_path", "bytes", "sha256", "kind"]); const temporary = safeRelative(object.temporary_path, `prepared/${transactionId}/artifacts/`); const final = safeRelative(object.final_path); if (!Number.isSafeInteger(object.bytes) || (object.bytes as number) < 1 || typeof object.sha256 !== "string" || !HEX64.test(object.sha256) || !["conversation", "system-prompt", "checkpoint-input", "cleanup-input"].includes(object.kind as string)) throw new Error("prepared artifact invalid"); return { temporary_path: temporary, final_path: final, bytes: object.bytes as number, sha256: object.sha256, kind: object.kind as PreparedArtifactV1["kind"] }; }
function operation(value: unknown, createdAt?: string): PreparedOperationV1 { const object = value as Record<string, unknown>; if (!object || typeof object.kind !== "string") throw new Error("prepared operation kind missing"); const common = ["kind", "request_id", "caller", "operation_digest", "phase"] as const; const owner = object.kind === "spawn" || object.kind === "followup"; const local = object.kind === "local-admission"; const metadata = object.kind === "metadata-mutation"; if (!owner && !local && !metadata) throw new Error("prepared operation kind invalid"); const optional = owner ? ["caller_runtime_generation", "prepared_token_sha256", "expires_at", "reserved_agent_id", "reserved_task_id", "reserved_task_path", "structural_parent", "logical_lease_key", "lease_owner", "public_result_json", "public_result_sha256"] : local ? ["lease_owner", "reserved_agent_id", "reserved_task_id", "reserved_task_path", "structural_parent", "logical_lease_key", "public_result_json", "public_result_sha256"] : [];
  exactObject(value, common, optional); if (typeof object.request_id !== "string" || !UUID_V4.test(object.request_id) || typeof object.operation_digest !== "string" || !HEX64.test(object.operation_digest)) throw new Error("prepared operation identity invalid"); conversation(object.caller); const phases = metadata ? ["prepared", "commit-requested"] : ["prepared", "lease-proved", "commit-requested"]; if (!phases.includes(object.phase as string)) throw new Error("prepared operation phase invalid"); if (!metadata) { if (!isDomainId(object.reserved_task_id, "tsk") || !isDomainId(object.logical_lease_key, "tsk") || object.reserved_task_id !== object.logical_lease_key || typeof object.reserved_task_path !== "string" || typeof object.public_result_json !== "string" || typeof object.public_result_sha256 !== "string" || sha256(object.public_result_json) !== object.public_result_sha256) throw new Error("prepared task operation invalid"); conversation(object.structural_parent); if (object.reserved_agent_id !== undefined && !isDomainId(object.reserved_agent_id, "agt")) throw new Error("prepared Agent id invalid"); }
  if (local) conversation(object.lease_owner);
  if (owner) { if (!Number.isSafeInteger(object.caller_runtime_generation) || (object.caller_runtime_generation as number) <= 0 || typeof object.prepared_token_sha256 !== "string" || !HEX64.test(object.prepared_token_sha256)) throw new Error("prepared owner operation invalid"); const expires = timestamp(object.expires_at, "prepared expiry"); if (createdAt !== undefined && Date.parse(expires) !== Date.parse(createdAt) + 30_000) throw new Error("prepared owner expiry must be exactly 30 seconds"); conversation(object.lease_owner); }
  return object as unknown as PreparedOperationV1;
}
function validateArtifactOwnership(record: PrepareRecordV1): void {
  const operation = record.prepared_operation;
  const isSpawn = operation.kind === "spawn" || (operation.kind === "local-admission" && operation.reserved_agent_id !== undefined);
  if (!isSpawn) {
    if (record.artifacts.length !== 0) throw new Error("non-spawn prepared operation cannot own artifacts");
    return;
  }
  const agentId = operation.reserved_agent_id;
  if (!agentId) throw new Error("spawn prepared operation requires reserved_agent_id");
  if (record.artifacts.length !== 2) throw new Error("spawn admission requires exactly two artifacts");
  const expected = new Map([
    ["conversation", { temporary: `prepared/${record.transaction_id}/artifacts/session.jsonl`, final: `conversations/${agentId}/session.jsonl` }],
    ["system-prompt", { temporary: `prepared/${record.transaction_id}/artifacts/system-prompt.txt`, final: `conversations/${agentId}/system-prompt.txt` }],
  ]);
  for (const item of record.artifacts) {
    const path = expected.get(item.kind);
    if (!path || item.temporary_path !== path.temporary || item.final_path !== path.final) throw new Error("prepared artifact path/owner mismatch");
    expected.delete(item.kind);
  }
  if (expected.size !== 0) throw new Error("spawn prepared artifact set is incomplete");
}
export function decodePrepareRecordV1(value: unknown): PrepareRecordV1 { const object = exactObject(value, ["version", "transaction_id", "operation", "base_revision", "proposed_revision", "created_at", "prepared_operation", "lease_intents", "artifacts"]); if (object.version !== 1 || !isDomainId(object.transaction_id, "txn") || typeof object.operation !== "string" || !Number.isSafeInteger(object.base_revision) || (object.base_revision as number) < 0 || object.proposed_revision !== (object.base_revision as number) + 1 || !Array.isArray(object.lease_intents) || !Array.isArray(object.artifacts)) throw new Error("prepare record identity/revision invalid"); const transactionId = object.transaction_id as `txn_${string}`; const result: PrepareRecordV1 = { version: 1, transaction_id: transactionId, operation: object.operation, base_revision: object.base_revision as number, proposed_revision: object.proposed_revision as number, created_at: timestamp(object.created_at, "prepare created"), prepared_operation: operation(object.prepared_operation, object.created_at as string), lease_intents: object.lease_intents.map(lease), artifacts: object.artifacts.map((item) => artifact(item, transactionId)) }; if (new Set(result.artifacts.flatMap((item) => [item.temporary_path, item.final_path])).size !== result.artifacts.length * 2) throw new Error("prepared artifact paths overlap"); if (result.prepared_operation.kind !== "metadata-mutation") { if (result.lease_intents.length !== 1 || result.lease_intents[0]!.logical_key !== result.prepared_operation.logical_lease_key || result.lease_intents[0]!.session_id !== result.prepared_operation.lease_owner.session_id) throw new Error("prepared lease intent/operation mismatch"); } else if (result.lease_intents.length !== 0) throw new Error("metadata mutation cannot own a lease intent"); validateArtifactOwnership(result); return result; }
function encodeLine(value: unknown): Uint8Array { return Buffer.from(`${canonicalJsonV1(value)}\n`, "utf8"); }
function parseLine(bytes: Uint8Array): unknown { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("prepared metadata must be one line"); return parseStrictJsonV1(Buffer.from(text.slice(0, -1))); }

async function ensureArtifactDirectories(path: string, mainRoot: string, fs?: SafeFsOptionsV1): Promise<void> { const target = dirname(path); const relativeTarget = relative(mainRoot, target); let current = mainRoot; for (const segment of relativeTarget.split("/")) { if (!segment) continue; current = join(current, segment); try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } await inspectPrivateDirectory(current, fs); } }
async function removePath(path: string, fs?: SafeFsOptionsV1): Promise<void> { try { await removeValidatedPrivateTree(path, fs); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
function withPhase(record: PrepareRecordV1, phase: "prepared" | "lease-proved" | "commit-requested"): PrepareRecordV1 { return { ...record, prepared_operation: { ...record.prepared_operation, phase } as PreparedOperationV1 }; }
async function replacePrepare(directory: string, record: PrepareRecordV1, fs?: SafeFsOptionsV1): Promise<void> { await atomicReplacePrivateFile(join(directory, "prepare.json"), encodeLine(record), `prepare-${record.prepared_operation.phase}.tmp`, fs); }

export interface StagedOwnerTaskOptionsV1 { readonly mainRoot: string; readonly transactionId: string; readonly clearToken: string; readonly fs?: SafeFsOptionsV1; readonly now?: () => Date }
export async function stageOwnerTaskPrepareV1(input: { readonly mainRoot: string; readonly record: PrepareRecordV1; readonly artifactBytes: ReadonlyMap<string, Uint8Array>; readonly fs?: SafeFsOptionsV1 }): Promise<void> {
  const record = decodePrepareRecordV1(input.record); if (record.prepared_operation.kind !== "spawn" && record.prepared_operation.kind !== "followup") throw new Error("staged prepare requires an owner Task operation"); if (record.prepared_operation.phase !== "prepared") throw new Error("staged prepare must start in prepared phase");
  const preparedRoot = join(input.mainRoot, "prepared", record.transaction_id); const artifactsRoot = join(preparedRoot, "artifacts");
  await mkdir(preparedRoot, { mode: 0o700 }); await mkdir(artifactsRoot, { mode: 0o700 }); await inspectPrivateDirectory(preparedRoot, input.fs); await inspectPrivateDirectory(artifactsRoot, input.fs);
  try {
    await writePrivateFileExclusive(join(preparedRoot, "prepare.json"), encodeLine(record), input.fs);
    for (const descriptor of record.artifacts) { const bytes = input.artifactBytes.get(descriptor.temporary_path); if (!bytes || bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw new Error("staged artifact bytes/digest mismatch"); const path = join(input.mainRoot, descriptor.temporary_path); await ensureArtifactDirectories(path, input.mainRoot, input.fs); await writePrivateFileExclusive(path, bytes, input.fs); }
    await syncDirectory(artifactsRoot, input.fs); await syncDirectory(preparedRoot, input.fs); await syncDirectory(join(input.mainRoot, "prepared"), input.fs);
  } catch (error) { await removePath(preparedRoot, input.fs).catch(() => undefined); throw error; }
}
export async function readStagedOwnerTaskV1(mainRoot: string, transactionId: string, fs?: SafeFsOptionsV1): Promise<PrepareRecordV1> {
  if (!isDomainId(transactionId, "txn")) throw new Error("staged transaction ID is invalid");
  const directory = join(mainRoot, "prepared", transactionId); await inspectPrivateDirectory(directory, fs); return decodePrepareRecordV1(parseLine(await readPrivateFile(join(directory, "prepare.json"), 1_048_576, fs)));
}
function verifyStagedToken(record: PrepareRecordV1, clearToken: string, now: Date): asserts record is PrepareRecordV1 & { prepared_operation: Extract<PreparedOperationV1, { kind: "spawn" | "followup" }> } {
  const operation = record.prepared_operation; if (operation.kind !== "spawn" && operation.kind !== "followup") throw new Error("staged operation is not owner Task admission"); if (typeof clearToken !== "string" || Buffer.byteLength(clearToken) < 32 || sha256(clearToken) !== operation.prepared_token_sha256) throw new Error("prepared token mismatch"); if (Date.parse(operation.expires_at) <= now.getTime()) throw new Error("prepared operation expired");
}
export async function proveStagedOwnerLeaseV1(input: StagedOwnerTaskOptionsV1): Promise<PrepareRecordV1> {
  const record = await readStagedOwnerTaskV1(input.mainRoot, input.transactionId, input.fs); verifyStagedToken(record, input.clearToken, (input.now ?? (() => new Date()))()); if (record.prepared_operation.phase !== "prepared") throw new Error("staged operation is not awaiting lease proof"); const next = withPhase(record, "lease-proved"); await replacePrepare(join(input.mainRoot, "prepared", record.transaction_id), next, input.fs); return next;
}
export async function promoteStagedOwnerTaskV1(input: StagedOwnerTaskOptionsV1): Promise<PrepareRecordV1> {
  const record = await readStagedOwnerTaskV1(input.mainRoot, input.transactionId, input.fs); verifyStagedToken(record, input.clearToken, (input.now ?? (() => new Date()))()); if (record.prepared_operation.phase !== "lease-proved") throw new Error("staged operation has no lease proof");
  for (const descriptor of record.artifacts) { const from = join(input.mainRoot, descriptor.temporary_path); const to = join(input.mainRoot, descriptor.final_path); const bytes = await readPrivateFile(from, descriptor.bytes, input.fs); if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw new Error("staged artifact proof mismatch"); await ensureArtifactDirectories(to, input.mainRoot, input.fs); try { await inspectPrivateFile(to, input.fs); throw new Error("staged final artifact already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await rename(from, to); await syncDirectory(dirname(to), input.fs); }
  const next = withPhase(record, "commit-requested"); await replacePrepare(join(input.mainRoot, "prepared", record.transaction_id), next, input.fs); return next;
}
export async function cleanupStagedOwnerTaskV1(mainRoot: string, transactionId: string, fs?: SafeFsOptionsV1): Promise<void> { if (!isDomainId(transactionId, "txn")) throw new Error("staged transaction ID is invalid"); await removePath(join(mainRoot, "prepared", transactionId), fs); await syncDirectory(join(mainRoot, "prepared"), fs); }

export async function runPreparedAdmissionV1(input: PrepareAdmissionInputV1): Promise<MainStoreCommitResultV1> {
  const record = decodePrepareRecordV1(input.record); if (record.base_revision + 1 !== record.proposed_revision) throw new Error("prepare revision mismatch");
  const receiptMutation = input.mutations.find((mutation) => mutation.type === "put" && mutation.entity_type === "operation-receipt" && (mutation.value as { transaction_id?: unknown; state?: unknown }).transaction_id === record.transaction_id && (mutation.value as { state?: unknown }).state === "committed");
  if (!receiptMutation) throw new Error("prepared admission must commit a matching operation receipt");
  if (record.prepared_operation.kind === "spawn" || (record.prepared_operation.kind === "local-admission" && record.prepared_operation.reserved_agent_id)) {
    const kinds = record.artifacts.map((artifact) => artifact.kind).sort();
    if (kinds.length !== 2 || kinds[0] !== "conversation" || kinds[1] !== "system-prompt") throw new Error("spawn admission requires exactly one conversation and one system-prompt artifact");
  }
  const preparedRoot = join(input.mainRoot, "prepared", record.transaction_id); const artifactsRoot = join(preparedRoot, "artifacts");
  await mkdir(preparedRoot, { mode: 0o700 }); await mkdir(artifactsRoot, { mode: 0o700 }); await inspectPrivateDirectory(preparedRoot, input.fs); await inspectPrivateDirectory(artifactsRoot, input.fs);
  const leases: PreparedLeaseHandleV1[] = [];
  let committed: MainStoreCommitResultV1 | undefined;
  try {
    // The recovery discriminator is durable before any artifact or lease side effect.
    await writePrivateFileExclusive(join(preparedRoot, "prepare.json"), encodeLine(record), input.fs); await syncDirectory(preparedRoot, input.fs); await syncDirectory(join(input.mainRoot, "prepared"), input.fs); await input.fault?.("prepare-synced");
    for (const descriptor of record.artifacts) { const bytes = input.artifactBytes.get(descriptor.temporary_path); if (!bytes || bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw new Error("prepared artifact bytes/digest mismatch"); const path = join(input.mainRoot, descriptor.temporary_path); await ensureArtifactDirectories(path, input.mainRoot, input.fs); await writePrivateFileExclusive(path, bytes, input.fs); }
    await syncDirectory(artifactsRoot, input.fs); await syncDirectory(preparedRoot, input.fs); await input.fault?.("artifacts-synced");
    for (const intent of record.lease_intents) leases.push(await input.leasePort.acquire(intent));
    await input.fault?.("lease-acquired");
    await replacePrepare(preparedRoot, withPhase(record, "lease-proved"), input.fs); await input.fault?.("lease-phase-synced");
    for (const descriptor of record.artifacts) { const from = join(input.mainRoot, descriptor.temporary_path); const to = join(input.mainRoot, descriptor.final_path); await ensureArtifactDirectories(to, input.mainRoot, input.fs); try { await inspectPrivateFile(to, input.fs); throw new Error("prepared final artifact already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await rename(from, to); await syncDirectory(dirname(to), input.fs); }
    await input.fault?.("artifacts-promoted");
    await replacePrepare(preparedRoot, withPhase(record, "commit-requested"), input.fs); await input.fault?.("commit-phase-synced");
    committed = await input.commit({ transactionId: record.transaction_id, operation: record.operation, mutations: input.mutations, createdAt: record.created_at, committedAt: (input.now ?? (() => new Date()))().toISOString() });
    await input.fault?.("journal-committed");
  } catch (error) {
    if (committed) return committed;
    if (error instanceof CommitUncertainError && error.commitState === "unknown") {
      // Preserve prepared record, acquired leases and promoted artifacts. Recovery
      // must rescan authority before deciding commit or abort.
      if (!input.leasePort.retainUncertain) throw new Error("uncertain commit requires a process-owned lease retention registry", { cause: error });
      input.leasePort.retainUncertain(record.transaction_id, record.lease_intents, leases);
      throw error;
    }
    const abort: AbortRecordV1 = { version: 1, transaction_id: record.transaction_id, aborted_at: (input.now ?? (() => new Date()))().toISOString(), reason_code: "admission-failed" };
    await writePrivateFileExclusive(join(preparedRoot, "abort.json"), encodeLine(abort), input.fs).catch(() => undefined);
    for (const leaseHandle of leases.reverse()) await leaseHandle.releaseWithoutWake("cancelled").catch(() => undefined);
    for (const descriptor of record.artifacts) { const final = join(input.mainRoot, descriptor.final_path); try { const bytes = await readPrivateFile(final, descriptor.bytes, input.fs); if (bytes.byteLength === descriptor.bytes && sha256(bytes) === descriptor.sha256) await rm(final); } catch { /* preserve absent or uncertain evidence */ } }
    await removePath(preparedRoot, input.fs).catch(() => undefined); throw error;
  }
  // Cleanup is maintenance after the irreversible journal commit. Failure leaves
  // evidence for recovery and must never release the lease or delete artifacts.
  await removePath(preparedRoot, input.fs).catch(() => undefined);
  await syncDirectory(join(input.mainRoot, "prepared"), input.fs).catch(() => undefined);
  try { await input.fault?.("cleanup-complete"); } catch { /* post-commit cleanup fault is diagnostic only */ }
  return committed;
}

export interface PreparedRecoveryResultV1 { committed: string[]; aborted: string[]; incompleteAborted: string[]; pending: string[]; degraded: string[]; leaseRecoveryDeferred: string[] }
export interface PreparedRecoveryOptionsV1 {
  readonly fs?: SafeFsOptionsV1;
  readonly now?: () => Date;
  readonly liveRuntimeGenerations?: ReadonlyMap<string, { readonly runtimeGeneration: number; readonly preparedTokenDigests: ReadonlySet<string> }>;
  readonly leasePort?: Pick<PreparedLeasePortV1, "releaseIntent">;
}
async function exactArtifact(path: string, descriptor: PreparedArtifactV1, fs?: SafeFsOptionsV1): Promise<"absent" | "exact"> {
  try {
    const bytes = await readPrivateFile(path, descriptor.bytes, fs);
    if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw new Error("prepared artifact identity/digest mismatch");
    return "exact";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** 只有安全且完全没有文件的目录树，才能证明 prepare 尚未写入；文件、链接、权限异常都不猜。 */
async function assertEmptyDirectoryTree(path: string, fs?: SafeFsOptionsV1): Promise<void> {
  for (const name of await listPrivateDirectory(path, fs)) await assertEmptyDirectoryTree(join(path, name), fs);
}

export async function reconcilePreparedDirectoriesV1(mainRoot: string, committedTransactionIds: ReadonlySet<string>, options: PreparedRecoveryOptionsV1 = {}): Promise<PreparedRecoveryResultV1> {
  const root = join(mainRoot, "prepared");
  const fs = options.fs;
  const result: PreparedRecoveryResultV1 = { committed: [], aborted: [], incompleteAborted: [], pending: [], degraded: [], leaseRecoveryDeferred: [] };
  for (const name of await listPrivateDirectory(root, fs)) {
    if (!isDomainId(name, "txn")) { result.degraded.push(name); continue; }
    const directory = join(root, name);
    try {
      const entries = await listPrivateDirectory(directory, fs);
      if (!entries.includes("prepare.json")) {
        await assertEmptyDirectoryTree(directory, fs);
        await removePath(directory, fs);
        result.aborted.push(name); result.incompleteAborted.push(name);
        continue;
      }
      const record = decodePrepareRecordV1(parseLine(await readPrivateFile(join(directory, "prepare.json"), 1_048_576, fs)));
      if (record.transaction_id !== name) throw new Error("prepared directory identity mismatch");
      if (committedTransactionIds.has(name)) {
        for (const descriptor of record.artifacts) {
          if (await exactArtifact(join(mainRoot, descriptor.final_path), descriptor, fs) !== "exact") throw new Error("committed prepared artifact is missing");
        }
        result.committed.push(name);
      } else {
        const operation = record.prepared_operation;
        if ((operation.kind === "spawn" || operation.kind === "followup") && operation.phase === "prepared" && Date.parse(operation.expires_at) > (options.now ?? (() => new Date()))().getTime()) {
          const live = options.liveRuntimeGenerations?.get(operation.caller.agent_id ?? "");
          if (live && live.runtimeGeneration === operation.caller_runtime_generation && live.preparedTokenDigests.has(operation.prepared_token_sha256)) {
            result.pending.push(name);
            continue;
          }
        }
        if (operation.kind !== "metadata-mutation" && operation.phase !== "prepared") {
          if (!options.leasePort?.releaseIntent) {
            // 没有 lease 释放权限时保留整个 prepared 目录等下一次带权限的 recovery。
            // 原来直接抛错会被记成 degraded，而 degraded 会让 openMainStoreV1 拒绝打开 —— 一次 spawn 中途崩溃就永久锁死这个 Main。
            result.pending.push(name);
            result.leaseRecoveryDeferred.push(name);
            continue;
          }
          for (const intent of record.lease_intents) await options.leasePort.releaseIntent(intent);
        }
        for (const descriptor of record.artifacts) {
          for (const candidate of [descriptor.temporary_path, descriptor.final_path]) {
            const path = join(mainRoot, safeRelative(candidate));
            if (await exactArtifact(path, descriptor, fs) === "exact") await rm(path);
          }
        }
        result.aborted.push(name);
      }
      await removePath(directory, fs);
    } catch { result.degraded.push(name); }
  }
  await syncDirectory(root, fs);
  return result;
}
