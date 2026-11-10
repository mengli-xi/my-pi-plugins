import assert from "node:assert/strict";
import { afterEach, test, mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createRequestHeadersCommandFetch } from "./request-headers-command.ts";

afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

for (const result of [
  { status: 1, signal: null, stdout: "", expected: "ps exited with code 1" },
  { status: null, signal: "SIGTERM", stdout: "", expected: "ps was killed by signal SIGTERM" },
]) {
  test(`request headers command fails before launch when ${result.expected}`, { skip: process.platform === "win32" }, async () => {
    const ps = mock.method(childProcess, "spawnSync", (command: string, args: string[]) => {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["axeww", "-o", "pid=,ppid=,command="]);
      return result;
    });
    const spawn = mock.method(childProcess, "spawn", () => { throw new Error("must not start a command after failed process discovery"); });
    syncBuiltinESMExports();
    let requests = 0;
    const fetch = createRequestHeadersCommandFetch({ command: "unused-test-command" }, async () => {
      requests++;
      throw new Error("must not contact a server");
    });
    await assert.rejects(fetch("https://example.com/mcp"), error => error instanceof Error && error.message.includes(result.expected));
    assert.equal(ps.mock.callCount(), 1);
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(requests, 0);
  });
}
