import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { rootHeaderV1 } from "../../src/persistence/codecs.ts";
import { proveStagedOwnerLeaseV1, stageOwnerTaskPrepareV1 } from "../../src/persistence/prepared.ts";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../../src/persistence/layout.ts";
import { openMainStoreV1, type MainStoreV1 } from "../../src/persistence/store.ts";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const TX = (value: number) => encodeDomainId("txn", Buffer.alloc(16, value));

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-crash-"));
  await chmod(root, PRIVATE_DIR_MODE);
  return root;
}

function rootMutation(store: MainStoreV1, revision: number) {
  const snapshot = store.snapshot();
  return { version: 1 as const, type: "put" as const, transaction_id: TX(revision), entity_type: "root" as const, entity_id: "root", value: { ...rootHeaderV1(snapshot.root), host_revision: revision, next_admission_order: snapshot.root.next_admission_order + 1 } };
}
async function advance(store: MainStoreV1, revision: number) {
  return store.commit({ transactionId: TX(revision), operation: `advance-${revision}`, mutations: [rootMutation(store, revision)] });
}

test("a journal write that fails mid-transaction truncates the partial tail and keeps the store reopenable", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  let armed = false; let fired = false;
  const options = { agentDirectory: root, mainSessionId: "main-partial-write", now: () => NOW, fs: { async fault(step: string, path: string) { if (armed && !fired && step === "after-write" && path.includes("/journals/")) { fired = true; await truncate(path, (await stat(path)).size - 5); throw new Error("EIO-sim"); } } } };
  const store = await openMainStoreV1(options);
  const journal = join(store.paths.journals, "jr_0000000000000001.bin");
  const before = await readFile(journal);
  armed = true;
  await assert.rejects(advance(store, 1), (error: unknown) => (error as { commitState?: string }).commitState === "absent" && /proven absent/u.test((error as Error).message));
  // 被证明不存在的 commit 必须不留任何字节，否则下一次 append 会写在破损区段之后。
  assert.deepEqual(await readFile(journal), before);
  assert.equal(store.snapshot().root.host_revision, 0);
  assert.equal(store.health().storage, "healthy");
  assert.equal((await advance(store, 1)).revision, 1);
  await store.close();
  const reopened = await openMainStoreV1({ ...options, fs: undefined });
  assert.equal(reopened.snapshot().root.host_revision, 1);
  assert.equal((await readdir(reopened.paths.recovery)).length, 0);
  await reopened.close();
});

test("an uncertain journal commit fences further mutation instead of writing past unknown bytes", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  let armed = false;
  const options = { agentDirectory: root, mainSessionId: "main-uncertain-write", now: () => NOW, fs: { async fault(step: string, path: string) { if (!armed || !path.includes("/journals/")) return; if (step === "after-write") throw new Error("EIO-sim"); if (step === "before-open") throw new Error("EIO-reopen-sim"); } } };
  const store = await openMainStoreV1(options);
  armed = true;
  await assert.rejects(advance(store, 1), (error: unknown) => (error as { commitState?: string }).commitState === "unknown");
  armed = false;
  assert.equal(store.health().storage, "degraded-maintenance");
  await assert.rejects(advance(store, 1), /storage-unavailable.*uncertain/u);
  await store.close();
});

test("crash residue in another Main never fails this Main's commit while the own Main stays strict", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const mine = await openMainStoreV1({ agentDirectory: root, mainSessionId: "session-a", now: () => NOW });
  const other = await openMainStoreV1({ agentDirectory: root, mainSessionId: "session-b", now: () => NOW });
  const otherRoot = other.paths.mainRoot;
  await other.close();

  let revision = 0;
  assert.equal((await advance(mine, ++revision)).revision, revision);
  // 这些残留全部由实现自己产生：checkpoint 切换、marker 写入、锁创建、conversation 尾部修复各留一种。
  await writeFile(join(otherRoot, "CURRENT.tmp"), "half written", { mode: PRIVATE_FILE_MODE });
  await writeFile(join(otherRoot, `owner.tmp-${"0".repeat(32)}`), "", { mode: PRIVATE_FILE_MODE });
  await mkdir(join(otherRoot, "writer.lock"), { mode: PRIVATE_DIR_MODE });
  const conversation = join(otherRoot, "conversations", encodeDomainId("agt", Buffer.alloc(16, 5)));
  await mkdir(conversation, { mode: PRIVATE_DIR_MODE });
  await writeFile(join(conversation, `.repair-${encodeDomainId("txn", Buffer.alloc(16, 6))}.jsonl`), "{}\n", { mode: PRIVATE_FILE_MODE });
  await writeFile(join(otherRoot, "not-part-of-the-layout"), "x", { mode: PRIVATE_FILE_MODE });
  assert.equal((await advance(mine, ++revision)).revision, revision);

  await writeFile(join(mine.paths.mainRoot, "not-part-of-the-layout"), "x", { mode: PRIVATE_FILE_MODE });
  await assert.rejects(advance(mine, revision + 1), /unexpected Main store entry/u);
  await rm(join(mine.paths.mainRoot, "not-part-of-the-layout"));
  assert.equal((await advance(mine, ++revision)).revision, revision);
  await mine.close();
});

test("a torn owner marker temp is treated as crash residue instead of blocking every future open", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-torn-marker", now: () => NOW };
  const store = await openMainStoreV1(options);
  const mainRoot = store.paths.mainRoot;
  await advance(store, 1);
  await store.close();
  await writeFile(join(mainRoot, `owner.tmp-${"0".repeat(32)}`), "", { mode: PRIVATE_FILE_MODE });
  const reopened = await openMainStoreV1(options);
  assert.equal(reopened.snapshot().root.host_revision, 1);
  assert.equal((await readdir(mainRoot)).some((name) => name.startsWith("owner.tmp-")), false);
  await reopened.close();
});

test("an owner marker lost before rename is adopted from its intact temp", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-adopt-marker", now: () => NOW };
  const store = await openMainStoreV1(options);
  const mainRoot = store.paths.mainRoot;
  await store.close();
  const marker = await readFile(join(mainRoot, "owner.json"));
  await rm(join(mainRoot, "owner.json"));
  await writeFile(join(mainRoot, `owner.tmp-${"1".repeat(32)}`), marker, { mode: PRIVATE_FILE_MODE });
  await writeFile(join(mainRoot, `owner.tmp-${"2".repeat(32)}`), "torn", { mode: PRIVATE_FILE_MODE });
  const reopened = await openMainStoreV1(options);
  assert.deepEqual(await readFile(join(mainRoot, "owner.json")), marker);
  assert.equal((await readdir(mainRoot)).some((name) => name.startsWith("owner.tmp-")), false);
  await reopened.close();
});

test("a checkpoint that crashed before its journal never blocks the next checkpoint", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  let armed = false; let fired = false;
  const options = { agentDirectory: root, mainSessionId: "main-retry-checkpoint", now: () => NOW, fs: { fault(step: string, path: string) { if (armed && !fired && step === "before-open" && path.includes("/journals/jr_")) { fired = true; throw new Error("ENOSPC-sim"); } } } };
  const store = await openMainStoreV1(options);
  armed = true;
  await assert.rejects(store.checkpoint(), /checkpoint switch did not complete/u);
  armed = false;
  await store.checkpoint();
  assert.equal(store.health().storage, "healthy");
  assert.equal((await advance(store, 1)).revision, 1);
  await store.close();
  const reopened = await openMainStoreV1({ ...options, fs: undefined });
  assert.equal(reopened.snapshot().root.host_revision, 1);
  assert.deepEqual((await readdir(reopened.paths.checkpoints)).sort(), ["cp_0000000000000002"]);
  assert.deepEqual((await readdir(reopened.paths.journals)).sort(), ["jr_0000000000000002.bin"]);
  await reopened.close();
});

test("a prepared directory left past lease proof still lets the Main store open", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-prepared-open", now: () => NOW };
  const store = await openMainStoreV1(options);
  const mainRoot = store.paths.mainRoot;
  await store.close();
  const transactionId = encodeDomainId("txn", Buffer.alloc(16, 101));
  const agentId = encodeDomainId("agt", Buffer.alloc(16, 102));
  const taskId = encodeDomainId("tsk", Buffer.alloc(16, 103));
  const clear = "x".repeat(32);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const record = { version: 1 as const, transaction_id: transactionId, operation: "owner-followup", base_revision: 0, proposed_revision: 1, created_at: NOW.toISOString(), prepared_operation: { kind: "followup" as const, request_id: "11111111-1111-4111-8111-111111111111", caller: { kind: "agent" as const, session_id: "parent-session", agent_id: agentId }, caller_runtime_generation: 1, operation_digest: digest("op"), prepared_token_sha256: digest(clear), expires_at: new Date(NOW.getTime() + 30_000).toISOString(), reserved_task_id: taskId, reserved_task_path: "/root/parent/child", structural_parent: { kind: "agent" as const, session_id: "parent-session", agent_id: agentId }, logical_lease_key: taskId, lease_owner: { kind: "agent" as const, session_id: "parent-session", agent_id: agentId }, public_result_json: "{}", public_result_sha256: digest("{}"), phase: "prepared" as const }, lease_intents: [{ api_version: 1 as const, session_id: "parent-session", owner_id: "pi-subagents" as const, logical_key: taskId, reason: "background task" }], artifacts: [] };
  await stageOwnerTaskPrepareV1({ mainRoot, record, artifactBytes: new Map() });
  await proveStagedOwnerLeaseV1({ mainRoot, transactionId, clearToken: clear, now: () => NOW });
  // 调用方没提供 preparedLeaseRecovery 时，证据保留，但 store 必须还能打开。
  const reopened = await openMainStoreV1({ ...options, now: () => new Date(NOW.getTime() + 60_000) });
  assert.equal(reopened.snapshot().root.host_revision, 0);
  assert.deepEqual(await readdir(join(mainRoot, "prepared")), [transactionId]);
  await reopened.close();
});
