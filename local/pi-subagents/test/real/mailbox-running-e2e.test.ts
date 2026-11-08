import { prepareFreshProfile, piBinary } from "../fixtures/fresh-profile.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pi = piBinary;

async function childSessionFile(home: string): Promise<string> {
  const mains = join(home, ".pi", "agent", "pi-subagents", "store-v2", "mains");
  for (const main of await readdir(mains)) {
    const conversations = join(mains, main, "conversations");
    for (const agent of await readdir(conversations).catch(() => [])) {
      const file = join(conversations, agent, "session.jsonl");
      if (await readFile(file).then(() => true).catch(() => false)) return file;
    }
  }
  throw new Error("Subagent conversation was not created");
}

// send_input 投给正在跑任务的 Agent：必须被接受，并在子进程 session 里留下可证明的 mailbox entry。
test("send_input reaches an Agent that is running a task", { timeout: 120_000 }, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-mailbox-")));
  await chmod(home, 0o700);
  await mkdir(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const session = join(home, "main.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "mailbox-main", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`, { mode: 0o600 });
  if (process.env.PI_KEEP_MAILBOX_FIXTURE === "1") console.error(`MAILBOX_HOME=${home}`);
  else t.after(() => rm(home, { recursive: true, force: true }));

  const agentDir = await prepareFreshProfile(home); const child = spawn(pi, [
    "--mode", "rpc", "--session", session, "--no-extensions",
    "-e", join(process.cwd(), "dist", "index.js"),
    "-e", join(process.cwd(), "test", "fixtures", "faux-subagent-provider.ts"),
    "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--provider", "fixture", "--model", "faux-1", "--thinking", "off",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENTS_TEST_HOOKS: "1",
      PI_SUBAGENTS_TEST_ASYNC: "1",
      PI_SUBAGENTS_TEST_TASK_NAME: "mail_child",
      PI_SUBAGENTS_TEST_MESSAGE: "MAILBOX_CHILD",
      PI_SUBAGENTS_TEST_MAILBOX: "MAILBOX_NOTE",
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
  const file = await (async () => { const deadline = Date.now() + 30_000; for (;;) { try { return await childSessionFile(home); } catch (error) { if (Date.now() > deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); } } })();
  const read = async (): Promise<any[]> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // 等子进程真正进入 tool batch（bash 还在跑）再投递 mailbox。
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !JSON.stringify(await read()).includes("mailbox-sleep")) await new Promise((resolve) => setTimeout(resolve, 50));
  child.stdin.write(`${JSON.stringify({ id: "send", type: "prompt", message: "/subagents-test-send" })}\n`);
  const sent = await wait("send");
  assert.equal(sent.success, true, `${JSON.stringify(sent)}\n${Buffer.concat(stderr)}`);

  const mailboxDeadline = Date.now() + 60_000;
  let entries: any[] = [];
  while (Date.now() < mailboxDeadline) {
    entries = await read();
    if (entries.some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("MAILBOX_SEEN"))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const kinds = entries.map((entry) => entry.type === "custom_message" ? `custom:${entry.customType}` : entry.type === "message" ? `message:${entry.message.role}` : entry.type);
  const mailbox = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-mailbox-v1");
  assert.equal(mailbox.length, 1, `${Buffer.concat(stderr)}\nentries=${JSON.stringify(kinds)}`);
  assert.match(String(mailbox[0].content), /MAILBOX_NOTE/);
  // §4.2：steer 排在当前 assistant tool batch 之后、下一次 provider request 之前。
  const mailboxIndex = entries.indexOf(mailbox[0]);
  const toolResultIndex = entries.findIndex((entry) => entry.message?.role === "toolResult");
  const assistantAfter = entries.filter((entry, index) => index > mailboxIndex && entry.message?.role === "assistant");
  assert.ok(toolResultIndex >= 0, `no tool batch ran: ${JSON.stringify(kinds)}`);
  assert.ok(mailboxIndex > toolResultIndex, `mailbox landed inside the tool batch: ${JSON.stringify(kinds)}`);
  assert.equal(assistantAfter.length, 1, `expected exactly one turn after the mailbox: ${JSON.stringify(kinds)}`);
  assert.match(JSON.stringify(assistantAfter[0].message.content), /MAILBOX_SEEN/);

  // 投递不能把子进程带崩：Task 仍要正常结算出一张 completion card。
  let cards: any[] = [];
  const cardDeadline = Date.now() + 60_000;
  while (Date.now() < cardDeadline) {
    child.stdin.write(`${JSON.stringify({ id: `cards-${Date.now()}`, type: "get_entries" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const latest = [...records].reverse().find((record) => String(record.id).startsWith("cards-") && record.type === "response");
    cards = (latest?.data?.entries ?? []).filter((entry: any) => entry.type === "custom_message" && entry.customType === "subagent-completion-v1");
    if (cards.length > 0) break;
  }
  assert.equal(cards.length, 1, `${Buffer.concat(stderr)}`);
  assert.doesNotMatch(String(cards[0].content), /crashed/);

  child.stdin.end();
  const exit = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Mailbox Main did not exit")); }, 20_000);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(exit, { code: 0, signal: null }, Buffer.concat(stderr).toString());
});

// 子 agent 已经给出 final（无 tool call）并 park 在 Process 等待上：mailbox 要由 Host 批准恢复，
// 只多跑一轮；之后 Process 完成仍然拿得到它那一次 continuation。
test("a mailbox resumes a Process-parked Agent for exactly one extra turn", { timeout: 180_000 }, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-subagents-mailbox-park-")));
  await chmod(home, 0o700);
  await mkdir(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const session = join(home, "main.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "mailbox-park-main", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`, { mode: 0o600 });
  if (process.env.PI_KEEP_MAILBOX_FIXTURE === "1") console.error(`MAILBOX_PARK_HOME=${home}`);
  else t.after(() => rm(home, { recursive: true, force: true }));

  await prepareFreshProfile(home); const child = spawn(pi, [
    "--mode", "rpc", "--session", session, "--no-extensions",
    "-e", join(process.cwd(), "dist", "index.js"),
    "-e", join(process.cwd(), "..", "pi-processes", "dist", "index.js"),
    "-e", join(process.cwd(), "test", "fixtures", "faux-subagent-provider.ts"),
    "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--provider", "fixture", "--model", "faux-1", "--thinking", "off",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), HOME: home, PI_SUBAGENTS_TEST_HOOKS: "1", PI_SUBAGENTS_TEST_ASYNC: "1", PI_SUBAGENTS_TEST_TASK_NAME: "mail_park_child", PI_SUBAGENTS_TEST_MESSAGE: "MAILBOX_PARK_CHILD", PI_SUBAGENTS_TEST_MAILBOX: "MAILBOX_NOTE" },
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
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = records.find((record) => record.id === id && record.type === "response");
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timeout ${id}: ${Buffer.concat(stderr)}`);
  };

  child.stdin.write(`${JSON.stringify({ id: "spawn", type: "prompt", message: "/subagents-test-spawn" })}\n`);
  await wait("spawn");
  const file = await (async () => { const deadline = Date.now() + 30_000; for (;;) { try { return await childSessionFile(home); } catch (error) { if (Date.now() > deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); } } })();
  const read = async (): Promise<any[]> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const until = async (predicate: (entries: any[]) => boolean, label: string): Promise<any[]> => {
    const deadline = Date.now() + 90_000;
    for (;;) { const entries = await read(); if (predicate(entries)) return entries; if (Date.now() > deadline) throw new Error(`${label}: ${Buffer.concat(stderr)}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  };
  const text = (entries: any[]) => JSON.stringify(entries.filter((entry) => entry.message?.role === "assistant").map((entry) => entry.message.content));

  await until((entries) => text(entries).includes("PARK_WAITING"), "child never parked on the Process wait");
  child.stdin.write(`${JSON.stringify({ id: "send", type: "prompt", message: "/subagents-test-send" })}\n`);
  assert.equal((await wait("send")).success, true, Buffer.concat(stderr).toString());

  const entries = await until((candidates) => text(candidates).includes("PARK_PROCESS_SEEN"), "Process continuation never resumed the Task");
  const kinds = entries.map((entry) => entry.type === "custom_message" ? `custom:${entry.customType}` : entry.type === "message" ? `message:${entry.message.role}` : entry.type);
  const assistants = entries.map((entry, index) => ({ entry, index })).filter((item) => item.entry.message?.role === "assistant");
  const mailbox = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-mailbox-v1");
  assert.equal(mailbox.length, 1, `${Buffer.concat(stderr)}\n${JSON.stringify(kinds)}`);
  const mailboxIndex = entries.indexOf(mailbox[0]);
  const afterMailbox = assistants.filter((item) => item.index > mailboxIndex);
  assert.equal(JSON.stringify(afterMailbox[0]!.entry.message.content).includes("PARK_MAILBOX_SEEN"), true, JSON.stringify(kinds));
  assert.equal(assistants.filter((item) => JSON.stringify(item.entry.message.content).includes("PARK_MAILBOX_SEEN")).length, 1, "mailbox started more than one turn");
  assert.equal(assistants.filter((item) => JSON.stringify(item.entry.message.content).includes("PARK_PROCESS_SEEN")).length, 1, "Process continuation started more than one turn");

  child.stdin.end();
  const exit = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Mailbox park Main did not exit")); }, 30_000);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(exit, { code: 0, signal: null }, Buffer.concat(stderr).toString());
});
