import assert from "node:assert/strict";
import fs, { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSearchConfig, saveSearchConfig, type SearchConfig } from "../extensions/config.ts";

const config: SearchConfig = { enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-search-config-"));
  return { dir, path: join(dir, "search-config.json"), restore() { rmSync(dir, { recursive: true, force: true }); } };
}

test("missing config defaults, cached reads are isolated, metadata changes reload, canonical save is a no-op", () => {
  const f = fixture();
  try {
    assert.deepEqual(loadSearchConfig(f.dir), config);
    saveSearchConfig(config, f.dir);
    const originalRead = fs.readFileSync;
    let reads = 0;
    const read = test.mock.method(fs, "readFileSync", (...args: any[]) => {
      if (typeof args[0] === "number") reads++;
      return (originalRead as any)(...args);
    });
    syncBuiltinESMExports();
    try {
      loadSearchConfig(f.dir).enabled = false;
      assert.equal(loadSearchConfig(f.dir).enabled, true);
      assert.equal(reads, 0, "save seeds the metadata cache; unchanged lifecycle reads do not read/parse");
      const before = statSync(f.path, { bigint: true });
      saveSearchConfig({ ...config, providerOverrides: {} }, f.dir);
      const after = statSync(f.path, { bigint: true });
      assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
      writeFileSync(f.path, JSON.stringify({ ...config, enabled: false }));
      assert.equal(loadSearchConfig(f.dir).enabled, false); assert.equal(reads, 1);
      assert.equal(loadSearchConfig(f.dir).enabled, false); assert.equal(reads, 1);
      const noncanonical = JSON.stringify({ providerOverrides: { z: { fetchEnabled: true, searchEnabled: false }, a: {} }, fetchEnabled: true, searchEnabled: true, enabled: true });
      writeFileSync(f.path, noncanonical);
      const reordered = loadSearchConfig(f.dir);
      const original = statSync(f.path, { bigint: true });
      saveSearchConfig({ ...reordered, providerOverrides: { a: {}, z: { searchEnabled: false, fetchEnabled: true } } }, f.dir);
      assert.equal(statSync(f.path, { bigint: true }).ino, original.ino);
      assert.equal(statSync(f.path, { bigint: true }).mtimeNs, original.mtimeNs);
      assert.equal(readFileSync(f.path, "utf8"), noncanonical, "canonical equality must not rewrite formatting or key order");
    } finally { read.mock.restore(); syncBuiltinESMExports(); }
  } finally { f.restore(); }
});

test("malformed JSON and schema never enable or overwrite config; unchanged failures reuse the parse", () => {
  const f = fixture();
  try {
    for (const bytes of ["{broken", "null", "[]", '{"enabled":true}', JSON.stringify({ ...config, providerOverrides: { fixture: { searchEnabled: "yes" } } })]) {
      writeFileSync(f.path, bytes);
      let first: unknown;
      try { loadSearchConfig(f.dir); assert.fail("must reject"); } catch (error) { first = error; }
      assert.throws(() => loadSearchConfig(f.dir), error => error === first);
      assert.throws(() => saveSearchConfig(config, f.dir), /Cannot load search config/);
      assert.equal(readFileSync(f.path, "utf8"), bytes);
      assert.ok((first as Error).cause, "retain JSON/schema error");
    }
    writeFileSync(f.path, JSON.stringify(config));
    assert.deepEqual(loadSearchConfig(f.dir), config, "a repaired source recovers after metadata changes");
  } finally { f.restore(); }
});

test("read/inspect/write errors retain context, preserve source, and remove atomic temp files", () => {
  const f = fixture();
  try {
    const bytes = JSON.stringify(config); writeFileSync(f.path, bytes);
    const cause = Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
    const originalRead = fs.readFileSync;
    const read = test.mock.method(fs, "readFileSync", (...args: any[]) => {
      if (typeof args[0] === "number") throw cause;
      return (originalRead as any)(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => loadSearchConfig(f.dir), error => (error as Error).cause === cause);
      assert.throws(() => saveSearchConfig(config, f.dir), error => (error as Error).cause === cause);
    } finally { read.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(f.path, "utf8"), bytes);
    writeFileSync(f.path, `${bytes}\n`); // new metadata retries a formerly unreadable file
    loadSearchConfig(f.dir);
    const rename = test.mock.method(fs, "renameSync", () => { throw cause; });
    syncBuiltinESMExports();
    try {
      assert.throws(() => saveSearchConfig({ ...config, enabled: false }, f.dir), error => (error as Error).cause === cause);
    } finally { rename.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(f.path, "utf8"), `${bytes}\n`);
    assert.deepEqual(readdirSync(f.dir), ["search-config.json"]);
    const notDirectory = join(f.dir, "file"); writeFileSync(notDirectory, "file");
    assert.throws(() => loadSearchConfig(notDirectory), error => ((error as Error).cause as NodeJS.ErrnoException).code === "ENOTDIR");
    rmSync(f.path); mkdirSync(f.path);
    assert.throws(() => loadSearchConfig(f.dir), error => /regular file/.test(String((error as Error).cause)));
    assert.throws(() => saveSearchConfig(config, f.dir), error => /regular file/.test(String((error as Error).cause)));
  } finally { f.restore(); }
});

test("regular-file symlinks can be read but all saves refuse to replace the link", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const target = join(f.dir, "target.json"), bytes = JSON.stringify(config);
    writeFileSync(target, bytes); symlinkSync(target, f.path);
    assert.deepEqual(loadSearchConfig(f.dir), config);
    for (const next of [config, { ...config, enabled: false }]) {
      assert.throws(() => saveSearchConfig(next, f.dir), /refusing to replace a symlink/);
      assert.ok(lstatSync(f.path).isSymbolicLink());
      assert.equal(readFileSync(target, "utf8"), bytes);
    }
    rmSync(target);
    assert.throws(() => loadSearchConfig(f.dir), /Cannot inspect search config/, "a dangling link is not a missing config");
  } finally { f.restore(); }
});

test("save rechecks for a symlink immediately before atomic rename", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const target = join(f.dir, "target.json"), bytes = JSON.stringify(config);
    writeFileSync(f.path, bytes); writeFileSync(target, bytes);
    const originalLstat = fs.lstatSync;
    let checks = 0;
    const lstat = test.mock.method(fs, "lstatSync", (...args: any[]) => {
      if (args[0] === f.path && ++checks === 2) { rmSync(f.path); symlinkSync(target, f.path); }
      return (originalLstat as any)(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => saveSearchConfig({ ...config, enabled: false }, f.dir), error => /refusing to replace a symlink/.test(String((error as Error).cause)));
      assert.ok(checks >= 2, "the pre-rename symlink check must run");
    } finally { lstat.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(lstatSync(f.path).isSymbolicLink());
    assert.equal(readFileSync(target, "utf8"), bytes);
    assert.deepEqual(readdirSync(f.dir).sort(), ["search-config.json", "target.json"]);
  } finally { f.restore(); }
});

test("FIFO paths, including a swap after stat, are rejected in a bounded subprocess", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const fifo = spawnSync("mkfifo", [f.path], { timeout: 5000, encoding: "utf8" });
    assert.equal(fifo.status, 0, String(fifo.error ?? fifo.stderr));
    const regular = join(f.dir, "regular.json"); writeFileSync(regular, JSON.stringify(config));
    const script = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { loadSearchConfig, saveSearchConfig } from ${JSON.stringify(new URL("../extensions/config.ts", import.meta.url).href)};
      const dir = ${JSON.stringify(f.dir)}, path = ${JSON.stringify(f.path)};
      assert.throws(() => loadSearchConfig(dir), error => /regular file/.test(String(error.cause)));
      assert.throws(() => saveSearchConfig(${JSON.stringify(config)}, dir), error => /regular file/.test(String(error.cause)));
      const originalStat = fs.statSync, regular = originalStat(${JSON.stringify(regular)}, { bigint: true });
      let first = true;
      fs.statSync = (...args) => { if (args[0] === path && first) { first = false; return regular; } return originalStat(...args); };
      syncBuiltinESMExports();
      assert.throws(() => loadSearchConfig(dir), error => /regular file/.test(String(error.cause)));
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 5000, encoding: "utf8" });
    assert.equal(child.status, 0, String(child.error ?? child.stderr));
  } finally { f.restore(); }
});
