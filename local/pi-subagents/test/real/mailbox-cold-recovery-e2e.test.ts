import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { piBinary, prepareFreshProfile } from "../fixtures/fresh-profile.js";
import { delay } from "../fixtures/fresh-host.js";
test("recovered D intent is cold until resume; lost fulfilled ACK repairs without a request", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "subagents-mailbox-cold-")), agentDir = await prepareFreshProfile(root);
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const session = join(root, "main.jsonl"), sessionId = "subagent-cold-recovery", log = join(root, "provider.jsonl");
  await writeFile(session, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const pkg = resolve(import.meta.dirname, "../..");
  async function start(loseAck: boolean) {
    const child = spawn(piBinary, ["--offline", "--mode", "rpc", "--session", session, "--no-extensions",
      "-e", join(pkg, "test/fixtures/faux-subagent-provider.ts"), "-e", join(pkg, "test/fixtures/mailbox-cold-source.ts"),
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "fixture", "--model", "faux-1", "--thinking", "off"],
    { cwd: root, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_NEXT_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SUBAGENTS_TEST_LOG: log,
      PI_MAILBOX_TEST_ACK_LOST: loseAck ? "1" : "0" }, stdio: ["pipe", "pipe", "pipe"] });
    const records: any[] = []; let buffer = "", stderr = "", id = 0;
    child.stdout.on("data", data => { buffer += data; for (let at; (at = buffer.indexOf("\n")) >= 0;) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) records.push(JSON.parse(line)); } });
    child.stderr.on("data", data => { stderr += data; });
    children.push(child);
    const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    const until = async <T>(get: () => Promise<T> | T, accept: (value: T) => boolean): Promise<T> => {
      const end = Date.now() + 25_000;
      for (;;) { const result = await get(); if (accept(result)) return result; if (Date.now() > end || child.exitCode !== null) throw new Error(stderr + "\n" + JSON.stringify(records.slice(-4)).slice(-2000)); await delay(10); }
    };
    async function rpc(type: string, data: any = {}) { const request = `cold-${++id}`; child.stdin.write(JSON.stringify({ id: request, type, ...data }) + "\n");
      const reply: any = await until(() => records.find(row => row.id === request), Boolean); assert.equal(reply.success, true, JSON.stringify(reply)); return reply.data; }
    await rpc("get_state");
    return { rpc, until, async stop() {
      child.stdin.end(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { assert.deepEqual(await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cold fixture quit timed out: " + stderr)), 15_000); })]), { code: 0, signal: null }); }
      finally { clearTimeout(timer); }
    } };
  }
  const calls = async () => { try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const first = await start(true); await delay(150); assert.equal(await calls(), 0, "recovered ingress cannot wake a fresh host");
  await first.rpc("prompt", { message: "/mailbox resume" });
  await first.until(async () => (await first.rpc("get_entries")).entries as any[], entries => entries.some(entry => entry.customType === "agent-mailbox-delivery-v1"));
  assert.equal(await calls(), 1);
  const path = join(agentDir, "mailbox/v1", sessionId, "pending.json");
  const debt = await first.until(async () => JSON.parse(await readFile(path, "utf8")), value => value.pending.length === 0 && value.terminal[0]?.terminalAck === "pending");
  const terminalId = debt.terminal[0].evidence.terminalId;
  await first.until(async () => { try { return await readFile(join(root, "mailbox-fixture-settled"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } }, value => value === "yes");
  await first.stop();
  const reopened = await start(false);
  await reopened.until(async () => (await reopened.rpc("get_entries")).entries as any[], entries => entries.some(entry => entry.customType === "subagent-test-terminal-ack" && entry.data.terminalId === terminalId));
  await reopened.until(async () => {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], terminal: [] }; throw error; }
  }, value => value.pending.length === 0 && value.terminal.length === 0);
  assert.equal(await calls(), 1, "terminal replay repairs only the final source ACK");
  const entries = (await reopened.rpc("get_entries")).entries as any[];
  assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "subagent-mailbox-v1").length, 1);
  assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "agent-mailbox-trigger-v1").length, 1);
  t.diagnostic(JSON.stringify({ coldProviderRequests: 0, resumeProviderRequests: 1, reopenProviderRequests: 0, terminalId })); await reopened.stop();
});
