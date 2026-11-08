import type { NormalizedStoreStateV1 } from "../persistence/types.js";
/** Keep the parent owner alive until child leases and their durable control work finish. */
export function needsChildControl(state: NormalizedStoreStateV1, agentId: string): boolean {
  return state.agents.some(partition => partition.agent.parent_agent_id === agentId && partition.tasks.some(task => task.lease_disposition !== "released"))
    || state.agents.find(partition => partition.agent.agent_id === agentId)?.owner_events.some(event => !["acked","cancelled"].includes(event.state)) === true;
}
