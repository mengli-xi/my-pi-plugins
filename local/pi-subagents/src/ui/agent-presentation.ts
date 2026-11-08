import type { AgentCheckpointV1, NormalizedStoreStateV1, TaskRecordV1 } from "../persistence/types.js";
import { unreadInboxIndexV1 } from "../persistence/unread.js";

export type AgentTab = "running" | "done";
export type AgentGroup = "running" | "waiting" | "queued" | "closing";
export type AgentTone = "success" | "accent" | "warning" | "error" | "dim";
export interface AgentCounts { agents: number; open: number; running: number; waiting: number; queued: number; closing: number; unread: number; active: number; done: number }
export interface AgentRow {
  partition: AgentCheckpointV1; tab: AgentTab; group?: AgentGroup; labels: { text: string; tone: AgentTone }[];
  unread: number; queued: number; task?: TaskRecordV1; latest?: TaskRecordV1;
  sort: readonly [number, number, string];
}
export interface AgentPresentation { revision: number; rows: AgentRow[]; counts: AgentCounts; tabs: Record<AgentTab, (AgentRow & { muted: boolean })[]> }

/** One projection for list, tab, strip and statusline. Time/width/theme never affect ordering. */
export function agentPresentation(snapshot: NormalizedStoreStateV1, execution: ReadonlyMap<string, { state: "active" | "waiting" | "idle" }> = new Map()): AgentPresentation {
  const inboxes = unreadInboxIndexV1(snapshot);
  const producers = new Map(snapshot.agents.flatMap(item => item.completions.map(completion => [completion.completion_id, item.agent.agent_id] as const)));
  const counts: AgentCounts = { agents: snapshot.agents.length, open: 0, running: 0, waiting: 0, queued: 0, closing: 0, unread: inboxes.size, active: 0, done: 0 };
  const rows: AgentRow[] = snapshot.agents.map(partition => {
    const agent = partition.agent;
    const task = partition.tasks.find(task => task.task_id === agent.current_task_id && task.phase !== "settled")
      ?? partition.tasks.filter(task => task.phase !== "settled").sort((a,b) => a.admission_order - b.admission_order)[0];
    const latest = partition.tasks.filter(task => task.phase === "settled").sort((a,b) => Date.parse(b.settled_at ?? b.admitted_at) - Date.parse(a.settled_at ?? a.admitted_at) || b.admission_order - a.admission_order)[0];
    const queued = agent.queued_task_ids.length;
    const group: AgentGroup | undefined = agent.lifecycle === "closing" ? "closing"
      : task?.phase === "starting" || task?.phase === "running" || task?.phase === "waiting" && execution.get(agent.agent_id)?.state === "active" ? "running"
      : task?.phase === "waiting" ? "waiting" : task || queued ? "queued" : undefined;
    const tab: AgentTab = group ? "running" : "done";
    const unread = [...inboxes.values()].filter(inbox => producers.get(inbox.completion_id) === agent.agent_id || inbox.recipient.agent_id === agent.agent_id).length;
    const labels: AgentRow["labels"] = [];
    const base = group === "running" ? task?.phase === "starting" ? "starting" : "running" : group === "closing" ? "closing" : group ?? latest?.outcome ?? "idle";
    const tone: AgentTone = base === "running" || base === "completed" ? "success" : base === "starting" ? "accent"
      : ["waiting", "partial", "blocked", "interrupted", "closing"].includes(base) ? "warning" : base === "failed" ? "error" : "dim";
    labels.push({ text: base, tone });
    if (task?.phase === "waiting" && task.activation_order !== undefined && group === "waiting") labels.push({ text: "activation queued", tone: "accent" });
    if (queued) labels.push({ text: `queued ×${queued}`, tone: "dim" });
    if (agent.lifecycle === "closed") labels.push({ text: "closed", tone: "dim" });
    if (agent.availability !== "available") labels.push({ text: "unavailable", tone: "error" });
    if (unread) labels.push({ text: `● unread ${unread}`, tone: "accent" });
    if (agent.lifecycle !== "closed") counts.open++;
    if (group) { counts[group]++; counts.active++; } else counts.done++;
    const rank = group === "running" ? 0 : group === "waiting" ? 1 : group === "queued" ? 2 : group === "closing" ? 3 : unread ? 0 : 1;
    const order = group ? task?.activation_order ?? task?.admission_order ?? agent.created_revision
      : -Math.max(Date.parse(latest?.settled_at ?? latest?.admitted_at ?? agent.created_at), Date.parse(agent.closed_at ?? agent.created_at));
    return { partition, tab, group, labels, unread, queued, task, latest, sort: [rank, order, agent.agent_id] };
  });
  const compare = (a: AgentRow, b: AgentRow) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2].localeCompare(b.sort[2]);
  const byParent = new Map<string | undefined, AgentRow[]>();
  const ids = new Set(rows.map(row => row.partition.agent.agent_id));
  for (const row of rows) {
    const parent = row.partition.agent.parent_agent_id;
    const key = parent && ids.has(parent) ? parent : undefined;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const tree = (tab: AgentTab) => {
    const best = new Map<AgentRow, AgentRow | undefined>();
    const matches = (row: AgentRow): AgentRow | undefined => {
      if (best.has(row)) return best.get(row);
      const candidates = [row.tab === tab ? row : undefined, ...(byParent.get(row.partition.agent.agent_id) ?? []).map(matches)].filter((row): row is AgentRow => !!row).sort(compare);
      best.set(row, candidates[0]); return candidates[0];
    };
    const output: (AgentRow & { muted: boolean })[] = [];
    const visit = (siblings: AgentRow[]) => {
      for (const row of siblings.filter(row => matches(row)).sort((a,b) => compare(matches(a)!, matches(b)!))) {
        output.push({ ...row, muted: row.tab !== tab }); visit(byParent.get(row.partition.agent.agent_id) ?? []);
      }
    };
    visit(byParent.get(undefined) ?? []); return output;
  };
  return { revision: snapshot.root.host_revision, rows, counts, tabs: { running: tree("running"), done: tree("done") } };
}
