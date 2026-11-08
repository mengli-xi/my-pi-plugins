import {
  encodeFrameV1,
  encodePayloadV1,
  JOURNAL_FORMAT_VERSION,
  scanJournalV1,
  transactionDigestV1,
  type JournalAnchorV1,
  type TransactionBeginV1,
  type TransactionCommitV1,
  type TransactionMutationV1,
} from "./journal.js";
import {
  buildCheckpointManifestV1,
  checkpointDirectoryName,
  encodeCheckpointManifestV1,
  encodeCurrentPointerV1,
  generationHex,
  journalFileName,
  parseCheckpointManifestV1,
  parseCurrentPointerV1,
  verifyCheckpointBundleV1,
  type CheckpointBundleV1,
  type CurrentPointerV1,
} from "./checkpoint.js";
import { canonicalJson } from "../capabilities/canonical.js";
import { compareCanonicalV1 } from "./canonical.js";

export interface JournalAppendPortV1 {
  writev(chunks: readonly Uint8Array[]): Promise<number>;
  sync(): Promise<void>;
  reopenReadAll(): Promise<Uint8Array>;
  /** 把 journal 截回 size 字节并 sync；只在证明 commit 不存在后调用。 */
  truncate(size: number): Promise<void>;
}

export interface AppendTransactionInputV1 {
  readonly begin: TransactionBeginV1;
  readonly mutations: readonly TransactionMutationV1[];
  readonly committedAt: string;
  readonly firstSequence: number;
  readonly manifestLastSequence: number;
  readonly checkpointRevision: number;
  readonly currentRevision: number;
  readonly anchorExpectation?: { readonly checkpointGeneration: number; readonly stateSha256: string };
}

export function estimateTransactionBytesV1(input: { begin: TransactionBeginV1; mutations: readonly TransactionMutationV1[]; committedAt: string; firstSequence: number }): number {
  const beginBytes = encodePayloadV1(input.begin);
  const mutationBytes = input.mutations.map((mutation) => {
    if (mutation.transaction_id !== input.begin.transaction_id) throw new Error("transaction mutation id mismatch");
    return encodePayloadV1(mutation);
  });
  const commit: TransactionCommitV1 = { version: 1, type: "tx-commit", transaction_id: input.begin.transaction_id, revision: input.begin.revision, mutation_count: input.mutations.length, transaction_sha256: transactionDigestV1([beginBytes, ...mutationBytes]), committed_at: input.committedAt };
  return [beginBytes, ...mutationBytes, encodePayloadV1(commit)].reduce((sum, payload, index) => sum + encodeFrameV1(input.firstSequence + index, payload).byteLength, 0);
}

export interface AppendTransactionResultV1 {
  readonly committed: true;
  readonly proof: "sync" | "rescan";
  readonly commit: TransactionCommitV1;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly bytesWritten: number;
  readonly transactionBytes: number;
}

export class CommitUncertainError extends Error {
  readonly causeError: unknown;
  readonly commitState: "absent" | "unknown";
  constructor(message: string, causeError: unknown, commitState: "absent" | "unknown") {
    super(message);
    this.name = "CommitUncertainError";
    this.causeError = causeError;
    this.commitState = commitState;
  }
}

function remainingChunks(chunks: readonly Uint8Array[], consumed: number): Uint8Array[] {
  const remaining: Uint8Array[] = [];
  let skipped = 0;
  for (const chunk of chunks) {
    if (skipped + chunk.byteLength <= consumed) {
      skipped += chunk.byteLength;
      continue;
    }
    const start = Math.max(0, consumed - skipped);
    remaining.push(chunk.subarray(start));
    skipped += chunk.byteLength;
  }
  return remaining;
}

async function completeWritev(port: JournalAppendPortV1, chunks: readonly Uint8Array[]): Promise<number> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  let written = 0;
  while (written < total) {
    const count = await port.writev(remainingChunks(chunks, written));
    if (!Number.isSafeInteger(count) || count <= 0 || count > total - written) throw new Error("journal writev returned an invalid short-write count");
    written += count;
  }
  return written;
}

function inspectExactCommit(bytes: Uint8Array, input: AppendTransactionInputV1, expected: TransactionCommitV1): { state: "present" | "absent" | "unknown"; committedBytes: number } {
  const scan = scanJournalV1(bytes, input.manifestLastSequence, input.checkpointRevision, input.anchorExpectation);
  if (scan.status === "corrupt") return { state: "unknown", committedBytes: 0 };
  const present = scan.committed.some((transaction) =>
    transaction.begin.transaction_id === expected.transaction_id
    && transaction.commit.revision === expected.revision
    && transaction.commit.transaction_sha256 === expected.transaction_sha256
    && transaction.commit.mutation_count === expected.mutation_count,
  );
  return { state: present ? "present" : "absent", committedBytes: scan.lastCommittedOffset };
}

export async function appendTransactionV1(port: JournalAppendPortV1, input: AppendTransactionInputV1): Promise<AppendTransactionResultV1> {
  if (input.begin.base_revision !== input.currentRevision || input.begin.revision !== input.currentRevision + 1) throw new Error("append base revision does not match current revision");
  if (input.mutations.length > 8_192) throw new Error("transaction mutation bound exceeded");
  const beginBytes = encodePayloadV1(input.begin);
  const mutationBytes = input.mutations.map((mutation) => {
    if (mutation.transaction_id !== input.begin.transaction_id) throw new Error("transaction mutation id mismatch");
    return encodePayloadV1(mutation);
  });
  const commit: TransactionCommitV1 = {
    version: 1,
    type: "tx-commit",
    transaction_id: input.begin.transaction_id,
    revision: input.begin.revision,
    mutation_count: input.mutations.length,
    transaction_sha256: transactionDigestV1([beginBytes, ...mutationBytes]),
    committed_at: input.committedAt,
  };
  const payloads = [beginBytes, ...mutationBytes, encodePayloadV1(commit)];
  if (payloads.length > 65_536) throw new Error("transaction frame bound exceeded");
  const frames = payloads.map((payload, index) => encodeFrameV1(input.firstSequence + index, payload));
  let bytesWritten = 0;
  try {
    bytesWritten = await completeWritev(port, frames);
    await port.sync();
    return { committed: true, proof: "sync", commit, firstSequence: input.firstSequence, lastSequence: input.firstSequence + frames.length - 1, bytesWritten, transactionBytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0) };
  } catch (error) {
    let bytes: Uint8Array;
    try {
      bytes = await port.reopenReadAll();
    } catch (reopenError) {
      throw new CommitUncertainError("journal commit is uncertain and reopen failed", reopenError, "unknown");
    }
    const inspected = inspectExactCommit(bytes, input, commit);
    if (inspected.state === "present") {
      return { committed: true, proof: "rescan", commit, firstSequence: input.firstSequence, lastSequence: input.firstSequence + frames.length - 1, bytesWritten, transactionBytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0) };
    }
    if (inspected.state === "absent") {
      // 半截 frames 必须在下一次 append 之前截掉。留着它们，后续 commit 会写在破损区段之后，
      // §12.5 只修复单一尾部的 recovery 就永远救不回这个 journal。
      try { await port.truncate(inspected.committedBytes); } catch (truncateError) {
        throw new CommitUncertainError("journal commit is proven absent but the partial tail could not be truncated", truncateError, "unknown");
      }
      throw new CommitUncertainError("journal commit is proven absent after write/sync failure", error, "absent");
    }
    throw new CommitUncertainError("journal commit remains uncertain after corrupt rescan", error, "unknown");
  }
}

export interface CheckpointSwitchPortV1 {
  mkdir(path: string): Promise<void>;
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>;
  syncFile(path: string): Promise<void>;
  syncDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface CheckpointSwitchInputV1 {
  readonly mainDirectory: string;
  readonly mainKey: string;
  readonly checkpointGeneration: number;
  readonly journalGeneration: number;
  readonly hostRevision: number;
  readonly lastJournalSequence: number;
  readonly createdAt: string;
  readonly rootBytes: Uint8Array;
  readonly agents: ReadonlyMap<string, Uint8Array>;
  /**
   * 切换 CURRENT 之前，用打开 store 时的同一套解码校验读回来的 checkpoint；抛错就不建 journal、不切换，
   * 旧代保持权威。「写得出、读不回」的 checkpoint 因此不会变成打不开的 store。
   */
  readonly verifyBeforeSwitch?: (bundle: CheckpointBundleV1) => void;
}

function join(...parts: string[]): string {
  return parts.map((part, index) => index === 0 ? part.replace(/\/+$/u, "") : part.replace(/^\/+|\/+$/gu, "")).join("/");
}

function parseCanonicalFile(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const value = JSON.parse(trimmed) as unknown;
  if (canonicalJson(value) !== trimmed) throw new Error("metadata file is not canonical JSON");
  return value;
}

export async function switchCheckpointV1(port: CheckpointSwitchPortV1, input: CheckpointSwitchInputV1): Promise<{ pointer: CurrentPointerV1; manifest: ReturnType<typeof buildCheckpointManifestV1> }> {
  const checkpointName = checkpointDirectoryName(input.checkpointGeneration);
  const journalName = journalFileName(input.journalGeneration);
  const checkpointDir = join(input.mainDirectory, "checkpoints", checkpointName);
  const agentsDir = join(checkpointDir, "agents");
  const journalPath = join(input.mainDirectory, "journals", journalName);
  const manifest = buildCheckpointManifestV1({
    mainKey: input.mainKey,
    generation: input.checkpointGeneration,
    hostRevision: input.hostRevision,
    lastJournalSequence: input.lastJournalSequence,
    createdAt: input.createdAt,
    rootBytes: input.rootBytes,
    agents: input.agents,
  });
  await port.mkdir(checkpointDir);
  await port.mkdir(agentsDir);
  const files = new Map<string, Uint8Array>();
  await port.writeExclusive(join(checkpointDir, "root.json"), input.rootBytes);
  await port.syncFile(join(checkpointDir, "root.json"));
  for (const [agentId, bytes] of [...input.agents].sort(([left], [right]) => compareCanonicalV1(left, right))) {
    const path = join(agentsDir, `${agentId}.json`);
    await port.writeExclusive(path, bytes);
    await port.syncFile(path);
  }
  const manifestBytes = encodeCheckpointManifestV1(manifest);
  await port.writeExclusive(join(checkpointDir, "manifest.json"), manifestBytes);
  await port.syncFile(join(checkpointDir, "manifest.json"));
  await port.syncDir(agentsDir);
  await port.syncDir(checkpointDir);
  if (input.verifyBeforeSwitch) {
    const writtenManifest = parseCheckpointManifestV1(parseCanonicalFile(await port.readFile(join(checkpointDir, "manifest.json"))));
    const written = new Map<string, Uint8Array>([["root.json", await port.readFile(join(checkpointDir, "root.json"))]]);
    for (const descriptor of writtenManifest.agents) written.set(descriptor.file, await port.readFile(join(checkpointDir, descriptor.file)));
    const bundle = { manifest: writtenManifest, files: written } satisfies CheckpointBundleV1;
    verifyCheckpointBundleV1(bundle);
    input.verifyBeforeSwitch(bundle);
  }

  const anchor: JournalAnchorV1 = {
    version: JOURNAL_FORMAT_VERSION,
    type: "journal-anchor",
    checkpoint_generation: input.checkpointGeneration,
    checkpoint_revision: input.hostRevision,
    checkpoint_state_sha256: manifest.state_sha256,
    created_at: input.createdAt,
  };
  const journalBytes = encodeFrameV1(input.lastJournalSequence + 1, anchor);
  await port.writeExclusive(journalPath, journalBytes);
  await port.syncFile(journalPath);
  await port.syncDir(join(input.mainDirectory, "journals"));

  const pointer: CurrentPointerV1 = { version: 1, checkpoint_generation: input.checkpointGeneration, journal_generation: input.journalGeneration };
  const currentTmp = join(input.mainDirectory, "CURRENT.tmp");
  const current = join(input.mainDirectory, "CURRENT");
  await port.writeExclusive(currentTmp, encodeCurrentPointerV1(pointer));
  await port.syncFile(currentTmp);
  await port.rename(currentTmp, current);
  await port.syncDir(input.mainDirectory);

  const reopenedPointer = parseCurrentPointerV1(parseCanonicalFile(await port.readFile(current)));
  if (reopenedPointer.checkpoint_generation !== pointer.checkpoint_generation || reopenedPointer.journal_generation !== pointer.journal_generation) throw new Error("reopened CURRENT does not match checkpoint switch");
  const reopenedManifest = parseCheckpointManifestV1(parseCanonicalFile(await port.readFile(join(checkpointDir, "manifest.json"))));
  files.set("root.json", await port.readFile(join(checkpointDir, "root.json")));
  for (const descriptor of reopenedManifest.agents) files.set(descriptor.file, await port.readFile(join(checkpointDir, descriptor.file)));
  verifyCheckpointBundleV1({ manifest: reopenedManifest, files } satisfies CheckpointBundleV1);
  const reopenedJournal = await port.readFile(journalPath);
  const scan = scanJournalV1(reopenedJournal, input.lastJournalSequence, input.hostRevision, { checkpointGeneration: input.checkpointGeneration, stateSha256: manifest.state_sha256 });
  if (scan.status !== "valid" || scan.frames.length !== 1) throw new Error("reopened journal anchor is invalid");
  return { pointer, manifest };
}

export function checkpointPathsV1(input: { mainDirectory: string; checkpointGeneration: number; journalGeneration: number }): { checkpointDirectory: string; journalFile: string; currentFile: string } {
  generationHex(input.checkpointGeneration);
  generationHex(input.journalGeneration);
  return {
    checkpointDirectory: join(input.mainDirectory, "checkpoints", checkpointDirectoryName(input.checkpointGeneration)),
    journalFile: join(input.mainDirectory, "journals", journalFileName(input.journalGeneration)),
    currentFile: join(input.mainDirectory, "CURRENT"),
  };
}
