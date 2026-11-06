import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { RewindArchive } from "../archive.ts";
import { sessionBytesDigest } from "../session-file.ts";

function sessionHeader(suffix: string): Record<string, unknown> {
	return { type: "session", version: 3, id: `session-${suffix}`, timestamp: "t0", cwd: "/tmp" };
}

function targetMessage(suffix: string, body = "answer"): Record<string, unknown> {
	return { type: "message", id: `target-${suffix}`, parentId: null, timestamp: "t1", message: { role: "assistant", content: [{ type: "text", text: body }], stopReason: "stop", timestamp: 1 } };
}

function sessionText(suffix: string, body = "answer"): string {
	return [
		JSON.stringify(sessionHeader(suffix)),
		JSON.stringify(targetMessage(suffix, body)),
		JSON.stringify({ type: "custom", id: `leaf-${suffix}`, parentId: `target-${suffix}`, timestamp: "t2", customType: "marker", data: {} }),
	].join("\n") + "\n";
}

function input(_sourceFile: string, text: string, suffix: string) {
	const rewoundJsonl = [
		JSON.stringify(sessionHeader(suffix)),
		JSON.stringify(targetMessage(suffix)),
	].join("\n") + "\n";
	return {
		originalJsonl: text,
		rewoundJsonl,
		sessionId: `session-${suffix}`,
		sessionFile: `/sessions/${suffix}.jsonl`,
		originalDigest: sessionBytesDigest(text),
		rewoundDigest: sessionBytesDigest(rewoundJsonl),
		originalLeafId: `leaf-${suffix}`,
		logicalRetainedLeafId: `target-${suffix}`,
		rewoundLeafId: `target-${suffix}`,
		originalEditorText: "",
		rewoundEditorText: "",
		targetEntryId: `target-${suffix}`,
		targetRole: "assistant" as const,
		targetText: `answer ${suffix}`,
		discardedDialogueCount: 2,
		discardedPreview: `discarded ${suffix}`,
	};
}

test("archive stores verified gzip payload and metadata", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-archive-"));
	try {
		const source = join(dir, "source.jsonl");
		const text = sessionText("one", "repeated session text ".repeat(10_000));
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(join(dir, "archive"));
		const result = await archive.create(input(source, text, "one"));
		assert.equal(result.retained, true);
		assert.ok(result.record);
		assert.ok(result.record.compressedBytes < result.record.originalBytes);
		assert.deepEqual([...await readFile(result.record.archiveFile)].slice(0, 2), [0x1f, 0x8b]);
		assert.equal(await archive.read(result.record), text);
		assert.equal((await archive.list())[0]?.discardedPreview, "discarded one");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive removes multiple records under one locked fresh scan", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-remove-many-"));
	let now = 1_800_000_000_000;
	try {
		const source = join(dir, "source.jsonl");
		const archive = new RewindArchive(join(dir, "archive"), { now: () => now });
		const textOne = sessionText("one");
		await writeFile(source, textOne, "utf8");
		const one = (await archive.create(input(source, textOne, "one"))).record!;
		now += 1;
		const textTwo = sessionText("two");
		const two = (await archive.create(input(source, textTwo, "two"))).record!;
		now += 1;
		const textThree = sessionText("three");
		const three = (await archive.create(input(source, textThree, "three"))).record!;

		const removal = await archive.removeMany([one.id, three.id, one.id, "rewind-missing"]);
		assert.deepEqual(removal.removedIds, [one.id, three.id]);
		assert.deepEqual(removal.missingIds, ["rewind-missing"]);
		assert.deepEqual(removal.failures, []);
		assert.deepEqual((await archive.list()).map(({ id }) => id), [two.id]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive prunes by age and entry count", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-retention-"));
	let now = 1_800_000_000_000;
	try {
		const source = join(dir, "source.jsonl");
		const text = sessionText("one");
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(join(dir, "archive"), {
			now: () => now,
			limits: { maxAgeMs: 1_000, maxEntries: 2, maxBytes: 1024 * 1024 },
		});
		await archive.create(input(source, text, "one"));
		now += 100;
		const textTwo = sessionText("two");
		await archive.create(input(source, textTwo, "two"));
		now += 100;
		const textThree = sessionText("three");
		await archive.create(input(source, textThree, "three"));
		assert.deepEqual((await archive.list()).map((record) => record.sessionId), ["session-three", "session-two"]);
		now += 1_001;
		assert.deepEqual(await archive.list(), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive drops records that would exceed the compressed byte budget", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-budget-"));
	try {
		const source = join(dir, "source.jsonl");
		const text = sessionText("large", Array.from({ length: 4096 }, (_, index) => `${index}-${Math.random()}`).join("\n"));
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(join(dir, "archive"), {
			limits: { maxAgeMs: 10_000, maxEntries: 100, maxBytes: 1 },
		});
		const result = await archive.create(input(source, text, "large"));
		assert.equal(result.retained, false);
		assert.equal(result.record, undefined);
		assert.deepEqual(await archive.list(), []);
		assert.deepEqual((await readdir(join(dir, "archive"))).filter((name) => !name.startsWith(".tmp-")), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("concurrent archive writers converge retention after atomic publish", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-concurrent-"));
	try {
		const root = join(dir, "archive");
		const source = join(dir, "source.jsonl");
		const textOne = sessionText("one", "concurrent archive data ".repeat(10_000));
		const textTwo = sessionText("two", "concurrent archive data ".repeat(10_000));
		await writeFile(source, textOne, "utf8");
		const limits = { maxAgeMs: 10_000, maxEntries: 1, maxBytes: 1024 * 1024 };
		const first = new RewindArchive(root, { limits });
		const second = new RewindArchive(root, { limits });
		await Promise.all([
			first.create(input(source, textOne, "one")),
			second.create(input(source, textTwo, "two")),
		]);
		assert.equal((await first.list()).length, 1);
		assert.equal((await readdir(root)).some((name) => name.startsWith(".tmp-rewind-")), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive rejects metadata changes that are not bound to the record name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-metadata-integrity-"));
	try {
		const root = join(dir, "archive");
		const source = join(dir, "source.jsonl");
		const text = sessionText("bound");
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(root);
		const result = await archive.create(input(source, text, "bound"));
		assert.ok(result.record);
		const metadataFile = join(result.record.recordDir, "metadata.json");
		const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
		metadata.originalLeafId = "target-bound";
		await writeFile(metadataFile, `${JSON.stringify(metadata)}\n`, "utf8");
		assert.deepEqual(await archive.list(), []);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive preserves records when metadata is temporarily unreadable", {
	skip: process.platform === "win32" || process.getuid?.() === 0
		? "requires non-root POSIX file permissions"
		: false,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-unreadable-"));
	try {
		const root = join(dir, "archive");
		const source = join(dir, "source.jsonl");
		const text = sessionText("unreadable");
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(root);
		const result = await archive.create(input(source, text, "unreadable"));
		assert.ok(result.record);
		const metadataFile = join(result.record.recordDir, "metadata.json");
		const metadataBytes = await readFile(metadataFile);
		const payloadBytes = await readFile(result.record.archiveFile);
		await chmod(metadataFile, 0o000);
		await assert.rejects(archive.list(), (error: NodeJS.ErrnoException) =>
			error.code === "EACCES" || error.code === "EPERM",
		);
		assert.deepEqual(await readdir(root), [result.record.id]);
		assert.deepEqual(await readFile(result.record.archiveFile), payloadBytes);
		await chmod(metadataFile, 0o600);
		assert.deepEqual(await readFile(metadataFile), metadataBytes);
		assert.equal(await archive.read(result.record), text);
		assert.deepEqual((await archive.list()).map(({ id }) => id), [result.record.id]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive accepts retained session_info as the physical rewind leaf", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-session-info-"));
	try {
		const source = join(dir, "source.jsonl");
		const text = [
			JSON.stringify({ type: "session", version: 3, id: "session-info", timestamp: "t0", cwd: "/tmp" }),
			JSON.stringify({ type: "message", id: "target-info", parentId: null, timestamp: "t1", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop", timestamp: 1 } }),
			JSON.stringify({ type: "message", id: "later", parentId: "target-info", timestamp: "t2", message: { role: "user", content: [{ type: "text", text: "later" }], timestamp: 2 } }),
			JSON.stringify({ type: "session_info", id: "name-info", parentId: "later", timestamp: "t3", name: "Latest name" }),
		].join("\n") + "\n";
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(join(dir, "archive"));
		const rewoundJsonl = [
			JSON.stringify({ type: "session", version: 3, id: "session-info", timestamp: "t0", cwd: "/tmp" }),
			JSON.stringify({ type: "message", id: "target-info", parentId: null, timestamp: "t1", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop", timestamp: 1 } }),
			JSON.stringify({ type: "session_info", id: "name-info", parentId: "target-info", timestamp: "t3", name: "Latest name" }),
		].join("\n") + "\n";
		const result = await archive.create({
			...input(source, text, "info"),
			rewoundJsonl,
			rewoundDigest: sessionBytesDigest(rewoundJsonl),
			originalLeafId: "name-info",
			logicalRetainedLeafId: "target-info",
			rewoundLeafId: "name-info",
		});
		assert.ok(result.record);
		assert.equal(await archive.read(result.record), text);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive accepts session_tree state appended after the logical target", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-tree-state-"));
	try {
		const source = join(dir, "source.jsonl");
		const text = sessionText("tree-state");
		const rewoundJsonl = [
			JSON.stringify(sessionHeader("tree-state")),
			JSON.stringify(targetMessage("tree-state")),
			JSON.stringify({ type: "custom", id: "tree-state-entry", parentId: "target-tree-state", timestamp: "t2", customType: "goal-state", data: { active: true } }),
		].join("\n") + "\n";
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(join(dir, "archive"));
		const result = await archive.create({
			...input(source, text, "tree-state"),
			rewoundJsonl,
			rewoundDigest: sessionBytesDigest(rewoundJsonl),
			rewoundLeafId: "tree-state-entry",
		});
		assert.ok(result.record);
		assert.equal(await archive.read(result.record), text);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive removes abandoned temp directories while holding the publish lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-temp-owner-"));
	try {
		const root = join(dir, "archive");
		const source = join(dir, "source.jsonl");
		const text = sessionText("owner");
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(root);
		await archive.create(input(source, text, "owner"));
		const abandoned = join(root, ".tmp-rewind-2147483647-00000000-0000-0000-0000-000000000002");
		await mkdir(abandoned);
		await archive.list();
		const names = await readdir(root);
		assert.equal(names.includes(abandoned.split("/").at(-1)!), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive reclaims a lock and candidate left by a dead process", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-lock-recovery-"));
	try {
		const root = join(dir, "archive");
		const source = join(dir, "source.jsonl");
		const text = sessionText("lock-recovery");
		await writeFile(source, text, "utf8");
		await mkdir(root);
		const lock = join(root, ".retention.lock");
		const missingStartDigest = "0".repeat(64);
		await mkdir(lock);
		await writeFile(join(lock, `owner-2147483647-${missingStartDigest}-00000000-0000-0000-0000-000000000001`), "", "utf8");
		await mkdir(join(root, `.lock-candidate-2147483647-${missingStartDigest}-00000000-0000-0000-0000-000000000002`));
		await mkdir(join(root, ".lock-release-2147483647-00000000-0000-0000-0000-000000000003"));
		await mkdir(join(root, ".stale-lock-2147483647-00000000-0000-0000-0000-000000000004"));
		const archive = new RewindArchive(root);
		const result = await archive.create(input(source, text, "lock-recovery"));
		assert.equal(result.retained, true);
		const names = await readdir(root);
		assert.equal(names.includes(".retention.lock"), false);
		assert.equal(names.some((name) => name.startsWith(".lock-candidate-")), false);
		assert.equal(names.some((name) => name.startsWith(".lock-release-")), false);
		assert.equal(names.some((name) => name.startsWith(".stale-lock-")), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive reclaims this process's stale claim after partial release", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-claim-recovery-"));
	try {
		const root = join(dir, "archive");
		const source = join(dir, "source.jsonl");
		const text = sessionText("claim-recovery");
		await writeFile(source, text, "utf8");
		await mkdir(root);
		const startIdentity = execFileSync(
			"/bin/ps",
			["-p", String(process.pid), "-o", "lstart="],
			{ encoding: "utf8" },
		).trim();
		const startDigest = createHash("sha256").update(startIdentity).digest("hex");
		const lock = join(root, ".retention.lock");
		await mkdir(lock);
		await writeFile(
			join(lock, `claim-${process.pid}-${startDigest}-00000000-0000-0000-0000-000000000001`),
			"",
			"utf8",
		);
		const archive = new RewindArchive(root);
		const result = await archive.create(input(source, text, "claim-recovery"));
		assert.equal(result.retained, true);
		assert.equal((await readdir(root)).includes(".retention.lock"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive removes corrupt records in its own namespace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-corrupt-"));
	try {
		const root = join(dir, "archive");
		const source = join(dir, "source.jsonl");
		const text = sessionText("valid");
		await writeFile(source, text, "utf8");
		const archive = new RewindArchive(root);
		const result = await archive.create(input(source, text, "valid"));
		assert.ok(result.record);
		await writeFile(join(result.record.recordDir, "metadata.json"), "not json\n", "utf8");
		assert.deepEqual(await archive.list(), []);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
