import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectDialogueChoices, collectRewindChoices, oneLine, rewindEditorContent } from "../conversation.ts";

const entries = [
	{ type: "message", id: "u1", parentId: null, timestamp: "x", message: {
		role: "user", content: [{ type: "text", text: "first\nquestion" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 1,
	} },
	{ type: "message", id: "a-tool", parentId: "u1", timestamp: "x", message: {
		role: "assistant", content: [{ type: "text", text: "checking" }, { type: "toolCall", id: "c", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 2,
	} },
	{ type: "message", id: "tool", parentId: "a-tool", timestamp: "x", message: {
		role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 3,
	} },
	{ type: "message", id: "a1", parentId: "tool", timestamp: "x", message: {
		role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final answer" }], stopReason: "stop", timestamp: 4,
	} },
	{ type: "custom", id: "custom", parentId: "a1", timestamp: "x", customType: "state", data: {} },
	{ type: "message", id: "u2", parentId: "custom", timestamp: "x", message: {
		role: "user", content: "next", timestamp: 5,
	} },
	{ type: "message", id: "u3", parentId: "u2", timestamp: "x", message: {
		role: "user", content: [{ type: "image", data: "y", mimeType: "image/png" }], timestamp: 6,
	} },
] as SessionEntry[];

test("the rewind list contains user prompts only and retains their preceding leaf", () => {
	assert.deepEqual(collectRewindChoices(entries), [
		{ entryId: "u1", role: "user", text: "first\nquestion\n[Image]", retainThroughId: null, editorText: "first\nquestion\n[Image]", hasImages: true },
		{ entryId: "u2", role: "user", text: "next", retainThroughId: "custom", editorText: "next", hasImages: false },
		{ entryId: "u3", role: "user", text: "[Image]", retainThroughId: "u2", editorText: "[Image]", hasImages: true },
	]);
});

test("rewind editor text hides Pi clipboard paths without changing ordinary paths", () => {
	const clipboard = "/var/folders/test/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png";
	assert.deepEqual(rewindEditorContent(`inspect ${clipboard}`), {
		text: "inspect [Image]",
		editorText: `inspect ${clipboard}`,
		hasImages: true,
	});
	assert.deepEqual(rewindEditorContent("inspect /tmp/screenshot.png"), {
		text: "inspect /tmp/screenshot.png",
		editorText: "inspect /tmp/screenshot.png",
		hasImages: false,
	});
});

test("row previews collapse whitespace", () => {
	assert.equal(oneLine(" alpha\n  beta\t gamma "), "alpha beta gamma");
});

test("archive dialogue statistics still include completed answers", () => {
	assert.deepEqual(collectDialogueChoices(entries).map(({ entryId }) => entryId), ["u1", "a1", "u2", "u3"]);
});
