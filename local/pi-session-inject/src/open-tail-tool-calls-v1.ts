/**
 * Scan the active branch for unresolved tool calls in its current message tail.
 *
 * Non-message entries (including compaction and custom_message) are ignored.
 * Each assistant message resets the set and seeds it with its toolCall ids,
 * unless it aborted/errored. A matching toolResult removes one id; any other
 * message role (including user and system) clears the set. The remaining ids
 * are tool calls from the latest assistant message whose results have not landed.
 *
 * Scheduler injection and subagent delivery share this tail predicate. It is
 * not a whole-branch audit of all unpaired calls: a fresh assistant or other
 * non-toolResult message clears earlier calls even in malformed history.
 * Callers that require fail-closed history validation must audit separately.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** The library only needs the active branch; live contexts expose this read-only shape. */
export type BranchSession = Pick<SessionManager, "getBranch">;

export function openTailToolCallIds(session: BranchSession): readonly string[] {
  const open = new Set<string>();
  for (const entry of session.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      open.clear();
      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        for (const block of message.content) {
          if (block.type === "toolCall") open.add(block.id);
        }
      }
    } else if (message.role === "toolResult") {
      open.delete(message.toolCallId);
    } else {
      open.clear();
    }
  }
  return Object.freeze([...open]);
}
