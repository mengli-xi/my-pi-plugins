import { createReadStream } from "node:fs";
import { mkdir, opendir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setImmediate as yieldToUi } from "node:timers/promises";
import { DAY_MS, mergeShard, parseShard, readShard, type DailyShard } from "./daily-format.ts";

export const ARCHIVE_NAME = "summary.jsonl";
export const ARCHIVE_GROUP_LIMIT = 32;
export const ARCHIVE_BYTE_LIMIT = 8 * 1024 * 1024;
interface Archive { version: 1; kind: "daily-summary"; day: string; transaction: string; combined: boolean; groups: Map<string, DailyShard> }
function freshArchive(day: string): Archive {
  return { version: 1, kind: "daily-summary", day, transaction: "", combined: false, groups: new Map() };
}
export async function readArchive(directory: string, day: string): Promise<Archive> {
  const path = join(directory, ARCHIVE_NAME);
  try { if ((await stat(path)).size > ARCHIVE_BYTE_LIMIT) throw new Error("daily archive exceeds 8MiB"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return freshArchive(day);
    throw error;
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const result = freshArchive(day); let header = false, count = 0, bytes = 0, buffer = "";
  const consume = async (line: string) => {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("daily archive line exceeds 1MiB");
    if (!header) {
      const meta = JSON.parse(line);
      if (meta?.version !== 1 || meta.kind !== "daily-summary" || meta.day !== day || typeof meta.transaction !== "string" || typeof meta.combined !== "boolean") throw new Error("invalid archive header");
      result.transaction = meta.transaction; result.combined = meta.combined; header = true;
    } else {
      if (++count > ARCHIVE_GROUP_LIMIT + 5) throw new Error("too many archive groups");
      mergeShard(result.groups, await parseShard(line, day));
    }
    await yieldToUi();
  };
  try {
    // Iterating the stream directly propagates read/open errors to the caller;
    // readline's input stream errors must not become uncaught session errors.
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > ARCHIVE_BYTE_LIMIT) throw new Error("daily archive exceeds 8MiB");
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) { await consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("daily archive line exceeds 1MiB");
    }
    if (buffer) await consume(buffer);
    if (!header) throw new Error("empty daily archive");
    return result;
  } finally { stream.destroy(); }
}
/** Caller owns the maintenance/day lock. Never unlink a live writer's tmp. */
export async function cleanDeadTemps(directory: string, now = Date.now()): Promise<void> {
  let entries;
  try { entries = await opendir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
    const path = join(directory, entry.name), pid = entry.name.match(/\.(\d+)\.tmp$/)?.[1];
    if (pid) {
      try { process.kill(Number(pid), 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    } else {
      // 另一个进程可能刚删掉它
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!info || info.mtimeMs >= now - DAY_MS) continue;
    }
    await rm(path, { force: true });
  }
}
async function maintenanceArchive(directory: string, day: string, assertOwned: () => void): Promise<Archive> {
  try { return await readArchive(directory, day); } catch (error) {
    if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
    const path = join(directory, ARCHIVE_NAME);
    let backup = `${path}.bad`;
    try { await stat(backup); backup += `.${randomUUID()}`; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assertOwned(); await rename(path, backup);
    const reason = error instanceof SyntaxError ? "invalid JSON" : (error as Error).message;
    throw new Error(`summary.jsonl quarantined as ${backup.slice(directory.length + 1)}: ${reason}`);
  }
}
function encode(archive: Archive): string {
  return [JSON.stringify({ version: 1, kind: archive.kind, day: archive.day, transaction: archive.transaction, combined: archive.combined }),
    ...[...archive.groups.values()].map(group => JSON.stringify(group))].join("\n") + "\n";
}
function boundArchive(archive: Archive): string {
  const source = [...archive.groups.values()]; archive.groups = new Map();
  const individual = source.filter(group => group.identity.piVersion !== "mixed" || !group.identity.packagesHash.startsWith("other-"));
  const overflow = source.filter(group => !individual.includes(group));
  const collapse = (group: DailyShard) => {
    archive.combined = true;
    mergeShard(archive.groups, { ...group, identity: { ...group.identity, piVersion: "mixed", packages: ["other"], packagesHash: `other-${group.identity.mode}` } });
  };
  for (const group of overflow) collapse(group);
  const kept = individual.slice(0, ARCHIVE_GROUP_LIMIT);
  for (const group of individual.slice(ARCHIVE_GROUP_LIMIT)) collapse(group);
  for (const group of kept) mergeShard(archive.groups, group);
  let payload = encode(archive);
  while (Buffer.byteLength(payload) > ARCHIVE_BYTE_LIMIT && kept.length) {
    const group = kept.pop()!;
    archive.groups.delete(`${group.day}/${group.identity.piVersion}/${group.identity.packagesHash}/${group.identity.mode}`);
    collapse(group); payload = encode(archive);
  }
  if (Buffer.byteLength(payload) > ARCHIVE_BYTE_LIMIT) throw new Error("daily archive cannot fit bounded format");
  return payload;
}
async function commitArchive(directory: string, archive: Archive, assertOwned: () => void): Promise<void> {
  const temporary = join(directory, `${ARCHIVE_NAME}.${process.pid}.tmp`);
  assertOwned(); await writeFile(temporary, boundArchive(archive), { mode: 0o600 });
  assertOwned(); await rename(temporary, join(directory, ARCHIVE_NAME));
}
/** Called only while holding the day's lock. The archive transaction token
 * makes recovery after commit-before-delete exactly-once, without retaining an
 * unbounded set of historical run IDs in the permanent archive. */
export async function recoverCompaction(directory: string, day: string, assertOwned: () => void): Promise<void> {
  const pending = join(directory, ".compact");
  let transaction: string;
  try {
    transaction = JSON.parse(await readFile(join(pending, "state.json"), "utf8")).transaction;
    if (typeof transaction !== "string" || !/^[a-f0-9-]{36}$/.test(transaction)) throw new Error("invalid compaction transaction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A crash before state publication cannot have moved any run files yet.
    let files: string[];
    try { files = await readdir(pending); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (files.some(name => name.endsWith(".json") && name !== "state.json")) throw new Error("compaction state missing; source files retained");
    assertOwned(); await rm(pending, { recursive: true, force: true }); return;
  }
  const archive = await maintenanceArchive(directory, day, assertOwned);
  if (archive.transaction !== transaction) {
    for (const name of await readdir(pending)) {
      if (name === "state.json" || !name.endsWith(".json")) continue;
      mergeShard(archive.groups, await readShard(join(pending, name), day));
      await yieldToUi();
    }
    archive.transaction = transaction;
    await commitArchive(directory, archive, assertOwned);
  }
  assertOwned(); await rm(pending, { recursive: true, force: true });
}
/** Lock held by caller. Each batch is recoverable, so maintenance can yield or
 * stop on runtime retirement without dropping or double-counting a run. */
/** 只有还剩 run 文件、未完成事务或临时文件的日期才值得加锁合并。 */
export async function needsCompaction(directory: string): Promise<boolean> {
  let entries;
  try { entries = await opendir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for await (const entry of entries) {
    if (entry.name === ".compact" || (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".tmp")))) return true;
  }
  return false;
}
export async function compactDay(directory: string, day: string, assertOwned: () => void, signal?: AbortSignal): Promise<number> {
  await cleanDeadTemps(directory);
  let invalid = 0; const candidates: string[] = [];
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) candidates.push(entry.name);
  }
  // Archive-only dates need no merge. A pending transaction still needs recovery.
  let pending = false;
  try { await stat(join(directory, ".compact")); pending = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!candidates.length && !pending) return 0;
  await maintenanceArchive(directory, day, assertOwned);
  await recoverCompaction(directory, day, assertOwned);
  for (let offset = 0; offset < candidates.length && !signal?.aborted; offset += 128) {
    const valid: string[] = [];
    for (const name of candidates.slice(offset, offset + 128)) {
      try { await readShard(join(directory, name), day); valid.push(name); } catch { invalid++; }
      await yieldToUi();
    }
    if (!valid.length) continue;
    const pending = join(directory, ".compact"); assertOwned();
    await mkdir(pending, { mode: 0o700 });
    await writeFile(join(pending, "state.tmp"), JSON.stringify({ transaction: randomUUID() }), { mode: 0o600 });
    await rename(join(pending, "state.tmp"), join(pending, "state.json"));
    for (const name of valid) { assertOwned(); await rename(join(directory, name), join(pending, name)); }
    await recoverCompaction(directory, day, assertOwned);
  }
  return invalid;
}
