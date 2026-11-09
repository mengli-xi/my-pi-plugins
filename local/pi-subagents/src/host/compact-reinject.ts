import type { ExtensionAPI, ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ProcessMainBindingV1 } from "./process-service.js";

/** Only finalized, public SDK messages from the current Task; never expose thinking. */
export function latestTaskProgress(messages: readonly { role: string; timestamp?: number; content?: unknown; toolName?: string }[], startedAt?: string): string | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.timestamp === undefined || message.timestamp < start) continue;
    if (message.role === "toolResult") return `最近完成工具：${message.toolName}`;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join(" ").replace(/\s+/g, " ").trim();
    if (text) return Array.from(text).slice(0, 400).join("");
    const tools = message.content.filter(block => block.type === "toolCall").map(block => block.name);
    if (tools.length) return `正在调用工具：${tools.join(", ")}`;
  }
  return undefined;
}

export function createCompactReinjection(pi: Pick<ExtensionAPI, "sendMessage"> & Partial<Pick<ExtensionAPI, "events" | "on">>, getBinding: (ctx: ExtensionContext) => ProcessMainBindingV1 | undefined) {
  const snapshot = (ctx: ExtensionContext) => {
    const binding = getBinding(ctx);
    if (!binding) return; // Empty sessions must retain the lazy service/store boundary.
    const lines = binding.host.snapshot().agents.flatMap(({ agent, tasks }) => tasks.filter(task => task.phase !== "settled").map(task => {
      const progress = binding.runtime.taskProgress(agent.agent_id, task.task_id) ?? (task.waiting_on ? `等待 ${task.waiting_on.kind}：${task.waiting_on.key}` : "尚无当前任务的模型输出");
      return `- Agent ${agent.agent_id} · ${agent.task_name} (${agent.task_path}); Task ${task.task_id}; 状态：${task.phase}${agent.lifecycle === "closing" ? " / closing" : ""}; 最近进度：${progress}`;
    }));
    if (!lines.length) return;
    return { content: ["这是压缩完成时的实时状态，与摘要冲突时以此为准。", "仍未完成的子任务：", ...lines,
        "结果通过原有 subagent-completion-v1 完成通知自动送达其 owner conversation；list_agents 可核对当前状态，wait_agents({targets:[Agent ID 或 task path]}) 可等待自己拥有的任务。不要重复启动这些任务。"].join("\n"), identity: { tasks: binding.host.snapshot().agents.flatMap(({ agent, tasks }) => tasks.filter(task => task.phase !== "settled").map(task => ({ agentId: agent.agent_id, taskId: task.task_id }))) } };
  };
  let current: ExtensionContext | undefined;
  const release = pi.events?.on?.("pi-session-compact:collect-recovery-v1", (raw: unknown) => {
      const request = raw as { version?: number; sessionId?: string; operationId?: string; reply?: (item: unknown) => void };
      if (request?.version !== 1 || typeof request.operationId !== "string" || typeof request.reply !== "function" || !current || request.sessionId !== current.sessionManager.getSessionId()) return;
      const state = snapshot(current);
      if (state) request.reply({ owner: "pi-subagents", order: 40, customType: "subagent-compact-state-v1", ...state });
    });
  pi.on?.("session_start", (_event, ctx) => { current = ctx; });
  pi.on?.("session_tree", (_event, ctx) => { current = ctx; });
  pi.on?.("session_shutdown", event => { current = undefined; if (event.reason === "quit" || event.reason === "reload") release?.(); });
  const seen = new Set<string>();
  return (event: SessionCompactEvent, ctx: ExtensionContext): void => {
    const key = `${ctx.sessionManager.getSessionId()}:${event.compactionEntry.id}`;
    if (seen.has(key)) return;
    seen.add(key); // Also remember an empty snapshot if this event is replayed later.
    const recovery = (event.compactionEntry.details as { recovery?: { version?: number; items?: Array<{ owner: string; customType: string }> } } | undefined)?.recovery;
    if (recovery?.version === 1 && Array.isArray(recovery.items) && recovery.items.some(item => item.owner === "pi-subagents" && item.customType === "subagent-compact-state-v1")) return;
    if (ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "subagent-compact-state-v1" && (entry.details as { compactionId?: string } | undefined)?.compactionId === event.compactionEntry.id)) return;
    const state = snapshot(ctx);
    if (!state) return;
    pi.sendMessage({ customType: "subagent-compact-state-v1", display: false,
      content: state.content,
      details: { compactionId: event.compactionEntry.id } }, { triggerTurn: false, deliverAs: "steer" });
  };
}
