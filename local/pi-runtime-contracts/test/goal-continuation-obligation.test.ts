import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  queryGoalContinuationObligationV1 as query,
  registerGoalContinuationObligationV1 as register,
} from "../src/goal-continuation-obligation-v1.ts";

test("Goal obligation is tri-state, session scoped and stale disposal cannot release a peer", () => {
  const target = { sessionId: "session", continuationId: "goal:marker" };
  assert.equal(query(target), "none");
  const unbound = register(() => "unknown");
  assert.equal(query(target), "unknown");
  const bound = register((value) => value.sessionId === "session" ? "owed" : "none");
  assert.equal(query(target), "owed");
  unbound.dispose();
  unbound.dispose();
  assert.equal(query(target), "owed");
  assert.equal(query({ ...target, sessionId: "other" }), "none");
  bound.dispose();
  const unavailable = register(() => { throw new Error("source unavailable"); });
  assert.equal(query(target), "unknown");
  unavailable.dispose();
  assert.equal(query(target), "none");
});

test("incompatible holder is unknown and registration cannot overwrite it", () => {
  const moduleUrl = new URL("../src/goal-continuation-obligation-v1.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "--experimental-strip-types", "-e", `
    import assert from 'node:assert/strict';
    globalThis[Symbol.for('pi.goal.continuation-obligation.v1')] = {version: 2};
    const api = await import(${JSON.stringify(moduleUrl)});
    assert.equal(api.queryGoalContinuationObligationV1({sessionId:'s',continuationId:'g:m'}), 'unknown');
    assert.throws(() => api.registerGoalContinuationObligationV1(() => 'owed'), /Incompatible/);
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});
