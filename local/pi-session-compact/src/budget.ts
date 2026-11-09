import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

export const TOKEN_METHOD = "unicode-conservative-v1";
export const hash = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
/** An estimate, never provider usage. Non-ASCII receives one token per code point. */
export function tokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let ascii = 0, other = 0;
  for (const cp of text) cp.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 3) + other;
}
export const reserveForWindow = (window: number): number => Math.ceil(window * 0.1);
/** Stock Pi's strict reserve-based boundary; triggerTokens is the first integer above it. */
export function reserveThreshold(window: number, reserve: number) {
  if (!Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(reserve) || reserve < 0) return undefined;
  const boundaryTokens = window - reserve;
  return { comparison: ">" as const, boundaryTokens, triggerTokens: boundaryTokens + 1, ratio: boundaryTokens / window };
}
export const overThreshold = (input: number, window: number): boolean => input > window - reserveForWindow(window);
export function fits(input: number, output: number, window: number): boolean {
  return input + output + Math.ceil(input * 0.1) + 256 <= window;
}
export interface Throughput {
  version: string; measuredAt: string; inputTokensPerSecond: number; outputTokensPerSecond: number;
  safetyFactor: number; cache: "cold"; concurrency: "single" | "shadow";
}
/** Conservative planning assumptions, not measurements or a provider/model profile.
 * Missing/stale profiles use these estimates; actual total/single deadlines remain enforced.
 */
export const DEFAULT_THROUGHPUT = {inputTokensPerSecond:2000,outputTokensPerSecond:120,safetyFactor:3};
export function deadlinePlan(input:number,output:number,profile:Throughput|undefined,concurrency:"single"|"shadow",now=Date.now()) {
  const usable=profile&&profile.version&&Number.isFinite(Date.parse(profile.measuredAt))&&now-Date.parse(profile.measuredAt)<=7*86400000&&Date.parse(profile.measuredAt)<=now+60000&&profile.cache==="cold"&&profile.concurrency===concurrency&&[profile.inputTokensPerSecond,profile.outputTokensPerSecond,profile.safetyFactor].every(x=>Number.isFinite(x)&&x>0)&&profile.safetyFactor>=1;
  const rates=usable?profile:DEFAULT_THROUGHPUT;
  return {milliseconds:Math.ceil(1000*rates.safetyFactor*(input/rates.inputTokensPerSecond+output/rates.outputTokensPerSecond)),throughputSource:usable?"measured":profile?"stale":"default",rates};
}
export function deadline(input: number, output: number, profile: Throughput | undefined, concurrency: "single" | "shadow", now = Date.now()): number {
  return deadlinePlan(input,output,profile,concurrency,now).milliseconds;
}

/** Model-visible context uses stock Pi's message estimator, never serialized session JSON.
 * In Pi 1.5 image data costs a fixed 1,200 tokens, and tool-result details are not content.
 */
export const CONTEXT_TOKEN_METHOD = "pi-estimateTokens-1.5";
export function contextTokens(messages: readonly Parameters<typeof estimateTokens>[0][]): number {
  const system = getCurrentSystemMessage(messages as Parameters<typeof getCurrentSystemMessage>[0]);
  return (system ? estimateTokens(system) : 0) + messages.reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)), 0);
}
export const textTokens = (text: string): number => estimateTokens({ role: "user", content: text, timestamp: 0 });
