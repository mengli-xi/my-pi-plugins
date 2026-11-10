import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runIsolated(source: string): void {
	const home = mkdtempSync(join(tmpdir(), "ask-config-"));
	try {
		const output = execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
			cwd: new URL("..", import.meta.url),
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "xdg") },
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.equal(output, "");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const setup = `
	import assert from "node:assert/strict";
	import fs from "node:fs";
	import { syncBuiltinESMExports } from "node:module";
	import { join, dirname } from "node:path";
	import { createJiti } from "jiti";
	const xdg = join(process.env.XDG_CONFIG_HOME, "rpiv-ask-user-question", "config.json");
	const legacy = join(process.env.HOME, ".config", "rpiv-ask-user-question", "config.json");
	const write = (path, text) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, text); };
	const warnings = [];
	console.warn = text => warnings.push(text);
	let reads = 0, parses = 0, statError;
	let beforeOpen;
	const parse = JSON.parse;
	JSON.parse = function(text, ...args) {
		if (typeof text === "string" && (text.includes("collapseKey") || text === "{broken")) parses++;
		return parse.call(this, text, ...args);
	};
	const { statSync, openSync, readFileSync } = fs;
	fs.statSync = (...args) => {
		if (args[0] === xdg && statError) throw statError;
		return statSync(...args);
	};
	fs.openSync = (...args) => {
		if (args[0] === xdg) beforeOpen?.();
		return openSync(...args);
	};
	fs.readFileSync = (...args) => {
		if (typeof args[0] === "number" || args[0] === xdg || args[0] === legacy) reads++;
		return readFileSync(...args);
	};
	syncBuiltinESMExports();
	const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
	const config = await jiti.import("./config.ts");
`;

test("wrong runtime shortcut types use defaults without throwing", () => {
	runIsolated(setup + `
		for (const value of [null, false, true, 0, 1, [], {}, ["n"]]) {
			assert.equal(config.resolveCollapseKey({ collapseKey: value }), "ctrl+]");
			assert.equal(config.resolveNotesKey({ notesKey: value }), "n");
		}
		assert.equal(config.resolveCollapseKey({ collapseKey: " OFF " }), "off");
		assert.equal(config.resolveNotesKey({ notesKey: " т " }), "т");
		assert.equal(config.resolveNotesKey({ notesKey: "CTRL+N" }), "ctrl+n");
		assert.equal(config.resolveNotesKey({ notesKey: "enter" }), "n");
	`);
});

test("XDG and legacy discovery reuse unchanged versions and pick up edits without writes", () => {
	runIsolated(setup + `
		assert.deepEqual(config.loadConfig(), {});
		write(legacy, '{"collapseKey":"alt+o"}');
		fs.chmodSync(legacy, 0o400);
		const before = fs.statSync(legacy);
		const first = config.loadConfig();
		assert.equal(first.collapseKey, "alt+o");
		const readCount = reads, parseCount = parses;
		assert.ok(readCount > 0);
		assert.ok(parseCount > 0);
		assert.strictEqual(config.loadConfig(), first);
		assert.equal(reads, readCount);
		assert.equal(parses, parseCount);
		assert.equal(fs.statSync(legacy).mode, before.mode);
		assert.equal(fs.statSync(legacy).mtimeMs, before.mtimeMs);
		write(xdg, "{broken");
		assert.deepEqual(config.loadConfig(), {});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /invalid JSON/);
		assert.ok(warnings[0].includes(xdg));
		const badReads = reads, badParses = parses;
		assert.deepEqual(config.loadConfig(), {});
		assert.equal(reads, badReads);
		assert.equal(parses, badParses);
		assert.equal(warnings.length, 1);
		write(xdg + ".new", '{"collapseKey":"off"}');
		fs.renameSync(xdg + ".new", xdg);
		assert.equal(config.loadConfig().collapseKey, "off");
		fs.unlinkSync(xdg);
		assert.equal(config.loadConfig().collapseKey, "alt+o");
		for (const invalid of ["null", "[]", "42", '"string"']) {
			write(xdg, invalid);
			assert.deepEqual(config.loadConfig(), {});
		}
		assert.equal(warnings.length, 1);
		write(xdg, "PRIVATE_CONFIG_CONTENT_FIXTURE");
		assert.deepEqual(config.loadConfig(), {});
		assert.equal(warnings.length, 2);
		assert.match(warnings[1], /invalid JSON.*SyntaxError/);
		assert.ok(!warnings[1].includes("PRIVATE_CONFIG_CONTENT_FIXTURE"));
		process.env.XDG_CONFIG_HOME = "relative-is-ignored";
		assert.equal(config.loadConfig().collapseKey, "alt+o");
		process.env.XDG_CONFIG_HOME = " ~/.config ";
		assert.equal(config.loadConfig().collapseKey, "alt+o");
	`);
});

test("stat failures retain path and cause without repeated warnings or legacy reads", () => {
	runIsolated(setup + `
		write(legacy, '{"collapseKey":"alt+o"}');
		write(xdg, '{"collapseKey":"off"}');
		statError = Object.assign(new Error("EACCES: fixture access denied"), { code: "EACCES" });
		assert.deepEqual(config.loadConfig(), {});
		assert.deepEqual(config.loadConfig(), {});
		assert.equal(reads, 0);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0].includes(xdg));
		assert.match(warnings[0], /EACCES: fixture access denied/);
		statError = undefined;
		assert.equal(config.loadConfig().collapseKey, "off");
	`);
});

test("non-regular XDG configs do not block or fall back, and diagnose once per version", () => {
	runIsolated(setup + `
		import { execFileSync } from "node:child_process";
		write(legacy, '{"collapseKey":"alt+o"}');
		fs.mkdirSync(xdg, { recursive: true });
		assert.deepEqual(config.loadConfig(), {});
		assert.deepEqual(config.loadConfig(), {});
		assert.equal(reads, 0);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0].includes(xdg));
		assert.match(warnings[0], /not a regular file/);
		fs.rmdirSync(xdg);
		execFileSync("mkfifo", [xdg]);
		assert.deepEqual(config.loadConfig(), {});
		assert.deepEqual(config.loadConfig(), {});
		assert.equal(reads, 0);
		assert.equal(warnings.length, 2);
		fs.unlinkSync(xdg);
		write(xdg, '{"collapseKey":"off"}');
		beforeOpen = () => {
			beforeOpen = undefined;
			fs.unlinkSync(xdg);
			execFileSync("mkfifo", [xdg]);
		};
		assert.deepEqual(config.loadConfig(), {});
		assert.equal(warnings.length, 3);
		assert.equal(reads, 0);
		fs.unlinkSync(xdg);
		write(xdg, '{"collapseKey":"off"}');
		assert.equal(config.loadConfig().collapseKey, "off");
	`);
});
