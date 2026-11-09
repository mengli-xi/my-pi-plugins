import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Config } from "./config.ts";
import { deadlinePlan } from "./budget.ts";

export interface RequestPlan { model: string; inputTokens: number; predictedMs: number; availableMs: number; fitsDeadline: boolean; throughputSource: "measured" | "default" | "stale"; inputTokenLimit: number; reason: string }
/** Plan before sending: bounded output estimate for timing, explicit wire output limit unchanged. */
export function requestPlan(config: Config, model: Model<any>, effort: ModelThinkingLevel | undefined, input: number, outputEstimate: number, availableMs = Infinity): RequestPlan {
  // Output capacity is a generation limit and timing estimate, never a rendered-summary quota.
  const output = Math.min(config.outputTokens, Math.max(1024, outputEstimate));
  const prediction = deadlinePlan(input, output, config.throughput[`${model.provider}/${model.id}/${effort}`], config.shadow.enabled ? "shadow" : "single");
  const rates = prediction.rates;
  const inputTokenLimit = Number.isFinite(availableMs) ? Math.max(0, Math.floor((availableMs / 1000 / rates.safetyFactor - output / rates.outputTokensPerSecond) * rates.inputTokensPerSecond)) : Infinity;
  return { model: `${model.provider}/${model.id}`, inputTokens: input, throughputSource: prediction.throughputSource as RequestPlan["throughputSource"], predictedMs: prediction.milliseconds, availableMs, fitsDeadline: prediction.milliseconds <= availableMs, inputTokenLimit, reason: prediction.milliseconds <= availableMs ? "complete request fits active deadline estimate" : "complete request exceeds active deadline estimate; use bounded source chunks" };
}
