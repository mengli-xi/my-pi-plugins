import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectMemoryMaterials } from "../src/materials.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createMemoryExtension } from "../index.ts";
import { resolveProject } from "../src/identity.ts";

test("owner selects at most eight indexed topics, ranks relevance and contains symlinks", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-material-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), dir = join(agentDir, "pi-cc-memory", "projects", "a".repeat(64), "memory"); await mkdir(dir, { recursive: true });
  assert.deepEqual(await collectMemoryMaterials(agentDir, dir, ""), { memory: [], known: [] });
  const names = Array.from({ length: 10 }, (_, i) => `topic-${i}.md`);
  await writeFile(join(dir, "MEMORY.md"), names.map(n => `- [${n}](${n})`).join("\n"));
  for (const name of names) await writeFile(join(dir, name), name);
  const selected = await collectMemoryMaterials(agentDir, dir, "topic-9");
  assert.equal(selected.memory.length, 9); assert.ok(selected.memory[1]!.path.endsWith("topic-9.md")); assert.match(selected.known[0]!.statement, /2 indexed/);
  const outside = join(root, "private.md"); await writeFile(outside, "OUTSIDE");
  await rm(join(dir, "topic-9.md")); await symlink(outside, join(dir, "topic-9.md"));
  const escaped = await collectMemoryMaterials(agentDir, dir, "topic-9"); assert.match(escaped.known[0]!.statement, /outside project/); assert.ok(!JSON.stringify(escaped.memory).includes("OUTSIDE"));
  await rm(join(dir, "MEMORY.md")); await symlink(outside, join(dir, "MEMORY.md"));
  assert.equal((await collectMemoryMaterials(agentDir, dir, "")).memory.length, 0);
});

test("public materials request works with no consumer, a stand-in consumer and after session retirement", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-material-protocol-")); t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const handlers = new Map<string, any>(), events = createEventBus();
  createMemoryExtension()({ events, on: (key: string, fn: any) => handlers.set(key, fn), registerCommand() {} } as any);
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => "s", getBranch: () => [] }, ui: { notify() {}, theme: { fg: (_: string, text: string) => text } } };
  await handlers.get("session_start")({}, ctx); // No consumer is normal.
  const project = await resolveProject(root, process.env.PI_CODING_AGENT_DIR!); assert.ok(project.available);
  await writeFile(join(project.memoryDir, "MEMORY.md"), "INDEX_FROM_OWNER");
  const replies: Promise<any>[] = [];
  const request = (sessionId: string) => events.emit("cc-memory:request:materials-v1", { version: 1, sessionId, context: "", reply: (p: any) => replies.push(Promise.resolve(p)) });
  request("other"); assert.equal(replies.length, 0); request("s");
  assert.equal((await replies[0]).memory[0].contents, "INDEX_FROM_OWNER");
  handlers.get("session_shutdown")(); request("s"); assert.equal(replies.length, 1);
});


test("canonical memory directory cannot escape the owner project tree through a symlink", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-root-boundary-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), projects = join(agentDir, "pi-cc-memory", "projects");
  const parent = join(projects, "a".repeat(64)), dir = join(parent, "memory"), outside = join(root, "external");
  await mkdir(parent, { recursive: true }); await mkdir(outside); await writeFile(join(outside, "MEMORY.md"), "OUTSIDE_ROOT");
  await symlink(outside, dir);
  let result = await collectMemoryMaterials(agentDir, dir, "");
  assert.deepEqual(result.memory, []); assert.match(result.known[0]!.statement, /outside owner's project tree/);
  await rm(projects, { recursive: true });
  await mkdir(join(outside, "a".repeat(64), "memory"), { recursive: true });
  await writeFile(join(outside, "a".repeat(64), "memory", "MEMORY.md"), "OUTSIDE_PROJECTS_ROOT");
  await symlink(outside, projects);
  result = await collectMemoryMaterials(agentDir, dir, "");
  assert.deepEqual(result.memory, []); assert.match(result.known[0]!.statement, /outside owner's project tree/);
});


test("a dangling indexed topic records a warning without dropping later topics", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-topic-dangling-")); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "pi-cc-memory", "projects", "a".repeat(64), "memory"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "MEMORY.md"), "[a](a-missing.md)\n[b](b-kept.md)");
  await symlink(join(dir, "nonexistent"), join(dir, "a-missing.md")); await writeFile(join(dir, "b-kept.md"), "KEPT");
  const result = await collectMemoryMaterials(root, dir, "");
  assert.deepEqual(result.memory.map(item => item.contents), ["[a](a-missing.md)\n[b](b-kept.md)", "KEPT"]);
  assert.equal(result.known.length, 1); assert.match(result.known[0]!.statement, /a-missing.md.*ENOENT/);
});

test("deletion after scanning reports the missing topic and continues remaining reads", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-topic-deleted-")); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "pi-cc-memory", "projects", "a".repeat(64), "memory"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "MEMORY.md"), "[a](a-deleted.md)\n[b](b-kept.md)");
  await writeFile(join(dir, "a-deleted.md"), "DELETED"); await writeFile(join(dir, "b-kept.md"), "KEPT");
  const readdir = fs.readdir;
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof readdir>) => {
    const listed = await readdir(...args);
    await rm(join(dir, "a-deleted.md"));
    return listed;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await collectMemoryMaterials(root, dir, "");
  assert.equal(result.memory.at(-1)!.contents, "KEPT"); assert.match(result.known[0]!.statement, /a-deleted.md.*ENOENT/);
});
