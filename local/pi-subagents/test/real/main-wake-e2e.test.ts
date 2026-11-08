import { prepareFreshProfile, piBinary } from "../fixtures/fresh-profile.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pi = piBinary;
const cwd = await realpath(process.cwd());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("producer fallback wakes Main after a Subagent completion", { timeout: 60_000 }, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-main-wake-")));
  await chmod(home, 0o700);
  await mkdir(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const session = join(home, "main.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "main-wake", timestamp: new Date().toISOString(), cwd })}\n`, { mode: 0o600 });
  const agentDir = await prepareFreshProfile(home); const child = spawn(pi, ["--mode", "rpc", "--session", session, "--no-extensions", "-e", join(cwd, "dist", "index.js"), "-e", join(cwd, "test", "fixtures", "faux-subagent-provider.ts"), "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "fixture", "--model", "faux-1", "--thinking", "off"], { cwd, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  });
  const records: any[] = [], stderr: Buffer[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => { buffer += chunk; for (let at; (at = buffer.indexOf("\n")) >= 0;) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) records.push(JSON.parse(line)); } });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const request = async (id: string, type: string, extra: Record<string, unknown> = {}) => {
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { const response = records.find((record) => record.id === id && record.type === "response"); if (response) return response; await sleep(10); }
    throw new Error(`timeout ${id}: ${Buffer.concat(stderr)}`);
  };
  await request("prompt", "prompt", { message: "WAKE_MAIN: spawn one Subagent with spawn_agent. The child must reply exactly SUBAGENT_OK. Do not wait manually." });
  let entries: any[] = [];
  const deadline = Date.now() + 45_000;
  for (let index = 0; Date.now() < deadline; index++) {
    entries = (await request(`entries-${index}`, "get_entries")).data.entries;
    if (entries.some((entry: any) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.content?.some((block: any) => block.type === "text" && block.text.includes("MAIN_WOKEN")))) break;
    await sleep(20);
  }
  assert.ok(entries.some((entry: any) => entry.type === "custom_message" && entry.customType === "subagent-completion-v1"), JSON.stringify(entries));
  assert.equal(entries.filter((entry: any) => entry.type === "custom_message" && entry.customType === "subagent-continuation-v1").length, 1, JSON.stringify(entries));
  assert.ok(entries.some((entry: any) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.content?.some((block: any) => block.type === "text" && block.text.includes("MAIN_WOKEN"))), `${Buffer.concat(stderr)}\n${JSON.stringify(entries)}`);
  child.stdin.end();
});
