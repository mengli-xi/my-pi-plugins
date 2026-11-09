import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { hash } from "./budget.ts";
export interface MaterialWarning { kind: string; statement: string }

export interface SkillMaterial { sourceEntryId: string; name: string; path: string; contentHash: string; contents: string }
export interface Materials {
  goal: unknown; memory: Array<{ path: string; hash: string; contents: string }>;
  skills: SkillMaterial[]; known: MaterialWarning[];
}
export async function collectMaterials(pi: ExtensionAPI, ctx: ExtensionContext, _agentDir: string, branch: SessionEntry[]): Promise<Materials> {
  const result: Materials = { goal: null, memory: [], skills: [], known: [] };
  // Open, synchronous material contributions. The owner proves its own loaded versions.
  let accepting = true;
  try { pi.events.emit("pi-session-compact:collect-materials-v1", { version: 1, sessionId: ctx.sessionManager.getSessionId(), branchEntries: branch, reply: (raw: unknown) => {
    if (!accepting) return;
    const payload = raw as { owner?: string; skills?: SkillMaterial[] };
    if (typeof payload?.owner !== "string" || !Array.isArray(payload.skills)) return;
    for (const skill of payload.skills) if (skill && [skill.sourceEntryId, skill.name, skill.path, skill.contents].every(value => typeof value === "string")) {
      const material = { sourceEntryId: skill.sourceEntryId, name: skill.name, path: skill.path, contents: skill.contents, contentHash: hash(skill.contents) };
      const at = result.skills.findIndex(item => item.path === material.path);
      if (at >= 0) result.skills[at] = material; else result.skills.push(material);
    }
  } }); } catch { result.known.push({ kind: "owner-material", statement: "Some optional material contributors did not reply." }); }
  accepting = false;
  // Copied synchronous contract owned by pi-goal; no owner import/load-order dependency.
  pi.events.emit("goal:request:snapshot-v1", { sessionId: ctx.sessionManager.getSessionId(), reply: (raw: unknown) => {
    const payload = raw as { version?: number; sessionId?: string; goal?: { id?: unknown; text?: unknown; phase?: unknown } | null };
    if (payload?.version === 1 && payload.sessionId === ctx.sessionManager.getSessionId() && payload.goal && typeof payload.goal.id === "string" && typeof payload.goal.text === "string" && typeof payload.goal.phase === "string") result.goal = payload.goal;
  } });
  // The memory owner chooses and reads its own storage. Accept only protocol data.
  const replies: Promise<unknown>[] = [];
  let open = true;
  const sessionId = ctx.sessionManager.getSessionId();
  try { pi.events.emit("cc-memory:request:materials-v1", { version: 1, sessionId,
    context: `${JSON.stringify(result.goal)} ${JSON.stringify(branch.filter(entry => entry.type === "message").slice(-20))}`,
    reply: (payload: unknown) => { if (open) replies.push(Promise.resolve(payload)); },
  }); } catch { result.known.push({ kind: "memory-source", statement: "Optional memory owner did not reply." }); }
  open = false;
  for (const pending of replies) try {
    const payload = await pending as { version?: number; sessionId?: string; memory?: Materials["memory"]; known?: MaterialWarning[] };
    if (payload?.version !== 1 || payload.sessionId !== sessionId) continue;
    for (const item of payload.memory ?? []) if (item && typeof item.path === "string" && typeof item.contents === "string") result.memory.push({ path: item.path, contents: item.contents, hash: hash(item.contents) });
    for (const item of payload.known ?? []) if (item && typeof item.kind === "string" && typeof item.statement === "string") result.known.push({ kind: item.kind, statement: item.statement });
  } catch { result.known.push({ kind: "memory-source", statement: "Optional memory materials unavailable." }); }
  return result;
}
