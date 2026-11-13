// Controlled benchmark fixture only; preserves the original session graph and tool trajectory.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const thinkingBody = "Inspect the available evidence, compare the possible explanations, and verify the next step before answering.\n\n".repeat(10);
export function withThinking(source, standalone = false) {
  const entries = source.trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(entries[0]?.type, "session", "需要 Pi session JSONL");
  let users = 0, thinkingMessages = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") users++;
    if (entry.message.role !== "assistant" || !entry.message.content.some(part => part.type === "text")) continue;
    assert.ok(!entry.message.content.some(part => part.type === "thinking"), "输入已经有 Thinking，拒绝重复注入");
    const thinking = { type: "thinking", thinking: thinkingBody };
    if (standalone) {
      const index = entry.message.content.findIndex(part => part.type === "text");
      const part = entry.message.content[index], cut = part.text.indexOf("\n\n") + 2;
      assert.ok(cut > 1 && cut < part.text.length, "standalone 需要含两段正文的 fixture");
      // Keep every original text byte and tool event. The first prose paragraph
      // closes the tool phase, so Thinking is actually visible in CC, not archived.
      entry.message.content.splice(index, 1, { ...part, text: part.text.slice(0, cut) }, thinking,
        { ...part, text: part.text.slice(cut) });
    } else entry.message.content.unshift(thinking);
    thinkingMessages++;
  }
  assert.equal(thinkingMessages, users, "每轮最终 assistant 必须恰有一段 Thinking");
  return { jsonl: entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", users, thinkingMessages,
    thinkingBytes: Buffer.byteLength(thinkingBody), standalone };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === "--standalone"),
    "用法：node scripts/bench/with-thinking.mjs input.jsonl output.jsonl [--standalone]");
  const { jsonl, ...summary } = withThinking(readFileSync(process.argv[2], "utf8"), process.argv[4] === "--standalone");
  writeFileSync(process.argv[3], jsonl, { flag: "wx" });
  console.log(JSON.stringify(summary));
}
