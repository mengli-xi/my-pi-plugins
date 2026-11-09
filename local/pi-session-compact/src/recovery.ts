import { buildSessionProjection, convertToLlm, type CompactionResult, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { fits, contextTokens, textTokens } from "./budget.ts";
import { boundedContextTokens, retainedMessages, type RecoveryBound } from "./preflight.ts";
export interface RestoreRef { sourceEntryId: string; name: string; path: string; contentHash: string; reason: string }
export const recoveryText = (): string => "按用户最新有效要求继续当前任务；累计原话是历史，后来的明确更正优先。已完成的工作不要因压缩再做。运行状态和结果以各自管理组件及实际交付的通知为准，不因历史状态重复启动或自行续跑。";
export interface RecoveryOptions { bound?: RecoveryBound; recoveryAppendix?: string; systemMessage?: SystemMessage; additionalTokens?: number; reserveTokens?: number; handoff?: string; quotations?: string; inventory?: string }
export function restoredContext(branch: SessionEntry[], result: CompactionResult, window: number, options: RecoveryOptions = {}) {
  const before = convertToLlm(buildSessionProjection(branch, branch.at(-1)?.id ?? null).messages);
  const systemMessage = options.systemMessage ?? getCurrentSystemMessage(before);
  const timestamp = new Date().toISOString();
  const checkpoint: SessionEntry = { type: "compaction", id: "compact-window-check", parentId: branch.at(-1)?.id ?? null, timestamp, firstKeptEntryId: result.firstKeptEntryId, summary: result.summary, tokensBefore: result.tokensBefore, ...(systemMessage ? { systemMessage } : {}) };
  const projected = convertToLlm(buildSessionProjection([...branch, checkpoint], checkpoint.id).messages);
  const baselineCheckpoint = { ...checkpoint, summary: options.recoveryAppendix && result.summary.endsWith(options.recoveryAppendix) ? result.summary.slice(0, -options.recoveryAppendix.length) : result.summary };
  const baseline = convertToLlm(buildSessionProjection([...branch, baselineCheckpoint], checkpoint.id).messages);
  const currentSystem = getCurrentSystemMessage(projected);
  const systemAndTools = contextTokens(currentSystem ? [currentSystem] : []);
  const sized = boundedContextTokens(projected, retainedMessages(branch, result.firstKeptEntryId), options.bound);
  const total = sized.total + (options.additionalTokens ?? 0);
  const summary = contextTokens(convertToLlm(buildSessionProjection([checkpoint], checkpoint.id).messages).filter(m => m.role !== "system"));
  const recoveryPackage = contextTokens(projected) - contextTokens(baseline);
  const retainedRecentUnbounded = Math.max(0, contextTokens(projected) - systemAndTools - summary);
  const retainedRecent = retainedRecentUnbounded - sized.retainedEstimate + sized.retainedBounded;
  const estimated = { systemAndTools, summary, handoff: textTokens(options.handoff ?? result.summary), quotations: textTokens(options.quotations ?? ""), inventory: textTokens(options.inventory ?? ""), retainedRecent, retainedRecentUnbounded, recoveryPackage, otherInjected: options.additionalTokens ?? 0, outputReserve: options.reserveTokens ?? 0, total, unboundedTotal: sized.unbounded + (options.additionalTokens ?? 0), providerUpperBound: options.bound, method: sized.method };

  return { fits: fits(total, options.reserveTokens ?? 0, window), estimated };
}
export const describeOverflow = (estimate: ReturnType<typeof restoredContext>["estimated"], window: number): string => `完整恢复上下文放不下：窗口 ${window}；正文 ${estimate.handoff}、原话 ${estimate.quotations}、文件清单 ${estimate.inventory}、尾部 ${estimate.retainedRecent}、恢复包 ${estimate.recoveryPackage}、系统/工具 ${estimate.systemAndTools}、其他注入 ${estimate.otherInjected}、输出余量 ${estimate.outputReserve}，合计约 ${estimate.total} tokens（另计安全余量）。保留原会话，不删减内容。`;
