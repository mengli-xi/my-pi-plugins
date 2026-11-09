import { prepareFreshProfile, piBinary } from "../fixtures/fresh-profile.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pi = piBinary;

// finish_task 之后 Process 才退出：Task 不能被未释放的 Process lease 挂住，late terminal 也不能再起一个 turn。
test("finish_task settles the Task while a Process wait is still blocking", { timeout: 120_000 }, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-process-finish-")));
  await chmod(home, 0o700);
  await mkdir(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const session = join(home, "main.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "process-finish-main", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`, { mode: 0o600 });
  if (process.env.PI_KEEP_PROCESS_FINISH_FIXTURE === "1") console.error(`PROCESS_FINISH_HOME=${home}`);
  else t.after(() => rm(home, { recursive: true, force: true }));

  const agentDir = await prepareFreshProfile(home); const child = spawn(pi, [
    "--mode", "rpc", "--session", session, "--no-extensions",
    "-e", join(process.cwd(), "test", "fixtures", "test-commands.ts"),
    "-e", join(process.cwd(), "..", "pi-processes", "dist", "index.js"),
    "-e", join(process.cwd(), "test", "fixtures", "faux-subagent-provider.ts"),
    "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--provider", "fixture", "--model", "faux-1", "--thinking", "off",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENTS_TEST_TASK_NAME: "process-finish-parent",
      PI_SUBAGENTS_TEST_MESSAGE: "PROCESS_FINISH_PARENT",
      PI_SUBAGENTS_TEST_TIMEOUT_MS: "30000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });

  const records: any[] = [];
  const stderr: Buffer[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let at; (at = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line) records.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const wait = async (id: string) => {
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      const result = records.find((record) => record.id === id && record.type === "response");
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timeout ${id}: ${Buffer.concat(stderr)}`);
  };

  child.stdin.write(`${JSON.stringify({ id: "spawn", type: "prompt", message: "/subagents-test-spawn" })}\n`);
  await wait("spawn");
  // 给已经退出的 Process 留出投递 late terminal 的时间。
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  child.stdin.write(`${JSON.stringify({ id: "entries", type: "get_entries" })}\n`);
  const entries = (await wait("entries")).data.entries;
  const cards = entries.filter((entry: any) => entry.type === "custom_message" && entry.customType === "subagent-completion-v1");
  assert.equal(cards.length, 1, `${Buffer.concat(stderr)}\nentries=${JSON.stringify(entries)}`);
  assert.match(cards[0].content, /FINISH_BEFORE_PROCESS/);
  assert.doesNotMatch(JSON.stringify(entries), /LATE_FINISH_TURN/);

  child.stdin.end();
  const exit = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Process Main did not exit")); }, 10_000);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(exit, { code: 0, signal: null }, Buffer.concat(stderr).toString());
});
