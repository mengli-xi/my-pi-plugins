import { TOPIC_MAX_BYTES, type TopicFile } from "./files.ts";

export interface MemoryView {
  /** Present when this session injects memory: identity, directory and the frozen section. */
  snapshot?: { identity: string; memoryDir: string; index: string; indexNote: string };
  /** Why nothing is injected (identity or directory failure). */
  unavailable?: string;
  /** The branch compacted after the snapshot; the next turn rereads the disk. */
  stale?: boolean;
  topics?: TopicFile[];
  topicError?: string;
}

const bytes = (size: number) => `${size.toLocaleString("en-US")} 字节`;
const oversized = (size: number) => size > TOPIC_MAX_BYTES ? "，超过 12 KiB，请精简过程或拆分独立决定" : "";

/** Read-only `/memory` text; nothing here enters model context. */
export function describeMemory(view: MemoryView): string {
  if (!view.snapshot) return view.unavailable ? `没有注入项目记忆。${view.unavailable}` : "还没有记忆快照：会话尚未开始，暂不注入。";
  const { snapshot } = view;
  const lines = [
    `项目身份：${snapshot.identity}`,
    `记忆目录：${snapshot.memoryDir}`,
    "注入：本会话快照（会话开始、换分支或压缩后的下一轮读取；会话中途改磁盘不刷新）",
    `MEMORY.md：${snapshot.indexNote}`,
  ];
  if (view.stale) lines.push("当前分支在快照之后压缩过，下一轮会重新读取磁盘。");
  if (view.topicError) lines.push("", `主题文件读取失败：${view.topicError}`);
  else {
    const topics = view.topics ?? [];
    lines.push("", `主题文件（当前磁盘 ${topics.length} 个）：`);
    lines.push(...(topics.length ? topics.map((t) => `- ${t.name}  ${bytes(t.size)}  ${t.indexed ? "已索引" : "未被 MEMORY.md 引用"}${oversized(t.size)}`) : ["（无）"]));
    if (topics.length) lines.push("用 /memory <主题> 查看全文。");
  }
  return `${lines.join("\n")}\n\n──── 注入给模型的索引段（cc_memory_index）────\n${snapshot.index}`;
}

export function describeTopic(topic: TopicFile, contents: string): string {
  return `路径：${topic.path}\n大小：${bytes(topic.size)}${oversized(topic.size)}；${topic.indexed ? "已索引" : "未被 MEMORY.md 引用"}\n\n${contents}`;
}
