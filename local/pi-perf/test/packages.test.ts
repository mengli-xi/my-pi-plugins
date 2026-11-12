import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extensionArguments, processPackageInventory, resolvePackageNames } from "../src/packages.ts";
import { packageHash } from "../src/history.ts";

test("CLI extension forms share parsing and package identities use manifests, not local paths", async () => {
  assert.deepEqual(extensionArguments(["pi", "-e", "one", "--extension", "two", "--extension=three", "--model=x"]), ["one", "two", "three"]);
  const root = await mkdtemp(join(tmpdir(), "perf-packages-"));
  try {
    for (const path of ["private-alice/pkg", "private-bob/pkg"]) {
      await mkdir(join(root, path, "src"), { recursive: true });
      await writeFile(join(root, path, "package.json"), JSON.stringify({ name: "@scope/plugin" }));
      await writeFile(join(root, path, "src/index.ts"), "");
    }
    const a = await resolvePackageNames(["private-alice/pkg/src/index.ts", "builtin:mcp", "/missing/username/plugin"], root);
    const b = await resolvePackageNames(["private-bob/pkg", "private-alice/pkg"], root);
    assert.deepEqual(a, ["local"]); assert.deepEqual(b, ["@scope/plugin"]);
    assert.equal(packageHash(await resolvePackageNames(["private-alice/pkg"], root)), packageHash(b));
    assert.equal(packageHash(["b", "a", "a"]), packageHash(["a", "b"]));
    assert.doesNotMatch(JSON.stringify({ packages: a, hash: packageHash(a) }), /private|alice|bob/);
    await mkdir(join(root, "invalid")); await writeFile(join(root, "invalid/package.json"), '{"name":"/Users/name/private"}');
    assert.deepEqual(await resolvePackageNames(["invalid"], root), ["local"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("single-file extensions never read a parent project manifest; process inventory is keyed by sources and cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-private-project-"));
  Reflect.deleteProperty(globalThis, Symbol.for("pi.perf.package-inventory.v1"));
  try {
    await writeFile(join(root, "package.json"), '{"name":"secret-internal-project"}');
    await mkdir(join(root, ".pi/extensions"), { recursive: true });
    await writeFile(join(root, "x.ts"), ""); await writeFile(join(root, ".pi/extensions/x.ts"), "");
    assert.deepEqual(await resolvePackageNames(["x.ts", ".pi/extensions/x.ts", ".pi/extensions"], root), ["local"]);
    const first = processPackageInventory(["x.ts"], root);
    let resolved = false; void first.then(() => { resolved = true; });
    await Promise.resolve(); assert.equal(resolved, false, "resolution starts on a later event-loop turn");
    const result = await first;
    assert.deepEqual(result.names, ["local"]); assert.ok(result.durationMs >= 0);
    const again = processPackageInventory(["x.ts"], root); assert.equal(again, first);
    assert.deepEqual((await again).names, ["local"]);
    const changed = processPackageInventory([root], root); assert.notEqual(changed, first);
    assert.deepEqual((await changed).names, ["secret-internal-project"], "an explicitly selected root is a different inventory");
    const moved = processPackageInventory([root], join(root, ".pi")); assert.notEqual(moved, changed);
  } finally { Reflect.deleteProperty(globalThis, Symbol.for("pi.perf.package-inventory.v1")); await rm(root, { recursive: true, force: true }); }
});

test("measure asynchronous explicit-root manifest resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-inventory-time-"));
  try {
    const roots = Array.from({ length: 32 }, (_, i) => join(root, `package-${i}`));
    for (let i = 0; i < roots.length; i++) { await mkdir(roots[i]); await writeFile(join(roots[i], "package.json"), JSON.stringify({ name: `plugin-${i}` })); }
    const durations: number[] = [];
    for (let i = 0; i < 8; i++) {
      const start = performance.now(); const names = await resolvePackageNames(roots, root);
      durations.push(performance.now() - start); assert.equal(names.length, 32);
    }
    durations.sort((a, b) => a - b);
    console.log("package resolution (32 explicit roots, ms)", { p50: durations[3], p95: durations[7] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
