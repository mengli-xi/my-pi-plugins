import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionLogStore, type LogReadOptions } from "../../src/logs/store.ts";
import type { NormalizedLogRecord } from "../../src/logs/normalizer.ts";

const NONCE = "ab".repeat(32);

function record(text: string, options: Partial<NormalizedLogRecord> = {}): NormalizedLogRecord {
  return {
    text,
    terminated: true,
    truncated: false,
    utf8ReplacementBytes: 0,
    ...options,
  };
}

async function fixture(options: { sessionBytes?: number; segmentTargetBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-processes-store-"));
  const store = new SessionLogStore({
    root,
    sessionScopeId: "session-1",
    hostNonce: NONCE,
    sessionBytes: options.sessionBytes ?? 8 * 1024 * 1024,
    segmentTargetBytes: options.segmentTargetBytes ?? 1024,
    now: (() => {
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      return () => new Date(now++);
    })(),
  });
  return { root, store, dispose: () => rm(root, { recursive: true, force: true }) };
}

const READ: LogReadOptions = { stream: "both", limit: 100 };

test("persists normalized records, modes and strict private permissions", async () => {
  const f = await fixture();
  try {
    await f.store.openProcess({ processId: "proc_000000000001", perProcessBytes: 2 * 1024 * 1024 });
    await f.store.append("proc_000000000001", "stdout", record("alpha"));
    await f.store.append("proc_000000000001", "stderr", record("beta", { terminated: false }));
    const page = await f.store.read("proc_000000000001", READ);
    assert.deepEqual(page.lines.map(({ sequence, stream, text, terminated }) => ({ sequence, stream, text, terminated })), [
      { sequence: 1, stream: "stdout", text: "alpha", terminated: true },
      { sequence: 2, stream: "stderr", text: "beta", terminated: false },
    ]);
    const records = join(f.root, "records");
    assert.equal((await stat(f.root)).mode & 0o777, 0o700);
    assert.equal((await stat(records)).mode & 0o777, 0o700);
    for (const file of await readdir(records)) assert.equal((await stat(join(records, file))).mode & 0o777, 0o600);
  } finally { await f.dispose(); }
});

test("rotates and evicts the globally oldest segment across processes", async () => {
  const f = await fixture({ sessionBytes: 1024 * 1024, segmentTargetBytes: 180_000 });
  try {
    for (const id of ["proc_000000000001", "proc_000000000002"]) {
      await f.store.openProcess({ processId: id, perProcessBytes: 2 * 1024 * 1024 });
    }
    const payload = "x".repeat(60_000);
    for (let index = 0; index < 10; index += 1) {
      await f.store.append("proc_000000000001", "stdout", record(`a${index}${payload}`));
    }
    for (let index = 0; index < 10; index += 1) {
      await f.store.append("proc_000000000002", "stdout", record(`b${index}${payload}`));
    }
    const first = await f.store.read("proc_000000000001", READ);
    const second = await f.store.read("proc_000000000002", READ);
    assert.equal(first.truncated, true);
    assert.ok(first.lines.length < 10);
    assert.ok(second.lines.length > 0);
    assert.match(second.lines.at(-1)!.text, /^b9/);
    assert.ok((await f.store.health()).retainedBytes <= 1024 * 1024);
  } finally { await f.dispose(); }
});

test("enforces per-process cap while retaining the newest legal records", async () => {
  const f = await fixture({ segmentTargetBytes: 180_000 });
  try {
    const id = "proc_000000000001";
    await f.store.openProcess({ processId: id, perProcessBytes: 1024 * 1024 });
    const payload = "x".repeat(60_000);
    for (let index = 0; index < 24; index += 1) {
      await f.store.append(id, "stdout", record(`${index}${payload}`));
    }
    const page = await f.store.read(id, READ);
    assert.ok(page.lines[0]!.sequence > 1);
    assert.equal(page.lines.at(-1)!.sequence, 24);
    assert.equal(page.truncated, true);
    assert.ok(page.droppedBytes > 0);
    assert.ok(page.droppedLines > 0);
  } finally { await f.dispose(); }
});

test("authenticates and fences cursors by revision and query fingerprint", async () => {
  const f = await fixture();
  try {
    const id = "proc_000000000001";
    await f.store.openProcess({ processId: id, perProcessBytes: 2 * 1024 * 1024 });
    for (const text of ["one", "two", "three"]) await f.store.append(id, "stdout", record(text));
    const first = await f.store.read(id, { stream: "both", limit: 1, direction: "forward" });
    assert.deepEqual(first.lines.map((line) => line.text), ["one"]);
    assert.ok(first.nextCursor);
    const second = await f.store.read(id, { stream: "both", limit: 1, direction: "forward", cursor: first.nextCursor });
    assert.deepEqual(second.lines.map((line) => line.text), ["two"]);
    await assert.rejects(
      () => f.store.read(id, { stream: "stderr", limit: 1, direction: "forward", cursor: first.nextCursor }),
      /process\/cursor-stale/,
    );
    const tampered = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith("a") ? "b" : "a"}`;
    await assert.rejects(() => f.store.read(id, { stream: "both", limit: 1, direction: "forward", cursor: tampered }), /process\/cursor-stale/);
    await f.store.append(id, "stdout", record("four"));
    await assert.rejects(() => f.store.read(id, { stream: "both", limit: 1, direction: "forward", cursor: first.nextCursor }), /process\/cursor-stale/);
  } finally { await f.dispose(); }
});

test("filters a bounded tail and keeps ascending sequence order", async () => {
  const f = await fixture();
  try {
    const id = "proc_000000000001";
    await f.store.openProcess({ processId: id, perProcessBytes: 2 * 1024 * 1024 });
    await f.store.append(id, "stdout", record("ready one"));
    await f.store.append(id, "stderr", record("ignore"));
    await f.store.append(id, "stdout", record("ready two"));
    const page = await f.store.read(id, { stream: "stdout", limit: 2, pattern: "ready", mode: "literal" });
    assert.deepEqual(page.lines.map((line) => line.text), ["ready one", "ready two"]);
  } finally { await f.dispose(); }
});

test("detects corrupt indexes and truncated JSONL on recovery", async () => {
  const f = await fixture();
  try {
    const id = "proc_000000000001";
    await f.store.openProcess({ processId: id, perProcessBytes: 2 * 1024 * 1024 });
    await f.store.append(id, "stdout", record("ok"));
    const records = join(f.root, "records");
    const segment = (await readdir(records)).find((file) => file.endsWith(".jsonl"))!;
    const source = await readFile(join(records, segment), "utf8");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(records, segment), source.slice(0, -1), { mode: 0o600 }));
    const recovered = new SessionLogStore({ root: f.root, sessionScopeId: "session-1", hostNonce: NONCE, sessionBytes: 8 * 1024 * 1024 });
    await assert.rejects(() => recovered.openProcess({ processId: id, perProcessBytes: 2 * 1024 * 1024 }), /process\/storage-corrupt/);
  } finally { await f.dispose(); }
});

test("clear reports outcomes per captured record and removes successful stores", async () => {
  const f = await fixture();
  try {
    const id = "proc_000000000001";
    await f.store.openProcess({ processId: id, perProcessBytes: 2 * 1024 * 1024 });
    await f.store.append(id, "stdout", record("done"));
    assert.deepEqual(await f.store.clear([id, "proc_000000000002"]), {
      [id]: { cleared: true },
      proc_000000000002: { cleared: false, errorCode: "not-found" },
    });
    await assert.rejects(() => f.store.read(id, READ), /process\/not-found/);
  } finally { await f.dispose(); }
});
