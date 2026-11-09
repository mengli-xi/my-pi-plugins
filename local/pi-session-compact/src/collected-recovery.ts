import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { recoveryText, type RestoreRef } from "./recovery.ts";

export const COLLECT_RECOVERY = "pi-session-compact:collect-recovery-v1";
export interface RecoveryItem { owner: string; customType: string; identity: Record<string, unknown>; content: string; order?: number; covers?: string[] }
export interface CollectedRecovery { version: 1; items: Omit<RecoveryItem, "content">[] }
export function includesRecovery(details: unknown, owner: string, customType: string): boolean {
  const recovery = (details as { recovery?: CollectedRecovery } | undefined)?.recovery;
  return recovery?.version === 1 && Array.isArray(recovery.items) && recovery.items.some(item => item?.owner === owner && item.customType === customType);
}
/** Replies run on the emit stack. No participant is required; failures become prose, not a request latch. */
export function collectRecovery(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext, operationId: string, restoreSkills: RestoreRef[], branch: SessionEntry[] = []) {
  const items = new Map<string, RecoveryItem>();
  const notes: string[] = [];
  let accepting = true;
  try { pi.events.emit(COLLECT_RECOVERY, { version: 1, sessionId: ctx.sessionManager.getSessionId(), operationId, restoreSkills, branchEntries: branch, reply: (raw: unknown) => {
    if (!accepting) return;
    const item = raw as RecoveryItem & { error?: string };
    if (!item || typeof item.owner !== "string" || !item.owner.trim()) return;
    if (item.error) { notes.push(`${item.owner}：未恢复（${item.error}）。`); return; }
    if (typeof item.customType !== "string" || !item.customType || typeof item.content !== "string" || !item.content.trim() || !item.identity || typeof item.identity !== "object" || Array.isArray(item.identity)
      || (item.order !== undefined && !Number.isFinite(item.order)) || (item.covers !== undefined && (!Array.isArray(item.covers) || !item.covers.every(type => typeof type === "string")))) {
      notes.push(`${item.owner}：未恢复（无效回复）。`); return;
    }
    if (items.has(item.owner)) { notes.push(`${item.owner}：忽略重复回复。`); return; }
    try { items.set(item.owner, structuredClone(item)); } catch { notes.push(`${item.owner}：未恢复（回复无法复制）。`); }
  } }); } catch { notes.push("部分协作方未恢复（恢复回调失败）。"); }
  accepting = false;
  items.set("pi-session-compact", { owner: "pi-session-compact", order: 0, customType: "pi-session-compact:recovery-v1", identity: { operationId }, content: recoveryText() });
  const covered = new Set([...items.values()].flatMap(item => [item.customType, ...(item.covers ?? [])]));
  // Only public entry tags and this protocol's own persisted markers are inspected, never owner data/details.
  const historical = new Set(branch.flatMap(entry => entry.type === "custom" || entry.type === "custom_message" ? [entry.customType] : []));
  for (const entry of branch) if (entry.type === "compaction") {
    const details = entry.details as { recovery?: CollectedRecovery; restoreSkills?: unknown[] } | undefined;
    if (details?.recovery?.version === 1 && Array.isArray(details.recovery.items)) for (const item of details.recovery.items) if (typeof item?.customType === "string") historical.add(item.customType);
    // Old Compact details are ours, not the skills owner's private record format.
    if (details?.restoreSkills?.length && !restoreSkills.length) notes.push("旧压缩中的技能引用未恢复；没有协作方提供当前规则。");
  }
  for (const type of [...historical].sort()) if (!covered.has(type)) notes.push(`历史记录 ${type} 未恢复（没有协作方提供恢复内容）。`);
  const ordered = [...items.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const appendix = "\n\n## 压缩恢复内容\n\n" + ordered.map(item => `### ${item.owner} (${item.customType})\n\n${item.content}`).join("\n\n") + (notes.length ? "\n\n" + notes.join("\n") : "");
  const details: CollectedRecovery = { version: 1, items: ordered.map(({ content: _content, ...item }) => item) };
  return { appendix, details };
}
