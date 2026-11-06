import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MailboxStore, type StoreFaultPoint } from "../src/mailbox-v1/store.js";
import { SlotStorage } from "../src/mailbox-v1/storage.js";
import { parseMailboxSnapshot } from "../src/mailbox-v1/index.js";
import type { PendingRecord, TerminalRecord } from "../src/mailbox-v1/types.js";
import { fulfilledFinalAckLostFixture } from "./fixtures/fulfilled-final-ack-lost.js";

function pending(): PendingRecord {
  return { producer: "pi-mcp-adapter", key: "ui:fixture:1", anchorEntryId: null, policy: "next-request", wake: true,
    messages: [{ customType: "fixture", content: "data", display: false }], acceptedRevision: 1,
    requiredCallbacks: { recorded: false, terminal: true }, branchEntryId: null, nativeEntries: [], recorded: null };
}
function terminal(sessionId: string): TerminalRecord {
  const mail = pending();
  const { acceptedRevision: _accepted, requiredCallbacks, branchEntryId, nativeEntries: _entries, recorded, ...frozen } = mail;
  return { mail: frozen, requiredCallbacks, branchEntryId, recorded, terminalAck: "pending", backingReceiptEntryId: null,
    evidence: { producer: mail.producer, key: mail.key, terminalId: "stable-cancel-token", scope: { sessionId, anchorEntryId: null }, outcome: "cancelled", reason: "fixture cancel" } };
}

test("lazy writer open retries after real EACCES and still shares one successful writer", { skip: process.getuid?.() === 0 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-lazy-open-")), id = randomUUID();
  const storage = new SlotStorage(directory, { id, file: join(directory, "session.jsonl") });
  const writerDirectory = join(directory, "mailbox", "v1", id);
  await mkdir(writerDirectory, { recursive: true });
  try {
    await chmod(writerDirectory, 0o500);
    const attempts = await Promise.allSettled([storage.open(), storage.open()]);
    for (const attempt of attempts) {
      assert.equal(attempt.status, "rejected");
      if (attempt.status === "rejected") assert.equal(attempt.reason.code, "EACCES");
    }
    // No acquired writer remains for shutdown/barrier to revisit after failure.
    await storage.barrier(); await storage.close();
    await chmod(writerDirectory, 0o700);
    const [first, second] = await Promise.all([storage.open(), storage.open()]);
    assert.equal(first, second);
    await storage.transact(draft => { draft.terminal.push(terminal(id)); });
    const snapshot = parseMailboxSnapshot(JSON.parse(await readFile(storage.path, "utf8")));
    assert.equal(snapshot.terminal[0]!.evidence.terminalId, "stable-cancel-token");
  } finally {
    await chmod(writerDirectory, 0o700); await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const point of ["before-write", "before-file-sync", "before-rename", "before-directory-sync", "after-commit"] as const) {
  test(`snapshot failure at ${point} never acknowledges cancel and retry observes old/new complete state`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbox-io-")), id = randomUUID();
    let enabled = false;
    const store = new MailboxStore(directory, { id, file: join(directory, "session.jsonl") }, { at: current => { if (enabled && current === point) throw new Error(`injected ${point}`); } });
    try {
      await store.acquire(); await store.transact(draft => { draft.pending.push(pending()); }); enabled = true;
      await assert.rejects(store.transact(draft => { draft.pending = []; draft.terminal.push(terminal(id)); }), { code: "io-error" });
      const snapshot = parseMailboxSnapshot(JSON.parse(await readFile(store.path, "utf8")));
      assert.equal(snapshot.pending.length + snapshot.terminal.length, 1);
      assert.equal(snapshot.terminal.length, point === "before-directory-sync" || point === "after-commit" ? 1 : 0);
      enabled = false;
      const token = await store.transact(draft => {
        if (!draft.terminal.length) { draft.pending = []; draft.terminal.push(terminal(id)); }
        return draft.terminal[0]!.evidence.terminalId;
      });
      assert.equal(token, "stable-cancel-token");
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("atomic writer lock rejects live second writer and reclaims a positively exited PID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-lock-")), id = randomUUID();
  const identity = { id, file: join(directory, "session.jsonl") };
  const first = new MailboxStore(directory, identity), second = new MailboxStore(directory, identity);
  try {
    await first.acquire(); await assert.rejects(second.acquire(), { code: "writer-conflict" }); await first.close();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const pid = child.pid!; child.kill("SIGKILL"); await exited;
    await symlink(`${pid}:positively-exited-fixture`, first.lockPath);
    await second.acquire(); await second.transact(draft => { draft.pending.push(pending()); });
    assert.equal(second.snapshot.pending.length, 1);
  } finally { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
});

test("schema rejects foreign submitted state, invalid ACK order, missing frozen identity, and lossy JSON", () => {
  const id = randomUUID(), snapshot = { version: 1, session: { id, file: null }, revision: 1, suspended: null, pending: [pending()], terminal: [] };
  assert.equal(parseMailboxSnapshot(snapshot).pending.length, 1);
  assert.throws(() => parseMailboxSnapshot({ ...snapshot, falseBodies: [] }));
  assert.throws(() => parseMailboxSnapshot({ ...snapshot, pending: [{ ...pending(), nativeEntries: [{ messageIndex: 9, entryId: "x" }] }] }));
  assert.throws(() => parseMailboxSnapshot({ ...snapshot, pending: [{ ...pending(), messages: [{ customType: "x", content: "x", display: false, details: { dropped: undefined } }] }] }));
  assert.throws(() => parseMailboxSnapshot({ ...snapshot, terminal: [{ ...terminal(id), mail: undefined }] }));
});

test("parser rejects required terminal ACK before recorded ACK and accepts both valid ACK stages", () => {
  const fixture = fulfilledFinalAckLostFixture(join(tmpdir(), "mailbox-ack-order.jsonl"), tmpdir());
  const terminal = fixture.snapshot.terminal[0]!;
  const pending = { ...terminal, recorded: { ...terminal.recorded!, ack: "pending" as const } };
  assert.doesNotThrow(() => parseMailboxSnapshot({ ...fixture.snapshot, terminal: [pending] }));
  assert.throws(() => parseMailboxSnapshot({ ...fixture.snapshot, terminal: [{ ...pending, terminalAck: "acknowledged" }] }),
    { code: "conflict", message: "terminal ACK cannot precede recorded ACK" });
  assert.doesNotThrow(() => parseMailboxSnapshot({ ...fixture.snapshot, terminal: [{ ...terminal, terminalAck: "acknowledged" }] }));
  assert.doesNotThrow(() => parseMailboxSnapshot({ ...fixture.snapshot,
    terminal: [{ ...pending, requiredCallbacks: { recorded: true, terminal: false }, terminalAck: "acknowledged" }] }));
});

for (const point of ["before-write", "before-file-sync", "before-rename", "before-directory-sync", "after-commit"] as const) {
  test(`SIGKILL at ${point} preserves a complete old/new snapshot and dead-writer recovery`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbox-kill-")), id = randomUUID();
    const identity = { id, file: join(directory, "session.jsonl") }, store = new MailboxStore(directory, identity);
    await store.acquire(); await store.transact(draft => { draft.pending.push(pending()); }); await store.close();
    const module = new URL("../src/mailbox-v1/store.ts", import.meta.url).href;
    const resolver = fileURLToPath(new URL("./ts-resolve.mjs", import.meta.url));
    const code = `import {MailboxStore} from ${JSON.stringify(module)}; const [directory,identity,point,terminal] = process.argv.slice(1); setInterval(()=>{},1000); const store=new MailboxStore(directory,JSON.parse(identity),{at:async current=>{if(current===point){process.stdout.write('CRASHPOINT\\n');await new Promise(()=>{});}}}); await store.acquire(); await store.transact(draft=>{draft.pending=[];draft.terminal.push(JSON.parse(terminal));});`;
    const child = spawn(process.execPath, ["--import", resolver, "--experimental-strip-types", "--input-type=module", "-e", code, directory, JSON.stringify(identity), point, JSON.stringify(terminal(id))], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`crash worker did not reach ${point}: ${stderr}`)), 10000);
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("CRASHPOINT")) { clearTimeout(timeout); resolve(); } });
      child.once("exit", () => { clearTimeout(timeout); if (!stdout.includes("CRASHPOINT")) reject(new Error(stderr || "crash worker exited early")); });
    });
    let recovered: MailboxStore | undefined;
    try {
      await ready; child.kill("SIGKILL"); await exited;
      recovered = new MailboxStore(directory, identity); await recovered.acquire();
      const snapshot = recovered.snapshot;
      assert.equal(snapshot.pending.length + snapshot.terminal.length, 1);
      assert.equal(snapshot.terminal.length, point === "before-directory-sync" || point === "after-commit" ? 1 : 0);
      await recovered.transact(draft => { if (!draft.terminal.length) { draft.pending = []; draft.terminal.push(terminal(id)); } });
      assert.equal(recovered.snapshot.terminal[0]!.evidence.terminalId, "stable-cancel-token");
    } finally { child.kill("SIGKILL"); await exited; await recovered?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
