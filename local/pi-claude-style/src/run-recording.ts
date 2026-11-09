import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunMetrics } from "./metrics.ts";
import { TranscriptSeparators } from "./separator-state.ts";
import type { RunStatus, SeparatorsConfig } from "./types.ts";

export function latestAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  return [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
}

export function finalRunStatus(messages: AgentMessage[]): Exclude<RunStatus, "running"> {
  const assistant = latestAssistantMessage(messages);
  if (assistant?.stopReason === "aborted") return "cancelled";
  if (assistant?.stopReason === "error") return "failed";
  return "done";
}

export interface TranscriptRunRecording {
  readonly metrics: RunMetrics;
  readonly separators: TranscriptSeparators;
}

/** Session data only: no TUI, presentation owner, UI timer, or component survives a view detach. */
export function installTranscriptRunRecording(pi: ExtensionAPI, config: SeparatorsConfig): TranscriptRunRecording {
  const metrics = new RunMetrics(), separators = new TranscriptSeparators(pi, config);
  let sessionId: string | undefined;
  const subscriptions = [
    pi.on("session_start", (_event, ctx) => {
      const current = ctx.sessionManager.getSessionId();
      if (current !== sessionId) separators.reset();
      sessionId = current;
    }),
    pi.on("agent_start", () => { separators.startRun(); metrics.start(); }),
    pi.on("turn_start", event => { separators.startTurn(event.turnIndex); metrics.startTurn(event.timestamp); }),
    pi.on("turn_end", event => {
      if (event.message.role === "assistant") metrics.reconcileTurnUsage(event.message.usage);
      separators.finishTurn();
    }),
    pi.on("message_update", event => metrics.handleAssistantEvent(event.assistantMessageEvent)),
    pi.on("tool_execution_start", event => { if (!event.parentToolCallId) metrics.pauseForTool(); }),
    pi.on("tool_execution_end", event => { if (!event.parentToolCallId) metrics.resumeAfterTool(); }),
    pi.on("agent_end", event => {
      const assistant = latestAssistantMessage(event.messages);
      if (assistant) metrics.reconcileFinalUsage(assistant.usage);
      separators.finishRun(metrics.finish(finalRunStatus(event.messages)));
    }),
    pi.on("agent_settled", () => separators.settleRun()),
    pi.on("session_shutdown", () => {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      separators.reset();
    }),
  ];
  return { metrics, separators };
}
