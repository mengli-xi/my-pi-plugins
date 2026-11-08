import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./layout.js";

export type PersistenceFaultStep =
  | "before-mkdir"
  | "after-mkdir"
  | "before-open"
  | "after-open"
  | "before-write"
  | "after-write"
  | "before-file-sync"
  | "after-file-sync"
  | "before-rename"
  | "after-rename"
  | "before-dir-sync"
  | "after-dir-sync"
  | "before-remove"
  | "after-remove";

export interface SafeFsOptionsV1 {
  readonly uid?: number;
  readonly fault?: (step: PersistenceFaultStep, path: string) => void | Promise<void>;
}

export class UnsafeFilesystemEntryError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

function currentUid(options?: SafeFsOptionsV1): number {
  const uid = options?.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) throw new Error("current UID is unavailable");
  return uid as number;
}

async function fault(options: SafeFsOptionsV1 | undefined, step: PersistenceFaultStep, path: string): Promise<void> {
  await options?.fault?.(step, path);
}

function modeBits(stats: Stats): number { return stats.mode & 0o777; }

export function assertPrivateDirectoryStats(path: string, stats: Stats, options?: SafeFsOptionsV1): void {
  if (!stats.isDirectory()) throw new UnsafeFilesystemEntryError(path, "expected a directory");
  if (stats.uid !== currentUid(options)) throw new UnsafeFilesystemEntryError(path, "directory owner does not match current UID");
  if (modeBits(stats) !== PRIVATE_DIR_MODE) throw new UnsafeFilesystemEntryError(path, "directory mode must be exactly 0700");
}

export function assertPrivateFileStats(path: string, stats: Stats, options?: SafeFsOptionsV1): void {
  if (!stats.isFile()) throw new UnsafeFilesystemEntryError(path, "expected a regular file");
  if (stats.uid !== currentUid(options)) throw new UnsafeFilesystemEntryError(path, "file owner does not match current UID");
  if (modeBits(stats) !== PRIVATE_FILE_MODE) throw new UnsafeFilesystemEntryError(path, "file mode must be exactly 0600");
  if (stats.nlink !== 1) throw new UnsafeFilesystemEntryError(path, "hard-linked private files are forbidden");
}

export async function inspectOwnedDirectory(path: string, options?: SafeFsOptionsV1): Promise<Stats> { const stats=await lstat(path); if(!stats.isDirectory())throw new UnsafeFilesystemEntryError(path,"expected a directory"); if(stats.uid!==currentUid(options))throw new UnsafeFilesystemEntryError(path,"directory owner does not match current UID"); return stats; }

export async function inspectPrivateDirectory(path: string, options?: SafeFsOptionsV1): Promise<Stats> {
  const stats = await lstat(path);
  assertPrivateDirectoryStats(path, stats, options);
  return stats;
}

export async function inspectPrivateFile(path: string, options?: SafeFsOptionsV1): Promise<Stats> {
  const stats = await lstat(path);
  assertPrivateFileStats(path, stats, options);
  return stats;
}

export async function ensurePrivateDirectory(path: string, options?: SafeFsOptionsV1): Promise<void> {
  await fault(options, "before-mkdir", path);
  try {
    await mkdir(path, { mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await fault(options, "after-mkdir", path);
  await inspectPrivateDirectory(path, options);
}

export async function ensurePrivateDirectoryChain(base: string, segments: readonly string[], options?: SafeFsOptionsV1): Promise<string> {
  await inspectPrivateDirectory(base, options);
  let path = base;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error("unsafe directory segment");
    }
    path = join(path, segment);
    await ensurePrivateDirectory(path, options);
  }
  return path;
}

function noFollowFlags(base: number): number {
  return base | (constants.O_NOFOLLOW ?? 0);
}

async function verifiedOpen(path: string, flags: number, mode: number | undefined, options?: SafeFsOptionsV1): Promise<FileHandle> {
  let before: Stats | undefined;
  try { before = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (before) assertPrivateFileStats(path, before, options);
  await fault(options, "before-open", path);
  const handle = await open(path, noFollowFlags(flags), mode);
  try {
    const after = await handle.stat();
    assertPrivateFileStats(path, after, options);
    if (before && (before.dev !== after.dev || before.ino !== after.ino)) {
      throw new UnsafeFilesystemEntryError(path, "file identity changed while opening");
    }
    await fault(options, "after-open", path);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function readPrivateFile(path: string, maxBytes: number, options?: SafeFsOptionsV1): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes is invalid");
  const handle = await verifiedOpen(path, constants.O_RDONLY, undefined, options);
  try {
    const stats = await handle.stat();
    if (stats.size > maxBytes) throw new Error(`${path}: exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(Number(stats.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${path}: short read`);
      offset += result.bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function writePrivateFileExclusive(path: string, data: Uint8Array, options?: SafeFsOptionsV1): Promise<void> {
  await fault(options, "before-open", path);
  const handle = await open(path, noFollowFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL), PRIVATE_FILE_MODE);
  try {
    const stats = await handle.stat();
    assertPrivateFileStats(path, stats, options);
    await fault(options, "after-open", path);
    await writeAll(handle, data, path, options);
    await fault(options, "before-file-sync", path);
    await handle.sync();
    await fault(options, "after-file-sync", path);
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, data: Uint8Array, path: string, options?: SafeFsOptionsV1): Promise<void> {
  await fault(options, "before-write", path);
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error(`${path}: short write`);
    offset += result.bytesWritten;
  }
  await fault(options, "after-write", path);
}

export async function syncDirectory(path: string, options?: SafeFsOptionsV1): Promise<void> {
  await inspectPrivateDirectory(path, options);
  await fault(options, "before-dir-sync", path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
  await fault(options, "after-dir-sync", path);
}

export async function atomicReplacePrivateFile(path: string, data: Uint8Array, temporaryName: string, options?: SafeFsOptionsV1): Promise<void> {
  if (basename(temporaryName) !== temporaryName || !/^[A-Za-z0-9._-]+$/u.test(temporaryName)) throw new Error("temporary filename is invalid");
  const parent = dirname(path);
  await inspectPrivateDirectory(parent, options);
  const temporary = join(parent, temporaryName);
  await writePrivateFileExclusive(temporary, data, options);
  await fault(options, "before-rename", path);
  await rename(temporary, path);
  await fault(options, "after-rename", path);
  await syncDirectory(parent, options);
}

export async function listPrivateDirectory(path: string, options?: SafeFsOptionsV1): Promise<string[]> {
  await inspectPrivateDirectory(path, options);
  return (await readdir(path)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export async function removeValidatedPrivateTree(path: string, options?: SafeFsOptionsV1): Promise<void> {
  await validatePrivateTree(path, options);
  await fault(options, "before-remove", path);
  await rm(path, { recursive: true, force: false });
  await fault(options, "after-remove", path);
  await syncDirectory(dirname(path), options);
}

export async function validatePrivateTree(path: string, options?: SafeFsOptionsV1): Promise<void> {
  const stats = await lstat(path);
  if (stats.isDirectory()) {
    assertPrivateDirectoryStats(path, stats, options);
    for (const name of await readdir(path)) await validatePrivateTree(join(path, name), options);
    return;
  }
  assertPrivateFileStats(path, stats, options);
}

export function allocatedRegularFileBytes(stats: Stats): number {
  if (!stats.isFile()) return 0;
  const blocks = typeof stats.blocks === "number" && stats.blocks > 0 ? stats.blocks * 512 : stats.size;
  if (!Number.isSafeInteger(blocks) || blocks < 0) throw new Error("filesystem byte count is invalid");
  return blocks;
}
