import { createInterface } from "node:readline";

interface MatchTask {
  taskId: string;
  mode: "literal" | "regex";
  pattern: string;
  records: Array<{ sequence: number; text: string }>;
}

function isTask(value: unknown): value is MatchTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<MatchTask>;
  return typeof task.taskId === "string"
    && (task.mode === "literal" || task.mode === "regex")
    && typeof task.pattern === "string"
    && task.pattern.length > 0
    && [...task.pattern].length <= 500
    && Array.isArray(task.records)
    && task.records.length <= 2_000
    && task.records.every((record) => Number.isSafeInteger(record.sequence) && record.sequence > 0 && typeof record.text === "string" && Buffer.byteLength(record.text) <= 65_536);
}

function runTask(task: MatchTask): { taskId: string; matches: number[]; lastSequence: number } {
  const matcher = task.mode === "regex" ? new RegExp(task.pattern, "u") : undefined;
  const matches: number[] = [];
  for (const record of task.records) {
    if (matcher ? matcher.test(record.text) : record.text.includes(task.pattern)) matches.push(record.sequence);
    matcher?.lastIndex && (matcher.lastIndex = 0);
  }
  return { taskId: task.taskId, matches, lastSequence: task.records.at(-1)?.sequence ?? 0 };
}

process.stdout.write(`${JSON.stringify({ type: "matcher-ready", version: 1 })}\n`);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let taskId: string | undefined;
  try {
    if (Buffer.byteLength(line) > 1_048_576) throw new Error("task-too-large");
    const value = JSON.parse(line) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const candidate = (value as { taskId?: unknown }).taskId;
      if (typeof candidate === "string") taskId = candidate;
    }
    if (!isTask(value)) throw new Error("invalid-task");
    process.stdout.write(`${JSON.stringify({ ok: true, result: runTask(value) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, taskId, error: error instanceof Error ? error.message : "worker-error" })}\n`);
  }
});
