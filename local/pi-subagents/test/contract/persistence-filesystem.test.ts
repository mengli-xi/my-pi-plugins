import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../src/capabilities/canonical.ts";
import { encodeDomainId, mainKey } from "../../src/domain/ids.ts";
import {
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  ensurePrivateDirectoryChain,
  inspectPrivateFile,
  readPrivateFile,
  UnsafeFilesystemEntryError,
  writePrivateFileExclusive,
} from "../../src/persistence/fs-safe.ts";
import { DiagnosticWriterV1 } from "../../src/persistence/diagnostics.ts";
import { acquireWriterLockV1, ensureMainLayoutDirectoriesV1, StoreLockedError } from "../../src/persistence/lock.ts";
import { diagnosticBaseName, mainStorePaths, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, storePaths } from "../../src/persistence/layout.ts";
import { assertQuotaAdmissionV1, scanProcessStoreQuotaV1 } from "../../src/persistence/quota.ts";

const UID = process.getuid?.();
if (UID === undefined) throw new Error("filesystem tests require POSIX UID");
const PROCESS_NONCE = Buffer.alloc(32, 1).toString("base64url");
const HOST_NONCE = Buffer.alloc(32, 2).toString("base64url");

async function fixture(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-fs-"));
  await chmod(root, PRIVATE_DIR_MODE);
  const agentDir = await ensurePrivateDirectoryChain(root, ["agent"]);
  return { root, agentDir };
}

async function createStore(agentDir: string, sessionId = "main-session") {
  const paths = storePaths(agentDir);
  await ensurePrivateDirectoryChain(agentDir, ["pi-subagents", "store-v2", "mains"]);
  const marker = Buffer.from(`${canonicalJson({ format: "pi-subagents-store", version: 1, install_nonce: Buffer.alloc(32, 3).toString("base64url"), created_at: "2026-08-17T00:00:00.000Z" })}\n`);
  await writePrivateFileExclusive(join(paths.storeRoot, "owner.json"), marker);
  const key = mainKey(sessionId);
  const main = mainStorePaths(paths.mainsRoot, key);
  await ensureMainLayoutDirectoriesV1(main.mainRoot);
  await writePrivateFileExclusive(main.ownerFile, Buffer.from("{}\n"));
  return { paths, key, main };
}

test("private primitives reject symlinks, hardlinks, weak modes and preserve atomic replacement ordering", async (t) => {
  const { root, agentDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const safe = join(agentDir, "safe.json");
  await writePrivateFileExclusive(safe, Buffer.from("old"));
  assert.equal((await readPrivateFile(safe, 16)).toString(), "old");

  const outside = join(root, "outside");
  await writeFile(outside, "outside", { mode: PRIVATE_FILE_MODE });
  const symlinkPath = join(agentDir, "link");
  await symlink(outside, symlinkPath);
  await assert.rejects(readPrivateFile(symlinkPath, 16), UnsafeFilesystemEntryError);

  const hardlinkPath = join(agentDir, "hard");
  await link(safe, hardlinkPath);
  await assert.rejects(inspectPrivateFile(safe), /hard-linked/);
  await rm(hardlinkPath);
  assert.equal((await inspectPrivateFile(safe)).nlink, 1);

  await chmod(safe, 0o644);
  await assert.rejects(readPrivateFile(safe, 16), /0600/);
  await chmod(safe, PRIVATE_FILE_MODE);

  const steps: string[] = [];
  await atomicReplacePrivateFile(safe, Buffer.from("new"), "safe.tmp", {
    fault(step) { steps.push(step); },
  });
  assert.equal((await readFile(safe)).toString(), "new");
  assert.ok(steps.indexOf("after-file-sync") < steps.indexOf("before-rename"));
  assert.ok(steps.indexOf("after-rename") < steps.indexOf("before-dir-sync"));
});

test("atomic replace exposes old or new bytes under injected write/sync/rename failures", async (t) => {
  for (const failure of ["before-write", "before-file-sync", "before-rename", "after-rename", "before-dir-sync"] as const) {
    const { root, agentDir } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(agentDir, `${failure}.json`);
    await writePrivateFileExclusive(path, Buffer.from("old"));
    let fired = false;
    await assert.rejects(atomicReplacePrivateFile(path, Buffer.from("new"), `${failure}.tmp`, {
      fault(step) {
        if (!fired && step === failure) {
          fired = true;
          const error = new Error(`fault:${failure}`) as NodeJS.ErrnoException;
          error.code = failure === "before-write" ? "ENOSPC" : "EIO";
          throw error;
        }
      },
    }), /fault:/);
    assert.ok(["old", "new"].includes((await readFile(path)).toString()));
  }
});

test("writer lock rejects live and EPERM owners, reclaims only ESRCH, and fences stale release", async (t) => {
  const { root, agentDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { main } = await createStore(agentDir);
  const first = await acquireWriterLockV1(main.writerLock, { pid: 111, processNonce: PROCESS_NONCE, hostNonce: HOST_NONCE, kill() {} });
  await assert.rejects(acquireWriterLockV1(main.writerLock, { pid: 222, kill() {} }), StoreLockedError);
  await assert.rejects(acquireWriterLockV1(main.writerLock, {
    pid: 222,
    kill() { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; },
  }), StoreLockedError);
  await first.release();

  const dead = await acquireWriterLockV1(main.writerLock, { pid: 333, processNonce: PROCESS_NONCE, hostNonce: HOST_NONCE, kill() {} });
  const replacement = await acquireWriterLockV1(main.writerLock, {
    pid: 444,
    kill() { const error = new Error("dead") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; },
  });
  await assert.rejects(dead.release(), /stale/);
  await replacement.release();
  await assert.rejects(lstat(main.writerLock), { code: "ENOENT" });
});

test("process quota includes locked, unopened, dormant and corrupt-but-countable stores and rejects unsafe entries", async (t) => {
  const { root, agentDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = await createStore(agentDir, "one");
  const twoKey = mainKey("two");
  const two = mainStorePaths(one.paths.mainsRoot, twoKey);
  await ensureMainLayoutDirectoriesV1(two.mainRoot);
  await writePrivateFileExclusive(two.ownerFile, Buffer.from("corrupt but countable\n"));
  await writePrivateFileExclusive(join(two.journals, "jr_0000000000000001.bin"), Buffer.alloc(8192, 7));
  const lock = await acquireWriterLockV1(one.main.writerLock, { pid: 900, kill() {} });

  const snapshot = await scanProcessStoreQuotaV1(one.paths.storeRoot, { nowMs: () => 42 });
  assert.equal(snapshot.mains.length, 2);
  assert.equal(snapshot.scannedAtMs, 42);
  assert.ok(snapshot.mains.find((item) => item.mainKey === twoKey)!.bytes >= 8192);
  assert.throws(() => assertQuotaAdmissionV1(snapshot, snapshot.totalBytes - 1), /storage-capacity/);
  assert.doesNotThrow(() => assertQuotaAdmissionV1(snapshot, snapshot.totalBytes));

  const unsafe = join(two.mainRoot, "unknown");
  await writePrivateFileExclusive(unsafe, Buffer.from("x"));
  await assert.rejects(scanProcessStoreQuotaV1(one.paths.storeRoot), /unexpected Main store entry/);
  await rm(unsafe);
  const linked = join(two.journals, "jr_0000000000000002.bin");
  await link(join(two.journals, "jr_0000000000000001.bin"), linked);
  await assert.rejects(scanProcessStoreQuotaV1(one.paths.storeRoot), /hard-linked/);
  await lock.release();
});

test("diagnostics write canonical bounded records, rotate four files, maintain age/bytes, and degrade without throwing", async (t) => {
  const { root, agentDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = join(agentDir, "pi-subagents", "diagnostics");
  await ensurePrivateDirectoryChain(agentDir, ["pi-subagents", "diagnostics"]);
  const base = join(diagnostics, diagnosticBaseName(123, "0123456789abcdef"));
  await writePrivateFileExclusive(base, Buffer.alloc(1_048_560, 0x20));
  const writer = new DiagnosticWriterV1(diagnostics, {
    pid: 123,
    processNonce16: "0123456789abcdef",
    now: () => new Date("2026-08-17T00:00:00.000Z"),
  });
  await writer.initialize();
  await writer.write({ severity: "info", code: "started", correlation_id: "c-1", message: "runtime started" });
  assert.ok((await readdir(diagnostics)).includes(`${diagnosticBaseName(123, "0123456789abcdef")}.1`));
  const record = (await readFile(base, "utf8")).trim();
  assert.equal(canonicalJson(JSON.parse(record)), record);
  assert.ok(Buffer.byteLength(record) <= 4096);

  // Repeated rotations retain at most base + .1/.2/.3 for this process.
  for (let index = 0; index < 4; index++) {
    await writeFile(base, Buffer.alloc(1_048_570, 0x20), { mode: PRIVATE_FILE_MODE });
    await writer.write({ severity: "warning", code: `rotate-${index}`, message: "rotation event" });
  }
  const ownFiles = (await readdir(diagnostics)).filter((name) => name.startsWith("diag-123-0123456789abcdef"));
  assert.deepEqual(ownFiles.sort(), [
    "diag-123-0123456789abcdef.jsonl",
    "diag-123-0123456789abcdef.jsonl.1",
    "diag-123-0123456789abcdef.jsonl.2",
    "diag-123-0123456789abcdef.jsonl.3",
  ]);

  const before = (await readFile(base)).byteLength;
  await writer.write({ severity: "error", code: "secret", message: "/Users/private token=abc" });
  assert.equal((await readFile(base)).byteLength, before);
  // 被禁内容只丢这一条记录：sink 本身没坏，健康状态不能因此永久变成 diagnostics-unavailable。
  assert.deepEqual(writer.health(), { degraded: false });
  await writer.write({ severity: "info", code: "after-refusal", message: "still writable" });
  assert.ok((await readFile(base, "utf8")).includes("after-refusal"));
  assert.equal(writer.health().degraded, false);
});

test("diagnostic maintenance deletes only safe expired files and reduces the directory below 32 MiB", async (t) => {
  const { root, agentDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = join(agentDir, "diagnostics");
  await ensurePrivateDirectory(diagnostics);
  const oldOne = join(diagnostics, "diag-2-1111111111111111.jsonl");
  const oldTwo = join(diagnostics, "diag-3-2222222222222222.jsonl");
  await writeFile(oldOne, "", { mode: PRIVATE_FILE_MODE });
  await writeFile(oldTwo, "", { mode: PRIVATE_FILE_MODE });
  await truncate(oldOne, 17 * 1024 * 1024);
  await truncate(oldTwo, 17 * 1024 * 1024);
  const old = new Date("2026-08-01T00:00:00.000Z");
  await utimes(oldOne, old, old);
  await utimes(oldTwo, new Date("2026-08-02T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z"));
  const writer = new DiagnosticWriterV1(diagnostics, {
    pid: 4,
    processNonce16: "3333333333333333",
    now: () => new Date("2026-08-17T00:00:00.000Z"),
  });
  await writer.initialize();
  const remaining = await readdir(diagnostics);
  assert.equal(remaining.includes("diag-2-1111111111111111.jsonl"), false);
  assert.equal(remaining.includes("diag-3-2222222222222222.jsonl"), false);
  assert.equal(writer.health().degraded, false);
});

test("diagnostic maintenance and ENOSPC refuse unsafe writes without surfacing domain failure", async (t) => {
  const { root, agentDir } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = join(agentDir, "diagnostics");
  await ensurePrivateDirectory(diagnostics);
  const outside = join(root, "outside-log");
  await writeFile(outside, "x", { mode: PRIVATE_FILE_MODE });
  await symlink(outside, join(diagnostics, "diag-1-0123456789abcdef.jsonl"));
  const writer = new DiagnosticWriterV1(diagnostics, { pid: 1, processNonce16: "0123456789abcdef" });
  await assert.doesNotReject(writer.initialize());
  await assert.doesNotReject(writer.write({ severity: "error", code: "failed", message: "safe bounded failure" }));
  assert.equal(writer.health().degraded, true);
  assert.equal((await readFile(outside, "utf8")), "x");

  const enospcDir = join(agentDir, "diagnostics-enospc");
  await ensurePrivateDirectory(enospcDir);
  const enospc = new DiagnosticWriterV1(enospcDir, {
    pid: 5,
    processNonce16: "4444444444444444",
    fs: {
      fault(step) {
        if (step === "before-open") {
          const error = new Error("disk full") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        }
      },
    },
  });
  await enospc.initialize();
  await assert.doesNotReject(enospc.write({ severity: "error", code: "disk-full", message: "diagnostic write failed" }));
  assert.deepEqual(enospc.health(), { degraded: true, code: "diagnostics-unavailable" });
});
