import { buildSessionProjection, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { contextFingerprint } from "pi-session-runtime/effective-context";
import { contextTokens } from "./budget.ts";

const canonical = (message: Message): string => { const { timestamp: _timestamp, ...body } = message; return contextFingerprint(body); };
/** Unknown request-only owner content remains fully charged, without parsing private binding records. */
export function requestOnlyTokens(branch: SessionEntry[], prefix: Message[], _firstKeptEntryId: string): number {
  const projection = buildSessionProjection(branch, branch.at(-1)?.id ?? null);
  const nativeCounts = new Map<string, number>();
  for (const message of convertToLlm(projection.messages)) { const key = canonical(message); nativeCounts.set(key, (nativeCounts.get(key) ?? 0) + 1); }
  let total = 0;
  for (const message of prefix) {
    if (message.role === "system") continue;
    const key = canonical(message), count = nativeCounts.get(key) ?? 0;
    if (count) nativeCounts.set(key, count - 1);
    else total += contextTokens([message]);
  }
  return total;
}
