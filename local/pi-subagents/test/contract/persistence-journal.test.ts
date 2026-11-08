import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../../src/capabilities/canonical.ts";
import { crc32c, crc32cHex } from "../../src/persistence/crc32.ts";
import {
  encodeFrameV1,
  encodePayloadV1,
  scanJournalV1,
  transactionDigestV1,
  type JournalAnchorV1,
  type TransactionBeginV1,
  type TransactionMutationV1,
} from "../../src/persistence/journal.ts";
import {
  buildCheckpointManifestV1,
  checkpointDirectoryName,
  checkpointStateDigest,
  descriptorFor,
  encodeCheckpointManifestV1,
  encodeCurrentPointerV1,
  generationHex,
  journalFileName,
  parseCheckpointManifestV1,
  parseCurrentPointerV1,
  verifyCheckpointBundleV1,
} from "../../src/persistence/checkpoint.ts";
import {
  appendTransactionV1,
  CommitUncertainError,
  switchCheckpointV1,
  type CheckpointSwitchPortV1,
  type JournalAppendPortV1,
} from "../../src/persistence/transaction.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const MAIN_KEY = `main_${"A".repeat(32)}`;
const STATE = "1".repeat(64);
const TX = `txn_${"a".repeat(22)}`;

function anchor(sequence = 1, revision = 0): Uint8Array {
  return encodeFrameV1(sequence, {
    version: 1,
    type: "journal-anchor",
    checkpoint_generation: 1,
    checkpoint_revision: revision,
    checkpoint_state_sha256: STATE,
    created_at: NOW,
  });
}

function begin(baseRevision = 0): TransactionBeginV1 {
  return {
    version: 1,
    type: "tx-begin",
    transaction_id: TX,
    base_revision: baseRevision,
    revision: baseRevision + 1,
    operation: "test",
    created_at: NOW,
  };
}

function mutation(): TransactionMutationV1 {
  return {
    version: 1,
    type: "put",
    transaction_id: TX,
    entity_type: "root",
    entity_id: "root",
    value: { version: 1, host_revision: 1 },
  };
}

class MemoryJournalPort implements JournalAppendPortV1 {
  data: Buffer;
  maxWrite: number;
  failWriteAfter: number | undefined;
  failSync: boolean;
  calls = 0;
  truncatedTo: number | undefined;

  constructor(initial: Uint8Array, options: { maxWrite?: number; failWriteAfter?: number; failSync?: boolean } = {}) {
    this.data = Buffer.from(initial);
    this.maxWrite = options.maxWrite ?? Number.MAX_SAFE_INTEGER;
    this.failWriteAfter = options.failWriteAfter;
    this.failSync = options.failSync ?? false;
  }

  async writev(chunks: readonly Uint8Array[]): Promise<number> {
    this.calls++;
    if (this.failWriteAfter !== undefined && this.data.byteLength >= this.failWriteAfter) throw new Error("ENOSPC");
    const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const allowedByFailure = this.failWriteAfter === undefined ? combined.byteLength : Math.max(0, this.failWriteAfter - this.data.byteLength);
    const count = Math.min(combined.byteLength, this.maxWrite, allowedByFailure);
    if (count === 0) throw new Error("ENOSPC");
    this.data = Buffer.concat([this.data, combined.subarray(0, count)]);
    return count;
  }

  async sync(): Promise<void> {
    if (this.failSync) throw new Error("EIO");
  }

  async reopenReadAll(): Promise<Uint8Array> {
    return Buffer.from(this.data);
  }

  async truncate(size: number): Promise<void> {
    if (size > this.data.byteLength) throw new Error("truncate beyond end of journal");
    this.truncatedTo = size;
    this.data = Buffer.from(this.data.subarray(0, size));
  }
}

test("CRC-32C Castagnoli and transaction digest use normative vectors", () => {
  assert.equal(crc32c(Buffer.from("123456789")), 0xe3069283);
  assert.equal(crc32cHex(Buffer.from("123456789")), "e3069283");
  const payloads = [Buffer.from("abc"), Buffer.from("d")];
  const independent = createHash("sha256")
    .update(Buffer.from("0000000000000003", "hex"))
    .update("abc")
    .update(Buffer.from("0000000000000001", "hex"))
    .update("d")
    .digest("hex");
  assert.equal(transactionDigestV1(payloads), independent);
  assert.equal(independent, "dd36d2bbd52a75ae1af694f0ab93b3146275934cb55376cc53c608d7ab10bf86");
});

test("frame is fixed-width, canonical, contiguous and bounded", () => {
  const bytes = anchor();
  assert.equal(Buffer.from(bytes.subarray(0, 41)).toString("ascii"), `PSAJ1 0000000000000001 000000dc ${crc32cHex(bytes.subarray(41, -1))}\n`);
  assert.equal(bytes.at(-1), 0x0a);
  const scan = scanJournalV1(bytes, 0, 0, { checkpointGeneration: 1, stateSha256: STATE });
  assert.equal(scan.status, "valid");
  if (scan.status !== "valid") return;
  assert.equal(scan.nextSequence, 2);
  assert.equal(scan.nextRevision, 1);
  assert.throws(() => encodeFrameV1(1, new Uint8Array()), /length/);
  assert.throws(() => encodeFrameV1(1, Buffer.alloc(1_048_577, 0x20)), /length/);
});

test("scanner applies complete commits and treats an uncommitted final transaction as one recoverable tail", async () => {
  const port = new MemoryJournalPort(anchor(), { maxWrite: 7 });
  const result = await appendTransactionV1(port, {
    begin: begin(), mutations: [mutation()], committedAt: NOW, firstSequence: 2,
    manifestLastSequence: 0, checkpointRevision: 0, currentRevision: 0,
    anchorExpectation: { checkpointGeneration: 1, stateSha256: STATE },
  });
  assert.equal(result.proof, "sync");
  assert.ok(port.calls > 3, "short writes must be completed");
  const valid = scanJournalV1(port.data, 0, 0, { checkpointGeneration: 1, stateSha256: STATE });
  assert.equal(valid.status, "valid");
  if (valid.status !== "valid") return;
  assert.equal(valid.committed.length, 1);
  assert.equal(valid.committed[0]!.mutations.length, 1);
  assert.equal(valid.nextRevision, 2);

  const dangling = Buffer.concat([
    port.data,
    Buffer.from(encodeFrameV1(valid.nextSequence, begin(1))),
    Buffer.from(encodeFrameV1(valid.nextSequence + 1, { ...mutation(), transaction_id: TX })),
  ]);
  const tail = scanJournalV1(dangling, 0, 0, { checkpointGeneration: 1, stateSha256: STATE });
  assert.equal(tail.status, "recoverable-tail");
  if (tail.status !== "recoverable-tail") return;
  assert.equal(tail.tailOffset, valid.lastCommittedOffset);
  assert.deepEqual(Buffer.from(tail.tailBytes), Buffer.from(dangling.subarray(valid.lastCommittedOffset)));
  assert.equal(tail.nextRevision, 2);
  assert.equal(tail.nextSequence, valid.nextSequence);
});

test("final torn/CRC tail is recoverable but the same corruption with a later complete frame is mid-file fatal", () => {
  const good = anchor();
  const final = Buffer.from(encodeFrameV1(2, begin()));
  final[final.byteLength - 2] ^= 0x01;
  const tail = scanJournalV1(Buffer.concat([good, final]), 0, 0, { checkpointGeneration: 1, stateSha256: STATE });
  assert.equal(tail.status, "recoverable-tail");
  if (tail.status === "recoverable-tail") assert.equal(tail.tailOffset, good.byteLength);

  const later = Buffer.from(encodeFrameV1(3, mutation()));
  const middle = scanJournalV1(Buffer.concat([good, final, later]), 0, 0, { checkpointGeneration: 1, stateSha256: STATE });
  assert.equal(middle.status, "corrupt");
  if (middle.status === "corrupt") assert.match(middle.reason, /CRC/);

  const truncated = scanJournalV1(Buffer.concat([good, Buffer.from("PSAJ1 000")]), 0, 0, { checkpointGeneration: 1, stateSha256: STATE });
  assert.equal(truncated.status, "recoverable-tail");
});

test("wrong sequence, noncanonical payload and invalid commit hash fail closed", () => {
  const gap = scanJournalV1(Buffer.concat([anchor(), encodeFrameV1(3, begin())]), 0, 0);
  assert.equal(gap.status, "corrupt");

  const raw = Buffer.from('{"version":1, "type":"journal-anchor","checkpoint_generation":1,"checkpoint_revision":0,"checkpoint_state_sha256":"' + STATE + '","created_at":"' + NOW + '"}', "utf8");
  assert.throws(() => encodeFrameV1(1, raw), /canonical/);

  const beginBytes = encodePayloadV1(begin());
  const badCommit = {
    version: 1 as const, type: "tx-commit" as const, transaction_id: TX, revision: 1,
    mutation_count: 0, transaction_sha256: "0".repeat(64), committed_at: NOW,
  };
  const bytes = Buffer.concat([anchor(), encodeFrameV1(2, beginBytes), encodeFrameV1(3, badCommit)]);
  const scan = scanJournalV1(bytes, 0, 0);
  assert.equal(scan.status, "corrupt");
});

test("sync failure returns committed only when reopen proves the exact commit", async () => {
  const committedPort = new MemoryJournalPort(anchor(), { failSync: true });
  const committed = await appendTransactionV1(committedPort, {
    begin: begin(), mutations: [mutation()], committedAt: NOW, firstSequence: 2,
    manifestLastSequence: 0, checkpointRevision: 0, currentRevision: 0,
  });
  assert.equal(committed.proof, "rescan");

  const partialPort = new MemoryJournalPort(anchor(), { maxWrite: 11, failWriteAfter: anchor().byteLength + 30 });
  await assert.rejects(
    appendTransactionV1(partialPort, {
      begin: begin(), mutations: [mutation()], committedAt: NOW, firstSequence: 2,
      manifestLastSequence: 0, checkpointRevision: 0, currentRevision: 0,
    }),
    (error: unknown) => error instanceof CommitUncertainError && error.commitState === "absent" && /proven absent/.test(error.message),
  );
  // 被证明不存在的 commit 必须把半截 frames 截回最后一个已提交 offset，否则后续 append 会写在破损区段之后。
  assert.equal(partialPort.truncatedTo, anchor().byteLength);
  assert.deepEqual(Buffer.from(partialPort.data), Buffer.from(anchor()));
  assert.equal(scanJournalV1(partialPort.data, 0, 0).status, "valid");
});

test("checkpoint manifest sorts descriptors and verifies exact reopened bytes", () => {
  const root = Buffer.from(`${canonicalJson({ version: 1, host_revision: 0 })}\n`);
  const a = Buffer.from(`${canonicalJson({ version: 1, agent: "a" })}\n`);
  const z = Buffer.from(`${canonicalJson({ version: 1, agent: "z" })}\n`);
  const agents = new Map([[`agt_${"z".repeat(22)}`, z], [`agt_${"a".repeat(22)}`, a]]);
  const manifest = buildCheckpointManifestV1({ mainKey: MAIN_KEY, generation: 2, hostRevision: 5, lastJournalSequence: 42, createdAt: NOW, rootBytes: root, agents });
  assert.deepEqual(manifest.agents.map((entry) => entry.agent_id), [`agt_${"a".repeat(22)}`, `agt_${"z".repeat(22)}`]);
  assert.equal(manifest.state_sha256, checkpointStateDigest(manifest.root, manifest.agents));
  assert.deepEqual(parseCheckpointManifestV1(JSON.parse(Buffer.from(encodeCheckpointManifestV1(manifest)).toString("utf8"))), manifest);
  const files = new Map<string, Uint8Array>([["root.json", root]]);
  for (const [agentId, bytes] of agents) files.set(`agents/${agentId}.json`, bytes);
  verifyCheckpointBundleV1({ manifest, files });
  files.set("root.json", Buffer.from("tampered"));
  assert.throws(() => verifyCheckpointBundleV1({ manifest, files }), /descriptor mismatch/);
});

class MemoryCheckpointPort implements CheckpointSwitchPortV1 {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>();
  readonly operations: string[] = [];
  failAfterOperation: number | undefined;

  constructor(main: string, oldPointer?: Uint8Array) {
    for (const path of [main, `${main}/checkpoints`, `${main}/journals`]) this.directories.add(path);
    if (oldPointer) this.files.set(`${main}/CURRENT`, Buffer.from(oldPointer));
  }

  private after(label: string): void {
    this.operations.push(label);
    if (this.failAfterOperation === this.operations.length) throw new Error(`fault after ${label}`);
  }

  async mkdir(path: string): Promise<void> {
    if (this.directories.has(path)) throw new Error("EEXIST");
    this.directories.add(path);
    this.after(`mkdir:${path}`);
  }

  async writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
    if (this.files.has(path)) throw new Error("EEXIST");
    this.files.set(path, Buffer.from(bytes));
    this.after(`write:${path}`);
  }

  async syncFile(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error("ENOENT");
    this.after(`sync-file:${path}`);
  }

  async syncDir(path: string): Promise<void> {
    if (!this.directories.has(path)) throw new Error("ENOENT");
    this.after(`sync-dir:${path}`);
  }

  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error("ENOENT");
    this.files.delete(from);
    this.files.set(to, bytes);
    this.after(`rename:${from}->${to}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("ENOENT");
    this.after(`read:${path}`);
    return Buffer.from(bytes);
  }
}

function checkpointInput(main = "/store/main_x") {
  return {
    mainDirectory: main,
    mainKey: MAIN_KEY,
    checkpointGeneration: 2,
    journalGeneration: 2,
    hostRevision: 3,
    lastJournalSequence: 12,
    createdAt: NOW,
    rootBytes: Buffer.from(`${canonicalJson({ version: 1, host_revision: 3 })}\n`),
    agents: new Map([[`agt_${"a".repeat(22)}`, Buffer.from(`${canonicalJson({ version: 1, agent: "a" })}\n`)]]),
  };
}

test("CURRENT formats and generation filenames are closed", () => {
  assert.equal(generationHex(1), "0000000000000001");
  assert.equal(checkpointDirectoryName(1), "cp_0000000000000001");
  assert.equal(journalFileName(1), "jr_0000000000000001.bin");
  const pointer = { version: 1 as const, checkpoint_generation: 2, journal_generation: 3 };
  assert.deepEqual(parseCurrentPointerV1(JSON.parse(Buffer.from(encodeCurrentPointerV1(pointer)).toString("utf8"))), pointer);
  assert.throws(() => parseCurrentPointerV1({ ...pointer, extra: true }), /unknown/);
});

test("checkpoint switch reopens actual files and CURRENT rename is the only authority boundary", async () => {
  const main = "/store/main_x";
  const oldPointer = encodeCurrentPointerV1({ version: 1, checkpoint_generation: 1, journal_generation: 1 });
  const baseline = new MemoryCheckpointPort(main, oldPointer);
  const success = await switchCheckpointV1(baseline, checkpointInput(main));
  assert.equal(success.pointer.checkpoint_generation, 2);
  assert.equal(parseCurrentPointerV1(JSON.parse(baseline.files.get(`${main}/CURRENT`)!.toString("utf8"))).checkpoint_generation, 2);
  const operationCount = baseline.operations.length;
  const renameIndex = baseline.operations.findIndex((entry) => entry.startsWith("rename:")) + 1;
  assert.ok(renameIndex > 0);

  for (let failAfter = 1; failAfter <= operationCount; failAfter++) {
    const port = new MemoryCheckpointPort(main, oldPointer);
    port.failAfterOperation = failAfter;
    await assert.rejects(switchCheckpointV1(port, checkpointInput(main)));
    const raw = port.files.get(`${main}/CURRENT`)!;
    const pointer = parseCurrentPointerV1(JSON.parse(raw.toString("utf8")));
    assert.equal(pointer.checkpoint_generation, failAfter < renameIndex ? 1 : 2, `fault ${failAfter}: ${port.operations.at(-1)}`);
  }
});

test("checkpoint reopen catches persisted root or agent corruption", async () => {
  const port = new MemoryCheckpointPort("/store/main_x");
  const originalRead = port.readFile.bind(port);
  port.readFile = async (path: string) => {
    const bytes = await originalRead(path);
    if (path.endsWith("root.json")) return Buffer.from("tampered\n");
    return bytes;
  };
  await assert.rejects(switchCheckpointV1(port, checkpointInput()), /descriptor mismatch/);
});

test("descriptor helpers bind exact paths, sizes and digests", () => {
  const bytes = Buffer.from("x");
  assert.deepEqual(descriptorFor("root.json", bytes), { file: "root.json", bytes: 1, sha256: sha256Hex(bytes) });
  assert.throws(() => descriptorFor("../root.json", bytes), /path/);
  assert.throws(() => descriptorFor(`agents/agt_${"a".repeat(22)}.json`, bytes, `agt_${"b".repeat(22)}`), /identity/);
});
