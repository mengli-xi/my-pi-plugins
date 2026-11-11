import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freshHost } from "../fixtures/fresh-host.ts";

test("a failed quit is force-reaped by fixture cleanup even after EOF was sent", async t => {
  const host = await freshHost(t, undefined, false, 1, [fileURLToPath(new URL("../fixtures/slow-quit.ts", import.meta.url))], "default", 20);
  await assert.rejects(host.stop(), /quit timed out/);
  assert.equal(host.main.exitCode, null);
  // Registered after the fixture's hook, so this observes its failure cleanup.
  t.after(() => {
    assert.equal(host.main.signalCode, "SIGKILL");
    assert.throws(() => process.kill(host.main.pid!, 0), { code: "ESRCH" });
  });
});
