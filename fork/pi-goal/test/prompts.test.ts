import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { goalAppendRules } from "../src/prompts.js";

async function appendFixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "goal-append-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return { dir, path: join(dir, "goal-append.md") };
}

test("goalAppendRules returns trimmed content with a leading newline", async (t) => {
	const { dir } = await appendFixture(t);
	const path = join(dir, "goal-append.md");
	await writeFile(path, "\n- Completion means scope is met.\n\n");
	assert.equal(goalAppendRules(path), "\n- Completion means scope is met.");
});

test("goalAppendRules returns empty string for a missing file", async (t) => {
	const { dir } = await appendFixture(t);
	assert.equal(goalAppendRules(join(dir, "goal-append.md")), "");
});

test("goalAppendRules returns empty string for a whitespace-only file", async (t) => {
	const { dir } = await appendFixture(t);
	const path = join(dir, "goal-append.md");
	await writeFile(path, "  \n\n");
	assert.equal(goalAppendRules(path), "");
});

test("goalAppendRules reads rapid same-length edits even with identical metadata", async (t) => {
	const { path } = await appendFixture(t);
	await writeFile(path, "- first");
	const version = fs.statSync(path, { bigint: true });
	t.mock.method(fs, "statSync", () => version);
	t.mock.method(fs, "fstatSync", () => version);
	syncBuiltinESMExports();
	for (let i = 0; i < 40; i++) {
		const text = i % 2 ? "- first" : "- later";
		await writeFile(path, text);
		assert.equal(goalAppendRules(path), `\n${text}`);
	}
});

test("goalAppendRules follows the current getAgentDir and does not cache its path", async (t) => {
	const { dir } = await appendFixture(t);
	const previous = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	for (const name of ["first", "second"]) {
		const agentDir = join(dir, name);
		await mkdir(agentDir);
		await writeFile(join(agentDir, "goal-append.md"), `- ${name}`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		assert.equal(getAgentDir(), agentDir);
		assert.equal(goalAppendRules(), `\n- ${name}`);
	}
});

test("goalAppendRules reloads edits and atomic replacements and clears deleted text", async (t) => {
	const { dir, path } = await appendFixture(t);
	const issues: Array<string | undefined> = [];
	const read = () => goalAppendRules(path, (issue) => issues.push(issue));
	assert.equal(read(), "");
	await writeFile(path, "- first");
	assert.equal(read(), "\n- first");
	await writeFile(path, "- later");
	assert.equal(read(), "\n- later");
	const replacement = join(dir, "replacement.md");
	await writeFile(replacement, "- final");
	await rename(replacement, path);
	assert.equal(read(), "\n- final");
	await rm(path);
	assert.equal(read(), "");
	await writeFile(path, " \n");
	assert.equal(read(), "");
	assert.deepEqual(issues, Array(6).fill(undefined));
});

test("goalAppendRules reports stat faults safely and never reuses stale text after failure", async (t) => {
	const { path } = await appendFixture(t);
	await writeFile(path, "- private text");
	assert.equal(goalAppendRules(path), "\n- private text");
	const originalStat = fs.statSync;
	let failure: unknown = Object.assign(new Error("private text"), { code: "EACCES" });
	t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
		if (failure) throw failure;
		return originalStat(...args);
	});
	const read = t.mock.method(fs, "readFileSync");
	syncBuiltinESMExports();
	const issues: Array<string | undefined> = [];
	assert.equal(
		goalAppendRules(path, (issue) => issues.push(issue)),
		"",
	);
	assert.equal(issues.at(-1), "pi-goal: goal-append.md ignored (stat: EACCES).");
	failure = Object.assign(new Error("private text"), { code: "private\ntext" });
	assert.equal(
		goalAppendRules(path, (issue) => issues.push(issue)),
		"",
	);
	assert.equal(issues.at(-1), "pi-goal: goal-append.md ignored (stat: unknown error).");
	failure = null;
	assert.equal(
		goalAppendRules(path, (issue) => issues.push(issue)),
		"\n- private text",
	);
	assert.equal(read.mock.callCount(), 1, "recovery must re-read even the old stable version");
	assert.equal(issues.at(-1), undefined);
	assert.doesNotMatch(issues.filter(Boolean).join("\n"), /private text|private\ntext/);
});

test("goalAppendRules reports read faults safely and retries without stale text", async (t) => {
	const { path } = await appendFixture(t);
	await writeFile(path, "- before");
	assert.equal(goalAppendRules(path), "\n- before");
	await writeFile(path, "- after");
	const originalRead = fs.readFileSync;
	let fail = true;
	t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
		if (fail) throw Object.assign(new Error("private file contents"), { code: "EIO" });
		return originalRead(...args);
	});
	syncBuiltinESMExports();
	let issue: string | undefined;
	assert.equal(
		goalAppendRules(path, (value) => {
			issue = value;
		}),
		"",
	);
	assert.equal(issue, "pi-goal: goal-append.md ignored (read: EIO).");
	fail = false;
	assert.equal(goalAppendRules(path), "\n- after");
});

test("goalAppendRules rejects directories and FIFOs before opening or reading", async (t) => {
	const { dir, path } = await appendFixture(t);
	const directory = join(dir, "directory");
	await mkdir(directory);
	execFileSync("mkfifo", [path]);
	const open = t.mock.method(fs, "openSync");
	const read = t.mock.method(fs, "readFileSync");
	syncBuiltinESMExports();
	for (const target of [directory, path]) {
		let issue: string | undefined;
		assert.equal(
			goalAppendRules(target, (value) => {
				issue = value;
			}),
			"",
		);
		assert.equal(issue, "pi-goal: goal-append.md ignored (not a regular file).");
	}
	assert.equal(open.mock.callCount(), 0);
	assert.equal(read.mock.callCount(), 0);
});

test("goalAppendRules follows regular-file symlinks but rejects FIFO replacements at open", async (t) => {
	const { dir, path } = await appendFixture(t);
	const target = join(dir, "target.md");
	await writeFile(target, "- linked");
	await symlink(target, path);
	assert.equal(goalAppendRules(path), "\n- linked");
	await writeFile(target, "- changed");
	const originalOpen = fs.openSync;
	t.mock.method(fs, "openSync", (...[file, flags, mode]: Parameters<typeof fs.openSync>) => {
		fs.unlinkSync(path);
		execFileSync("mkfifo", [path]);
		assert.equal((Number(flags) & fs.constants.O_NONBLOCK) !== 0, true);
		return originalOpen(file, flags, mode);
	});
	const read = t.mock.method(fs, "readFileSync");
	syncBuiltinESMExports();
	let issue: string | undefined;
	assert.equal(
		goalAppendRules(path, (value) => {
			issue = value;
		}),
		"",
	);
	assert.equal(issue, "pi-goal: goal-append.md ignored (not a regular file).");
	assert.equal(read.mock.callCount(), 0);
});
