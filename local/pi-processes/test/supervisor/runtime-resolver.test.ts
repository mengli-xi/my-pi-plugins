import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

for (const supported of [true, false]) test(`slow runtime is reaped before one timeout retry ${supported ? "succeeds" : "reports its unsupported version"}`, async t => {
  const reply = supported ? accepted : accepted.replace("24.0.0", "18.0.0");
  const f = await fakeRuntime(t, `[ "$(wc -l < CALLS)" -eq 1 ] && exec /bin/sleep 30\n${reply}`);
  const result = await probeRuntime(f.candidate, "unused-supervisor");
  if (supported) assert.ok("candidate" in result, JSON.stringify(result));
  else {
    assert.ok("outcome" in result);
    assert.equal(result.outcome, "unsupported-version");
    assert.match(result.detail!, /first attempt: timeout \(probe exceeded 10000ms\); retry: unsupported-version \(node 18\.0\.0\)/);
  }
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
  assert.match(result.detail!, /first attempt: timeout \(probe exceeded 10000ms\); retry: timeout \(probe exceeded 10000ms\)/);
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

async function detachedPipeRuntime(t: TestContext, childSource: string) {
  const root = await mkdtemp(join(tmpdir(), "process-detached-pipe-"));
  const runtime = join(root, "node"), calls = join(root, "calls"), holders = join(root, "holders");
  t.after(async () => {
    try {
      const pids = (await readFile(holders, "utf8").catch(error => {
        if (error.code === "ENOENT") return "";
        throw error;
      })).trim().split("\n").filter(Boolean).map(Number);
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        const deadline = Date.now() + 5_000;
        for (;;) {
          try { process.kill(pid, 0); }
          catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); break; }
          assert.ok(Date.now() < deadline, `detached pipe holder ${pid} was not reaped`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const script = join(root, "runtime.mjs");
  await writeFile(script, `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, process.pid + "\\n");
const holder = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], {
  detached: true, stdio: ["ignore", process.stdout, process.stderr],
});
appendFileSync(${JSON.stringify(holders)}, holder.pid + "\\n");
holder.unref();
process.stdout.write("pi-processes-runtime-v1 " + process.argv.at(-1) + " node 24.0.0\\n", () => process.exit(0));
`);
  await writeFile(runtime, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
  // Run the real resolver in a separately bounded host so a regression cannot
  // leave an in-flight retry creating holders after this test's cleanup.
  const run = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
const { resolveHelperRuntime } = await import(${JSON.stringify(new URL("../../src/supervisor/runtime-resolver.ts", import.meta.url).href)});
const start = performance.now();
const result = await resolveHelperRuntime({ helperRuntime: ${JSON.stringify(runtime)}, supervisorPath: "unused-supervisor" });
console.log(JSON.stringify({ result, elapsed: performance.now() - start }));
`], { timeout: 35_000, killSignal: "SIGKILL" });
    return JSON.parse(stdout);
  };
  return { run, calls, holders };
}

test("exited runtime with detached pipe holders times out, retries, and its resolver host exits", { timeout: 45_000 }, async t => {
  const f = await detachedPipeRuntime(t, "setTimeout(() => process.exit(0), 60000)");
  const { result, elapsed } = await f.run();
  assert.equal(result.runtime, undefined);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, "timeout");
  const detail = result.attempts[0].detail;
  assert.match(detail, /first attempt: timeout/);
  assert.match(detail, /; retry: timeout/);
  assert.equal(detail.split("pipes remained open 2000ms after runtime exit").length, 3);
  assert.equal(detail.split("pipes forcibly closed after 2000ms cleanup").length, 3);
  assert.ok(elapsed >= 7_500 && elapsed < 26_000, `elapsed=${elapsed}`);
  const pids = (await readFile(f.holders, "utf8")).trim().split("\n").map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0), "holder escaped probe group and must be cleaned by the fixture");
  const parents = (await readFile(f.calls, "utf8")).trim().split("\n").map(Number);
  assert.equal(parents.length, 2);
  for (const pid of parents) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const stderr of [false, true]) test(`exit pipe grace ${stderr ? "rejects late stderr" : "accepts complete output"} without retry`, { timeout: 45_000 }, async t => {
  const f = await detachedPipeRuntime(t, stderr
    ? 'setTimeout(() => process.stderr.write("late stderr\\n", () => process.exit(0)), 100)'
    : "setTimeout(() => process.exit(0), 100)");
  const { result, elapsed } = await f.run();
  if (stderr) {
    assert.equal(result.runtime, undefined);
    assert.equal(result.attempts[0].outcome, "invalid-output");
  } else {
    assert.equal(result.runtime.engine, "node");
    assert.deepEqual(result.attempts, []);
  }
  assert.equal((await readFile(f.calls, "utf8")).trim().split("\n").length, 1);
  assert.ok(elapsed < 10_000, `elapsed=${elapsed}`);
});
