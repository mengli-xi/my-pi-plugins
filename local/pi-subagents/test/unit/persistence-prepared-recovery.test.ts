import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { proveStagedOwnerLeaseV1, reconcilePreparedDirectoriesV1, stageOwnerTaskPrepareV1 } from "../../src/persistence/prepared.ts";
import type { LeaseIntentV1, PrepareRecordV1 } from "../../src/persistence/types.ts";

const tx = encodeDomainId("txn", Buffer.alloc(16, 101));
const agent = encodeDomainId("agt", Buffer.alloc(16, 102));
const task = encodeDomainId("tsk", Buffer.alloc(16, 103));
const clear = "x".repeat(32);
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const now = new Date("2027-01-01T00:00:00.000Z");

async function mainRoot(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-subagents-prepared-"));
  await chmod(path, 0o700);
  await mkdir(join(path, "prepared"), { mode: 0o700 });
  await mkdir(join(path, "conversations"), { mode: 0o700 });
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function record(): PrepareRecordV1 {
  return { version: 1, transaction_id: tx, operation: "owner-followup", base_revision: 2, proposed_revision: 3, created_at: now.toISOString(), prepared_operation: { kind: "followup", request_id: "11111111-1111-4111-8111-111111111111", caller: { kind: "agent", session_id: "parent-session", agent_id: agent }, caller_runtime_generation: 1, operation_digest: sha("op"), prepared_token_sha256: sha(clear), expires_at: new Date(now.getTime() + 30_000).toISOString(), reserved_task_id: task, reserved_task_path: "/root/parent/child", structural_parent: { kind: "agent", session_id: "parent-session", agent_id: agent }, logical_lease_key: task, lease_owner: { kind: "agent", session_id: "parent-session", agent_id: agent }, public_result_json: "{}", public_result_sha256: sha("{}"), phase: "prepared" }, lease_intents: [{ api_version: 1, session_id: "parent-session", owner_id: "pi-subagents", logical_key: task, reason: `Subagent task ${task} is running in the background` }], artifacts: [] };
}

test("a prepared directory past lease proof is deferred, not degraded, when no lease release authority exists", async (t) => {
  const root = await mainRoot(t);
  await stageOwnerTaskPrepareV1({ mainRoot: root, record: record(), artifactBytes: new Map() });
  await proveStagedOwnerLeaseV1({ mainRoot: root, transactionId: tx, clearToken: clear, now: () => now });
  // 没有 releaseIntent 时不能报 degraded：openMainStoreV1 见到 degraded 就拒绝打开，一次 spawn 中途崩溃会永久锁死这个 Main。
  const result = await reconcilePreparedDirectoriesV1(root, new Set(), { now: () => new Date(now.getTime() + 60_000) });
  assert.deepEqual(result.degraded, []);
  assert.deepEqual(result.aborted, []);
  assert.deepEqual(result.pending, [tx]);
  assert.deepEqual(result.leaseRecoveryDeferred, [tx]);
  assert.deepEqual(await readdir(join(root, "prepared")), [tx]);
});

test("the same prepared directory aborts and releases its intent once lease authority is available", async (t) => {
  const root = await mainRoot(t);
  await stageOwnerTaskPrepareV1({ mainRoot: root, record: record(), artifactBytes: new Map() });
  await proveStagedOwnerLeaseV1({ mainRoot: root, transactionId: tx, clearToken: clear, now: () => now });
  const released: LeaseIntentV1[] = [];
  const result = await reconcilePreparedDirectoriesV1(root, new Set(), { now: () => new Date(now.getTime() + 60_000), leasePort: { async releaseIntent(intent) { released.push(intent); } } });
  assert.deepEqual(result.aborted, [tx]);
  assert.deepEqual(result.leaseRecoveryDeferred, []);
  assert.deepEqual(released.map((intent) => intent.logical_key), [task]);
  assert.deepEqual(await readdir(join(root, "prepared")), []);
});

test("a prepared directory still in the prepared phase never needs lease release authority", async (t) => {
  const root = await mainRoot(t);
  await stageOwnerTaskPrepareV1({ mainRoot: root, record: record(), artifactBytes: new Map() });
  const result = await reconcilePreparedDirectoriesV1(root, new Set(), { now: () => new Date(now.getTime() + 60_000) });
  assert.deepEqual(result.degraded, []);
  assert.deepEqual(result.aborted, [tx]);
  assert.deepEqual(result.leaseRecoveryDeferred, []);
  assert.deepEqual(await readdir(join(root, "prepared")), []);
});

for (const nested of [false, true]) test(`missing prepare metadata aborts a tree containing only empty directories (nested=${nested})`, async (t) => {
  const root = await mainRoot(t), directory = join(root, "prepared", tx);
  await mkdir(directory, { mode: 0o700 });
  if (nested) {
    await mkdir(join(directory, "artifacts"), { mode: 0o700 });
    await mkdir(join(directory, "artifacts", "empty"), { mode: 0o700 });
  }
  const result = await reconcilePreparedDirectoriesV1(root, new Set());
  assert.deepEqual(result.aborted, [tx]);
  assert.deepEqual(result.degraded, []);
  assert.deepEqual(await readdir(join(root, "prepared")), []);
});

for (const residue of ["file", "empty-file", "symlink", "unsafe-directory"] as const) test(`missing prepare metadata preserves a tree with ${residue}`, async (t) => {
  const root = await mainRoot(t), directory = join(root, "prepared", tx), artifacts = join(directory, "artifacts");
  await mkdir(directory, { mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 });
  if (residue === "symlink") await symlink(join(root, "conversations"), join(artifacts, "residue"));
  else if (residue === "unsafe-directory") { await mkdir(join(artifacts, "residue"), { mode: 0o700 }); await chmod(join(artifacts, "residue"), 0o755); }
  else await writeFile(join(artifacts, "residue"), residue === "file" ? "unproven artifact" : "", { mode: 0o600 });
  const result = await reconcilePreparedDirectoriesV1(root, new Set());
  assert.deepEqual(result.aborted, []); assert.deepEqual(result.degraded, [tx]);
  assert.deepEqual(await readdir(artifacts), ["residue"]);
});
