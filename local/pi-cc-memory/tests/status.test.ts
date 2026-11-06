import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMemoryExtension } from "../index.ts";
import { resolveProject } from "../src/identity.ts";
import { memoryStatusLine, memoryStatusPayload } from "../src/status.ts";

const paint = (tone: string, text: string) => `<${tone}>${text}</${tone}>`;

test("MEM shows the topic count, 0 included; a warning paints MEM:N! and an unknown count reads MEM:?!", () => {
  assert.equal(memoryStatusLine({ topics: 0, warn: false }, paint), "<dim>MEM:0</dim>");
  assert.equal(memoryStatusLine({ topics: 5, warn: true }, paint), "<warning>MEM:5!</warning>");
  assert.equal(memoryStatusLine({ warn: true }, paint), "<warning>MEM:?!</warning>");
  const onClick = () => true;
  assert.deepEqual(memoryStatusPayload("MEM:0", onClick), { key: "memory", line: "MEM:0", placement: "inline", row: 2, align: "left", order: 20, onClick });
});

test("the segment follows session start, branch changes and each turn's scan; a click opens /memory; shutdown withdraws", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-status-"));
  const agent = join(root, "agent"), cwd = join(root, "cwd");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await mkdir(cwd);
    const project = await resolveProject(cwd, agent);
    assert.ok(project.available);
    await mkdir(project.memoryDir, { recursive: true });
    await writeFile(join(project.memoryDir, "MEMORY.md"), "- [A](a.md) — a\n");
    await writeFile(join(project.memoryDir, "a.md"), "A");
    const events = createEventBus(), rows: Array<{ key: string; line?: string; placement?: string; row?: number; align?: string; onClick?: () => boolean }> = [];
    events.on("statusline:row", (payload) => rows.push(payload as (typeof rows)[number]));
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>(), commands = new Map<string, any>();
    createMemoryExtension()({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), events, registerCommand: (name: string, options: unknown) => commands.set(name, options) } as unknown as ExtensionAPI);
    const notices: string[] = [];
    const ctx = { cwd, mode: "rpc", hasUI: false, sessionManager: SessionManager.inMemory(cwd), ui: { notify: (text: string) => notices.push(text), theme: { fg: paint } } } as unknown as ExtensionContext;
    const emit = async (name: string, event: object = {}) => handlers.get(name)!(event, ctx);
    const turn = () => emit("before_agent_start", { systemPromptOptions: { sections: {} } });
    const latest = () => rows.at(-1)!;

    await emit("session_start");
    assert.deepEqual([latest().key, latest().line, latest().placement, latest().row, latest().align], ["memory", "<dim>MEM:1</dim>", "inline", 2, "left"]);
    await writeFile(join(project.memoryDir, "b.md"), "B");
    await turn();
    assert.equal(latest().line, "<dim>MEM:2</dim>", "the next turn's scan counts the written topic");
    await writeFile(join(project.memoryDir, "big.md"), "x".repeat(12 * 1024 + 1));
    await turn();
    assert.equal(latest().line, "<warning>MEM:3!</warning>", "a topic over 12 KiB warns");
    await rm(join(project.memoryDir, "big.md"));
    await writeFile(join(project.memoryDir, "MEMORY.md"), Array.from({ length: 205 }, (_, i) => `- line ${i}`).join("\n"));
    await turn();
    assert.equal(latest().line, "<dim>MEM:2</dim>", "the frozen snapshot still holds the complete index");
    await emit("session_tree");
    assert.equal(latest().line, "<warning>MEM:2!</warning>", "a refreshed snapshot with a truncated index warns");

    // A click opens exactly what /memory opens.
    const before = notices.length;
    assert.equal(latest().onClick!(), true);
    for (const start = Date.now(); notices.length === before; await new Promise((r) => setTimeout(r, 5))) if (Date.now() - start > 5000) throw new Error("timeout");
    const clicked = notices.at(-1)!;
    await commands.get("memory").handler("", ctx);
    assert.equal(notices.at(-1), clicked);
    assert.match(clicked, /注入给模型的索引段/);

    await rm(join(project.memoryDir, "MEMORY.md"));
    await mkdir(join(project.memoryDir, "MEMORY.md"));
    await emit("session_tree");
    assert.equal(latest().line, "<warning>MEM:2!</warning>", "an unreadable index was not injected either");
    await rm(join(project.memoryDir, "MEMORY.md"), { recursive: true });
    await emit("session_tree");
    assert.equal(latest().line, "<dim>MEM:2</dim>", "a missing index is normal before the first topic is saved");

    (ctx as { cwd: string }).cwd = join(root, "gone");
    await turn();
    assert.equal(latest().line, "<warning>MEM:?!</warning>", "nothing injected this session");

    const click = latest().onClick!;
    await emit("session_shutdown");
    assert.deepEqual([latest().key, latest().line], ["memory", undefined]);
    assert.equal(click(), false, "a click left from the replaced session does nothing");
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  }
});
