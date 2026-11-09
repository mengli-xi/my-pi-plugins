import {buildSessionProjection,calculateContextTokens,convertToLlm,sessionEntryToContextMessages,type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {createInitialSystemMessage,getCurrentTools,toToolDeclaration,type AssistantMessage,type Message} from "@earendil-works/pi-ai";
import type { Config } from "./config.ts";
import type { Materials } from "./materials.ts";
import { validUsage } from "./preflight.ts";
import { contextTokens, textTokens, CONTEXT_TOKEN_METHOD } from "./budget.ts";
import { contextFingerprint, getEffectiveContextGeneration, getEffectiveContextStore } from "pi-session-runtime/effective-context";
import { selectEffectiveContext, stableMessagePrefix } from "pi-session-runtime/native-child-context";
import { filterMailboxMessages } from "pi-session-inject/mailbox-v1/light";

export interface PrefixCaptureDiagnostic { generation: number | null; reason: string }
export class MainPrefixUnavailableError extends Error {
  readonly diagnostic: PrefixCaptureDiagnostic;
  constructor(diagnostic: PrefixCaptureDiagnostic) {
    super(`effective-prefix-unavailable: ${diagnostic.reason}; generation=${diagnostic.generation ?? "none"}`);
    this.diagnostic = diagnostic;
  }
}

// Only observed absence, not a structural/identity rejection subsequently cleared by another owner.
const REBUILDABLE_CAPTURE_REASONS = new Set(["no-capture", "awaiting-provider-capture", "native-compaction", "provider-not-decoratable"]);
export function canRebuildMainPrefix(error: unknown): error is MainPrefixUnavailableError {
  return error instanceof MainPrefixUnavailableError && REBUILDABLE_CAPTURE_REASONS.has(error.diagnostic.reason);
}

export interface MainPrefixSource { source: "capture" | "rebuilt"; reason: string }

/** Public current projection, with current prompt/loadout folded into a fresh system head.
 * Like Pi's forced-prompt projection, historical system/tool deltas are replaced by that head.
 * Request-only extension transforms cannot be recovered without a capture; this is not cache proof.
 */
export async function rebuildMainPrefix(pi: ExtensionAPI, ctx: ExtensionContext, branch: SessionEntry[]): Promise<Message[]> {
  const byName = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
  const tools = pi.getActiveTools().map(name => {
    const tool = byName.get(name);
    if (!tool) throw new Error("effective-prefix-tool-loadout-unavailable");
    return toToolDeclaration(tool);
  });
  const head = createInitialSystemMessage(ctx.getSystemPrompt(), tools);
  if (!head) throw new Error("effective-prefix-incomplete");
  const projected = buildSessionProjection(branch, branch.at(-1)?.id ?? null).messages;
  const messages = [head, ...convertToLlm(await filterMailboxMessages(ctx, projected)).filter(m => m.role !== "system")];
  if (stableMessagePrefix(messages).length !== messages.length) throw new Error("effective-prefix-incomplete");
  return messages;
}

export function mainPrefix(pi: ExtensionAPI, ctx: ExtensionContext, branch: SessionEntry[]): Message[] {
  const sessionId = ctx.sessionManager.getSessionId();
  const generation = getEffectiveContextGeneration(sessionId);
  const store = getEffectiveContextStore();
  const capture = generation === undefined ? undefined : store.get(sessionId, generation);
  if (!capture || !ctx.model) throw new MainPrefixUnavailableError({ generation: generation ?? null, reason: store.reason(sessionId) });
  const byName = new Map(pi.getAllTools().map((t) => [t.name, t]));
  const active = pi.getActiveTools().map((name) => {
    const tool = byName.get(name);
    return tool ? { name, description: tool.description, parameters: tool.parameters, sourceInfo: tool.sourceInfo } : { name, unavailable: true };
  });
  const selection = selectEffectiveContext({ mode: "all", branch, requiresCapture: true, capture, identity: {
    sessionId, generation: generation!, selectedModel: { provider: ctx.model.provider, id: ctx.model.id },
    thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(), toolLoadoutFingerprint: contextFingerprint(active),
    // The capture owner defines this opaque fingerprint. We do not invent a second registry.
    capabilityFingerprint: capture.capabilityFingerprint,
  } });
  const captureAt=branch.findIndex(e=>e.id===capture.leafId);
  const tail=convertToLlm(branch.slice(captureAt+1).flatMap(sessionEntryToContextMessages));
  if(selection.messages.length!==capture.normalizedMessages.length+tail.length)throw new Error("effective-prefix-truncated-batch");
  const tools=getCurrentTools(selection.messages);
  if(tools.map(t=>t.name).join("\0")!==pi.getActiveTools().join("\0"))throw new Error("effective-prefix-tool-loadout-changed");
  if (!selection.exactRequestPrefix || !selection.messages.some((m) => m.role === "system") || stableMessagePrefix(selection.messages).length !== selection.messages.length) throw new Error("effective-prefix-incomplete");
  return selection.messages;
}

/**
 * Only context-window failures route the main slot to small mode. Output-limit failures (stop
 * reason `length`) use the same-slot retry allowance first; exhausted retries degrade to native,
 * not small. Other failures keep the configured adoption rule and degrade to native.
 */
export const routesToSmall = (error: unknown): boolean => /context.{0,30}(overflow|window|length|limit)|maximum.{0,20}context/i.test(String(error));

export const ADMISSION_MARGIN = 256;
export interface Admission {
  contextSource: "provider-usage" | "estimate"; reason?: string;
  providerUsageTokens: number | null; observedUncachedTokens?: number; usageEntryId: string | null; usageModel: string | null;
  estimatedTrailing: number; estimatedAppend: number; estimatedPrefix: number;
  outputBudget: number; margin: number; window: number; total: number; passed: boolean; method: string;
}
/** Pi's projection rule: usage after the latest context_edit/compaction still describes this context. */
function lastProviderUsage(branch: SessionEntry[]): { entryId: string; message: AssistantMessage } | { reason: string } {
  const projection = buildSessionProjection(branch, branch.at(-1)?.id ?? null);
  for (const { sourceEntry, messages } of [...projection.entries].reverse()) {
    const message = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error" && validUsage(m.usage));
    if (!message) continue;
    const at = branch.findIndex((e) => e.id === sourceEntry.id);
    if (branch.slice(at + 1).some((e) => e.type === "context_edit" || e.type === "compaction")) return { reason: "usage-before-context-edit-or-compaction" };
    return { entryId: sourceEntry.id, message };
  }
  return { reason: "no-provider-usage" };
}
/** Main headroom: provider-measured context plus estimates only for content after that measurement. */
export function mainAdmission(branch: SessionEntry[], prefix: Message[], append: string, outputBudget: number, window: number, target?: { provider: string; id: string }): Admission {
  const estimatedAppend = textTokens(append), estimatedPrefix = contextTokens(prefix);
  const usage = lastProviderUsage(branch);
  const at = "message" in usage ? prefix.findLastIndex((m) => m.role === "assistant" && m.timestamp === usage.message.timestamp) : -1;
  const modelMatches = target && "message" in usage && usage.message.provider === target.provider && usage.message.model === target.id;
  const changedModel = "message" in usage && branch.slice(branch.findIndex(e => e.id === usage.entryId) + 1).some(e => e.type === "model_change" && (!target || e.provider !== target.provider || e.modelId !== target.id));
  const measured = !!modelMatches && !changedModel && "message" in usage && at >= 0;
  const providerUsageTokens = measured ? calculateContextTokens(usage.message.usage) : null;
  const trailing = measured ? prefix.slice(at + 1) : prefix;
  const estimatedTrailing = contextTokens(trailing);
  const total = (providerUsageTokens ?? 0) + estimatedTrailing + estimatedAppend + outputBudget + ADMISSION_MARGIN;
  return {
    contextSource: measured ? "provider-usage" : "estimate",
    ...(measured ? {} : { reason: "reason" in usage ? usage.reason : !modelMatches || changedModel ? "usage-model-mismatch" : "usage-message-not-in-request-prefix" }),
    providerUsageTokens, ...(measured ? { observedUncachedTokens: usage.message.usage.input + usage.message.usage.output } : {}), usageEntryId: measured ? usage.entryId : null,
    usageModel: measured ? `${usage.message.provider}/${usage.message.model}` : null,
    estimatedTrailing, estimatedAppend, estimatedPrefix, outputBudget, margin: ADMISSION_MARGIN, window, total, passed: total <= window, method: CONTEXT_TOKEN_METHOD,
  };
}

export interface MainMemorySelection {
  requestedMode: Config["mainMemory"];
  effectiveMode: Config["mainMemory"];
  fellBack: boolean;
  fullAdmission?: Admission;
}

/** Assemble and admit the actual main request; retry an oversized full-memory append as digest. */
export function mainRequest(
  branch: SessionEntry[], prefix: Message[], config: Pick<Config, "mainMemory" | "outputTokens">, window: number,
  input: { instruction: string; materials: Materials; focus: string }, target?: { provider: string; id: string },
): { append: string; admission: Admission; memory: MainMemorySelection } {
  const { instruction, materials, focus } = input;
  const memory: MainMemorySelection = { requestedMode: config.mainMemory, effectiveMode: config.mainMemory, fellBack: false };
  const assemble = (mode: Config["mainMemory"]) => {
    const refs = mode === "full" ? materials.memory : materials.memory.map(({ contents, ...ref }) => ref);
    const supplemental = `Current goal snapshot: ${JSON.stringify(materials.goal)}\nLoaded skill references: ${JSON.stringify(materials.skills.map(({ name, path }) => ({ name, path })))}\nCurrent memory ${mode === "full" ? "full text" : "digests"}: ${JSON.stringify(refs)}`;
    return `${instruction}\n\n${supplemental}\n\n${focus}`;
  };
  let append = assemble(memory.effectiveMode);
  let admission = mainAdmission(branch, prefix, append, config.outputTokens, window, target);
  if (config.mainMemory === "full" && !admission.passed) {
    memory.fullAdmission = admission;
    memory.effectiveMode = "digest";
    memory.fellBack = true;
    append = assemble("digest");
    admission = mainAdmission(branch, prefix, append, config.outputTokens, window, target);
  }
  return { append, admission, memory };
}
