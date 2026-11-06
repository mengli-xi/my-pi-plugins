import assert from "node:assert/strict";
import test from "node:test";
import { editorSourceText } from "../editor-image-source.ts";
import { restoreEditorSource } from "../index.ts";

const KEY = Symbol.for("pi.claude-style.editor-image-source.v2");

function clear(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[KEY];
}

test("falls back to visible editor text when the image source owner is absent", () => {
	clear();
	assert.equal(editorSourceText("draft [Image #1]"), "draft [Image #1]");
});

test("reads recoverable source from the matching editor image registry", () => {
	(globalThis as Record<PropertyKey, unknown>)[KEY] = {
		version: 2,
		sourceText: (visible: string) => visible.replace("[Image #1]", "/tmp/pi-clipboard-abc.png"),
		restoredSource: () => ({ handled: true, editorText: "draft [Image #1]" }),
	};
	try {
		assert.equal(editorSourceText("draft [Image #1]"), "draft /tmp/pi-clipboard-abc.png");
	} finally {
		clear();
	}
});

test("trusts the editor owner's receipt instead of expanded public editor text", () => {
	let value = "";
	const imagePath = "/tmp/pi-clipboard-abc.png";
	(globalThis as Record<PropertyKey, unknown>)[KEY] = {
		version: 2,
		sourceText: (visible: string) => visible,
		restoredSource: (source: string) => ({ handled: source === `draft ${imagePath}`, editorText: "draft [Image #1]" }),
	};
	const ui = {
		setEditorText(text: string) { value = text; },
		getEditorText: () => `draft ${imagePath}`,
	};
	try {
		assert.deepEqual(restoreEditorSource(ui as never, `draft ${imagePath}`), { restoredImages: true });
		assert.equal(value, `draft ${imagePath}`, "successful owner handling is not overwritten by fallback text");
	} finally {
		clear();
	}
});

test("falls back to safe placeholders when the editor owner rejects any image", () => {
	let value = "";
	const first = "/tmp/pi-clipboard-aaa.png";
	const second = "/tmp/pi-clipboard-bbb.png";
	(globalThis as Record<PropertyKey, unknown>)[KEY] = {
		version: 2,
		sourceText: (visible: string) => visible,
		restoredSource: () => ({ handled: false, editorText: `draft [Image #1] ${second}` }),
	};
	const ui = {
		setEditorText(text: string) { value = text; },
		getEditorText: () => value,
	};
	try {
		assert.deepEqual(restoreEditorSource(ui as never, `draft ${first} ${second}`), { restoredImages: false });
		assert.equal(value, "draft [Image] [Image]");
	} finally {
		clear();
	}
});

test("rejects incompatible and throwing editor image registries", () => {
	(globalThis as Record<PropertyKey, unknown>)[KEY] = {
		version: 1,
		sourceText: () => "wrong",
		restoredSource: () => ({ handled: true, editorText: "wrong" }),
	};
	assert.equal(editorSourceText("draft"), "draft");
	(globalThis as Record<PropertyKey, unknown>)[KEY] = {
		version: 2,
		sourceText: () => { throw new Error("stale"); },
		restoredSource: () => { throw new Error("stale"); },
	};
	assert.equal(editorSourceText("draft"), "draft");
	assert.deepEqual(restoreEditorSource({
		setEditorText() {},
		getEditorText: () => "draft",
	} as never, "draft /tmp/pi-clipboard-abc.png"), { restoredImages: false });
	clear();
});
