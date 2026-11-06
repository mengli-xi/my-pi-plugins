import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMemoryExtension } from "../index.ts";
import { resolveProject } from "../src/identity.ts";

test("session snapshots freeze disk and size notes, follow branch compaction IDs and lifecycle boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-snapshot-"));
  const agent = join(root, "agent"), a = join(root, "a"), b = join(root, "b");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await mkdir(a); await mkdir(b);
    const project = await resolveProject(a, agent);
    assert.ok(project.available);
    await mkdir(project.memoryDir, { recursive: true });
    const writeIndex = (value: string) => writeFile(join(project.memoryDir, "MEMORY.md"), value);
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
    const commands = new Map<string, any>();
    createMemoryExtension()({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler), events: createEventBus(), registerCommand: (name: string, options: unknown) => commands.set(name, options) } as unknown as ExtensionAPI);
    const warnings: string[] = [];
    const manager = SessionManager.inMemory(a);
    const ctx = { cwd: a, sessionManager: manager, ui: { notify: (text: string) => warnings.push(text), theme: { fg: (_tone: string, text: string) => text } } } as unknown as ExtensionContext;
    const emit = async (name: string, event = {}) => handlers.get(name)!(event, ctx);
    const turn = async () => {
      const sections: Record<string, string> = { other_owner: "preserved" };
      await emit("before_agent_start", { systemPromptOptions: { sections } });
      assert.equal(sections.other_owner, "preserved");
      return sections;
    };
    await writeIndex("V1");
    await emit("session_start");
    // This happens before the first turn: session_start, rather than first prompt, owns the snapshot.
    await writeIndex("V2");
    await writeFile(join(project.memoryDir, "large.md"), Buffer.alloc(12289));
    const initial = await turn();
    assert.match(initial.cc_memory_index!, /V1/);
    assert.doesNotMatch(initial.cc_memory_index!, /Oversized topics/);
    for (let i = 0; i < 3; i++) assert.deepEqual(await turn(), initial);
    assert.ok(warnings.some((warning) => warning.includes("超过 12 KiB")));
    assert.equal(warnings.filter((warning) => warning.includes("超过 12 KiB")).length, 1);
    // /memory shows the frozen injected index, while the topic list and bodies come from the disk.
    const memory = commands.get("memory");
    await memory.handler("", ctx);
    assert.ok(warnings.at(-1)!.includes("MEMORY.md：完整注入：1 行 / 2 字节。") && warnings.at(-1)!.includes("Index contents:\nV1") && !warnings.at(-1)!.includes("V2"));
    assert.match(warnings.at(-1)!, /large  12,289 字节  未被 MEMORY.md 引用，超过 12 KiB/);
    assert.deepEqual((await memory.getArgumentCompletions("la")).map((item: { value: string }) => item.value), ["large"]);
    await memory.handler("large", ctx);
    assert.match(warnings.at(-1)!, /^路径：.*large\.md\n大小：12,289 字节/);
    await memory.handler("missing", ctx);
    assert.match(warnings.at(-1)!, /没有主题「missing」。现有主题：large/);

    const anchor = manager.appendMessage({ role: "user", content: "anchor", timestamp: 1 });
    // No session_compact event: matches extensions which call appendCompaction directly.
    const first = manager.appendCompaction("summary", anchor, 1);
    const compacted = await turn();
    assert.match(compacted.cc_memory_index!, /V2/);
    assert.match(compacted.cc_memory_index!, /Oversized topics/);
    assert.equal(compacted.cc_memory_policy, initial.cc_memory_policy);
    await writeIndex("V3");
    await rm(join(project.memoryDir, "large.md"));
    assert.deepEqual(await turn(), compacted);
    const second = manager.appendCompaction("second summary", anchor, 1);
    assert.notEqual(first, second);
    assert.match((await turn()).cc_memory_index!, /V3/);

    await writeIndex("BRANCH");
    manager.branch(anchor);
    const branched = await turn();
    assert.match(branched.cc_memory_index!, /BRANCH/);
    await writeIndex("TREE");
    // A different leaf with the same latest compaction still refreshes on /tree.
    manager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
    manager.branch(anchor);
    await emit("session_tree");
    assert.match((await turn()).cc_memory_index!, /TREE/);
    await writeIndex("RESUME");
    await emit("session_start", { reason: "resume" });
    assert.match((await turn()).cc_memory_index!, /RESUME/);

    await writeIndex("SWITCH");
    ctx.sessionManager = SessionManager.inMemory(a);
    assert.match((await turn()).cc_memory_index!, /SWITCH/);
    ctx.cwd = b;
    assert.match((await turn()).cc_memory_index!, /No index yet/);
    ctx.cwd = a;
    await writeIndex("BACK");
    assert.match((await turn()).cc_memory_index!, /BACK/);
    ctx.cwd = join(root, "gone");
    const failed = await turn();
    assert.equal("cc_memory_index" in failed, false);
    assert.equal("cc_memory_policy" in failed, false);
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  }
});

async function memoryHost() {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-request-"));
  const agent = join(root, "agent"), a = join(root, "a"), b = join(root, "b");
  await mkdir(a); await mkdir(b);
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const events = createEventBus();
  createMemoryExtension()({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler), events, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd: a, sessionManager: SessionManager.inMemory(a), ui: { notify() {}, theme: { fg: (_tone: string, text: string) => text } } } as unknown as ExtensionContext;
  const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  const turn = async () => {
    const sections: Record<string, string> = {};
    await emit("before_agent_start", { systemPromptOptions: { sections } });
    return sections;
  };
  // Pi's own bus: the reply must arrive synchronously inside emit().
  const request = (sessionId: string) => {
    const replies: unknown[] = [];
    events.emit("cc-memory:request:project-v1", { version: 1, sessionId, reply: (value: unknown) => replies.push(value) });
    return replies;
  };
  const cleanup = async () => {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  };
  return { root, agent, a, b, ctx, emit, turn, request, cleanup };
}

test("project request replies with the frozen snapshot directory that was injected", async () => {
  const host = await memoryHost();
  try {
    const sessionId = host.ctx.sessionManager.getSessionId();
    await host.emit("session_start");
    const injected = await host.turn();
    const project = await resolveProject(host.a, host.agent);
    assert.ok(project.available);
    assert.deepEqual(host.request(sessionId), [{ version: 1, sessionId, memoryDir: project.memoryDir, identity: project.identity }]);
    assert.ok(injected.cc_memory_policy!.startsWith(`Project memory: ${project.memoryDir}\n`));

    host.ctx.cwd = host.b;
    const switched = await host.turn();
    const other = await resolveProject(host.b, host.agent);
    assert.ok(other.available);
    assert.deepEqual(host.request(sessionId), [{ version: 1, sessionId, memoryDir: other.memoryDir, identity: other.identity }]);
    assert.ok(switched.cc_memory_policy!.startsWith(`Project memory: ${other.memoryDir}\n`));

    host.ctx.cwd = join(host.root, "gone");
    assert.equal("cc_memory_policy" in await host.turn(), false);
    const [unavailable] = host.request(sessionId) as Array<{ version: number; sessionId: string; memoryDir: null; reason: string }>;
    assert.equal(unavailable!.memoryDir, null);
    assert.equal(unavailable!.sessionId, sessionId);
    assert.match(unavailable!.reason, /无法识别项目/);
  } finally { await host.cleanup(); }
});

test("project request from another session gets no reply", async () => {
  const host = await memoryHost();
  try {
    await host.emit("session_start");
    await host.turn();
    assert.deepEqual(host.request("other-session"), []);
    assert.equal(host.request(host.ctx.sessionManager.getSessionId()).length, 1);
  } finally { await host.cleanup(); }
});
