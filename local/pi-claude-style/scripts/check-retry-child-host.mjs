import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolve(process.argv[2] ?? process.env.PI_BINARY ?? "");
if (!process.argv[2] && !process.env.PI_BINARY) throw new Error("usage: node scripts/check-retry-child-host.mjs /path/to/pi");
const keep = !!process.env.CC_RETRY_CHILD_ARTIFACTS;
const root = keep ? resolve(process.env.CC_RETRY_CHILD_ARTIFACTS) : await mkdtemp(join(tmpdir(), "cc-retry-child-"));
try {
  for (const target of ["side-chat", "subagent"]) for (const entry of ["reattach", "first"]) {
    const directory = join(root, `${target}-${entry}`);
    for (const name of ["home", "agent", "sessions"]) await mkdir(join(directory, name), { recursive: true });
    const child = spawn(binary, ["--mode", "rpc", "--offline", "--no-session", "--approve", "--no-extensions",
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
      "--extension", join(packageRoot, "test/integration/retry-child-fixture.mjs")], {
      cwd: directory, env: { ...process.env, HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "home/.config"),
        PI_CODING_AGENT_DIR: join(directory, "agent"), PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"), PI_OFFLINE: "1",
        CC_RETRY_CHILD_ROOT: directory, CC_RETRY_CHILD_TARGET: target, CC_RETRY_CHILD_ENTRY: entry }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timer;
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
    try {
      const exit = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("retry child fixture timed out")), 45_000); })]);
      const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
      assert.deepEqual(exit, { code: 0, signal: null }, `${JSON.stringify(result)}\n${stderr}\n${stdout}`);
      assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(stderr, "", stderr);
      console.log(`ok ${target} ${entry}: original countdown, isolated Main, Esc, no stale snapshot`);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }
  console.log(`artifacts: ${root}`);
} finally { if (!keep) await rm(root, { recursive: true, force: true }); }
