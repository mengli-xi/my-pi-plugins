import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RewindArchive } from "../archive.ts";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import piRewind from "../index.ts";
import { sessionBytesDigest, SessionRewriteConflictError } from "../session-file.ts";

const HEADER_CWD = "/tmp/pi-rewind-in-place";
const ESCAPE = "\x1b";

function line(entry: Record<string, unknown>): string {
	return JSON.stringify(entry);
}

/** One finished turn. The turn under test is appended live, the way Pi does. */
function baseSession(): string {
	return [
		line({ type: "session", version: 3, id: "01a07600-0000-7000-8000-00000000abcd", timestamp: "t0", cwd: HEADER_CWD }),
		line({ type: "session_info", id: "name", parentId: null, timestamp: "t0", name: "Kept name" }),
		line({ type: "message", id: "u1", parentId: "name", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1 } }),
		line({ type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "stop", timestamp: 2 } }),
		line({ type: "custom", id: "sep1", parentId: "a1", timestamp: "t3", customType: "run-separator", data: {} }),
	].join("\n") + "\n";
}

/**
 * `/usr/bin/trash` is the one step a rewind cannot own: a sandbox or a policy
 * can refuse a path that is perfectly valid, and the machine running the suite
 * decides which. Both outcomes are real product behavior, so the tests drive
 * the step directly instead of letting the environment pick one silently.
 */
interface TrashStub {
	backup: (backupFile: string) => Promise<boolean>;
	calls: string[];
}

/** Stands in for a working Trash: the backup leaves the session directory. */
function trashAccepts(): TrashStub {
	const calls: string[] = [];
	return {
		calls,
		backup: async (backupFile) => {
			calls.push(backupFile);
			await rm(backupFile, { force: true });
			return true;
		},
	};
}

/** Stands in for a Trash that refuses the path, as a sandboxed one does. */
function trashRefuses(): TrashStub {
	const calls: string[] = [];
	return {
		calls,
		backup: async (backupFile) => {
			calls.push(backupFile);
			return false;
		},
	};
}

async function build(
	trash: TrashStub = trashAccepts(),
	archive: RewindArchive | false = false,
	initialSession = baseSession(),
) {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-inplace-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, initialSession, "utf8");
	const manager = SessionManager.open(sessionFile, dir);

	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const navigations: string[] = [];
	const notes: string[] = [];
	const levels: Array<string | undefined> = [];
	const switchCalls: string[] = [];
	const submitted: string[] = [];
	let editorText = "";
	let idle = true;
	let aborts = 0;
	let commandHandler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let rowsUp = 0;
	let panelInputs: string[][] = [];
	let nextConfirmation = true;
	let cancelNextNavigation = false;
	let appendBeforeCancel = false;
	let afterPickerClosed: (() => void | Promise<void>) | undefined;
	let afterNavigation: (() => void | Promise<void>) | undefined;
	let onEditorSubmit: ((text: string) => void) | undefined;
	let waitForIdle: () => Promise<void> = async () => {};
	const statuses: Array<string | undefined> = [];
	let pickerCount = 0;

	const editor = {
		onSubmit: (text: string) => { submitted.push(text); onEditorSubmit?.(text); },
		getText: () => editorText,
		setText: (text: string) => { editorText = text; },
		handleInput(data: string) {
			if (data === "\r" || data === "\x1b\r") {
				const text = editorText;
				editorText = "";
				editor.onSubmit(text);
			} else if (data !== ESCAPE) editorText += data;
		},
		render: () => ["editor"],
		invalidate() {},
	};
	let factory = ((): typeof editor => editor) as never;

	const ui = {
		theme: { fg: (_tone: string, text: string) => text },
		getEditorComponent: () => factory,
		setEditorComponent: (next: never) => { factory = next; },
		getEditorText: () => editorText,
		setEditorText: (text: string) => { editorText = text; },
		notify: (message: string, level?: string) => { notes.push(message); levels.push(level); },
		setWidget: (_key: string, lines: string[] | undefined) => { statuses.push(lines?.join("\n")); },
		confirm: async () => nextConfirmation,
		// The real editor-slot panel, driven with arrow keys and Enter.
		custom: async (factory: (...args: unknown[]) => unknown) => {
			pickerCount += 1;
			let resolve!: (value: unknown) => void;
			const closed = new Promise((done) => { resolve = done; });
			const setFocus = (value: unknown): void => {
				if (value && typeof value === "object" && "focused" in value) {
					(value as { focused: boolean }).focused = true;
				}
			};
			const component = factory(
				{ terminal: { rows: 40, columns: 100, write() {} }, children: [], requestRender() {}, setFocus },
				{ fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
				{ matches: (data: string, key: string) => ({
					"tui.select.up": "\x1b[A",
					"tui.select.down": "\x1b[B",
					"tui.select.pageUp": "page-up",
					"tui.select.pageDown": "page-down",
					"tui.select.confirm": "\r",
					"tui.select.cancel": "\x1b",
				} as Record<string, string>)[key] === data },
				(value: unknown) => resolve(value),
			) as { handleInput(data: string): void; render(width: number): string[] };
			setFocus(component);
			component.render(100);
			const scriptedInputs = panelInputs.shift();
			if (scriptedInputs) {
				for (const input of scriptedInputs) component.handleInput(input);
			} else {
				for (let step = 0; step < rowsUp; step++) component.handleInput("\x1b[A");
				component.handleInput("\r");
			}
			await closed;
			const afterClose = afterPickerClosed;
			afterPickerClosed = undefined;
			await afterClose?.();
		},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: manager,
		ui,
		isIdle: () => idle,
		abort: () => { aborts += 1; idle = true; },
		waitForIdle: () => waitForIdle(),
		navigateTree: async (targetId: string) => {
			navigations.push(targetId);
			if (cancelNextNavigation) {
				cancelNextNavigation = false;
				if (appendBeforeCancel) {
					appendBeforeCancel = false;
					manager.appendCustomEntry("veto-owner-state", { kept: true });
				}
				return { cancelled: true };
			}
			const entry = manager.getEntry(targetId) as SessionEntry | undefined;
			if (!entry) throw new Error(`missing entry ${targetId}`);
			const isUser = entry.type === "message" && entry.message.role === "user";
			const leaf = isUser ? entry.parentId : targetId;
			if (leaf === null) manager.resetLeaf();
			else manager.branch(leaf);
			const after = afterNavigation;
			afterNavigation = undefined;
			await after?.();
			return { cancelled: false };
		},
		switchSession: async (path: string) => {
			switchCalls.push(path);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;

	const pi = {
		registerCommand(_name: string, options: { handler: typeof commandHandler }) {
			commandHandler = options.handler;
		},
		on(name: string, handler: (event: unknown, c: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	piRewind(pi, { trashBackup: trash.backup, archive });

	const emit = async (name: string, event: unknown = { type: name }): Promise<void> => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx as unknown as ExtensionContext);
	};
	const decoratedEditor = (): { handleInput(data: string): void } => {
		const build = factory as unknown as (t: unknown, th: unknown, kb: unknown) => { handleInput(data: string): void };
		return build({}, {}, { matches: (data: string, action: string) =>
			(action === "app.interrupt" && data === ESCAPE) || (action === "tui.input.submit" && data === "\r")
			|| (action === "app.message.followUp" && data === "\x1b\r") });
	};

	return {
		dir,
		sessionFile,
		manager,
		emit,
		decoratedEditor,
		submitted,
		navigations,
		notes,
		levels,
		statuses,
		trash,
		switchCalls,
		get editorText() { return editorText; },
		get aborts() { return aborts; },
		get pickerCount() { return pickerCount; },
		setIdle: (value: boolean) => { idle = value; },
		afterPickerClosed: (action: () => void | Promise<void>) => { afterPickerClosed = action; },
		afterNavigation: (action: () => void | Promise<void>) => { afterNavigation = action; },
		setEditorText: (text: string) => { editorText = text; },
		onEditorSubmit: (action: (text: string) => void) => { onEditorSubmit = action; },
		setWaitForIdle: (action: () => Promise<void>) => { waitForIdle = action; },
		cancelNextNavigation: () => { cancelNextNavigation = true; },
		appendAndCancelNextNavigation: () => {
			appendBeforeCancel = true;
			cancelNextNavigation = true;
		},
		command: (args: string) => commandHandler(args, ctx),
		setPanelInputs: (...inputs: string[][]) => { panelInputs = [...inputs]; },
		setConfirmation: (value: boolean) => { nextConfirmation = value; },
		/** Drive /rewind and pick the row `steps` above the newest one. */
		pickAndRewind: async (steps: number) => {
			rowsUp = steps;
			await commandHandler("", ctx);
		},
		/** Recovery siblings still sitting next to the session file. */
		async backupsOnDisk(): Promise<string[]> {
			return (await readdir(dir)).filter((name) => name.includes(".pi-rewind-backup-"));
		},
		async entriesOnDisk(): Promise<Array<Record<string, unknown>>> {
			const text = await readFile(sessionFile, "utf8");
			return text.trim().split("\n").map((row) => JSON.parse(row) as Record<string, unknown>);
		},
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

/**
 * Submit a prompt and stop where Pi does while it waits for the answer: the
 * user entry is on disk, nothing of the answer is.
 */
async function submitPrompt(
	view: Awaited<ReturnType<typeof build>>,
	text: string,
	images: Array<Record<string, unknown>> = [],
	beforeUser: () => void = () => {},
): Promise<string> {
	await view.emit("session_start", { type: "session_start", reason: "startup" });
	await view.emit("input", { type: "input", source: "interactive", text, images });
	beforeUser();
	await view.emit("before_agent_start", { type: "before_agent_start", prompt: text });
	await view.emit("agent_start", { type: "agent_start" });
	view.setIdle(false);
	return view.manager.appendMessage({
		role: "user",
		content: [{ type: "text", text }, ...images],
		timestamp: 3,
	} as never);
}

test("missing rebind support is rejected before navigation or file changes", async () => {
	const view = await build();
	try {
		const original = await readFile(view.sessionFile, "utf8");
		view.manager.setSessionFile = undefined as never;
		await assert.rejects(view.pickAndRewind(0), /setSessionFile/);
		assert.deepEqual(view.navigations, []);
		assert.equal(await readFile(view.sessionFile, "utf8"), original);
		assert.deepEqual(await view.backupsOnDisk(), []);
	} finally {
		await view.cleanup();
	}
});

test("preparation and navigation recovery errors are both preserved", async () => {
	const view = await build();
	try {
		const original = await readFile(view.sessionFile, "utf8");
		const leaf = view.manager.getLeafId();
		const header = view.manager.getHeader()!;
		const prepareError = new Error("fixture preparation failed");
		const recoveryError = new Error("fixture navigation recovery failed");
		view.manager.getHeader = () => Object.assign({}, header, { toJSON: () => { throw prepareError; } });
		const getEntry = view.manager.getEntry.bind(view.manager);
		view.manager.getEntry = (id: string) => {
			if (id === leaf) throw recoveryError;
			return getEntry(id);
		};
		await assert.rejects(view.pickAndRewind(0), (error: unknown) =>
			error instanceof AggregateError && error.errors.includes(prepareError) && error.errors.includes(recoveryError));
		assert.equal(await readFile(view.sessionFile, "utf8"), original);
	} finally {
		await view.cleanup();
	}
});

test("failed rebind never rolls back over a newer append and reports both failures", async () => {
	const view = await build();
	try {
		const rebindError = new Error("fixture rebind failed");
		const rebind = view.manager.setSessionFile.bind(view.manager);
		let failed = false;
		view.manager.setSessionFile = (file: string) => {
			if (!failed) {
				failed = true;
				view.manager.appendCustomEntry("newer-during-rebind", { kept: true });
				throw rebindError;
			}
			rebind(file);
		};
		await assert.rejects(view.pickAndRewind(0), (error: unknown) => error instanceof AggregateError &&
			error.errors.includes(rebindError) && error.errors.some((cause) => cause instanceof SessionRewriteConflictError));
		const entries = await view.entriesOnDisk();
		assert.ok(entries.some((entry) => entry.customType === "newer-during-rebind"));
		assert.ok(!entries.some((entry) => entry.id === "a1"));
		assert.deepEqual(view.manager.getEntries().map((entry) => entry.id), entries.slice(1).map((entry) => entry.id));
		assert.equal((await view.backupsOnDisk()).length, 1);
	} finally {
		await view.cleanup();
	}
});

test("rewind follows local history regardless of assistant provider", async () => {
	const initial = baseSession().replace('"role":"assistant"', '"role":"assistant","provider":"mira"');
	const view = await build(trashAccepts(), false, initial);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await view.pickAndRewind(0);
		assert.deepEqual(view.navigations, ["u1"]);
		assert.equal(view.editorText, "first question");
		assert.equal(view.manager.getEntries().some(entry => entry.id === "a1"), false);
	} finally {
		await view.cleanup();
	}
});

type AssistantContent = Array<Record<string, unknown>>;

/**
 * Replay one raw SDK stream event the way `agent-loop.js:209-226` hands it to
 * extensions: the event itself, plus the partial message it was built from.
 */
async function streamUpdate(
	view: Awaited<ReturnType<typeof build>>,
	assistantMessageEvent: Record<string, unknown>,
	content: AssistantContent,
): Promise<void> {
	const partial = { role: "assistant", content, stopReason: "pending", timestamp: 4 };
	await view.emit("message_update", {
		type: "message_update",
		message: { ...partial },
		assistantMessageEvent: { ...assistantMessageEvent, partial },
	});
}

/** The SDK `start`, which `agent-loop.js:203-207` forwards as an empty message_start. */
async function streamStart(view: Awaited<ReturnType<typeof build>>): Promise<void> {
	await view.emit("message_start", {
		type: "message_start",
		message: { role: "assistant", content: [], stopReason: "pending", timestamp: 4 },
	});
}

/** What Pi persists once the user aborts a turn that produced nothing. */
function persistAbortedTurn(view: Awaited<ReturnType<typeof build>>): void {
	view.manager.appendMessage({
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "Operation aborted",
		timestamp: 4,
	} as never);
	view.manager.appendCustomEntry("run-separator", {});
}

for (const fresh of [false, true]) {
	test(`pending rewind retains inserted non-dialogue entries (${fresh ? "null base" : "existing base"})`, async () => {
		const initial = fresh ? baseSession().split("\n")[0]! + "\n" : baseSession();
		const view = await build(trashAccepts(), false, initial);
		try {
			assert.equal(view.manager.getLeafId(), fresh ? null : "sep1");
			let retainedId = "";
			const userId = await submitPrompt(view, "pending question", [], () => {
				view.manager.appendModelChange("faux", "faux");
				view.manager.appendThinkingLevelChange("off");
				view.manager.appendCustomEntry("extension-before-user", {});
				retainedId = view.manager.appendMessage({ role: "system", content: "tool loadout", timestamp: 3 } as never);
			});
			view.decoratedEditor().handleInput(ESCAPE);
			persistAbortedTurn(view);
			await view.command("--pending-connection");
			assert.deepEqual(view.navigations, [userId]);
			assert.equal(view.editorText, "pending question");
			assert.equal(view.manager.getLeafId(), retainedId);
			const disk = await view.entriesOnDisk();
			assert.equal(disk.at(-1)?.id, retainedId);
			assert.ok(!disk.some((entry) => (entry.message as { role?: string })?.role === "assistant"
				&& (entry.message as { stopReason?: string }).stopReason === "aborted"));
		} finally {
			await view.cleanup();
		}
	});
}

for (const role of ["user", "assistant"] as const) {
	test(`pending rewind rejects an intervening ${role} message, including invisible content`, async () => {
		const view = await build();
		try {
			await submitPrompt(view, "pending question", [], () => {
				view.manager.appendMessage({ role, content: [], stopReason: "toolUse", timestamp: 3 } as never);
				view.manager.appendMessage({ role: "system", content: "tools changed", timestamp: 3 } as never);
			});
			view.decoratedEditor().handleInput(ESCAPE);
			persistAbortedTurn(view);
			const before = await readFile(view.sessionFile, "utf8");
			await view.command("--pending-connection");
			assert.deepEqual(view.navigations, []);
			assert.equal(await readFile(view.sessionFile, "utf8"), before);
			assert.ok(view.notes.some((note) => note.includes("pending user message could not be found")));
		} finally {
			await view.cleanup();
		}
	});
}

test("picker rewinds the first user while retaining its system parent", async () => {
	const view = await build(trashAccepts(), false, baseSession().split("\n")[0]! + "\n");
	try {
		const systemId = view.manager.appendMessage({ role: "system", content: "tool loadout", timestamp: 3 } as never);
		view.manager.appendMessage({ role: "user", content: "first question", timestamp: 3 });
		await view.pickAndRewind(0);
		assert.equal(view.editorText, "first question");
		assert.equal(view.manager.getLeafId(), systemId);
		assert.equal((await view.entriesOnDisk()).at(-1)?.id, systemId);
	} finally {
		await view.cleanup();
	}
});

test("one Escape still rewinds after the provider request left, before any answer", async () => {
	const view = await build();
	try {
		const userId = await submitPrompt(view, "second question");
		// The outgoing request must not close the window on its own.
		await view.emit("before_provider_request", { type: "before_provider_request", payload: {} });
		view.decoratedEditor().handleInput(ESCAPE);
		assert.deepEqual(view.submitted, ["/rewind --pending-connection"]);
		persistAbortedTurn(view);

		await view.command("--pending-connection");

		assert.deepEqual(view.switchCalls, [], "the runtime is not rebuilt for an edit undo");
		assert.deepEqual(view.navigations, [userId], "the live branch moves through Pi's tree navigation");
		assert.equal(view.aborts, 1);
		assert.equal(view.editorText, "second question");

		const disk = await view.entriesOnDisk();
		assert.deepEqual(
			disk.map((entry) => entry.id),
			["01a07600-0000-7000-8000-00000000abcd", "name", "u1", "a1", "sep1"],
			"the aborted turn is gone from the file, the kept path and name stay",
		);
		assert.deepEqual(
			view.manager.getEntries().map((entry) => entry.id),
			["name", "u1", "a1", "sep1"],
			"memory matches the pruned file instead of keeping the discarded branch",
		);
		assert.equal(view.manager.getSessionId(), "01a07600-0000-7000-8000-00000000abcd");
		assert.equal(view.manager.getSessionFile(), view.sessionFile);
		assert.equal(view.manager.getSessionName(), "Kept name");
		assert.equal(view.manager.getLeafId(), "sep1");
	} finally {
		await view.cleanup();
	}
});

test("one Escape restores an image placeholder instead of its temporary path", async () => {
	const view = await build();
	try {
		const imagePath = "/var/folders/test/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png";
		await submitPrompt(view, `inspect ${imagePath}`);
		view.decoratedEditor().handleInput(ESCAPE);
		persistAbortedTurn(view);

		await view.command("--pending-connection");

		assert.equal(view.editorText, "inspect [Image]");
		assert.doesNotMatch(view.editorText, /pi-clipboard-/u);
	} finally {
		await view.cleanup();
	}
});

test("the empty blocks opened before the first token keep one Escape rewinding", async () => {
	const view = await build();
	try {
		const userId = await submitPrompt(view, "second question");
		// Everything a provider emits before it has said anything: the stream
		// start, the empty thinking and text blocks it opens, and empty deltas.
		await streamStart(view);
		await streamUpdate(view, { type: "thinking_start", contentIndex: 0 }, [{ type: "thinking", thinking: "" }]);
		await streamUpdate(view, { type: "thinking_delta", contentIndex: 0, delta: "" }, [{ type: "thinking", thinking: "" }]);
		await streamUpdate(view, { type: "text_start", contentIndex: 1 }, [
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "" },
		]);
		await streamUpdate(view, { type: "text_delta", contentIndex: 1, delta: "" }, [
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "" },
		]);

		view.decoratedEditor().handleInput(ESCAPE);
		assert.deepEqual(
			view.submitted,
			["/rewind --pending-connection"],
			"an opened but empty block is still only a submitted prompt",
		);
		persistAbortedTurn(view);

		await view.command("--pending-connection");

		assert.deepEqual(view.navigations, [userId]);
		assert.equal(view.aborts, 1);
		assert.equal(view.editorText, "second question");
		const disk = await view.entriesOnDisk();
		assert.deepEqual(
			disk.map((entry) => entry.id),
			["01a07600-0000-7000-8000-00000000abcd", "name", "u1", "a1", "sep1"],
			"the aborted turn is gone from the file, the kept path and name stay",
		);
		assert.deepEqual(
			view.manager.getEntries().map((entry) => entry.id),
			["name", "u1", "a1", "sep1"],
			"memory matches the pruned file",
		);
	} finally {
		await view.cleanup();
	}
});

test("the first real thinking, text or tool content hands Escape back to Pi", async () => {
	const answered: Array<[string, Record<string, unknown>, AssistantContent]> = [
		["a thinking delta", { type: "thinking_delta", contentIndex: 0, delta: "Let me" }, [
			{ type: "thinking", thinking: "Let me" },
		]],
		["a text delta", { type: "text_delta", contentIndex: 0, delta: "Sure" }, [
			{ type: "text", text: "Sure" },
		]],
		// Providers name the tool in the block they open, so the call is already out.
		["a named tool call", { type: "toolcall_start", contentIndex: 0 }, [
			{ type: "toolCall", id: "c1", name: "bash", arguments: {}, partialJson: "" },
		]],
		["streamed tool arguments", { type: "toolcall_delta", contentIndex: 0, delta: '{"cmd"' }, [
			{ type: "toolCall", id: "c1", name: "", arguments: {}, partialJson: '{"cmd"' },
		]],
	];
	for (const [label, streamed, content] of answered) {
		const view = await build();
		try {
			await submitPrompt(view, "second question");
			await streamStart(view);
			await streamUpdate(view, streamed, content);
			view.decoratedEditor().handleInput(ESCAPE);
			assert.deepEqual(view.submitted, [], `${label} falls through to Pi's abort`);
		} finally {
			await view.cleanup();
		}
	}
});

test("the first streamed answer content hands Escape back to Pi's cancel", async () => {
	const view = await build();
	try {
		await submitPrompt(view, "second question");
		await view.emit("message_update", {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
		});
		view.decoratedEditor().handleInput(ESCAPE);
		assert.deepEqual(view.submitted, [], "Escape falls through to Pi's abort");
		persistAbortedTurn(view);

		await view.command("--pending-connection");
		assert.deepEqual(view.navigations, []);
		const disk = await view.entriesOnDisk();
		assert.equal(disk.length, 8, "the whole turn is still on disk");
	} finally {
		await view.cleanup();
	}
});

test("a tool-result update from an older turn cannot arm a rewind", async () => {
	const view = await build();
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		// Continuation run: no interactive input was captured for it.
		await view.emit("agent_start", { type: "agent_start" });
		view.setIdle(false);
		view.decoratedEditor().handleInput(ESCAPE);
		assert.deepEqual(view.submitted, []);
	} finally {
		await view.cleanup();
	}
});

test("picking an image user message restores only its placeholder", async () => {
	const view = await build();
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		const imagePath = "/var/folders/test/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png";
		view.manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `inspect ${imagePath}` }],
			timestamp: 3,
		} as never);
		view.manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			stopReason: "stop",
			timestamp: 4,
		} as never);

		await view.pickAndRewind(0);

		assert.equal(view.editorText, "inspect [Image]");
		assert.doesNotMatch(view.editorText, /pi-clipboard-/u);
	} finally {
		await view.cleanup();
	}
});

test("moving up in the picker rewinds to the preceding user prompt, skipping answers", async () => {
	const trash = trashAccepts();
	const view = await build(trash);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await submitPrompt(view, "second question");
		persistAbortedTurn(view);
		view.setIdle(true);
		await view.pickAndRewind(1);
		assert.deepEqual(view.navigations, ["u1"]);
		assert.deepEqual(view.switchCalls, []);
		assert.deepEqual((await view.entriesOnDisk()).map((entry) => entry.id),
			["01a07600-0000-7000-8000-00000000abcd", "name"]);
		assert.deepEqual(view.manager.getEntries().map((entry) => entry.id), ["name"]);
		assert.equal(view.editorText, "first question");
		assert.equal(trash.calls.length, 0);
		assert.equal((await view.backupsOnDisk()).length, 1);
		assert.match(view.notes.at(-1) ?? "", /Run \/rewind undo/);
	} finally {
		await view.cleanup();
	}
});

test("undo restores the exact pre-rewind file and original leaf once", async () => {
	const trash = trashAccepts();
	const view = await build(trash);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await submitPrompt(view, "second question");
		persistAbortedTurn(view);
		view.setIdle(true);
		const originalEntries = await view.entriesOnDisk();
		const originalLeafId = view.manager.getLeafId();

		await view.pickAndRewind(1);
		assert.equal((await view.backupsOnDisk()).length, 1);

		await view.command("undo");

		assert.deepEqual(await view.entriesOnDisk(), originalEntries);
		assert.deepEqual(view.manager.getEntries().map((entry) => entry.id), originalEntries.slice(1).map((entry) => entry.id));
		assert.equal(view.manager.getLeafId(), originalLeafId);
		assert.deepEqual(view.navigations, ["u1", originalLeafId]);
		assert.deepEqual(await view.backupsOnDisk(), []);
		assert.match(view.notes.at(-1) ?? "", /Restored the conversation/);
		assert.equal(view.levels.at(-1), "info");

		await view.command("undo");
		assert.match(view.notes.at(-1) ?? "", /No rewind is available to undo/);
		assert.equal(view.levels.at(-1), "warning");
	} finally {
		await view.cleanup();
	}
});

test("undo survives an extension restart through the persistent gzip archive", async () => {
	const trash = trashAccepts();
	const archiveRoot = await mkdtemp(join(tmpdir(), "pi-rewind-history-"));
	const archive = new RewindArchive(archiveRoot);
	const view = await build(trash, archive);
	try {
		const originalEntries = await view.entriesOnDisk();
		const originalLeafId = view.manager.getLeafId();
		await view.pickAndRewind(1);
		assert.equal((await archive.list()).length, 1);

		await view.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		assert.deepEqual(await view.backupsOnDisk(), [], "the temporary sibling is removed after durable archiving");

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		let commandHandler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		const pi = {
			registerCommand(_name: string, options: { handler: typeof commandHandler }) { commandHandler = options.handler; },
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		piRewind(pi, { trashBackup: trash.backup, archive });
		await commandHandler("undo", {
			mode: "tui",
			hasUI: true,
			sessionManager: view.manager,
			ui: {
				getEditorText: () => view.editorText,
				setEditorText() {},
				notify: (message: string, level?: string) => { view.notes.push(message); view.levels.push(level); },
			},
			isIdle: () => true,
			navigateTree: async (targetId: string) => {
				view.navigations.push(targetId);
				view.manager.branch(targetId);
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext);

		assert.deepEqual(await view.entriesOnDisk(), originalEntries);
		assert.equal(view.manager.getLeafId(), originalLeafId);
		assert.match(view.notes.at(-1) ?? "", /rewind history/);
	} finally {
		await view.cleanup();
		await rm(archiveRoot, { recursive: true, force: true });
	}
});

test("persistent undo restores when rewind reparents a later session name", async () => {
	const archiveRoot = await mkdtemp(join(tmpdir(), "pi-rewind-late-name-"));
	const archive = new RewindArchive(archiveRoot);
	const view = await build(trashAccepts(), archive);
	try {
		view.manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second question" }],
			timestamp: 3,
		} as never);
		view.manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second answer" }],
			stopReason: "stop",
			timestamp: 4,
		} as never);
		const nameLeaf = view.manager.appendSessionInfo("Late name");
		const originalEntries = await view.entriesOnDisk();

		await view.pickAndRewind(3);
		assert.equal(view.manager.getLeafId(), nameLeaf, "the retained session_info becomes the physical leaf");
		await view.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		let commandHandler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		const pi = {
			registerCommand(_name: string, options: { handler: typeof commandHandler }) { commandHandler = options.handler; },
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		piRewind(pi, { archive });
		await commandHandler("undo", {
			mode: "tui",
			hasUI: true,
			sessionManager: view.manager,
			ui: {
				getEditorText: () => view.editorText,
				setEditorText() {},
				notify: (message: string, level?: string) => { view.notes.push(message); view.levels.push(level); },
			},
			isIdle: () => true,
			navigateTree: async (targetId: string) => {
				view.manager.branch(targetId);
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext);
		assert.deepEqual(await view.entriesOnDisk(), originalEntries);
		assert.equal(view.manager.getLeafId(), nameLeaf);
	} finally {
		await view.cleanup();
		await rm(archiveRoot, { recursive: true, force: true });
	}
});

test("history restores a selected archive and rejects one after later session changes", async () => {
	const archiveRoot = await mkdtemp(join(tmpdir(), "pi-rewind-history-picker-"));
	const archive = new RewindArchive(archiveRoot);
	const restored = await build(trashAccepts(), archive);
	try {
		const originalEntries = await restored.entriesOnDisk();
		await restored.pickAndRewind(1);
		await restored.command("history");
		assert.deepEqual(await restored.entriesOnDisk(), originalEntries);
		assert.match(restored.notes.at(-1) ?? "", /rewind history/);
	} finally {
		await restored.cleanup();
	}

	const changedArchiveRoot = await mkdtemp(join(tmpdir(), "pi-rewind-history-changed-"));
	const changed = await build(trashAccepts(), new RewindArchive(changedArchiveRoot));
	try {
		await changed.pickAndRewind(1);
		changed.manager.appendCustomEntry("later-work", { kept: true });
		const before = await changed.entriesOnDisk();
		await changed.command("history");
		assert.deepEqual(await changed.entriesOnDisk(), before);
		assert.match(changed.notes.at(-1) ?? "", /would overwrite later work/);
	} finally {
		await changed.cleanup();
		await rm(archiveRoot, { recursive: true, force: true });
		await rm(changedArchiveRoot, { recursive: true, force: true });
	}
});

test("history cancellation keeps selected archives and confirmed multi-delete leaves the session unchanged", async () => {
	const archiveRoot = await mkdtemp(join(tmpdir(), "pi-rewind-history-delete-"));
	let now = 1_800_000_000_000;
	const archive = new RewindArchive(archiveRoot, { now: () => now });
	const view = await build(trashAccepts(), archive);
	try {
		const originalJsonl = await readFile(view.sessionFile, "utf8");
		const originalDigest = sessionBytesDigest(originalJsonl);
		const leaf = view.manager.getLeafId()!;
		const archiveInput = {
			originalJsonl,
			rewoundJsonl: originalJsonl,
			sessionId: view.manager.getSessionId(),
			sessionFile: view.sessionFile,
			originalDigest,
			rewoundDigest: originalDigest,
			originalLeafId: leaf,
			logicalRetainedLeafId: "a1",
			rewoundLeafId: leaf,
			originalEditorText: "",
			rewoundEditorText: "",
			targetEntryId: "a1",
			targetRole: "assistant" as const,
			targetText: "first answer",
			discardedDialogueCount: 1,
			discardedPreview: "discarded",
		};
		await archive.create(archiveInput);
		now += 1;
		await archive.create(archiveInput);
		assert.equal((await archive.list()).length, 2);

		view.setConfirmation(false);
		view.setPanelInputs([" ", "\x1b[B", " ", "d"], ["\x1b"]);
		await view.command("history");
		assert.equal((await archive.list()).length, 2, "cancelled confirmation keeps both archives");

		view.setConfirmation(true);
		view.setPanelInputs(["a", "d"]);
		await view.command("history");
		assert.deepEqual(await archive.list(), []);
		assert.equal(await readFile(view.sessionFile, "utf8"), originalJsonl, "archive deletion never rewrites the current session");
		assert.match(view.notes.at(-1) ?? "", /Deleted 2 rewind archives/);
	} finally {
		await view.cleanup();
		await rm(archiveRoot, { recursive: true, force: true });
	}
});

test("history reports a record pruned after the picker opened", async () => {
	const archiveRoot = await mkdtemp(join(tmpdir(), "pi-rewind-history-missing-"));
	class VanishingArchive extends RewindArchive {
		vanishOnList = false;
		override async list() {
			const records = await super.list();
			if (this.vanishOnList && records[0]) await this.remove(records[0]);
			return records;
		}
	}
	const archive = new VanishingArchive(archiveRoot);
	const view = await build(trashAccepts(), archive);
	try {
		await view.pickAndRewind(1);
		archive.vanishOnList = true;
		await view.command("history");
		assert.match(view.notes.at(-1) ?? "", /no longer available or failed verification/);
	} finally {
		await view.cleanup();
		await rm(archiveRoot, { recursive: true, force: true });
	}
});

test("history and persistent undo report an unsafe archive root without changing the session", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rewind-unsafe-root-"));
	const root = join(dir, "rewind-trash");
	await writeFile(root, "not a directory\n", "utf8");
	const view = await build(trashAccepts(), new RewindArchive(root));
	try {
		const before = await view.entriesOnDisk();
		await view.command("history");
		assert.match(view.notes.at(-1) ?? "", /Rewind history is unavailable/);
		await view.command("undo");
		assert.match(view.notes.at(-1) ?? "", /Rewind history is unavailable/);
		assert.deepEqual(await view.entriesOnDisk(), before);
	} finally {
		await view.cleanup();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a cancelled undo restores the rewound file and keeps the undo point", async () => {
	const trash = trashAccepts();
	const view = await build(trash);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await submitPrompt(view, "second question");
		persistAbortedTurn(view);
		view.setIdle(true);
		await view.pickAndRewind(1);
		const rewoundEntries = await view.entriesOnDisk();
		const rewoundLeaf = view.manager.getLeafId();
		view.cancelNextNavigation();

		await assert.rejects(() => view.command("undo"), /Undo was cancelled/);

		assert.deepEqual(await view.entriesOnDisk(), rewoundEntries);
		assert.equal(view.manager.getLeafId(), rewoundLeaf);
		assert.equal((await view.backupsOnDisk()).length, 1);
		await view.command("undo");
		assert.match(view.notes.at(-1) ?? "", /Restored the conversation/);
	} finally {
		await view.cleanup();
	}
});

test("a veto handler append wins over undo rollback", async () => {
	const trash = trashAccepts();
	const view = await build(trash);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await submitPrompt(view, "second question");
		persistAbortedTurn(view);
		view.setIdle(true);
		await view.pickAndRewind(1);
		view.appendAndCancelNextNavigation();

		await view.command("undo");

		assert.ok(
			view.manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "veto-owner-state"),
			"the veto owner's append stays authoritative",
		);
		assert.ok(
			(await view.entriesOnDisk()).some((entry) => entry.type === "custom" && entry.customType === "veto-owner-state"),
			"checked rollback does not overwrite the appended JSONL entry",
		);
		assert.match(view.notes.at(-1) ?? "", /newer session was kept/);
		await view.command("undo");
		assert.match(view.notes.at(-1) ?? "", /No rewind is available to undo/);
	} finally {
		await view.cleanup();
	}
});

test("a changed session invalidates undo instead of overwriting later work", async () => {
	const trash = trashAccepts();
	const view = await build(trash);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await submitPrompt(view, "second question");
		persistAbortedTurn(view);
		view.setIdle(true);
		await view.pickAndRewind(1);

		view.manager.appendCustomEntry("later-work", { kept: true });
		await view.command("undo");

		assert.ok(view.manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "later-work"));
		assert.match(view.notes.at(-1) ?? "", /can no longer be undone/);
		assert.deepEqual(await view.backupsOnDisk(), []);
	} finally {
		await view.cleanup();
	}
});

test("a changed undo backup is rejected without replacing the rewound session", async () => {
	const trash = trashRefuses();
	const view = await build(trash);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await submitPrompt(view, "second question");
		persistAbortedTurn(view);
		view.setIdle(true);
		await view.pickAndRewind(1);
		const rewoundEntries = await view.entriesOnDisk();
		const [backup] = await view.backupsOnDisk();
		assert.ok(backup);
		writeFileSync(join(view.dir, backup), "tampered\n", "utf8");

		await view.command("undo");

		assert.deepEqual(await view.entriesOnDisk(), rewoundEntries);
		assert.match(view.notes.at(-1) ?? "", /backup changed and was not restored/);
		assert.equal(view.levels.at(-1), "warning");
	} finally {
		await view.cleanup();
	}
});

test("a Trash refusal on session shutdown keeps the undo backup and names it", async () => {
	const trash = trashRefuses();
	const view = await build(trash);
	try {
		await view.emit("session_start", { type: "session_start", reason: "startup" });
		await submitPrompt(view, "second question");
		persistAbortedTurn(view);
		view.setIdle(true);
		await view.pickAndRewind(1);

		await view.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		const backups = await view.backupsOnDisk();
		assert.equal(backups.length, 1, "the refused undo snapshot remains on disk");
		assert.equal(trash.calls.length, 1);
		assert.equal(view.levels.at(-1), "warning");
		assert.ok((view.notes.at(-1) ?? "").includes(backups[0]!));
	} finally {
		await view.cleanup();
	}
});

test("a run that ends or a session that shuts down disarms the pending Escape", async () => {
	const view = await build();
	try {
		await submitPrompt(view, "second question");
		await view.emit("agent_end", { type: "agent_end", messages: [] });
		view.decoratedEditor().handleInput(ESCAPE);
		assert.deepEqual(view.submitted, [], "a finished run is Pi's normal cancel territory");

		await submitPrompt(view, "third question");
		await view.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
		view.decoratedEditor().handleInput(ESCAPE);
		assert.deepEqual(view.submitted, [], "a replaced session cannot rewind the old turn");
	} finally {
		await view.cleanup();
	}
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("concurrent pickers for the same target execute one rewind and release the guard for undo", async () => {
	const view = await build();
	const selected = deferred();
	const release = deferred();
	try {
		view.afterPickerClosed(() => { selected.resolve(); return release.promise; });
		const first = view.command("");
		await selected.promise;
		await view.command("");
		assert.equal(view.pickerCount, 1, "the later request is dropped before it captures stale choices");
		release.resolve();
		await first;
		assert.deepEqual(view.navigations, ["u1"]);
		assert.equal((await view.backupsOnDisk()).length, 1);
		await view.command("undo");
		assert.match(view.notes.at(-1) ?? "", /Restored the conversation/);
	} finally {
		release.resolve();
		await view.cleanup();
	}
});

for (const missing of [true, false]) {
	test(`a picker target ${missing ? "removed from the file" : "moved off the active branch"} is ignored`, async () => {
		const view = await build();
		try {
			view.afterPickerClosed(() => {
				if (missing) {
					writeFileSync(view.sessionFile, baseSession().split("\n").filter((row) => !row.includes('"type":"message"') && !row.includes('"id":"sep1"')).join("\n"));
					view.manager.setSessionFile(view.sessionFile);
				} else view.manager.branch("name");
			});
			await assert.doesNotReject(() => view.command(""));
			assert.deepEqual(view.navigations, []);
			assert.deepEqual(await view.backupsOnDisk(), []);
			assert.match(view.notes.at(-1) ?? "", /no longer on the current path/);
			assert.equal(view.levels.at(-1), "info");
		} finally {
			await view.cleanup();
		}
	});
}

test("pending rewind announces progress before idle, swallows repeated Escape and ignores picker reentry", async () => {
	const view = await build();
	const idle = deferred();
	try {
		const userId = await submitPrompt(view, "second question");
		const editor = view.decoratedEditor();
		editor.handleInput(ESCAPE);
		view.setWaitForIdle(() => idle.promise);
		const first = view.command("--pending-connection");
		assert.deepEqual(view.statuses, ["Rewinding… Enter sends after rewind completes."], "feedback precedes abort settling");
		view.setIdle(true);
		for (let repeat = 0; repeat < 8; repeat++) editor.handleInput(ESCAPE);
		assert.deepEqual(view.submitted, ["/rewind --pending-connection"]);
		await view.command("");
		assert.equal(view.pickerCount, 0);
		persistAbortedTurn(view);
		idle.resolve();
		await first;
		assert.deepEqual(view.navigations, [userId]);
		assert.deepEqual(view.statuses, ["Rewinding… Enter sends after rewind completes.", undefined]);
	} finally {
		idle.resolve();
		await view.cleanup();
	}
});

test("a target invalidated while waiting for idle is ignored and errors release progress and the guard", async () => {
	const view = await build();
	try {
		view.setIdle(false);
		view.setWaitForIdle(async () => { view.manager.branch("name"); });
		await view.command("");
		assert.deepEqual(view.navigations, []);
		assert.match(view.notes.at(-1) ?? "", /no longer on the current path/);

		await submitPrompt(view, "second question");
		view.decoratedEditor().handleInput(ESCAPE);
		view.setWaitForIdle(async () => { throw new Error("idle failed"); });
		await assert.rejects(() => view.command("--pending-connection"), /idle failed/);
		assert.deepEqual(view.statuses, ["Rewinding… Enter sends after rewind completes.", undefined]);
		view.setIdle(true);
		view.setPanelInputs([ESCAPE]);
		await view.command("");
		assert.equal(view.pickerCount, 2, "the failed pending command does not leave the guard locked");
	} finally {
		await view.cleanup();
	}
});

for (const key of ["\r", "\x1b\r"]) for (const outcome of ["success", "edited", "failed"] as const) {
	test(`${key === "\r" ? "Enter" : "Alt+Enter"} after navigation restores text: ${outcome}`, async () => {
		const view = await build();
		try {
			await submitPrompt(view, "second question");
			const editor = view.decoratedEditor();
			editor.handleInput(ESCAPE);
			const sends: string[] = [];
			view.onEditorSubmit((text) => {
				sends.push(text);
				view.manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 9 });
			});
			view.afterNavigation(() => {
				// Public TUI navigateTree restores this text before returning.
				view.setEditorText("second question");
				editor.handleInput(key);
				editor.handleInput(key);
				assert.equal(view.editorText, "second question");
				assert.deepEqual(sends, [], "nothing is sent before file commit");
				if (outcome === "edited") editor.handleInput(" edited");
				if (outcome === "failed") {
					const reload = view.manager.setSessionFile.bind(view.manager);
					view.manager.setSessionFile = () => {
						view.manager.setSessionFile = reload;
						throw new Error("injected reload failure");
					};
				}
			});
			if (outcome === "failed") await assert.rejects(() => view.command("--pending-connection"), /injected reload failure/);
			else await view.command("--pending-connection");
			if (outcome === "success") {
				assert.deepEqual(sends, ["second question"]);
				const disk = await view.entriesOnDisk();
				const users = disk.filter((entry) => entry.type === "message" && (entry.message as { role: string }).role === "user");
				assert.equal(users.length, 2, "the newly sent user remains in the committed file");
				assert.equal(view.editorText, "");
			} else {
				assert.deepEqual(sends, []);
				assert.equal(view.editorText, outcome === "edited" ? "second question edited" : "second question");
			}
		} finally {
			await view.cleanup();
		}
	});
}
