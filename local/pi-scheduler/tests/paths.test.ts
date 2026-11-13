import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

async function fixture(t: TestContext, temp = "/fixture-tmp", foreignOwner = false) {
  const root = mkdtempSync(join(tmpdir(), "scheduler-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  t.after(() => { if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous; });
  const privateDir = join(root, "private");
  const fallback = `/tmp/pi-scheduler-${process.getuid!()}`;
  const url = new URL(`../src/paths.ts?fixture=${basename(root)}`, import.meta.url).href;
  // Keep the real filesystem checks inside the test root, never alter /tmp's shared namespace.
  const fs = `data:text/javascript,${encodeURIComponent(`
    export * from "node:fs";
    import { mkdirSync as mkdir, lstatSync as lstat } from "node:fs";
    const map = path => path === ${JSON.stringify(fallback)} ? ${JSON.stringify(privateDir)} : path;
    export const mkdirSync = (path, options) => mkdir(map(path), options);
    export function lstatSync(path) {
      const stat = lstat(map(path));
      return ${foreignOwner} ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 }) : stat;
    }
  `)}`;
  const os = `data:text/javascript,${encodeURIComponent(`export * from "node:os"; export const tmpdir = () => ${JSON.stringify(temp)};`)}`;
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === url && specifier === "node:fs") return { url: fs, shortCircuit: true };
    if (context.parentURL === url && specifier === "node:os") return { url: os, shortCircuit: true };
    return next(specifier, context);
  } });
  try {
    const { schedulerPaths } = await import(url) as typeof import("../src/paths.ts");
    return { paths: () => schedulerPaths("/fixture/profile"), privateDir, fallback, root };
  } finally { hook.deregister(); }
}

const longTemp = "/fixture/" + "long-".repeat(40);

test("socket keeps the original filename in XDG_RUNTIME_DIR or the user's tmpdir", async (t) => {
  const f = await fixture(t);
  assert.equal(dirname(f.paths().socket), "/fixture-tmp");
  assert.match(basename(f.paths().socket), /^pi-scheduler-[0-9a-f]{12}\.sock$/);
  process.env.XDG_RUNTIME_DIR = "/fixture-xdg";
  assert.equal(dirname(f.paths().socket), "/fixture-xdg");
  assert.match(basename(f.paths().socket), /^pi-scheduler-[0-9a-f]{12}\.sock$/);
  process.env.XDG_RUNTIME_DIR = "";
  assert.equal(dirname(f.paths().socket), "/fixture-tmp");
});

test("only overlong socket paths use a private 0700 per-user directory", async (t) => {
  const f = await fixture(t, longTemp);
  assert.equal(dirname(f.paths().socket), f.fallback);
  assert.ok(Buffer.byteLength(f.paths().socket) <= 103);
  assert.equal(lstatSync(f.privateDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.privateDir).uid, process.getuid!());
  process.env.XDG_RUNTIME_DIR = longTemp;
  assert.equal(dirname(f.paths().socket), f.fallback);
});

for (const occupied of ["foreign", "wide", "symlink", "file"]) {
  test(`overlong paths refuse an unsafe private directory: ${occupied}`, async (t) => {
    const f = await fixture(t, longTemp, occupied === "foreign");
    if (occupied === "symlink") {
      mkdirSync(join(f.root, "target"), { mode: 0o700 });
      symlinkSync(join(f.root, "target"), f.privateDir, "dir");
    } else if (occupied === "file") writeFileSync(f.privateDir, "occupied");
    else { mkdirSync(f.privateDir, { mode: 0o700 }); if (occupied === "wide") chmodSync(f.privateDir, 0o777); }
    assert.throws(() => f.paths(), /unsafe.*socket directory/i);
    assert.ok(lstatSync(f.privateDir), "foreign entries are not removed or repaired");
  });
}
