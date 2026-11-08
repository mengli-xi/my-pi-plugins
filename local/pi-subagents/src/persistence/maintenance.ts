import { lstat, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { allocatedRegularFileBytes, assertPrivateDirectoryStats, assertPrivateFileStats, removeValidatedPrivateTree, syncDirectory, type SafeFsOptionsV1 } from "./fs-safe.js";
import type { NormalizedStoreStateV1 } from "./types.js";

export interface MainStoreUsageV1 { readonly totalBytes: number; readonly metadataBytes: number; readonly conversationBytes: number; readonly maintenanceBytes: number }

function add(left: number, right: number): number { const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new Error("store usage exceeds safe integer range"); return result; }
async function walk(path: string, category: "metadata" | "conversation" | "maintenance", options: SafeFsOptionsV1 | undefined, totals: Record<string, number>): Promise<void> { const stats = await lstat(path); if (stats.isDirectory()) { assertPrivateDirectoryStats(path, stats, options); for (const name of await readdir(path)) { if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error("unsafe store entry name"); await walk(join(path, name), category, options, totals); } return; } assertPrivateFileStats(path, stats, options); const bytes = allocatedRegularFileBytes(stats); totals.total = add(totals.total!, bytes); totals[category] = add(totals[category]!, bytes); }

export async function measureMainStoreUsageV1(mainRoot: string, options?: SafeFsOptionsV1): Promise<MainStoreUsageV1> {
  const totals = { total: 0, metadata: 0, conversation: 0, maintenance: 0 };
  const entries = await readdir(mainRoot);
  for (const name of entries) {
    const path = join(mainRoot, name);
    if (name === "conversations") await walk(path, "conversation", options, totals);
    else if (name === "prepared" || name === "trash" || name === "recovery") await walk(path, "maintenance", options, totals);
    else if (name === "writer.lock" || name.startsWith("writer.lock.reclaim-")) continue;
    else await walk(path, "metadata", options, totals);
  }
  return Object.freeze({ totalBytes: totals.total, metadataBytes: totals.metadata, conversationBytes: totals.conversation, maintenanceBytes: totals.maintenance });
}

export interface AdmissionCapacityV1 {
  readonly maxStoreBytesPerMain: number;
  readonly maxMetadataBytesPerMain: number;
  readonly maintenanceAllowanceBytes?: number;
}
export function assertMainAdmissionCapacityV1(usage: MainStoreUsageV1, additional: { metadataBytes: number; conversationBytes: number }, limits: AdmissionCapacityV1): void {
  const allowance = limits.maintenanceAllowanceBytes ?? 16_777_216;
  for (const [label, value] of Object.entries({ ...additional, maxStoreBytesPerMain: limits.maxStoreBytesPerMain, maxMetadataBytesPerMain: limits.maxMetadataBytesPerMain, allowance })) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  if (add(usage.metadataBytes, additional.metadataBytes) > limits.maxMetadataBytesPerMain) throw new Error("[subagent/storage-capacity] metadata cap would be exceeded");
  const projected = add(usage.totalBytes, add(additional.metadataBytes, additional.conversationBytes));
  if (projected > limits.maxStoreBytesPerMain) throw new Error("[subagent/storage-capacity] Main store cap would be exceeded");
  if (usage.totalBytes > limits.maxStoreBytesPerMain + allowance) throw new Error("[subagent/storage-unavailable] maintenance allowance is exhausted");
}

export function assertCheckpointPeakCapacityV1(usage: MainStoreUsageV1, newCheckpointBytes: number, newJournalBytes: number, limits: AdmissionCapacityV1): void {
  const allowance = limits.maintenanceAllowanceBytes ?? 16_777_216;
  for (const value of [newCheckpointBytes, newJournalBytes, limits.maxStoreBytesPerMain, limits.maxMetadataBytesPerMain, allowance]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("checkpoint peak input is invalid");
  const newGenerationBytes = add(newCheckpointBytes, newJournalBytes);
  if (newCheckpointBytes > limits.maxMetadataBytesPerMain) throw new Error("[subagent/storage-capacity] compacted checkpoint exceeds metadata cap");
  if (add(usage.totalBytes, newGenerationBytes) > add(limits.maxStoreBytesPerMain, allowance)) throw new Error("[subagent/storage-capacity] checkpoint peak exceeds Main maintenance allowance");
}

// 每笔 commit 要量两次整份状态。状态都过了 codec 校验（无游离代理对、无 undefined、只有安全整数），
// JSON.stringify 和规范 JSON 只差键序，字节数相同；规范编码逐字符校验，Root 涨到几 MB 后每笔要多花上百毫秒。
export function estimateNormalizedMetadataBytesV1(state: NormalizedStoreStateV1): number {
  let bytes = Buffer.byteLength(JSON.stringify(state.root)) + 1;
  for (const partition of state.agents) bytes = add(bytes, Buffer.byteLength(JSON.stringify(partition)) + 1);
  return bytes;
}

export async function moveAgentConversationToTrashV1(mainRoot: string, agentId: string, cleanupId: string, options?: SafeFsOptionsV1): Promise<string> {
  if (!/^agt_[A-Za-z0-9_-]{22}$/u.test(agentId) || !/^cln_[A-Za-z0-9_-]{22}$/u.test(cleanupId)) throw new Error("cleanup identity is invalid");
  const source = join(mainRoot, "conversations", agentId); const trash = join(mainRoot, "trash", cleanupId); const target = join(trash, agentId);
  const sourceStats = await lstat(source); assertPrivateDirectoryStats(source, sourceStats, options);
  try { const trashStats = await lstat(trash); assertPrivateDirectoryStats(trash, trashStats, options); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await (await import("node:fs/promises")).mkdir(trash, { mode: 0o700 }); }
  await rename(source, target); await syncDirectory(join(mainRoot, "conversations"), options); await syncDirectory(trash, options); return target;
}
export async function finishTrashCleanupV1(target: string, options?: SafeFsOptionsV1): Promise<void> { await removeValidatedPrivateTree(target, options); const parent = join(target, ".."); try { if ((await readdir(parent)).length === 0) await rm(parent); } catch { /* cleanup evidence may remain */ } }
