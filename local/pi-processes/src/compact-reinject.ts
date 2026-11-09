import type { ExtensionAPI, ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ProcessHost } from "./host/process-host.js";

export function createCompactReinjection(pi: Pick<ExtensionAPI, "sendMessage"> & Partial<Pick<ExtensionAPI, "events" | "on">>, getHost: (ctx: ExtensionContext) => ProcessHost | undefined) {
  const snapshot = (ctx: ExtensionContext) => {
    const host = getHost(ctx);
    if (!host) return;
    const lines = host.records().filter(record => ["starting", "running", "stopping"].includes(record.state)).map(record =>
      `- ${record.id} · ${record.name}; 状态：${record.state}; 命令：${JSON.stringify(host.command(record.id))}; 日志：${host.logPath(record.id) ?? "路径暂不可用"}`);
    if (!lines.length) return;
    return { content: ["这是压缩完成时的实时状态，与摘要冲突时以此为准。", "仍在运行的后台进程：", ...lines,
        '日志路径为滚动 JSONL 分段；用 process({action:"logs",target:"进程 ID"}) 读取保留的输出。不要重复启动这些进程。'].join("\n"), identity: { processIds: host.records().filter(record => ["starting", "running", "stopping"].includes(record.state)).map(record => record.id) } };
  };
  let current: ExtensionContext | undefined;
  const release = pi.events?.on?.("pi-session-compact:collect-recovery-v1", (raw: unknown) => {
      const request = raw as { version?: number; sessionId?: string; operationId?: string; reply?: (item: unknown) => void };
      if (request?.version !== 1 || typeof request.operationId !== "string" || typeof request.reply !== "function" || !current || request.sessionId !== current.sessionManager.getSessionId()) return;
      const state = snapshot(current);
      if (state) request.reply({ owner: "pi-processes", customType: "process-compact-state-v1", ...state });
    });
  pi.on?.("session_start", (_event, ctx) => { current = ctx; });
  pi.on?.("session_tree", (_event, ctx) => { current = ctx; });
  pi.on?.("session_shutdown", event => { current = undefined; if (event.reason === "quit" || event.reason === "reload") release?.(); });
  const seen = new Set<string>();
  return (event: SessionCompactEvent, ctx: ExtensionContext): void => {
    const key = `${ctx.sessionManager.getSessionId()}:${event.compactionEntry.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const recovery = (event.compactionEntry.details as { recovery?: { version?: number; items?: Array<{ owner: string; customType: string }> } } | undefined)?.recovery;
    if (recovery?.version === 1 && Array.isArray(recovery.items) && recovery.items.some(item => item.owner === "pi-processes" && item.customType === "process-compact-state-v1")) return;
    if (ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "process-compact-state-v1" && (entry.details as { compactionId?: string } | undefined)?.compactionId === event.compactionEntry.id)) return;
    const state = snapshot(ctx);
    if (!state) return;
    pi.sendMessage({ customType: "process-compact-state-v1", display: false,
      content: state.content,
      details: { compactionId: event.compactionEntry.id } }, { triggerTurn: false, deliverAs: "steer" });
  };
}
