import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRuntime, resolveHelperRuntime } from "../../src/supervisor/runtime-resolver.ts";

async function fakeRuntime(t: TestContext, body: string) {
  const root = await mkdtemp(join(tmpdir(), "process-slow-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "node"), calls = join(root, "calls");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$$" >> '${calls}'\n${body.replaceAll("CALLS", `'${calls}'`)}\n`, { mode: 0o700 });
  return { candidate: { path, source: "explicit" as const }, calls };
}

const accepted = `printf 'pi-processes-runtime-v1 %s node 24.0.0\\n' "$3"`;

test("runtime startup slower than the former two-second budget is accepted without retry", async t => {
  const f = await fakeRuntime(t, `/bin/sleep 3\n${accepted}`);
  const result = await probeRuntime(f.candidate, "unused-supervisor");
  assert.ok("candidate" in result, JSON.stringify(result));
  assert.equal((await readFile(f.calls, "utf8")).trim().split("\n").length, 1);
});

test("slow runtime is killed and reaped before one timeout retry succeeds", async t => {
  const f = await fakeRuntime(t, `[ "$(wc -l < CALLS)" -eq 1 ] && exec /bin/sleep 30\n${accepted}`);
  const result = await probeRuntime(f.candidate, "unused-supervisor");
  assert.ok("candidate" in result, JSON.stringify(result));
  const pids = (await readFile(f.calls, "utf8")).trim().split("\n").map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("two slow runtime probes return the final timeout without leaking children", async t => {
  const f = await fakeRuntime(t, "/bin/sleep 30");
  const resolved = await resolveHelperRuntime({ helperRuntime: f.candidate.path, supervisorPath: "unused-supervisor" });
  assert.equal(resolved.runtime, undefined);
  assert.equal(resolved.attempts.length, 1);
  const result = resolved.attempts[0]!;
  assert.equal(result.outcome, "timeout");
  assert.match(result.detail!, /timeout retry/);
  const pids = (await readFile(f.calls, "utf8")).trim().split("\n").map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("unsupported and invalid output are not retried; missing runtime reports failure", async t => {
  for (const body of [accepted.replace("24.0.0", "18.0.0"), "printf invalid"]) {
    const f = await fakeRuntime(t, body);
    const result = await resolveHelperRuntime({ helperRuntime: f.candidate.path, supervisorPath: "unused-supervisor" });
    assert.equal(result.runtime, undefined);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]!.outcome, body.includes("18.0.0") ? "unsupported-version" : "invalid-output");
    assert.equal((await readFile(f.calls, "utf8")).trim().split("\n").length, 1);
  }
  const missing = await resolveHelperRuntime({ helperRuntime: join(tmpdir(), "missing-process-runtime"), supervisorPath: "unused-supervisor" });
  assert.equal(missing.runtime, undefined);
  assert.equal(missing.attempts[0]!.outcome, "not-executable");
});
