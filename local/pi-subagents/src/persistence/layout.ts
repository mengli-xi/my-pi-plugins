import { join } from "node:path";
import { isDomainId, isMainKey } from "../domain/ids.js";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const STORE_FORMAT = "pi-subagents-store";
export const STORE_VERSION = 1;

const CHECKPOINT = /^cp_[0-9a-f]{16}$/u;
const JOURNAL = /^jr_[0-9a-f]{16}\.bin$/u;
const DIAGNOSTIC = /^diag-([1-9][0-9]*)-([0-9a-f]{16})\.jsonl(?:\.([1-3]))?$/u;
const LOCK_RECLAIM = /^writer\.lock\.reclaim-[0-9a-f]{32}$/u;
const RECOVERY_TAIL = /^[0-9]{8}T[0-9]{6}\.[0-9]{3}Z-txn_[A-Za-z0-9_-]{22}\.tail$/u;
const OWNER_TEMP = /^owner\.tmp-[0-9a-f]{32}$/u;
const CONVERSATION_REPAIR = /^\.repair-txn_[A-Za-z0-9_-]{22}\.jsonl$/u;

export interface StorePathsV1 {
  readonly packageRoot: string;
  readonly storeRoot: string;
  readonly mainsRoot: string;
  readonly diagnosticsRoot: string;
}

export interface MainStorePathsV1 {
  readonly mainRoot: string;
  readonly ownerFile: string;
  readonly currentFile: string;
  readonly writerLock: string;
  readonly checkpoints: string;
  readonly journals: string;
  readonly prepared: string;
  readonly conversations: string;
  readonly trash: string;
  readonly recovery: string;
}

export function storePaths(agentDir: string): StorePathsV1 {
  const packageRoot = join(agentDir, "pi-subagents");
  return Object.freeze({
    packageRoot,
    storeRoot: join(packageRoot, "store-v2"),
    mainsRoot: join(packageRoot, "store-v2", "mains"),
    diagnosticsRoot: join(packageRoot, "diagnostics"),
  });
}

export function mainStorePaths(mainsRoot: string, mainKey: string): MainStorePathsV1 {
  if (!isMainKey(mainKey)) throw new Error("invalid Main key");
  const mainRoot = join(mainsRoot, mainKey);
  return Object.freeze({
    mainRoot,
    ownerFile: join(mainRoot, "owner.json"),
    currentFile: join(mainRoot, "CURRENT"),
    writerLock: join(mainRoot, "writer.lock"),
    checkpoints: join(mainRoot, "checkpoints"),
    journals: join(mainRoot, "journals"),
    prepared: join(mainRoot, "prepared"),
    conversations: join(mainRoot, "conversations"),
    trash: join(mainRoot, "trash"),
    recovery: join(mainRoot, "recovery"),
  });
}

export type MainRootEntryKind =
  | "owner"
  | "owner-temp"
  | "current"
  | "current-temp"
  | "writer-lock"
  | "writer-lock-reclaim"
  | "checkpoints"
  | "journals"
  | "prepared"
  | "conversations"
  | "trash"
  | "recovery";

// 布局本身会产生这两种在途临时名：checkpoint 切换写的 CURRENT.tmp，以及 marker 写入用的 owner.tmp-*。
// crash 会把它们留在原地，所以它们属于封闭布局，不能被当成外来条目。
export function classifyMainRootEntry(name: string): MainRootEntryKind | undefined {
  if (name === "owner.json") return "owner";
  if (OWNER_TEMP.test(name)) return "owner-temp";
  if (name === "CURRENT") return "current";
  if (name === "CURRENT.tmp") return "current-temp";
  if (name === "writer.lock") return "writer-lock";
  if (LOCK_RECLAIM.test(name)) return "writer-lock-reclaim";
  if (name === "checkpoints") return "checkpoints";
  if (name === "journals") return "journals";
  if (name === "prepared") return "prepared";
  if (name === "conversations") return "conversations";
  if (name === "trash") return "trash";
  if (name === "recovery") return "recovery";
  return undefined;
}

export function isCheckpointName(name: string): boolean { return CHECKPOINT.test(name); }
export function isJournalName(name: string): boolean { return JOURNAL.test(name); }
export function isDiagnosticName(name: string): boolean { return DIAGNOSTIC.test(name); }
export function isRecoveryTailName(name: string): boolean { return RECOVERY_TAIL.test(name); }
export function isOwnerTempName(name: string): boolean { return OWNER_TEMP.test(name); }
/** conversations/<agentId>/ 下的合法条目，含 artifacts.ts 修复尾部时留下的 .repair- 临时文件。 */
export function isConversationEntryName(name: string): boolean { return name === "session.jsonl" || name === "system-prompt.txt" || CONVERSATION_REPAIR.test(name); }
export function isPreparedName(name: string): boolean { return isDomainId(name, "txn"); }
export function isConversationName(name: string): boolean { return isDomainId(name, "agt"); }
export function isTrashName(name: string): boolean { return isDomainId(name, "cln"); }

export function diagnosticBaseName(pid: number, processNonce16: string): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("diagnostic pid is invalid");
  if (!/^[0-9a-f]{16}$/u.test(processNonce16)) throw new Error("diagnostic process nonce is invalid");
  return `diag-${pid}-${processNonce16}.jsonl`;
}

export function checkpointName(generation: number): string {
  return `cp_${generationHex(generation)}`;
}

export function journalName(generation: number): string {
  return `jr_${generationHex(generation)}.bin`;
}

function generationHex(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("generation must be a positive safe integer");
  const value = generation.toString(16);
  if (value.length > 16) throw new Error("generation exceeds filename width");
  return value.padStart(16, "0");
}
