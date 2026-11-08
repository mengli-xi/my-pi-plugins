import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ReasoningEffort, ResolvedAgentRoleV1 } from "../roles/types.js";
import { matchesQueryWordsV1, queryWordsV1, SEARCH_RESULT_LIMIT_V1 } from "./search.js";

export interface ScopedModelInputV1 { readonly model: Model<any>; readonly thinkingLevel?: ReasoningEffort }

export interface FrozenExecutionSelectionV1 {
  readonly provider: string;
  readonly modelId: string;
  readonly canonicalModel: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly serviceTier?: string;
}

function clean(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > 256 || value.includes("\0") || value.normalize("NFC") !== value) throw new Error(`${label} is invalid`);
  return value;
}
function sameModel(left: Model<any> | undefined, right: Model<any>): boolean { return left?.provider === right.provider && left.id === right.id; }
function findExactModelReferenceMatch(reference: string, models: readonly Model<any>[]): Model<any> | undefined {
  const slash = reference.indexOf("/");
  if (slash > 0) {
    const provider = reference.slice(0, slash); const id = reference.slice(slash + 1);
    return models.find((model) => model.provider === provider && model.id === id);
  }
  const matches = models.filter((model) => model.id === reference);
  return matches.length === 1 ? matches[0] : undefined;
}
function unsupportedEffortMessage(effort: ReasoningEffort, supported: readonly ReasoningEffort[]): string {
  return `reasoning effort is unsupported: ${effort}; supported: ${supported.join(", ")}`;
}

interface ModelSearchInputV1 {
  readonly availableModels: readonly Model<any>[];
  readonly scopedModels: readonly ScopedModelInputV1[];
  readonly query: string;
  /** spawn_agent 必然拒绝的 provider（没有唯一的 Subagent owner 扩展）。 */
  readonly excludeProviderIds?: ReadonlySet<string>;
}

export interface SubagentModelSearchV1 {
  readonly models: readonly string[];
  readonly unavailable: readonly { readonly id: string; readonly reason: string }[];
  readonly more?: number;
}

export function listSubagentModelsV1(input: ModelSearchInputV1): SubagentModelSearchV1 {
  const words = queryWordsV1(input.query);
  const canonical = (model: Model<any>): string => `${model.provider}/${model.id}`;
  const compare = (left: string, right: string): number => Buffer.from(left).compare(Buffer.from(right));
  const scopedIds = new Set(input.scopedModels.map((entry) => canonical(entry.model)));
  const candidates = new Map(input.availableModels.concat(input.scopedModels.map((entry) => entry.model)).map((model) => [canonical(model), model]));
  const ids = [...candidates.keys()].sort(compare);
  const exact = ids.find((id) => id.toLowerCase() === input.query.trim().toLowerCase());
  const matches = exact ? [exact] : ids.filter((id) => matchesQueryWordsV1(id, words));
  const models: string[] = [];
  const unavailable: { readonly id: string; readonly reason: string }[] = [];
  for (const id of matches.slice(0, SEARCH_RESULT_LIMIT_V1)) {
    const model = candidates.get(id)!;
    // Provider rejection takes precedence when both restrictions apply.
    const reason = input.excludeProviderIds?.has(model.provider) ? "provider has no subagent support"
      : scopedIds.size > 0 && !scopedIds.has(id) ? "outside --models scope" : undefined;
    if (reason) unavailable.push(Object.freeze({ id, reason }));
    else models.push(id);
  }
  return Object.freeze({
    models: Object.freeze(models),
    unavailable: Object.freeze(unavailable),
    ...(matches.length > SEARCH_RESULT_LIMIT_V1 ? { more: matches.length - SEARCH_RESULT_LIMIT_V1 } : {}),
  });
}

export function listSubagentModelIdsV1(input: ModelSearchInputV1): readonly string[] {
  return listSubagentModelsV1(input).models;
}

export function resolveFrozenExecutionSelectionV1(input: {
  readonly availableModels: readonly Model<any>[];
  readonly scopedModels: readonly ScopedModelInputV1[];
  readonly parentModel?: Model<any>;
  readonly parentThinkingLevel?: ReasoningEffort;
  readonly role: ResolvedAgentRoleV1;
  readonly explicitModel?: string;
  readonly explicitReasoningEffort?: ReasoningEffort;
  readonly explicitServiceTier?: string;
}): FrozenExecutionSelectionV1 {
  const allowed = input.scopedModels.length > 0 ? input.scopedModels.map((entry) => entry.model) : [...input.availableModels];
  const modelReference = input.explicitModel ?? input.role.frontmatter.model;
  let model: Model<any> | undefined;
  if (modelReference !== undefined) model = findExactModelReferenceMatch(clean(modelReference, "model"), allowed as Model<any>[]);
  else if (input.parentModel && allowed.some((candidate) => sameModel(input.parentModel, candidate))) model = allowed.find((candidate) => sameModel(input.parentModel, candidate));
  if (!model) throw new Error("model is unavailable in the parent scope");
  const explicitEffort = input.explicitReasoningEffort ?? input.role.frontmatter.reasoning_effort;
  let reasoningEffort: ReasoningEffort;
  const supported = getSupportedThinkingLevels(model) as ReasoningEffort[];
  if (explicitEffort !== undefined) {
    if (!supported.includes(explicitEffort)) throw new Error(unsupportedEffortMessage(explicitEffort, supported));
    reasoningEffort = explicitEffort;
  } else if (sameModel(input.parentModel, model) && input.parentThinkingLevel !== undefined) {
    if (!supported.includes(input.parentThinkingLevel)) throw new Error(unsupportedEffortMessage(input.parentThinkingLevel, supported));
    reasoningEffort = input.parentThinkingLevel;
  } else reasoningEffort = clampThinkingLevel(model, "medium") as ReasoningEffort;
  const serviceTier = input.explicitServiceTier ?? input.role.frontmatter.service_tier;
  return Object.freeze({ provider: model.provider, modelId: model.id, canonicalModel: `${model.provider}/${model.id}`, reasoningEffort, ...(serviceTier === undefined ? {} : { serviceTier: clean(serviceTier, "service tier") }) });
}
