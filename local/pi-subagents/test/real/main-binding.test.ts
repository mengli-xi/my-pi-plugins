import assert from "node:assert/strict";
import test from "node:test";
import { freshHost, delay } from "../fixtures/fresh-host.js";
test("fresh stock host keeps SDK service and durable store lazy", { timeout: 120_000 }, async t => {
  const f = await freshHost(t); await f.assertAuthSymlink();
  const state = await f.snapshot(); assert.equal(state.service, false); f.assertNoChildPi();
  await f.stop(); assert.equal(f.stderr, "");
});
