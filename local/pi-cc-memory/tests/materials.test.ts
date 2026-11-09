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
  const dir = join(root, "memory"); await mkdir(dir);
  assert.deepEqual(await collectMemoryMaterials(dir, ""), { memory: [], known: [] });
  const names = Array.from({ length: 10 }, (_, i) => `topic-${i}.md`);
  await writeFile(join(dir, "MEMORY.md"), names.map(n => `- [${n}](${n})`).join("\n"));
  for (const name of names) await writeFile(join(dir, name), name);
  const selected = await collectMemoryMaterials(dir, "topic-9");
  assert.equal(selected.memory.length, 9); assert.ok(selected.memory[1]!.path.endsWith("topic-9.md")); assert.match(selected.known[0]!.statement, /2 indexed/);
  const outside = join(root, "private.md"); await writeFile(outside, "OUTSIDE");
  await rm(join(dir, "topic-9.md")); await symlink(outside, join(dir, "topic-9.md"));
  const escaped = await collectMemoryMaterials(dir, "topic-9"); assert.match(escaped.known[0]!.statement, /outside project/); assert.ok(!JSON.stringify(escaped.memory).includes("OUTSIDE"));
  await rm(join(dir, "MEMORY.md")); await symlink(outside, join(dir, "MEMORY.md"));
  assert.equal((await collectMemoryMaterials(dir, "")).memory.length, 0);
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
