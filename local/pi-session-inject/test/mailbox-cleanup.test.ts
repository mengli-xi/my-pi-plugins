import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readlink, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MailboxStore, listRecoveryTargets } from "../src/mailbox-v1/store.js";
import { snapshotPath } from "../src/mailbox-v1/paths.js";
import { MAILBOX_HOLDER_KEY } from "../src/mailbox-v1/light.js";
import type { PendingRecord } from "../src/mailbox-v1/types.js";
import { harness, until } from "./mailbox-harness.js";

function pending(key: string): PendingRecord {
  return { producer: "pi-processes", key, anchorEntryId: null, policy: "next-request", wake: false,
    messages: [{ customType: "cleanup-body", content: key, display: false }], acceptedRevision: 1,
    requiredCallbacks: { recorded: false, terminal: false }, branchEntryId: null, nativeEntries: [], recorded: null };
}
for (const outcome of ["fulfilled", "cancelled"] as const) test(`${outcome} GC removes the snapshot and directory, receipt dedupes and new mail recreates storage`, async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const p = h.producer("pi-processes"); await h.emit("session_start", { reason: "startup" });
    const mail = h.mail("pi-processes", "cleaned-key", { wake: false }); await p.endpoint.put(mail);
    await until(() => h.sends.length === 1);
    if (outcome === "fulfilled") { await h.startUser(); await h.context(); await h.finish(); }
    else await p.endpoint.cancel(mail.key, "fixture cancelled");
    const path = snapshotPath(h.agentDir, h.manager.getSessionId());
    await until(() => !existsSync(dirname(path)), "GC removes the entire session directory");
    const result = await p.endpoint.put(mail); assert.equal(result.kind, "terminal");
    if (result.kind !== "terminal") throw Error("expected terminal");
    assert.equal(result.evidence.outcome, outcome);
    assert.deepEqual(await p.endpoint.cancel(mail.key, "retry"), result.evidence);
    assert.equal(h.sends.length, 1); assert.equal(existsSync(dirname(path)), false);
    assert.deepEqual(await listRecoveryTargets(h.agentDir), []);
    await h.commands.get("mailbox")!.definition.handler("status", h.ctx as any);
    assert.ok(h.notices.at(-1)?.includes("0 pending"));
    await p.endpoint.put(h.mail("pi-processes", "new-key", { wake: false }));
    assert.equal(JSON.parse(await readFile(path, "utf8")).pending[0].key, "new-key");
    assert.match(await readlink(join(dirname(path), "writer.lock")), new RegExp(`^${process.pid}:`));
  } finally { await h.cleanup(); }
});

for (const reason of ["pending", "terminal", "attempt", "suspended"] as const) test(`cleanup retains ${reason} obligations`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-cleanup-retain-"));
  const store = new MailboxStore(directory, { id: "retained", file: join(directory, "session.jsonl") });
  try {
    await store.acquire();
    await store.transact(draft => {
      if (reason === "pending") draft.pending.push(pending("unproved"));
      if (reason === "attempt") draft.attempt = { id: "sealed", members: [], sealedRevision: 1 };
      if (reason === "suspended") draft.suspended = { reason: "blocked", detail: "unverifiable" };
      if (reason === "terminal") {
        const { acceptedRevision, requiredCallbacks, branchEntryId, nativeEntries, recorded, ...mail } = pending("ack-debt");
        draft.terminal.push({ mail, requiredCallbacks: { ...requiredCallbacks, terminal: true }, branchEntryId, recorded, terminalAck: "pending", backingReceiptEntryId: null,
          evidence: { producer: mail.producer, key: mail.key, terminalId: "retained-terminal", scope: { sessionId: "retained", anchorEntryId: null }, outcome: "cancelled", reason: "source not acknowledged" } });
      }
    });
    assert.ok(existsSync(store.path));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const point of ["before-unlink", "after-unlink", "before-rmdir", "after-rmdir"] as const)
  test(`a queued put after ${point} cannot be removed by cleanup`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbox-cleanup-queue-"));
    let enabled = false, entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: MailboxStore = new MailboxStore(directory, { id: "queued", file: join(directory, "session.jsonl") }, { at: async current => {
      if (current === "before-write") assert.equal(await readlink(store.lockPath), store.owner, "every write owns the writer token");
      if (enabled && current === point) { entered = true; await gate; }
    } });
    try {
      await store.acquire(); await store.transact(draft => { draft.pending.push(pending("old")); }); enabled = true;
      const cleanup = store.transact(draft => { draft.pending = []; }); await until(() => entered);
      const put = store.transact(draft => { draft.pending.push(pending("new")); });
      enabled = false; release(); await Promise.all([cleanup, put]);
      assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")).pending.map((record: any) => record.key), ["new"]);
      assert.equal(await readlink(store.lockPath), store.owner);
    } finally { release(); await store.close(); await rm(directory, { recursive: true, force: true }); }
  });

for (const mode of ["writer-before-rmdir", "mkdir-before-rmdir"] as const)
  test(`another process put interleaves with cleanup: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbox-cleanup-process-"));
    const identity = { id: "interleaved", file: join(directory, "session.jsonl") };
    let enabled = false, entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = new MailboxStore(directory, identity, { at: async point => { if (enabled && point === "before-rmdir") { entered = true; await gate; } } });
    let child: ReturnType<typeof fork> | undefined, exited: Promise<number | null> | undefined;
    try {
      await store.acquire(); await store.transact(draft => { draft.pending.push(pending("old")); }); enabled = true;
      const cleanup = store.transact(draft => { draft.pending = []; }); await until(() => entered);
      const messages: any[] = [];
      child = fork(fileURLToPath(new URL("./cleanup-race-child.ts", import.meta.url)), [directory, JSON.stringify(identity), mode, JSON.stringify(pending("other-process"))], {
        execArgv: ["--import", fileURLToPath(new URL("./ts-resolve.mjs", import.meta.url)), "--experimental-strip-types"], silent: true,
        env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1" },
      });
      let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; }); child.on("message", message => { messages.push(message); });
      exited = new Promise(resolve => child!.once("exit", code => resolve(code)));
      await until(() => messages.some(message => message.stage === (mode === "mkdir-before-rmdir" ? "before-lock" : "written")), "second process boundary");
      enabled = false; release(); await cleanup;
      if (mode === "mkdir-before-rmdir") child.send("acquire");
      await until(() => messages.some(message => message.stage === "written"));
      assert.equal(messages.find(message => message.stage === "written").attempts, mode === "mkdir-before-rmdir" ? 2 : 1);
      await assert.rejects(store.transact(draft => { draft.pending.push(pending("must-not-write")); }), { code: "writer-conflict" });
      assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")).pending.map((record: any) => record.key), ["other-process"]);
      child.send("close"); assert.equal(await exited, 0, stderr);
      await store.transact(draft => { draft.pending.push(pending("after-owner-exit")); });
      assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")).pending.map((record: any) => record.key), ["other-process", "after-owner-exit"]);
    } finally { release(); child?.kill("SIGKILL"); await exited; await store.close(); await rm(directory, { recursive: true, force: true }); }
  });

test("reacquiring after cleanup cold-holds a different writer's pending while accepting new local mail", async () => {
  const h = await harness({ persist: true });
  try {
    await h.finish();
    const p = h.producer("pi-processes", { checkCurrent: () => ({ kind: "allow", project: true, wake: false }) });
    await h.emit("session_start", { reason: "startup" });
    const first = h.mail("pi-processes", "first", { wake: false }); await p.endpoint.put(first);
    await until(() => h.sends.length === 1); await p.endpoint.cancel(first.key, "done");
    const path = snapshotPath(h.agentDir, h.manager.getSessionId()); await until(() => !existsSync(dirname(path)));
    const foreign = new MailboxStore(h.agentDir, { id: h.manager.getSessionId(), file: h.manager.getSessionFile()!, cwd: h.cwd });
    await foreign.acquire();
    const old = h.mail("pi-processes", "other-writer", { wake: false });
    await foreign.transact(draft => { draft.pending.push({ ...old, acceptedRevision: 1, requiredCallbacks: { recorded: false, terminal: false }, branchEntryId: null, nativeEntries: [], recorded: null }); });
    await foreign.close();
    await p.endpoint.put(h.mail("pi-processes", "new-local", { wake: false }));
    const slot = [...(globalThis as any)[Symbol.for(MAILBOX_HOLDER_KEY)].slots.values()][0];
    await until(() => slot.snapshot.pending.find((record: any) => record.key === "new-local").nativeEntries.length === 1);
    assert.equal(slot.recoveryHeld, true);
    assert.equal(slot.snapshot.pending.find((record: any) => record.key === old.key).nativeEntries.length, 0);
    assert.equal(slot.snapshot.pending.find((record: any) => record.key === "new-local").nativeEntries.length, 1);
    assert.equal(slot.snapshot.pending.length, 2);
  } finally { await h.cleanup(); }
});

test("directory removal during every lock attempt stops at the retry bound and never writes unlocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-cleanup-bound-"));
  let attempts = 0;
  const store: MailboxStore = new MailboxStore(directory, { id: "bounded", file: join(directory, "session.jsonl") }, { at: async point => {
    if (point === "before-lock") { attempts++; await rmdir(store.directory); }
    if (point === "before-write") assert.fail("no write may run without a lock");
  } });
  try {
    await assert.rejects(store.transact(draft => { draft.pending.push(pending("never-written")); }), { code: "writer-conflict" });
    assert.equal(attempts, 8); assert.equal(existsSync(store.path), false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
