import {
	constants,
	copyFileSync,
	linkSync,
	lstatSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { copyFile, lstat, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

export interface SessionRewrite {
	readonly sessionFile: string;
	readonly backupFile: string;
	/** False when ordinary rewind had to copy its backup instead of linking it. */
	readonly supportsCheckedReplacement: boolean;
	rollback(options?: SessionRewriteOptions): Promise<void>;
	discard(): Promise<void>;
}

export interface SessionRewriteOptions {
	/** Fail without replacing the live file unless it still has these exact bytes. */
	expectedCurrentDigest?: string;
	/** @internal Deterministic filesystem-capability injection for tests. */
	linkCurrent?: (existingPath: string, newPath: string) => void;
}

export class SessionRewriteConflictError extends Error {
	constructor() {
		super("The session changed while the rewind transaction was being committed");
		this.name = "SessionRewriteConflictError";
	}
}

export class CheckedSessionRewriteUnsupportedError extends Error {
	constructor() {
		super("Checked rewind restore requires hard-link support in the session directory");
		this.name = "CheckedSessionRewriteUnsupportedError";
	}
}

export function sessionBytesDigest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Read one regular snapshot without following a replacement symlink. */
export async function readSessionSnapshot(file: string): Promise<string> {
	if (!isAbsolute(file)) throw new Error("Rewind snapshot path must be absolute");
	const resolved = resolve(file);
	const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Rewind snapshot must be a regular file");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

function latestSessionInfo(entries: readonly SessionEntry[]): SessionEntry | undefined {
	return [...entries].reverse().find((entry) => entry.type === "session_info");
}

/** Serialize one retained path while keeping the session's display name metadata. */
export function buildPrunedJsonl(
	header: SessionHeader,
	retained: readonly SessionEntry[],
	allEntries: readonly SessionEntry[],
): string {
	const entries = retained.map((entry) => ({ ...entry }));
	const retainedIds = new Set(entries.map((entry) => entry.id));
	const sessionInfo = latestSessionInfo(allEntries);
	if (sessionInfo && !retainedIds.has(sessionInfo.id)) {
		entries.push({
			...sessionInfo,
			parentId: entries.at(-1)?.id ?? null,
		});
	}
	return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

/**
 * Atomically replace the live JSONL after first copying a recoverable sibling.
 * The caller must reload the session and either trash the backup or roll back.
 */
export async function stageSessionRewrite(
	sessionFile: string,
	jsonl: string,
	options: SessionRewriteOptions = {},
): Promise<SessionRewrite> {
	if (!isAbsolute(sessionFile)) throw new Error("Rewind requires an absolute session path");
	const resolved = resolve(sessionFile);
	// Capture the version before the first await: the caller just serialized the
	// live branch on this event loop. An append during preparation must not be
	// replaced by that older serialization, including on copy-only filesystems.
	const info = lstatSync(resolved);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Rewind requires a regular session file");
	const linkCurrent = options.linkCurrent ?? linkSync;
	const suffix = randomUUID();
	const backupFile = `${resolved}.pi-rewind-backup-${suffix}`;
	const temporaryFile = `${resolved}.pi-rewind-next-${suffix}`;
	try {
		const handle = await open(temporaryFile, "wx", info.mode & 0o777);
		try {
			await handle.writeFile(jsonl, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		if (options.expectedCurrentDigest !== undefined) {
			// SessionManager appends synchronously on this event loop. Keep the
			// identity check, rename, and post-rename check synchronous so no
			// extension append can land between validation and replacement. Checked
			// replacement fails closed without a hard link because a copied backup
			// cannot observe writes through an already-open old inode.
			try {
				linkCurrent(resolved, backupFile);
			} catch {
				throw new CheckedSessionRewriteUnsupportedError();
			}
			if (sessionBytesDigest(readFileSync(backupFile)) !== options.expectedCurrentDigest) {
				throw new SessionRewriteConflictError();
			}
			renameSync(temporaryFile, resolved);
			if (sessionBytesDigest(readFileSync(backupFile)) !== options.expectedCurrentDigest) {
				const restore = `${resolved}.pi-rewind-conflict-${randomUUID()}`;
				copyFileSync(backupFile, restore, constants.COPYFILE_EXCL);
				renameSync(restore, resolved);
				throw new SessionRewriteConflictError();
			}
		} else {
			// A hard link keeps the original bytes reachable under the backup name
			// without re-reading the file. Filesystems without links fall back to a
			// copy for ordinary rewind. The final metadata check and rename stay on
			// one event-loop turn; this is not a cross-process filesystem lock.
			try {
				linkCurrent(resolved, backupFile);
			} catch {
				await copyFile(resolved, backupFile, constants.COPYFILE_EXCL);
			}
			const current = lstatSync(resolved);
			if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size ||
				current.mtimeMs !== info.mtimeMs) throw new SessionRewriteConflictError();
			renameSync(temporaryFile, resolved);
		}
	} catch (error) {
		rmSync(temporaryFile, { force: true });
		rmSync(backupFile, { force: true });
		throw error;
	}

	const backupInfo = await lstat(backupFile);
	const supportsCheckedReplacement = backupInfo.dev === info.dev && backupInfo.ino === info.ino;
	let active = true;
	return {
		sessionFile: resolved,
		backupFile,
		supportsCheckedReplacement,
		async rollback(rollbackOptions: SessionRewriteOptions = {}) {
			if (!active) return;
			const restore = `${resolved}.pi-rewind-restore-${randomUUID()}`;
			const observed = `${resolved}.pi-rewind-observed-${randomUUID()}`;
			try {
				await copyFile(backupFile, restore, constants.COPYFILE_EXCL);
				if (rollbackOptions.expectedCurrentDigest === undefined) {
					await rename(restore, resolved);
				} else {
					// As in the checked forward commit, keep validation and rename on
					// one event-loop turn. The observed hard link also catches a writer
					// that already opened the old inode before the rename.
					try {
						(rollbackOptions.linkCurrent ?? linkCurrent)(resolved, observed);
					} catch {
						throw new CheckedSessionRewriteUnsupportedError();
					}
					if (sessionBytesDigest(readFileSync(observed)) !== rollbackOptions.expectedCurrentDigest) {
						throw new SessionRewriteConflictError();
					}
					renameSync(restore, resolved);
					if (sessionBytesDigest(readFileSync(observed)) !== rollbackOptions.expectedCurrentDigest) {
						const preserve = `${resolved}.pi-rewind-conflict-${randomUUID()}`;
						copyFileSync(observed, preserve, constants.COPYFILE_EXCL);
						renameSync(preserve, resolved);
						throw new SessionRewriteConflictError();
					}
				}
				await rm(backupFile, { force: true });
				active = false;
			} finally {
				rmSync(restore, { force: true });
				rmSync(observed, { force: true });
			}
		},
		async discard() {
			if (!active) return;
			await rm(backupFile, { force: true });
			active = false;
		},
	};
}

export function isSessionSibling(sessionFile: string, candidate: string): boolean {
	return dirname(resolve(sessionFile)) === dirname(resolve(candidate));
}
