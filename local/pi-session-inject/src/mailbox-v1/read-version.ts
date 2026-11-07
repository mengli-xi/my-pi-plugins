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
export const READ_VERSION_ATTEMPTS = 3;
function appendVersion(before: FileVersion | null, after: FileVersion | null): boolean {
  return !!before && !!after && before.dev === after.dev && before.ino === after.ino && after.size > before.size;
}
export function requireSameFileVersion(before: FileVersion | null, after: FileVersion | null): void {
  if (sameFileVersion(before, after)) return;
  // Only growth of the same inode is a recoverable append race. Replacement,
  // truncation and equal-size rewrites remain unverifiable, never retry authority.
  throw new MailboxError(appendVersion(before, after) ? "read-race" : "unverifiable-proof", "file changed while reading mailbox proof");
}
/** Check both the opened inode and its path before accepting bytes. Unstable
 * bytes are never returned or parsed; session readers bound append retries. */
export async function readVersionedText(path: string): Promise<{ text: string; version: FileVersion } | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = await handle.stat({ bigint: true });
    const text = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const current = await fileVersion(path);
    const checks = [[before, after], [after, current]] as const;
    // A growth observation must not mask a later replace/truncate/rewrite.
    for (const [left, right] of checks)
      if (!sameFileVersion(left, right) && !appendVersion(left, right)) requireSameFileVersion(left, right);
    for (const [left, right] of checks) requireSameFileVersion(left, right);
    return { text, version: after };
  } finally { await handle.close(); }
}
