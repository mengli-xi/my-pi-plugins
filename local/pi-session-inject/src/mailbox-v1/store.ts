import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readlink, realpath, symlink, unlink, rename, readdir, rmdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { MailboxError } from "./errors.js";
import { cloneJson, parseMailboxSnapshot, same } from "./validation.js";
import { checkpoint } from "./checkpoint.js";
import { fileVersion, readVersionedText, sameFileVersion, type FileVersion } from "./read-version.js";
import type { MailboxSessionIdentity, MailboxSnapshot, PendingRecord, TerminalRecord, MailboxRecoveryTarget } from "./types.js";
import { snapshotPath } from "./storage.js";
export { canonicalAgentDir, snapshotPath } from "./storage.js";

export interface SnapshotDraft {
  version: 1; session: MailboxSessionIdentity; revision: number;
  suspended: MailboxSnapshot["suspended"]; pending: PendingRecord[]; terminal: TerminalRecord[];
  attempt?: MailboxSnapshot["attempt"];
}
export type StoreFaultPoint = "before-lock" | "before-write" | "before-file-sync" | "before-rename" | "before-directory-sync" | "after-commit"
  | "before-unlink" | "after-unlink" | "before-rmdir" | "after-rmdir";
export interface StoreFaults { at(point: StoreFaultPoint): void | Promise<void> }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const empty = (snapshot: MailboxSnapshot) => !snapshot.pending.length && !snapshot.terminal.length && !snapshot.attempt && !snapshot.suspended;
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
}

/** One writer, serial atomic snapshots. No source callback executes in transact.
 * A lock is an atomic symlink whose complete PID/token exists from creation;
 * partial PID files and elapsed-time/TTL reclamation are deliberately avoided. */
export class MailboxStore {
  readonly path: string;
  readonly directory: string;
  readonly lockPath: string;
  readonly owner = `${process.pid}:${randomUUID()}`;
  readonly identity: MailboxSessionIdentity;
  #snapshot: MailboxSnapshot;
  #version: FileVersion | null | undefined;
  #reading: Promise<MailboxSnapshot> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #locked = false;
  readonly faults: StoreFaults | undefined;
  readonly onAcquire: ((snapshot: MailboxSnapshot) => void) | undefined;

  constructor(agentDir: string, identity: MailboxSessionIdentity, faults?: StoreFaults, onAcquire?: (snapshot: MailboxSnapshot) => void) {
    if (identity.file !== null && !isAbsolute(identity.file)) throw new MailboxError("conflict", "session file must be absolute");
    this.path = snapshotPath(agentDir, identity.id);
    this.directory = resolve(this.path, "..");
    this.lockPath = join(this.directory, "writer.lock");
    this.identity = { ...identity };
    this.faults = faults;
    this.onAcquire = onAcquire;
    this.#snapshot = { version: 1, session: this.identity, revision: 0, suspended: null, pending: [], terminal: [] };
  }
  get snapshot(): MailboxSnapshot { return this.#snapshot; }
  async acquire(): Promise<void> {
    // A cleaner may remove the empty directory between mkdir and symlink.
    // Retry that race with a bound; never continue without a writer lock.
    for (let attempt = 0; ; attempt++) {
      await mkdir(this.directory, { recursive: true });
      await this.faults?.at("before-lock");
      try { await symlink(this.owner, this.lockPath); break; }
      catch (error) {
        if (missing(error)) {
          if (attempt < 7) continue;
          throw new MailboxError("writer-conflict", "mailbox directory kept changing during lock acquisition", { cause: error });
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = await readlink(this.lockPath).catch(cause => { if (missing(cause)) return null; throw cause; });
        if (previous === null) {
          if (attempt < 7) continue;
          throw new MailboxError("writer-conflict", "mailbox lock kept changing during acquisition");
        }
        const [pidText, token] = previous.split(":");
        if (!/^\d+$/.test(pidText ?? "") || !token || alive(Number(pidText))) {
          throw new MailboxError("writer-conflict", `mailbox writer is live or unverifiable: ${previous || this.lockPath}`);
        }
        // Claim reclamation of this specific dead owner's token. Other reclaimers
        // cannot remove a replacement lock. A crashed reclaimer leaves a visible
        // conflict instead of permitting a second writer on uncertain evidence.
        const claim = join(this.directory, `reclaim-${token}`);
        try { await symlink(this.owner, claim); }
        catch { throw new MailboxError("writer-conflict", "mailbox dead-writer reclamation is already claimed"); }
        try {
          if (await readlink(this.lockPath) !== previous) throw new MailboxError("writer-conflict", "mailbox writer changed during reclaim");
          await unlink(this.lockPath);
          await symlink(this.owner, this.lockPath);
        } catch (cause) { throw new MailboxError("writer-conflict", "mailbox writer raced with dead-owner reclaim", { cause }); }
        finally { await unlink(claim).catch(() => {}); }
        break;
      }
    }
    this.#locked = true;
    try {
      // A lock handoff is a new read lifetime, even if metadata looks unchanged.
      if (this.#reading) await this.#reading;
      this.#version = undefined;
      this.#snapshot = await this.read(); this.onAcquire?.(this.#snapshot);
    } catch (error) { await this.#releaseLock(); throw error; }
  }
  async read(): Promise<MailboxSnapshot> {
    if (this.#reading) return this.#reading;
    const reading = this.#readCurrent();
    this.#reading = reading;
    try { return await reading; }
    finally { if (this.#reading === reading) this.#reading = undefined; }
  }
  async #readCurrent(): Promise<MailboxSnapshot> {
    try {
      const version = await fileVersion(this.path);
      if (this.#locked && sameFileVersion(this.#version, version)) return this.#snapshot;
      this.#version = undefined;
      const disk = version === null ? null : await readVersionedText(this.path);
      if (!disk) {
        if (!empty(this.#snapshot)) throw new MailboxError("unverifiable-proof", "previously committed mailbox snapshot disappeared");
        this.#version = null;
        return this.#snapshot;
      }
      const snapshot = parseMailboxSnapshot(JSON.parse(disk.text));
      if (snapshot.session.id !== this.identity.id || snapshot.session.file !== this.identity.file) throw new MailboxError("conflict", "mailbox snapshot/session identity mismatch");
      if (snapshot.session.cwd && this.identity.cwd && snapshot.session.cwd !== this.identity.cwd) {
        const [original, current] = await Promise.all([realpath(snapshot.session.cwd).catch(() => resolve(snapshot.session.cwd!)), realpath(this.identity.cwd).catch(() => resolve(this.identity.cwd!))]);
        if (original !== current) throw new MailboxError("conflict", `mailbox origin cwd differs: ${snapshot.session.cwd}`);
      }
      this.#snapshot = snapshot;
      this.#version = disk.version;
      return snapshot;
    } catch (error) { this.#version = undefined; throw error; }
  }
  transact<T>(edit: (draft: SnapshotDraft) => T): Promise<T> {
    if (this.#closed) return Promise.reject(new MailboxError("stale-binding", "mailbox store closed"));
    const result = this.#tail.then(async () => {
      if (!this.#locked) await this.acquire();
      if (!this.#locked || await readlink(this.lockPath).catch(() => "") !== this.owner) {
        this.#version = undefined;
        throw new MailboxError("writer-conflict", "mailbox writer lock lost");
      }
      const before = await this.read();
      const draft = cloneJson(before) as SnapshotDraft;
      const value = edit(draft);
      if (!draft.session.cwd && this.identity.cwd) draft.session = { ...draft.session, cwd: this.identity.cwd };
      if (same(before, draft)) { this.#snapshot = before; await this.#removeEmpty(); return value; }
      draft.revision = before.revision + 1;
      const next = parseMailboxSnapshot(draft);
      const temporary = join(this.directory, `.pending-${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await this.faults?.at("before-write");
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(next)}\n`);
        await this.faults?.at("before-file-sync");
        await handle.sync();
        const written = await handle.stat({ bigint: true });
        await this.faults?.at("before-rename");
        await rename(temporary, this.path);
        await this.faults?.at("before-directory-sync");
        await syncDirectory(this.directory);
        const version = await handle.stat({ bigint: true });
        await handle.close(); handle = undefined;
        this.#snapshot = next;
        const current = await fileVersion(this.path);
        // Rename may change ctime, but the written content metadata must survive.
        this.#version = written.dev === version.dev && written.ino === version.ino && written.size === version.size
          && written.mtimeNs === version.mtimeNs && sameFileVersion(version, current) ? version : undefined;
        await this.faults?.at("after-commit");
        await this.#removeEmpty();
        return value;
      } catch (cause) {
        // Rename may already have committed. The next transaction rereads disk;
        // callers never receive success on an uncertain write result.
        this.#version = undefined;
        throw new MailboxError("io-error", `mailbox snapshot commit failed: ${String(cause)}`, { cause });
      } finally {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
  async #releaseLock(): Promise<void> {
    if (this.#locked && await readlink(this.lockPath).catch(() => "") === this.owner) await unlink(this.lockPath);
    this.#locked = false;
    this.#version = undefined;
  }
  /** Runs only in the transaction queue after a complete empty commit. Native
   * terminal receipts already replaced every GC'd key; no callback runs here. */
  async #removeEmpty(): Promise<void> {
    if (!empty(this.#snapshot)) return;
    await this.faults?.at("before-unlink"); checkpoint("before-snapshot-unlink");
    await unlink(this.path).catch(error => { if (!missing(error)) throw error; });
    await this.faults?.at("after-unlink"); checkpoint("after-snapshot-unlink");
    await syncDirectory(this.directory);
    // writer.lock lives inside this directory. Release only our token, then let
    // atomic rmdir refuse any directory a competing writer has populated.
    await this.#releaseLock();
    await this.faults?.at("before-rmdir"); checkpoint("before-snapshot-rmdir");
    try { await rmdir(this.directory); }
    catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await this.faults?.at("after-rmdir"); checkpoint("after-snapshot-rmdir");
    await syncDirectory(resolve(this.directory, ".."));
  }
  barrier(): Promise<void> { return this.#tail; }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    await this.#releaseLock();
  }
}

/** Lists actual orphan snapshots only; no synthesized completion values. */
export async function listRecoveryTargets(agentDir: string): Promise<MailboxRecoveryTarget[]> {
  const root = join(agentDir, "mailbox", "v1");
  const names = await readdir(root).catch(error => { if (missing(error)) return []; throw error; });
  const targets: MailboxRecoveryTarget[] = [];
  for (const name of names) {
    try {
      const snapshot = parseMailboxSnapshot(JSON.parse(await readFile(snapshotPath(agentDir, name), "utf8")));
      if (snapshot.pending.length > 0 || snapshot.terminal.some(record => record.terminalAck === "pending" || record.recorded?.ack === "pending")) targets.push({ agentDir, session: snapshot.session, pendingCount: snapshot.pending.length });
    } catch (error) { if (!missing(error)) throw error; }
  }
  return targets;
}
