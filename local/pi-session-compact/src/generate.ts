import type { CompactionDeadline } from "./deadline.ts";
import type { RetryInfo } from "./retry.ts";
import type { Context, Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { deadlinePlan, contextTokens, textTokens, fits, CONTEXT_TOKEN_METHOD } from "./budget.ts";
import { PROMPT_VERSION, type PromptVariant } from "./output.ts";

export interface Attempt {
  requestAttempt?: number; retry?: RetryInfo; retryScheduled?: RetryInfo;
  promptVersion?: number; promptVariant?: PromptVariant;
  phase: string; model: string; requestedEffort: string; effectiveEffort: string; wireEffort: null; wireModel: null;
  inputTokens: number; outputTokenBudget: number | null; outputTokens: number | null; reasoningTokens: number | null;
  deadlineOutputTokens: number; deadlineOutputTokenSource: "request" | "model" | "fallback";
  effectiveDeadlineMs?: number; activeElapsedMs?: number; cacheRead: number | null; usageKnown: boolean; predictedDeadlineMs: number | null; elapsedMs: number;
  stopReason?: string; providerError?: string; outputSource?: "tool" | "text"; toolCalls?: unknown[]; protocolDeviation?: string;  error?: string; usage?: AssistantMessage["usage"]; sent?:boolean;
  requestPlan?: unknown; throughputSource?:string;throughputRates?:unknown;calibrationSample?:unknown;
  status?:"started"|"settled"|"interrupted";rawOutput?:string;windowAdmission?:WindowAdmission;
  timings: { ttftMs: number | null; queueMs: number | null; generateMs: number | null };
}
/** plugin checks full configured output; caller has proven main admission; none is native with its own output policy. */
export type WindowAdmission = "plugin" | "caller" | "none";
export interface RequestRecord { phase: string; slot: string; estimated: Record<string, unknown>; providerReported: Record<string, unknown> | null; prefixCache?: Record<string, unknown> }
/** null means no request-level output limit; deadline estimates never become wire limits. */
export async function generate(ctx: ExtensionContext, config: Config, model: Model<any>, context: Context, effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined, parent: AbortSignal, attempts: Attempt[], records: RequestRecord[], slot: string, phase: string, estimated: Record<string, unknown>, checkpoint:()=>Promise<boolean>, admission: WindowAdmission = "plugin", retry?: RetryInfo, deadline?: CompactionDeadline, outputTokenBudget: number | null = config.outputTokens): Promise<AssistantMessage> {
  parent.throwIfAborted();
  deadline?.throwIfExpired();
  const inputTokens = contextTokens(context.messages) + (context.tools?.length ? textTokens(JSON.stringify(context.tools)) : 0);
  if (admission !== "none") {
    if (config.outputTokens > model.maxTokens && model.maxTokens > 0) throw new Error("provider-output-limit-exceeded");
    if(admission === "plugin" && !fits(inputTokens,config.outputTokens,model.contextWindow))throw new Error("request-context-window-overflow");
  }
  if (admission === "none" && !fits(inputTokens, 0, model.contextWindow)) throw new Error("native-request-context-window-overflow");
  if (model.inputLimits?.maxRequestBytes && Buffer.byteLength(JSON.stringify(context)) > model.inputLimits.maxRequestBytes) throw new Error("provider-input-byte-limit-exceeded");
  const modelOutputKnown = Number.isFinite(model.maxTokens) && model.maxTokens > 0;
  // With unknown metadata, allow a conservative 64k output for timing only.
  const deadlineOutputTokens = outputTokenBudget ?? (modelOutputKnown ? model.maxTokens : 65536);
  const deadlineOutputTokenSource = outputTokenBudget !== null ? "request" : modelOutputKnown ? "model" : "fallback";
  const timingInput = typeof estimated.deadlineInputTokens === "number" ? estimated.deadlineInputTokens : inputTokens;
  const plan = deadlinePlan(timingInput, deadlineOutputTokens, config.throughput[`${model.provider}/${model.id}/${effort}`], config.shadow.enabled ? "shadow" : "single");
  const predictedDeadlineMs=plan.milliseconds;
  const attempt: Attempt = { phase, model: `${model.provider}/${model.id}`, requestedEffort: effort ?? "off", effectiveEffort: effort ?? "off", wireEffort: null, wireModel: null, inputTokens, outputTokenBudget, deadlineOutputTokens, deadlineOutputTokenSource, outputTokens: null, reasoningTokens: null, cacheRead: null, usageKnown: false, predictedDeadlineMs, elapsedMs: 0, timings: { ttftMs: null, queueMs: null, generateMs: null } };
  if (phase === "main" || phase === "small" || phase === "chunk" || phase === "synthesis") {
    attempt.promptVersion = PROMPT_VERSION;
    attempt.promptVariant = phase === "main" ? "main" : "small";
  }
  if (retry) { attempt.retry = retry; attempt.requestAttempt = retry.attempt; } else attempt.requestAttempt = 1;
  attempts.push(attempt);
  attempt.windowAdmission=admission;
  attempt.throughputSource=plan.throughputSource;attempt.throughputRates=plan.rates;
  const record: RequestRecord = { phase, slot, estimated: { ...estimated, total: inputTokens, method: CONTEXT_TOKEN_METHOD }, providerReported: null };
  if (phase === "main") record.prefixCache = { measuredHit: null, measuredMiss: null, evidence: "unknown; provider aggregate only" };
  records.push(record);
  attempt.status="started";
  try {
    if (!await checkpoint() && slot !== "native") throw new Error("attempt-log-unavailable");
    parent.throwIfAborted(); deadline?.throwIfExpired();
  } catch (error) {
    attempt.error = String(error); attempt.status = "settled"; await checkpoint(); throw error;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  parent.addEventListener("abort", cancel, { once: true });
  attempt.effectiveDeadlineMs = Math.min(predictedDeadlineMs, deadline?.remainingMs() ?? Infinity);
  const activeTimer = deadline?.attempt(model.provider, predictedDeadlineMs, () => controller.abort(new Error("dynamic-deadline-exceeded")));
  const timer = activeTimer ? undefined : setTimeout(() => controller.abort(new Error("dynamic-deadline-exceeded")), Math.min(predictedDeadlineMs, 2147483647));
  const started = performance.now();
  ctx.ui.notify(`正在压缩：${phase}${retry ? `（第 ${retry.attempt - 1} 次重试：${retry.kind === "invalid-output" ? "内容" : "网络"}）` : ""}，输入约 ${inputTokens} tokens，预算 ${Math.ceil(attempt.effectiveDeadlineMs / 1000)} 秒（${plan.throughputSource==="measured"?"实测速率":"保守默认速率"}）。`, "info");
  try {
    controller.signal.throwIfAborted();
    attempt.sent=true;
    const stream = ctx.modelRegistry.streamSimple(model, context, { reasoning: effort === "off" ? undefined : effort, ...(outputTokenBudget === null ? {} : { maxTokens: outputTokenBudget }), signal: controller.signal,sessionId:ctx.sessionManager.getSessionId() });
    let terminal = false;
    for await (const event of stream) {
      if (event.type === "done" || event.type === "error") terminal = true;
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
        activeTimer?.progress();
        if (attempt.timings.ttftMs === null) attempt.timings.ttftMs = performance.now() - started;
      }
    }
    if (!terminal) throw new Error("stream interrupted before terminal response");
    const response = await stream.result();
    attempt.rawOutput=responseText(response);
    if (response.stopReason === "error") attempt.providerError = response.errorMessage;
    const calls = response.content.filter(p => p.type === "toolCall");
    if (calls.length) { attempt.toolCalls = calls; attempt.protocolDeviation = "Returned tool calls were ignored; no tool was executed."; }
    attempt.usage = response.usage; attempt.usageKnown = true;
    attempt.outputTokens = response.usage.output; attempt.reasoningTokens = response.usage.reasoning ?? null; attempt.cacheRead = response.usage.cacheRead; attempt.stopReason = response.stopReason;
    record.providerReported = { input: response.usage.input, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, output: response.usage.output, reasoning: response.usage.reasoning ?? null, rawUsage: response.usage, semantics: "raw provider fields; input/cache are not summed" };
    controller.signal.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") throw new Error(`Invalid summarization stop: ${response.stopReason}${response.errorMessage ? ` ${response.errorMessage}` : ""}`);
    if (phase !== "native") {
      const output = smallResponseOutput(response);
      attempt.rawOutput = output.rawOutput;
      attempt.outputSource = output.outputSource;
    } else if (response.stopReason !== "stop" || !responseText(response).trim()) throw new Error(`Invalid native summarization stop/body: ${response.stopReason}`);
    attempt.outputSource ??= "text";
    return response;
  } catch (error) { if (controller.signal.aborted) error = controller.signal.reason ?? error; attempt.error = String(error); throw error; }
  finally {
    if (activeTimer) { const timing = activeTimer.snapshot(); attempt.activeElapsedMs = timing.activeElapsedMs; attempt.timings.queueMs = timing.queueMs; activeTimer.stop(); }
    attempt.elapsedMs = performance.now() - started;
    attempt.status="settled";
    attempt.timings.generateMs = attempt.timings.ttftMs === null ? null : attempt.elapsedMs - attempt.timings.ttftMs;
    if(config.calibration)attempt.calibrationSample={inputTokens:attempt.usage?.input??inputTokens,inputEstimate:!attempt.usage,outputTokens:attempt.outputTokens,reasoningTokens:attempt.reasoningTokens,ttftMs:attempt.timings.ttftMs,generateMs:attempt.timings.generateMs,measuredAt:new Date().toISOString()};
    if (timer) clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
    await checkpoint();
  }
}
export const responseText = (response: AssistantMessage) => response.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");

/** Returned calls are inert. Read legacy submit arguments only when no visible prose exists. */
export function smallResponseOutput(response: AssistantMessage): { rawOutput: string; outputSource: "tool" | "text" } {
  const text = responseText(response);
  if (text.trim()) return { rawOutput: text, outputSource: "text" };
  const legacy = response.content.find(p => p.type === "toolCall" && p.name === "submit_compaction");
  if (legacy?.type === "toolCall") {
    const rawOutput = typeof legacy.arguments === "string" ? legacy.arguments : JSON.stringify(legacy.arguments);
    if (rawOutput?.trim()) return { rawOutput, outputSource: "tool" };
  }
  throw new Error("empty-compaction-body");
}
