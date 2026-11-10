import type { Usage } from "@earendil-works/pi-ai";

export type CacheObservation =
  | { status: "hit"; cacheRead: number; cacheWrite: number; promptTokens: number }
  | { status: "miss"; cacheRead: 0; cacheWrite: number; promptTokens: number }
  | { status: "unknown"; cacheRead: 0; cacheWrite: 0; promptTokens: 0 };

export function observeCache(usage: Usage): CacheObservation {
  const promptTokens = Math.max(0, usage.input + usage.cacheRead + usage.cacheWrite);
  if (promptTokens === 0) {
    return { status: "unknown", cacheRead: 0, cacheWrite: 0, promptTokens: 0 };
  }
  if (usage.cacheRead > 0) {
    return {
      status: "hit",
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      promptTokens,
    };
  }
  return {
    status: "miss",
    cacheRead: 0,
    cacheWrite: usage.cacheWrite,
    promptTokens,
  };
}
