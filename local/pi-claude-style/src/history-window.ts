import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** A bounded tail, extended backwards without cutting a tool call from its results. */
export const HISTORY_BATCH_SIZE = 200;

/** Input history is independent of the transcript window. Pick at most the
 * native editor's last 100 eligible, adjacent-distinct inputs; the native
 * renderer/editor still performs actual extraction, trimming and insertion. */
export function historyInputEntries(entries: readonly SessionEntry[], limit = 100): SessionEntry[] {
  const result: SessionEntry[] = [];
  let previous: string | undefined;
  for (let index = entries.length - 1; index >= 0 && result.length < limit; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text = (typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("")).trim();
    if (!text || text === previous) continue;
    previous = text;
    result.push(entry);
  }
  return result.reverse();
}

export function historyWindowStart(entries: readonly SessionEntry[], end = entries.length, size = HISTORY_BATCH_SIZE): number {
  let start = Math.max(0, end - size);
  while (start > 0) {
    const entry = entries[start];
    if (entry?.type === "compaction" || entry?.type === "branch_summary"
      || (entry?.type === "message" && entry.message.role === "user")) break;
    start--;
  }
  // A summary can be a boundary inside one user request. Keep any tool call
  // before it together with a result after it, rather than relying on native
  // renderSessionItems' pending-tool map across independently loaded batches.
  if (start > 0 && entries[start]?.type !== "message") {
    let user = start;
    while (user > 0) {
      const entry = entries[user];
      if (entry?.type === "message" && entry.message.role === "user") break;
      user--;
    }
    const pending = new Set<string>();
    for (let index = user; index < start; index++) {
      const entry = entries[index];
      if (entry?.type !== "message") continue;
      if (entry.message.role === "assistant") for (const block of entry.message.content) if (block.type === "toolCall") pending.add(block.id);
      if (entry.message.role === "toolResult") pending.delete(entry.message.toolCallId);
    }
    for (let index = start; index < end; index++) {
      const entry = entries[index];
      if (entry?.type === "message" && entry.message.role === "toolResult" && pending.has(entry.message.toolCallId)) { start = user; break; }
    }
  }
  return start;
}

export interface HistoryBoundary { index: number; count: number }

/** Only the latest compaction defines what the model can still see today.
 * Older summaries stay at their chronological positions in the branch. */
export function historyBoundary(entries: readonly SessionEntry[]): HistoryBoundary | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    const kept = entries.findIndex(candidate => candidate.id === entry.firstKeptEntryId);
    if (kept < 0 || kept > index) return undefined;
    return { index: kept, count: entries.slice(0, kept).filter(candidate => candidate.type === "message").length };
  }
  return undefined;
}

export type HistoryProjection = (entries: readonly SessionEntry[]) => void;
// CC's Main and bundled child have separate module graphs. Their APIs are
// distinct keys; the registry contains no cross-package protocol or session data.
const KEY = Symbol.for("pi.claude-style.history-projections.v1");
interface Projection { fullscreen: boolean; read?: () => readonly SessionEntry[]; project?: HistoryProjection }
const projections = (): WeakMap<object, Projection> => {
  const scope = globalThis as Record<PropertyKey, unknown>;
  return (scope[KEY] ??= new WeakMap()) as WeakMap<object, Projection>;
};
function state(api: object): Projection {
  let value = projections().get(api);
  if (!value) projections().set(api, value = { fullscreen: false });
  return value;
}
export function setHistoryView(api: object, fullscreen: boolean, read?: () => readonly SessionEntry[]): void {
  Object.assign(state(api), { fullscreen, read });
}
export function projectHistoryWindow(api: object, entries: readonly SessionEntry[]): void { state(api).project?.(entries); }
export function subscribeHistoryProjection(api: object, project: HistoryProjection): () => void {
  state(api).project = project;
  return () => { if (state(api).project === project) state(api).project = undefined; };
}
export function historyProjectionEntries(api: object, branch: readonly SessionEntry[], context: () => readonly SessionEntry[]): readonly SessionEntry[] {
  const view = state(api);
  return view.fullscreen ? view.read?.() ?? branch.slice(historyWindowStart(branch)) : context();
}
export function releaseHistoryView(api: object): void { projections().delete(api); }
