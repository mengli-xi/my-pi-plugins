import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  scavengeStaleRoots,
  type StaleRootCleanupOptions,
  type StaleRootCleanupSummaryV1,
  type StaleRootSkipReason,
} from "../../src/host/stale-root-cleanup.ts";

/**
 * 每个用例都在自己的 mkdtemp base 里造 root。base 名字不匹配 root 命名规则，
 * 机器上真实的历史 root 既不会被读到也不会被删。
 */
async function makeBase(t: TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pi-processes-scavenge-case-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  return base;
}

function nonce(): string {
  return randomBytes(32).toString("hex");
}

/** 拿一个已确认退出（kill(pid,0) 抛 ESRCH）的 PID，不假设固定数字。 */
async function deadPid(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
    await new Promise((resolve) => setImmediate(resolve));
    if (!pid) continue;
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not obtain a confirmed dead pid");
}

/** 一个当前存活、但与 Pi 无关的进程，用来模拟 PID 复用。 */
async function livePid(t: TestContext): Promise<number> {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(child.pid, "helper child has a pid");
  process.kill(child.pid, 0);
  return child.pid;
}

interface PlantOptions {
  readonly piPid: number;
  readonly supervisorPid: number;
  readonly nonce?: string;
  readonly markerNonce?: string;
  readonly markerPiPid?: number;
  readonly marker?: string | undefined;
  readonly records?: boolean;
  /** records/ 里放多少对 `.jsonl` + `.index`；不传就用默认的一对。 */
  readonly recordPairs?: number;
  readonly rootMode?: number;
  readonly markerMode?: number;
}

async function plantRoot(base: string, options: PlantOptions): Promise<string> {
  const hostNonce = options.nonce ?? nonce();
  const path = join(base, `pi-processes-${options.piPid}-${hostNonce}`);
  await mkdir(path, { mode: 0o700 });
  if (options.records !== false) {
    const records = join(path, "records");
    await mkdir(records, { mode: 0o700 });
    if (options.recordPairs === undefined) {
      await writeFile(join(records, "proc_abcdefghijkl.00000001.jsonl"), "{}\n", { mode: 0o600 });
      await writeFile(join(records, "proc_abcdefghijkl.index"), "{}", { mode: 0o600 });
    } else {
      for (let index = 0; index < options.recordPairs; index++) {
        const id = `proc_${index.toString(36).padStart(12, "0")}`;
        await writeFile(join(records, `${id}.00000001.jsonl`), "{}\n", { mode: 0o600 });
        await writeFile(join(records, `${id}.index`), "{}", { mode: 0o600 });
      }
    }
  }
  const marker = options.marker !== undefined ? options.marker : JSON.stringify({
    version: 1,
    hostNonce: options.markerNonce ?? hostNonce,
    piPid: options.markerPiPid ?? options.piPid,
    supervisorPid: options.supervisorPid,
    generation: 1,
  });
  if (marker !== "") await writeFile(join(path, "supervisor.json"), marker, { mode: 0o600 });
  if (options.markerMode !== undefined) await chmod(join(path, "supervisor.json"), options.markerMode);
  await chmod(path, options.rootMode ?? 0o700);
  return path;
}

async function scavenge(base: string, overrides: StaleRootCleanupOptions = {}): Promise<StaleRootCleanupSummaryV1> {
  return await scavengeStaleRoots({ base, report: () => undefined, ...overrides });
}

function skipCount(summary: StaleRootCleanupSummaryV1, reason: StaleRootSkipReason): number {
  return summary.skipped[reason];
}

test("removes a root whose Pi and Supervisor PIDs are both confirmed dead", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });

  const summary = await scavenge(base);

  assert.equal(summary.scanned, 1);
  assert.equal(summary.inspected, 1);
  assert.equal(summary.removed, 1);
  assert.equal(existsSync(path), false);
});

test("removes a dead-owner root that never created a records directory", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid(), records: false });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 1);
  assert.equal(existsSync(path), false);
});

test("keeps a root whose Pi PID is still alive", async (t) => {
  const base = await makeBase(t);
  const alive = await livePid(t);
  const path = await plantRoot(base, { piPid: alive, supervisorPid: await deadPid() });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "owner-alive"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose Supervisor PID was reused by an unrelated live process", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await livePid(t) });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "owner-alive"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root when the liveness probe is inconclusive", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });
  const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });

  const summary = await scavenge(base, { kill: () => { throw eperm; } });

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "owner-unknown"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root when only the Supervisor probe is inconclusive", async (t) => {
  const base = await makeBase(t);
  const piPid = await deadPid();
  const supervisorPid = await deadPid();
  const path = await plantRoot(base, { piPid, supervisorPid });
  const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });

  const summary = await scavenge(base, {
    kill: (pid) => {
      if (pid === supervisorPid) throw eperm;
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    },
  });

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "owner-unknown"), 1);
  assert.equal(existsSync(path), true);
});

test("never touches the current Pi process's own root", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: process.pid, supervisorPid: await deadPid() });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "self-root"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a symlinked root", async (t) => {
  const base = await makeBase(t);
  const real = await mkdtemp(join(tmpdir(), "pi-processes-scavenge-target-"));
  t.after(async () => { await rm(real, { recursive: true, force: true }); });
  const link = join(base, `pi-processes-${await deadPid()}-${nonce()}`);
  await symlink(real, link);

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "not-a-directory"), 1);
  assert.equal(existsSync(real), true);
});

test("keeps a root containing a symlinked marker", async (t) => {
  const base = await makeBase(t);
  const decoy = join(base, "decoy.json");
  await writeFile(decoy, JSON.stringify({ version: 1 }), { mode: 0o600 });
  const hostNonce = nonce();
  const piPid = await deadPid();
  const path = join(base, `pi-processes-${piPid}-${hostNonce}`);
  await mkdir(path, { mode: 0o700 });
  await symlink(decoy, join(path, "supervisor.json"));

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "unknown-entry"), 1);
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(decoy), true);
});

test("keeps a root containing a symlinked record file", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });
  const decoy = join(base, "decoy.jsonl");
  await writeFile(decoy, "{}\n", { mode: 0o600 });
  await symlink(decoy, join(path, "records", "proc_abcdefghijkm.00000001.jsonl"));

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "unknown-entry"), 1);
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(decoy), true);
});

test("keeps a root holding an entry outside the closed layout", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });
  await writeFile(join(path, "notes.txt"), "keep me", { mode: 0o600 });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "unknown-entry"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose records directory holds an unknown file", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });
  await writeFile(join(path, "records", "stray.log"), "x", { mode: 0o600 });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "unknown-entry"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose marker nonce disagrees with the directory name", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid(), markerNonce: nonce() });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "identity-mismatch"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose marker Pi PID disagrees with the directory name", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid(), markerPiPid: await deadPid() });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "identity-mismatch"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root owned by another uid", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });

  const summary = await scavenge(base, { uid: (process.getuid?.() ?? 0) + 1 });

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "foreign-owner"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose directory mode is not 0700", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid(), rootMode: 0o755 });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "mode-mismatch"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose marker mode is not 0600", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid(), markerMode: 0o644 });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "mode-mismatch"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose marker is malformed", async (t) => {
  const base = await makeBase(t);
  const path = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid(), marker: "{not json" });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "marker-invalid"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root whose marker carries an unknown schema version", async (t) => {
  const base = await makeBase(t);
  const piPid = await deadPid();
  const hostNonce = nonce();
  const path = await plantRoot(base, {
    piPid,
    supervisorPid: await deadPid(),
    nonce: hostNonce,
    marker: JSON.stringify({ version: 2, hostNonce, piPid, supervisorPid: 4242, generation: 1 }),
  });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "marker-version-unknown"), 1);
  assert.equal(existsSync(path), true);
});

test("keeps a root that never finished creation", async (t) => {
  const base = await makeBase(t);
  const path = join(base, `pi-processes-${await deadPid()}-${nonce()}`);
  await mkdir(path, { mode: 0o700 });

  const summary = await scavenge(base);

  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "marker-missing"), 1);
  assert.equal(existsSync(path), true);
});

test("two concurrent passes over one base remove the dead root once and keep the live one", async (t) => {
  const base = await makeBase(t);
  const dead = await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });
  const live = await plantRoot(base, { piPid: await livePid(t), supervisorPid: await deadPid() });

  const [first, second] = await Promise.all([scavenge(base), scavenge(base)]);

  assert.ok(first.removed + second.removed >= 1, "the dead root is removed by exactly one of the passes");
  assert.ok(first.removed + second.removed <= 2);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
  assert.equal(skipCount(first, "inspect-failed") + skipCount(second, "inspect-failed"), 0);
  assert.equal(skipCount(first, "remove-failed") + skipCount(second, "remove-failed"), 0);
  assert.deepEqual((await readdir(base)).sort(), [live.slice(base.length + 1)]);
});

test("stops at the per-start root bound and defers the rest", async (t) => {
  const base = await makeBase(t);
  for (let index = 0; index < 5; index++) await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });

  const summary = await scavenge(base, { maxRoots: 2 });

  assert.equal(summary.scanned, 5);
  assert.equal(summary.inspected, 2);
  assert.equal(summary.removed, 2);
  assert.equal(summary.deferred, 3);
  assert.equal((await readdir(base)).length, 3);
});

test("admits no root once the soft budget is already spent", async (t) => {
  const base = await makeBase(t);
  for (let index = 0; index < 3; index++) await plantRoot(base, { piPid: await deadPid(), supervisorPid: await deadPid() });
  let clock = 0;

  const summary = await scavenge(base, { budgetMs: 10, now: () => (clock += 20) });

  assert.equal(summary.inspected, 0);
  assert.equal(summary.deferred, 3);
  assert.equal((await readdir(base)).length, 3);
});

test("an unreadable base reports a failed scan instead of throwing", async (t) => {
  const base = await makeBase(t);

  const summary = await scavenge(join(base, "missing"));

  assert.equal(summary.scanFailed, true);
  assert.equal(summary.scanned, 0);
  assert.equal(summary.removed, 0);
});

test("ignores directory names that are not canonical private roots", async (t) => {
  const base = await makeBase(t);
  await mkdir(join(base, "pi-processes-0-" + nonce()), { mode: 0o700 });
  await mkdir(join(base, "pi-processes-007-" + nonce()), { mode: 0o700 });
  await mkdir(join(base, "pi-processes-123-short"), { mode: 0o700 });
  await mkdir(join(base, "unrelated"), { mode: 0o700 });

  const summary = await scavenge(base);

  assert.equal(summary.scanned, 0, "pid 0 与前导零都不是 SupervisorClient 会造出来的名字");
  assert.equal(summary.inspected, 0);
  assert.equal(summary.removed, 0);
  assert.equal(skipCount(summary, "name-mismatch"), 0, "初筛就排掉了，不进入 inspected");
  assert.equal((await readdir(base)).length, 4);
});

test("invalid names never consume the per-start allowance of valid dead roots", async (t) => {
  const base = await makeBase(t);
  const piPid = await deadPid();
  const supervisorPid = await deadPid();
  const invalid: string[] = [];
  for (let index = 0; index < 100; index++) {
    const flavour = index % 3;
    const name = flavour === 0 ? `pi-processes-0-${nonce()}`
      : flavour === 1 ? `pi-processes-0${index + 1}-${nonce()}`
        : `pi-processes-${index + 1}-${nonce().slice(0, 32)}`;
    invalid.push(name);
    await mkdir(join(base, name), { mode: 0o700 });
  }
  for (let index = 0; index < 70; index++) await plantRoot(base, { piPid, supervisorPid });

  // 冻住时钟，这一轮只考察数量上限。
  const summary = await scavenge(base, { now: () => 0 });

  assert.equal(summary.scanned, 70, "100 个无效名字一个都没进候选");
  assert.equal(summary.inspected, 64);
  assert.equal(summary.removed, 64, "一轮仍然删满 64 个有效 root");
  assert.equal(summary.deferred, 6);
  assert.equal(skipCount(summary, "name-mismatch"), 0);
  const remaining = await readdir(base);
  assert.equal(remaining.length, 106);
  assert.equal(remaining.filter((name) => invalid.includes(name)).length, 100, "无效名字的目录一个都没被删");
});

test("a large root that outruns the soft budget is still removed in full", async (t) => {
  const base = await makeBase(t);
  const piPid = await deadPid();
  const supervisorPid = await deadPid();
  const first = await plantRoot(base, { piPid, supervisorPid, recordPairs: 256 });
  const second = await plantRoot(base, { piPid, supervisorPid, recordPairs: 256 });
  // 两个 root 一样大，所以打乱顺序不影响结论。时钟脚本：开始第一个 root 时预算还在，
  // 跑完它已经远超预算，于是第二个 root 不再开始。
  const clock = [0, 1, 5_000, 5_000];
  let tick = 0;

  const summary = await scavenge(base, {
    budgetMs: 50,
    now: () => clock[Math.min(tick++, clock.length - 1)] as number,
  });

  assert.equal(summary.scanned, 2);
  assert.equal(summary.inspected, 1);
  assert.equal(summary.removed, 1, "超出软预算的 root 照样删干净，不算失败");
  assert.equal(summary.deferred, 1, "预算花完后不再开始下一个 root");
  assert.ok(summary.durationMs > 50, "这一轮确实超出了软预算");
  assert.equal(skipCount(summary, "remove-failed"), 0);
  assert.equal(skipCount(summary, "inspect-failed"), 0);
  const kept = existsSync(first) ? first : second;
  const gone = existsSync(first) ? second : first;
  assert.equal(existsSync(gone), false);
  assert.deepEqual(await readdir(base), [kept.slice(base.length + 1)]);
  assert.equal((await readdir(join(kept, "records"))).length, 512, "被推迟的 root 一个文件都没动");
});
