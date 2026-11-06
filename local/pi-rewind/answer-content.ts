import type { MessageStartEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
	/** Streaming providers buffer raw tool arguments here before parsing them. */
	partialJson?: unknown;
};

function isFilled(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * A tool call is real work the moment the provider names the tool or streams an
 * argument, so it must never be rewound as if nothing had happened. An empty
 * placeholder block is not enough.
 */
function toolCallStarted(block: ContentBlock): boolean {
	if (isFilled(block.name) || isFilled(block.partialJson)) return true;
	const args = block.arguments;
	return typeof args === "object" && args !== null && Object.keys(args).length > 0;
}

/** Pure: does this one content block hold answer content the user would lose? */
export function blockHasAnswerContent(block: unknown): boolean {
	if (typeof block !== "object" || block === null) return false;
	const candidate = block as ContentBlock;
	if (candidate.type === "text") return isFilled(candidate.text);
	if (candidate.type === "thinking") return isFilled(candidate.thinking);
	if (candidate.type === "toolCall") return toolCallStarted(candidate);
	return false;
}

function contentHasAnswer(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim().length > 0;
	return Array.isArray(content) && content.some(blockHasAnswerContent);
}

type StreamEvent = {
	type?: unknown;
	delta?: unknown;
	content?: unknown;
	toolCall?: unknown;
	partial?: unknown;
};

/**
 * Has the answer itself begun, or is the turn still only a submitted prompt?
 *
 * A provider opens an empty block before its first token and streams that
 * emptiness: `text_start` pushes `{type:"text",text:""}` and `thinking_start`
 * pushes `{type:"thinking",thinking:""}`, each emitted right away
 * (pi-ai `api/openai-responses-shared.js:344-363`, `api/anthropic-messages.js:408-427`),
 * and `pi-agent-core/dist/agent-loop.js:209-226` turns every one of them into a
 * `message_update`. A delta can carry an empty string too. Treating any of those
 * as the answer closed the one-Escape rewind window before a single character
 * existed. The SDK's generic `start` never reaches here at all: `agent-loop.js:203-207`
 * maps it to `message_start`.
 *
 * So the type alone decides nothing. The partial message decides: whatever the
 * event says, an update that already carries non-empty text, thinking, or a
 * named tool call ends the window.
 */
export function hasAnswerContent(
	event: Pick<MessageUpdateEvent, "message"> & Partial<Pick<MessageUpdateEvent, "assistantMessageEvent">>,
): boolean {
	if (contentHasAnswer(event.message)) return true;
	const streamed = event.assistantMessageEvent as StreamEvent | undefined;
	if (!streamed) return false;
	if (contentHasAnswer(streamed.partial)) return true;
	// The partial above normally already holds the delta; these keep a provider
	// that emits the delta before mutating its block from slipping through.
	if (streamed.type === "text_delta" || streamed.type === "thinking_delta") return isFilled(streamed.delta);
	if (streamed.type === "toolcall_delta") return typeof streamed.delta === "string" && streamed.delta.length > 0;
	if (streamed.type === "text_end" || streamed.type === "thinking_end") return isFilled(streamed.content);
	if (streamed.type === "toolcall_end") return streamed.toolCall != null;
	return false;
}

/**
 * Non-streaming providers skip `message_update` entirely: `agent-loop.js:228-239`
 * emits a `message_start` carrying the finished answer. That answer is content.
 */
export function startHasAnswerContent(event: Pick<MessageStartEvent, "message">): boolean {
	return contentHasAnswer(event.message);
}
