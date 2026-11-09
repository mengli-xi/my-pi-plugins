import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const script = join(pkg, "scripts/measure-startup.mjs");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function commandOf(pid: number): string {
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
  catch { return ""; }
}
async function until(condition: () => boolean, label: string) {
  const end = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await delay(25);
  }
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cc-measure-test-"));
  const source = join(root, "source"), home = join(root, "home");
  mkdirSync(source); mkdirSync(home);
  const settings = join(source, "settings.json");
  writeFileSync(settings, JSON.stringify({ packages: [], synthetic: true }), { mode: 0o644 });
  writeFileSync(join(source, "pi-private.json"), "synthetic private", { mode: 0o600 });
  writeFileSync(join(source, "pi-public.json"), "synthetic public", { mode: 0o644 });
  const binary = join(root, "fake-pi.mjs"), facts = join(root, "facts.json"), stops = join(root, "stops.jsonl");
  const ready = join(root, "ready"), outputDir = join(root, "output");
  mkdirSync(ready);
  writeFileSync(binary, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
if (process.argv.includes("--version")) { console.log("1.4.0"); process.exit(0); }
const mode = process.argv[2];
const dir = mode === "--daemon" ? process.argv[3] : process.env.PI_CODING_AGENT_DIR;
process.on("SIGHUP", () => {});
process.on("SIGTERM", () => {
  appendFileSync(process.env.STARTUP_TEST_STOPS, JSON.stringify({ pid: process.pid, mode, profileExists: existsSync(dir) }) + "\\n");
  if (!process.env.STARTUP_TEST_IGNORE_TERM) setTimeout(() => process.exit(0), 120);
});
// Each PID advertises readiness only after installing its signal handlers.
writeFileSync(join(process.env.STARTUP_TEST_READY, String(process.pid)), "");
if (mode !== "--daemon" && mode !== "--sentinel") {
  const daemon = spawn(process.execPath, [fileURLToPath(import.meta.url), "--daemon", dir], { detached: true, stdio: "ignore" });
  daemon.unref();
  mkdirSync(join(dir, "scheduler"), { recursive: true });
  writeFileSync(join(dir, "scheduler/daemon.lock"), process.env.STARTUP_TEST_FOREIGN_PID || String(daemon.pid));
  writeFileSync(process.env.STARTUP_TEST_FACTS, JSON.stringify({ pid: process.pid, daemon: daemon.pid, dir, home: process.env.HOME, files: readdirSync(dir) }));
  if (!process.env.STARTUP_TEST_HOLD) {
    while (!existsSync(join(process.env.STARTUP_TEST_READY, String(daemon.pid)))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (process.env.STARTUP_TEST_NO_TOTAL) process.exit(0);
    console.log("TOTAL: 1ms"); console.log("TOTAL: 2ms");
  }
}
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }));
    if (existsSync(facts)) {
      const info = JSON.parse(readFileSync(facts, "utf8"));
      // Failure cleanup still requires the exact fixture command identity.
      for (const pid of [info.pid, info.daemon]) if (commandOf(pid).includes(binary)) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await until(() => !commandOf(pid).includes(binary), "fixture process exit");
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"),
    STARTUP_TEST_FACTS: facts, STARTUP_TEST_STOPS: stops, STARTUP_TEST_READY: ready };
  const run = (extra: Record<string, string> = {}) => {
    const child = spawn("bun", [script, binary, "--source", source, "--profiles", "full", "--samples", "1", "--warmup", "0", "--out", outputDir],
      { cwd: pkg, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout!.on("data", bytes => { output += bytes; }); child.stderr!.on("data", bytes => { output += bytes; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    return { child, exited, output: () => output };
  };
  return { root, source, settings, binary, facts, stops, ready, outputDir, env, children, run };
}

for (const interrupt of [undefined, "SIGINT", "SIGTERM"] as const) {
  test(`startup sample ${interrupt ?? "normal exit"} reaps verified children before deleting the profile`, { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const sentinel = spawn(process.execPath, [f.binary, "--sentinel"], { env: f.env, stdio: "ignore" });
    f.children.push(sentinel);
    const run = f.run(interrupt ? { STARTUP_TEST_HOLD: "1" } : { STARTUP_TEST_FOREIGN_PID: String(sentinel.pid) });
    await until(() => existsSync(f.facts), "sample started");
    const info = JSON.parse(readFileSync(f.facts, "utf8"));
    await until(() => [info.pid, info.daemon].every(pid => existsSync(join(f.ready, String(pid)))), "parent and daemon ready");
    if (interrupt) run.child.kill(interrupt);
    const code = await run.exited;
    assert.equal(code, interrupt === "SIGINT" ? 130 : interrupt === "SIGTERM" ? 143 : 0, run.output());
    assert.equal(commandOf(info.pid).includes(f.binary), false);
    assert.equal(commandOf(info.daemon).includes(f.binary), false);
    assert.equal(existsSync(dirname(info.dir)), false, "profile/HOME root is removed only after the sample exits");
    assert.ok(commandOf(sentinel.pid!).includes(f.binary), "a foreign daemon-lock PID is left alone");
    const stopped = readFileSync(f.stops, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(new Set(stopped.map(event => event.pid)), new Set([info.pid, info.daemon]));
    assert.ok(stopped.every(event => event.profileExists), "the profile survives until each verified child handles termination");
    assert.ok(info.files.includes("pi-public.json"));
    assert.ok(!info.files.includes("pi-private.json"));
    if (!interrupt) assert.match(run.output(), /\| full \| 1 \| 1 \| 2 \|/);
  });
}

test("startup settings reject owner-only files and links outside the synthetic source before parsing", async t => {
  const f = fixture(t);
  writeFileSync(f.settings, "invalid synthetic JSON"); chmodSync(f.settings, 0o600);
  const privateRun = f.run();
  assert.notEqual(await privateRun.exited, 0);
  assert.match(privateRun.output(), /owner-only settings are not copied/);
  assert.equal(existsSync(f.facts), false);
  rmSync(f.settings);
  const external = join(f.root, "outside.json"); writeFileSync(external, "invalid external JSON", { mode: 0o644 });
  symlinkSync(external, f.settings);
  const linkedRun = f.run();
  assert.notEqual(await linkedRun.exited, 0);
  assert.match(linkedRun.output(), /settings.json must resolve inside --source/);
  assert.equal(existsSync(f.facts), false);
});


test("forced sample KILL lets time finish the memory report", { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const run = f.run({ STARTUP_TEST_IGNORE_TERM: "1" });
  await until(() => existsSync(f.facts), "sample started");
  const info = JSON.parse(readFileSync(f.facts, "utf8"));
  await until(() => [info.pid, info.daemon].every(pid => existsSync(join(f.ready, String(pid)))), "parent and daemon ready");
  assert.equal(await run.exited, 0, run.output());
  const result = JSON.parse(readFileSync(join(f.outputDir, "results.json"), "utf8")).results[0];
  assert.equal(result.mainTotalMs, 1);
  assert.equal(result.extensionsTotalMs, 2);
  assert.ok(result.maxRssMiB > 0, "RSS survives the forced program exit");
  assert.ok(result.peakFootprintMiB > 0, "the final footprint field is captured before closing the PTY");
  assert.equal(commandOf(info.pid).includes(f.binary), false);
  assert.equal(commandOf(info.daemon).includes(f.binary), false);
  assert.equal(existsSync(dirname(info.dir)), false);
});

test("an incomplete startup sample fails instead of publishing a successful summary", { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const run = f.run({ STARTUP_TEST_NO_TOTAL: "1" });
  assert.notEqual(await run.exited, 0);
  assert.match(run.output(), /incomplete startup sample full-1: missing mainTotalMs, extensionsTotalMs/);
  assert.equal(existsSync(join(f.outputDir, "results.json")), false);
  assert.equal(existsSync(join(f.outputDir, "summary.md")), false);
  const raw = readFileSync(join(f.outputDir, "full-1.out"), "utf8");
  assert.match(raw, /maximum resident set size/);
  const info = JSON.parse(readFileSync(f.facts, "utf8"));
  assert.equal(commandOf(info.pid).includes(f.binary), false);
  assert.equal(commandOf(info.daemon).includes(f.binary), false);
  assert.equal(existsSync(dirname(info.dir)), false);
});
