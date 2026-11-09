import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { piBinary, prepareFreshProfile } from "./fresh-profile.js";

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function freshHost(t: TestContext, message = "Reply exactly SUBAGENT_OK", fullSettings = false, maxDepth: 1 | 2 = 1, extensions: string[] = [], order: "default" | "reverse" = "default") {
  const root = await mkdtemp(join(tmpdir(), "subagents-sdk-host-")), agentDir = await prepareFreshProfile(root, maxDepth, order);
  const session = join(root, "main.jsonl"), sessionId = `sdk-host-${Date.now()}`;
  await writeFile(session, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const pkg = resolve(import.meta.dirname, "../..");
  const fullProfile = process.env.PI_MAILBOX_FULL_PROFILE === "1";
  const runtimeTmp = fullProfile ? JSON.parse(await readFile(join(root, "profile-metadata.json"), "utf8")).runtimeTmp as string : undefined;
  const capture = fullProfile && process.env.PI_MAILBOX_JOINT_EVIDENCE ? join(process.env.PI_MAILBOX_JOINT_EVIDENCE, sessionId) : undefined;
  if (capture) mkdirSync(capture, { recursive: true });
  const extra = fullSettings && !fullProfile ? ["-e", resolve(pkg, "../pi-claude-style/dist/index.ts"), "--tools", "read,bash,edit,write,grep,find,ls"] : [];
  const owners = fullProfile ? [join(pkg, "test/fixtures/test-commands.ts"), ...extensions.filter(path => !path.includes("/fork/pi-goal/extensions/pi-goal/dist/") && !path.includes("/local/pi-claude-style/dist/"))] : [join(pkg, "dist/index.js"), join(pkg, "test/fixtures/test-commands.ts"), resolve(pkg, "../pi-processes/dist/index.js"), ...extensions];
  if (order === "reverse") owners.reverse();
  const main = spawn(piBinary, ["--offline", "--mode", "rpc", "--session", session, ...(fullProfile ? [] : ["--no-extensions"]), ...(process.env.PI_MAILBOX_JOINT === "1" ? ["-e", join(pkg, "test/fixtures/mailbox-joint-cutoff.ts")] : []), "-e", join(pkg, "test/fixtures/faux-subagent-provider.ts"), ...owners.flatMap(path => ["-e", path]), "-e", join(pkg, "test/fixtures/sdk-host-control.ts"),
    ...extra, ...(fullProfile ? [] : ["--no-skills", "--no-prompt-templates", "--no-context-files"]), "--provider", "fixture", "--model", "faux-1", "--thinking", "off", "--approve"], {
    cwd: root, env: { ...process.env, ...(runtimeTmp ? { TMPDIR: runtimeTmp } : {}), HOME: root, XDG_CONFIG_HOME: join(root, ".config"), XDG_DATA_HOME: join(root, ".local/share"), MAGIC_CONTEXT_STORAGE_DIR: join(root, "mc"), PI_SCHEDULER_BINARY: piBinary, PI_CODING_AGENT_DIR: agentDir, PI_NEXT_AGENT_DIR: agentDir, PI_OFFLINE: "1",
      PI_SUBAGENTS_TEST_ASYNC: "1", PI_SUBAGENTS_TEST_MESSAGE: message, PI_SUBAGENTS_HOST_CONTROL: root, PI_SUBAGENTS_TEST_LOG: join(root, "provider.jsonl") }, stdio: ["pipe", "pipe", "pipe"],
  });
  const records: any[] = []; let stderr = "", pending = "", serial = 0;
  main.stdout.on("data", data => { if (capture) appendFileSync(join(capture, "stdout.jsonl"), data); pending += data; for (let at; (at = pending.indexOf("\n")) >= 0;) { const line = pending.slice(0, at); pending = pending.slice(at + 1); if (line) records.push(JSON.parse(line)); } });
  main.stderr.on("data", data => { stderr += data; if (capture) appendFileSync(join(capture, "stderr.txt"), data); });
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => main.once("exit", (code, signal) => resolve({ code, signal })));
  let stopped = false;
  async function until<T>(get: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeout = 25_000): Promise<T> {
    const end = Date.now() + timeout;
    for (;;) { const result = await get(); if (accept(result)) return result; if (Date.now() > end || main.exitCode !== null || main.signalCode !== null) throw new Error(`${label}: ${stderr}\n${JSON.stringify(records.slice(-6)).slice(-4000)}`); await delay(20); }
  }
  async function rpc(type: string, extra: Record<string, unknown> = {}) {
    const id = `rpc-${++serial}`; main.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    const result = await until<any>(() => records.find(row => row.id === id && row.type === "response"), Boolean, id);
    assert.equal(result.success, true, JSON.stringify(result) + stderr); return result.data;
  }
  async function control(op: string, params?: unknown, target?: string): Promise<any> {
    const id = ++serial; await writeFile(join(root, "command.json"), JSON.stringify({ id, op, params, target }));
    await rpc("prompt", { message: "/subagents-host-control" });
    const value = JSON.parse(await readFile(join(root, "result.json"), "utf8")); assert.equal(value.id, id); return value.result;
  }
  const snapshot = () => control("snapshot");
  const settled = (count = 1) => until(snapshot, value => value.snapshot?.agents.reduce((n: number, item: any) => n + item.tasks.filter((task: any) => task.phase === "settled").length, 0) >= count, "settled", Math.max(25_000, count * 4_000));
  async function stop() { if (!stopped) { stopped = true; main.stdin.end(); } let timer: ReturnType<typeof setTimeout> | undefined; const result = await Promise.race([exit, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`quit timed out: ${stderr}`)), 15_000); })]).finally(() => clearTimeout(timer)); assert.deepEqual(result, { code: 0, signal: null }, stderr); return result; }
  t.after(async () => {
    if (!stopped && main.exitCode === null && main.signalCode === null) { try { await stop(); } catch { main.kill("SIGKILL"); await exit; } }
    if (capture) for (const [source, destination] of [["provider.jsonl", "provider.jsonl"], ["profile-metadata.json", "profile-metadata.json"], ["joint-cutoff.json", "joint-cutoff.json"], ["joint-cutoff-accepted.json", "joint-cutoff-accepted.json"]]) {
      try { await writeFile(join(capture, destination!), await readFile(join(root, source!))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (fullProfile) {
      // This store was created in this fixture's private agent directory. Stop
      // its detached daemon after Pi exits, before deleting its lock and store.
      const { stopOwnScheduler } = await import(pathToFileURL(resolve(pkg, "../../scripts/mailbox/runtime-cleanup.mjs")).href);
      await stopOwnScheduler(agentDir);
    }
    await rm(root, { recursive: true, force: true });
    if (runtimeTmp) await rm(runtimeTmp, { recursive: true, force: true });
  });
  await rpc("get_state");
  if (fullProfile) await rpc("prompt", { message: "/schedule list" }); // positive backend readiness, zero provider requests
  const descendants = () => {
    const rows = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").flatMap(line => { const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : []; });
    const ids = new Set([main.pid]); let changed = true;
    while (changed) { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
    return rows.filter(row => row.pid !== main.pid && ids.has(row.pid));
  };
  return { root, agentDir, session, sessionId, main, records, rpc, control, snapshot, settled, until, stop, descendants,
    async assertAuthSymlink() { assert.equal((await lstat(join(agentDir, "auth.json"))).isSymbolicLink(), true); },
    assertNoChildPi() { const rows = descendants(); assert.deepEqual(rows.filter(row => /pi-subagents\/dist\/(child|supervisor)\.js/.test(row.command) || row.command.includes(piBinary)), []); },
    get stderr() { return stderr; } };
}
