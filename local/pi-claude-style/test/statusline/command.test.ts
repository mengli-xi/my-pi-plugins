import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { runStatusLineCommand } from "../../src/statusline/command.ts";

const CWD = process.cwd();

/** Hold the event loop for `ms`, the way rebuilding a large transcript does. */
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy on purpose: timers and I/O callbacks both queue up behind this.
  }
}

test("reads a command that finished while the event loop was blocked", async () => {
  // The regression: Node runs the timers phase before the I/O phase, so after a
  // block long enough to expire the timeout, the timeout callback runs while
  // the command's `data` and `close` are still sitting unread. Deciding the
  // result from the timeout threw the frame away — and at startup and after
  // `/reload` there is no previous frame to fall back on, which is what left
  // the statusline blank until the next turn ended.
  //
  // The deadline only has to outlast a cold shell start, and the block only has
  // to outlast the deadline: what the case pins down is that the timeout
  // expires while `data` and `close` are still unread, not how fast `echo` is.
  // Both spans keep several times the scheduling slack a loaded machine needs.
  const pending = runStatusLineCommand("echo hello", {}, CWD, undefined, 2_000);
  blockEventLoop(2_600);

  assert.deepEqual(await pending, ["hello"]);
});

test("reports a command that really is hung as empty", async () => {
  const started = Date.now();
  const lines = await runStatusLineCommand("sleep 30", {}, CWD, undefined, 50);

  assert.deepEqual(lines, []);
  // SIGTERM takes it down; the SIGKILL grace period is a backstop for a process
  // that ignores it, not the normal path.
  assert.ok(Date.now() - started < 2_000, "hung command should not wait out the kill grace");
});

test("reports a non-zero exit as empty even when it printed", async () => {
  assert.deepEqual(await runStatusLineCommand("echo out; exit 3", {}, CWD, undefined, 5_000), []);
});

test("an aborted run resolves empty", async () => {
  const controller = new AbortController();
  const pending = runStatusLineCommand("sleep 30", {}, CWD, controller.signal, 5_000);
  controller.abort();

  assert.deepEqual(await pending, []);
});

test("a command that never reads its payload does not take the process down", async () => {
  // No stdin drain, so the write lands on a closed pipe. An unhandled 'error'
  // on that stream would be an uncaught exception, not a lost frame.
  assert.deepEqual(await runStatusLineCommand("echo fine", {}, CWD, undefined, 5_000), ["fine"]);
});

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const mode of ["abort", "abort-resistant", "timeout", "timeout-then-abort"] as const) {
  test(`cancelling a slow command tree drains every descendant: ${mode}`, { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "statusline-command-tree-"));
    const groups: number[] = [], workers: number[] = [];
    t.after(() => {
      for (const group of groups) {
        try { process.kill(-group, "SIGKILL"); } catch { /* Owned group already gone. */ }
      }
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(join(root, "worker.cjs"), `
const fs = require("node:fs");
if (process.argv[3] === "ignore") process.on("SIGTERM", () => {});
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`);
    const script = join(root, "statusline.sh");
    writeFileSync(script, `cat >/dev/null
echo "$$" > "$1.group"
${quote(process.execPath)} ${quote(join(root, "worker.cjs"))} "$1" "$2" >/dev/null 2>&1 &
worker=$!
wait "$worker" || exit $?
printf 'late output\\n'
`);
    // A process in the test runner's group must survive command-group cleanup.
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(unrelated, "spawn");
    t.after(async () => { const closed = once(unrelated, "close"); unrelated.kill("SIGKILL"); await closed; });
    for (let cycle = 0; cycle < (mode === "abort" ? 3 : 1); cycle++) {
      const pidFile = join(root, `worker-${cycle}.pid`);
      const controller = new AbortController();
      const resistant = mode === "abort-resistant" || mode === "timeout-then-abort";
      // The timeout modes need the worker (a cold Node process) to be running
      // before the deadline fires; only the cancellation budget is under test.
      const spawnedAt = Date.now();
      const pending = runStatusLineCommand(`exec /bin/sh ${quote(script)} ${quote(pidFile)} ${resistant ? "ignore" : "normal"}`, {}, root, controller.signal, mode.startsWith("timeout") ? 5_000 : 10_000);
      const deadline = Date.now() + 20_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await delay(10);
      if (existsSync(pidFile + ".group")) groups.push(Number(readFileSync(pidFile + ".group", "utf8")));
      assert.ok(existsSync(pidFile), "slow worker must start before cancellation");
      const pid = Number(readFileSync(pidFile, "utf8")); workers.push(pid);
      assert.equal(alive(pid), true);
      // Abort shortly after the command's own timeout (measured from spawn, not
      // from the worker's start) so the abort still lands inside the timeout's
      // two-second KILL grace however long the worker took to boot.
      if (mode === "timeout-then-abort") await delay(Math.max(0, spawnedAt + 5_300 - Date.now()));
      const started = Date.now();
      if (mode !== "timeout") controller.abort();
      assert.deepEqual(await pending, []);
      if (resistant) {
        assert.ok(Date.now() - started >= 200, "await SIGKILL escalation instead of resolving when only the shell exits");
        assert.ok(Date.now() - started < 1_500, "abort must finish within the 1s cleanup budget plus scheduling slack");
      }
      assert.equal(workers.filter(alive).length, 0, "no surviving worker after any of three cancellations");
      assert.equal(alive(unrelated.pid!), true, "never signal the caller's process group");
    }
  });
}
