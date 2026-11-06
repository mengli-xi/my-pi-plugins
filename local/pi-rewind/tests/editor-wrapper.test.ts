import assert from "node:assert/strict";
import test from "node:test";
import { Editor, getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { decorateRewindEditor, RewindSubmissionGuard } from "../editor-wrapper.ts";

function harness(options: { idle?: boolean; text?: string; pendingConnection?: boolean } = {}) {
	let now = 1_000;
	let idle = options.idle ?? true;
	let text = options.text ?? "";
	let pendingConnection = options.pendingConnection ?? false;
	let rewinding = false;
	const submissions = new RewindSubmissionGuard();
	const submitted: string[] = [];
	const delegated: string[] = [];
	const autocompleteState = { open: true };
	const autocompleteList = { render: () => ["menu"] };
	const inner = {
		onSubmit: (value: string): void => { submitted.push(value); },
		autocompleteState,
		autocompleteList,
		focused: true,
		render: () => ["editor"],
		handleInput: (data: string) => {
			delegated.push(data);
			if (data === "\r" || data === "follow-up-key") {
				const value = text;
				text = "";
				inner.onSubmit(value);
			}
			else if (data !== "\x1b") text += data;
		},
		getText: () => text,
		setText: (value: string) => { text = value; },
		invalidate() {},
	};
	const editor = decorateRewindEditor(inner, {
		matches: (data, action) => (action === "app.interrupt" && data === "\x1b")
			|| (action === "tui.input.submit" && data === "\r")
			|| (action === "app.message.followUp" && data === "follow-up-key")
			|| (action === "tui.input.newLine" && data === "\n"),
	}, {
		isIdle: () => idle,
		isRewindInProgress: () => rewinding,
		submissionGuard: submissions,
		requestPendingConnectionRewind: () => {
			if (!pendingConnection) return false;
			pendingConnection = false;
			return true;
		},
		now: () => now,
	});
	return {
		inner,
		editor,
		submitted,
		delegated,
		submissions,
		autocompleteState,
		autocompleteList,
		advance(ms: number) { now += ms; },
		setIdle(value: boolean) { idle = value; },
		setRewinding(value: boolean) { rewinding = value; },
	};
}

test("decoration preserves editor identity and autocomplete discovery fields", () => {
	const view = harness();
	assert.strictEqual(view.editor, view.inner);
	assert.strictEqual(view.editor.autocompleteState, view.autocompleteState);
	assert.strictEqual(view.editor.autocompleteList, view.autocompleteList);
});

test("Enter during rewrite leaves text intact and repeated Enter replays one native submit on success", () => {
	const view = harness({ text: "restored prompt" });
	view.submissions.begin();
	view.editor.handleInput("\r");
	view.editor.handleInput("\r");
	assert.equal(view.editor.getText(), "restored prompt");
	assert.deepEqual(view.submitted, []);
	assert.deepEqual(view.delegated, ["\r", "\r"]);
	view.submissions.finish(true);
	view.submissions.finish(true);
	assert.deepEqual(view.submitted, ["restored prompt"]);
});

test("editing after a deferred Enter cancels auto-send even if the text is changed back", () => {
	const view = harness({ text: "restored prompt" });
	view.submissions.begin();
	view.editor.handleInput("\r");
	view.editor.handleInput(" edited");
	view.editor.setText("restored prompt");
	view.submissions.finish(true);
	assert.equal(view.editor.getText(), "restored prompt");
	assert.deepEqual(view.submitted, []);
});

test("failed or cancelled rewrite keeps deferred text and never submits it", () => {
	const view = harness({ text: "restored prompt" });
	view.submissions.begin();
	view.editor.handleInput("\r");
	view.submissions.finish(false);
	assert.equal(view.editor.getText(), "restored prompt");
	assert.deepEqual(view.submitted, []);
	view.submissions.begin();
	view.submissions.finish(true);
	assert.deepEqual(view.submitted, [], "a failed operation cannot leak a submit into the next one");
});

for (const outcome of ["success", "edited", "failed"] as const) {
	test(`a rebound follow-up action is deferred and replayed natively: ${outcome}`, () => {
		const view = harness({ text: "restored prompt" });
		view.submissions.begin();
		view.editor.handleInput("follow-up-key");
		view.editor.handleInput("follow-up-key");
		assert.deepEqual(view.delegated, ["follow-up-key", "follow-up-key"]);
		assert.equal(view.editor.getText(), "restored prompt");
		if (outcome === "edited") view.editor.handleInput(" edited");
		view.submissions.finish(outcome !== "failed");
		assert.deepEqual(view.submitted, outcome === "success" ? ["restored prompt"] : []);
		assert.deepEqual(view.delegated, ["follow-up-key", "follow-up-key", ...(outcome === "edited" ? [" edited"] : [])]);
	});
}

test("ordinary newlines remain immediate and are not merged or lost before further typing", () => {
	const view = harness({ text: "restored prompt" });
	view.submissions.begin();
	for (let count = 1; count <= 3; count++) {
		view.editor.handleInput("\n");
		assert.equal(view.editor.getText(), `restored prompt${"\n".repeat(count)}`);
	}
	view.editor.handleInput("next");
	assert.equal(view.editor.getText(), "restored prompt\n\n\nnext");
	view.submissions.finish(true);
	assert.equal(view.editor.getText(), "restored prompt\n\n\nnext");
	assert.deepEqual(view.submitted, []);
});

for (const data of ["\r", "\n"]) test(`native backslash+Enter fallback is held and replayed once: ${JSON.stringify(data)}`, () => {
	const previous = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.input.submit": "shift+enter",
		"tui.input.newLine": ["enter", "ctrl+j"],
	});
	setKeybindings(keybindings);
	try {
		const editor = new Editor({ requestRender() {} } as never, {} as never);
		const submitted: string[] = [];
		editor.onSubmit = (text) => { submitted.push(text); };
		editor.setText("restored prompt\\");
		const submissions = new RewindSubmissionGuard();
		decorateRewindEditor(editor, keybindings, { isIdle: () => true, submissionGuard: submissions });
		submissions.begin();
		editor.handleInput(data);
		editor.onSubmit?.("restored prompt");
		editor.onSubmit?.("restored prompt");
		assert.deepEqual(submitted, []);
		assert.equal(editor.getText(), "restored prompt", "retain the actual native submission result");
		submissions.finish(true);
		assert.deepEqual(submitted, ["restored prompt"]);
	} finally {
		setKeybindings(previous);
	}
});

const nativeNewlineCases: Array<{
	name: string;
	bindings?: KeybindingsConfig;
	text: string;
	inputs: string[];
	expected: string;
	disableSubmit?: boolean;
}> = [
	{ name: "Ctrl+J repeated then text", text: "prompt", inputs: ["\n", "\n", "\n", "next"], expected: "prompt\n\n\nnext" },
	{ name: "Shift+Enter repeated then text", text: "prompt", inputs: ["\x1b[13;2u", "\x1b[13;2u", "next"], expected: "prompt\n\nnext" },
	{ name: "ordinary Enter after backslash", text: "prompt\\", inputs: ["\r", "next"], expected: "prompt\nnext" },
	{ name: "rebound Enter without backslash", bindings: { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" }, text: "prompt", inputs: ["\r", "\r", "next"], expected: "prompt\n\nnext" },
	{ name: "newline without Shift+Enter submit binding", bindings: { "tui.input.submit": "ctrl+enter", "tui.input.newLine": "enter" }, text: "prompt\\", inputs: ["\r"], expected: "prompt\\\n" },
	{ name: "backslash not before cursor", bindings: { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" }, text: "prompt\\suffix", inputs: ["\r"], expected: "prompt\\suffix\n" },
	{ name: "disabled fallback submit", bindings: { "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" }, text: "prompt\\", inputs: ["\r"], expected: "prompt\\\n", disableSubmit: true },
	{ name: "forced LF after remapping newline", bindings: { "tui.input.newLine": "ctrl+o" }, text: "prompt", inputs: ["\n", "\n", "\n", "next"], expected: "prompt\n\n\nnext" },
];

for (const scenario of nativeNewlineCases) {
	test(`native newline is immediate during rewind: ${scenario.name}`, () => {
		const previous = getKeybindings();
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, scenario.bindings);
		setKeybindings(keybindings);
		try {
			const editor = new Editor({ requestRender() {} } as never, {} as never);
			const submitted: string[] = [];
			editor.onSubmit = (text) => { submitted.push(text); };
			editor.disableSubmit = scenario.disableSubmit ?? false;
			editor.setText(scenario.text);
			const submissions = new RewindSubmissionGuard();
			decorateRewindEditor(editor, keybindings, { isIdle: () => true, submissionGuard: submissions });
			submissions.begin();
			for (const data of scenario.inputs) {
				const before = editor.getText();
				editor.handleInput(data);
				assert.notEqual(editor.getText(), before, "native editing must happen before finish");
			}
			assert.equal(editor.getText(), scenario.expected);
			submissions.finish(true);
			assert.equal(editor.getText(), scenario.expected);
			assert.deepEqual(submitted, []);
		} finally {
			setKeybindings(previous);
		}
	});
}

test("unbound LF fallback submits through the protected exit after remapping newline", () => {
	const previous = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.input.submit": "shift+enter", "tui.input.newLine": "ctrl+o",
	});
	setKeybindings(keybindings);
	try {
		const editor = new Editor({ requestRender() {} } as never, {} as never);
		const submitted: string[] = [];
		const submissions = new RewindSubmissionGuard();
		decorateRewindEditor(editor, keybindings, { isIdle: () => true, submissionGuard: submissions });
		editor.onSubmit = (text) => { submitted.push(text); };
		editor.setText("prompt\\");
		submissions.begin();
		editor.handleInput("\n");
		assert.deepEqual(submitted, []);
		assert.equal(editor.getText(), "prompt");
		submissions.finish(true);
		assert.deepEqual(submitted, ["prompt"]);
		assert.equal(editor.getText(), "");
	} finally {
		setKeybindings(previous);
	}
});

test("a newline after an actual LF fallback stays native editing and cancels the held submission", () => {
	const previous = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.input.submit": "shift+enter", "tui.input.newLine": "ctrl+o",
	});
	setKeybindings(keybindings);
	try {
		const editor = new Editor({ requestRender() {} } as never, {} as never);
		const submitted: string[] = [];
		const submissions = new RewindSubmissionGuard();
		decorateRewindEditor(editor, keybindings, { isIdle: () => true, submissionGuard: submissions });
		editor.onSubmit = (text) => { submitted.push(text); };
		editor.setText("prompt\\");
		submissions.begin();
		editor.handleInput("\n");
		assert.equal(editor.getText(), "prompt");
		editor.handleInput("\n");
		assert.equal(editor.getText(), "prompt\n");
		submissions.finish(true);
		assert.equal(editor.getText(), "prompt\n");
		assert.deepEqual(submitted, []);
	} finally {
		setKeybindings(previous);
	}
});

test("later onSubmit assignments stay protected and clear input only on successful release", () => {
	const view = harness({ text: "draft" });
	const sent: string[] = [];
	view.editor.onSubmit = (text) => { sent.push(text); };
	view.submissions.begin();
	view.editor.handleInput("\r");
	assert.equal(view.editor.getText(), "draft");
	assert.deepEqual(sent, []);
	view.submissions.finish(true);
	assert.deepEqual(sent, ["draft"]);
	assert.equal(view.editor.getText(), "");
});

test("another decorator can wrap the previous onSubmit without a forwarding loop", () => {
	const view = harness({ text: "draft" });
	const previous = view.editor.onSubmit!;
	const wrapped: string[] = [];
	view.editor.onSubmit = (text) => { wrapped.push(text); previous(text); };
	view.editor.onSubmit = view.editor.onSubmit;
	view.submissions.begin();
	view.editor.handleInput("\r");
	assert.deepEqual(view.submitted, []);
	view.submissions.finish(true);
	assert.deepEqual(view.submitted, ["draft"]);
	assert.deepEqual(wrapped, ["draft"]);
});

test("copying onSubmit to another editor uses its guard and preserves the native receiver", () => {
	const first = harness({ text: "first draft" });
	const second = harness({ text: "second draft" });
	const sent: Array<{ receiver: unknown; text: string }> = [];
	first.editor.onSubmit = function (this: unknown, text) { sent.push({ receiver: this, text }); };
	second.editor.onSubmit = first.editor.onSubmit;
	first.submissions.begin();
	second.submissions.begin();
	second.editor.handleInput("\r");
	assert.equal(first.editor.getText(), "first draft");
	assert.equal(second.editor.getText(), "second draft");
	assert.deepEqual(sent, []);
	second.submissions.finish(true);
	assert.deepEqual(sent, [{ receiver: second.editor, text: "second draft" }]);
	first.submissions.finish(false);
});

test("an existing public submit accessor expands its payload before deferral and remains active on reassignment", () => {
	let text = "[image]";
	let ownerSubmit: ((text: string) => void) | undefined;
	const editor = {
		onSubmit: undefined as ((text: string) => void) | undefined,
		getText: () => text,
		setText: (value: string) => { text = value; },
		handleInput(_data: string) { const value = text; text = ""; editor.onSubmit?.(value); },
		render: () => [], invalidate() {},
	};
	Object.defineProperty(editor, "onSubmit", {
		configurable: true,
		get: () => ownerSubmit,
		set: (handler: ((text: string) => void) | undefined) => {
			ownerSubmit = handler ? (value) => handler(value.replace("[image]", "/image-source.png")) : undefined;
		},
	});
	const submissions = new RewindSubmissionGuard();
	decorateRewindEditor(editor, { matches: () => false }, { isIdle: () => true, submissionGuard: submissions });
	const sent: string[] = [];
	editor.onSubmit = (value) => { sent.push(value); };
	submissions.begin();
		editor.handleInput("\r");
	assert.equal(text, "/image-source.png");
		assert.equal(sent.length, 0);
	submissions.finish(true);
		assert.equal(sent.join("|"), "/image-source.png");
	editor.onSubmit = (value) => { sent.push(`later:${value}`); };
	editor.setText("[image]");
		editor.handleInput("\r");
	assert.deepEqual(sent, ["/image-source.png", "later:/image-source.png"]);
});

test("two idle Escapes open /rewind without reaching Pi's built-in tree action", () => {
	const view = harness();
	view.editor.handleInput("\x1b");
	view.advance(200);
	view.editor.handleInput("\x1b");
	assert.deepEqual(view.submitted, ["/rewind"]);
	assert.deepEqual(view.delegated, []);
});

test("slow Escapes restart the gesture window", () => {
	const view = harness();
	view.editor.handleInput("\x1b");
	view.advance(600);
	view.editor.handleInput("\x1b");
	assert.deepEqual(view.submitted, []);
});

test("streaming and non-empty editor input keep Pi's normal Escape behavior", () => {
	const streaming = harness({ idle: false });
	streaming.editor.handleInput("\x1b");
	assert.deepEqual(streaming.delegated, ["\x1b"]);
	const draft = harness({ text: "draft" });
	draft.editor.handleInput("\x1b");
	assert.deepEqual(draft.delegated, ["\x1b"]);
});

test("one Escape requests a direct rewind before the provider connection starts", () => {
	const view = harness({ idle: false, pendingConnection: true });
	view.editor.handleInput("\x1b");
	assert.deepEqual(view.submitted, ["/rewind --pending-connection"]);
	assert.deepEqual(view.delegated, []);

	// The reservation is one-shot; a later Escape returns to Pi's abort path.
	view.editor.handleInput("\x1b");
	assert.deepEqual(view.delegated, ["\x1b"]);
});

test("Escape repeats during rewind never reach the native editor or prime a later double Escape", () => {
	for (const text of ["", "restored prompt"]) {
		const view = harness({ idle: false, text });
		view.setRewinding(true);
		for (const idle of [false, true]) {
			view.setIdle(idle);
			for (let repeat = 0; repeat < 4; repeat++) {
				view.editor.handleInput("\x1b");
				view.advance(30);
			}
		}
		assert.deepEqual(view.submitted, []);
		assert.deepEqual(view.delegated, []);
		view.setRewinding(false);
		view.editor.handleInput("\x1b");
		assert.deepEqual(view.submitted, [], "a busy Escape does not become the first half of a later gesture");
	}
});
