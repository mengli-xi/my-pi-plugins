import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMemoryExtension } from "../index.ts";
import { resolveProject } from "../src/identity.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listTopics, readIndex, topicCompletions } from "../src/files.ts";
import { describeMemory, describeTopic } from "../src/view.ts";

test("the user note says whether and where the injected index was truncated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-view-"));
  try {
    assert.equal((await readIndex(dir)).note, "还没有 MEMORY.md，首次保存主题时创建。");
    await writeFile(join(dir, "MEMORY.md"), "- [A](a.md) — a\n");
    assert.equal((await readIndex(dir)).note, "完整注入：1 行 / 18 字节。");
    await writeFile(join(dir, "MEMORY.md"), Array.from({ length: 205 }, (_, i) => `- line ${i}`).join("\n"));
    assert.match((await readIndex(dir)).note, /^已截断：共 205 行 \/ \d+ 字节，只注入前 200 行 \/ \d+ 字节，从第 201 行起没有注入。$/);
    await writeFile(join(dir, "MEMORY.md"), "x".repeat(30000));
    assert.match((await readIndex(dir)).note, /只注入前 1 行 \/ 25000 字节（首行只注入片段）/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("topics list real files with sizes and index links; completions come from them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-topics-"));
  try {
    await writeFile(join(dir, "MEMORY.md"), "- [Stock](project-stock.md) — host\n- [Old](./feedback-style.md) — style\n");
    await writeFile(join(dir, "project-stock.md"), "STOCK_BODY");
    await writeFile(join(dir, "feedback-style.md"), "s");
    await writeFile(join(dir, "big-topic.md"), "b".repeat(12 * 1024 + 1));
    await writeFile(join(dir, "notes.txt"), "not a topic");
    await mkdir(join(dir, "nested.md"));
    const topics = await listTopics(dir);
    assert.deepEqual(topics.map((t) => [t.name, t.size, t.indexed]), [["big-topic", 12289, false], ["feedback-style", 1, true], ["project-stock", 10, true]]);
    assert.deepEqual((await topicCompletions(dir, ""))?.map((i) => i.value), ["big-topic", "feedback-style", "project-stock"]);
    assert.deepEqual((await topicCompletions(dir, "pro"))?.map((i) => i.value), ["project-stock"]);
    assert.equal(await topicCompletions(dir, "unknown"), null);
    assert.equal(await topicCompletions(undefined, ""), null, "no memory directory");
    assert.equal(await topicCompletions(join(dir, "missing"), ""), null, "unreadable directory");
    const text = describeMemory({ snapshot: { identity: "git:/repo/.git", memoryDir: dir, index: "INJECTED_SECTION", indexNote: "完整注入：2 行 / 70 字节。" }, topics, stale: true });
    for (const expected of ["项目身份：git:/repo/.git", `记忆目录：${dir}`, "MEMORY.md：完整注入", "下一轮会重新读取磁盘", "big-topic  12,289 字节  未被 MEMORY.md 引用，超过 12 KiB", "project-stock  10 字节  已索引", "INJECTED_SECTION"])
      assert.ok(text.includes(expected), expected);
    assert.match(describeTopic(topics[2]!, "STOCK_BODY"), /已索引\n\nSTOCK_BODY$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("without a snapshot the view says why nothing is injected", () => {
  assert.equal(describeMemory({ unavailable: "pi-cc-memory：无法识别项目，暂不注入记忆。boom" }), "没有注入项目记忆。pi-cc-memory：无法识别项目，暂不注入记忆。boom");
  assert.match(describeMemory({}), /还没有记忆快照/);
});

test("completion reuses unchanged index parsing without refreshing the injected snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-completion-cache-"));
  const cwd = join(root, "cwd"), agent = join(root, "agent");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await mkdir(cwd);
    const project = await resolveProject(cwd, agent); assert.ok(project.available);
    await mkdir(project.memoryDir, { recursive: true });
    const index = join(project.memoryDir, "MEMORY.md");
    await writeFile(index, "- [Topic](topic.md) — INITIAL_INDEX\n");
    await writeFile(join(project.memoryDir, "topic.md"), "body");
    const handlers = new Map<string, any>(); let command: any;
    createMemoryExtension()({ on: (name: string, handler: unknown) => handlers.set(name, handler),
      events: createEventBus(), registerCommand: (_name: string, value: unknown) => { command = value; } } as unknown as ExtensionAPI);
    const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd), ui: { notify() {}, theme: { fg: (_tone: string, text: string) => text } } } as unknown as ExtensionContext;
    await handlers.get("session_start")({}, ctx);
    const read = fs.readFile; let reads = 0;
    t.mock.method(fs, "readFile", (...args: any[]) => {
      if (args[0] === index) reads++;
      return Reflect.apply(read, fs, args);
    });
    syncBuiltinESMExports();
    const results = await Promise.all([command.getArgumentCompletions(""), command.getArgumentCompletions("to"), command.getArgumentCompletions("topic")]);
    assert.equal(reads, 1);
    assert.ok(results.every((items: any[]) => items[0].value === "topic" && !items[0].description.includes("未索引")));
    await writeFile(index, "- [Other](other.md) — CURRENT_INDEX\n");
    assert.match((await command.getArgumentCompletions("to"))[0].description, /未索引/);
    assert.equal(reads, 2);
    const sections: Record<string, string> = {};
    await handlers.get("before_agent_start")({ systemPromptOptions: { sections } }, ctx);
    assert.match(sections.cc_memory_index!, /INITIAL_INDEX/);
    assert.doesNotMatch(sections.cc_memory_index!, /CURRENT_INDEX/);
    assert.equal(reads, 2);
    await rm(index);
    assert.match((await command.getArgumentCompletions("to"))[0].description, /未索引/);
    await writeFile(index, "- [Topic](topic.md) — RECREATED\n");
    assert.ok(!(await command.getArgumentCompletions("to"))[0].description.includes("未索引"));
    assert.equal(reads, 3);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  }
});

test("topic stat errors preserve the cause; only concurrent disappearance is ignored", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-topic-error-"));
  const topic = join(dir, "topic.md");
  const failure = Object.assign(new Error("fixture stat I/O failed"), { code: "EIO" });
  try {
    await writeFile(topic, "body");
    const original = fs.stat;
    t.mock.method(fs, "stat", (...args: any[]) => args[0] === topic ? Promise.reject(failure) : Reflect.apply(original, fs, args));
    syncBuiltinESMExports();
    await assert.rejects(listTopics(dir), (error: unknown) => error === failure);
    assert.equal(await topicCompletions(dir, ""), null, "unavailable candidates are not fabricated");
    failure.code = "ENOENT";
    assert.deepEqual(await listTopics(dir), []);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});
