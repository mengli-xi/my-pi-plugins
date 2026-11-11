import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { resolvePiBinary } from "../src/pi-binary.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scheduler-pi-entry-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, "package");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  const cli = join(packageDir, "dist", "cli.js");
  writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o700 });
  const manifest = (bin: unknown = { pi: "dist/cli.js" }, name = "@earendil-works/pi-coding-agent") =>
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, bin }));
  manifest();
  return { root, packageDir, cli, manifest };
}

test("compiled Bun Pi keeps its actual executable, not the script bin metadata", (t) => {
  const f = fixture(t), binary = join(f.packageDir, "pi");
  writeFileSync(binary, "compiled fixture", { mode: 0o700 });
  assert.equal(resolvePiBinary({ execPath: binary, packageDir: f.packageDir, bun: true }), binary);
});

for (const bun of [false, true]) test(`${bun ? "Bun" : "Node"} script host resolves the public Pi bin, not the runtime or SDK caller`, (t) => {
  const f = fixture(t);
  assert.equal(resolvePiBinary({ execPath: process.execPath, packageDir: f.packageDir, bun }), f.cli);
});

test("explicit override wins before package discovery and resolves relative paths/symlinks", (t) => {
  const f = fixture(t), link = join(f.root, "override");
  symlinkSync(f.cli, link);
  assert.equal(resolvePiBinary({ execPath: "/missing-runtime", packageDir: "/missing-package", bun: false, override: ` ${link} ` }), f.cli);
  assert.equal(resolvePiBinary({ execPath: "/missing-runtime", packageDir: "/missing-package", bun: false, override: relative(process.cwd(), link) }), f.cli);
});

test("unknown SDK embedding fails closed without public Pi bin evidence", (t) => {
  const f = fixture(t), host = { execPath: process.execPath, packageDir: f.packageDir, bun: false };
  for (const bin of [undefined, {}, { pi: "../caller.js" }, { pi: "/arbitrary/caller.js" }, { pi: "dist/missing.js" }]) {
    f.manifest(bin === undefined ? null : bin);
    assert.throws(() => resolvePiBinary(host), /Cannot resolve an executable Pi CLI/);
  }
  f.manifest({ pi: "dist/cli.js" }, "sdk-caller");
  assert.throws(() => resolvePiBinary(host), /Cannot resolve an executable Pi CLI/);
  f.manifest();
  assert.equal(resolvePiBinary(host), f.cli, "known public bin permits SDK fallback without using its caller script");
});
