import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type CompactionEntry } from "@earendil-works/pi-coding-agent";
import { COMPACTION_MODES, DEFAULT_CONFIG, readConfig } from "../src/config.ts";
import { FOCUS_SCAFFOLD, parseNow, selectMode } from "../src/mode.ts";
import { compactionCompletions } from "../src/window.ts";
import { describeCompaction } from "../src/show.ts";

const now = 1800000000000;
function branch(age: number) {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "assistant", timestamp: now - age } as never);
  sm.appendMessage({ role: "user", content: "latest user is recent", timestamp: now });
  return sm.getBranch();
}
const config = { ...DEFAULT_CONFIG, mode: "auto" as const };
test("auto uses the last assistant message time on the branch at the strict boundary", () => {
  assert.equal(selectMode(config, branch(19 * 60000 + 59000), undefined, now).selectedMode, "main");
  const boundary = selectMode(config, branch(20 * 60000), undefined, now);
  assert.equal(boundary.selectedMode, "small");
  assert.match(boundary.reason, /20 分钟 ≥ 20 分钟 → 小模型/);
  assert.equal(selectMode(config, [], undefined, now).selectedMode, "main");
  assert.equal(selectMode({ ...config, autoIdleMinutes: 0.5 }, branch(30000), undefined, now).selectedMode, "small");
  const sm = SessionManager.inMemory();
  const old = sm.appendMessage({ role: "assistant", timestamp: now - 21 * 60000 } as never);
  sm.appendMessage({ role: "assistant", timestamp: now } as never);
  sm.branch(old);
  assert.equal(selectMode(config, sm.getBranch(), undefined, now).selectedMode, "small", "other branches are excluded");
});
test("manual overrides and auto selection choose the adopted slot even with shadows enabled", () => {
  const c = { ...config, shadow: { enabled: true, adopt: "main" as const } };
  assert.equal(selectMode(c, branch(21 * 60000), undefined, now).selectedMode, "small");
  for (const mode of COMPACTION_MODES) {
    const selected = selectMode({ ...c, mode: "small" }, branch(0), mode, now);
    assert.equal(selected.selectedMode, mode === "auto" ? "main" : mode);
    assert.match(selected.reason, new RegExp(`手动指定 ${mode}`));
  }
  assert.equal(config.mode, "auto");
});
test("autoIdleMinutes defaults to 20 and rejects non-positive, non-finite or non-numeric values explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-mode-config-"));
  try {
    mkdirSync(join(root, "pi-session-compact"));
    assert.equal((await readConfig(root)).mode, "main");
    assert.equal((await readConfig(root)).autoIdleMinutes, 20);
    for (const value of [0, -1, "20", null, "Infinity"]) {
      writeFileSync(join(root, "pi-session-compact/config.json"), JSON.stringify({ autoIdleMinutes: value }));
      await assert.rejects(readConfig(root), /autoIdleMinutes.*positive number/);
    }
    writeFileSync(join(root, "pi-session-compact/config.json"), '{"mode":"auto","autoIdleMinutes":1e999}');
    await assert.rejects(readConfig(root), /autoIdleMinutes/);
    writeFileSync(join(root, "pi-session-compact/config.json"), JSON.stringify({ mode: "auto", autoIdleMinutes: 0.5 }));
    assert.equal((await readConfig(root)).autoIdleMinutes, 0.5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("now parser and completions share canonical mode values and offer real free-text scaffolds", () => {
  assert.deepEqual(parseNow(""), { mode: undefined, customInstructions: undefined });
  for (const mode of COMPACTION_MODES) {
    assert.deepEqual(parseNow(`${mode} 保留约束\n和待办`), { mode, customInstructions: "保留约束\n和待办" });
    assert.deepEqual(parseNow(mode), { mode, customInstructions: undefined });
  }
  assert.deepEqual(parseNow("unknown focus"), { mode: undefined, customInstructions: "unknown focus" });
  assert.ok(compactionCompletions("")!.some(i => i.value === "now "));
  assert.deepEqual(compactionCompletions("n")?.map(i => i.value), ["now "]);
  assert.deepEqual(compactionCompletions("now ")?.map(i => i.value), [...COMPACTION_MODES.map(m => `now ${m} `), `now ${FOCUS_SCAFFOLD}`]);
  assert.deepEqual(compactionCompletions("now sm")?.map(i => i.value), ["now small "]);
  assert.equal(compactionCompletions("now nonsense"), null);
  assert.equal(compactionCompletions("nope "), null);
  assert.deepEqual(compactionCompletions("now main ")?.map(i => i.value), [`now main ${FOCUS_SCAFFOLD}`]);
  assert.equal(compactionCompletions("now main custom focus"), null);
});
test("show exposes auto/manual mode reasons and effective main-to-small fallback", () => {
  const entry = { type: "compaction", id: "c", timestamp: new Date(now).toISOString(), summary: "summary", firstKeptEntryId: "u", tokensBefore: 1 } as CompactionEntry;
  for (const manual of [undefined, "small"] as const) {
    const modeSelection = selectMode(config, branch(34 * 60000), manual, now);
    const text = describeCompaction(entry, [entry], { modeSelection, adopted: { slot: "small" }, outputs: { small: { effectiveMode: "small" } } });
    assert.match(text, /模式：small/);
    assert.ok(text.includes(modeSelection.reason));
  }
  assert.match(describeCompaction(entry, [entry], { modeSelection: selectMode(config, []), adopted: { slot: "main" }, outputs: { main: { effectiveMode: "small", fallbackReason: "main-budget-overflow" } } }), /主模型准入超预算 → 小模型/);
  for (const fallbackReason of ["Error: effective-prefix-unavailable", "Error: effective-prefix-unavailable: no-capture; generation=1"]) {
    assert.match(describeCompaction(entry, [entry], { adopted: { slot: "main" }, outputs: { main: { effectiveMode: "small", fallbackReason } } }), /当前版本会先按当前会话历史重建主模型请求/);
  }
  for (const source of ["capture", "rebuilt"] as const) {
    const text = describeCompaction(entry, [entry], { adopted: { slot: "main" }, outputs: { main: { effectiveMode: "main", prefix: { source, reason: "PREFIX_REASON" } } } });
    assert.match(text, new RegExp(`Main 前缀：${source}`));
    assert.match(text, /PREFIX_REASON/);
  }
});
