import { constants } from "node:fs";
import * as fs from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { mergeReserve, parseSettings, reserveReport, type ReserveModel, type ReserveReport } from "./reserve.ts";

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function readReserveSettings(agentDir: string, cwd: string) {
  const [globalText, projectText] = await Promise.all([readOptional(join(agentDir, "settings.json")), readOptional(join(cwd, ".pi/settings.json"))]);
  return { globalText, projectText, global: parseSettings(globalText), project: parseSettings(projectText) };
}

/** Same lock identity as Pi 1.5 FileSettingsStorage: proper-lockfile(path, {realpath:false}).
 * All reads/backup/rename happen while held; unrelated concurrent settings are retained.
 */
export async function writeReserveSettings(agentDir: string, cwd: string, models: ReserveModel[], approved: ReserveReport, previous: Awaited<ReturnType<typeof readReserveSettings>>): Promise<string | undefined> {
  const path = join(agentDir, "settings.json");
  await mkdir(agentDir, { recursive: true });
  // Jiti can proxy graceful-fs; proper-lockfile's nonconfigurable precision-cache symbol then
  // violates Proxy invariants on a second lock. A fresh plain Node fs adapter avoids that cache seam.
  const release = await lockfile.lock(path, { realpath: false, fs: { ...fs }, retries: { retries: 10, minTimeout: 20, maxTimeout: 100 } });
  let temporary: string | undefined;
  try {
    const current = await readReserveSettings(agentDir, cwd);
    // A changed compaction configuration requires a new confirmation; unrelated edits are merged.
    if (JSON.stringify(current.global.compaction) !== JSON.stringify(previous.global.compaction) || current.projectText !== previous.projectText) {
      throw new Error("确认期间 compaction 或项目设置已变化，未写入；请重新运行 /compaction reserve write。");
    }
    const fresh = reserveReport(models, current.global, current.project);
    if (JSON.stringify(fresh.changes) !== JSON.stringify(approved.changes)) throw new Error("待写入条目已变化，未写入；请重新运行。");
    if (!Object.keys(fresh.changes).length) return undefined;
    const info = await lstat(path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (info?.isSymbolicLink()) throw new Error("settings.json 是符号链接，未写入。");
    const next = mergeReserve(current.globalText, fresh.changes);
    const backup = `${path}.before-reserve-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    if (info) await copyFile(path, backup, constants.COPYFILE_EXCL);
    else { const file = await open(backup, "wx", 0o600); await file.writeFile("{}\n"); await file.close(); }
    temporary = join(dirname(path), `.settings-reserve-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", info ? info.mode & 0o777 : 0o600);
    try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); temporary = undefined;
    return backup;
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await release();
  }
}
