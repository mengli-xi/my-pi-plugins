import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runStatusLineCommand } from "../../src/statusline/command.ts";

// Keep pipes open and the group query positive so completion must use the
// deadline. Virtual time makes a 50ms/250ms postponement fail deterministically.
for (const { name, abortAt, killAt } of [
  { name: "abort before timeout", abortAt: 260, killAt: 510 },
  { name: "timeout before early abort", abortAt: 760, killAt: 1_010 },
  { name: "timeout before late abort", abortAt: 2_300, killAt: 2_500 },
]) {
  test(`cleanup keeps the earliest deadline: ${name}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(performance, "now", () => Date.now());
    const child = Object.assign(new EventEmitter(), {
      pid: 424_242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const signals: Array<{ at: number; signal: NodeJS.Signals | number | undefined }> = [];
    t.mock.method(process, "kill", (_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) signals.push({ at: Date.now(), signal });
      return true;
    });
    Object.assign(child, { kill: (signal: NodeJS.Signals) => process.kill(child.pid, signal) });
    const spawn = t.mock.method(childProcess, "spawn", () => child as unknown as ReturnType<typeof childProcess.spawn>);
    syncBuiltinESMExports();
    t.after(() => {
      spawn.mock.restore();
      syncBuiltinESMExports();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    });

    const controller = new AbortController();
    const pending = runStatusLineCommand("fixture", {}, process.cwd(), controller.signal, 500);
    if (abortAt > 500) {
      t.mock.timers.tick(500);
      assert.deepEqual(signals, [{ at: 500, signal: "SIGTERM" }]);
      t.mock.timers.tick(abortAt - 500);
    } else {
      t.mock.timers.tick(abortAt);
    }
    controller.abort();
    const termAt = Math.min(abortAt, 500);
    assert.deepEqual(signals, [{ at: termAt, signal: "SIGTERM" }]);
    if (abortAt < 500) {
      t.mock.timers.tick(500 - abortAt);
      assert.deepEqual(signals, [{ at: termAt, signal: "SIGTERM" }]);
    }
    t.mock.timers.tick(killAt - Date.now() - 1);
    assert.equal(signals.length, 1, "KILL waits for its original earliest deadline");
    t.mock.timers.tick(1);
    assert.deepEqual(signals, [
      { at: termAt, signal: "SIGTERM" },
      { at: killAt, signal: "SIGKILL" },
    ]);
    t.mock.timers.tick(749);
    assert.equal(child.stdout.destroyed, false, "drain retains its 750ms budget");
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, []);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.ok(Date.now() - abortAt <= 1_000, "neither event order can extend the abort budget");
  });
}
