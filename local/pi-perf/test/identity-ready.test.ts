import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_TIMEOUT_MS, packageHash, PerfHistory, type Identity } from "../src/history.ts";

function identity(): Identity { return { pid: process.pid, piVersion: "1.5.0", mode: "unknown", packages: [], packagesHash: packageHash([]) }; }
async function raw(root: string) {
  const directory = join(root, "raw");
  return (await readFile(join(directory, (await readdir(directory))[0]), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}
test("a sample before a startup delayed past 60s waits for its identity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "perf-identity-")), id = identity(), history = new PerfHistory(root, id);
  try {
    t.mock.timers.tick(60_001); history.write("sample", { rss: 1 });
    await Promise.resolve(); assert.equal(existsSync(join(root, "raw")), false);
    id.packages = ["resolved-plugin"]; id.packagesHash = packageHash(id.packages); id.mode = "tui";
    history.setIdentityReady(Promise.resolve()); await history.flush();
    assert.deepEqual((await raw(root))[0].packages, ["resolved-plugin"]);
    assert.equal((await raw(root))[0].mode, "tui");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("identity readiness has a finite local fallback, including rejected resolution", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "perf-identity-timeout-"));
  try {
    const history = new PerfHistory(root, identity()); history.write("sample", { rss: 2 });
    t.mock.timers.tick(IDENTITY_TIMEOUT_MS); await history.flush();
    assert.match(history.identityError!, /timed out/);
    assert.deepEqual((await raw(root))[0].packages, ["local"]);
    const rejected = new PerfHistory(root, identity()); rejected.write("sample", { rss: 3 });
    rejected.setIdentityReady(Promise.reject(new Error("unavailable"))); await rejected.flush();
    assert.match(rejected.identityError!, /resolution failed/);
    assert.ok((await raw(root)).every(row => row.packages.length > 0));
  } finally { await rm(root, { recursive: true, force: true }); }
});
