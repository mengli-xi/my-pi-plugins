import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDomainId, isMainKey } from "../domain/ids.js";
import {
  allocatedRegularFileBytes,
  assertPrivateDirectoryStats,
  assertPrivateFileStats,
  type SafeFsOptionsV1,
  UnsafeFilesystemEntryError,
} from "./fs-safe.js";
import {
  classifyMainRootEntry,
  isCheckpointName,
  isConversationEntryName,
  isConversationName,
  isJournalName,
  isPreparedName,
  isRecoveryTailName,
  isTrashName,
} from "./layout.js";

export interface StoreQuotaMainV1 {
  readonly mainKey: string;
  readonly bytes: number;
}

export interface StoreQuotaSnapshotV1 {
  readonly version: 1;
  readonly totalBytes: number;
  readonly mains: readonly StoreQuotaMainV1[];
  readonly scannedAtMs: number;
}

export interface StoreQuotaScanOptionsV1 extends SafeFsOptionsV1 {
  readonly nowMs?: () => number;
  /**
   * 只对这一个 Main 做封闭布局校验，其余 Main 只按 no-follow 安全规则不透明计字节。
   * process quota 是记账，别的 Main 目录里的残留不该让本 Main 的每次 commit 失败。
   * 不传则所有 Main 都严格校验。
   */
  readonly strictMainKey?: string;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("store byte count exceeds safe integer range");
  return result;
}

async function opaquePrivateTreeBytes(path: string, options?: SafeFsOptionsV1): Promise<number> {
  const stats = await lstat(path);
  if (stats.isDirectory()) {
    assertPrivateDirectoryStats(path, stats, options);
    let bytes = 0;
    for (const name of await readdir(path)) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new UnsafeFilesystemEntryError(join(path, name), "unsafe private entry name");
      }
      bytes = safeAdd(bytes, await opaquePrivateTreeBytes(join(path, name), options));
    }
    return bytes;
  }
  assertPrivateFileStats(path, stats, options);
  return allocatedRegularFileBytes(stats);
}

async function fileBytes(path: string, options?: SafeFsOptionsV1): Promise<number> {
  const stats = await lstat(path);
  assertPrivateFileStats(path, stats, options);
  return allocatedRegularFileBytes(stats);
}

async function directoryEntries(path: string, options?: SafeFsOptionsV1): Promise<string[]> {
  const stats = await lstat(path);
  assertPrivateDirectoryStats(path, stats, options);
  return (await readdir(path)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

async function checkpointBytes(path: string, options?: SafeFsOptionsV1): Promise<number> {
  let bytes = 0;
  const entries = await directoryEntries(path, options);
  for (const name of entries) {
    const child = join(path, name);
    if (name === "manifest.json" || name === "root.json") {
      bytes = safeAdd(bytes, await fileBytes(child, options));
      continue;
    }
    if (name !== "agents") throw new UnsafeFilesystemEntryError(child, "unexpected checkpoint entry");
    for (const agentFile of await directoryEntries(child, options)) {
      if (!/^agt_[A-Za-z0-9_-]{22}\.json$/u.test(agentFile)) {
        throw new UnsafeFilesystemEntryError(join(child, agentFile), "unexpected Agent checkpoint entry");
      }
      bytes = safeAdd(bytes, await fileBytes(join(child, agentFile), options));
    }
  }
  return bytes;
}

async function conversationBytes(path: string, options?: SafeFsOptionsV1): Promise<number> {
  let bytes = 0;
  const entries = await directoryEntries(path, options);
  if (entries.some((name) => !isConversationEntryName(name))) {
    throw new UnsafeFilesystemEntryError(path, "unexpected conversation entry");
  }
  for (const name of entries) bytes = safeAdd(bytes, await fileBytes(join(path, name), options));
  return bytes;
}

async function preparedBytes(path: string, options?: SafeFsOptionsV1): Promise<number> {
  let bytes = 0;
  const entries = await directoryEntries(path, options);
  for (const name of entries) {
    const child = join(path, name);
    if (name === "prepare.json" || name === "abort.json") {
      bytes = safeAdd(bytes, await fileBytes(child, options));
      continue;
    }
    if (name !== "artifacts") throw new UnsafeFilesystemEntryError(child, "unexpected prepared entry");
    bytes = safeAdd(bytes, await opaquePrivateTreeBytes(child, options));
  }
  return bytes;
}

// 锁目录在 mkdir 与 owner.json 之间 crash 会留下空目录，reclaim 目录也可能停在半路。
// 记账不负责判定锁是否有效，安全遍历后照实计字节即可。
async function lockBytes(path: string, options?: SafeFsOptionsV1): Promise<number> {
  return opaquePrivateTreeBytes(path, options);
}

async function mainBytes(path: string, options?: SafeFsOptionsV1): Promise<number> {
  let bytes = 0;
  let owner = false;
  for (const name of await directoryEntries(path, options)) {
    const kind = classifyMainRootEntry(name);
    const child = join(path, name);
    if (!kind) throw new UnsafeFilesystemEntryError(child, "unexpected Main store entry");
    if (kind === "owner" || kind === "current" || kind === "owner-temp" || kind === "current-temp") {
      bytes = safeAdd(bytes, await fileBytes(child, options));
      if (kind === "owner") owner = true;
      continue;
    }
    if (kind === "writer-lock" || kind === "writer-lock-reclaim") {
      bytes = safeAdd(bytes, await lockBytes(child, options));
      continue;
    }
    if (kind === "checkpoints") {
      for (const entry of await directoryEntries(child, options)) {
        if (!isCheckpointName(entry)) throw new UnsafeFilesystemEntryError(join(child, entry), "unexpected checkpoint generation");
        bytes = safeAdd(bytes, await checkpointBytes(join(child, entry), options));
      }
    } else if (kind === "journals") {
      for (const entry of await directoryEntries(child, options)) {
        if (!isJournalName(entry)) throw new UnsafeFilesystemEntryError(join(child, entry), "unexpected journal generation");
        bytes = safeAdd(bytes, await fileBytes(join(child, entry), options));
      }
    } else if (kind === "prepared") {
      for (const entry of await directoryEntries(child, options)) {
        if (!isPreparedName(entry)) throw new UnsafeFilesystemEntryError(join(child, entry), "unexpected prepared transaction");
        bytes = safeAdd(bytes, await preparedBytes(join(child, entry), options));
      }
    } else if (kind === "conversations") {
      for (const entry of await directoryEntries(child, options)) {
        if (!isConversationName(entry)) throw new UnsafeFilesystemEntryError(join(child, entry), "unexpected conversation");
        bytes = safeAdd(bytes, await conversationBytes(join(child, entry), options));
      }
    } else if (kind === "trash") {
      for (const entry of await directoryEntries(child, options)) {
        if (!isTrashName(entry)) throw new UnsafeFilesystemEntryError(join(child, entry), "unexpected trash entry");
        bytes = safeAdd(bytes, await opaquePrivateTreeBytes(join(child, entry), options));
      }
    } else if (kind === "recovery") {
      for (const entry of await directoryEntries(child, options)) {
        if (!isRecoveryTailName(entry)) throw new UnsafeFilesystemEntryError(join(child, entry), "unexpected recovery entry");
        bytes = safeAdd(bytes, await fileBytes(join(child, entry), options));
      }
    }
  }
  // A crash before CURRENT may leave a closed-name initialization subset.
  // It is still safely enumerable and counts toward the process quota. The
  // owning recovery path, not quota accounting, decides whether to remove it.
  void owner;
  return bytes;
}

/** 本 Main 目录按封闭布局严格计字节；store.ts 每次 commit 都现量这一份。 */
export async function scanMainStoreQuotaBytesV1(mainRoot: string, options?: SafeFsOptionsV1): Promise<number> {
  return mainBytes(mainRoot, options);
}

// 同时扫几个 Main。一台机器上攒下几十个历史 Main 后，逐个 await 两千多次 lstat 在负载高时要好几秒。
const MAIN_SCAN_CONCURRENCY = 8;

export async function scanProcessStoreQuotaV1(storeRoot: string, options: StoreQuotaScanOptionsV1 = {}): Promise<StoreQuotaSnapshotV1> {
  const rootEntries = await directoryEntries(storeRoot, options);
  if (rootEntries.length !== 2 || !rootEntries.includes("owner.json") || !rootEntries.includes("mains")) {
    throw new UnsafeFilesystemEntryError(storeRoot, "store root must contain exactly owner.json and mains");
  }
  let totalBytes = await fileBytes(join(storeRoot, "owner.json"), options);
  const mainsPath = join(storeRoot, "mains");
  const names = await directoryEntries(mainsPath, options);
  for (const name of names) if (!isMainKey(name)) throw new UnsafeFilesystemEntryError(join(mainsPath, name), "unexpected Main directory");
  const bytesByIndex: number[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      const name = names[index];
      if (name === undefined) return;
      const strict = options.strictMainKey === undefined || options.strictMainKey === name;
      bytesByIndex[index] = strict ? await mainBytes(join(mainsPath, name), options) : await opaquePrivateTreeBytes(join(mainsPath, name), options);
    }
  };
  // allSettled 让所有 worker 跑完再报错，否则先失败的 Promise.all 会留下未观察的 rejection。
  const settled = await Promise.allSettled(Array.from({ length: Math.min(MAIN_SCAN_CONCURRENCY, names.length) }, worker));
  for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason;
  const mains: StoreQuotaMainV1[] = [];
  names.forEach((name, index) => {
    const bytes = bytesByIndex[index]!;
    totalBytes = safeAdd(totalBytes, bytes);
    mains.push(Object.freeze({ mainKey: name, bytes }));
  });
  return Object.freeze({
    version: 1,
    totalBytes,
    mains: Object.freeze(mains),
    scannedAtMs: (options.nowMs ?? Date.now)(),
  });
}

export function assertQuotaAdmissionV1(snapshot: StoreQuotaSnapshotV1, maxStoreBytesPerProcess: number, additionalBytes = 0): void {
  if (!Number.isSafeInteger(maxStoreBytesPerProcess) || maxStoreBytesPerProcess < 0) throw new Error("process quota limit is invalid");
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error("additional byte estimate is invalid");
  if (safeAdd(snapshot.totalBytes, additionalBytes) > maxStoreBytesPerProcess) {
    throw new Error("[subagent/storage-capacity] process store quota would be exceeded");
  }
}
