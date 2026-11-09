import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  renderSkillInstructions,
  type LoadedSkill,
} from "./skills.ts";

export const SKILL_BINDING_ENTRY_TYPE = "pi-skills:binding-v1";
export const SKILL_INJECTION_MESSAGE_TYPE = "pi-skills:injection-v1";
export const LEGACY_SKILL_BINDING_ENTRY_TYPE = "pi-skill-mentions:binding-v1";
const LEGACY_SKILL_INJECTION_MESSAGE_TYPE = "pi-skill-mentions:injection-v1";

export interface InvocationSnapshot {
  version: 1;
  key: string;
  text: string;
  skills: LoadedSkill[];
}

interface PendingInvocation {
  text: string;
  skills: LoadedSkill[];
  createdAt: number;
}

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => (
      typeof part === "object"
      && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("");
}

function messageBase(message: { timestamp?: unknown; content?: unknown }): string {
  return `${String(message.timestamp ?? "missing")}\u0000${messageText(message)}`;
}

function occurrenceKey(base: string, occurrence: number): string {
  return `${base}\u0000${occurrence}`;
}

function isSnapshot(value: unknown): value is InvocationSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<InvocationSnapshot>;
  return record.version === 1
    && typeof record.key === "string"
    && typeof record.text === "string"
    && Array.isArray(record.skills)
    && record.skills.every((skill) => (
      typeof skill === "object"
      && skill !== null
      && typeof (skill as LoadedSkill).name === "string"
      && typeof (skill as LoadedSkill).path === "string"
      && typeof (skill as LoadedSkill).contents === "string"
      && (
        (skill as LoadedSkill).truncated === undefined
        || typeof (skill as LoadedSkill).truncated === "boolean"
      )
    ));
}

function entryMessage(entry: SessionEntry): AgentMessage | undefined {
  return entry.type === "message" ? entry.message : undefined;
}

export class InvocationStore {
  private pending: PendingInvocation[] = [];
  private snapshots = new Map<string, InvocationSnapshot>();
  private unpersisted: InvocationSnapshot[] = [];

  restore(entries: readonly SessionEntry[]): void {
    this.pending = [];
    this.snapshots.clear();
    this.unpersisted = [];
    for (const entry of entries) {
      if (
        entry.type === "custom"
        && (entry.customType === SKILL_BINDING_ENTRY_TYPE || entry.customType === LEGACY_SKILL_BINDING_ENTRY_TYPE)
        && isSnapshot(entry.data)
      ) {
        this.snapshots.set(entry.data.key, entry.data);
      }
    }
  }

  stage(text: string, skills: LoadedSkill[]): void {
    const now = Date.now();
    this.pending = this.pending.filter((pending) => now - pending.createdAt < 5 * 60_000);
    this.pending.push({ text, skills, createdAt: now });
    if (this.pending.length > 32) this.pending.splice(0, this.pending.length - 32);
  }

  captureUserMessage(message: AgentMessage, priorEntries: readonly SessionEntry[]): void {
    if (message.role !== "user") return;
    const text = messageText(message);
    const pendingIndex = this.pending.findIndex((pending) => pending.text === text);
    if (pendingIndex < 0) return;
    const [pending] = this.pending.splice(pendingIndex, 1);
    const base = messageBase(message);
    let occurrence = 0;
    for (const entry of priorEntries) {
      const prior = entryMessage(entry);
      if (prior?.role === "user" && messageBase(prior) === base) occurrence++;
    }
    const snapshot: InvocationSnapshot = {
      version: 1,
      key: occurrenceKey(base, occurrence),
      text,
      skills: pending.skills,
    };
    this.snapshots.set(snapshot.key, snapshot);
    this.unpersisted.push(snapshot);
  }

  takeUnpersisted(): InvocationSnapshot[] {
    return this.unpersisted.splice(0);
  }

  clearPending(): void {
    this.pending = [];
  }

  async inject(
    messages: readonly AgentMessage[],
    infer: (text: string) => Promise<LoadedSkill[]>,
    refreshLegacy: (skill: LoadedSkill) => Promise<LoadedSkill> = async (skill) => skill,
  ): Promise<AgentMessage[]> {
    const output: AgentMessage[] = [];
    const occurrences = new Map<string, number>();
    for (const message of messages) {
      if (
        message.role === "custom"
        && (
          message.customType === SKILL_INJECTION_MESSAGE_TYPE
          || message.customType === LEGACY_SKILL_INJECTION_MESSAGE_TYPE
        )
      ) continue;
      output.push(message);
      if (message.role !== "user") continue;

      const base = messageBase(message);
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const key = occurrenceKey(base, occurrence);
      let snapshot = this.snapshots.get(key);
      if (!snapshot) {
        const text = messageText(message);
        const skills = await infer(text);
        if (skills.length > 0) {
          snapshot = { version: 1, key, text, skills };
          this.snapshots.set(key, snapshot);
        }
      }
      if (!snapshot) continue;

      if (snapshot.skills.some((skill) => skill.truncated === true)) {
        const refreshedSkills = await Promise.all(snapshot.skills.map((skill) => (
          skill.truncated === true ? refreshLegacy(skill) : skill
        )));
        if (refreshedSkills.some((skill, index) => skill !== snapshot?.skills[index])) {
          snapshot = { ...snapshot, skills: refreshedSkills };
          this.snapshots.set(key, snapshot);
          this.unpersisted.push(snapshot);
        }
      }

      for (const skill of snapshot.skills) {
        output.push({
          role: "custom",
          customType: SKILL_INJECTION_MESSAGE_TYPE,
          content: renderSkillInstructions(skill),
          display: false,
          details: { name: skill.name, path: skill.path },
          timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
        });
      }
    }
    return output;
  }
}
