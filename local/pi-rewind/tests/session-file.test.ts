import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { RewindArchive } from "../archive.ts";
import { reloadPrunedSessionFile } from "../index.ts";
import {
	buildPrunedJsonl,
	CheckedSessionRewriteUnsupportedError,
	readSessionSnapshot,
	sessionBytesDigest,
	SessionRewriteConflictError,
	stageSessionRewrite,
} from "../session-file.ts";

const header = { type: "session", version: 3, id: "session-id", timestamp: "x", cwd: "/tmp" } as SessionHeader;
const user = { type: "message", id: "u", parentId: null, timestamp: "x", message: { role: "user", content: "hello", timestamp: 1 } } as SessionEntry;
const assistant = { type: "message", id: "a", parentId: "u", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 2 } } as SessionEntry;
const name = { type: "session_info", id: "name", parentId: "a", timestamp: "x", name: "Named session" } as SessionEntry;
const abandoned = { type: "message", id: "old", parentId: "a", timestamp: "x", message: { role: "user", content: "discard", timestamp: 3 } } as SessionEntry;

test("pruned JSONL keeps identity, selected path and display name", () => {
	const lines = buildPrunedJsonl(header, [user], [user, assistant, name, abandoned])
		.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines[0].id, "session-id");
	assert.deepEqual(lines.slice(1).map((entry) => entry.id), ["u", "name"]);
	assert.equal(lines[2].parentId, "u");
});

test("the live session manager is rebound to rewritten bytes", () => {
	const calls: string[] = [];
	reloadPrunedSessionFile({ setSessionFile: (file) => calls.push(file) }, "/tmp/session.jsonl");
	assert.deepEqual(calls, ["/tmp/session.jsonl"]);
});

test("a Pi build without the rebind seam fails closed instead of drifting", () => {
	assert.throws(
		() => reloadPrunedSessionFile({} as never, "/tmp/session.jsonl"),
		/setSessionFile/,
	);
});

test("staged rewrite is atomic and rollback restores the original bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
	try {
		const file = join(dir, "session.jsonl");
		await writeFile(file, "original\n", "utf8");
		const rewrite = await stageSessionRewrite(file, "pruned\n");
		assert.equal(await readFile(file, "utf8"), "pruned\n");
		assert.equal(await readFile(rewrite.backupFile, "utf8"), "original\n");
		await rewrite.rollback();
		assert.equal(await readFile(file, "utf8"), "original\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("session snapshots use stable bytes and refuse symlinks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
	try {
		const file = join(dir, "session.jsonl");
		const alias = join(dir, "alias.jsonl");
		await writeFile(file, "one\ntwo\n", "utf8");
		await symlink(file, alias);
		assert.equal(await readSessionSnapshot(file), "one\ntwo\n");
		assert.equal(sessionBytesDigest("one\ntwo\n"), sessionBytesDigest(await readSessionSnapshot(file)));
		await assert.rejects(() => readSessionSnapshot(alias));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a checked rewrite preserves an append that races after validation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
	try {
		const file = join(dir, "session.jsonl");
		const original = "original\n";
		await writeFile(file, original, "utf8");
		// Match undoRewind's outer validation, then change the file while the
		// checked commit is preparing its temporary replacement.
		const validatedDigest = sessionBytesDigest(await readSessionSnapshot(file));
		const rewrite = stageSessionRewrite(file, "restored\n", {
			expectedCurrentDigest: validatedDigest,
		});
		appendFileSync(file, "later-entry\n", "utf8");
		await assert.rejects(rewrite, SessionRewriteConflictError);
		assert.equal(await readFile(file, "utf8"), "original\nlater-entry\n");
		assert.deepEqual((await readdir(dir)).sort(), ["session.jsonl"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ordinary rewrite preserves concurrent appends with linked and copied backups", async () => {
	for (const copied of [false, true]) {
		const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
		try {
			const file = join(dir, "session.jsonl");
			await writeFile(file, "original\n", "utf8");
			const rewrite = stageSessionRewrite(file, "pruned\n", copied ? {
				linkCurrent: () => { throw new Error("hard links unavailable"); },
			} : {});
			appendFileSync(file, "later-entry\n", "utf8");
			await assert.rejects(rewrite, SessionRewriteConflictError);
			assert.equal(await readFile(file, "utf8"), "original\nlater-entry\n");
			assert.deepEqual(await readdir(dir), ["session.jsonl"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("hard-link failure keeps ordinary rewind but disables checked replacement", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
	const unsupported = (): never => { throw new Error("hard links unavailable"); };
	try {
		const file = join(dir, "session.jsonl");
		await writeFile(file, "original\n", "utf8");
		const rewrite = await stageSessionRewrite(file, "rewound\n", { linkCurrent: unsupported });
		assert.equal(rewrite.supportsCheckedReplacement, false);
		assert.equal(await readFile(file, "utf8"), "rewound\n");
		await assert.rejects(
			() => rewrite.rollback({
				expectedCurrentDigest: sessionBytesDigest("rewound\n"),
				linkCurrent: unsupported,
			}),
			CheckedSessionRewriteUnsupportedError,
		);
		assert.equal(await readFile(file, "utf8"), "rewound\n");

		await assert.rejects(
			() => stageSessionRewrite(file, "restored\n", {
				expectedCurrentDigest: sessionBytesDigest("rewound\n"),
				linkCurrent: unsupported,
			}),
			CheckedSessionRewriteUnsupportedError,
		);
		assert.equal(await readFile(file, "utf8"), "rewound\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the backup shares the original bytes instead of re-reading a large file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
	try {
		const file = join(dir, "session.jsonl");
		await writeFile(file, "original\n", "utf8");
		const before = await stat(file);
		const rewrite = await stageSessionRewrite(file, "pruned\n");
		assert.equal(rewrite.supportsCheckedReplacement, true);
		const backup = await stat(rewrite.backupFile);
		assert.equal(backup.ino, before.ino, "the backup keeps the original inode");
		assert.notEqual((await stat(file)).ino, before.ino, "the live path holds the new bytes");
		assert.equal(await readFile(rewrite.backupFile, "utf8"), "original\n");
		await rewrite.discard();
		await rewrite.discard();
		await assert.rejects(() => stat(rewrite.backupFile));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// Pi 1.2 history must survive destructive rewrites without losing model projection metadata.
test("prune, archive and restore preserve system, usage, context edits and nested calls", async () => {
	const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const entries: SessionEntry[] = [
		{ type: "message", id: "sys", parentId: null, timestamp: "x", message: {
			role: "system", content: "base prompt", sections: { guidance: "instructions" },
			toolsAdded: [{ name: "read", description: "Read a file", parameters: {} }], timestamp: 1,
		} },
		{ ...user, parentId: "sys" },
		{ type: "context_edit", id: "edit", parentId: "u", timestamp: "x",
			targetId: "u", replacement: { content: "edited prompt" } },
		{ type: "usage", id: "usage", parentId: "edit", timestamp: "x",
			kind: "cache_warm", provider: "faux", model: "faux", usage, note: "cache notice" },
		{ type: "message", id: "nested", parentId: "usage", timestamp: "x", message: {
			role: "toolResult", toolCallId: "outer", toolName: "codemode", content: [{ type: "text", text: "ok" }],
			isError: false, timestamp: 2, nestedCalls: { complete: true,
				calls: [{ id: "inner", name: "read", arguments: { path: "test.txt" }, status: "ok" }] },
		} },
		{ type: "message", id: "answer", parentId: "nested", timestamp: "x", message: {
			role: "assistant", content: [{ type: "text", text: "done" }], api: "faux", provider: "faux",
			model: "faux", usage, stopReason: "stop", timestamp: 3,
		} },
		{ ...abandoned, parentId: "answer" },
	];
	const original = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	const pruned = buildPrunedJsonl(header, entries.slice(0, -1), entries);
	assert.deepEqual(pruned.trim().split("\n").map((line) => JSON.parse(line)), [header, ...entries.slice(0, -1)]);
	const retainedIds = new Set(entries.slice(0, -1).map(({ id }) => id));
	for (const entry of entries.slice(0, -1)) {
		if (entry.type === "context_edit") assert.ok(retainedIds.has(entry.targetId));
	}
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-1.2-"));
	try {
		const file = join(dir, "session.jsonl");
		await writeFile(file, original);
		const rewrite = await stageSessionRewrite(file, pruned);
		const archive = new RewindArchive(join(dir, "archive"));
		const archived = await archive.create({
			originalJsonl: await readFile(rewrite.backupFile, "utf8"), rewoundJsonl: pruned,
			sessionId: header.id, sessionFile: file, originalDigest: sessionBytesDigest(original),
			rewoundDigest: sessionBytesDigest(pruned), originalLeafId: "old",
			logicalRetainedLeafId: "answer", rewoundLeafId: "answer", originalEditorText: "", rewoundEditorText: "",
			targetEntryId: "answer", targetRole: "assistant", targetText: "done", discardedDialogueCount: 1, discardedPreview: "discard",
		});
		assert.ok(archived.record);
		assert.equal(await archive.read(archived.record), original);
		await rewrite.discard();
		// The durable undo path restores those original bytes with a checked rewrite.
		const restore = await stageSessionRewrite(file, await archive.read(archived.record), {
			expectedCurrentDigest: sessionBytesDigest(pruned),
		});
		assert.equal(await readFile(file, "utf8"), original);
		await restore.discard();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
