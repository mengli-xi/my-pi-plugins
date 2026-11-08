import type { AgentCheckpointV1, NormalizedStoreStateV1, InboxRecordV1 } from "./types.js";

/** Index each appended, unread card once by its durable recipient Inbox identity. */
export function unreadInboxIndexV1(state: NormalizedStoreStateV1): Map<string, InboxRecordV1> {
  return new Map([state.root, ...state.agents].flatMap(partition => partition.inbox).filter(inbox => inbox.state === "appended" && inbox.ui_read_at === undefined).map(inbox => [inbox.inbox_id, inbox]));
}
/** A row may relate to both produced and received cards; the footer counts the unique index. */
export function unreadCompletionsForAgentV1(state: NormalizedStoreStateV1, partition: AgentCheckpointV1): number {
  const produced = new Set(partition.completions.map(completion => completion.completion_id));
  return [...unreadInboxIndexV1(state).values()].filter(inbox => produced.has(inbox.completion_id) || inbox.recipient?.agent_id === partition.agent.agent_id).length;
}
