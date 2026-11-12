import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { readyHistory } from "./history-fixture.ts";
import { addValue, emptyHistogram, histogramDistribution } from "../src/histogram.ts";
import { DAY_MS, packageHash, type Identity } from "../src/history.ts";

const identity: Identity = { pid: process.pid, piVersion: "1.5.0", packagesHash: packageHash(["b", "a"]), packages: ["a", "b"], mode: "tui" };
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "perf-history-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("daily rotation, identity, merged quantile bounds and version/package comparison", () => temporary(async root => {
  const a = readyHistory(root, identity), b = readyHistory(root, identity);
  const now = Date.UTC(2026, 10, 12);
  a.write("session", {}, now); b.write("session", {}, now);
  for (const rss of [10, 20, 30]) a.write("sample", { rss, cpuPercent: rss / 10, loopP99Ms: rss / 5 }, now);
  b.write("sample", { rss: 100 }, now);
  a.write("startup", { readyMs: 100, extensionReachedMs: 40, extensionToReadyMs: 60 }, now);
  b.write("startup", { readyMs: 300, extensionReachedMs: 50, extensionToReadyMs: 250 }, now);
  a.write("sample", { rss: 40 }, now + DAY_MS);
  const other = readyHistory(root, { ...identity, piVersion: "1.6.0", packagesHash: packageHash(["c"]) });
  other.write("sample", { rss: 50 }, now);
  await Promise.all([a.flush(), b.flush(), other.flush()]);
  assert.equal(a.error, undefined);
  assert.deepEqual((await readdir(join(root, "raw"))).sort(), ["2026-11-12.jsonl", "2026-11-13.jsonl"]);
  const { rows } = await a.trends(7, now + DAY_MS);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].metrics.rss.count, 4); assert.equal(rows[0].metrics.rss.max, 100); assert.equal(rows[0].metrics.rss.mean, 40);
  assert.ok(Math.abs(rows[0].metrics.rss.p50 / 20 - 1) <= .025);
  assert.ok(Math.abs(rows[0].metrics.rss.p95 / 100 - 1) <= .025);
  assert.ok(Math.abs(rows[0].metrics.readyMs.p50 / 100 - 1) <= .025); assert.ok(Math.abs(rows[0].metrics.readyMs.p95 / 300 - 1) <= .025);
  assert.equal(rows[0].sessions, 2); assert.equal(rows[0].startups, 2);
  const raw = (await readFile(join(root, "raw/2026-11-12.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const row of raw) {
    assert.equal(row.pid, process.pid); assert.equal(typeof row.piVersion, "string");
    assert.match(row.packagesHash, /^[a-f0-9]{16}$/);
    assert.deepEqual(Object.keys(row).sort(), ["at", "kind", "mode", "packages", "packagesHash", "pid", "piVersion", "run", "values"].sort());
  }
  assert.equal(packageHash(["a", "b"]), packageHash(["b", "a"]));
}));
test("startup cleanup removes only raw days older than 90 days; daily summaries survive", () => temporary(async root => {
  const history = readyHistory(root, identity), now = Date.UTC(2026, 10, 12);
  history.write("sample", { rss: 5 }, now - 91 * DAY_MS);
  history.write("sample", { rss: 6 }, now - 90 * DAY_MS);
  await history.flush();
  await writeFile(join(root, "raw", "unrelated.jsonl"), "keep");
  await history.cleanup(now);
  assert.deepEqual((await readdir(join(root, "raw"))).sort(), ["2026-08-14.jsonl", "unrelated.jsonl"]);
  assert.equal((await readdir(join(root, "daily"))).length, 2);
  assert.equal((await history.trends(30, now)).rows.length, 0);
}));
test("7 and 30 day windows are UTC calendar days, future days excluded", () => temporary(async root => {
  const history = readyHistory(root, identity), now = Date.UTC(2026, 10, 12, 18);
  for (const age of [0, 6, 7, 29, 30, -1]) history.write("sample", { rss: age }, now - age * DAY_MS);
  await history.flush();
  assert.equal((await history.trends(7, now)).rows.length, 2);
  assert.equal((await history.trends(30, now)).rows.length, 4);
}));
test("multiple real processes append without losing or interleaving lines or daily contributions", () => temporary(async root => {
  const source = `import { PerfHistory } from ${JSON.stringify(new URL("../src/history.ts", import.meta.url).href)};
const history = new PerfHistory(process.argv[1], { pid:process.pid, piVersion:'1.5.0', packagesHash:'test', packages:['a','b'], mode:'tui' });
history.setIdentityReady(Promise.resolve());
for(let i=0;i<120;i++) history.write('sample',{rss:i},Date.UTC(2026,10,12));
await history.flush(); if(history.error) throw new Error(history.error);`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, root], { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  const lines = (await readFile(join(root, "raw/2026-11-12.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 480);
  const pids = new Set(lines.map(row => row.pid)); assert.equal(pids.size, 4);
  for (const pid of pids) assert.deepEqual(lines.filter(row => row.pid === pid).map(row => row.values.rss), Array.from({ length: 120 }, (_, i) => i));
  const { rows } = await readyHistory(root, identity).trends(7, Date.UTC(2026, 10, 12));
  assert.equal(rows[0].metrics.rss.count, 480); assert.ok(Math.abs(rows[0].metrics.rss.p95 / 113 - 1) <= .025);
}));
test("storage and invalid summary failures are visible and do not reject profiling writes", () => temporary(async root => {
  await writeFile(join(root, "raw"), "not a directory");
  const history = readyHistory(root, identity);
  history.write("sample", { rss: 1 }); await history.flush();
  assert.match(history.error!, /history write failed/);
  await mkdir(join(root, "daily/2026-11-12"), { recursive: true });
  await writeFile(join(root, "daily/2026-11-12/bad.json"), "{}");
  assert.equal((await history.trends(7, Date.UTC(2026, 10, 12))).skippedFiles, 1);
}));
test("nearest-rank summary handles empty and skewed data", () => {
  assert.deepEqual(histogramDistribution(emptyHistogram()), { count: 0, p50: 0, p95: 0, max: 0, mean: 0 });
  const histogram = emptyHistogram(); for (const value of [1, 2, 3, 100]) addValue(histogram, value);
  assert.ok(Math.abs(histogramDistribution(histogram).p95 / 100 - 1) <= .025);
});


test("clock correction back to a previous day does not overwrite a daily contribution", () => temporary(async root => {
  const history = readyHistory(root, identity), now = Date.UTC(2026, 10, 12);
  history.write("sample", { rss: 1 }, now);
  history.write("sample", { rss: 2 }, now + DAY_MS);
  history.write("sample", { rss: 3 }, now);
  await history.flush();
  const { rows } = await history.trends(7, now + DAY_MS);
  assert.equal(rows[0].metrics.rss.count, 2); assert.equal(rows[0].metrics.rss.max, 3);
}));


test("bad or incomplete files are skipped individually while valid and legacy data remain readable", () => temporary(async root => {
  const now = Date.UTC(2026, 10, 12), history = readyHistory(root, identity);
  history.write("startup", { readyMs: 100 }, now); await history.flush();
  const dir = join(root, "daily/2026-11-12");
  const valid = JSON.parse(await readFile(join(dir, `${history.run}.json`), "utf8"));
  await writeFile(join(dir, "broken.json"), "{");
  await writeFile(join(dir, "missing-version.json"), JSON.stringify({ ...valid, identity: { ...identity, piVersion: undefined } }));
  await writeFile(join(dir, "broken-histogram.json"), JSON.stringify({ ...valid, histograms: { rss: { count: 1 } } }));
  await writeFile(join(dir, "legacy.json"), JSON.stringify({ version: 1, day: "2026-11-12", identity,
    sessions: 1, startups: 1, values: { readyMs: Array(10000).fill(200), loopP99Ms: [21, 41] } }));
  let yielded = false; const timer = setImmediate(() => { yielded = true; });
  const result = await history.trends(30, now); clearImmediate(timer);
  assert.equal(yielded, true); assert.equal(result.skippedFiles, 3); assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find(row => row.mode === "tui")!.startups, 1);
  assert.equal(result.rows.find(row => row.mode === "unknown")!.metrics.readyMs.count, 10000);
  assert.equal(result.rows.find(row => row.mode === "unknown")!.metrics.loopP99Ms.mean, 11);
}));
test("daily shards are bounded and modes are never combined", () => temporary(async root => {
  const now = Date.UTC(2026, 10, 12), history = readyHistory(root, identity);
  history.write("sample", { rss: 100 }, now); await history.flush();
  const path = join(root, "daily/2026-11-12", `${history.run}.json`);
  const initial = (await readFile(path)).length;
  for (let i = 0; i < 500; i++) history.write("sample", { rss: 100 }, now);
  const rpc = readyHistory(root, { ...identity, mode: "rpc" }); rpc.write("startup", { readyMs: 20 }, now);
  history.write("startup", { readyMs: 200 }, now); await Promise.all([history.flush(), rpc.flush()]);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.version, 2); assert.equal(stored.values, undefined); assert.equal(stored.summary, undefined);
  assert.ok((await readFile(path)).length < initial + 400);
  assert.equal((await readdir(join(root, "daily/2026-11-12"))).length, 2);
  const { rows } = await history.trends(7, now); assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.mode === "rpc")!.metrics.readyMs.mean, 20);
  assert.equal(rows.find(row => row.mode === "tui")!.metrics.readyMs.mean, 200);
}));
test("history errors clear only after successful writes", () => temporary(async root => {
  await writeFile(join(root, "raw"), "blocked"); const history = readyHistory(root, identity);
  history.write("sample", { rss: 1 }); await history.flush(); assert.ok(history.error);
  await rm(join(root, "raw")); history.write("sample", { rss: 2 }); await history.flush(); assert.equal(history.error, undefined);
}));


test("legacy frame fields are read using observed-frame names", () => temporary(async root => {
  const day = "2026-11-12", dir = join(root, "daily", day); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "legacy.json"), JSON.stringify({ version: 1, day, identity, sessions: 1, startups: 1,
    values: { firstPaintMs: [123], launcherFirstPaintMs: [150] } }));
  const { rows } = await readyHistory(root, identity).trends(7, Date.UTC(2026, 10, 12));
  assert.equal(rows[0].metrics.firstObservedFrameMs.mean, 123); assert.equal(rows[0].metrics.launcherFirstObservedFrameMs.mean, 150);
  assert.equal(rows[0].metrics.firstPaintMs, undefined);
}));
