import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recoveryText, type RestoreRef } from "./recovery.ts";

export const COLLECT_RECOVERY = "pi-session-compact:collect-recovery-v1";
const owners = ["pi-session-compact", "pi-skills", "pi-todo", "pi-processes", "pi-subagents"] as const;
export interface RecoveryItem { owner: string; customType: string; identity: Record<string, unknown>; content: string }
export interface CollectedRecovery { version: 1; items: Omit<RecoveryItem, "content">[] }
export function includesRecovery(details: unknown, owner: string, customType: string): boolean {
  const recovery = (details as { recovery?: CollectedRecovery } | undefined)?.recovery;
  return recovery?.version === 1 && Array.isArray(recovery.items) && recovery.items.some(item => item.owner === owner && item.customType === customType);
}
/** Replies must run on the emit stack. Late replies cannot mutate an admitted package. */
export function collectRecovery(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext, operationId: string, restoreSkills: RestoreRef[]) {
  const items = new Map<string, RecoveryItem>();
  const errors: string[] = [];
  let accepting = true;
  pi.events.emit(COLLECT_RECOVERY, { version: 1, sessionId: ctx.sessionManager.getSessionId(), operationId, restoreSkills, reply: (raw: unknown) => {
    if (!accepting) return;
    const item = raw as RecoveryItem & { error?: string };
    if (!item || !owners.includes(item.owner as typeof owners[number])) return;
    if (item.error) { errors.push(`${item.owner}: ${item.error}`); return; }
    if (typeof item.customType !== "string" || typeof item.content !== "string" || !item.content.trim() || !item.identity || typeof item.identity !== "object" || Array.isArray(item.identity)) { errors.push(`Invalid recovery reply from ${item.owner}`); return; }
    if (items.has(item.owner)) { errors.push(`Duplicate recovery owner ${item.owner}`); return; }
    items.set(item.owner, structuredClone(item));
  } });
  accepting = false;
  if (errors.length) throw new Error(errors.join("; "));
  if (restoreSkills.length && !items.has("pi-skills")) throw new Error("Required skill recovery owner did not reply synchronously");
  items.set("pi-session-compact", { owner: "pi-session-compact", customType: "pi-session-compact:recovery-v1", identity: { operationId }, content: recoveryText() });
  const ordered = owners.flatMap(owner => items.get(owner) ? [items.get(owner)!] : []);
  const appendix = "\n\n## 压缩恢复内容\n\n" + ordered.map(item => `### ${item.owner} (${item.customType})\n\n${item.content}`).join("\n\n");
  const details: CollectedRecovery = { version: 1, items: ordered.map(({ content: _content, ...item }) => item) };
  return { appendix, details };
}
