import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { MailboxError } from "./errors.js";

export type FileVersion = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;
export function sameFileVersion(left: FileVersion | null | undefined, right: FileVersion | null): boolean {
  return left === null ? right === null : !!left && !!right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
export async function fileVersion(path: string): Promise<FileVersion | null> {
  try { return await stat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Check both the opened inode and its path before accepting bytes. A changing
 * append/replace/truncate is not proof; callers can retry after it settles. */
export async function readVersionedText(path: string): Promise<{ text: string; version: FileVersion } | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = await handle.stat({ bigint: true });
    const text = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (!sameFileVersion(before, after) || !sameFileVersion(after, await fileVersion(path))) {
      throw new MailboxError("unverifiable-proof", "file changed while reading mailbox proof");
    }
    return { text, version: after };
  } finally { await handle.close(); }
}
