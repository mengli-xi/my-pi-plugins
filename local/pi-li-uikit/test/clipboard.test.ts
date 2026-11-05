import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { copyToClipboard } from "../src/clipboard.ts";

function clipboardHarness(t: TestContext, commandExitCode = 0) {
  const originalEnv = process.env;
  process.env = { ...originalEnv };
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION", "PI_CLIPBOARD_OSC52"]) {
    delete process.env[name];
  }
  const writes: Array<{ target: string; text: string }> = [];
  t.after(() => {
    process.env = originalEnv;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(os, "platform", () => "darwin");
  t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
    assert.equal(command, "pbcopy");
    assert.deepEqual(args, []);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() });
    let input = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => { input += chunk; });
    child.stdin.on("finish", () => {
      writes.push({ target: "system", text: input });
      child.emit("close", commandExitCode);
    });
    return child;
  });
  const originalWrite = process.stdout.write;
  t.mock.method(process.stdout, "write", (text: string | Uint8Array, ...args: unknown[]) => {
    // Node's test runner also writes binary IPC frames to this stream.
    if (typeof text !== "string") return Reflect.apply(originalWrite, process.stdout, [text, ...args]);
    writes.push({ target: "terminal", text });
    return true;
  });
  syncBuiltinESMExports();
  return writes;
}

test("PI_CLIPBOARD_OSC52 only adds a direct OSC 52 copy when set to 1", async (t) => {
  for (const value of [undefined, "0", "true", "1"]) {
    await t.test(`PI_CLIPBOARD_OSC52=${value ?? "unset"}`, async (t) => {
      const writes = clipboardHarness(t);
      if (value !== undefined) process.env.PI_CLIPBOARD_OSC52 = value;
      const text = "复制\nclipboard";
      await copyToClipboard(text);
      const expected = [{ target: "system", text }];
      if (value === "1") {
        expected.push({ target: "terminal", text: `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07` });
      }
      assert.deepEqual(writes, expected);
    });
  }
});

test("opt-in OSC 52 keeps Pi's 100,000 base64-character limit and successful system copy", async (t) => {
  const writes = clipboardHarness(t);
  process.env.PI_CLIPBOARD_OSC52 = "1";
  const atLimit = "中".repeat(25_000);
  await copyToClipboard(atLimit);
  assert.deepEqual(writes, [
    { target: "system", text: atLimit },
    { target: "terminal", text: `\x1b]52;c;${Buffer.from(atLimit).toString("base64")}\x07` },
  ]);
  writes.length = 0;
  const oversized = `${atLimit}a`;
  await copyToClipboard(oversized);
  assert.deepEqual(writes, [{ target: "system", text: oversized }]);
});

test("a failed system copy still falls back to one OSC 52 sequence", async (t) => {
  const writes = clipboardHarness(t, 1);
  await copyToClipboard("fallback");
  assert.deepEqual(writes, [
    { target: "system", text: "fallback" },
    { target: "terminal", text: "\x1b]52;c;ZmFsbGJhY2s=\x07" },
  ]);
});
