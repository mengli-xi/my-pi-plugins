import { mkdir, readFile } from "node:fs/promises";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProjectResolver } from "./src/identity.ts";
import { createTopicLister, readIndex, scanTopics, topicCompletions, TopicWarnings } from "./src/files.ts";
import { describeMemory, describeTopic } from "./src/view.ts";
import { memoryPolicy, type MemoryRole } from "./src/prompt.ts";
import { STATUS_LINE_ROW_CHANNEL, memoryStatusLine, memoryStatusPayload, type MemoryStatus } from "./src/status.ts";

export interface MemoryOptions { role?: MemoryRole }

/** Explicit per-session role; never infer child identity from process-global environment. */
export function createMemoryExtension({ role = "main" }: MemoryOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const topicWarnings = new TopicWarnings();
    const listTopics = createTopicLister();
    let resolveProject = createProjectResolver();
    const notices = new Map<string, string>();
    let snapshot: { sessionId: string; identity: string; memoryDir: string; compactionId?: string; policy: string; index: string; indexNote: string; indexWarning: boolean } | undefined;
    // Why this session currently has no project memory; answered on the request channel below.
    let unavailable: { sessionId: string; reason: string } | undefined;
    // CC Style statusline segment (MEM), user-only. Set by capture(): the frozen snapshot plus the
    // per-turn directory scan, so a render never touches the disk.
    let status: MemoryStatus = { warn: true };
    let statusCtx: ExtensionContext | undefined;
    const notify = (ctx: ExtensionContext, key: string, message?: string) => {
      if (message && notices.get(key) !== message) ctx.ui.notify(message, "warning");
      if (message) notices.set(key, message);
      else notices.delete(key);
    };
    const prepare = async (ctx: ExtensionContext) => {
      const project = await resolveProject(ctx.cwd, getAgentDir());
      notify(ctx, "identity", project.warning);
      if (!project.available) return project.warning;
      try {
        await mkdir(project.memoryDir, { recursive: true });
        notify(ctx, "directory");
        return project;
      } catch (error) {
        const reason = `pi-cc-memory：记忆目录不可用，暂不注入。${String(error)}`;
        notify(ctx, "directory", reason);
        return reason;
      }
    };

    const capture = async (ctx: ExtensionContext, force = false) => {
      const project = await prepare(ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      if (typeof project === "string") {
        snapshot = undefined;
        unavailable = { sessionId, reason: project };
        status = { warn: true };
        return;
      }
      unavailable = undefined;
      // Public branch projection also sees appendCompaction() calls without session_compact events.
      const compactionId = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id;
      let topicNote = "";
      let topicCount: number | undefined, oversized = false;
      try {
        const { count, oversized: topics } = await scanTopics(project.memoryDir);
        topicCount = count;
        oversized = topics.length > 0;
        for (const topic of topicWarnings.fresh(topics)) {
          ctx.ui.notify(`pi-cc-memory：${topic.path} 为 ${topic.size} 字节，超过 12 KiB；请精简过程噪音或拆分独立决定，保留必要结论。`, "warning");
        }
        if (topics.length) topicNote = `\n\nOversized topics (full bodies remain readable):\n${topics.map((topic) => `- ${topic.name}: ${topic.size} UTF-8 bytes, over 12 KiB. Trim noise or split independent decisions; retain necessary conclusions and conditions.`).join("\n")}`;
        notify(ctx, "scan");
      } catch (error) {
        topicNote = `\n\nTopic size check unavailable: ${String(error)}`;
        notify(ctx, "scan", `pi-cc-memory：主题大小检查 unavailable：${String(error)}`);
      }
      if (force || !snapshot || snapshot.sessionId !== sessionId || snapshot.identity !== project.identity || snapshot.compactionId !== compactionId) {
        const index = await readIndex(project.memoryDir);
        notify(ctx, "index", index.warning);
        snapshot = {
          sessionId, identity: project.identity, memoryDir: project.memoryDir, compactionId,
          policy: memoryPolicy(project.memoryDir, sessionId, role),
          // readIndex warns exactly when the index was truncated or could not be read.
          index: index.section + topicNote, indexNote: index.note, indexWarning: index.warning !== undefined,
        };
      }
      status = { topics: topicCount, warn: topicCount === undefined || oversized || snapshot.indexWarning };
      return snapshot;
    };

    // Versioned synchronous contract for read-only consumers (pi-session-compact). Answers from the
    // frozen snapshot, so the directory matches what was injected; other sessions get no reply.
    pi.events.on("cc-memory:request:project-v1", (raw) => {
      const request = raw as { version?: unknown; sessionId?: unknown; reply?: unknown } | undefined;
      if (request?.version !== 1 || typeof request.sessionId !== "string" || typeof request.reply !== "function") return;
      if (snapshot && snapshot.sessionId === request.sessionId) {
        request.reply({ version: 1, sessionId: snapshot.sessionId, memoryDir: snapshot.memoryDir, identity: snapshot.identity });
      } else if (unavailable && unavailable.sessionId === request.sessionId) {
        request.reply({ version: 1, sessionId: unavailable.sessionId, memoryDir: null, reason: unavailable.reason });
      }
    });
    const publish = (ctx: ExtensionContext) => {
      statusCtx = ctx;
      // Display only: a failure here must not skip the injection in the same handler.
      try {
        pi.events.emit(STATUS_LINE_ROW_CHANNEL, memoryStatusPayload(memoryStatusLine(status, (tone, text) => ctx.ui.theme.fg(tone, text)), () => {
          if (statusCtx !== ctx) return false;
          void overview(ctx).catch((error) => ctx.ui.notify(`pi-cc-memory：无法打开记忆视图：${String(error)}`, "warning"));
          return true;
        }));
      } catch {}
    };
    pi.on("session_start", async (_event, ctx) => { resolveProject = createProjectResolver(); await capture(ctx, true); publish(ctx); });
    pi.on("session_tree", async (_event, ctx) => { await capture(ctx, true); publish(ctx); });
    pi.on("session_shutdown", () => { resolveProject = createProjectResolver(); statusCtx = undefined; try { pi.events.emit(STATUS_LINE_ROW_CHANNEL, memoryStatusPayload(undefined)); } catch {} });
    pi.on("before_agent_start", async (event, ctx) => {
      // These two keys are exclusively owned here. Remove historical values on an identity failure.
      const sections = event.systemPromptOptions.sections;
      delete sections.cc_memory_policy;
      delete sections.cc_memory_index;
      const current = await capture(ctx);
      publish(ctx);
      if (!current) return;
      sections.cc_memory_policy = current.policy;
      sections.cc_memory_index = current.index;
    });
    /** `/memory` without a topic, also opened by a statusline click. */
    const overview = async (ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const current = snapshot?.sessionId === sessionId ? snapshot : undefined;
      const reason = unavailable?.sessionId === sessionId ? unavailable.reason : undefined;
      let topics, topicError;
      if (current) try { topics = await listTopics(current.memoryDir); } catch (error) { topicError = String(error); }
      const stale = !!current && ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id !== current.compactionId;
      await present(ctx, "项目记忆", describeMemory({ snapshot: current, unavailable: reason, stale, topics, topicError }));
    };
    pi.registerCommand("memory", {
      description: "查看项目记忆：身份、目录、本会话注入的索引和主题列表；/memory <主题> 查看该主题全文",
      getArgumentCompletions: (prefix) => topicCompletions(snapshot?.memoryDir, prefix, listTopics),
      handler: async (args, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const current = snapshot?.sessionId === sessionId ? snapshot : undefined;
        const reason = unavailable?.sessionId === sessionId ? unavailable.reason : undefined;
        const name = args.trim().replace(/\.md$/, "");
        if (!name) { await overview(ctx); return; }
        if (!current) { ctx.ui.notify(reason ?? "还没有记忆快照，无法定位记忆目录。", "warning"); return; }
        try {
          const topics = await listTopics(current.memoryDir), topic = topics.find((t) => t.name === name);
          if (!topic) { ctx.ui.notify(`没有主题「${name}」。现有主题：${topics.map((t) => t.name).join("、") || "无"}`, "warning"); return; }
          await present(ctx, `记忆主题 · ${topic.name}`, describeTopic(topic, await readFile(topic.path, "utf8")));
        } catch (error) { ctx.ui.notify(`pi-cc-memory：读取主题失败：${String(error)}`, "warning"); }
      },
    });
  };
}

/** The repo's read-only long-text view (as in pi-model-prompts); other modes get the same text as a notice. */
async function present(ctx: ExtensionContext, title: string, body: string): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI) { const { showTextPanel } = await import("pi-li-uikit/text-panel"); await showTextPanel(ctx, { title, body, format: "plain" }); }
  else ctx.ui.notify(body, "info");
}

export default createMemoryExtension();
