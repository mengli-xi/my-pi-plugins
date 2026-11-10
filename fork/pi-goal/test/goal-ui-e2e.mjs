import assert from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { isolatedEnvironment, stockHost } from "./runtime-test-env.mjs";

// The package default loads only Goal and its faux fixture. A root integration
// wrapper may explicitly supply additional built entries and a semantic row check.
export async function runGoalUiE2e({ additionalEntries = [], semanticGoalRow = false } = {}) {
	assert.ok(globalThis.Bun, "Run this PTY driver with Bun");
	const root = mkdtempSync(join(tmpdir(), "goal-ui-"));
	const env = isolatedEnvironment(root, { TERM: "xterm-256color", GOAL_UI_ROOT: root });
	const { binary, version } = stockHost(env);
	const goal = fileURLToPath(new URL("../dist/index.js", import.meta.url));
	const fixture = fileURLToPath(new URL("./goal-ui-fixture.ts", import.meta.url));
	for (const entry of [goal, fixture, ...additionalEntries]) assert.ok(existsSync(entry), entry);
	const cwd = join(root, "cwd");
	mkdirSync(cwd);
	writeFileSync(join(root, "commands.jsonl"), "");
	writeFileSync(join(root, "events.jsonl"), "");
	// Goal settings are intentionally absent: queue and managed RPC stay default-off.
	writeFileSync(
		join(root, "agent/settings.json"),
		JSON.stringify({
			packages: [],
			extensions: [],
			quietStartup: true,
			theme: "dark",
			tuiMode: "fullscreen",
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	const terminal = new xterm.Terminal({
		cols: 120,
		rows: 42,
		allowProposedApi: true,
		scrollback: 1000,
	});
	const chunks = [];
	let child;
	const replies = terminal.onData((data) => child?.terminal?.write(data));
	child = Bun.spawn({
		cmd: [
			binary,
			"--offline",
			"--approve",
			"--tui-mode",
			"fullscreen",
			"-ne",
			"--no-mcp",
			"-ns",
			"-np",
			"-nc",
			"--no-themes",
			"--session",
			join(root, "main.jsonl"),
			...additionalEntries.flatMap((entry) => ["-e", entry]),
			"-e",
			goal,
			"-e",
			fixture,
			"--provider",
			"goal-ui-faux",
			"--model",
			"fixture",
			"--thinking",
			"off",
		],
		cwd,
		env,
		terminal: {
			cols: 120,
			rows: 42,
			data(_pty, data) {
				chunks.push(Buffer.from(data));
				terminal.write(data);
			},
		},
	});
	assert.ok(child.terminal, "Bun must allocate an actual PTY");
	const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	let eventVersion = "",
		eventRows = [],
		serial = 0;
	const events = () => {
		const path = join(root, "events.jsonl"),
			info = statSync(path, { bigint: true });
		const version = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
		if (version !== eventVersion) {
			eventVersion = version;
			const lines = readFileSync(path, "utf8").split("\n");
			lines.pop();
			eventRows = lines.filter(Boolean).map(JSON.parse);
		}
		return eventRows;
	};
	const screen = () =>
		Array.from(
			{ length: terminal.rows },
			(_, row) =>
				terminal.buffer.active
					.getLine(terminal.buffer.active.viewportY + row)
					?.translateToString(true) ?? "",
		).join("\n");
	const send = (text) => child.terminal.write(text);
	const command = (text) => send(`${text}\r`);
	const shot = (name) => writeFileSync(join(root, `${name}.txt`), screen());
	function assertVisibleMenuOrder(labels) {
		const rendered = screen();
		let cursor = 0;
		for (const label of labels) {
			const index = rendered.indexOf(label, cursor);
			assert.ok(index >= cursor, `Expected visible menu order: ${labels.join(" -> ")}`);
			cursor = index + label.length;
		}
	}
	async function wait(label, predicate, timeout = 15000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (await predicate()) return;
			if (child.exitCode !== null) throw new Error(`Pi exited ${child.exitCode}: ${label}`);
			await delay(25);
		}
		throw new Error(`Timeout: ${label}\n${screen()}`);
	}
	async function inspect(op = "inspect") {
		const id = ++serial;
		appendFileSync(join(root, "commands.jsonl"), `${JSON.stringify({ id, op })}\n`);
		await wait(`inspect ${id}`, () =>
			events().some((row) => row.event === "inspect" && row.id === id),
		);
		return events().findLast((row) => row.event === "inspect" && row.id === id);
	}
	async function unchanged(paused, label) {
		const current = await inspect();
		assert.equal(current.snapshot.goal.id, paused.id, label);
		assert.equal(current.snapshot.goal.text, paused.text, label);
		assert.equal(current.snapshot.goal.phase, "paused", label);
		assert.equal(current.snapshot.goal.clockRunning, false, label);
		assert.equal(current.calls, 1, label);
		assert.equal(current.pendingMessages, false, label);
		assert.equal(current.editor, "", label);
		return current;
	}
	const semanticClock = () => screen().match(/Goal paused\s+((?:\d+h)?(?:\d+m)?\d+s)\b/)?.[1];
	let result;
	try {
		await wait("TUI ready", () => events().some((row) => row.event === "ready"));
		let state = await inspect();
		assert.equal(state.mode, "tui");
		assert.equal(state.snapshot.goal, null);
		const draft = "DRAFT  exact α text  TWO";
		send(draft);
		await wait("exact editor draft", async () => (await inspect()).editor === draft);
		// This public test shortcut dispatches the real /goal command without
		// clearing the editor first; it does not implement or replace its UI.
		send("\x1bg");
		await wait(
			"Goal menu",
			() => screen().includes("Start a goal") && screen().includes("Settings"),
		);
		assert.ok(!screen().includes("Queue…"), "queue remains default-off");
		shot("idle-menu");
		send("\x1b");
		await wait("draft restored after menu cancellation", async () => {
			const value = await inspect();
			return value.editor === draft && !screen().includes("Start a goal");
		});
		assert.equal((await inspect()).calls, 0);
		const menuSession = (await inspect()).sessionId;
		send("\x1bg");
		await wait("Goal menu before replacement", () => screen().includes("Start a goal"));
		await inspect("replace");
		await wait(
			"open menu invalidated by new generation",
			() =>
				events().findLast((row) => row.event === "ready")?.sessionId !== menuSession &&
				!screen().includes("Start a goal"),
		);
		state = await inspect();
		assert.notEqual(state.sessionId, menuSession);
		assert.equal(state.snapshot.goal, null);
		assert.equal(state.calls, 0);
		send("\x01\x0b");
		command("/goal");
		await wait("idle menu for settings", () => screen().includes("Start a goal"));
		// buildGoalMenuState in menu.ts: no goal -> start, startBudget, settings.
		assertVisibleMenuOrder(["Start a goal…", "Start with token budget…", "Settings…"]);
		send("\x1b[B\x1b[B\r");
		await wait("Goal settings", () => screen().includes("Pi Goal Settings"));
		assert.match(screen(), /Ordered goal queue\s+Off/);
		assert.match(screen(), /Managed run RPC\s+Off/);
		shot("default-settings");
		send("\x1b[B\x1b[A\x1b");
		await wait("settings cancelled", () => !screen().includes("Pi Goal Settings"));
		await wait("settings returns to Goal menu", () => screen().includes("Start a goal"));
		send("\x1b");
		await wait("Goal menu closed after settings", () => !screen().includes("Start a goal"));
		assert.equal(
			existsSync(join(root, "agent/pi-goal.json")),
			false,
			"navigation must not save settings",
		);
		assert.equal((await inspect()).calls, 0);

		const objective = "Original  exact objective α";
		// The existing parser preserves inner whitespace inside a quoted objective.
		command(`/goal "${objective}"`);
		await wait("held Goal request", () =>
			events().some((row) => row.event === "request" && row.call === 1),
		);
		state = await inspect();
		const active = state.snapshot.goal;
		assert.equal(active.text, objective);
		assert.equal(
			events().find((row) => row.event === "request" && row.call === 1)?.goalId,
			active.id,
		);
		assert.equal(active.phase, "active");
		assert.equal(active.clockRunning, true);
		assert.equal(active.queued, 0);
		await wait("visible active Goal status", () =>
			semanticGoalRow
				? /Goal active\s+(?:\d+h)?(?:\d+m)?\d+s\b/.test(screen())
				: /active .*· automatic/.test(screen()),
		);
		shot("active");
		command("/goal pause");
		await wait("paused and idle", async () => {
			const value = await inspect();
			return value.snapshot.goal?.phase === "paused" && value.idle && value.pending === 0;
		});
		const paused = (await inspect()).snapshot.goal;
		assert.equal(paused.id, active.id);
		assert.equal(paused.clockRunning, false);
		await wait("visible paused status", () =>
			semanticGoalRow ? screen().includes("Goal paused") : screen().includes("paused · automatic"),
		);
		if (semanticGoalRow)
			await wait("semantic Goal paused clock row", () => semanticClock() !== undefined);
		const clock = semanticGoalRow ? semanticClock() : undefined;
		const frozenSeconds = paused.runtimeSeconds;
		shot("paused");
		await delay(1250);
		assert.equal(
			(await unchanged(paused, "paused clock is frozen")).snapshot.goal.runtimeSeconds,
			frozenSeconds,
		);
		if (semanticGoalRow) assert.equal(semanticClock(), clock, "semantic paused row must not tick");

		command("/goal");
		await wait(
			"paused menu",
			() => screen().includes("Resume goal") && screen().includes("View full status"),
		);
		assert.ok(!screen().includes("Queue…"));
		// menu.ts appends edit/replace/status after a normally paused goal's resume.
		assertVisibleMenuOrder(["Resume goal", "Edit goal…", "Replace goal…", "View full status"]);
		send("\x1b[B\x1b[B\x1b[B\r");
		await wait("full Goal status", () => screen().includes("Goal status"));
		assert.ok(screen().includes(objective));
		assert.ok(screen().includes("Status: paused"));
		assert.ok(screen().includes("Active elapsed:"));
		shot("status");
		send("\x1b");
		await wait("status back to menu", () => screen().includes("Resume goal"));
		send("\x1b");
		await wait("menu closed", () => !screen().includes("Resume goal"));
		await unchanged(paused, "status navigation must not resume work");
		command("/goal edit");
		await wait(
			"prefilled edit editor",
			() => screen().includes("Edit goal objective") && screen().includes(objective),
		);
		send(" CANCELLED_SUFFIX\x1b");
		await wait("modify cancelled", () => !screen().includes("Edit goal objective"));
		await unchanged(paused, "cancelled edit must not change or resume the Goal");
		command("/goal modify");
		await wait("modify editor reopened", () => screen().includes("Edit goal objective"));
		const revised = "Revised  exact objective β";
		send(`\x01\x0b${revised}\r`);
		await wait(
			"paused objective modified",
			async () => (await inspect()).snapshot.goal?.text === revised,
		);
		const edited = (await inspect()).snapshot.goal;
		assert.equal(edited.phase, "paused");
		assert.equal(edited.clockRunning, false);
		assert.equal((await inspect()).calls, 1);
		command("/goal resume");
		await wait(
			"explicit resume request",
			() => events().filter((row) => row.event === "request").length === 2,
		);
		const resumed = (await inspect()).snapshot.goal;
		assert.notEqual(resumed.id, edited.id, "resume rotates the guarded Goal instance id");
		assert.equal(resumed.text, revised);
		assert.equal(resumed.phase, "active");
		assert.equal(
			events().find((row) => row.event === "request" && row.call === 2)?.goalId,
			resumed.id,
		);
		assert.equal(resumed.clockRunning, true);
		writeFileSync(join(root, "release-2"), "release the only completing response");
		await wait("Goal completed once", async () => {
			const value = await inspect();
			return value.snapshot.goal === null && value.idle && value.pending === 0;
		});
		assert.deepEqual(
			events()
				.filter((row) => row.event === "complete-tool")
				.map((row) => row.isError),
			[false],
		);
		assert.deepEqual(
			events()
				.filter((row) => row.event === "provider-cancelled")
				.map((row) => row.call),
			[1],
		);
		assert.deepEqual(
			events()
				.filter((row) => row.event === "provider-released")
				.map((row) => row.call),
			[2],
		);
		shot("completed");

		const oldSession = (await inspect()).sessionId;
		writeFileSync(join(root, "commands.jsonl"), "");
		command("/new");
		await wait(
			"replacement TUI generation",
			() => events().findLast((row) => row.event === "ready")?.sessionId !== oldSession,
		);
		writeFileSync(join(root, "release-1"), "stale cancelled generation must never restart");
		await delay(300);
		state = await inspect();
		assert.notEqual(state.sessionId, oldSession);
		assert.equal(state.snapshot.goal, null);
		assert.equal(state.pending, 0);
		assert.equal(events().filter((row) => row.event === "request").length, 2);
		assert.equal(
			events().findLast((row) => row.event === "shutdown" && row.reason === "new")?.pending,
			0,
		);
		command("/goal-ui-exit");
		let shutdownTimer;
		const code = await Promise.race([
			child.exited,
			new Promise((_, reject) => {
				shutdownTimer = setTimeout(
					() => reject(new Error("Graceful PTY shutdown timed out")),
					15000,
				);
			}),
		]).finally(() => clearTimeout(shutdownTimer));
		assert.equal(code, 0);
		assert.equal(events().findLast((row) => row.event === "shutdown")?.reason, "quit");
		assert.equal(events().findLast((row) => row.event === "shutdown")?.pending, 0);
		await new Promise((resolve) => terminal.write("", resolve));
		const raw = Buffer.concat(chunks).toString();
		assert.ok(
			raw.lastIndexOf("\x1b[?2004l") > raw.lastIndexOf("\x1b[?2004h"),
			"bracketed paste restored on exit",
		);
		assert.ok(
			raw.lastIndexOf("\x1b[?25h") > raw.lastIndexOf("\x1b[?25l"),
			"cursor restored on exit",
		);
		assert.ok(!raw.includes("Failed to load extension"), raw.slice(-4000));
		result = {
			root,
			host: version,
			mode: "tui",
			providerRequests: 2,
			realRequests: 0,
			completedToolCalls: 1,
			pausedClockFrozen: true,
			semanticGoalRow,
			shutdown: "clean",
			passed: true,
		};
		writeFileSync(join(root, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
		console.log(JSON.stringify(result));
		return result;
	} catch (error) {
		shot("failure-screen");
		writeFileSync(join(root, "failure.txt"), String(error));
		console.error(JSON.stringify({ root, passed: false, error: String(error) }));
		throw error;
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		writeFileSync(join(root, "terminal.raw"), Buffer.concat(chunks));
		replies.dispose();
		child.terminal.close();
		terminal.dispose();
	}
}

if (import.meta.main) await runGoalUiE2e();
