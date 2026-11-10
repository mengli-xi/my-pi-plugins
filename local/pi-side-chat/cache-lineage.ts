import type { Api } from "@earendil-works/pi-ai";

const PAYLOAD_STRATEGIES: Partial<Record<Api, (payload: unknown, lineage: string) => unknown>> = {
  "openai-responses": rewriteOpenAIResponses,
  "openai-codex-responses": rewriteOpenAIResponses,
};

function rewriteOpenAIResponses(payload: unknown, lineage: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (!("prompt_cache_key" in record)) return payload;
  return { ...record, prompt_cache_key: lineage };
}

export function rewritePromptCacheLineage(
  api: Api,
  payload: unknown,
  lineage: string,
): unknown {
  return PAYLOAD_STRATEGIES[api]?.(payload, lineage) ?? payload;
}

export function supportsPromptCacheLineage(api: Api): boolean {
  return PAYLOAD_STRATEGIES[api] !== undefined;
}
