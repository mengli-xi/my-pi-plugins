import assert from "node:assert/strict";
import test from "node:test";
import { readyHistory } from "./history-fixture.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, MAX_TREND_FILES, packageHash, RUN_RETENTION_DAYS, type DailyShard, type Identity } from "../src/history.ts";
import { addValue, emptyHistogram } from "../src/histogram.ts";
import { ARCHIVE_BYTE_LIMIT, ARCHIVE_GROUP_LIMIT, readArchive, recoverCompaction } from "../src/daily-archive.ts";
import { withStorageLock } from "../src/storage-lock.ts";

const identity: Identity = { pid: process.pid, piVersion: "1.5.0", packages: ["plugin-a"], packagesHash: packageHash(["plugin-a"]), mode: "tui" };
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
function shard(day: string, id = identity, rss = 100): DailyShard {
  const histogram = emptyHistogram(); addValue(histogram, rss);
  return { version: 2, day, identity: id, sessions: 1, startups: 0, histograms: { rss: histogram } };
}
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "perf-maintenance-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function child(source: string, root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, root], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; processChild.stderr.on("data", chunk => { stderr += chunk; });
    processChild.on("error", reject); processChild.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test("old runs compact once, stay bounded, and preserve modes and all counts", () => temporary(async root => {
  const now = Date.now(), day = dayOf(now - (RUN_RETENTION_DAYS + 2) * DAY_MS), directory = join(root, "daily", day);
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < 50; i++) {
    const packages = [`plugin-${i}`], mode = i % 2 ? "rpc" : "tui";
    await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(shard(day, { ...identity, packages, mode, packagesHash: packageHash(packages) }, i)));
  }
  const history = readyHistory(root, identity); await history.cleanup(now);
  assert.equal(history.maintenanceError, undefined);
  assert.deepEqual(await readdir(directory), ["summary.jsonl"]);
  assert.ok((await stat(join(directory, "summary.jsonl"))).size <= ARCHIVE_BYTE_LIMIT);
  const result = await history.trends(30, now);
  assert.equal(result.combinedGroups, true); assert.ok(result.rows.length <= ARCHIVE_GROUP_LIMIT + 5);
  for (const mode of ["tui", "rpc"]) assert.equal(result.rows.filter(row => row.mode === mode).reduce((n, row) => n + row.metrics.rss.count, 0), 25);
  await history.cleanup(now); assert.equal((await history.trends(30, now)).rows.reduce((n, row) => n + row.metrics.rss.count, 0), 50);
}));
test("multiple maintainers and a late writer converge without lost or duplicated contributions", () => temporary(async root => {
  const now = Date.now(), at = now - 10 * DAY_MS, day = dayOf(at), directory = join(root, "daily", day);
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < 20; i++) await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(shard(day)));
  const module = JSON.stringify(new URL("../src/history.ts", import.meta.url).href);
  const id = JSON.stringify(identity);
  const maintain = `import { PerfHistory } from ${module}; const h=new PerfHistory(process.argv[1],${id}); await h.cleanup(${now}); if(h.maintenanceError) throw Error(h.maintenanceError);`;
  const write = `import { PerfHistory } from ${module}; const h=new PerfHistory(process.argv[1],{...${id},pid:process.pid}); h.setIdentityReady(Promise.resolve()); for(let i=0;i<10;i++)h.write('sample',{rss:100},${at}); await h.flush(); if(h.error)throw Error(h.error);`;
  await Promise.all([child(maintain, root), child(maintain, root), child(write, root)]);
  const history = readyHistory(root, identity), result = await history.trends(30, now);
  assert.equal(result.rows[0].metrics.rss.count, 30); assert.equal(result.rows[0].sessions, 20);
  // A writer never merges. Any contribution published after maintenance is
  // still loose until the next maintenance pass; reads include both forms.
  await history.cleanup(now);
  assert.equal((await history.trends(30, now)).rows[0].metrics.rss.count, 30);
  assert.deepEqual(await readdir(directory), ["summary.jsonl"]);
}));
test("compaction recovers before and after publication without double-counting staged runs", () => temporary(async root => {
  const day = dayOf(Date.now() - 10 * DAY_MS), directory = join(root, "daily", day), pending = join(directory, ".compact");
  await mkdir(pending, { recursive: true });
  const transaction = randomUUID(), source = JSON.stringify(shard(day));
  await writeFile(join(pending, "state.json"), JSON.stringify({ transaction }));
  await writeFile(join(pending, `${randomUUID()}.json`), source);
  await withStorageLock(directory, owned => recoverCompaction(directory, day, owned));
  assert.equal([...((await readArchive(directory, day)).groups.values())][0].histograms.rss.count, 1);
  // Simulate SIGKILL after archive rename but before source deletion.
  await mkdir(pending); await writeFile(join(pending, "state.json"), JSON.stringify({ transaction }));
  await writeFile(join(pending, `${randomUUID()}.json`), source);
  await withStorageLock(directory, owned => recoverCompaction(directory, day, owned));
  assert.equal([...((await readArchive(directory, day)).groups.values())][0].histograms.rss.count, 1);
  assert.deepEqual(await readdir(directory), ["summary.jsonl"]);
}));
test("old archive tmp files are reclaimed under the maintenance lock", () => temporary(async root => {
  const now = Date.now(), day = dayOf(now - 100 * DAY_MS), directory = join(root, "daily", day);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "summary.jsonl.2147483647.tmp"), "abandoned");
  await writeFile(join(directory, `summary.jsonl.${process.pid}.tmp`), "live");
  await readyHistory(root, identity).cleanup(now);
  assert.deepEqual(await readdir(directory), [`summary.jsonl.${process.pid}.tmp`]);
}));
test("maintenance starts off the startup path and cancellation prevents its timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const history = readyHistory("/unused", identity); let calls = 0;
  t.mock.method(history, "cleanup", async () => { calls++; });
  const stop = history.scheduleCleanup(); assert.equal(calls, 0);
  t.mock.timers.tick(29_999); assert.equal(calls, 0);
  t.mock.timers.tick(1); await Promise.resolve(); assert.equal(calls, 1);
  stop(); t.mock.timers.tick(24 * DAY_MS); await Promise.resolve(); assert.equal(calls, 1);
});
test("trends apply a total file budget and have stable package-hash tie ordering", () => temporary(async root => {
  const now = Date.now(), day = dayOf(now), directory = join(root, "daily", day);
  await mkdir(directory, { recursive: true });
  for (const hash of ["zz", "aa"]) await writeFile(join(directory, `${hash}.json`), JSON.stringify(shard(day, { ...identity, packagesHash: hash })));
  const history = readyHistory(root, identity);
  assert.deepEqual((await history.trends(7, now)).rows.map(row => row.packagesHash), ["aa", "zz"]);
  await Promise.all(Array.from({ length: MAX_TREND_FILES + 1 }, (_, i) => writeFile(join(directory, `invalid-${i}.json`), "{}")));
  const result = await history.trends(7, now); assert.equal(result.limited, true); assert.ok(result.skippedFiles <= MAX_TREND_FILES);
}));
test("own damaged and oversized shard is rebuilt rather than poisoning every later write", () => temporary(async root => {
  const now = Date.now(), day = dayOf(now), history = readyHistory(root, identity);
  history.write("sample", { rss: 1 }, now); await history.flush();
  const path = join(root, "daily", day, `${history.run}.json`);
  for (const payload of ["broken", "x".repeat(1024 * 1024 + 1)]) {
    // Rotate away so the next access reads persistent state, rather than the valid cache.
    history.write("sample", { rss: 1 }, now + DAY_MS); await history.flush();
    await writeFile(path, payload); history.write("sample", { rss: 2 }, now); await history.flush();
    assert.equal(history.error, undefined);
    history.write("sample", { rss: 3 }, now); await history.flush(); assert.equal(history.error, undefined);
    const stored = JSON.parse(await readFile(path, "utf8")); assert.equal(stored.histograms.rss.count, 2);
  }
}));


test("an archive stream read error is skipped without terminating the session", () => temporary(async root => {
  const now = Date.now(), day = dayOf(now - 10 * DAY_MS), directory = join(root, "daily", day);
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, "summary.jsonl")); // stat succeeds, stream read fails (EISDIR).
  const history = readyHistory(root, identity);
  const result = await history.trends(30, now);
  assert.equal(result.skippedFiles, 1); assert.deepEqual(result.rows, []);
}));


test("one failed day is isolated, later days progress, and errors survive another process", () => temporary(async root => {
  const now = Date.now(), badDay = dayOf(now - 10 * DAY_MS), goodDay = dayOf(now - 9 * DAY_MS);
  for (const day of [badDay, goodDay]) {
    const directory = join(root, "daily", day); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(shard(day)));
  }
  const directory = join(root, "daily", badDay);
  await writeFile(join(directory, "summary.jsonl"), "broken JSON");
  const history = readyHistory(root, identity); await history.cleanup(now);
  assert.match(history.maintenanceError!, /invalid JSON/);
  assert.equal(await readFile(join(directory, "summary.jsonl.bad"), "utf8"), "broken JSON");
  assert.deepEqual(await readdir(join(root, "daily", goodDay)), ["summary.jsonl"]);
  const state = JSON.parse(await readFile(join(root, ".maintenance/state.json"), "utf8"));
  assert.equal(state.errorCount, 1); assert.match(state.failedDays[badDay], /quarantined/);
  const module = JSON.stringify(new URL("../src/history.ts", import.meta.url).href);
  await child(`import { PerfHistory } from ${module}; const h=new PerfHistory(process.argv[1],${JSON.stringify(identity)}); await h.loadMaintenanceErrors(); if(!h.maintenanceError?.includes('invalid JSON')) throw Error('lost persisted diagnostic');`, root);
  await history.cleanup(now); // No through/checkedOn skips: the failed date is retried now.
  const result = await history.trends(30, now); assert.equal(result.rows.reduce((n, row) => n + row.metrics.rss.count, 0), 2);
  const recovered = JSON.parse(await readFile(join(root, ".maintenance/state.json"), "utf8"));
  assert.deepEqual(recovered, { errorCount: 0, failedDays: {} }); assert.equal(history.maintenanceError, undefined);
}));
test("settled days are not locked and an unchanged state is not written", () => temporary(async root => {
  const now = Date.now(), day = dayOf(now - 20 * DAY_MS), directory = join(root, "daily", day);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(shard(day)));
  const history = readyHistory(root, identity); await history.cleanup(now);
  assert.deepEqual(await readdir(directory), ["summary.jsonl"]);
  await history.cleanup(now);
  // 已合并完的日期不再加锁（没有 .lock 残留），状态没变也不写 state.json
  assert.deepEqual(await readdir(directory), ["summary.jsonl"]);
  assert.deepEqual(await readdir(join(root, ".maintenance")), []);
}));
test("late writes publish only loose deltas and never inspect or change an archive", () => temporary(async root => {
  const now = Date.now(), at = now - 10 * DAY_MS, day = dayOf(at), directory = join(root, "daily", day);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(shard(day)));
  const history = readyHistory(root, identity); await history.cleanup(now);
  const archive = join(directory, "summary.jsonl"), before = await readFile(archive);
  history.write("sample", { rss: 3 }, at); history.write("sample", { rss: 4 }, at); await history.flush();
  assert.equal(history.error, undefined); assert.deepEqual(await readFile(archive), before);
  assert.equal((await readdir(directory)).filter(name => name.endsWith(".json")).length, 2);
  assert.equal((await history.trends(30, now)).rows[0].metrics.rss.count, 3);
  await history.cleanup(now); assert.deepEqual(await readdir(directory), ["summary.jsonl"]);
  assert.equal((await history.trends(30, now)).rows[0].metrics.rss.count, 3);
}));


test("a transaction interrupted before moving its first run recovers a valid empty archive", () => temporary(async root => {
  const day = dayOf(Date.now() - 10 * DAY_MS), directory = join(root, "daily", day), pending = join(directory, ".compact");
  await mkdir(pending, { recursive: true });
  await writeFile(join(pending, "state.json"), JSON.stringify({ transaction: randomUUID() }));
  await withStorageLock(directory, owned => recoverCompaction(directory, day, owned));
  assert.equal((await readArchive(directory, day)).groups.size, 0);
  await writeFile(join(directory, `${randomUUID()}.json`), JSON.stringify(shard(day)));
  const history = readyHistory(root, identity); await history.cleanup();
  assert.equal(history.maintenanceError, undefined);
  assert.equal((await history.trends(30)).rows[0].metrics.rss.count, 1);
}));
