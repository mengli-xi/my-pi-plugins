import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { hash } from "./budget.ts";
export interface MaterialWarning { kind: string; statement: string }

export interface SkillMaterial { sourceEntryId: string; name: string; path: string; contentHash: string; contents: string }
export interface Materials {
  goal: unknown; memory: Array<{ path: string; hash: string; contents: string }>;
  skills: SkillMaterial[]; known: MaterialWarning[];
}
async function memoryFile(dir:string,name:string){
  const path=await realpath(join(dir,name)),rel=relative(dir,path);
  if(isAbsolute(rel)||rel===".."||rel.startsWith(`..${process.platform==="win32"?"\\":"/"}`))throw new Error(`Memory file outside project: ${name}`);
  const contents=await readFile(path,"utf8");return{path,hash:hash(contents),contents};
}
/** Consume the skill owner's existing persisted binding/read ABI; no catalog name implies loaded rules. */
export function skillMaterials(branch: SessionEntry[]): SkillMaterial[] {
  const skills = new Map<string, SkillMaterial>();
  for (const entry of branch) {
    if (entry.type !== "custom" || !["pi-skills:binding-v1", "pi-skills:agent-read-v1"].includes(entry.customType)) continue;
    const data = entry.data as { version?: number; skills?: unknown[]; skill?: unknown } | undefined;
    if (data?.version !== 1) continue;
    for (const raw of data.skills ?? (data.skill ? [data.skill] : [])) {
      const s = raw as { name?: unknown; path?: unknown; contents?: unknown; truncated?: boolean };
      if (typeof s.name === "string" && typeof s.path === "string" && typeof s.contents === "string" && s.truncated !== true) skills.set(s.path, { sourceEntryId: entry.id, name: s.name, path: s.path, contents: s.contents, contentHash: hash(s.contents) });
    }
  }
  return [...skills.values()];
}
export async function collectMaterials(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string, branch: SessionEntry[]): Promise<Materials> {
  const result: Materials = { goal: null, memory: [], skills: skillMaterials(branch), known: [] };
  // Copied synchronous contract owned by pi-goal; no owner import/load-order dependency.
  pi.events.emit("goal:request:snapshot-v1", { sessionId: ctx.sessionManager.getSessionId(), reply: (raw: unknown) => {
    const payload = raw as { version?: number; sessionId?: string; goal?: { id?: unknown; text?: unknown; phase?: unknown } | null };
    if (payload?.version === 1 && payload.sessionId === ctx.sessionManager.getSessionId() && payload.goal && typeof payload.goal.id === "string" && typeof payload.goal.text === "string" && typeof payload.goal.phase === "string") result.goal = payload.goal;
  } });
  // Copied synchronous contract owned by pi-cc-memory; no owner import/load-order dependency.
  // No reply means the memory package is not loaded, which is a normal configuration.
  let project: { memoryDir: string | null; reason?: string } | undefined;
  pi.events.emit("cc-memory:request:project-v1", { version: 1, sessionId: ctx.sessionManager.getSessionId(), reply: (raw: unknown) => {
    const payload = raw as { version?: number; sessionId?: string; memoryDir?: unknown; reason?: unknown };
    if (payload?.version === 1 && payload.sessionId === ctx.sessionManager.getSessionId() && (typeof payload.memoryDir === "string" || payload.memoryDir === null)) project = { memoryDir: payload.memoryDir, reason: typeof payload.reason === "string" ? payload.reason : undefined };
  } });
  if (!project) return result;
  if (project.memoryDir === null) {
    result.known.push({ kind: "memory-source", statement: `Project memory unavailable: ${project.reason ?? "no reason given"}` });
    return result;
  }
  try {
    const root = await realpath(join(agentDir, "pi-cc-memory/projects"));
    const dir = await realpath(project.memoryDir);
    const rel = relative(root, dir);
    if (isAbsolute(rel) || rel.startsWith("..") || !/^[a-f0-9]{64}\/memory$/.test(rel)) throw new Error("Memory path outside owner's project tree");
    let indexFile;
    try { indexFile = await memoryFile(dir, "MEMORY.md"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    const index = indexFile.contents;
    result.memory.push(indexFile);
    const referenced = new Set([...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]));
    // Read supplied relevant indexed topics; prefer names referenced in this branch and current goal.
    const context = `${JSON.stringify(result.goal)} ${JSON.stringify(branch.slice(-20))}`.toLowerCase();
    const names = (await readdir(dir)).filter((n) => n !== "MEMORY.md" && /^[a-z0-9-]+\.md$/.test(n) && referenced.has(n));
    const ranked = names.sort((a, b) => Number(context.includes(b.slice(0, -3))) - Number(context.includes(a.slice(0, -3))) || a.localeCompare(b));
    for (const name of ranked.slice(0, 8)) {
      result.memory.push(await memoryFile(dir,name));
    }
    if (ranked.length > 8) result.known.push({ kind: "memory-coverage", statement: `${ranked.length - 8} indexed memory topics were not read; relevance selection is heuristic.` });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && result.memory.length === 0) return result;
    result.known.push({ kind: "memory-source", statement: `Current memory read failed: ${String(error)}` });
  }
  return result;
}
