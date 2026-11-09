import { requestPlan, type RequestPlan } from "./request-plan.ts";
import type { CompactionDeadline } from "./deadline.ts";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { buildSessionProjection, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { fits, contextTokens, textTokens } from "./budget.ts";
import type { Context, Message } from "@earendil-works/pi-ai";
import { withRequestRetries, type RequestRetryOptions } from "./retry.ts";
import { generate, type Attempt, type RequestRecord } from "./generate.ts";
import { generationInstruction, validateOutput, type ValidatedOutput } from "./output.ts";
import { contentParts, editedEntryIds } from "./sources.ts";
import type { Materials } from "./materials.ts";
import type { FocusSnapshot } from "./focus.ts";
import { filterMailboxMessages } from "pi-session-inject/mailbox-v1/light";

export interface SourceUnit { entryId: string; role: string; partIndex: number; start: number; end: number; text: string; group: string; entryType?: string; edited?: true }
/** Read original session entries at the frozen branch IDs; do not reinterpret visibility as source loss. */
export async function readFrozenEntries(ctx: ExtensionContext, branch: SessionEntry[], signal: AbortSignal): Promise<SessionEntry[]> {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) return branch;
  const ids = new Set(branch.map((e) => e.id));
  const found = new Map<string, SessionEntry>();
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as SessionEntry;
      if (ids.has(entry.id)) found.set(entry.id, entry);
    }
  } finally { reader.close(); }
  if (branch.some((e) => !found.has(e.id))) throw new Error("frozen-session-source-incomplete");
  return branch.map((e) => found.get(e.id)!);
}
export function sourceUnits(branch: SessionEntry[], projection = buildSessionProjection(branch, branch.at(-1)?.id ?? null)): SourceUnit[] {
  const units: SourceUnit[] = [];
  const editedIds = editedEntryIds(branch);
  let group = "preamble";
  for (const { sourceEntry: e, messages } of projection.entries) {
    const parts = contentParts(e, messages);
    if (parts.some(p => p.role === "user")) group = e.id;
    if (parts.some(p => p.kind === "toolCall")) group = `tool-batch:${e.id}`;
    for (const p of parts) {
      const text = p.text ?? `[image: ${p.media?.mimeType}; visual interpretation unavailable]`;
      units.push({ entryId: e.id, entryType: e.type, role: p.role, partIndex: p.partIndex, start: 0, end: p.kind === "toolCall" || p.kind === "image" ? 0 : [...text].length, text, group, ...(editedIds.has(e.id) ? { edited: true } : {}) });
    }
  }
  return units;
}
/** IDs and ranges belong to internal chunk planning, never the model-facing handoff. */
export const unitText = (u: SourceUnit) => `${u.role}:\n${u.text}`;
/** Complete groups first; oversize text is divided by code point with no missing range. */
export function chunkUnits(units: SourceUnit[], makeMessages: (items: SourceUnit[]) => Message[], output: number, window: number): SourceUnit[][] {
  const groups: SourceUnit[][] = [];
  for (const unit of units) {
    const last = groups.at(-1);
    if (last?.[0]?.group === unit.group) last.push(unit); else groups.push([unit]);
  }
  const chunks: SourceUnit[][] = [];
  let current: SourceUnit[] = [];
  const canFit = (items: SourceUnit[]) => fits(contextTokens(makeMessages(items)), output, window);
  if (!canFit([])) throw new Error("small-common-prefix-overflow");
  const add = (items: SourceUnit[]) => {
    if (!canFit([...current, ...items])) { if (current.length) chunks.push(current); current = []; }
    current.push(...items);
  };
  for (const group of groups) {
    if (canFit(group)) { add(group); continue; }
    for (const unit of group) {
      if (canFit([unit])) { add([unit]); continue; }
      if (unit.end === unit.start) throw new Error("oversized-tool-arguments");
      const cps = [...unit.text];
      for (let offset = 0; offset < cps.length;) {
        let low = 1, high = cps.length - offset, count = 0;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const piece = { ...unit, start: unit.start + offset, end: unit.start + offset + mid, text: cps.slice(offset, offset + mid).join("") };
          if (canFit([piece])) { count = mid; low = mid + 1; } else high = mid - 1;
        }
        if (!count) throw new Error("small-unit-annotation-overflow");
        add([{ ...unit, start: unit.start + offset, end: unit.start + offset + count, text: cps.slice(offset, offset + count).join("") }]); offset += count;
      }
    }
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [[]];
}
export async function generateSmall(ctx: ExtensionContext, config: Config, branch: SessionEntry[], focus: FocusSnapshot, materials: Materials, signal: AbortSignal, attempts: Attempt[], records: RequestRecord[], slot: string, output: { rawOutput?: string; requestPlan?: RequestPlan; effectiveModel?: string }, checkpoint: () => Promise<boolean>, retryOptions: RequestRetryOptions = { enabled: false }, deadline?: CompactionDeadline): Promise<{ rawOutput: string; validated: ValidatedOutput; model: string }> {
  const configured = config.smallModel;
  const model = configured ? ctx.modelRegistry.find(configured.provider, configured.id) : ctx.model;
  if (!model) throw new Error(configured ? `small-model-unavailable:${configured.provider}/${configured.id}` : "small-model-unconfigured:current-model-unavailable");
  const effort = configured?.effort ?? ctx.thinkingLevel ?? "off";
  if ((!model.reasoning && effort !== "off") || (effort !== "off" && model.thinkingLevelMap?.[effort] === null)) throw new Error(`small-effort-unsupported:${effort}`);
  const frozen = await readFrozenEntries(ctx, branch, signal);
  const projection = buildSessionProjection(frozen, frozen.at(-1)?.id ?? null);
  const visible = new Set(await filterMailboxMessages(ctx, projection.messages));
  const units = sourceUnits(frozen, { ...projection, entries: projection.entries.map(entry => ({ ...entry, messages: entry.messages.filter(message => visible.has(message)) })) });
  const memory = materials.memory.map(m => `Current memory ${m.path}\n${m.contents}`).join("\n\n");
  const skill = materials.skills.map(s => `Loaded skill ${s.name}; path=${s.path}\n${s.contents}`).join("\n\n");
  // The public projection already includes the previous summary, exactly once.
  const instruction = generationInstruction("small");
  const common = `${instruction}\n\nCurrent goal snapshot (historical observation): ${JSON.stringify(materials.goal)}\n${materials.known.map(k => k.statement).join("\n")}\n\n${memory}\n\n${skill}\n\n${focus.mergedText}`;
  const makeContext = (text: string): Context => ({ messages: [{ role: "user", content: text, timestamp: 0 }] });
  const sourceContext = (items: SourceUnit[], final: boolean) => makeContext(`${common}\n\n${final ? "Generate the final handoff." : "Write a temporary handoff of only this material. Preserve requirements, findings, blockers and next steps for synthesis."}\n\n${items.map(unitText).join("\n\n")}`);
  const prefixTokens = contextTokens(sourceContext([], false).messages);
  const inputTokens = contextTokens(sourceContext(units, true).messages);
  const plan = requestPlan(config, model, effort, inputTokens, config.outputTokens, deadline?.remainingMs());
  output.requestPlan = plan;
  output.effectiveModel = `${model.provider}/${model.id}`;
  const ratio = plan.fitsDeadline || !Number.isFinite(plan.availableMs) ? 1 : 2;
  const chunkWindow = Math.max(prefixTokens * 1.1 + config.outputTokens + 1024, model.contextWindow / ratio);
  const chunks = plan.fitsDeadline && fits(inputTokens, config.outputTokens, model.contextWindow) ? [units] : chunkUnits(units, items => sourceContext(items, false).messages, config.outputTokens, Math.min(model.contextWindow, chunkWindow));
  const request = (context: Context, phase: string) => withRequestRetries(config, signal, attempts, checkpoint, retryOptions, async retry => {
    try { await generate(ctx, config, model!, context, effort, signal, attempts, records, slot, phase, { sources: { messages: contextTokens(context.messages), memory: textTokens(memory), skill: textTokens(skill), compactInstructions: focus.estimatedTokens } }, checkpoint, "plugin", retry, deadline); }
    finally { output.rawOutput = attempts.at(-1)?.rawOutput; }
    attempts.at(-1)!.requestPlan = plan;
    const rawOutput = attempts.at(-1)!.rawOutput!;
    const validated = validateOutput(rawOutput);
    deadline?.throwIfExpired(); signal.throwIfAborted();
    return { rawOutput, validated, model: `${model!.provider}/${model!.id}` };
  });
  const outputs: string[] = [];
  for (const chunk of chunks) {
    const final = chunks.length === 1;
    const result = await request(sourceContext(chunk, final), final ? "small" : "chunk");
    if (final) return result;
    outputs.push(result.validated.summary);
  }
  const synthesis = `${common}\n\nAll ${chunks.length} chunks completed. Synthesize their temporary handoffs into ordinary Markdown. Preserve active requirements, completed work, conflicts and next actions.\n\n${outputs.join("\n\n")}`;
  if (!fits(contextTokens(makeContext(synthesis).messages), config.outputTokens, model.contextWindow)) throw new Error("small-synthesis-overflow");
  return request(makeContext(synthesis), "synthesis");
}
