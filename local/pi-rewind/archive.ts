import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzip, gunzip } from "node:zlib";

const METADATA_FILE = "metadata.json";
const PAYLOAD_FILE = "session.jsonl.gz";
const METADATA_MAX_BYTES = 16 * 1024 * 1024;
const RECORD_NAME = /^rewind-(\d+)-([0-9a-f-]{36})-([0-9a-f]{64})$/;
const TEMP_NAME = /^\.tmp-rewind-(\d+)-([0-9a-f-]{36})$/;
const LOCK_DIRECTORY = ".retention.lock";
const LOCK_MARKER = /^(owner|claim)-(\d+)-([0-9a-f]{64})-([0-9a-f-]{36})$/;
const LOCK_CANDIDATE = /^\.lock-candidate-(\d+)-([0-9a-f]{64})-([0-9a-f-]{36})$/;
const LOCK_RESIDUE = /^\.(?:lock-release|stale-lock)-(\d+)-([0-9a-f-]{36})$/;
const LOCK_RETRY_MS = 10;
const LOCK_RELEASE_ATTEMPTS = 3;
const LOCK_TIMEOUT_MS = 30_000;
const ACTIVE_LOCK_TOKENS_KEY = Symbol.for("pi-rewind.active-archive-locks.v1");

interface ArchiveLockGlobals {
	[ACTIVE_LOCK_TOKENS_KEY]?: Set<string>;
}

function activeLockTokens(): Set<string> {
	const globals = globalThis as ArchiveLockGlobals;
	return globals[ACTIVE_LOCK_TOKENS_KEY] ??= new Set<string>();
}

export const REWIND_ARCHIVE_LIMITS = Object.freeze({
	maxAgeMs: 7 * 24 * 60 * 60 * 1000,
	maxEntries: 100,
	maxBytes: 500 * 1024 * 1024,
});

export interface RewindArchiveLimits {
	readonly maxAgeMs: number;
	readonly maxEntries: number;
	readonly maxBytes: number;
}

export interface RewindArchiveInput {
	readonly originalJsonl: string;
	readonly rewoundJsonl: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly originalDigest: string;
	readonly rewoundDigest: string;
	readonly originalLeafId: string;
	readonly logicalRetainedLeafId: string | null;
	readonly rewoundLeafId: string | null;
	readonly originalEditorText: string;
	readonly rewoundEditorText: string;
	readonly targetEntryId: string;
	readonly targetRole: "user" | "assistant";
	readonly targetText: string;
	readonly discardedDialogueCount: number;
	readonly discardedPreview: string;
}

interface RewindArchiveMetadataV1 {
	readonly version: 1;
	readonly id: string;
	readonly createdAt: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly originalDigest: string;
	readonly rewoundDigest: string;
	readonly originalLeafId: string;
	readonly logicalRetainedLeafId: string | null;
	readonly rewoundLeafId: string | null;
	readonly originalEditorText: string;
	readonly rewoundEditorText: string;
	readonly targetEntryId: string;
	readonly targetRole: "user" | "assistant";
	readonly targetPreview: string;
	readonly discardedDialogueCount: number;
	readonly discardedPreview: string;
	readonly originalBytes: number;
	readonly compressedBytes: number;
}

export interface RewindArchiveRecord extends RewindArchiveMetadataV1 {
	readonly recordDir: string;
	readonly archiveFile: string;
	/** Payload plus metadata bytes counted against the archive-wide limit. */
	readonly storedBytes: number;
}

export interface RewindArchiveResult {
	readonly record?: RewindArchiveRecord;
	readonly retained: boolean;
}

export interface RewindArchiveRemovalResult {
	readonly removedIds: readonly string[];
	readonly missingIds: readonly string[];
	readonly failures: readonly { id: string; message: string }[];
}

/** One `ps` read of a process start time; `undefined` means the read produced no identity. */
export type ProcessStartIdentityReader = (pid: number) => Promise<string | undefined>;

export interface RewindArchiveOptions {
	readonly limits?: Partial<RewindArchiveLimits>;
	readonly now?: () => number;
	/** One lock owner identity attempt; defaults to `/bin/ps`, replaced by tests. */
	readonly readProcessStartIdentity?: ProcessStartIdentityReader;
}

interface ParsedSession {
	readonly sessionId: string;
	readonly entries: Map<string, Record<string, unknown>>;
	readonly lastEntryId: string | null;
}

function preview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= 1000 ? normalized : `${normalized.slice(0, 999)}…`;
}

function finiteInteger(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function metadataIntegrityDigest(metadata: Omit<RewindArchiveMetadataV1, "id">): string {
	return digest(JSON.stringify(metadata));
}

function parseMetadata(value: unknown, expectedName: string): RewindArchiveMetadataV1 | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = value as Record<string, unknown>;
	const match = RECORD_NAME.exec(expectedName);
	if (
		!match
		|| data.version !== 1
		|| data.id !== expectedName
		|| !nonemptyString(data.createdAt)
		|| !Number.isFinite(Date.parse(data.createdAt))
		|| !nonemptyString(data.sessionId)
		|| !nonemptyString(data.sessionFile)
		|| !nonemptyString(data.originalDigest)
		|| !nonemptyString(data.rewoundDigest)
		|| !nonemptyString(data.originalLeafId)
		|| !(data.logicalRetainedLeafId === null || nonemptyString(data.logicalRetainedLeafId))
		|| !(data.rewoundLeafId === null || nonemptyString(data.rewoundLeafId))
		|| typeof data.originalEditorText !== "string"
		|| typeof data.rewoundEditorText !== "string"
		|| !nonemptyString(data.targetEntryId)
		|| (data.targetRole !== "user" && data.targetRole !== "assistant")
		|| typeof data.targetPreview !== "string"
		|| !finiteInteger(data.discardedDialogueCount)
		|| typeof data.discardedPreview !== "string"
		|| !finiteInteger(data.originalBytes)
		|| !finiteInteger(data.compressedBytes)
	) return undefined;
	const metadata = data as unknown as RewindArchiveMetadataV1;
	const { id: _id, ...integrityFields } = metadata;
	if (metadataIntegrityDigest(integrityFields) !== match[3]) return undefined;
	return metadata;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`Rewind archive root is not a private directory: ${directory}`);
	}
	await chmod(directory, 0o700);
}

class InvalidArchiveFileError extends Error {}

async function readPrivateFile(file: string, maxBytes: number): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > maxBytes) throw new InvalidArchiveFileError(`Invalid rewind archive file: ${file}`);
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

function gzipBuffer(input: string): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		gzip(input, { level: 6 }, (error, output) => {
			if (error) reject(error);
			else resolvePromise(output);
		});
	});
}

function gunzipBuffer(input: Buffer, maxOutputLength: number): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		gunzip(input, { maxOutputLength: Math.max(1, maxOutputLength) }, (error, output) => {
			if (error) reject(error);
			else resolvePromise(output);
		});
	});
}

function parseSession(jsonl: string): ParsedSession {
	const lines = jsonl.trimEnd().split("\n");
	if (lines.length === 0 || lines[0] === "") throw new Error("Archived rewind session is empty");
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(lines[0]!) as Record<string, unknown>;
	} catch {
		throw new Error("Archived rewind session header is invalid");
	}
	if (header.type !== "session" || !nonemptyString(header.id)) {
		throw new Error("Archived rewind session identity is invalid");
	}
	const entries = new Map<string, Record<string, unknown>>();
	let lastEntryId: string | null = null;
	for (const line of lines.slice(1)) {
		if (!line) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			throw new Error("Archived rewind session contains invalid JSONL");
		}
		if (typeof entry !== "object" || entry === null || !nonemptyString((entry as Record<string, unknown>).id)) {
			throw new Error("Archived rewind session contains an invalid entry");
		}
		const value = entry as Record<string, unknown> & { id: string };
		if (entries.has(value.id)) throw new Error("Archived rewind session contains duplicate entry IDs");
		entries.set(value.id, value);
		lastEntryId = value.id;
	}
	return { sessionId: header.id, entries, lastEntryId };
}

function pathFromLeaf(session: ParsedSession, leafId: string | null): Set<string> {
	const path = new Set<string>();
	let cursor = leafId;
	while (cursor !== null) {
		if (path.has(cursor)) throw new Error("Archived rewind session contains a parent cycle");
		path.add(cursor);
		const entry = session.entries.get(cursor);
		if (!entry) throw new Error("Archived rewind leaf path is incomplete");
		if (!(entry.parentId === null || nonemptyString(entry.parentId))) {
			throw new Error("Archived rewind session contains an invalid parent ID");
		}
		cursor = entry.parentId;
	}
	return path;
}

function validateArchiveInput(input: RewindArchiveInput): void {
	if (digest(input.originalJsonl) !== input.originalDigest || digest(input.rewoundJsonl) !== input.rewoundDigest) {
		throw new Error("The rewind snapshot digest does not match its archive metadata");
	}
	const original = parseSession(input.originalJsonl);
	const rewound = parseSession(input.rewoundJsonl);
	if (original.sessionId !== input.sessionId || rewound.sessionId !== input.sessionId) {
		throw new Error("Archived rewind session identity does not match its metadata");
	}
	const originalPath = pathFromLeaf(original, input.originalLeafId);
	if (!originalPath.has(input.targetEntryId)) {
		throw new Error("Archived rewind target is not on the original active path");
	}
	const target = original.entries.get(input.targetEntryId);
	if (target?.type !== "message") throw new Error("Archived rewind target message is absent from the session");
	const message = target.message;
	if (typeof message !== "object" || message === null || (message as Record<string, unknown>).role !== input.targetRole) {
		throw new Error("Archived rewind target role does not match the session");
	}
	const expectedLogicalLeaf = input.targetRole === "assistant" ? input.targetEntryId : target.parentId;
	if (expectedLogicalLeaf !== input.logicalRetainedLeafId) {
		throw new Error("Archived rewind logical target does not match the session");
	}
	if (rewound.lastEntryId !== input.rewoundLeafId) {
		throw new Error("Archived rewind physical leaf does not match the rewound session");
	}
	if (!pathFromLeaf(rewound, input.rewoundLeafId).has(input.logicalRetainedLeafId ?? "")) {
		if (input.logicalRetainedLeafId !== null) {
			throw new Error("Archived rewind physical leaf does not descend from its logical target");
		}
	}
}

function validateArchivedSession(jsonl: string, record: RewindArchiveRecord): void {
	const original = parseSession(jsonl);
	if (original.sessionId !== record.sessionId) {
		throw new Error("Archived rewind session identity does not match its metadata");
	}
	const originalPath = pathFromLeaf(original, record.originalLeafId);
	if (!originalPath.has(record.targetEntryId)) {
		throw new Error("Archived rewind target is not on the original active path");
	}
	const target = original.entries.get(record.targetEntryId);
	if (target?.type !== "message") throw new Error("Archived rewind target message is absent from the session");
	const message = target.message;
	if (typeof message !== "object" || message === null || (message as Record<string, unknown>).role !== record.targetRole) {
		throw new Error("Archived rewind target role does not match the session");
	}
	const expectedLogicalLeaf = record.targetRole === "assistant" ? record.targetEntryId : target.parentId;
	if (expectedLogicalLeaf !== record.logicalRetainedLeafId) {
		throw new Error("Archived rewind logical target does not match the session");
	}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// `ps -p <pid> -o lstart=` answers in a few milliseconds on an idle machine, but
// spawning and running it can take over a second when the machine is loaded, and
// a 1s budget turned that load into a failed archive operation. 5s keeps roughly
// two orders of magnitude of headroom for scheduler and process-table pressure
// while still bounding one read; the retry below caps an acquisition at about
// 10s, well under LOCK_TIMEOUT_MS, so a stalled `ps` cannot eat the whole wait.
const PROCESS_START_IDENTITY_TIMEOUT_MS = 5_000;
// A stalled or refused spawn is usually transient (load spike, no free process
// slot), so one short-delay retry recovers it. Both attempts failing still
// reports an unknown owner identity, so nothing skips the identity check.
const PROCESS_START_IDENTITY_ATTEMPTS = 2;
const PROCESS_START_IDENTITY_RETRY_MS = 100;

function readProcessStartIdentityWithPs(pid: number): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		try {
			execFile(
				"/bin/ps",
				["-p", String(pid), "-o", "lstart="],
				{ encoding: "utf8", timeout: PROCESS_START_IDENTITY_TIMEOUT_MS, maxBuffer: 4_096 },
				(error, stdout) => resolvePromise(error ? undefined : stdout.trim() || undefined),
			);
		} catch {
			// `execFile` throws synchronously when the spawn itself is refused
			// (e.g. EPERM): an unread identity, not a crash.
			resolvePromise(undefined);
		}
	});
}

async function processStartIdentity(
	read: ProcessStartIdentityReader,
	pid: number,
): Promise<string | undefined> {
	for (let attempt = 1; attempt <= PROCESS_START_IDENTITY_ATTEMPTS; attempt += 1) {
		let identity: string | undefined;
		try {
			identity = await read(pid);
		} catch {
			identity = undefined;
		}
		if (identity) return identity;
		if (attempt < PROCESS_START_IDENTITY_ATTEMPTS) await delay(PROCESS_START_IDENTITY_RETRY_MS);
	}
	return undefined;
}

// A process start time never changes, so the first successful read of this
// process is reused for every later lock. The cache is keyed by reader so an
// injected test reader cannot leak a fake identity into archives that use `ps`.
// Failures are not cached: a later operation may find `ps` responsive again.
const ownProcessStartIdentities = new WeakMap<ProcessStartIdentityReader, Promise<string | undefined>>();

function ownProcessStartIdentity(read: ProcessStartIdentityReader): Promise<string | undefined> {
	const cached = ownProcessStartIdentities.get(read);
	if (cached) return cached;
	const pending = processStartIdentity(read, process.pid).then((identity) => {
		if (identity === undefined) ownProcessStartIdentities.delete(read);
		return identity;
	});
	ownProcessStartIdentities.set(read, pending);
	return pending;
}

async function processMatches(
	read: ProcessStartIdentityReader,
	pid: number,
	expectedDigest: string,
	token?: string,
): Promise<boolean> {
	if (!processIsAlive(pid)) return false;
	if (pid === process.pid && token !== undefined) return activeLockTokens().has(token);
	const observed = await processStartIdentity(read, pid);
	return observed === undefined || digest(observed) === expectedDigest;
}

export class RewindArchive {
	readonly root: string;
	readonly limits: RewindArchiveLimits;
	readonly now: () => number;
	private readonly readProcessStartIdentity: ProcessStartIdentityReader;

	constructor(root: string, options: RewindArchiveOptions = {}) {
		this.root = resolve(root);
		this.limits = { ...REWIND_ARCHIVE_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.readProcessStartIdentity = options.readProcessStartIdentity ?? readProcessStartIdentityWithPs;
		if (
			!finiteInteger(this.limits.maxAgeMs, 1)
			|| !finiteInteger(this.limits.maxEntries, 1)
			|| !finiteInteger(this.limits.maxBytes, 1)
		) throw new Error("Invalid rewind archive limits");
	}

	async create(input: RewindArchiveInput): Promise<RewindArchiveResult> {
		await ensurePrivateDirectory(this.root);
		validateArchiveInput(input);
		const compressed = await gzipBuffer(input.originalJsonl);
		const createdAtMs = this.now();
		const nonce = randomUUID();
		const originalBytes = Buffer.byteLength(input.originalJsonl, "utf8");
		const integrityFields = {
			version: 1,
			createdAt: new Date(createdAtMs).toISOString(),
			sessionId: input.sessionId,
			sessionFile: resolve(input.sessionFile),
			originalDigest: input.originalDigest,
			rewoundDigest: input.rewoundDigest,
			originalLeafId: input.originalLeafId,
			logicalRetainedLeafId: input.logicalRetainedLeafId,
			rewoundLeafId: input.rewoundLeafId,
			originalEditorText: input.originalEditorText,
			rewoundEditorText: input.rewoundEditorText,
			targetEntryId: input.targetEntryId,
			targetRole: input.targetRole,
			targetPreview: preview(input.targetText),
			discardedDialogueCount: input.discardedDialogueCount,
			discardedPreview: preview(input.discardedPreview),
			originalBytes,
			compressedBytes: compressed.byteLength,
		} satisfies Omit<RewindArchiveMetadataV1, "id">;
		const id = `rewind-${createdAtMs}-${nonce}-${metadataIntegrityDigest(integrityFields)}`;
		const metadata = { id, ...integrityFields } satisfies RewindArchiveMetadataV1;
		const metadataBytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
		const storedBytes = compressed.byteLength + metadataBytes.byteLength;
		if (metadataBytes.byteLength > METADATA_MAX_BYTES || storedBytes > this.limits.maxBytes) {
			return { retained: false };
		}

		return this.withLock(async () => {
			await this.prune(1, storedBytes);
			const temporaryDir = join(this.root, `.tmp-rewind-${process.pid}-${nonce}`);
			const recordDir = join(this.root, id);
			await mkdir(temporaryDir, { mode: 0o700 });
			try {
				await this.writePrivateFile(join(temporaryDir, PAYLOAD_FILE), compressed);
				await this.writePrivateFile(join(temporaryDir, METADATA_FILE), metadataBytes);
				await rename(temporaryDir, recordDir);
				return {
					record: { ...metadata, recordDir, archiveFile: join(recordDir, PAYLOAD_FILE), storedBytes },
					retained: true,
				};
			} catch (error) {
				await rm(temporaryDir, { recursive: true, force: true });
				throw error;
			}
		});
	}

	async list(): Promise<RewindArchiveRecord[]> {
		await ensurePrivateDirectory(this.root);
		return this.withLock(() => this.prune());
	}

	async read(record: RewindArchiveRecord): Promise<string> {
		const compressed = await readPrivateFile(record.archiveFile, record.compressedBytes);
		const original = await gunzipBuffer(compressed, record.originalBytes);
		if (original.byteLength !== record.originalBytes || digest(original) !== record.originalDigest) {
			throw new Error(`Rewind archive verification failed: ${record.archiveFile}`);
		}
		const jsonl = original.toString("utf8");
		validateArchivedSession(jsonl, record);
		return jsonl;
	}

	async remove(record: RewindArchiveRecord): Promise<void> {
		const result = await this.removeMany([record.id]);
		if (result.failures.length > 0) {
			throw new Error(result.failures[0]!.message);
		}
	}

	async removeMany(ids: readonly string[]): Promise<RewindArchiveRemovalResult> {
		await ensurePrivateDirectory(this.root);
		const requested = [...new Set(ids)];
		return this.withLock(async () => {
			const available = new Map((await this.scan()).map((record) => [record.id, record]));
			const removedIds: string[] = [];
			const missingIds: string[] = [];
			const failures: Array<{ id: string; message: string }> = [];
			for (const id of requested) {
				const record = available.get(id);
				if (!record) {
					missingIds.push(id);
					continue;
				}
				try {
					await rm(record.recordDir, { recursive: true, force: true });
					removedIds.push(id);
				} catch (error) {
					failures.push({
						id,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return { removedIds, missingIds, failures };
		});
	}

	private async writePrivateFile(file: string, bytes: Uint8Array): Promise<void> {
		const handle = await open(file, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async withLock<T>(action: () => Promise<T>): Promise<T> {
		const lockDir = join(this.root, LOCK_DIRECTORY);
		const token = randomUUID();
		const startIdentity = await ownProcessStartIdentity(this.readProcessStartIdentity);
		if (!startIdentity) throw new Error("Could not determine rewind archive lock owner identity");
		const startDigest = digest(startIdentity);
		const ownerName = `owner-${process.pid}-${startDigest}-${token}`;
		const candidateDir = join(this.root, `.lock-candidate-${process.pid}-${startDigest}-${token}`);
		await mkdir(candidateDir, { mode: 0o700 });
		activeLockTokens().add(token);
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		let acquired = false;
		try {
			await this.writePrivateFile(join(candidateDir, ownerName), new Uint8Array());
			while (!acquired) {
				try {
					await rename(candidateDir, lockDir);
					acquired = true;
					break;
				} catch (error) {
					if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				}
				await this.reclaimDeadLock(lockDir, token);
				if (Date.now() >= deadline) throw new Error("Timed out waiting for rewind archive lock");
				await delay(LOCK_RETRY_MS);
			}
			await this.removeAbandonedWork();
			let value: T | undefined;
			let operationError: unknown;
			try {
				value = await action();
			} catch (error) {
				operationError = error;
			}
			let releaseError: unknown;
			try {
				await this.releaseLock(lockDir, ownerName, token);
				acquired = false;
			} catch (error) {
				releaseError = error;
			}
			if (operationError !== undefined && releaseError !== undefined) {
				throw new AggregateError([operationError, releaseError], "Rewind archive operation and lock release both failed");
			}
			if (operationError !== undefined) throw operationError;
			if (releaseError !== undefined) throw releaseError;
			return value as T;
		} finally {
			activeLockTokens().delete(token);
			if (!acquired) await rm(candidateDir, { recursive: true, force: true });
		}
	}

	private async releaseLock(lockDir: string, ownerName: string, token: string): Promise<void> {
		const marker = LOCK_MARKER.exec(ownerName);
		if (!marker) throw new Error("Rewind archive owner marker is invalid");
		const releaseName = `claim-${marker[2]}-${marker[3]}-${token}`;
		let lastError: unknown;
		for (let attempt = 0; attempt < LOCK_RELEASE_ATTEMPTS; attempt += 1) {
			try {
				try {
					await rename(join(lockDir, ownerName), join(lockDir, releaseName));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					let entries: string[];
					try {
						entries = await readdir(lockDir);
					} catch (readError) {
						if ((readError as NodeJS.ErrnoException).code === "ENOENT") return;
						throw readError;
					}
					if (entries.length !== 1 || entries[0] !== releaseName) {
						throw new Error("Rewind archive lock ownership changed during release");
					}
				}
				const releaseDir = join(this.root, `.lock-release-${process.pid}-${token}`);
				try {
					await rename(lockDir, releaseDir);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				await rm(releaseDir, { recursive: true, force: true });
				return;
			} catch (error) {
				lastError = error;
				if (attempt + 1 < LOCK_RELEASE_ATTEMPTS) await delay(LOCK_RETRY_MS);
			}
		}
		throw new Error("Could not release rewind archive lock", { cause: lastError });
	}

	private async reclaimDeadLock(lockDir: string, token: string): Promise<void> {
		let allEntries: string[];
		try {
			const lockInfo = await lstat(lockDir);
			if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) {
				throw new Error("Rewind archive lock is not a private directory");
			}
			allEntries = await readdir(lockDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const markers = allEntries.filter((name) => LOCK_MARKER.test(name));
		if (markers.length !== 1 || allEntries.length !== 1) {
			throw new Error("Rewind archive lock is malformed");
		}
		const marker = markers[0]!;
		const match = LOCK_MARKER.exec(marker)!;
		const ownerPid = Number.parseInt(match[2]!, 10);
		const ownerStartDigest = match[3]!;
		// An active owner or claimant keeps exclusive ownership. A dead claimant
		// can be claimed again, so crashes remain recoverable without a stale timer.
		if (await processMatches(this.readProcessStartIdentity, ownerPid, ownerStartDigest, match[4]!)) return;
		const startIdentity = await ownProcessStartIdentity(this.readProcessStartIdentity);
		if (!startIdentity) return;
		const startDigest = digest(startIdentity);
		const claimName = `claim-${process.pid}-${startDigest}-${token}`;
		try {
			await rename(join(lockDir, marker), join(lockDir, claimName));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		await this.quarantineLock(lockDir, token);
	}

	private async quarantineLock(lockDir: string, token: string): Promise<void> {
		const quarantine = join(this.root, `.stale-lock-${process.pid}-${token}`);
		try {
			await rename(lockDir, quarantine);
			await rm(quarantine, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async removeAbandonedWork(): Promise<void> {
		const entries = await readdir(this.root, { withFileTypes: true });
		const abandoned: string[] = [];
		for (const entry of entries) {
			const candidate = LOCK_CANDIDATE.exec(entry.name);
			if (TEMP_NAME.test(entry.name) || LOCK_RESIDUE.test(entry.name)) {
				abandoned.push(join(this.root, entry.name));
			} else if (
				candidate
				&& !await processMatches(
					this.readProcessStartIdentity,
					Number.parseInt(candidate[1]!, 10),
					candidate[2]!,
					candidate[3]!,
				)
			) {
				abandoned.push(join(this.root, entry.name));
			}
		}
		await this.removePaths(abandoned);
	}

	private async scan(): Promise<RewindArchiveRecord[]> {
		const entries = await readdir(this.root, { withFileTypes: true });
		const records: RewindArchiveRecord[] = [];
		const invalidRecordDirs: string[] = [];
		for (const entry of entries) {
			if (!RECORD_NAME.test(entry.name)) continue;
			const recordDir = join(this.root, entry.name);
			try {
				const directoryInfo = await lstat(recordDir);
				if (!entry.isDirectory() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
					invalidRecordDirs.push(recordDir);
					continue;
				}
				const metadataFile = join(recordDir, METADATA_FILE);
				const metadataBytes = await readPrivateFile(metadataFile, METADATA_MAX_BYTES);
				const metadata = parseMetadata(JSON.parse(metadataBytes.toString("utf8")), entry.name);
				if (!metadata) {
					invalidRecordDirs.push(recordDir);
					continue;
				}
				const archiveFile = join(recordDir, PAYLOAD_FILE);
				const archiveInfo = await lstat(archiveFile);
				if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size !== metadata.compressedBytes) {
					invalidRecordDirs.push(recordDir);
					continue;
				}
				records.push({
					...metadata,
					recordDir,
					archiveFile,
					storedBytes: archiveInfo.size + metadataBytes.byteLength,
				});
			} catch (error) {
				if (
					!(error instanceof InvalidArchiveFileError)
					&& !(error instanceof SyntaxError)
					&& !["ENOENT", "ENOTDIR", "ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
				) throw error;
				invalidRecordDirs.push(recordDir);
			}
		}
		await this.removePaths(invalidRecordDirs);
		return records.sort((a, b) =>
			Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
		);
	}

	private async removePaths(paths: readonly string[]): Promise<void> {
		const failures: unknown[] = [];
		for (const path of paths) {
			try {
				await rm(path, { recursive: true, force: true });
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Could not enforce rewind archive retention");
	}

	private async prune(reservedEntries = 0, reservedBytes = 0): Promise<RewindArchiveRecord[]> {
		const records = await this.scan();
		const cutoff = this.now() - this.limits.maxAgeMs;
		const retained: RewindArchiveRecord[] = [];
		const removed: RewindArchiveRecord[] = [];
		let storedBytes = reservedBytes;
		for (const record of records) {
			if (
				Date.parse(record.createdAt) < cutoff
				|| retained.length + reservedEntries >= this.limits.maxEntries
				|| storedBytes + record.storedBytes > this.limits.maxBytes
			) {
				removed.push(record);
				continue;
			}
			retained.push(record);
			storedBytes += record.storedBytes;
		}
		await this.removePaths(removed.map((record) => record.recordDir));
		return retained;
	}
}
