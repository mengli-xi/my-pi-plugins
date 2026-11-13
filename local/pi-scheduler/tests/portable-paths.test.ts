import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ping } from "../src/client.ts";
import { schedulerPaths } from "../src/paths.ts";

test("a frozen runtime directory keeps socket identity across TMPDIR changes", (t) => {
  const original = process.env.TMPDIR;
  const runtime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = tmpdir();
  t.after(() => { if (runtime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = runtime; });
  t.after(() => { if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original; });
  const agent = join(tmpdir(), "portable-profile");
  const first = schedulerPaths(agent).socket;
  process.env.TMPDIR = join(tmpdir(), "long-".repeat(40));
  assert.equal(schedulerPaths(agent).socket, first);
  assert.ok(Buffer.byteLength(first) <= 103);
  assert.notEqual(schedulerPaths(agent + "-other").socket, first);
});

test("bundled daemon starts from a path containing spaces and percent signs with long TMPDIR", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scheduler-portable-"));
  let daemon: ChildProcess | undefined;
  t.after(async () => {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise(resolve => daemon!.once("exit", resolve));
      daemon.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const install = join(root, "space %h $HOME dir");
  mkdirSync(install);
  const alias = join(root, "alias space %h");
  symlinkSync(install, alias, "dir");
  const entry = join(alias, "daemon.js");
  copyFileSync(fileURLToPath(new URL("../dist/daemon.js", import.meta.url)), entry);
  const agent = join(root, "agent");
  const paths = schedulerPaths(agent);
  daemon = spawn(process.execPath, [entry], {
    env: { ...process.env, TMPDIR: join(root, "long-".repeat(40)), PI_CODING_AGENT_DIR: agent, PI_SCHEDULER_BINARY: process.execPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  daemon.stdout!.on("data", chunk => { output += chunk; });
  daemon.stderr!.on("data", chunk => { output += chunk; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (await ping(paths.socket)) { ready = true; break; }
    assert.equal(daemon.exitCode, null, `daemon exited before listening: ${output}`);
    await delay(100);
  }
  assert.ok(ready, `daemon answers on the same short socket: ${output}`);
});

test("importing the daemon with a missing argv entry is not a direct invocation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scheduler-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = new URL("../src/daemon-entry.ts", import.meta.url).href;
  const loader = fileURLToPath(new URL("../../../ts-resolve.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", loader, "--experimental-strip-types", "--input-type=module", "-e",
    `process.argv[1] = ${JSON.stringify(join(root, "missing"))}; await import(${JSON.stringify(entry)}); console.log("IMPORTED");`],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "IMPORTED");
});
