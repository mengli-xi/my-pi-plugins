import { buildSessionProjection, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { contextFingerprint } from "pi-session-runtime/effective-context";
import { contextTokens } from "./budget.ts";

interface Binding { version: 1; key: string; text: string; skills: Array<{ name: string; path: string; contents: string; truncated?: boolean }> }
interface Source { id: string; timestamp: number; binding?: Binding }
const text = (message: Message): string => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("");
const canonical = (message: Message): string => { const { timestamp: _timestamp, ...body } = message; return contextFingerprint(body); };
/** Observe the existing owner envelope and pure-text shape; never render or reconstruct skill rules here. */
function provenSkillInjection(message: Message, source: Source): boolean {
  if (message.role !== "user" || message.timestamp !== source.timestamp) return false;
  if (typeof message.content !== "string" && (message.content.length !== 1 || message.content[0]?.type !== "text")) return false;
  const match = /^<skill>\n<name>([^<]*)<\/name>\n<path>([^<]*)<\/path>\n([\s\S]*)\n<\/skill>$/.exec(text(message));
  if (!match) return false;
  const decode = (value: string) => value.replace(/&(amp|lt|gt);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]!);
  return source.binding?.skills.some(skill => skill && skill.truncated !== true && skill.name === decode(match[1]!) && skill.path === decode(match[2]!) && skill.contents === match[3]) ?? false;
}
/** Only drop a captured skill injection when its exact bound user source is cut.
 * Other/unproven owner material stays charged; a retained source will inject again.
 */
export function requestOnlyTokens(branch: SessionEntry[], prefix: Message[], firstKeptEntryId: string): number {
  const projection = buildSessionProjection(branch, branch.at(-1)?.id ?? null);
  const checkpoint: SessionEntry = { type: "compaction", id: "request-only-retained", parentId: branch.at(-1)?.id ?? null, timestamp: "1970-01-01T00:00:00.000Z", summary: "", firstKeptEntryId, tokensBefore: 0 };
  const retained = new Set(buildSessionProjection([...branch, checkpoint], checkpoint.id).entries.filter(entry => entry.messages.some(message => message.role === "user")).map(entry => entry.sourceEntry.id));
  // Small copied binding identity ABI: the owner keys timestamp/text/occurrence.
  const bindings = new Map<string, Binding>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "pi-skills:binding-v1") continue;
    const binding = entry.data as Binding | undefined;
    if (binding?.version === 1 && typeof binding.key === "string" && typeof binding.text === "string" && Array.isArray(binding.skills)) bindings.set(binding.key, binding);
  }
  const sources = new Map<string, Source[]>(), occurrences = new Map<string, number>();
  for (const entry of projection.entries) for (const message of entry.messages) {
    if (message.role !== "user") continue;
    const body = text(message), base = `${message.timestamp}\0${body}`, occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const binding = bindings.get(`${base}\0${occurrence}`), key = contextFingerprint(message);
    const matches = sources.get(key) ?? [];
    matches.push({ id: entry.sourceEntry.id, timestamp: message.timestamp, binding: binding?.text === body ? binding : undefined });
    sources.set(key, matches);
  }
  const nativeCounts = new Map<string, number>();
  for (const message of convertToLlm(projection.messages)) { const key = canonical(message); nativeCounts.set(key, (nativeCounts.get(key) ?? 0) + 1); }
  let total = 0, source: Source | undefined;
  for (const message of prefix) {
    if (message.role === "system") { source = undefined; continue; }
    const key = canonical(message), count = nativeCounts.get(key) ?? 0;
    if (count) {
      nativeCounts.set(key, count - 1);
      source = message.role === "user" ? sources.get(contextFingerprint(message))?.shift() : undefined;
    } else if (!source || retained.has(source.id) || !provenSkillInjection(message, source)) total += contextTokens([message]);
    if (message.role !== "user") source = undefined;
  }
  return total;
}
