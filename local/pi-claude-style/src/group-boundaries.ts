import type { ToolPresentation, ToolPresentationKind } from "./types.ts";

export type ResolvePresentation = (toolName: string, args: unknown) => ToolPresentation;

export type AssistantContentItem =
  /** `callId` marks a natively rendered call, which the store must not track. */
  | { kind: "boundary"; callId?: string }
  | {
    kind: "call";
    id: string;
    name: string;
    args: unknown;
    presentation: Exclude<ToolPresentationKind, "native">;
  };

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

// Stops at the first visible character, which ordinary text has at its start.
// Not cached: a provider may replace a block's text in place (Pi's text_end
// writes the final text into the same block), so no earlier scan stays valid.
function hasVisibleText(block: ContentBlock): boolean {
  return typeof block.text === "string" && /\S/.test(block.text);
}

/**
 * The single grouping rule for one assistant message, shared by live streaming
 * and history replay. Groups split where the message places visible text or a
 * natively rendered call, by content position. Live streaming must not use
 * arrival or execution time instead: a provider may fill an earlier text block
 * after later tool calls have started.
 */
export function assistantContentItems(
  content: readonly unknown[],
  resolvePresentation: ResolvePresentation,
): AssistantContentItem[] {
  const items: AssistantContentItem[] = [];
  for (const raw of content) {
    const block = raw as ContentBlock;
    if (block?.type === "text") {
      if (hasVisibleText(block)) items.push({ kind: "boundary" });
      continue;
    }
    if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
    const presentation = resolvePresentation(block.name, block.arguments);
    if (presentation.kind === "native") {
      items.push({ kind: "boundary", callId: block.id });
      continue;
    }
    items.push({ kind: "call", id: block.id, name: block.name, args: block.arguments, presentation: presentation.kind });
  }
  return items;
}

/**
 * What can move a group boundary in a streaming message: visible text, each
 * call's current presentation, and which calls the store tracks. Live
 * alignment reruns only when this changes rather than on every token.
 */
export function assistantItemsShape(items: readonly AssistantContentItem[], isTracked: (toolCallId: string) => boolean): string {
  let shape = "";
  for (const item of items) {
    if (item.kind === "boundary") shape += item.callId ? `|${item.callId}${isTracked(item.callId) ? "+" : ""};` : "|";
    else shape += `${item.presentation}:${item.id}${isTracked(item.id) ? "+" : ""};`;
  }
  return shape;
}

/** A tool-less or failed assistant message ends its run, and with it the group. */
export function assistantEndsGroup(message: { content: readonly unknown[]; stopReason?: unknown }): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return true;
  return !message.content.some((block) => (block as ContentBlock)?.type === "toolCall");
}
