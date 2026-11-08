import { readMainMailboxRetirement, type MainMailboxReadContextV1 } from "../mailbox/retirement-main.js";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, truncate } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { mainKey } from "../domain/ids.js";
import { canonicalJsonV1, parseStrictJsonV1 } from "./canonical.js";
import { decodeAgentCheckpointV1, decodeRootCheckpointV1, rootHeaderV1 } from "./codecs.js";
import { checkpointDirectoryName, journalFileName, parseCheckpointManifestV1, parseCurrentPointerV1, verifyCheckpointBundleV1, type CheckpointBundleV1 } from "./checkpoint.js";
import { assertPrivateFileStats, atomicReplacePrivateFile, inspectOwnedDirectory, inspectPrivateDirectory, inspectPrivateFile, readPrivateFile, removeValidatedPrivateTree, syncDirectory, UnsafeFilesystemEntryError, writePrivateFileExclusive, type SafeFsOptionsV1 } from "./fs-safe.js";
import { validateNormalizedStoreStateV1 } from "./invariants.js";
import { JOURNAL_FORMAT_VERSION, LEGACY_JOURNAL_FORMAT_VERSION, MAX_JOURNAL_PAYLOAD_BYTES, payloadByteLengthV1, scanJournalV1, type TransactionBeginV1, type TransactionMutationV1 } from "./journal.js";
import { isCheckpointName, isJournalName, isOwnerTempName, mainStorePaths, PRIVATE_FILE_MODE, storePaths } from "./layout.js";
import { acquireWriterLockV1, ensureMainLayoutDirectoriesV1, type WriterLockHandleV1, type WriterLockPortsV1 } from "./lock.js";
import { createMainOwnerV1, encodeMainOwnerV1, encodeStoreRootMarkerV1, parseMainOwnerV1, parseStoreRootMarkerV1 } from "./markers.js";
import { applyJournalMutationsV1 } from "./state-reducer.js";
import { reconcilePreparedDirectoriesV1, type PreparedRecoveryOptionsV1 } from "./prepared.js";
import { planRecoveryV1 } from "./recovery.js";
import { validateAgentArtifactsV1 } from "./artifacts.js";
import { appendTransactionV1, CommitUncertainError, estimateTransactionBytesV1, switchCheckpointV1, type CheckpointSwitchPortV1, type JournalAppendPortV1 } from "./transaction.js";
import type { NormalizedStoreStateV1, RootCheckpointV1, RootHeaderV1 } from "./types.js";
import { assertCheckpointPeakCapacityV1, assertMainAdmissionCapacityV1, estimateNormalizedMetadataBytesV1, measureMainStoreUsageV1 } from "./maintenance.js";
import { assertQuotaAdmissionV1, scanMainStoreQuotaBytesV1, scanProcessStoreQuotaV1, type StoreQuotaMainV1 } from "./quota.js";
import { collectionBoundViolationV1, pruneForCheckpointV1, retentionPressureV1, retentionWorthwhileV1 } from "./retention.js";
import { DiagnosticWriterV1 } from "./diagnostics.js";

const MAX_METADATA_FILE = 67_108_864;
// 其他 Main 的字节多久重扫一次；本 Main 每次 commit 都现量。
const QUOTA_RESCAN_INTERVAL_MS = 60_000;
const CAPACITY = "[subagent/storage-capacity] ";
const RECORD_TOO_LARGE = "journal 单条记录超过 1 MiB（1,048,576 字节）上限";
const COLLECTION_BOUND = "Subagents 存储的条数上限";
function mutationLabel(mutation: TransactionMutationV1): string { return mutation.type === "delete-subtree" ? "delete-subtree" : `${mutation.entity_type} ${mutation.entity_id}`; }
function capacityReason(error: unknown): string | undefined { const message = error instanceof Error ? error.message : String(error); const index = message.indexOf(CAPACITY); return index < 0 ? undefined : message.slice(index + CAPACITY.length); }

export interface MainStoreOpenOptionsV1 {
  readonly agentDirectory: string;
  readonly mainSessionId: string;
  readonly mailboxImport?: boolean;
  readonly mainMailboxReadContext?: MainMailboxReadContextV1;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly fs?: SafeFsOptionsV1;
  readonly lock?: Omit<WriterLockPortsV1, "fs" | "now" | "randomBytes">;
  readonly limits?: {
    readonly maxStoreBytesPerMain?: number;
    readonly maxStoreBytesPerProcess?: number;
    readonly maxMetadataBytesPerMain?: number;
  };
  /** 其他 Main 的 process quota 扫描结果最多复用多久；测试注入用，生产走 60 s 默认。 */
  readonly quotaRescanIntervalMs?: number;
  /** Injectable maintenance policy; production uses the normative defaults. */
  readonly maintenancePolicy?: {
    readonly checkpointJournalBytes: number;
    readonly checkpointTransactions: number;
  };
  /** Authenticated SDK owner snapshot. Undefined means runtime liveness is unknown. */
  readonly liveRuntimeGenerations?: ReadonlyMap<string, { readonly runtimeGeneration: number; readonly preparedTokenDigests: ReadonlySet<string> }>;
  readonly preparedLeaseRecovery?: PreparedRecoveryOptionsV1["leasePort"];
  readonly inboxProofProvider?: (state: NormalizedStoreStateV1) => Promise<ReadonlyMap<string, string>>;
}

export interface MainStoreCommitInputV1 {
  readonly transactionId: string;
  readonly operation: string;
  readonly mutations: readonly TransactionMutationV1[];
  readonly createdAt?: string;
  readonly committedAt?: string;
  readonly maintenance?: boolean;
}

export interface MainStoreCommitResultV1 { readonly revision: number; readonly proof: "sync" | "rescan"; readonly transactionId: string; readonly maintenanceDegraded?: true }
export interface MainStoreHealthV1 { readonly storage: "healthy" | "degraded-maintenance" | "degraded-capacity"; readonly detail?: string }

function timestamp(now: () => Date): string { const value = now().toISOString(); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error("clock must produce millisecond UTC timestamps"); return value; }
function parseCanonicalLine(bytes: Uint8Array): unknown { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("metadata file must be one canonical line"); const value = parseStrictJsonV1(Buffer.from(text.slice(0, -1)), MAX_METADATA_FILE); if (canonicalJsonV1(value) !== text.slice(0, -1)) throw new Error("metadata file is not canonical"); return value; }
function rootCheckpoint(mainKeyValue: string): RootCheckpointV1 { return { version: 1, main_key: mainKeyValue, host_revision: 0, next_admission_order: 1, next_mailbox_sequence: 1, next_owner_event_sequence: 1, last_owner_event_acked_sequence: 0, agent_ids: [], mailbox: [], inbox: [], outbox: [], owner_events: [], operation_receipts: [], wake_receipts: [], cleanup: [], tombstones: [] }; }
function checkpointBytes(value: unknown): Uint8Array { return Buffer.from(`${canonicalJsonV1(value)}\n`, "utf8"); }
async function writeMarkerIfMissing(path: string, bytes: Uint8Array, validate: (bytes: Uint8Array) => unknown, random: (size: number) => Uint8Array, options?: SafeFsOptionsV1): Promise<void> {
  const parent = dirname(path);
  let exists = true;
  try { validate(await readPrivateFile(path, 4096, options)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  // 在 O_EXCL 与写入之间 crash 会留下一个空的/半截的 owner.tmp-*。它按定义就不是一个写完的 marker，
  // 只能当作 crash 残留删掉；把它当成校验失败会让这个 store 永远打不开。
  const stale: string[] = [];
  for (const name of (await readdir(parent)).filter((entry) => isOwnerTempName(entry))) {
    try { validate(await readPrivateFile(join(parent, name), 4096, options)); stale.push(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; if (error instanceof UnsafeFilesystemEntryError) throw error; }
  }
  if (!exists && stale.length === 1) {
    const candidate = join(parent, stale[0]!); await rename(candidate, path); await syncDirectory(parent, options); exists = true;
  } else if (!exists && stale.length > 1) throw new Error("multiple stale owner marker candidates");
  if (!exists) {
    const temporary = `owner.tmp-${Buffer.from(random(16)).toString("hex")}`;
    await atomicReplacePrivateFile(path, bytes, temporary, options); validate(await readPrivateFile(path, 4096, options)); exists = true;
  }
  if (exists) await syncDirectory(parent, options);
  for (const name of (await readdir(parent)).filter((entry) => isOwnerTempName(entry))) await removeValidatedPrivateTree(join(parent, name), options);
}

class RealCheckpointPort implements CheckpointSwitchPortV1 {
  readonly options?: SafeFsOptionsV1;
  constructor(options?: SafeFsOptionsV1) { this.options = options; }
  async mkdir(path: string): Promise<void> { await mkdir(path, { mode: 0o700 }); await inspectPrivateDirectory(path, this.options); }
  async writeExclusive(path: string, bytes: Uint8Array): Promise<void> { await writePrivateFileExclusive(path, bytes, this.options); }
  async syncFile(path: string): Promise<void> { await this.options?.fault?.("before-file-sync", path); const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { assertPrivateFileStats(path, await handle.stat(), this.options); await handle.sync(); } finally { await handle.close(); } await this.options?.fault?.("after-file-sync", path); }
  async syncDir(path: string): Promise<void> { await syncDirectory(path, this.options); }
  async rename(from: string, to: string): Promise<void> { await this.options?.fault?.("before-rename", to); await rename(from, to); await this.options?.fault?.("after-rename", to); }
  async readFile(path: string): Promise<Uint8Array> { return readPrivateFile(path, MAX_METADATA_FILE, this.options); }
}

class RealJournalPort implements JournalAppendPortV1 {
  readonly path: string; readonly options?: SafeFsOptionsV1;
  constructor(path: string, options?: SafeFsOptionsV1) { this.path = path; this.options = options; }
  async writev(chunks: readonly Uint8Array[]): Promise<number> { await this.options?.fault?.("before-write", this.path); const handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)); try { assertPrivateFileStats(this.path, await handle.stat(), this.options); const result = await handle.writev(chunks as readonly Uint8Array[]); await this.options?.fault?.("after-write", this.path); return result.bytesWritten; } finally { await handle.close(); } }
  async sync(): Promise<void> { await this.options?.fault?.("before-file-sync", this.path); const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { assertPrivateFileStats(this.path, await handle.stat(), this.options); await handle.sync(); } finally { await handle.close(); } await this.options?.fault?.("after-file-sync", this.path); }
  async reopenReadAll(): Promise<Uint8Array> { return readPrivateFile(this.path, MAX_METADATA_FILE, this.options); }
  async truncate(size: number): Promise<void> { const handle = await open(this.path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)); try { assertPrivateFileStats(this.path, await handle.stat(), this.options); await handle.truncate(size); await handle.sync(); } finally { await handle.close(); } await syncDirectory(dirname(this.path), this.options); }
}

async function ensureStoreRoot(options: MainStoreOpenOptionsV1, createdAt: string): Promise<ReturnType<typeof storePaths>> {
  const paths = storePaths(options.agentDirectory);
  await inspectOwnedDirectory(options.agentDirectory, options.fs);
  for (const path of [paths.packageRoot, paths.storeRoot, paths.mainsRoot]) {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await inspectPrivateDirectory(path, options.fs);
  }
  const rootOwner = join(paths.storeRoot, "owner.json");
  await writeMarkerIfMissing(rootOwner, encodeStoreRootMarkerV1({ format: "pi-subagents-store", version: 1, install_nonce: Buffer.from((options.randomBytes ?? randomBytes)(32)).toString("base64url"), created_at: createdAt }), parseStoreRootMarkerV1, options.randomBytes ?? randomBytes, options.fs);
  parseStoreRootMarkerV1(await readPrivateFile(join(paths.storeRoot, "owner.json"), 4096, options.fs));
  return paths;
}

async function initializeMain(options: MainStoreOpenOptionsV1, createdAt: string): Promise<{ paths: ReturnType<typeof mainStorePaths>; owner: ReturnType<typeof createMainOwnerV1> }> {
  const root = await ensureStoreRoot(options, createdAt); const key = mainKey(options.mainSessionId); const paths = mainStorePaths(root.mainsRoot, key);
  await ensureMainLayoutDirectoriesV1(paths.mainRoot, options.fs);
  const owner = createMainOwnerV1(options.mainSessionId, createdAt);
  await writeMarkerIfMissing(paths.ownerFile, encodeMainOwnerV1(owner), parseMainOwnerV1, options.randomBytes ?? randomBytes, options.fs);
  const existing = parseMainOwnerV1(await readPrivateFile(paths.ownerFile, 4096, options.fs));
  if (existing.main_session_id !== options.mainSessionId || existing.main_key !== key) throw new Error("Main store identity collision");
  return { paths, owner: existing };
}

async function removeUnreferencedInitialization(paths: ReturnType<typeof mainStorePaths>, options?: SafeFsOptionsV1): Promise<void> {
  for (const path of [join(paths.checkpoints, checkpointDirectoryName(1)), join(paths.journals, journalFileName(1)), join(paths.mainRoot, "CURRENT.tmp")]) {
    try { await removeValidatedPrivateTree(path, options); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function initializeGenerationOne(paths: ReturnType<typeof mainStorePaths>, key: string, createdAt: string, options?: SafeFsOptionsV1): Promise<void> {
  const root = rootCheckpoint(key); validateNormalizedStoreStateV1({ root, agents: [] });
  await removeUnreferencedInitialization(paths, options);
  await switchCheckpointV1(new RealCheckpointPort(options), { mainDirectory: paths.mainRoot, mainKey: key, checkpointGeneration: 1, journalGeneration: 1, hostRevision: 0, lastJournalSequence: 0, createdAt, rootBytes: checkpointBytes(root), agents: new Map() });
}

async function preserveTailAndTruncate(paths: ReturnType<typeof mainStorePaths>, journalPath: string, scan: Extract<ReturnType<typeof scanJournalV1>, { status: "recoverable-tail" }>, options?: SafeFsOptionsV1): Promise<void> {
  const transaction = [...scan.frames].reverse().find((frame) => frame.payload.type === "tx-begin")?.payload;
  const transactionId = transaction?.type === "tx-begin" ? transaction.transaction_id : `txn_${"A".repeat(22)}`;
  const stamp = new Date().toISOString().replace(/[-:]/gu, "");
  const tailPath = join(paths.recovery, `${stamp}-${transactionId}.tail`);
  await writePrivateFileExclusive(tailPath, scan.tailBytes, options); await syncDirectory(paths.recovery, options);
  const handle = await open(journalPath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)); try { assertPrivateFileStats(journalPath, await handle.stat(), options); await handle.truncate(scan.lastCommittedOffset); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(paths.journals, options);
}

/** 打开 store 和切换 checkpoint 前共用的 checkpoint 解码：读不回来的 checkpoint 绝不能成为 CURRENT。 */
function decodeCheckpointStateV1(bundle: CheckpointBundleV1, expectedMainKey: string): NormalizedStoreStateV1 {
  const root = decodeRootCheckpointV1(parseCanonicalLine(bundle.files.get("root.json")!)); if (root.main_key !== expectedMainKey) throw new Error("Root checkpoint Main identity mismatch"); if (root.host_revision !== bundle.manifest.host_revision) throw new Error("Root checkpoint revision mismatch");
  const agents = bundle.manifest.agents.map((descriptor) => decodeAgentCheckpointV1(parseCanonicalLine(bundle.files.get(descriptor.file)!))); const state: NormalizedStoreStateV1 = { root, agents }; validateNormalizedStoreStateV1(state); return state;
}
async function validateGenerationPair(paths: ReturnType<typeof mainStorePaths>, mainKeyValue: string, generation: number, options?: SafeFsOptionsV1): Promise<void> {
  const checkpointDir = join(paths.checkpoints, checkpointDirectoryName(generation));
  const manifest = parseCheckpointManifestV1(parseCanonicalLine(await readPrivateFile(join(checkpointDir, "manifest.json"), 1_048_576, options)));
  if (manifest.generation !== generation || manifest.main_key !== mainKeyValue) throw new Error("obsolete generation identity mismatch");
  const files = new Map<string, Uint8Array>(); for (const descriptor of [manifest.root, ...manifest.agents]) files.set(descriptor.file, await readPrivateFile(join(checkpointDir, descriptor.file), descriptor.bytes, options)); verifyCheckpointBundleV1({ manifest, files });
  const root = decodeRootCheckpointV1(parseCanonicalLine(files.get("root.json")!)); if (root.main_key !== mainKeyValue || root.host_revision !== manifest.host_revision) throw new Error("obsolete generation Root mismatch");
  const journal = await readPrivateFile(join(paths.journals, journalFileName(generation)), MAX_METADATA_FILE, options); const scan = scanJournalV1(journal, manifest.last_journal_sequence, manifest.host_revision, { checkpointGeneration: generation, stateSha256: manifest.state_sha256 }); if (scan.status !== "valid" || scan.frames.length < 1) throw new Error("obsolete generation journal is invalid");
}
async function cleanupObsoleteGenerations(paths: ReturnType<typeof mainStorePaths>, mainKeyValue: string, pointer: { checkpoint_generation: number; journal_generation: number }, options?: SafeFsOptionsV1): Promise<string[]> {
  const errors: string[] = [];
  const currentTmp = join(paths.mainRoot, "CURRENT.tmp");
  // 调用方已经读通了 CURRENT，CURRENT.tmp 不论内容（包括 O_EXCL 建出来还没写的空文件）都只是切换残留。
  try { await removeValidatedPrivateTree(currentTmp, options); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(String(error)); }
  const checkpointNames = await readdir(paths.checkpoints); const journalNames = await readdir(paths.journals);
  const checkpointGenerations = new Map<number, string>(); const journalGenerations = new Map<number, string>();
  for (const name of checkpointNames) { if (!isCheckpointName(name)) { errors.push(`unexpected checkpoint entry: ${name}`); continue; } checkpointGenerations.set(Number.parseInt(name.slice(3), 16), name); }
  for (const name of journalNames) { if (!isJournalName(name)) { errors.push(`unexpected journal entry: ${name}`); continue; } journalGenerations.set(Number.parseInt(name.slice(3, -4), 16), name); }
  const authoritative = Math.max(pointer.checkpoint_generation, pointer.journal_generation);
  for (const generation of new Set([...checkpointGenerations.keys(), ...journalGenerations.keys()])) {
    if (generation === pointer.checkpoint_generation || generation === pointer.journal_generation) continue;
    const checkpointNameValue = checkpointGenerations.get(generation); const journalNameValue = journalGenerations.get(generation);
    // CURRENT 只会向前走：比它新的代从来没当过权威，是切换中途崩溃的残留（比如刚建出来还没写的空 journal），不必成对校验。
    if (!checkpointNameValue || !journalNameValue || generation > authoritative) {
      // §6.0：没有被 CURRENT 引用的 generation 永远不可能成为权威，checkpoint 切换中途 crash 留下的半个 generation
      // 只是维护垃圾。校验成封闭布局后删掉；留着它会让 storage health 永久降级，也挡住下一次同号 checkpoint。
      try {
        if (checkpointNameValue) await removeValidatedPrivateTree(join(paths.checkpoints, checkpointNameValue), options);
        if (journalNameValue) await removeValidatedPrivateTree(join(paths.journals, journalNameValue), options);
      } catch (error) { errors.push(`unreferenced generation ${generation}: ${String(error)}`); }
      continue;
    }
    try { await validateGenerationPair(paths, mainKeyValue, generation, options); await removeValidatedPrivateTree(join(paths.checkpoints, checkpointNameValue), options); await removeValidatedPrivateTree(join(paths.journals, journalNameValue), options); } catch (error) { errors.push(String(error)); }
  }
  for (const directory of [paths.checkpoints,paths.journals]) {
    try { await syncDirectory(directory,options); } catch(error) { errors.push(String(error)); }
  }
  return errors;
}
async function loadState(paths: ReturnType<typeof mainStorePaths>, expectedMainKey: string, options?: SafeFsOptionsV1, cleanup = true): Promise<{ state: NormalizedStoreStateV1; checkpointGeneration: number; checkpointRevision: number; journalGeneration: number; lastJournalSequence: number; nextSequence: number; committedTransactionIds: ReadonlySet<string>; journalBytes: number; transactionsSinceCheckpoint: number; maintenanceErrors: readonly string[]; legacyJournal: boolean }> {
  if (basename(paths.mainRoot) !== expectedMainKey) throw new Error("Main store directory identity mismatch");
  const pointer = parseCurrentPointerV1(parseCanonicalLine(await readPrivateFile(paths.currentFile, 4096, options)));
  const checkpointDir = join(paths.checkpoints, checkpointDirectoryName(pointer.checkpoint_generation)); const manifest = parseCheckpointManifestV1(parseCanonicalLine(await readPrivateFile(join(checkpointDir, "manifest.json"), 1_048_576, options)));
  if (manifest.generation !== pointer.checkpoint_generation || manifest.main_key !== expectedMainKey) throw new Error("CURRENT/checkpoint Main identity mismatch");
  const files = new Map<string, Uint8Array>(); for (const descriptor of [manifest.root, ...manifest.agents]) files.set(descriptor.file, await readPrivateFile(join(checkpointDir, descriptor.file), descriptor.bytes, options)); verifyCheckpointBundleV1({ manifest, files });
  let state = decodeCheckpointStateV1({ manifest, files }, expectedMainKey);
  const journalPath = join(paths.journals, journalFileName(pointer.journal_generation)); const journal = await readPrivateFile(journalPath, MAX_METADATA_FILE, options); let scan = scanJournalV1(journal, manifest.last_journal_sequence, manifest.host_revision, { checkpointGeneration: pointer.checkpoint_generation, stateSha256: manifest.state_sha256 });
  if (scan.status === "corrupt") throw new Error(`[subagent/storage-corrupt] ${scan.reason} at ${scan.offset}`);
  if (scan.status === "recoverable-tail") { await preserveTailAndTruncate(paths, journalPath, scan, options); const repaired = await readPrivateFile(journalPath, MAX_METADATA_FILE, options); scan = scanJournalV1(repaired, manifest.last_journal_sequence, manifest.host_revision, { checkpointGeneration: pointer.checkpoint_generation, stateSha256: manifest.state_sha256 }); if (scan.status !== "valid") throw new Error("journal tail repair did not produce valid authority"); }
  // 格式 1 的 Root put 带整份 Root。所有写入方都把 Root put 放在事务第一条、集合变化另有实体 mutation，
  // 所以只取 Root 头回放与旧语义逐条等价；打开后立刻 checkpoint 成格式 3（openMainStoreV1）。
  const legacyJournal = scan.anchor.version === LEGACY_JOURNAL_FORMAT_VERSION;
  const replayable = (mutations: readonly TransactionMutationV1[]) => legacyJournal ? mutations.map((mutation) => mutation.type === "put" && mutation.entity_type === "root" ? { ...mutation, value: rootHeaderV1(mutation.value as RootHeaderV1) } : mutation) : mutations;
  for (const transaction of scan.committed) state = applyJournalMutationsV1(state, transaction.commit.revision, replayable(transaction.mutations), transaction.begin.operation);
  const committedTransactionIds = new Set(scan.committed.map((transaction) => transaction.begin.transaction_id));
  for (const receipt of [...state.root.operation_receipts, ...state.agents.flatMap((partition) => partition.operation_receipts)]) {
    if (receipt.state === "committed") committedTransactionIds.add(receipt.transaction_id);
  }
  const maintenanceErrors = cleanup ? await cleanupObsoleteGenerations(paths, expectedMainKey, pointer, options) : [];
  return { state, checkpointGeneration: pointer.checkpoint_generation, checkpointRevision: manifest.host_revision, journalGeneration: pointer.journal_generation, lastJournalSequence: manifest.last_journal_sequence, nextSequence: scan.nextSequence, committedTransactionIds, journalBytes: (await inspectPrivateFile(journalPath, options)).size, transactionsSinceCheckpoint: scan.committed.length, maintenanceErrors, legacyJournal: scan.anchor.version !== JOURNAL_FORMAT_VERSION };
}

export class MainStoreV1 {
  mainMailboxReadContext?: MainMailboxReadContextV1;
  readonly paths: ReturnType<typeof mainStorePaths>; readonly lock: WriterLockHandleV1; readonly options: MainStoreOpenOptionsV1;
  #state: NormalizedStoreStateV1; #metadataBytes: number; #checkpointGeneration: number; #checkpointRevision: number; #journalGeneration: number; #manifestLastSequence: number; #nextSequence: number; #journalBytes: number; #transactionsSinceCheckpoint: number; #maintenanceError?: string; #capacityError?: string; #deferredRecovery?: string; #fenced?: string; #closed = false; #queue: Promise<void> = Promise.resolve();
  constructor(input: { paths: ReturnType<typeof mainStorePaths>; lock: WriterLockHandleV1; options: MainStoreOpenOptionsV1; loaded: Awaited<ReturnType<typeof loadState>> }) { this.mainMailboxReadContext = input.options.mainMailboxReadContext; this.paths = input.paths; this.lock = input.lock; this.options = input.options; this.#state = input.loaded.state; this.#metadataBytes = estimateNormalizedMetadataBytesV1(input.loaded.state); this.#checkpointGeneration = input.loaded.checkpointGeneration; this.#checkpointRevision = input.loaded.checkpointRevision; this.#journalGeneration = input.loaded.journalGeneration; this.#manifestLastSequence = input.loaded.lastJournalSequence; this.#nextSequence = input.loaded.nextSequence; this.#journalBytes = input.loaded.journalBytes; this.#transactionsSinceCheckpoint = input.loaded.transactionsSinceCheckpoint; if (input.loaded.maintenanceErrors.length > 0) this.#maintenanceError = `generation cleanup failed: ${input.loaded.maintenanceErrors[0]}`.slice(0, 512); }
  get mainRoot(): string { return this.paths.mainRoot; }
  snapshot(): NormalizedStoreStateV1 { return structuredClone(this.#state); }
  // maintenance 降级只影响 health；只有权威本身不可证明（#fenced）才禁止继续 mutation。
  // 容量拒绝只说明「这笔没写进去」，store 仍可继续提交更小的事务；下一笔提交成功就恢复 healthy。
  health(): MainStoreHealthV1 { const detail = this.#fenced ?? this.#maintenanceError; if (detail) return Object.freeze({ storage: "degraded-maintenance", detail }); const capacity = this.#deferredRecovery ?? this.#capacityError; return capacity ? Object.freeze({ storage: "degraded-capacity", detail: capacity }) : Object.freeze({ storage: "healthy" }); }
  /** 打开时的恢复事务被容量上限拒绝：照常打开（store 未改动），health 一直标 degraded，直到下次打开重新恢复。 */
  deferOpenRecovery(operation: string, error: unknown): void { this.#deferredRecovery = `启动恢复事务 ${operation} 因存储容量不足没有提交（${capacityReason(error) ?? String(error)}）。未结算的 Task 暂时保持原状；删除已结算的子 Agent 子树腾出空间后，重开会话会重试恢复。`.slice(0, 512); }
  #adoptLoaded(loaded: Awaited<ReturnType<typeof loadState>>): void { this.#state = loaded.state; this.#metadataBytes = estimateNormalizedMetadataBytesV1(loaded.state); this.#checkpointGeneration = loaded.checkpointGeneration; this.#checkpointRevision = loaded.checkpointRevision; this.#journalGeneration = loaded.journalGeneration; this.#manifestLastSequence = loaded.lastJournalSequence; this.#nextSequence = loaded.nextSequence; this.#journalBytes = loaded.journalBytes; this.#transactionsSinceCheckpoint = loaded.transactionsSinceCheckpoint; if (loaded.maintenanceErrors.length > 0) this.#maintenanceError = `generation cleanup failed: ${loaded.maintenanceErrors[0]}`.slice(0, 512); }
  async #serialized<T>(operation: () => Promise<T>): Promise<T> { let release!: () => void; const previous = this.#queue; this.#queue = new Promise<void>((resolve) => { release = resolve; }); await previous; try { if (this.#closed) throw new Error("Main store is closed"); return await operation(); } finally { release(); } }
  async commit(input: MainStoreCommitInputV1): Promise<MainStoreCommitResultV1> {
    return this.#serialized(async () => {
      try { const result = await this.#commitUnlocked(input); this.#capacityError = undefined; return result; }
      catch (error) {
        const reason = capacityReason(error);
        if (reason === undefined) throw error;
        // 诊断放进抛出的错误：模型和用户看到的是 Host 错误，不是 health()。
        this.#capacityError = (reason.startsWith(RECORD_TOO_LARGE) ? `事务 ${input.operation} 已拒绝，store 未改动：${reason}。` : `事务 ${input.operation} 因存储容量不足已拒绝，store 未改动（${reason}）。删除已结算的子 Agent 子树可以腾出空间。`).slice(0, 512);
        throw new Error(`${CAPACITY}${this.#capacityError}`, { cause: error });
      }
    });
  }
  async #commitUnlocked(input: MainStoreCommitInputV1): Promise<MainStoreCommitResultV1> {
    if (this.#fenced) throw new Error(`[subagent/storage-unavailable] ${this.#fenced}`);
    // 单帧上限要在编码前拦下，报成容量拒绝；否则编码时抛的错会被 Host 兜底成 storage-unavailable。
    const oversized = input.mutations.map((mutation) => ({ mutation, bytes: payloadByteLengthV1(mutation) })).find((item) => item.bytes > MAX_JOURNAL_PAYLOAD_BYTES);
    if (oversized) throw new Error(`${CAPACITY}${RECORD_TOO_LARGE}：${mutationLabel(oversized.mutation)} 有 ${oversized.bytes} 字节`);
    const revision = this.#state.root.host_revision + 1;
    const candidate = applyJournalMutationsV1(this.#state, revision, input.mutations, input.operation);
    const bound = collectionBoundViolationV1(candidate);
    if (bound) throw new Error(`${CAPACITY}${COLLECTION_BOUND}：${bound}`);
    const currentMetadata = this.#metadataBytes, candidateMetadata = estimateNormalizedMetadataBytesV1(candidate);
    const metadataLimit = this.options.limits?.maxMetadataBytesPerMain ?? MAX_METADATA_FILE;
    if (candidateMetadata > metadataLimit) throw new Error("[subagent/storage-capacity] metadata hard ceiling would be exceeded");
    const createdAt = input.createdAt ?? timestamp(this.options.now ?? (() => new Date()));
    const committedAt = input.committedAt ?? timestamp(this.options.now ?? (() => new Date()));
    const begin: TransactionBeginV1 = { version: 1, type: "tx-begin", transaction_id: input.transactionId, base_revision: revision - 1, revision, operation: input.operation, created_at: createdAt };
    const estimate = () => estimateTransactionBytesV1({ begin, mutations: input.mutations, committedAt, firstSequence: this.#nextSequence });
    let transactionBytes = estimate();
    const policy = this.options.maintenancePolicy ?? { checkpointJournalBytes: 16_777_216, checkpointTransactions: 4096 };
    const maintain = async () => {
      // 提交前的 checkpoint 不做回收：candidate 和调用方的 mutation 都是按回收前的状态算的。
      try { await this.#checkpointUnlocked(false); }
      catch (error) { this.#maintenanceError = `checkpoint maintenance failed: ${error instanceof Error ? error.message : String(error)}`.slice(0,512); }
      if (this.#fenced) throw new Error(`[subagent/storage-unavailable] ${this.#fenced}`);
      transactionBytes = estimate();
    };
    let maintained = false;
    if ((!input.maintenance && (this.#journalBytes + transactionBytes >= policy.checkpointJournalBytes || this.#transactionsSinceCheckpoint + 1 >= policy.checkpointTransactions)) || this.#journalBytes + transactionBytes > metadataLimit) {
      await maintain(); maintained = true;
    }
    if (!input.maintenance) {
      const checkCapacity = async () => {
        const usage = await measureMainStoreUsageV1(this.paths.mainRoot,this.options.fs);
        const additional = transactionBytes + Math.max(0,candidateMetadata-currentMetadata);
        assertMainAdmissionCapacityV1(usage,{metadataBytes:additional,conversationBytes:0},{maxStoreBytesPerMain:this.options.limits?.maxStoreBytesPerMain ?? 536_870_912,maxMetadataBytesPerMain:metadataLimit});
        await this.#assertProcessQuota(additional,this.options.limits?.maxStoreBytesPerProcess ?? 2_147_483_648);
      };
      try { await checkCapacity(); }
      catch (error) {
        // Retained generations and the active journal are reclaimable maintenance,
        // so try the durable checkpoint boundary before rejecting otherwise valid work.
        if (maintained || !(error instanceof Error) || !error.message.includes("storage-capacity")) throw error;
        // 刚 checkpoint 过、也没有残留旧代时，再 checkpoint 一遍回收不到任何东西，只会重写全部分区。
        if (this.#transactionsSinceCheckpoint === 0 && this.#maintenanceError === undefined) throw error;
        await maintain(); await checkCapacity();
      }
    }
    if (this.#journalBytes + transactionBytes > metadataLimit) throw new Error("[subagent/storage-capacity] journal transaction exceeds metadata allowance after checkpoint");
    const journalPath = join(this.paths.journals,journalFileName(this.#journalGeneration));
    let result;
    try { result = await appendTransactionV1(new RealJournalPort(journalPath,this.options.fs),{begin,mutations:input.mutations,committedAt,firstSequence:this.#nextSequence,manifestLastSequence:this.#manifestLastSequence,checkpointRevision:this.#checkpointRevision,currentRevision:revision-1,anchorExpectation:undefined}); }
    catch (error) { if (error instanceof CommitUncertainError && error.commitState !== "absent") this.#fenced = `journal authority is uncertain after ${input.transactionId}: ${error.message}`.slice(0,512); throw error; }
    this.#state = candidate; this.#metadataBytes = candidateMetadata; this.#nextSequence = result.lastSequence+1; this.#journalBytes += result.transactionBytes; this.#transactionsSinceCheckpoint++;
    let maintenanceDegraded = false;
    // 可回收集合逼近解码上限时，提交后专门做一次带回收的 checkpoint（只在这里和显式 checkpoint 回收）。
    const pressure = retentionPressureV1(this.#state);
    const retentionDue = pressure !== "none" && retentionWorthwhileV1(this.#state, { preparedTransactionIds: await this.#preparedTransactionIds() }, pressure);
    if (this.#journalBytes >= policy.checkpointJournalBytes || this.#transactionsSinceCheckpoint >= policy.checkpointTransactions || retentionDue) {
      try { await this.#checkpointUnlocked(true); }
      catch (error) {
        maintenanceDegraded = true; this.#maintenanceError = `checkpoint maintenance failed: ${error instanceof Error ? error.message : String(error)}`.slice(0,512);
        try { const loaded = await loadState(this.paths,this.#state.root.main_key,this.options.fs); if (loaded.state.root.host_revision !== revision) throw new Error("reopened authority lost committed revision"); this.#adoptLoaded(loaded); }
        catch (reopenError) { this.#maintenanceError = `${this.#maintenanceError}; authority reopen failed: ${reopenError instanceof Error ? reopenError.message : String(reopenError)}`.slice(0,512); }
      }
    }
    return { revision,proof:result.proof,transactionId:input.transactionId,...(maintenanceDegraded || this.#maintenanceError ? {maintenanceDegraded:true as const} : {}) };
  }
  #quotaScan?: { readonly othersBytes: number; readonly scannedAtMs: number; readonly mains: readonly StoreQuotaMainV1[] };
  // process quota 是保守 high-water：本 Main 每次现量，其他 Main 沿用上次扫描；缓存过期、
  // 或者投影离上限不到 1/16 时才重扫整个 store。全量扫描要走遍所有历史 Main，之前每次 commit
  // 跑两遍，Host 队列上每个操作都被它拖住。
  async #assertProcessQuota(additionalBytes: number, limit: number): Promise<void> {
    const storeRoot = dirname(dirname(this.paths.mainRoot)); const ownKey = basename(this.paths.mainRoot);
    const nowMs = (this.options.now ?? (() => new Date()))().getTime();
    const cached = this.#quotaScan;
    if (cached && nowMs >= cached.scannedAtMs && nowMs - cached.scannedAtMs < (this.options.quotaRescanIntervalMs ?? QUOTA_RESCAN_INTERVAL_MS)) {
      const ownBytes = await scanMainStoreQuotaBytesV1(this.paths.mainRoot, this.options.fs);
      if (cached.othersBytes + ownBytes + additionalBytes <= limit - Math.floor(limit / 16)) return;
    }
    const snapshot = await scanProcessStoreQuotaV1(storeRoot, { ...this.options.fs, strictMainKey: ownKey, nowMs: () => nowMs });
    const own = snapshot.mains.find((main) => main.mainKey === ownKey);
    this.#quotaScan = { othersBytes: snapshot.totalBytes - (own?.bytes ?? 0), scannedAtMs: nowMs, mains: snapshot.mains };
    assertQuotaAdmissionV1(snapshot, limit, additionalBytes);
  }
  async #cleanupObsoleteUnlocked(): Promise<void> {
    // 只按磁盘上的 CURRENT 清理，而且必须和内存指针一致。切换 rename 之后没能证明权威时，内存指针会落后于磁盘，
    // 按内存指针删就会删掉 CURRENT 正指着的那一代。
    let pointer: ReturnType<typeof parseCurrentPointerV1>;
    try { pointer = parseCurrentPointerV1(parseCanonicalLine(await readPrivateFile(this.paths.currentFile, 4096, this.options.fs))); }
    catch (error) { this.#maintenanceError = `generation cleanup skipped: CURRENT is unreadable: ${String(error)}`.slice(0,512); return; }
    if (pointer.checkpoint_generation !== this.#checkpointGeneration || pointer.journal_generation !== this.#journalGeneration) { this.#maintenanceError = `generation cleanup skipped: CURRENT on disk (${pointer.checkpoint_generation}/${pointer.journal_generation}) differs from memory (${this.#checkpointGeneration}/${this.#journalGeneration})`.slice(0,512); return; }
    const errors = await cleanupObsoleteGenerations(this.paths,this.#state.root.main_key,pointer,this.options.fs);
    this.#maintenanceError = errors.length ? `generation cleanup failed: ${errors[0]}`.slice(0,512) : undefined;
  }
  /** prepared 目录还在的事务：它的 operation receipt 是恢复时 commit-wins 的证据，保留策略不能删。 */
  async #preparedTransactionIds(): Promise<ReadonlySet<string>> { return new Set((await readdir(this.paths.prepared)).filter((name) => name.startsWith("txn_"))); }
  async #checkpointUnlocked(prune: boolean): Promise<void> {
    if (this.#fenced) throw new Error(`[subagent/storage-unavailable] ${this.#fenced}`);
    await this.#cleanupObsoleteUnlocked();
    // 下一代编号取内存指针和磁盘上已有代的最大值：清理不掉的残留不会让每次切换都撞 EEXIST。
    const onDisk = [...(await readdir(this.paths.checkpoints)).filter(isCheckpointName).map((name) => Number.parseInt(name.slice(3), 16)), ...(await readdir(this.paths.journals)).filter(isJournalName).map((name) => Number.parseInt(name.slice(3, -4), 16))];
    const next = Math.max(this.#checkpointGeneration, this.#journalGeneration, ...onDisk) + 1;
    const context = this.mainMailboxReadContext;
    const facts = prune && this.#state.root.inbox.some(inbox => inbox.state === "appended" && inbox.ui_read_at !== undefined)
      ? await readMainMailboxRetirement(context, true) : undefined;
    const preparedTransactionIds = prune ? await this.#preparedTransactionIds() : new Set<string>();
    const written = prune ? pruneForCheckpointV1(this.#state, { preparedTransactionIds,
      retiredMainOutboxIds: context === this.mainMailboxReadContext ? facts?.retiredOutboxes(this.#state) : undefined }).state : this.#state;
    const rootBytes = checkpointBytes(written.root); const agents = new Map(written.agents.map((partition) => [partition.agent.agent_id, checkpointBytes(partition)]));
    const checkpointEstimate = rootBytes.byteLength + [...agents.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0) + 1_048_576;
    const anchorEstimate = 1_048_576;
    const usage = await measureMainStoreUsageV1(this.paths.mainRoot, this.options.fs); const limits = { maxStoreBytesPerMain: this.options.limits?.maxStoreBytesPerMain ?? 536_870_912, maxMetadataBytesPerMain: this.options.limits?.maxMetadataBytesPerMain ?? MAX_METADATA_FILE, maintenanceAllowanceBytes: 16_777_216 }; assertCheckpointPeakCapacityV1(usage, checkpointEstimate, anchorEstimate, limits);
    await this.#assertProcessQuota(checkpointEstimate + anchorEstimate, (this.options.limits?.maxStoreBytesPerProcess ?? 2_147_483_648) + limits.maintenanceAllowanceBytes);
    try {
      await switchCheckpointV1(new RealCheckpointPort(this.options.fs), { mainDirectory: this.paths.mainRoot, mainKey: this.#state.root.main_key, checkpointGeneration: next, journalGeneration: next, hostRevision: this.#state.root.host_revision, lastJournalSequence: this.#nextSequence - 1, createdAt: timestamp(this.options.now ?? (() => new Date())), rootBytes, agents, verifyBeforeSwitch: (bundle) => { decodeCheckpointStateV1(bundle, written.root.main_key); } });
    } catch (error) {
      // Rename may already have occurred. Complete the parent durability boundary,
      // then adopt whichever CURRENT is actually authoritative without deleting the
      // other generation. If this cannot be proven, fence all further mutation.
      let loaded: Awaited<ReturnType<typeof loadState>>;
      try {
        await syncDirectory(this.paths.mainRoot, this.options.fs);
        loaded = await loadState(this.paths, this.#state.root.main_key, this.options.fs, true);
        if (loaded.state.root.host_revision !== this.#state.root.host_revision) throw new Error("checkpoint recovery revision mismatch");
        this.#adoptLoaded(loaded);
      } catch (reconcileError) {
        this.#fenced = `checkpoint authority uncertain: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`.slice(0, 512);
        throw new Error(this.#fenced, { cause: error });
      }
      // 权威已经证明清楚了：切换成功就照常返回，没切成就把失败报给调用方，
      // 绝不能让一次没发生的 compaction 悄悄「成功」返回。
      if (loaded.checkpointGeneration === next && loaded.journalGeneration === next) return;
      throw new Error(`checkpoint switch did not complete: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (written !== this.#state) { this.#state = written; this.#metadataBytes = estimateNormalizedMetadataBytesV1(written); }
    this.#checkpointGeneration = next; this.#checkpointRevision = this.#state.root.host_revision; this.#journalGeneration = next; this.#manifestLastSequence = this.#nextSequence - 1; this.#nextSequence = this.#manifestLastSequence + 2; this.#journalBytes = (await inspectPrivateFile(join(this.paths.journals, journalFileName(next)), this.options.fs)).size; this.#transactionsSinceCheckpoint = 0;
    // CURRENT was verified and synced before retiring any older generation.
    // Cleanup remains best effort: its failure cannot reject a committed transaction.
    try { await this.#cleanupObsoleteUnlocked(); }
    catch (error) { this.#maintenanceError = `generation cleanup failed: ${String(error)}`.slice(0,512); }
  }
  async checkpoint(): Promise<void> { await this.#serialized(async () => this.#checkpointUnlocked(true)); }
  async close(): Promise<void> { await this.#serialized(async () => { this.#closed = true; }); await this.lock.release(); }
}

export async function openMainStoreV1(options: MainStoreOpenOptionsV1): Promise<MainStoreV1> {
  const now = options.now ?? (() => new Date()); const createdAt = timestamp(now); const { paths } = await initializeMain(options, createdAt); const lock = await acquireWriterLockV1(paths.writerLock, { ...options.lock, fs: options.fs, now, randomBytes: options.randomBytes });
  try {
    try { await inspectPrivateFile(paths.currentFile, options.fs); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await initializeGenerationOne(paths, mainKey(options.mainSessionId), createdAt, options.fs); }
    const loaded = await loadState(paths, mainKey(options.mainSessionId), options.fs);
    const store = new MainStoreV1({ paths, lock, options, loaded });
    // 旧 journal 已按其原格式回放。先 checkpoint 成格式 3 再允许新语义写入；失败就不打开。
    if (loaded.legacyJournal) await store.checkpoint();
    // 恢复事务只放过容量拒绝：store 没有改动，Subagents 仍要能打开，让用户查看并删除已结算子树腾出空间。
    const recover = async (input: MainStoreCommitInputV1) => { try { await store.commit(input); } catch (error) { if (capacityReason(error) === undefined) throw error; store.deferOpenRecovery(input.operation, error); } };
    const prepared = await reconcilePreparedDirectoriesV1(paths.mainRoot, loaded.committedTransactionIds, { fs: options.fs, now, liveRuntimeGenerations: options.liveRuntimeGenerations, leasePort: options.preparedLeaseRecovery });
    if (prepared.incompleteAborted.length > 0) {
      const diagnostics = new DiagnosticWriterV1(storePaths(options.agentDirectory).diagnosticsRoot, { processNonce16: Buffer.from((options.randomBytes ?? randomBytes)(8)).toString("hex"), fs: options.fs, now });
      await diagnostics.initialize();
      for (const transactionId of prepared.incompleteAborted) await diagnostics.write({ severity: "warning", code: "incomplete-prepare-aborted", correlation_id: transactionId, main_key_prefix: mainKey(options.mainSessionId).slice(0, 16), message: "Aborted incomplete prepare with no metadata or files" });
    }
    if (prepared.degraded.length > 0) throw new Error(`[subagent/storage-corrupt] prepared recovery is degraded: ${prepared.degraded.join(",")}`);
    for (const partition of store.snapshot().agents) {
      const validation = await validateAgentArtifactsV1(paths.mainRoot, partition.agent, options.fs);
      if (!validation.ok && partition.agent.availability === "available") {
        const snapshot = store.snapshot(); const revision = snapshot.root.host_revision + 1; const transactionId = `txn_${Buffer.from((options.randomBytes ?? randomBytes)(16)).toString("base64url")}`;
        await recover({ transactionId, operation: "recover-agent-artifacts", mutations: [
          { version: 1, type: "put", transaction_id: transactionId, entity_type: "agent", entity_id: partition.agent.agent_id, value: { ...partition.agent, record_revision: revision, availability: "unavailable", unavailable_reason: validation.reason, unavailable_detail: validation.detail } },
          { version: 1, type: "put", transaction_id: transactionId, entity_type: "root", entity_id: "root", value: { ...rootHeaderV1(snapshot.root), host_revision: revision } },
        ] });
      }
    }
    const beforeRecovery = store.snapshot();
    const hasAppendedInbox = [beforeRecovery.root, ...beforeRecovery.agents].some((partition) => partition.inbox.some((inbox) => inbox.state === "appended"));
    if (hasAppendedInbox && !options.inboxProofProvider) throw new Error("[subagent/storage-unavailable] appended Inbox recovery requires native transcript proof provider");
    const appendedInboxProofs = options.inboxProofProvider ? await options.inboxProofProvider(beforeRecovery) : undefined;
    // Completion requires agent_settled; a crash tail is not completion proof.
    const plan = planRecoveryV1(beforeRecovery, { now, liveRuntimeGenerations: options.liveRuntimeGenerations, appendedInboxProofs, mailboxImport: options.mailboxImport });
    if (plan) await recover({ transactionId: plan.transactionId, operation: "recover-runtime-state", mutations: plan.mutations, maintenance: true });
    return store;
  } catch (error) { await lock.release().catch(() => undefined); throw error; }
}
