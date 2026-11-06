import assert from "node:assert/strict";
import test from "node:test";
import { blockHasAnswerContent, hasAnswerContent, startHasAnswerContent } from "../answer-content.ts";

/** The partial an assistant message carries while a provider streams it. */
function update(content: unknown, streamed?: Record<string, unknown>) {
	return {
		message: { role: "assistant", content },
		...(streamed ? { assistantMessageEvent: streamed as never } : {}),
	} as never;
}

test("the empty blocks a provider opens before its first token are not an answer", () => {
	// pi-ai pushes {type:"text",text:""} / {type:"thinking",thinking:""} and emits
	// text_start / thinking_start immediately; agent-loop forwards both as message_update.
	assert.equal(
		hasAnswerContent(update([{ type: "text", text: "" }], { type: "text_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text: "" }] } })),
		false,
	);
	assert.equal(
		hasAnswerContent(update([{ type: "thinking", thinking: "" }], { type: "thinking_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } })),
		false,
	);
	assert.equal(
		hasAnswerContent(update([{ type: "text", text: "" }], { type: "text_delta", contentIndex: 0, delta: "", partial: { role: "assistant", content: [{ type: "text", text: "" }] } })),
		false,
	);
	assert.equal(
		hasAnswerContent(update([{ type: "thinking", thinking: " " }], { type: "thinking_delta", contentIndex: 0, delta: " ", partial: { role: "assistant", content: [{ type: "thinking", thinking: " " }] } })),
		false,
	);
	assert.equal(hasAnswerContent(update([])), false);
});

test("the first non-empty text or thinking is the answer", () => {
	assert.equal(
		hasAnswerContent(update([{ type: "text", text: "H" }], { type: "text_delta", contentIndex: 0, delta: "H", partial: { role: "assistant", content: [{ type: "text", text: "H" }] } })),
		true,
	);
	assert.equal(
		hasAnswerContent(update([{ type: "thinking", thinking: "Let me" }], { type: "thinking_delta", contentIndex: 0, delta: "Let me", partial: { role: "assistant", content: [{ type: "thinking", thinking: "Let me" }] } })),
		true,
	);
	// Redacted reasoning arrives as a filled thinking block with no delta.
	assert.equal(
		hasAnswerContent(update([{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }], { type: "thinking_start", contentIndex: 0, partial: { role: "assistant", content: [] } })),
		true,
	);
});

test("a content-carrying update closes the window whatever its type says", () => {
	// The first event an extension sees can already hold streamed content.
	assert.equal(hasAnswerContent(update([{ type: "text", text: "already here" }])), true);
	assert.equal(
		hasAnswerContent(update([], { type: "text_start", contentIndex: 1, partial: { role: "assistant", content: [{ type: "text", text: "in the partial only" }] } })),
		true,
	);
	assert.equal(hasAnswerContent(update("a plain string answer")), true);
});

test("a tool call counts from its name or its first argument, not from the placeholder", () => {
	assert.equal(blockHasAnswerContent({ type: "toolCall", id: "c1", name: "", arguments: {}, partialJson: "" }), false);
	assert.equal(blockHasAnswerContent({ type: "toolCall", id: "c1", name: "bash", arguments: {} }), true);
	assert.equal(blockHasAnswerContent({ type: "toolCall", id: "c1", name: "", arguments: {}, partialJson: '{"cmd' }), true);
	assert.equal(blockHasAnswerContent({ type: "toolCall", id: "c1", name: "", arguments: { cmd: "ls" } }), true);
	assert.equal(
		hasAnswerContent(update([{ type: "toolCall", id: "c1", name: "", arguments: {}, partialJson: "" }], { type: "toolcall_delta", contentIndex: 0, delta: "{", partial: { role: "assistant", content: [] } })),
		true,
	);
});

test("unknown or malformed blocks are never mistaken for an answer", () => {
	assert.equal(blockHasAnswerContent(null), false);
	assert.equal(blockHasAnswerContent("text"), false);
	assert.equal(blockHasAnswerContent({ type: "image", data: "..." }), false);
	assert.equal(blockHasAnswerContent({ type: "text" }), false);
	assert.equal(hasAnswerContent({ message: {} } as never), false);
});

test("a non-streaming provider's finished message_start is already the answer", () => {
	// agent-loop emits message_start with the final message when nothing streamed.
	assert.equal(startHasAnswerContent({ message: { role: "assistant", content: [] } } as never), false);
	assert.equal(
		startHasAnswerContent({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } } as never),
		true,
	);
});
