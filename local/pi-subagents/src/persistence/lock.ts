import { randomBytes } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalJson } from "../capabilities/canonical.js";
import {
  ensurePrivateDirectory,
  inspectPrivateDirectory,
  listPrivateDirectory,
  readPrivateFile,
  removeValidatedPrivateTree,
  syncDirectory,
  writePrivateFileExclusive,
  type SafeFsOptionsV1,
} from "./fs-safe.js";
import { PRIVATE_DIR_MODE } from "./layout.js";

export interface WriterLockOwnerV1 {
  readonly version: 1;
  readonly pid: number;
  readonly process_nonce: string;
  readonly host_nonce: string;
  readonly acquired_at: string;
}

export interface WriterLockPortsV1 {
  readonly pid?: number;
  readonly processNonce?: string;
  readonly hostNonce?: string;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly kill?: (pid: number, signal: 0) => void;
  readonly fs?: SafeFsOptionsV1;
}

export interface WriterLockHandleV1 {
  readonly path: string;
  readonly owner: WriterLockOwnerV1;
  release(): Promise<void>;
}

export class StoreLockedError extends Error {
  readonly code = "store-locked";
}

function nonce43(value: string | undefined, random: (size: number) => Uint8Array): string {
  const result = value ?? Buffer.from(random(32)).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(result)) throw new Error("writer nonce must contain 256-bit base64url");
  return result;
}

function timestamp(date: Date): string {
  const result = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) throw new Error("writer timestamp is invalid");
  return result;
}

function encodeOwner(owner: WriterLockOwnerV1): Buffer {
  return Buffer.from(`${canonicalJson(owner)}\n`, "utf8");
}

function decodeOwner(buffer: Buffer): WriterLockOwnerV1 {
  const source = buffer.toString("utf8");
  if (!source.endsWith("\n") || source.slice(0, -1).includes("\n")) throw new Error("lock owner must be one canonical JSON line");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("lock owner is invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lock owner must be an object");
  if (canonicalJson(value) + "\n" !== source) throw new Error("lock owner is not canonical JSON");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join("\0") !== ["acquired_at", "host_nonce", "pid", "process_nonce", "version"].join("\0")) {
    throw new Error("lock owner has unknown or missing keys");
  }
  if (object.version !== 1 || !Number.isSafeInteger(object.pid) || (object.pid as number) <= 0) throw new Error("lock owner identity is invalid");
  if (typeof object.process_nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(object.process_nonce)) throw new Error("lock process nonce is invalid");
  if (typeof object.host_nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(object.host_nonce)) throw new Error("lock host nonce is invalid");
  if (typeof object.acquired_at !== "string" || timestamp(new Date(object.acquired_at)) !== object.acquired_at) throw new Error("lock timestamp is invalid");
  return Object.freeze(object as unknown as WriterLockOwnerV1);
}

async function readExistingOwner(lockPath: string, fs: SafeFsOptionsV1 | undefined): Promise<WriterLockOwnerV1> {
  await inspectPrivateDirectory(lockPath, fs);
  const entries = await listPrivateDirectory(lockPath, fs);
  if (entries.length !== 1 || entries[0] !== "owner.json") throw new Error("writer lock layout is invalid");
  return decodeOwner(await readPrivateFile(join(lockPath, "owner.json"), 4096, fs));
}

function processIsDead(pid: number, kill: (pid: number, signal: 0) => void): boolean {
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    return false;
  }
}

async function createLock(lockPath: string, owner: WriterLockOwnerV1, fs: SafeFsOptionsV1 | undefined): Promise<void> {
  await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
  try {
    await inspectPrivateDirectory(lockPath, fs);
    await writePrivateFileExclusive(join(lockPath, "owner.json"), encodeOwner(owner), fs);
    await syncDirectory(lockPath, fs);
    await syncDirectory(dirname(lockPath), fs);
  } catch (error) {
    // mkdir succeeded in this call, so this path is ours to clean. An EEXIST
    // from mkdir is thrown before this try block and never removes another owner.
    await removeValidatedPrivateTree(lockPath, fs).catch(() => undefined);
    throw error;
  }
}

export async function acquireWriterLockV1(lockPath: string, ports: WriterLockPortsV1 = {}): Promise<WriterLockHandleV1> {
  if (basename(lockPath) !== "writer.lock") throw new Error("writer lock path must end in writer.lock");
  const parent = dirname(lockPath);
  await inspectPrivateDirectory(parent, ports.fs);
  const random = ports.randomBytes ?? randomBytes;
  const owner: WriterLockOwnerV1 = Object.freeze({
    version: 1,
    pid: ports.pid ?? process.pid,
    process_nonce: nonce43(ports.processNonce, random),
    host_nonce: nonce43(ports.hostNonce, random),
    acquired_at: timestamp((ports.now ?? (() => new Date()))()),
  });
  const kill = ports.kill ?? ((pid: number, signal: 0) => process.kill(pid, signal));
  try {
    await createLock(lockPath, owner, ports.fs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: WriterLockOwnerV1;
    try { existing = await readExistingOwner(lockPath, ports.fs); } catch (validationError) {
      throw new StoreLockedError(`writer lock cannot be validated: ${validationError instanceof Error ? validationError.message : String(validationError)}`);
    }
    if (!processIsDead(existing.pid, kill)) throw new StoreLockedError(`Main store is locked by PID ${existing.pid}`);
    const reclaimName = `writer.lock.reclaim-${Buffer.from(random(16)).toString("hex")}`;
    if (!/^writer\.lock\.reclaim-[0-9a-f]{32}$/u.test(reclaimName)) throw new Error("invalid reclaim name");
    const reclaimed = join(parent, reclaimName);
    let renamed = false;
    try {
      await rename(lockPath, reclaimed);
      renamed = true;
      await syncDirectory(parent, ports.fs);
      await createLock(lockPath, owner, ports.fs);
      await removeValidatedPrivateTree(reclaimed, ports.fs);
    } catch (reclaimError) {
      if (renamed) {
        try {
          await rename(reclaimed, lockPath);
          await syncDirectory(parent, ports.fs);
        } catch {
          // Keep both validated paths for operator/recovery inspection rather
          // than deleting uncertain ownership evidence.
        }
      }
      throw new StoreLockedError(`writer lock reclaim failed: ${reclaimError instanceof Error ? reclaimError.message : String(reclaimError)}`);
    }
  }
  let released = false;
  return Object.freeze({
    path: lockPath,
    owner,
    async release(): Promise<void> {
      if (released) return;
      const current = await readExistingOwner(lockPath, ports.fs);
      if (current.process_nonce !== owner.process_nonce || current.host_nonce !== owner.host_nonce || current.pid !== owner.pid) {
        throw new StoreLockedError("stale writer lock handle cannot release replacement lock");
      }
      await removeValidatedPrivateTree(lockPath, ports.fs);
      released = true;
    },
  });
}

export async function ensureMainLayoutDirectoriesV1(mainRoot: string, options?: SafeFsOptionsV1): Promise<void> {
  await ensurePrivateDirectory(mainRoot, options);
  for (const name of ["checkpoints", "journals", "prepared", "conversations", "trash", "recovery"]) {
    await ensurePrivateDirectory(join(mainRoot, name), options);
  }
  await syncDirectory(mainRoot, options);
}
