import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { encodeDomainId } from "../../src/domain/ids.ts";
import { rootHeaderV1 } from "../../src/persistence/codecs.ts";
import { canonicalJson } from "../../src/capabilities/canonical.ts";
import { crc32cHex } from "../../src/persistence/crc32.ts";
import { encodeFrameV1, encodePayloadV1, scanJournalV1, transactionDigestV1, type JournalPayloadV1 } from "../../src/persistence/journal.ts";
import { journalFileName } from "../../src/persistence/checkpoint.ts";
import { PRIVATE_DIR_MODE, storePaths } from "../../src/persistence/layout.ts";
import { openMainStoreV1 } from "../../src/persistence/store.ts";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const TX1 = encodeDomainId("txn", Buffer.alloc(16, 1));
const TX2 = encodeDomainId("txn", Buffer.alloc(16, 2));

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-store-"));
  await chmod(root, PRIVATE_DIR_MODE);
  return root;
}

function rootMutation(snapshot: ReturnType<Awaited<ReturnType<typeof openMainStoreV1>>["snapshot"]>, revision: number) {
  return {
    version: 1 as const,
    type: "put" as const,
    transaction_id: revision === 1 ? TX1 : TX2,
    entity_type: "root" as const,
    entity_id: "root",
    value: { ...rootHeaderV1(snapshot.root), host_revision: revision, next_admission_order: snapshot.root.next_admission_order + 1 },
  };
}

test("real store initializes generation one, commits, checkpoints and reopens exact authority", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-session", now: () => new Date(NOW), randomBytes: (size: number) => Buffer.alloc(size, 7) };
  const store = await openMainStoreV1(options);
  assert.equal(store.snapshot().root.host_revision, 0);
  await store.commit({ transactionId: TX1, operation: "advance", mutations: [rootMutation(store.snapshot(), 1)] });
  assert.equal(store.snapshot().root.host_revision, 1);
  await store.checkpoint();
  await store.commit({ transactionId: TX2, operation: "advance-2", mutations: [rootMutation(store.snapshot(), 2)] });
  await store.close();
  const reopened = await openMainStoreV1(options);
  assert.equal(reopened.snapshot().root.host_revision, 2);
  assert.equal(reopened.snapshot().root.next_admission_order, 3);
  await reopened.close();
});

test("open aborts an empty incomplete prepare and records one diagnostic", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-empty-prepare", now: () => NOW };
  const store = await openMainStoreV1(options), directory = join(store.paths.prepared, TX1);
  await store.close();
  await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, "artifacts"), { mode: 0o700 });
  const reopened = await openMainStoreV1(options);
  try {
    assert.equal(reopened.health().storage, "healthy");
    assert.deepEqual(await readdir(reopened.paths.prepared), []);
    await reopened.commit({ transactionId: TX2, operation: "advance", mutations: [{ ...rootMutation(reopened.snapshot(), 1), transaction_id: TX2 }] });
  } finally { await reopened.close(); }
  const diagnostics = storePaths(root).diagnosticsRoot;
  const records = async () => (await Promise.all((await readdir(diagnostics)).map(name => readFile(join(diagnostics, name), "utf8"))))
    .flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
  const recorded = await records();
  assert.equal(recorded.length, 1); assert.equal(recorded[0].code, "incomplete-prepare-aborted"); assert.equal(recorded[0].correlation_id, TX1);
  const again = await openMainStoreV1(options); await again.close();
  assert.deepEqual(await records(), recorded, "a cleaned prepare is not diagnosed again on reopen");
});

test("open rejects missing prepare metadata with a residual file and preserves its bytes", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-residual-prepare", now: () => NOW };
  const store = await openMainStoreV1(options), directory = join(store.paths.prepared, TX1);
  await store.close();
  await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, "artifacts"), { mode: 0o700 });
  const path = join(directory, "artifacts", "session.jsonl");
  await writeFile(path, "unproven artifact", { mode: 0o600 });
  await assert.rejects(openMainStoreV1(options), /prepared recovery is degraded/u);
  assert.equal(await readFile(path, "utf8"), "unproven artifact");
});

test("quota preflight counts full journal frames even when normalized state size barely changes", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-journal-quota", now: () => new Date(NOW), limits: { maxMetadataBytesPerMain: 2_000, maxStoreBytesPerMain: 536_870_912, maxStoreBytesPerProcess: 2_147_483_648 } }); const journal = join(store.paths.journals, journalFileName(1)); const before = await readFile(journal); const snapshot = store.snapshot(); const hugeOperation = "x".repeat(256); await assert.rejects(store.commit({ transactionId: TX1, operation: hugeOperation, mutations: [rootMutation(snapshot, 1)] }), /metadata|journal transaction/); assert.deepEqual(await readFile(journal), before); await store.close();
});

test("post-commit checkpoint failure never turns a durable transaction into rejection", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  let failCheckpoint = false;
  const options = { agentDirectory: root, mainSessionId: "main-post-commit", now: () => new Date(NOW), maintenancePolicy: { checkpointJournalBytes: Number.MAX_SAFE_INTEGER, checkpointTransactions: 1 }, fs: { fault(step: string, path: string) { if (failCheckpoint && step === "before-rename" && path.endsWith("/CURRENT")) throw new Error("checkpoint-fault"); } } };
  const store = await openMainStoreV1(options);
  failCheckpoint = true;
  const result = await store.commit({ transactionId: TX1, operation: "advance", mutations: [rootMutation(store.snapshot(), 1)] });
  assert.equal(result.revision, 1); assert.equal(store.snapshot().root.host_revision, 1);
  // compaction 没做成只降级 health，不影响已经落盘的 revision，也不能挡住后续 commit。
  assert.equal(result.maintenanceDegraded, true); assert.equal(store.health().storage, "degraded-maintenance"); assert.match(store.health().detail ?? "", /checkpoint/u);
  failCheckpoint = false;
  const second = await store.commit({ transactionId: TX2, operation: "advance-2", mutations: [rootMutation(store.snapshot(), 2)] });
  assert.equal(second.revision, 2); assert.equal(store.health().storage, "healthy");
  await store.close();
  const reopened = await openMainStoreV1({ ...options, fs: undefined, maintenancePolicy: undefined }); assert.equal(reopened.snapshot().root.host_revision, 2); await reopened.close();
});

test("checkpoint reconciles authority when failure occurs after CURRENT rename or before Main dir sync", async (t) => {
  for (const stage of ["after-rename", "before-dir-sync"] as const) {
    const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); let armed = false; let fired = false; let mainRoot = "";
    const options = { agentDirectory: root, mainSessionId: `main-switch-${stage}`, now: () => new Date(NOW), maintenancePolicy: { checkpointJournalBytes: Number.MAX_SAFE_INTEGER, checkpointTransactions: 1 }, fs: { fault(step: string, path: string) { const match = stage === "after-rename" ? step === "after-rename" && path.endsWith("/CURRENT") : step === "before-dir-sync" && path === mainRoot; if (armed && !fired && match) { fired = true; throw new Error(stage); } } } };
    const store = await openMainStoreV1(options); mainRoot = store.paths.mainRoot; armed = true; const result = await store.commit({ transactionId: TX1, operation: "advance", mutations: [rootMutation(store.snapshot(), 1)] }); assert.equal(result.revision, 1); assert.equal(store.snapshot().root.host_revision, 1); await store.close(); const reopened = await openMainStoreV1({ ...options, fs: undefined, maintenancePolicy: undefined }); assert.equal(reopened.snapshot().root.host_revision, 1); await reopened.close();
  }
});

test("incomplete unpaired checkpoint generation is removed instead of guessing authority or fencing the store", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); let armed = false; let fired = false;
  const options = { agentDirectory: root, mainSessionId: "main-incomplete-checkpoint", now: () => new Date(NOW), fs: { fault(step: string, path: string) { if (armed && !fired && step === "before-dir-sync" && path.includes("/checkpoints/cp_")) { fired = true; throw new Error("incomplete-checkpoint"); } } } };
  const store = await openMainStoreV1(options); armed = true;
  // 切换没完成必须报给调用方，不能静默返回；权威留在 generation 1，半个 generation 2 按封闭布局删掉。
  await assert.rejects(store.checkpoint(), /checkpoint switch did not complete/u);
  assert.deepEqual((await readdir(store.paths.checkpoints)).sort(), ["cp_0000000000000001"]);
  assert.deepEqual((await readdir(store.paths.journals)).sort(), ["jr_0000000000000001.bin"]);
  assert.equal(store.health().storage, "healthy");
  assert.equal((await store.commit({ transactionId: TX1, operation: "advance", mutations: [rootMutation(store.snapshot(), 1)] })).revision, 1);
  await store.close();
  const reopened = await openMainStoreV1({ ...options, fs: undefined }); assert.equal(reopened.snapshot().root.host_revision, 1); await reopened.close();
});

test("open removes CURRENT.tmp residue and obsolete generations but keeps pointed authority", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const options = { agentDirectory: root, mainSessionId: "main-clean-generations", now: () => new Date(NOW) }; const store = await openMainStoreV1(options); await store.checkpoint(); const paths = store.paths; await writeFile(join(paths.mainRoot, "CURRENT.tmp"), "stale", { mode: 0o600 }); await store.close();
  const reopened = await openMainStoreV1(options); assert.deepEqual((await readdir(paths.checkpoints)).sort(), ["cp_0000000000000002"]); assert.deepEqual((await readdir(paths.journals)).sort(), ["jr_0000000000000002.bin"]); await assert.rejects(readFile(join(paths.mainRoot, "CURRENT.tmp")), { code: "ENOENT" }); assert.equal(reopened.health().storage, "healthy"); await reopened.close();
});

test("final torn journal tail is preserved and truncated before reopen", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-tail", now: () => new Date(NOW), randomBytes: (size: number) => Buffer.alloc(size, 8) };
  const store = await openMainStoreV1(options); await store.close();
  const path = join(store.paths.journals, journalFileName(1));
  const before = await readFile(path);
  const frame = encodeFrameV1(2, { version: 1, type: "tx-begin", transaction_id: TX1, base_revision: 0, revision: 1, operation: "torn", created_at: NOW.toISOString() });
  const handle = await open(path, "a"); try { await handle.write(frame.subarray(0, 25)); await handle.sync(); } finally { await handle.close(); }
  const reopened = await openMainStoreV1(options);
  assert.equal((await readFile(path)).byteLength, before.byteLength);
  const tails = await readdir(reopened.paths.recovery);
  assert.equal(tails.length, 1);
  assert.equal((await readFile(join(reopened.paths.recovery, tails[0]!))).byteLength, 25);
  await reopened.close();
});

test("mid-file journal corruption rejects open and preserves bytes", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-corrupt", now: () => new Date(NOW), randomBytes: (size: number) => Buffer.alloc(size, 9) };
  const store = await openMainStoreV1(options); await store.close();
  const path = join(store.paths.journals, journalFileName(1));
  const first = Buffer.from(encodeFrameV1(2, { version: 1, type: "tx-begin", transaction_id: TX1, base_revision: 0, revision: 1, operation: "bad", created_at: NOW.toISOString() }));
  first[first.length - 2] ^= 1;
  const later = encodeFrameV1(3, { version: 1, type: "put", transaction_id: TX1, entity_type: "root", entity_id: "root", value: store.snapshot().root });
  const handle = await open(path, "a"); try { await handle.write(Buffer.concat([first, later])); await handle.sync(); } finally { await handle.close(); }
  const bytes = await readFile(path);
  await assert.rejects(openMainStoreV1(options), /storage-corrupt.*CRC/);
  assert.deepEqual(await readFile(path), bytes);
});

test("checkpoint and journal from another Main cannot replace this Main authority", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const one = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-one", now: () => new Date(NOW) }); const onePaths = one.paths; await one.close();
  const two = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-two", now: () => new Date(NOW) }); const twoPaths = two.paths; await two.close();
  await rm(onePaths.checkpoints, { recursive: true }); await rm(onePaths.journals, { recursive: true }); await cp(twoPaths.checkpoints, onePaths.checkpoints, { recursive: true }); await cp(twoPaths.journals, onePaths.journals, { recursive: true }); await cp(twoPaths.currentFile, onePaths.currentFile);
  await assert.rejects(openMainStoreV1({ agentDirectory: root, mainSessionId: "main-one", now: () => new Date(NOW) }), /Main identity mismatch/);
});

test("second live writer fails closed without mutating authority", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-lock", now: () => new Date(NOW) };
  const first = await openMainStoreV1(options);
  await assert.rejects(openMainStoreV1(options), /locked/i);
  assert.equal(first.snapshot().root.host_revision, 0);
  await first.close();
});

const TX3 = encodeDomainId("txn", Buffer.alloc(16, 3));
function advance(store: Awaited<ReturnType<typeof openMainStoreV1>>, transactionId: string) {
  const snapshot = store.snapshot(); const revision = snapshot.root.host_revision + 1;
  return store.commit({ transactionId, operation: `advance-${revision}`, mutations: [{ version: 1 as const, type: "put" as const, transaction_id: transactionId, entity_type: "root" as const, entity_id: "root", value: { ...rootHeaderV1(snapshot.root), host_revision: revision, next_admission_order: snapshot.root.next_admission_order + 1 } }] });
}

test("process quota reuses the cross-Main scan inside the rescan interval and rescans once it expires", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = NOW.getTime(); const clock = () => new Date(nowMs);
  // 另一个 Main 只占目录，之后往里塞字节模拟别的 Pi 进程在写。
  const other = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-other", now: clock }); await other.close();
  const probe = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-cached", now: clock });
  const { scanProcessStoreQuotaV1 } = await import("../../src/persistence/quota.ts");
  const baseline = (await scanProcessStoreQuotaV1(dirname(dirname(probe.paths.mainRoot)))).totalBytes;
  await probe.close();
  const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-cached", now: clock, quotaRescanIntervalMs: 60_000, limits: { maxStoreBytesPerMain: 536_870_912, maxStoreBytesPerProcess: baseline + 1_000_000, maxMetadataBytesPerMain: 67_108_864 } });
  await advance(store, TX1);
  await writeFile(join(other.paths.conversations, "growth.bin"), Buffer.alloc(2_000_000, 1), { mode: 0o600 });
  // 缓存期内：别的 Main 涨了也先不管，本次 commit 照常通过。
  await advance(store, TX2);
  nowMs += 60_001;
  await assert.rejects(advance(store, TX3), /process store quota/);
  await store.close();
});

test("process quota rescans immediately when the projection comes within 1/16 of the limit", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const clock = () => new Date(NOW);
  const other = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-other", now: clock }); await other.close();
  const probe = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-near", now: clock });
  const { scanProcessStoreQuotaV1 } = await import("../../src/persistence/quota.ts");
  const baseline = (await scanProcessStoreQuotaV1(dirname(dirname(probe.paths.mainRoot)))).totalBytes;
  await probe.close();
  const limit = baseline + 160_000;
  const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-near", now: clock, quotaRescanIntervalMs: 3_600_000, limits: { maxStoreBytesPerMain: 536_870_912, maxStoreBytesPerProcess: limit, maxMetadataBytesPerMain: 67_108_864 } });
  await advance(store, TX1);
  await writeFile(join(other.paths.conversations, "growth.bin"), Buffer.alloc(2_000_000, 1), { mode: 0o600 });
  // 本 Main 自己长到离上限不足 1/16：必须重扫，别的 Main 的增长这时就被看见了。
  const agentDirectory = join(store.paths.mainRoot, "conversations", encodeDomainId("agt", Buffer.alloc(16, 9)));
  await mkdir(agentDirectory, { mode: PRIVATE_DIR_MODE }); await writeFile(join(agentDirectory, "session.jsonl"), Buffer.alloc(150_000, 32), { mode: 0o600 });
  await assert.rejects(advance(store, TX2), /process store quota/);
  await store.close();
});

test("successful checkpoints reclaim prior generations while cleanup failure preserves committed authority",async t=>{
 const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));let blockCleanup=false;
 const store=await openMainStoreV1({agentDirectory:root,mainSessionId:"main-live-cleanup",now:()=>new Date(NOW),fs:{fault(step,path){if(blockCleanup&&step==="before-remove"&&path.endsWith("cp_0000000000000001"))throw new Error("cleanup-fault");}}});
 await advance(store,TX1);blockCleanup=true;await store.checkpoint();
 assert.equal(store.health().storage,"degraded-maintenance");assert.deepEqual((await readdir(store.paths.checkpoints)).sort(),["cp_0000000000000001","cp_0000000000000002"]);
 assert.equal(store.snapshot().root.host_revision,1);blockCleanup=false;await store.checkpoint();
 assert.equal(store.health().storage,"healthy");assert.deepEqual(await readdir(store.paths.checkpoints),["cp_0000000000000003"]);assert.deepEqual(await readdir(store.paths.journals),["jr_0000000000000003.bin"]);
 await store.close();const reopened=await openMainStoreV1({agentDirectory:root,mainSessionId:"main-live-cleanup",now:()=>new Date(NOW)});assert.equal(reopened.snapshot().root.host_revision,1);await reopened.close();
});

// 每笔事务换一条约 65 KB 的 receipt（put 新的、delete 旧的）：checkpoint 不长，journal 每笔涨约 65 KB。
async function replaceReceipt(store: Awaited<ReturnType<typeof openMainStoreV1>>, index: number) {
  const snapshot = store.snapshot(); const revision = snapshot.root.host_revision + 1; const transactionId = encodeDomainId("txn", Buffer.alloc(16, index + 40));
  const resultJson = JSON.stringify({ body: "x".repeat(65000), index }); const previous = snapshot.root.operation_receipts[0];
  const receipt = { version: 1, record_revision: revision, receipt_id: encodeDomainId("rcp", Buffer.alloc(16, index + 40)), request_id: randomUUID(), operation_digest: "a".repeat(64), caller: { kind: "main", session_id: "main-near-metadata-cap" }, runtime_generation: 1, operation: "seed-receipt", state: "committed", transaction_id: transactionId, result_json: resultJson, result_sha256: createHash("sha256").update(resultJson).digest("hex"), created_at: NOW.toISOString(), settled_at: NOW.toISOString() };
  return store.commit({ transactionId, operation: "replace-receipt", mutations: [
    { version: 1, type: "put", transaction_id: transactionId, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(snapshot.root), host_revision: revision } },
    { version: 1, type: "put", transaction_id: transactionId, entity_type: "operation-receipt", entity_id: receipt.receipt_id, value: receipt },
    ...(previous ? [{ version: 1 as const, type: "delete" as const, transaction_id: transactionId, entity_type: "operation-receipt" as const, entity_id: previous.receipt_id, expected_record_revision: previous.record_revision }] : []),
  ] });
}

test("metadata capacity first checkpoints reclaimable journal before rejecting new work",async t=>{
 const root=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
 const store=await openMainStoreV1({agentDirectory:root,mainSessionId:"main-near-metadata-cap",now:()=>new Date(NOW),limits:{maxMetadataBytesPerMain:2500000},maintenancePolicy:{checkpointJournalBytes:Number.MAX_SAFE_INTEGER,checkpointTransactions:Number.MAX_SAFE_INTEGER}});
 try{
  // 60 笔约 3.9 MB 的 journal 超过 2.5 MB 上限，只有中途 checkpoint 回收 journal 才能全部接纳。
  for(let index=0;index<60;index++)await replaceReceipt(store,index);
  assert.equal(store.snapshot().root.host_revision,60);assert.equal(store.snapshot().root.operation_receipts.length,1);assert.equal(store.health().storage,"healthy");assert.equal((await readdir(store.paths.checkpoints)).length,1);assert.equal((await readdir(store.paths.journals)).length,1);
  assert.notDeepEqual(await readdir(store.paths.checkpoints),["cp_0000000000000001"]);
 }finally{await store.close();}
});

test("checkpoint after a fence never deletes the generation CURRENT already points to", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  // 切换已经 rename 了 CURRENT，随后读回 CURRENT 失败：store 被 fence，内存指针还停在第 1 代。
  let phase = "idle"; const removed: string[] = [];
  const options = { agentDirectory: root, mainSessionId: "main-fenced-checkpoint", now: () => new Date(NOW), fs: { fault(step: string, path: string) {
    if (phase === "arm" && step === "after-rename" && path.endsWith("/CURRENT")) { phase = "reconcile"; throw new Error("after-rename-fault"); }
    if (phase === "reconcile" && step === "before-open" && path.endsWith("/CURRENT")) { phase = "idle"; throw new Error("reconcile-read-fault"); }
    if (step === "before-remove") removed.push(path);
  } } };
  const store = await openMainStoreV1(options);
  await advance(store, TX1); await advance(store, TX2);
  phase = "arm";
  await assert.rejects(store.checkpoint(), /checkpoint authority uncertain/);
  assert.equal(store.health().storage, "degraded-maintenance");
  assert.equal(JSON.parse(await readFile(store.paths.currentFile, "utf8")).checkpoint_generation, 2);
  removed.length = 0;
  await assert.rejects(store.checkpoint(), /storage-unavailable/);
  assert.deepEqual(removed, []);
  assert.deepEqual((await readdir(store.paths.checkpoints)).sort(), ["cp_0000000000000001", "cp_0000000000000002"]);
  assert.deepEqual((await readdir(store.paths.journals)).sort(), ["jr_0000000000000001.bin", "jr_0000000000000002.bin"]);
  await store.close();
  const reopened = await openMainStoreV1({ ...options, fs: undefined });
  assert.equal(reopened.snapshot().root.host_revision, 2); assert.equal(reopened.health().storage, "healthy");
  assert.deepEqual(await readdir(reopened.paths.checkpoints), ["cp_0000000000000002"]);
  await reopened.close();
});

test("a journal record over 1 MiB is a readable capacity rejection and the store keeps committing", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openMainStoreV1({ agentDirectory: root, mainSessionId: "main-record-cap", now: () => new Date(NOW) });
  const snapshot = store.snapshot(); const payloadJson = JSON.stringify({ blob: "x".repeat(1_048_500) }); const transactionId = encodeDomainId("txn", Buffer.alloc(16, 6));
  const event = { version: 1, record_revision: 1, event_id: encodeDomainId("evt", Buffer.alloc(16, 5)), target: { kind: "main", session_id: "main-record-cap" }, event_sequence: 1, kind: "owner_health", payload_json: payloadJson, payload_sha256: createHash("sha256").update(payloadJson).digest("hex"), state: "pending", attempts: 0, created_at: NOW.toISOString() };
  await assert.rejects(store.commit({ transactionId, operation: "oversized-event", mutations: [
    { version: 1, type: "put", transaction_id: transactionId, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(snapshot.root), host_revision: 1, next_owner_event_sequence: 2 } },
    { version: 1, type: "put", transaction_id: transactionId, entity_type: "owner-event", entity_id: event.event_id, value: event },
  ] }), (error: Error) => error.message.startsWith("[subagent/storage-capacity]") && error.message.includes(`owner-event ${event.event_id}`) && !error.message.includes("storage-unavailable"));
  assert.equal(store.snapshot().root.host_revision, 0);
  assert.equal(store.health().storage, "degraded-capacity"); assert.match(store.health().detail ?? "", /oversized-event.*1 MiB/u);
  await advance(store, TX1);
  assert.equal(store.snapshot().root.host_revision, 1); assert.equal(store.health().storage, "healthy");
  await store.close();
});

function frames(payloads: readonly JournalPayloadV1[], firstSequence: number): Buffer { return Buffer.concat(payloads.map((payload, index) => encodeFrameV1(firstSequence + index, payload))); }
function legacyTransaction(transactionId: string, revision: number, mutations: readonly JournalPayloadV1[]): JournalPayloadV1[] {
  const begin = { version: 1, type: "tx-begin", transaction_id: transactionId, base_revision: revision - 1, revision, operation: `legacy-${revision}`, created_at: NOW.toISOString() } as const;
  const digest = transactionDigestV1([begin, ...mutations].map((payload) => encodePayloadV1(payload)));
  return [begin, ...mutations, { version: 1, type: "tx-commit", transaction_id: transactionId, revision, mutation_count: mutations.length, transaction_sha256: digest, committed_at: NOW.toISOString() }];
}

test("a format-1 journal is replayed once from Root headers and checkpointed into format 3", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-legacy", now: () => new Date(NOW) };
  const fresh = await openMainStoreV1(options); const paths = fresh.paths; const base = fresh.snapshot().root; await fresh.close();
  // 按格式 1 重写 jr_1：anchor version 1，Root put 带整份 Root，按旧写法放在事务第一条。
  const manifest = JSON.parse(await readFile(join(paths.checkpoints, "cp_0000000000000001", "manifest.json"), "utf8"));
  const resultJson = JSON.stringify({ ok: true });
  const receipt = { version: 1, record_revision: 1, receipt_id: encodeDomainId("rcp", Buffer.alloc(16, 7)), request_id: randomUUID(), operation_digest: "a".repeat(64), caller: { kind: "main", session_id: "main-legacy" }, runtime_generation: 1, operation: "legacy-receipt", state: "committed", transaction_id: TX1, result_json: resultJson, result_sha256: createHash("sha256").update(resultJson).digest("hex"), created_at: NOW.toISOString(), settled_at: NOW.toISOString() } as const;
  const legacy = [
    { version: 1, type: "journal-anchor", checkpoint_generation: 1, checkpoint_revision: 0, checkpoint_state_sha256: manifest.state_sha256, created_at: NOW.toISOString() } as const,
    ...legacyTransaction(TX1, 1, [{ version: 1, type: "put", transaction_id: TX1, entity_type: "root", entity_id: "root", value: { ...base, host_revision: 1 } }, { version: 1, type: "put", transaction_id: TX1, entity_type: "operation-receipt", entity_id: receipt.receipt_id, value: receipt }]),
    ...legacyTransaction(TX2, 2, [{ version: 1, type: "put", transaction_id: TX2, entity_type: "root", entity_id: "root", value: { ...base, host_revision: 2, next_admission_order: 5, operation_receipts: [receipt] } }]),
  ];
  await writeFile(join(paths.journals, journalFileName(1)), frames(legacy, 1));
  const upgraded = await openMainStoreV1(options);
  const state = upgraded.snapshot().root;
  assert.equal(state.host_revision, 2); assert.equal(state.next_admission_order, 5); assert.deepEqual(state.operation_receipts, [receipt]); assert.equal(upgraded.health().storage, "healthy");
  assert.deepEqual(await readdir(paths.checkpoints), ["cp_0000000000000002"]); assert.deepEqual(await readdir(paths.journals), ["jr_0000000000000002.bin"]);
  const upgradedManifest = JSON.parse(await readFile(join(paths.checkpoints, "cp_0000000000000002", "manifest.json"), "utf8"));
  const anchor = scanJournalV1(await readFile(join(paths.journals, journalFileName(2))), upgradedManifest.last_journal_sequence, upgradedManifest.host_revision);
  assert.equal(anchor.status, "valid"); assert.equal(anchor.status === "valid" && anchor.anchor.version, 3);
  await advance(upgraded, TX3); await upgraded.close();
  const reopened = await openMainStoreV1(options);
  assert.equal(reopened.snapshot().root.host_revision, 3); assert.deepEqual(reopened.snapshot().root.operation_receipts, [receipt]);
  await reopened.close();
});

test("an unknown journal format version fails open with the version in the error", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { agentDirectory: root, mainSessionId: "main-future-format", now: () => new Date(NOW) };
  const fresh = await openMainStoreV1(options); const paths = fresh.paths; await fresh.close();
  const manifest = JSON.parse(await readFile(join(paths.checkpoints, "cp_0000000000000001", "manifest.json"), "utf8"));
  const payload = Buffer.from(canonicalJson({ version: 99, type: "journal-anchor", checkpoint_generation: 1, checkpoint_revision: 0, checkpoint_state_sha256: manifest.state_sha256, created_at: NOW.toISOString() }));
  const header = `PSAJ1 ${"1".padStart(16, "0")} ${payload.byteLength.toString(16).padStart(8, "0")} ${crc32cHex(payload)}\n`;
  await writeFile(join(paths.journals, journalFileName(1)), Buffer.concat([Buffer.from(header, "ascii"), payload, Buffer.from("\n")]));
  await assert.rejects(openMainStoreV1(options), /storage-corrupt.*journal format version 99 is not supported/);
});

/** 造一个格式 1 的 store：jr_1 改写成 anchor v1 加一笔整份 Root put 的事务。 */
async function legacyStore(root: string, session: string, extra: (base: ReturnType<Awaited<ReturnType<typeof openMainStoreV1>>["snapshot"]>["root"]) => { root: Record<string, unknown>; mutations: JournalPayloadV1[] } = (base) => ({ root: { ...base, host_revision: 1, next_admission_order: 5 }, mutations: [] })) {
  const options = { agentDirectory: root, mainSessionId: session, now: () => new Date(NOW) };
  const fresh = await openMainStoreV1(options); const paths = fresh.paths; const base = fresh.snapshot().root; await fresh.close();
  const manifest = JSON.parse(await readFile(join(paths.checkpoints, "cp_0000000000000001", "manifest.json"), "utf8"));
  const { root: legacyRoot, mutations } = extra(base);
  const legacy = [{ version: 1, type: "journal-anchor", checkpoint_generation: 1, checkpoint_revision: 0, checkpoint_state_sha256: manifest.state_sha256, created_at: NOW.toISOString() } as const, ...legacyTransaction(TX1, 1, [{ version: 1, type: "put", transaction_id: TX1, entity_type: "root", entity_id: "root", value: legacyRoot }, ...mutations])];
  await writeFile(join(paths.journals, journalFileName(1)), frames(legacy, 1));
  return { options, paths };
}

test("format-1 upgrade recovers from the empty journal and CURRENT.tmp a crash leaves mid-switch", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const { options, paths } = await legacyStore(root, "main-upgrade-residue");
  // 升级 checkpoint 在 O_EXCL 建出新 journal、CURRENT.tmp 之后、写入之前被杀：新代目录完整，journal 和 CURRENT.tmp 是空文件。
  await cp(join(paths.checkpoints, "cp_0000000000000001"), join(paths.checkpoints, "cp_0000000000000002"), { recursive: true });
  await writeFile(join(paths.journals, journalFileName(2)), "", { mode: 0o600 }); await writeFile(join(paths.mainRoot, "CURRENT.tmp"), "", { mode: 0o600 });
  const store = await openMainStoreV1(options);
  assert.equal(store.snapshot().root.host_revision, 1); assert.equal(store.snapshot().root.next_admission_order, 5); assert.equal(store.health().storage, "healthy");
  assert.deepEqual(await readdir(paths.checkpoints), ["cp_0000000000000002"]); assert.deepEqual(await readdir(paths.journals), ["jr_0000000000000002.bin"]);
  await assert.rejects(readFile(join(paths.mainRoot, "CURRENT.tmp")), { code: "ENOENT" });
  const manifest = JSON.parse(await readFile(join(paths.checkpoints, "cp_0000000000000002", "manifest.json"), "utf8"));
  const scan = scanJournalV1(await readFile(join(paths.journals, journalFileName(2))), manifest.last_journal_sequence, manifest.host_revision);
  assert.equal(scan.status === "valid" && scan.anchor.version, 3);
  await advance(store, TX2); await store.close();
  const reopened = await openMainStoreV1(options); assert.equal(reopened.snapshot().root.host_revision, 2); await reopened.close();
});

test("the next checkpoint generation skips a residue that cannot be removed instead of failing with EEXIST", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const { options, paths } = await legacyStore(root, "main-upgrade-stuck-residue");
  await cp(join(paths.checkpoints, "cp_0000000000000001"), join(paths.checkpoints, "cp_0000000000000002"), { recursive: true });
  const blocked = await openMainStoreV1({ ...options, fs: { fault(step: string, path: string) { if (step === "before-remove" && path.endsWith("/cp_0000000000000002")) throw new Error("residue-stuck"); } } });
  assert.equal(JSON.parse(await readFile(paths.currentFile, "utf8")).checkpoint_generation, 3);
  assert.equal(blocked.health().storage, "degraded-maintenance"); assert.equal(blocked.snapshot().root.next_admission_order, 5);
  await blocked.close();
  const reopened = await openMainStoreV1(options);
  assert.equal(reopened.health().storage, "healthy"); assert.deepEqual(await readdir(paths.checkpoints), ["cp_0000000000000003"]);
  await reopened.close();
});

test("a checkpoint that cannot be read back with the open-time decoder never becomes CURRENT", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  // 格式 1 回放不做条数预检：造一个有 4,097 条未 ACK OwnerEvent 的 Root。它们不能回收，升级 checkpoint 写得出、读不回。
  const session = "main-unreadable-checkpoint"; const payload = "{}";
  const { options, paths } = await legacyStore(root, session, (base) => ({
    root: { ...base, host_revision: 1, next_owner_event_sequence: 4098 },
    mutations: Array.from({ length: 4097 }, (_, index) => { const event = { version: 1, record_revision: 1, event_id: encodeDomainId("evt", Buffer.from(createHash("sha256").update(String(index)).digest().subarray(0, 16))), target: { kind: "main", session_id: session }, event_sequence: index + 1, kind: "owner_health", payload_json: payload, payload_sha256: createHash("sha256").update(payload).digest("hex"), state: "pending", attempts: 0, created_at: NOW.toISOString() }; return { version: 1, type: "put", transaction_id: TX1, entity_type: "owner-event", entity_id: event.event_id, value: event } as const; }),
  }));
  const journalBefore = await readFile(join(paths.journals, journalFileName(1))); const currentBefore = await readFile(paths.currentFile);
  await assert.rejects(openMainStoreV1(options), /checkpoint switch did not complete: .*root events must be bounded array/);
  assert.deepEqual(await readFile(paths.currentFile), currentBefore); assert.deepEqual(await readFile(join(paths.journals, journalFileName(1))), journalBefore);
  assert.deepEqual(await readdir(paths.checkpoints), ["cp_0000000000000001"]); assert.deepEqual(await readdir(paths.journals), ["jr_0000000000000001.bin"]);
});
