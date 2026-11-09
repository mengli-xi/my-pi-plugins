import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { mainRequest } from "../src/main.ts";
import { describeCompaction } from "../src/show.ts";

const input = {
  instruction: "Summarize", focus: "FOCUS",
  materials: { goal: null, skills: [], known: [], memory: [{ path: "/memory/topic.md", hash: "HASH", contents: "TOPIC_ONLY_FACT ".repeat(1000) }] },
};
const prepare = (mainMemory: "digest" | "full", window = 100000) => mainRequest([], [], { ...DEFAULT_CONFIG, mainMemory }, window, input);

test("main supplemental defaults to digest references; full includes the collected contents", () => {
  assert.equal(DEFAULT_CONFIG.mainMemory, "digest");
  const digest = prepare("digest"), full = prepare("full");
  for (const result of [digest, full]) {
    assert.match(result.append, /\/memory\/topic.md/);
    assert.match(result.append, /HASH/);
    assert.equal(result.memory.fellBack, false);
    assert.equal(result.admission.passed, true);
  }
  assert.doesNotMatch(digest.append, /TOPIC_ONLY_FACT|"contents"/);
  assert.match(full.append, /TOPIC_ONLY_FACT/);
  assert.equal(full.memory.effectiveMode, "full");
});

test("full overflow rechecks digest admission before main can route to small", () => {
  const digest = prepare("digest");
  const fallback = prepare("full", digest.admission.total);
  assert.deepEqual(fallback.append, digest.append);
  assert.equal(fallback.memory.requestedMode, "full");
  assert.equal(fallback.memory.effectiveMode, "digest");
  assert.equal(fallback.memory.fellBack, true);
  assert.equal(fallback.memory.fullAdmission?.passed, false);
  assert.equal(fallback.admission.passed, true);
  const overflow = prepare("full", digest.admission.total - 1);
  assert.equal(overflow.memory.fellBack, true);
  assert.equal(overflow.admission.passed, false, "the caller retains its main-to-small overflow route");
});

test("show reports the effective main memory mode and any full-to-digest fallback", () => {
  const entry = { type: "compaction", id: "c", timestamp: "2026-10-18T00:00:00Z", summary: "summary", firstKeptEntryId: "u", tokensBefore: 100 } as CompactionEntry;
  for (const result of [prepare("digest"), prepare("full"), prepare("full", prepare("digest").admission.total)]) {
    const text = describeCompaction(entry, [entry], { adopted: { slot: "main" }, outputs: { main: { mainMemory: result.memory } } });
    assert.ok(text.includes(`Main 记忆：${result.memory.effectiveMode}`));
    assert.equal(text.includes("full 超预算，已退回 digest"), result.memory.fellBack);
  }
});
