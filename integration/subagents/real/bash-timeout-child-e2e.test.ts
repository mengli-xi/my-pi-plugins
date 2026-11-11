import { prepareFreshProfile, piBinary } from "../../../local/pi-subagents/test/fixtures/fresh-profile.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { mainKey } from "../../../local/pi-subagents/src/domain/ids.ts";

const pi = piBinary;

test("real Subagent child rejects missing bash timeout and executes a corrected call", { timeout: 180_000 }, async (t) => {
  const startedAt = performance.now();
  const phase = (label: string) => t.diagnostic(`${label}: ${Math.round(performance.now() - startedAt)}ms since start`);
  const cwd = process.cwd();
  const extension = resolve(cwd, "../pi-bash-timeout/extensions/index.ts");
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-bash-timeout-")));
  await chmod(home, 0o700);
  const agentDir = await prepareFreshProfile(home);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const sessionId = `pi-subagents-bash-timeout-${Date.now()}`;
  const session = join(home, "main.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`, { mode: 0o600 });
  const storeRoot = join(agentDir, "pi-subagents", "store-v2", "mains", mainKey(sessionId));
  const child = spawn(pi, ["--mode", "rpc", "--session", session, "--no-extensions", "-e", join(cwd, "test/fixtures/test-commands.ts"), "-e", extension, "-e", join(cwd, "test", "fixtures", "faux-subagent-provider.ts"), "--provider", "fixture", "--model", "faux-1", "--thinking", "off"], {
    cwd,
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, HOME: home, PI_SUBAGENTS_TEST_TIMEOUT_MS: "30000", PI_SUBAGENTS_TEST_MESSAGE: "BASH_TIMEOUT_CHILD" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // close also fires after spawn failure; exit does not. Cleanup must never
  // wait forever for an ENOENT child that never acquired a pid.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  t.after(async () => {
    // Reap before deleting the live session/store; cleanup must also run after assertion/RPC failure.
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(home, { recursive: true, force: true });
  });
  const records: any[] = []; const stderr: Buffer[] = []; let buffer = "";
  child.stdout.on("data", (chunk) => { buffer += chunk.toString("utf8"); for (let at; (at = buffer.indexOf("\n")) >= 0;) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) records.push(JSON.parse(line)); } });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  await once(child, "spawn"); // Reject ENOENT immediately, with cleanup already installed.
  phase("Pi spawned");
  const response = async (id: string, timeout = 60_000) => { const deadline = Date.now() + timeout; for (;;) { const record = records.find((item) => item.id === id && item.type === "response"); if (record) return record; if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) throw new Error(`RPC ${id} unavailable: ${Buffer.concat(stderr)}`); await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); } };
  child.stdin.write(`${JSON.stringify({ id: "spawn", type: "prompt", message: "/subagents-test-spawn" })}\n`);
  await response("spawn");
  phase("Task spawn RPC acknowledged");
  let entries: any[] = []; let card: any;
  const deadline = Date.now() + 45_000;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const id = `entries-${attempt}`;
    child.stdin.write(`${JSON.stringify({ id, type: "get_entries" })}\n`);
    entries = (await response(id, Math.max(1, deadline - Date.now()))).data.entries;
    card = entries.find((entry: any) => entry.type === "custom_message" && entry.customType === "subagent-completion-v1" && String(entry.content).includes("BASH_TIMEOUT_CHILD_OK"));
    if (card) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  if (!card) {
    const summary = { stderr: Buffer.concat(stderr).toString("utf8"), custom: entries.filter((entry) => entry.type === "custom_message").map((entry) => ({ customType: entry.customType, content: String(entry.content).slice(0, 2_000), details: entry.details })), errors: records.filter((record) => record.type === "extension_error" || (record.type === "extension_ui_request" && record.method === "notify")).slice(-20) };
    console.error(JSON.stringify(summary));
    throw new Error("bash timeout completion missing");
  }
  phase("Corrected child call completed and delivered");
  const owner = JSON.parse(await readFile(join(storeRoot, "owner.json"), "utf8"));
  assert.equal(owner.main_session_id, sessionId);
  const conversations = await import("node:fs/promises").then(({ readdir }) => readdir(join(storeRoot, "conversations")));
  assert.equal(conversations.length, 1);
  const childEntries = (await readFile(join(storeRoot, "conversations", conversations[0]!, "session.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const childResults = childEntries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "bash");
  assert.equal(childResults.length, 2);
  assert.equal(childResults[0].message.isError, true);
  assert.match(JSON.stringify(childResults[0].message.content), /timeout/);
  assert.equal(childResults[1].message.isError, false);
  assert.match(JSON.stringify(childResults[1].message.content), /BASH_TIMEOUT_EXECUTED/);
  phase("Child transcript verified; sending EOF");
  child.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("bash-timeout Main did not exit")), 60_000); })]).finally(() => clearTimeout(timer));
  phase("Pi closed");
  assert.deepEqual(exit, { code: 0, signal: null }, Buffer.concat(stderr).toString("utf8"));
});
