import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { captureResult } from "./capture-result.ts";
import { assistantContentItems, assistantEndsGroup } from "./group-boundaries.ts";
import { GroupStore } from "./grouping.ts";
import { readTasks, type HostedTask } from "./todo-state.ts";
import type { CapturedResult, ToolPresentation } from "./types.ts";

export interface HistoryRebuildOptions {
  maxResultChars: number;
  resolvePresentation: (toolName: string, args: unknown) => ToolPresentation;
  isTodoTool?: (toolName: string) => boolean;
}

export interface SessionProjection {
  latestTasks?: HostedTask[];
}

function entryTimestamp(entry: SessionEntry, messageTimestamp?: unknown): number {
  if (
    typeof messageTimestamp === "number" &&
    Number.isFinite(messageTimestamp)
  ) {
    return messageTimestamp;
  }
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function terminalToolResult(stopReason: "aborted" | "error", errorMessage: unknown): CapturedResult {
  return {
    text: stopReason === "aborted"
      ? "Operation aborted"
      : typeof errorMessage === "string" && errorMessage ? errorMessage : "Error",
    truncated: false,
    isError: true,
  };
}

export function rebuildGroupsFromSession(
  entries: readonly SessionEntry[],
  store: GroupStore,
  options: HistoryRebuildOptions,
): SessionProjection {
  // During /reload Pi rebuilds chat components immediately before session_start.
  // Keep their callbacks for later live updates, but do not invoke one callback
  // per historical event: each callback can schedule a whole TUI render and make
  // large sessions effectively O(N²). Pi performs a full render after
  // session_start, so the reconstructed state is picked up in one pass.
  store.clear({ preserveInvalidators: true });

  let latestTasks: HostedTask[] | undefined;
  // A result is classified with its call's arguments, as live execution is.
  const callArgs = new Map<string, unknown>();
  store.bulkRestore((writer) => {
    for (const entry of entries) {
      if (entry.type !== "message") {
        if (entry.type === "compaction" || entry.type === "branch_summary") {
          writer.closeBoundary();
        }
        continue;
      }

      const message = entry.message;
      const timestamp = entryTimestamp(entry, message.timestamp);
      if (message.role === "user") {
        writer.closeBoundary();
        continue;
      }

      if (message.role === "assistant") {
        const terminalStopReason = message.stopReason === "aborted" || message.stopReason === "error"
          ? message.stopReason
          : undefined;
        const terminalStatus = terminalStopReason === "aborted"
          ? "cancelled"
          : terminalStopReason === "error" ? "failed" : undefined;
        for (const content of message.content) {
          if (content.type === "toolCall") callArgs.set(content.id, content.arguments);
        }
        for (const item of assistantContentItems(message.content, options.resolvePresentation)) {
          if (item.kind === "boundary") {
            writer.closeBoundary();
            continue;
          }
          writer.start(item.id, item.name, item.args, timestamp, item.presentation);
          // Pi only starts a tool at tool_execution_start. An assistant
          // batch ending error/aborted emits no such event, so its calls did not
          // run and cannot receive a native tool result. Preserve the terminal
          // fact in history rather than projecting an impossible live activity.
          if (terminalStatus !== undefined) {
            writer.end(
              item.id,
              terminalToolResult(terminalStopReason!, message.errorMessage),
              terminalStatus,
              timestamp,
            );
          }
        }
        if (assistantEndsGroup(message)) writer.closeBoundary();
        continue;
      }

      if (message.role === "toolResult") {
        if (options.isTodoTool?.(message.toolName)) {
          latestTasks = readTasks(message.details) ?? latestTasks;
        }
        // A native call's boundary was placed by its assistant content.
        const args = callArgs.get(message.toolCallId) ?? {};
        const presentation = options.resolvePresentation(message.toolName, args);
        if (presentation.kind === "native") continue;
        writer.ensure(
          message.toolCallId,
          message.toolName,
          args,
          timestamp,
          presentation.kind,
        );
        for (const child of message.nestedCalls?.calls ?? []) {
          // Pi's bounded record flattens descendants under the model-issued call.
          const duration = child.durationMs ?? 0;
          writer.start(child.id, child.name, child.arguments ?? {}, timestamp - duration, "grouped", message.toolCallId);
          writer.end(child.id, {
            text: child.error ?? "Nested result not retained in session history",
            truncated: true,
            isError: child.status === "error",
          }, child.status === "ok" ? "completed" : child.status === "error" ? "failed" : "cancelled", timestamp, child.durationMs);
        }
        writer.end(
          message.toolCallId,
          captureResult(message, message.isError, options.maxResultChars),
          message.isError ? "failed" : "completed",
          timestamp,
          message.durationMs,
        );
      }
    }
    writer.closeBoundary();
  });
  return { latestTasks };
}
