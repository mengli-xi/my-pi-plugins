// Protocol stand-ins only: no real optional plugin is loaded by this package's tests.
import { createHash } from "node:crypto";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const renderSkillInstructions = (s: any) => `<skill>\n<name>${s.name}</name>\n<path>${s.path}</path>\n${s.contents}\n</skill>`;
export class InvocationStore {
  skills: any[] = []; message: any;
  stage(_text: string, skills: any[]) { this.skills = skills; }
  captureUserMessage(message: any, _branch: any[]) { this.message = message; }
  takeUnpersisted() { return [{ version: 1, skills: this.skills }]; }
  async inject(messages: any[], _resolve: any) { return messages.flatMap(m => m.role === "user" && m.timestamp === this.message.timestamp ? [m, ...this.skills.map(s => ({ role: "user", timestamp: m.timestamp, content: [{ type: "text", text: renderSkillInstructions(s) }] }))] : [m]); }
}
export function installCompactionSkillRecovery(pi: any) {
  let ctx: any;
  pi.on("session_start", (_e: any, context: any) => { ctx = context; });
  const skills = () => {
    const found = new Map<string, any>();
    for (const e of ctx?.sessionManager.getBranch() ?? []) if (e.type === "custom" && e.customType === "pi-skills:binding-v1") for (const s of e.data.skills) found.set(s.path, { ...s, sourceEntryId: e.id, contentHash: hash(s.contents) });
    return [...found.values()];
  };
  pi.events.on("pi-session-compact:collect-materials-v1", (r: any) => { if (r.sessionId === ctx?.sessionManager.getSessionId()) r.reply({ owner: "pi-skills", skills: skills() }); });
  pi.events.on("pi-session-compact:collect-recovery-v1", (r: any) => {
    if (r.sessionId !== ctx?.sessionManager.getSessionId()) return;
    const current = skills();
    if (!current.length) return;
    r.reply({ owner: "pi-skills", order: 10, customType: "pi-skills:compact-restored-v1", covers: ["pi-skills:binding-v1"], identity: { operationId: r.operationId }, content: current.map(renderSkillInstructions).join("\n\n") });
  });
}
export default function todo(pi: any) {
  let ctx: any;
  pi.on("session_start", (_e: any, context: any) => { ctx = context; });
  pi.events.on("pi-session-compact:collect-recovery-v1", (r: any) => {
    if (r.sessionId !== ctx?.sessionManager.getSessionId()) return;
    const entry = ctx.sessionManager.getBranch().findLast((e: any) => e.type === "custom_message" && e.customType === "todo-state");
    if (entry) r.reply({ owner: "pi-todo", order: 20, customType: "todo-state", identity: { sourceEntryId: entry.id }, content: entry.details.todos.map((t: any) => t.content).join("\n") });
  });
}
export function liveOwner(pi: any, owner: string, customType: string, content: string, order: number) {
  pi.events.on("pi-session-compact:collect-recovery-v1", (r: any) => r.reply({ owner, customType, content, order, identity: {} }));
}
