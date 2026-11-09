import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentParts } from "./sources.ts";

export interface UserQuotation { kind: "user" | "qa"; text: string }
export interface UserQuotations { version: 1; items: UserQuotation[] }
/** Existing Goal producer protocol markers, not natural-language prompt prefix heuristics.
 * Other user-role inputs remain eligible, including unrecognized extension producers.
 */
export const isGoalPrompt = (text: string): boolean => /<!--\s*pi-goal-(?:continuation|prompt):[^\s>]+\s*-->/.test(text);
/** Keep IDs/ancestry and public context_edit semantics while exposing original history.
 * No compaction prose is parsed to recover user input.
 */
export function originalProjection(branch: SessionEntry[]) {
  const entries = branch.map((e): SessionEntry => e.type === "compaction"
    ? { type: "custom", id: e.id, parentId: e.parentId, timestamp: e.timestamp, customType: "compact-original-history", data: null }
    : e);
  return buildSessionProjection(entries, entries.at(-1)?.id ?? null);
}
export function assertOriginalHistory(branch: SessionEntry[]): void {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (ids.has(entry.id) || entry.parentId && !ids.has(entry.parentId)) throw new Error("user-history-incomplete: broken ancestry or duplicate entry");
    ids.add(entry.id);
    if (entry.type === "compaction" && (!ids.has(entry.firstKeptEntryId) || entry.firstKeptEntryId === entry.id)) throw new Error("user-history-incomplete: legacy retained boundary is missing");
  }
}
export function collectUserQuotations(branch: SessionEntry[], firstKeptEntryId: string): UserQuotations {
  assertOriginalHistory(branch);
  const positions = new Map(branch.map((e, i) => [e.id, i]));
  const end = positions.get(firstKeptEntryId) ?? -1;
  if (end < 0) throw new Error("user-history-incomplete: retained boundary is missing");
  const previous = branch.findLast(e => e.type === "compaction");
  const saved = (previous?.details as { userQuotations?: UserQuotations } | undefined)?.userQuotations;
  if (saved?.version === 1 && (!Array.isArray(saved.items) || saved.items.some(q => !q || !["user", "qa"].includes(q.kind) || typeof q.text !== "string"))) throw new Error("user-history-incomplete: corrupt accumulated quotations");
  const previousAt = previous ? branch.findIndex(e => e.id === previous.firstKeptEntryId) : -1;
  const previousCompactAt = previous ? branch.findIndex(e => e.id === previous.id) : -1;
  // Rebuild for edits, legacy native details and a cut that moves backwards.
  const inherited = saved?.version === 1 && previousAt >= 0 && previousAt <= end && !branch.slice(previousCompactAt + 1).some(e => e.type === "context_edit");
  const items: UserQuotation[] = inherited ? structuredClone(saved.items) : [];
  const start = inherited ? previousAt : 0;
  const questions = new Map<string, string[]>();
  const edited = new Set(branch.filter(e => e.type === "context_edit").map(e => e.targetId));
  for (const { sourceEntry, messages } of originalProjection(branch).entries) {
    const at = positions.get(sourceEntry.id)!;
    const parts = contentParts(sourceEntry, messages);
    for (const part of parts) if (part.toolCall?.name === "ask_user_question") {
      const qs = (part.toolCall.arguments as { questions?: unknown })?.questions;
      if (Array.isArray(qs) && qs.every(q => q && typeof q.question === "string")) questions.set(part.toolCall.id, qs.map(q => q.question));
    }
    if (at < start || at >= end || sourceEntry.type !== "message") continue;
    const message = sourceEntry.message;
    const text = parts.filter(p => p.kind === "text").map(p => p.text!).join("\n");
    if (message.role === "user") {
      if (!edited.has(sourceEntry.id) && (typeof message.content !== "string" && !Array.isArray(message.content) || Array.isArray(message.content) && message.content.some(p => p.type === "text" && typeof p.text !== "string"))) throw new Error("user-history-incomplete: unreadable user content");
      if (text && !isGoalPrompt(text)) items.push({ kind: "user", text });
      continue;
    }
    if (message.role !== "toolResult" || message.toolName !== "ask_user_question") continue;
    const qs = questions.get(message.toolCallId);
    if (!qs) continue;
    // An explicit edit owns the replacement text; do not resurrect old details.
    if (edited.has(sourceEntry.id)) { if (text) items.push({ kind: "qa", text }); continue; }
    const d = message.details as { cancelled?: boolean; answers?: Array<{ questionIndex: number; question: string; kind?: string; answer?: string | null; selected?: string[]; notes?: string }>; chat?: { questionIndex: number; question: string; notes?: string }; explain?: { questionIndex: number; question: string; notes?: string } } | undefined;
    if (typeof d?.cancelled !== "boolean") continue;
    const paired = (q: { questionIndex: number; question: string }) => Number.isInteger(q.questionIndex) && qs[q.questionIndex] === q.question;
    for (const a of d.answers ?? []) {
      if (!paired(a)) continue;
      const answer = a.kind === "multi" && Array.isArray(a.selected) && a.selected.every(s => typeof s === "string") ? a.selected.join("\n")
        : (a.kind === "custom" || a.kind === "option") && typeof a.answer === "string" ? a.answer : undefined;
      if (answer !== undefined) items.push({ kind: "qa", text: `${d.cancelled ? "已取消问答中先前填写的回答（不表示授权）：\n" : ""}问题：${a.question}\n回答：${answer}${typeof a.notes === "string" ? `\n补充：${a.notes}` : ""}` });
    }
    for (const [name, control] of [["Chat about this", d.chat], ["Explain More", d.explain]] as const) if (control && paired(control)) items.push({ kind: "qa", text: `问题：${control.question}\n回答：${name}${typeof control.notes === "string" ? `\n补充：${control.notes}` : ""}` });
  }
  return { version: 1, items };
}
export function renderUserQuotations(quotes: UserQuotations): string {
  return quotes.items.length ? `\n\n## 所有用户消息\n\n${quotes.items.map(q => q.text).join("\n\n---\n\n")}` : "";
}
