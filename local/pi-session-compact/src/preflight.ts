import { buildSessionProjection, calculateContextTokens, convertToLlm, type CompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { contextFingerprint, getEffectiveContextGeneration, getEffectiveContextStore } from "pi-session-runtime/effective-context";
import { contextTokens, CONTEXT_TOKEN_METHOD } from "./budget.ts";
export interface ProviderUsageSnapshot { leaf: string | null; usage: AssistantMessage["usage"] }
export interface MeasurementCapture { leafId: string | null; messages: Message[] }
export interface RecoveryBound { version: 2; tokens: number; source: "provider-usage"; usageEntryId: string; evidence: "capture" | "reported"; model: string; measuredMessages: Array<{ fingerprint: string; count: number }> }
export const validUsage = (usage: AssistantMessage["usage"] | undefined): usage is AssistantMessage["usage"] => !!usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(n => Number.isFinite(n) && n >= 0) && Number.isFinite(calculateContextTokens(usage)) && calculateContextTokens(usage) > 0;
export function validRecoveryBound(raw: unknown): raw is RecoveryBound {
  const b = raw as RecoveryBound | undefined;
  return b?.version === 2 && Number.isFinite(b.tokens) && b.tokens > 0 && typeof b.model === "string" && Array.isArray(b.measuredMessages) && b.measuredMessages.every(m => typeof m.fingerprint === "string" && Number.isSafeInteger(m.count) && m.count > 0);
}
/** Read the confirmed, model-matched actual request, not capture + subsequent session tail. */
export function readMeasurementCapture(sessionId: string, branch: SessionEntry[], model: { provider: string; id: string }): MeasurementCapture | undefined {
  const generation = getEffectiveContextGeneration(sessionId);
  const capture = generation === undefined ? undefined : getEffectiveContextStore().get(sessionId, generation);
  if (!capture || capture.sessionId !== sessionId || capture.selectedModel.provider !== model.provider || capture.selectedModel.id !== model.id) return;
  const at = capture.leafId === null ? -1 : branch.findIndex(e => e.id === capture.leafId);
  if (capture.leafId !== null && at < 0) return;
  return { leafId: capture.leafId, messages: capture.normalizedMessages };
}
/** Only the first assistant response after the captured request's leaf can supply its usage.
 * Absent capture means absent membership proof. Neither a session usage nor a later
 * extended prefix proves that a filtered carrier participated in the measured request.
 */
export function measuredRecoveryBound(branch: SessionEntry[], model: { provider: string; id: string }, reported?: ProviderUsageSnapshot | null, capture?: MeasurementCapture | Message[]): RecoveryBound | undefined {
  if (!capture || Array.isArray(capture)) return;
  const at = capture.leafId === null ? -1 : branch.findIndex(e => e.id === capture.leafId);
  if (capture.leafId !== null && at < 0) return;
  if (branch.slice(at + 1).some(e => ["compaction", "context_edit", "branch_summary"].includes(e.type) || e.type === "model_change" && (e.provider !== model.provider || e.modelId !== model.id))) return;
  const response = branch.slice(at + 1).find(e => e.type === "message" && e.message.role === "assistant");
  if (response?.type !== "message" || response.message.role !== "assistant") return;
  const assistant = response.message;
  if (assistant.provider !== model.provider || assistant.model !== model.id || assistant.stopReason === "error" || assistant.stopReason === "aborted") return;
  const fromReport = reported?.leaf === response.id && validUsage(reported.usage);
  const usage = fromReport ? reported!.usage : assistant.usage;
  if (!validUsage(usage)) return;
  const counts = new Map<string, number>();
  for (const m of capture.messages) if (m.role !== "system") { const fingerprint = contextFingerprint(m); counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1); }
  return { version: 2, tokens: calculateContextTokens(usage), source: "provider-usage", usageEntryId: response.id, evidence: fromReport ? "reported" : "capture", model: `${model.provider}/${model.id}`, measuredMessages: [...counts].map(([fingerprint, count]) => ({ fingerprint, count })) };
}
export function retainedMessages(branch: SessionEntry[], firstKeptEntryId: string): Message[] {
  const checkpoint: CompactionEntry = { type: "compaction", id: "compact-retained-estimate", parentId: branch.at(-1)?.id ?? null, timestamp: "1970-01-01T00:00:00.000Z", summary: "", firstKeptEntryId, tokensBefore: 0 };
  const projection = buildSessionProjection([...branch, checkpoint], checkpoint.id);
  return convertToLlm(projection.entries.filter(e => e.sourceEntry.id !== checkpoint.id).flatMap(e => e.messages)).filter(m => m.role !== "system");
}
/** Intersection of measured-request multiplicity, retained multiplicity and actual request.
 * No membership proof => full Pi estimate. New/filtered/replaced/extra copies remain full cost.
 */
export function boundedContextTokens(messages: Message[], retained: Message[], bound?: RecoveryBound) {
  const unbounded = contextTokens(messages);
  if (!validRecoveryBound(bound) || unbounded <= bound.tokens) return { total: unbounded, unbounded, retainedEstimate: 0, retainedBounded: 0, matched: 0, bound, method: CONTEXT_TOKEN_METHOD };
  const measured = new Map(bound.measuredMessages.map(m => [m.fingerprint, m.count]));
  const available = new Map<string, number>();
  for (const m of retained) { const key = contextFingerprint(m); available.set(key, Math.min((available.get(key) ?? 0) + 1, measured.get(key) ?? 0)); }
  const matched: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const key = contextFingerprint(m), count = available.get(key) ?? 0;
    if (count) { matched.push(m); available.set(key, count - 1); }
  }
  const retainedEstimate = contextTokens(matched), retainedBounded = Math.min(retainedEstimate, bound.tokens);
  return { total: unbounded - retainedEstimate + retainedBounded, unbounded, retainedEstimate, retainedBounded, matched: matched.length, bound, method: retainedBounded < retainedEstimate ? `${CONTEXT_TOKEN_METHOD}+provider-upper-bound` : CONTEXT_TOKEN_METHOD };
}
