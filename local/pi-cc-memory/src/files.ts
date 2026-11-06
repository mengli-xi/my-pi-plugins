import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createVersionedReader } from "./file-cache.ts";

export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
export const TOPIC_MAX_BYTES = 12 * 1024;

function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let count = bytes[bytes.length - 1] === 10 ? 0 : 1;
  for (const byte of bytes) if (byte === 10) count++;
  return count;
}

export function truncateIndex(bytes: Buffer) {
  let end = bytes.length;
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 && ++lines === INDEX_MAX_LINES) {
      end = i + 1;
      break;
    }
  }
  let partialLine = false;
  if (end > INDEX_MAX_BYTES) {
    const newline = bytes.lastIndexOf(10, INDEX_MAX_BYTES - 1);
    if (newline >= 0) end = newline + 1;
    else {
      end = INDEX_MAX_BYTES;
      // A byte at end belongs to the first omitted codepoint. Never split its continuation bytes.
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      partialLine = true;
    }
  }
  const view = bytes.subarray(0, end);
  return {
    content: view.toString("utf8"),
    totalLines: lineCount(bytes), totalBytes: bytes.length,
    shownLines: lineCount(view), shownBytes: end,
    truncated: end < bytes.length, partialLine,
  };
}

/** `section` is injected for the model; `note` tells the user what was injected and where it stopped. */
export async function readIndex(memoryDir: string): Promise<{ section: string; warning?: string; note: string }> {
  const path = join(memoryDir, "MEMORY.md");
  try {
    const view = truncateIndex(await readFile(path));
    const note = view.truncated
      ? `Index truncated: ${view.totalLines} lines / ${view.totalBytes} UTF-8 bytes total; showing the first ${view.shownLines} lines / ${view.shownBytes} bytes${view.partialLine ? " (first line is partial)" : " (complete lines)"}. Remaining content is still in MEMORY.md, not injected; read as needed and shorten the index.`
      : `Complete index: ${view.totalLines} lines / ${view.totalBytes} UTF-8 bytes.`;
    const warning = view.truncated
      ? `pi-cc-memory：索引已截断：共 ${view.totalLines} 行 / ${view.totalBytes} UTF-8 字节；展示前 ${view.shownLines} 行 / ${view.shownBytes} 字节${view.partialLine ? "（首行只展示片段，该行已截断）" : "（完整行）"}。其余内容仍在 MEMORY.md，未注入；请按需 read 并精简索引。`
      : undefined;
    const shown = view.truncated
      ? `已截断：共 ${view.totalLines} 行 / ${view.totalBytes} 字节，只注入前 ${view.shownLines} 行 / ${view.shownBytes} 字节${view.partialLine ? "（首行只注入片段）" : `，从第 ${view.shownLines + 1} 行起没有注入`}。`
      : `完整注入：${view.totalLines} 行 / ${view.totalBytes} 字节。`;
    return { section: `${path}\n${note}\n\nIndex contents:\n${view.content}`, warning, note: shown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { section: `${path}\nNo index yet; create MEMORY.md when saving the first topic.`, note: "还没有 MEMORY.md，首次保存主题时创建。" };
    }
    const warning = `pi-cc-memory：MEMORY.md unavailable，读取失败：${error instanceof Error ? error.message : String(error)}`;
    return { section: `${path}\nIndex unavailable: ${error instanceof Error ? error.message : String(error)}`, warning, note: `读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface OversizedTopic { name: string; path: string; size: number; mtimeMs: number }

/** Metadata only: never open topic bodies or derive an index from this scan. `count` excludes MEMORY.md. */
export async function scanTopics(memoryDir: string): Promise<{ count: number; oversized: OversizedTopic[] }> {
  const oversized: OversizedTopic[] = [];
  let count = 0;
  for (const entry of await readdir(memoryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
    const path = join(memoryDir, entry.name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      count++;
      if (info.size > TOPIC_MAX_BYTES) oversized.push({ name: entry.name, path, size: info.size, mtimeMs: info.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { count, oversized: oversized.sort((a, b) => a.name.localeCompare(b.name, "en")) };
}

export class TopicWarnings {
  private readonly seen = new Set<string>();
  fresh(topics: OversizedTopic[]): OversizedTopic[] {
    return topics.filter((topic) => {
      const signature = `${topic.path}\0${topic.size}:${topic.mtimeMs}`;
      if (this.seen.has(signature)) return false;
      this.seen.add(signature);
      return true;
    });
  }
}

export interface TopicFile { name: string; path: string; size: number; indexed: boolean }

async function readIndexLinks(path: string): Promise<Set<string>> {
  const index = await readFile(path, "utf8");
  return new Set([...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]!.replace(/^\.\//, "")));
}

/** Parsed links belong to one extension instance, separate from its frozen model snapshot. */
export function createTopicLister() {
  const readLinks = createVersionedReader(readIndexLinks);
  return (memoryDir: string) => listTopics(memoryDir, readLinks);
}

/** Current top-level topics; `indexed` means MEMORY.md links to the file. Used only by `/memory`. */
export async function listTopics(memoryDir: string, readLinks = readIndexLinks): Promise<TopicFile[]> {
  let linked = new Set<string>();
  try { linked = await readLinks(join(memoryDir, "MEMORY.md")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const topics: TopicFile[] = [];
  for (const entry of await readdir(memoryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
    const path = join(memoryDir, entry.name);
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info) topics.push({ name: entry.name.slice(0, -3), path, size: info.size, indexed: linked.has(entry.name) });
  }
  return topics.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Topic names from the real directory; no directory or no match gives null. */
export async function topicCompletions(memoryDir: string | undefined, prefix: string, list = listTopics): Promise<Array<{ value: string; label: string; description: string }> | null> {
  if (!memoryDir) return null;
  const query = prefix.trim();
  const items = (await list(memoryDir).catch(() => [])).filter((topic) => topic.name.startsWith(query))
    .map((topic) => ({ value: topic.name, label: topic.name, description: `${topic.size} 字节${topic.indexed ? "" : "，未索引"}` }));
  return items.length ? items : null;
}
