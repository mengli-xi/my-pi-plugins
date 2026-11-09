import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describeReserve, mergeReserve, parseReserve, reserveJson, reserveReport, RESERVE_ACTIONS } from "../src/reserve.ts";
import { compactionCompletions } from "../src/window.ts";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReserveSettings, writeReserveSettings } from "../src/reserve-storage.ts";

const models = ["match", "missing", "wrong"].map((id) => ({ provider: "faux", id, contextWindow: 1000000 }));
test("reserve classifies match/missing/mismatch and identifies model, global and default sources", () => {
  const global = { compaction: { reserveTokens: 123, keepRecentTokens: 456, modelOverrides: {
    "faux/match": { reserveTokens: 100000, keepRecentTokens: 789 }, "faux/wrong": { reserveTokens: 21600 },
  } } };
  const report = reserveReport(models, global, {});
  assert.deepEqual(report.rows.map((r) => [r.status, r.source, r.reserve]), [["一致", "模型覆盖", 100000], ["缺覆盖", "全局设置", 123], ["不一致", "模型覆盖", 21600]]);
  assert.deepEqual(JSON.parse(reserveJson(report)), { compaction: { modelOverrides: {
    "faux/missing": { reserveTokens: 100000, keepRecentTokens: 456 }, "faux/wrong": { reserveTokens: 100000, keepRecentTokens: 456 },
  } } });
  const defaults = SettingsManager.inMemory().getCompactionSettings();
  const builtin = reserveReport([models[0]], {}, {});
  assert.equal(builtin.rows[0].source, "内置默认");
  assert.equal(builtin.rows[0].reserve, defaults.reserveTokens);
  assert.equal(builtin.changes["faux/match"].keepRecentTokens, defaults.keepRecentTokens);
  assert.equal(reserveJson(reserveReport([models[0]], global, {})), "{}");
});

test("project overrides are reported without leaking project values into global writes", () => {
  const project = { compaction: { reserveTokens: 444, keepRecentTokens: 555, modelOverrides: { "faux/match": { reserveTokens: 66 } } } };
  const global = { compaction: { keepRecentTokens: 789 } };
  const report = reserveReport(models, global, project);
  assert.equal(report.rows[0].source, "模型覆盖（项目级）");
  assert.equal(report.rows[1].source, "项目级设置");
  assert.ok(report.rows.every((r) => r.project));
  assert.ok(Object.values(report.changes).every((p) => p.keepRecentTokens === 789));
  assert.match(describeReserve(report), /write 只写全局/);
  const untrusted = reserveReport(models, global, project, global, false);
  assert.equal(untrusted.rows[0].source, "内置默认", "actual effective settings can exclude an untrusted project");
  const equalValues = reserveReport(models, { compaction: { reserveTokens: 444 } }, project, undefined, false);
  assert.equal(equalValues.rows[1].source, "全局设置", "an untrusted project with equal values is still not the source");
});

test("changed project scalar and model reserve sources remain unknown until restart", () => {
  const global = { compaction: { reserveTokens: 111 } };
  const project = { compaction: { reserveTokens: 555, modelOverrides: { "faux/match": { reserveTokens: 777 } } } };
  const loaded = { compaction: { reserveTokens: 444, modelOverrides: { "faux/match": { reserveTokens: 666 } } } };
  const report = reserveReport(models, global, project, loaded, true);
  assert.equal(report.rows[0].reserve, 666);
  assert.equal(report.rows[1].reserve, 444);
  assert.ok(report.rows.every((row) => row.source === "无法确认（设置文件已变，重启后再看）"));
});

for (const [name, text] of [
  ["token", '{"compaction":{"modelOverrides":{"faux/match":{"reserveTokens":1,"reserveTokens":2}}}}'],
  ["model", '{"compaction":{"modelOverrides":{"faux/match":{"reserveTokens":1},"faux/match":{"reserveTokens":2}}}}'],
]) test(`duplicate ${name} keys reject the write before backup or temp creation`, async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-reserve-duplicate-"));
  const agent = join(root, "agent"), cwd = join(root, "cwd");
  try {
    await mkdir(agent); await mkdir(cwd);
    const path = join(agent, "settings.json"); await writeFile(path, text);
    const snapshot = await readReserveSettings(agent, cwd);
    const report = reserveReport([models[0]], snapshot.global, snapshot.project);
    await assert.rejects(writeReserveSettings(agent, cwd, [models[0]], report, snapshot), /settings.json 里的重复键/);
    assert.equal(await readFile(path, "utf8"), text);
    assert.deepEqual(await readdir(agent), ["settings.json"], "no backup, lock or temporary file remains");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("merge changes only specified token keys, retaining unknown fields and property order", () => {
  const text = '{\r\n\t"before": [1,2],\r\n\t"compaction": {\r\n\t\t"enabled": false,\r\n\t\t"modelOverrides": {\r\n\t\t\t"faux/wrong": { "keepRecentTokens": 9, "extra": "untouched", "reserveTokens": 1 },\r\n\t\t\t"offline/model": {"reserveTokens":42}\r\n\t\t},\r\n\t\t"reserveTokens": 999\r\n\t},\r\n\t"after": "unchanged"\r\n}\r\n';
  const merged = mergeReserve(text, { "faux/wrong": { reserveTokens: 100000, keepRecentTokens: 9 }, "faux/new": { reserveTokens: 87200, keepRecentTokens: 20000 } });
  assert.ok(merged.includes('"before": [1,2]'));
  assert.ok(merged.includes('"offline/model": {"reserveTokens":42}'));
  assert.ok(merged.includes('"faux/wrong": { "keepRecentTokens": 9, "extra": "untouched", "reserveTokens": 100000 }'));
  assert.deepEqual(Object.keys(JSON.parse(merged)), ["before", "compaction", "after"]);
  assert.deepEqual(Object.keys(JSON.parse(merged).compaction.modelOverrides), ["faux/wrong", "offline/model", "faux/new"]);
  assert.deepEqual(Object.keys(JSON.parse(merged).compaction.modelOverrides["faux/wrong"]), ["keepRecentTokens", "extra", "reserveTokens"]);
  assert.equal(mergeReserve(text, {}), text);
  assert.equal(JSON.parse(mergeReserve(undefined, { "faux/new": { reserveTokens: 100, keepRecentTokens: 20 } })).compaction.modelOverrides["faux/new"].reserveTokens, 100);
  for (const invalid of ["null", "[]", "{bad}"]) assert.throws(() => mergeReserve(invalid, {}));
});

test("reserve parsing and completions share canonical grammar", () => {
  assert.equal(parseReserve(""), "report");
  for (const action of RESERVE_ACTIONS) assert.equal(parseReserve(action), action);
  assert.equal(parseReserve("write extra"), undefined);
  assert.deepEqual(compactionCompletions("res")?.map((i) => i.value), ["reserve "]);
  for (const prefix of ["reserve ", "reserve w"]) assert.deepEqual(compactionCompletions(prefix)?.map((i) => i.value), ["reserve write"]);
  for (const prefix of ["reserve x", "reserve write extra"]) assert.equal(compactionCompletions(prefix), null);
});
