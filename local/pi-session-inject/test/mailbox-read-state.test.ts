import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs, { appendFile, mkdir, mkdtemp, open, rename, rm, stat, truncate, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { filterMailboxMessages } from "../src/mailbox-v1/light.js";
import { MailboxStore } from "../src/mailbox-v1/store.js";
import { SlotStorage } from "../src/mailbox-v1/storage.js";
import { readDiskSession, releaseDiskSession } from "../src/mailbox-v1/proof.js";
import { readVersionedText } from "../src/mailbox-v1/read-version.js";
import { fulfilledFinalAckLostFixture } from "./fixtures/fulfilled-final-ack-lost.js";

async function countReads(t: TestContext, path: string): Promise<() => number> {
  const handle = await open(path, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const original = prototype.readFile;
  let reads = 0;
  t.mock.method(prototype, "readFile", (function(this: FileHandle, ...args: Parameters<FileHandle["readFile"]>) {
    reads++;
    return original.apply(this, args);
  }) as FileHandle["readFile"]);
  return () => reads;
}
const row = (id: string, parentId: string | null) => ({ type: "custom", id, parentId, customType: "fixture", data: {} });
const jsonl = (id: string) => `${JSON.stringify({ type: "session", version: 3, id })}\n`;

test("disk reads coalesce, recheck identity, and release their parsed version", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-read-state-"));
  const identity = { id: "fixture", file: join(directory, "session.jsonl") };
  try {
    await writeFile(identity.file, jsonl(identity.id));
    const reads = await countReads(t, identity.file);
    const [first, concurrent] = await Promise.all([readDiskSession(identity), readDiskSession(identity)]);
    assert.equal(first, concurrent);
    assert.equal(await readDiskSession(identity), first);
    assert.equal(reads(), 1);
    identity.id = "wrong-session";
    await assert.rejects(readDiskSession(identity), { code: "unverifiable-proof" });
    assert.equal(reads(), 1);
    identity.id = "fixture";
    const validated = await readDiskSession(identity);
    releaseDiskSession(identity);
    assert.notEqual(await readDiskSession(identity), validated);
    assert.equal(reads(), 3);
  } finally { releaseDiskSession(identity); await rm(directory, { recursive: true, force: true }); }
});

test("a caller joining a resolved read rechecks the version before returning", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-read-join-"));
  const identity = { id: "fixture", file: join(directory, "session.jsonl") };
  let release = () => {};
  try {
    await writeFile(identity.file, jsonl(identity.id));
    const reads = await countReads(t, identity.file);
    await readDiskSession(identity);
    let reached = () => {};
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    const original = fs.stat;
    let calls = 0;
    const paused = t.mock.method(fs, "stat", (async function(...args: Parameters<typeof fs.stat>) {
      // Pause the first caller's completion check, after its cached read resolves.
      if (++calls === 2) { reached(); await resumed; }
      return original(...args);
    }) as typeof fs.stat);
    syncBuiltinESMExports();
    const first = readDiskSession(identity);
    try {
      await waiting;
      await appendFile(identity.file, `${JSON.stringify(row("a", null))}\n`);
      const joined = await readDiskSession(identity);
      assert.equal(joined!.entries.length, 1);
      release();
      assert.equal(await first, joined);
      assert.equal(reads(), 2);
    } finally {
      release();
      try { await first; } finally { paused.mock.restore(); syncBuiltinESMExports(); }
    }
  } finally { release(); releaseDiskSession(identity); await rm(directory, { recursive: true, force: true }); }
});

test("append, replace, truncate, and a failed parse invalidate disk history", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-read-version-"));
  const identity = { id: "fixture", file: join(directory, "session.jsonl") };
  try {
    const header = jsonl(identity.id);
    await writeFile(identity.file, header);
    const reads = await countReads(t, identity.file);
    const first = await readDiskSession(identity);
    await appendFile(identity.file, `${JSON.stringify(row("a", null))}\n`);
    const appended = await readDiskSession(identity);
    assert.notEqual(appended, first); assert.equal(appended!.entries.length, 1);
    const previous = await stat(identity.file);
    const replacement = `${header}${JSON.stringify(row("b", null))}\n`;
    await writeFile(join(directory, "replacement"), replacement);
    await utimes(join(directory, "replacement"), previous.atime, previous.mtime);
    await rename(join(directory, "replacement"), identity.file);
    const replaced = await readDiskSession(identity);
    assert.notEqual(replaced, appended); assert.equal(replaced!.entries[0]!.id, "b");
    await truncate(identity.file, Buffer.byteLength(header));
    assert.equal((await readDiskSession(identity))!.entries.length, 0);
    await appendFile(identity.file, "{unfinished");
    await assert.rejects(readDiskSession(identity), SyntaxError);
    await writeFile(identity.file, header);
    assert.equal((await readDiskSession(identity))!.entries.length, 0);
    await rm(identity.file);
    assert.equal(await readDiskSession(identity), null);
    assert.equal(reads(), 6);
  } finally { releaseDiskSession(identity); await rm(directory, { recursive: true, force: true }); }
});

test("same-inode equal-size rewrite with restored mtime still invalidates disk history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-read-ctime-"));
  const identity = { id: "fixture", file: join(directory, "session.jsonl") };
  try {
    const header = jsonl(identity.id), timestamp = 1700000000;
    await writeFile(identity.file, `${header}${JSON.stringify(row("a", null))}\n`);
    await utimes(identity.file, timestamp, timestamp);
    const first = await readDiskSession(identity), before = await stat(identity.file, { bigint: true });
    await writeFile(identity.file, `${header}${JSON.stringify(row("b", null))}\n`);
    await utimes(identity.file, timestamp, timestamp);
    const after = await stat(identity.file, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs"] as const) assert.equal(after[field], before[field]);
    assert.notEqual(after.ctimeNs, before.ctimeNs);
    const rewritten = await readDiskSession(identity);
    assert.notEqual(rewritten, first); assert.equal(rewritten!.entries[0]!.id, "b");
  } finally { releaseDiskSession(identity); await rm(directory, { recursive: true, force: true }); }
});

test("a changing read is rejected before parsing and can be retried", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-read-changing-"));
  const identity = { id: "fixture", file: join(directory, "session.jsonl") };
  try {
    await writeFile(identity.file, jsonl(identity.id));
    const handle = await open(identity.file, "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const original = prototype.readFile;
    const race = t.mock.method(prototype, "readFile", (async function(this: FileHandle, ...args: Parameters<FileHandle["readFile"]>) {
      await appendFile(identity.file, `${JSON.stringify(row("a", null))}\n`);
      return original.apply(this, args);
    }) as FileHandle["readFile"]);
    await assert.rejects(readDiskSession(identity), { code: "unverifiable-proof" });
    race.mock.restore();
    assert.equal((await readDiskSession(identity))!.entries.length, 1);
  } finally { releaseDiskSession(identity); await rm(directory, { recursive: true, force: true }); }
});

test("snapshot acquisition reads once; writes and unchanged transactions reuse it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-snapshot-state-"));
  const fixture = fulfilledFinalAckLostFixture(join(directory, "session.jsonl"), directory);
  const storage = new SlotStorage(directory, fixture.snapshot.session, () => { acquired++; });
  let acquired = 0;
  try {
    await mkdir(dirname(storage.path), { recursive: true });
    await writeFile(storage.path, JSON.stringify(fixture.snapshot));
    const reads = await countReads(t, storage.path);
    await storage.acquire();
    assert.equal(acquired, 1); assert.equal(reads(), 1);
    const first = storage.snapshot;
    await storage.transact(() => {});
    assert.equal(storage.snapshot, first); assert.equal(reads(), 1);
    await storage.transact(draft => { draft.terminal[0] = { ...draft.terminal[0]!, terminalAck: "acknowledged" }; });
    const committed = storage.snapshot;
    assert.notEqual(committed, first);
    assert.equal(await (await storage.open()).read(), committed); assert.equal(reads(), 1);
    await writeFile(storage.path, JSON.stringify({ ...committed, revision: committed.revision + 1 }));
    await storage.transact(() => {});
    assert.equal(storage.snapshot.revision, committed.revision + 1); assert.equal(reads(), 2);
    await storage.close();
    // The metadata is unchanged, but no writer lock remains to justify reuse.
    assert.notEqual(await (await storage.open()).read(), storage.snapshot); assert.equal(reads(), 3);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});

test("same-inode rewrite during commit cannot label our snapshot with external metadata", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-snapshot-rewritten-"));
  const fixture = fulfilledFinalAckLostFixture(join(directory, "session.jsonl"), directory);
  let rewrite = false;
  const store: MailboxStore = new MailboxStore(directory, fixture.snapshot.session, { at: async point => {
    if (!rewrite || point !== "before-directory-sync") return;
    rewrite = false;
    const before = await stat(store.path, { bigint: true });
    await writeFile(store.path, `${JSON.stringify({ ...fixture.snapshot, revision: fixture.snapshot.revision + 1,
      suspended: { reason: "blocked", detail: "them" } })}\n`);
    await utimes(store.path, 1700000000, 1700000000);
    const after = await stat(store.path, { bigint: true });
    for (const field of ["dev", "ino", "size"] as const) assert.equal(after[field], before[field]);
    assert.notEqual(after.mtimeNs, before.mtimeNs);
  } });
  try {
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.path, JSON.stringify(fixture.snapshot));
    const reads = await countReads(t, store.path);
    await store.acquire(); rewrite = true;
    await store.transact(draft => { draft.suspended = { reason: "blocked", detail: "ours" }; });
    assert.equal(store.snapshot.suspended!.detail, "ours"); assert.equal(reads(), 1);
    assert.equal(await store.transact(draft => draft.suspended?.detail), "them");
    assert.equal(store.snapshot.suspended!.detail, "them"); assert.equal(reads(), 2);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("uncertain commit forces reread even when the committed file has not changed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-snapshot-uncertain-"));
  const fixture = fulfilledFinalAckLostFixture(join(directory, "session.jsonl"), directory);
  let fail = false;
  const store = new MailboxStore(directory, fixture.snapshot.session, { at: point => { if (fail && point === "after-commit") throw new Error("uncertain commit"); } });
  try {
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.path, JSON.stringify(fixture.snapshot));
    const reads = await countReads(t, store.path);
    await store.acquire(); fail = true;
    await assert.rejects(store.transact(draft => { draft.terminal[0] = { ...draft.terminal[0]!, terminalAck: "acknowledged" }; }), { code: "io-error" });
    const committed = store.snapshot;
    fail = false;
    await store.transact(() => {});
    assert.equal(store.snapshot.revision, committed.revision);
    assert.notEqual(store.snapshot, committed); assert.equal(reads(), 2);
    await rm(store.path);
    await assert.rejects(store.transact(() => {}), { code: "unverifiable-proof" });
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("readonly snapshot and session checks reuse each unchanged file once", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-readonly-state-"));
  const fixture = fulfilledFinalAckLostFixture(join(directory, "session.jsonl"), directory);
  const path = join(directory, "mailbox", "v1", fixture.snapshot.session.id, "pending.json");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(fixture.snapshot));
    await writeFile(fixture.snapshot.session.file!, fixture.sessionEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const manager = SessionManager.open(fixture.snapshot.session.file!);
    const messages = fixture.mail.messages.map(message => ({ role: "custom" as const, ...message, timestamp: 0 }));
    const reads = await countReads(t, path);
    await filterMailboxMessages({ sessionManager: manager, cwd: directory }, messages, { agentDir: directory });
    assert.equal(reads(), 2, "snapshot and session each read once, including final snapshot check");
    await filterMailboxMessages({ sessionManager: manager, cwd: directory }, messages, { agentDir: directory });
    assert.equal(reads(), 2);
    await writeFile(path, JSON.stringify({ ...fixture.snapshot, revision: fixture.snapshot.revision + 1 }));
    await filterMailboxMessages({ sessionManager: manager, cwd: directory }, messages, { agentDir: directory });
    assert.equal(reads(), 3, "changed snapshot is refreshed without rereading the unchanged session");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a path replacement during a read cannot be accepted as the opened inode", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-read-replace-")), path = join(directory, "proof");
  try {
    await writeFile(path, "original"); await writeFile(join(directory, "next"), "replaced");
    const handle = await open(path, "r"), prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const original = prototype.readFile;
    t.mock.method(prototype, "readFile", (async function(this: FileHandle, ...args: Parameters<FileHandle["readFile"]>) {
      await rename(join(directory, "next"), path);
      return original.apply(this, args);
    }) as FileHandle["readFile"]);
    await assert.rejects(readVersionedText(path), { code: "unverifiable-proof" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
