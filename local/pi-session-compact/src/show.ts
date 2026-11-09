import { buildSessionProjection, calculateContextTokens, convertToLlm, sessionEntryToContextMessages, type CompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fallbackDescription, type ModeSelection } from "./mode.ts";
import { textTokens, contextTokens, type reserveThreshold } from "./budget.ts";
import { renderUserQuotations, type UserQuotations } from "./quotations.ts";

/** The run-log fields `/compaction show` reads; everything is optional because logs may be partial. */
interface Slot { prefix?: { source: "capture" | "rebuilt"; reason: string }; mainMemory?: { effectiveMode?: string; fellBack?: boolean }; status?: string; effectiveMode?: string; fallbackReason?: string; error?: string; attempts?: Array<{ elapsedMs?: number; retry?: { kind: "invalid-output" | "network" }; outputSource?: "tool" | "text" }>; validated?: { summary?: string } }
interface OutputBudget { outputTokenBudget?: number | null; deadlineOutputTokens?: number; deadlineOutputTokenSource?: "request" | "model" | "fallback" }
export interface RunLog {
  totalDeadline?: { activeElapsedMs?: number; queuePausedMs?: number; limitMinutes?: number };
  modeSelection?: ModeSelection; triggerReason?: string; startedAt?: string; threshold?: Partial<NonNullable<ReturnType<typeof reserveThreshold>>> & { contextWindow?: number; effectiveWindow?: number; reserveTokens?: number; tokensBefore?: number; source?: string; native?: ReturnType<typeof reserveThreshold> };
  shadow?: { enabled?: boolean; adopt?: string }; outputs?: Record<string, Slot | undefined>;
  adopted?: { slot?: string; effectiveMode?: string } | null; degraded?: { occurred?: boolean; reason?: string; nativeFocusScope?: string; attempts?: OutputBudget[] };
  contextSizes?: { before?: { estimated?: { total?: number } }; requests?: Array<{ slot?: string; estimated?: { total?: number } }>; after?: { estimated?: { total?: number; summary?: number; handoff?: number; quotations?: number; inventory?: number; retainedRecent?: number; recoveryPackage?: number } | null; providerReported?: { rawUsage?: Parameters<typeof calculateContextTokens>[0] } | null } };
}
interface Details { handoff?: string; userQuotations?: UserQuotations; operationId?: string; generator?: string; effectiveMode?: string; restoreSkills?: Array<{ name?: string; path?: string }> }

const TRIGGERS: Record<string, string> = { manual: "手动 /compact", threshold: "Pi 原生阈值", overflow: "上下文溢出恢复", "session-window": "本会话有效窗口" };
const SHADOW: Record<string, string> = { generated: "完成", cancelled: "取消", failed: "失败", generating: "进行中", not_started: "未开始" };
const n = (value: number | undefined) => value === undefined ? "未知" : Math.round(value).toLocaleString("en-US");
const seconds = (slot: Slot | undefined) => `${((slot?.attempts ?? []).reduce((sum, a) => sum + (a.elapsedMs ?? 0), 0) / 1000).toFixed(1)} 秒`;

/** Exactly what Pi projects to the model for this compaction entry (prefix, summary, suffix). */
export function projectedSummary(entry: CompactionEntry): string {
  return convertToLlm(sessionEntryToContextMessages(entry)).filter((m) => m.role !== "system")
    .map((m) => typeof m.content === "string" ? m.content : m.content.flatMap((p) => p.type === "text" ? [p.text] : []).join("\n")).join("\n\n");
}

/** Read-only text for `/compaction show`: key facts from the run log, then the projected summary. */
export function describeCompaction(entry: CompactionEntry, branch: SessionEntry[], run: RunLog | undefined, runNote?: string): string {
  const details = (entry.details ?? {}) as Details;
  const lines = [`时间：${new Date(entry.timestamp).toLocaleString("zh-CN", { hour12: false })}（compaction ${entry.id}）`];
  if (!run) lines.push(runNote ?? "这次压缩不是 pi-session-compact 生成的，没有运行日志。");
  const slot = run?.adopted?.slot;
  const adopted = slot === "main" || slot === "small" ? run?.outputs?.[slot] : undefined;
  if (run) {
    const mode = slot === "native" ? `native（降级原因：${run.degraded?.reason ?? "未知"}）`
      : slot === "main" && adopted?.effectiveMode === "small" ? `small（main 槽回退：${adopted.fallbackReason ?? "未知"}）` : slot ?? "未采用";
    lines.push(`采用：${mode}`);
    if (slot === "native") {
      const attempt = run.degraded?.attempts?.at(-1);
      if (attempt?.outputTokenBudget !== undefined) {
        lines.push(`原生输出上限：${attempt.outputTokenBudget === null ? "跟随模型（无请求级上限）" : `${n(attempt.outputTokenBudget)} tokens`}`);
        if (attempt.deadlineOutputTokens !== undefined) lines.push(`原生单次时限估算：输出 ${n(attempt.deadlineOutputTokens)} tokens（${({ request: "请求上限", model: "模型元数据", fallback: "保守固定估计" })[attempt.deadlineOutputTokenSource!] ?? "来源未知"}，仅用于计时）`);
      }
      if (run.degraded?.nativeFocusScope) lines.push(`原生重点范围：${run.degraded.nativeFocusScope}`);
    }
    if (run.totalDeadline) {
      const duration = (ms = 0) => `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`;
      lines.push(`用时 ${duration(run.totalDeadline.activeElapsedMs)}（不含排队 ${duration(run.totalDeadline.queuePausedMs)}）；总时限 ${run.totalDeadline.limitMinutes === 0 ? "不限" : `${run.totalDeadline.limitMinutes ?? "未知"} 分钟`}`);
    }
    const retries = Object.values(run.outputs ?? {}).flatMap(output => output?.attempts ?? []).flatMap(attempt => attempt.retry ? [attempt.retry] : []);
    lines.push(`重试：${retries.length} 次（内容 ${retries.filter(retry => retry.kind === "invalid-output").length}，网络 ${retries.filter(retry => retry.kind === "network").length}）`);
    const source = adopted?.attempts?.at(-1)?.outputSource;
    if (source) lines.push(`摘要输出：${source === "tool" ? "兼容旧提交参数" : "Markdown 正文"}`);
    if (run.modeSelection) lines.push(`模式：${run.modeSelection.selectedMode}；原因：${run.modeSelection.reason}`);
    if (adopted?.effectiveMode === "small" && slot === "main" && adopted.fallbackReason) lines.push(fallbackDescription(adopted.fallbackReason));
    const prefix = run.outputs?.main?.prefix;
    if (prefix) lines.push(`Main 前缀：${prefix.source}（${prefix.source === "capture" ? "精确请求前缀" : "按当前会话历史重建"}）；原因：${prefix.reason}`);
    const memory = run.outputs?.main?.mainMemory;
    if (memory) lines.push(`Main 记忆：${memory.effectiveMode ?? "未知"}${memory.fellBack ? "（full 超预算，已退回 digest）" : ""}`);
    const t = run.threshold ?? {};
    lines.push(`触发：${run.triggerReason ?? "未知"}（${TRIGGERS[run.triggerReason ?? ""] ?? "未知"}）；${t.effectiveWindow ? `有效窗口 ${n(t.effectiveWindow)}，` : ""}模型窗口 ${n(t.contextWindow)}`);
    if (t.source === "session-window" && t.boundaryTokens !== undefined)
      lines.push(`本会话触发条件：tokens ${t.comparison ?? ">"} ${n(t.boundaryTokens)}（最早 ${n(t.triggerTokens)}）`);
    if (t.native) lines.push(`Pi 原生 reserve 关系（按选择模型窗口推导）：tokens ${t.native.comparison} ${n(t.native.boundaryTokens)}（最早 ${n(t.native.triggerTokens)}，边界 ${(t.native.ratio * 100).toFixed(4)}%）；reserveTokens=${n(t.reserveTokens)}；压缩准备时 ${n(t.tokensBefore)} tokens`);
    const sizes = run.contextSizes ?? {};
    const material = (sizes.requests ?? []).filter((r) => r.slot === slot);
    const after = sizes.after?.estimated ?? undefined;
    lines.push(`大小（估算 tokens）：压缩前 ${n(sizes.before?.estimated?.total)}；材料 ${n(material.reduce((sum, r) => sum + (r.estimated?.total ?? 0), 0))}（${material.length} 个请求）；压缩后 ${n(after?.total)}（正文 ${n(after?.handoff)}，原话 ${n(after?.quotations)}，文件 ${n(after?.inventory)}，尾部 ${n(after?.retainedRecent)}，恢复包 ${n(after?.recoveryPackage)}）`);
    const usage = sizes.after?.providerReported?.rawUsage;
    if (usage) lines.push(`压缩后首个业务请求 provider 实报：${n(calculateContextTokens(usage))} tokens`);
    lines.push(`保留尾部：${n(after?.retainedRecent)} tokens，从 entry ${entry.firstKeptEntryId} 开始`);
  } else {
    const projection = buildSessionProjection(branch, branch.at(-1)?.id ?? null);
    const tail = projection.entries.filter(e => e.sourceEntry.type !== "compaction" && e.sourceEntry.type !== "custom_message").flatMap(e => e.messages);
    const recovery = projection.entries.filter(e => e.sourceEntry.type === "custom_message").flatMap(e => e.messages);
    lines.push(`大小（估算 tokens）：正文 ${n(textTokens(details.handoff ?? entry.summary))}，原话 ${details.userQuotations?.version === 1 ? n(textTokens(renderUserQuotations(details.userQuotations))) : "旧格式未分列"}，尾部 ${n(contextTokens(convertToLlm(tail).filter(m => m.role !== "system")))}，恢复包/通知 ${n(contextTokens(convertToLlm(recovery)))}`);
    lines.push(`保留尾部：从 entry ${entry.firstKeptEntryId} 开始`);
  }
  const skills = details.restoreSkills ?? [];
  lines.push(`恢复的 skill：${skills.length ? `${skills.map((s) => `${s.name}（${s.path}）`).join("、")}；公开材料引用；恢复状态见附录` : "无"}`);
  if (run?.shadow?.enabled) {
    const adopt = run.shadow.adopt === "small" ? "small" : "main", other = adopt === "main" ? "small" : "main";
    const describe = (name: string) => { const o = run.outputs?.[name]; return `${name} ${SHADOW[o?.status ?? ""] ?? o?.status ?? "无记录"}，摘要约 ${o?.validated?.summary ? n(textTokens(o.validated.summary)) : "无"} tokens，耗时 ${seconds(o)}`; };
    lines.push(`影子：${other} 为影子；${describe(adopt)}；${describe(other)}`);
  } else if (run) lines.push("影子：未开启");
  return `${lines.join("\n")}\n\n──── 模型看到的摘要 ────\n${projectedSummary(entry)}`;
}
