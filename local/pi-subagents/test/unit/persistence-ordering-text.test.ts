import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { boundedModelTextV1, canonicalJsonV1, compareCanonicalV1, trimToByteBudgetV1, utf8PrefixLengthV1 } from "../../src/persistence/canonical.ts";
import { buildCheckpointManifestV1, encodeCheckpointManifestV1, parseCheckpointManifestV1 } from "../../src/persistence/checkpoint.ts";
import { freezeCompletionProjectionV1 } from "../../src/persistence/settlement.ts";
import type { CompletionRecordV1 } from "../../src/persistence/types.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const MAIN_KEY = `main_${"A".repeat(32)}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
// 这五个 ID 的 locale 顺序与码元顺序不同：en 排序把 a_ / a- / aa 排在 B0 / Zb 之前。
const AGENT_IDS = ["agt_aaAAAAAAAAAAAAAAAAAAAA", "agt_ZbAAAAAAAAAAAAAAAAAAAA", "agt_a-AAAAAAAAAAAAAAAAAAAA", "agt_a_AAAAAAAAAAAAAAAAAAAA", "agt_B0AAAAAAAAAAAAAAAAAAAA"];

test("checkpoint manifests order Agent descriptors by code unit, the same order invariants enforce", () => {
  const agents = new Map(AGENT_IDS.map((agentId) => [agentId, Buffer.from(`${canonicalJsonV1({ version: 1, agent: agentId })}\n`, "utf8")]));
  const manifest = buildCheckpointManifestV1({ mainKey: MAIN_KEY, generation: 2, hostRevision: 5, lastJournalSequence: 42, createdAt: NOW, rootBytes: Buffer.from(`${canonicalJsonV1({ version: 1, host_revision: 5 })}\n`, "utf8"), agents });
  const codeUnitOrder = [...AGENT_IDS].sort();
  assert.deepEqual(manifest.agents.map((entry) => entry.agent_id), codeUnitOrder);
  // invariants.ts 用 `>` 比较码元；manifest 必须能通过同一个谓词，否则换个 locale 重开就报未排序。
  for (let index = 1; index < codeUnitOrder.length; index++) assert.ok(codeUnitOrder[index - 1]! < codeUnitOrder[index]!);
  assert.deepEqual(parseCheckpointManifestV1(JSON.parse(Buffer.from(encodeCheckpointManifestV1(manifest)).toString("utf8"))), manifest);
  const localeOrdered = { ...manifest, agents: [...manifest.agents].sort((left, right) => left.agent_id.localeCompare(right.agent_id)) };
  if (canonicalJsonV1(localeOrdered.agents) !== canonicalJsonV1([...manifest.agents])) {
    assert.throws(() => parseCheckpointManifestV1(localeOrdered), /not sorted by agent_id/u);
  }
});

test("canonical comparison is byte order and never follows the runtime locale", () => {
  assert.ok(compareCanonicalV1("agt_ZbA", "agt_aaA") < 0);
  assert.ok(compareCanonicalV1("agt_aaA", "agt_ZbA") > 0);
  assert.equal(compareCanonicalV1("same", "same"), 0);
});

test("frozen completion cards truncate on UTF-8 boundaries and never leave a dangling lead byte", () => {
  const original = "结".repeat(40_000);
  const completion: CompletionRecordV1 = { version: 1, record_revision: 1, completion_id: "cmp_AAAAAAAAAAAAAAAAAAAAAA", task_id: "tsk_AAAAAAAAAAAAAAAAAAAAAA", agent_id: "agt_AAAAAAAAAAAAAAAAAAAAAA", recipient: { kind: "main", session_id: "main" }, outcome: "completed", reason: "normal-final", final_text: original, summary: "s", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 }, task_admitted_at: NOW, completed_at: NOW };
  const projection = freezeCompletionProjectionV1({ completion, taskPath: "/root/a" });
  assert.equal(projection.result_truncated, true);
  const rendered = projection.content.slice(projection.content.indexOf("<result>") + "<result>".length, projection.content.lastIndexOf("</result>"));
  assert.equal(rendered.includes("�"), false);
  assert.ok(original.startsWith(rendered));
  assert.equal(Buffer.byteLength(rendered, "utf8"), projection.rendered_result_bytes);
  assert.ok(Buffer.byteLength(projection.content, "utf8") <= 71_680);
  // 冻结的卡片必须能进规范 JSON，非法 UTF-8 或游离代理对会在这里炸掉。
  assert.ok(canonicalJsonV1({ content: projection.content }).length > 0);
});

test("model text bounds cut on code points, repair lone surrogates and keep the byte budget", () => {
  assert.equal(utf8PrefixLengthV1(Buffer.from("结结", "utf8"), 4), 3);
  assert.equal(utf8PrefixLengthV1(Buffer.from("结结", "utf8"), 6), 6);
  assert.equal(utf8PrefixLengthV1(Buffer.from("ab", "utf8"), 9), 2);
  const long = boundedModelTextV1("结".repeat(30_000), 65_536);
  assert.ok(Buffer.byteLength(long, "utf8") <= 65_536);
  assert.equal(long.includes("�"), false);
  assert.ok("结".repeat(30_000).startsWith(long));
  assert.equal(boundedModelTextV1("ab\ud83d", 65_536), "ab�");
  assert.equal(boundedModelTextV1("\udc00tail", 65_536), "�tail");
  const emoji = trimToByteBudgetV1(`${"a".repeat(509)}😀`, 512);
  assert.equal(emoji, "a".repeat(509));
  assert.equal(canonicalJsonV1({ text: emoji }), `{"text":"${"a".repeat(509)}"}`);
  assert.equal(trimToByteBudgetV1("结果", 512), "结果");
});

test("the same summary rule survives an emoji sitting exactly on the 512 byte boundary", () => {
  const summary = trimToByteBudgetV1(`${"结".repeat(170)}😀`, 512);
  assert.ok(Buffer.byteLength(summary, "utf8") <= 512);
  assert.equal(summary.includes("�"), false);
  assert.ok(canonicalJsonV1({ summary }).length > 0);
});

test("checkpoint state digests stay stable across the ordering fix", () => {
  const agents = new Map(AGENT_IDS.map((agentId) => [agentId, Buffer.from(`${canonicalJsonV1({ version: 1, agent: agentId })}\n`, "utf8")]));
  const rootBytes = Buffer.from(`${canonicalJsonV1({ version: 1, host_revision: 5 })}\n`, "utf8");
  const first = buildCheckpointManifestV1({ mainKey: MAIN_KEY, generation: 2, hostRevision: 5, lastJournalSequence: 42, createdAt: NOW, rootBytes, agents });
  const shuffled = new Map([...agents].reverse());
  const second = buildCheckpointManifestV1({ mainKey: MAIN_KEY, generation: 2, hostRevision: 5, lastJournalSequence: 42, createdAt: NOW, rootBytes, agents: shuffled });
  assert.equal(first.state_sha256, second.state_sha256);
  assert.equal(sha(canonicalJsonV1(first)), sha(canonicalJsonV1(second)));
});
