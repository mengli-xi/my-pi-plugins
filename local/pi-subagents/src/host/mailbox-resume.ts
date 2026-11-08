import type { NormalizedStoreStateV1 } from "../persistence/types.js";
/** A parked Process task needs an execution grant before this mailbox can trigger it. */
export function hasTaskMailbox(state: NormalizedStoreStateV1, agentId: string): boolean {
  return state.agents.find(item => item.agent.agent_id === agentId)?.owner_events.some(event => {
    if (event.state !== "pending" || event.kind !== "mailbox_delivery") return false;
    try { return (JSON.parse(event.payload_json).items ?? []).some((item: { injectedInto?: { kind?: string } }) => item.injectedInto?.kind === "task"); }
    catch { return false; }
  }) === true;
}
