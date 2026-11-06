import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ConversationRole = "user" | "assistant";

export interface RewindChoice {
	entryId: string;
	role: ConversationRole;
	text: string;
	/** Path leaf retained after rewind. Null means retain only the session header. */
	retainThroughId: string | null;
	/** Source passed through the editor owner; picker previews use the sanitized `text`. */
	editorText?: string;
	hasImages: boolean;
}

type ContentBlock = {
	type?: unknown;
	text?: unknown;
};

const PI_CLIPBOARD_IMAGE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)(?:[^\s/\\]+[\\/])*pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|gif|webp|bmp)/gi;

/**
 * Pi inserts clipboard images as `pi-clipboard-<uuid>.<ext>` paths.
 * Picker text never exposes their paths. Editor source retains paths so the
 * active editor owner can rebuild atomic image markers; image blocks without a
 * recoverable path remain plain `[Image]` placeholders.
 */
export function rewindEditorContent(text: string, imageCount = 0): {
	text: string;
	editorText: string;
	hasImages: boolean;
} {
	let pathCount = 0;
	const preview = text.replace(PI_CLIPBOARD_IMAGE_PATH_RE, () => {
		pathCount += 1;
		return "[Image]";
	});
	const missingImageCount = Math.max(0, imageCount - pathCount);
	const markers = Array.from({ length: missingImageCount }, () => "[Image]");
	return {
		text: [preview, ...markers].filter(Boolean).join("\n"),
		editorText: [text, ...markers].filter(Boolean).join("\n"),
		hasImages: pathCount > 0 || imageCount > 0,
	};
}

function userContentText(content: unknown): { text: string; editorText: string; hasImages: boolean } {
	if (typeof content === "string") return rewindEditorContent(content);
	if (!Array.isArray(content)) return { text: "", editorText: "", hasImages: false };
	const text = content
		.filter((block): block is ContentBlock =>
			typeof block === "object" && block !== null && (block as ContentBlock).type === "text",
		)
		.map((block) => typeof block.text === "string" ? block.text : "")
		.filter(Boolean)
		.join("\n");
	const imageCount = content.filter((block) =>
		typeof block === "object" && block !== null && (block as ContentBlock).type === "image",
	).length;
	return rewindEditorContent(text, imageCount);
}

function assistantContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is ContentBlock =>
			typeof block === "object" && block !== null && (block as ContentBlock).type === "text",
		)
		.map((block) => typeof block.text === "string" ? block.text : "")
		.filter(Boolean)
		.join("\n");
}

export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Build a linear picker from the active branch. Tool results, custom messages,
 * thinking, and assistant tool-use hops are deliberately not conversation rows.
 */
export function collectDialogueChoices(entries: readonly SessionEntry[]): RewindChoice[] {
	const choices: RewindChoice[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		if (message.role === "assistant" && message.stopReason === "toolUse") continue;
		if (message.role === "user") {
			const content = userContentText(message.content);
			const text = content.text.trim();
			if (!text) continue;
			choices.push({
				entryId: entry.id,
				role: "user",
				text,
				retainThroughId: entry.parentId,
				editorText: content.editorText.trim(),
				hasImages: content.hasImages,
			});
			continue;
		}
		const text = assistantContentText(message.content).trim();
		if (!text) continue;
		choices.push({
			entryId: entry.id,
			role: "assistant",
			text,
			retainThroughId: entry.id,
			hasImages: false,
		});
	}
	return choices;
}

/** Rewind targets are user prompts; completed answers remain archive statistics only. */
export function collectRewindChoices(entries: readonly SessionEntry[]): RewindChoice[] {
	return collectDialogueChoices(entries).filter((choice) => choice.role === "user");
}
