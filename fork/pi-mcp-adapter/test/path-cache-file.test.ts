import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { canonicalJson, createFileReader, FileReadError } from "../file-version-cache.ts";

test("unchanged files reuse bytes and parsing; external replacements and in-place writes invalidate", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "mcp-file-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cache.json");
  fs.writeFileSync(path, '{"a":1}');
  const originalRead = fs.readFileSync;
  let reads = 0;
  const mock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === path || typeof args[0] === "number") reads++;
    return Reflect.apply(originalRead, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  let parses = 0;
  const read = createFileReader(text => { parses++; return JSON.parse(text); });
  assert.equal(read(path).value.a, 1);
  assert.equal(read(path).value.a, 1);
  assert.equal(reads, 1);
  assert.equal(parses, 1);
  const before = fs.statSync(path);
  const child = spawnSync(process.execPath, ["-e", `const fs=require('node:fs');fs.writeFileSync(process.argv[1],'{"a":2}');fs.utimesSync(process.argv[1],new Date(${before.atimeMs}),new Date(${before.mtimeMs}));`, path]);
  assert.equal(child.status, 0, child.stderr.toString());
  assert.equal(read(path).value.a, 2);
  const replacement = join(dir, "replacement");
  fs.writeFileSync(replacement, '{"a":3}');
  fs.utimesSync(replacement, before.atime, before.mtime);
  fs.renameSync(replacement, path);
  assert.equal(read(path).value.a, 3);
  fs.unlinkSync(path);
  assert.equal(read(path).exists, false);
  fs.writeFileSync(path, '{"a":4}');
  assert.equal(read(path).value.a, 4);
  assert.equal(reads, 4);
  assert.equal(parses, 4);
});

test("missing, malformed and I/O failures stay distinct and do not expose parser input", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "mcp-file-errors-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cache.json");
  let parses = 0;
  const read = createFileReader(text => { parses++; return JSON.parse(text); });
  assert.equal(read(path).exists, false);
  fs.writeFileSync(path, '{"credential":"do-not-print-this" bad}');
  for (let i = 0; i < 2; i++) assert.throws(() => read(path), (error) => {
    assert.ok(error instanceof FileReadError);
    assert.equal(error.kind, "malformed");
    assert.ok(!String(error).includes("do-not-print-this"));
    return true;
  });
  assert.equal(parses, 1);
  assert.throws(() => read(dir), (error) => error instanceof FileReadError && error.kind === "io" && error.code === "EISDIR");
  fs.writeFileSync(path, '{"fixed":true}');
  assert.equal(read(path).value.fixed, true);
});

test("non-regular config files fail without opening or returning stale bytes", (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "mcp-file-kind-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "cache.json");
  const read = createFileReader(text => JSON.parse(text));
  fs.writeFileSync(path, '{"old":true}');
  assert.equal(read(path).value.old, true);
  fs.unlinkSync(path);
  fs.mkdirSync(path);
  assert.throws(() => read(path), (error) => error instanceof FileReadError && error.code === "EISDIR");
  fs.rmdirSync(path);
  if (process.platform !== "win32") {
    const fifo = spawnSync("mkfifo", [path]);
    assert.equal(fifo.status, 0, fifo.stderr.toString());
    assert.throws(() => read(path), (error) => error instanceof FileReadError && error.code === "EINVAL");
    fs.unlinkSync(path);
  }
  fs.writeFileSync(path, '{"new":true}');
  assert.equal(read(path).value.new, true);
});

test("canonical JSON disregards object-key order, not arrays", () => {
  assert.equal(canonicalJson({ b: { d: 1, c: 2 }, a: 3 }), canonicalJson({ a: 3, b: { c: 2, d: 1 } }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});
