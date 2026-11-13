import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStorageLock } from "../src/storage-lock.ts";

// Own file, so no earlier lock in this process has touched the shared module.
test("storage lock keeps proper-lockfile's precision cache off the shared graceful-fs module", async () => {
  // Under the compiled Bun Pi this module is a Proxy; a cache symbol defined on it crashes the next lock.
  const lockRequire = createRequire(createRequire(import.meta.url).resolve("proper-lockfile"));
  const shared = lockRequire("graceful-fs");
  const before = Object.getOwnPropertySymbols(shared).length;
  const directory = await mkdtemp(join(tmpdir(), "pi-perf-lock-"));
  try {
    for (let i = 0; i < 2; i++) await withStorageLock(directory, async () => {});
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.equal(Object.getOwnPropertySymbols(shared).length, before);
});
