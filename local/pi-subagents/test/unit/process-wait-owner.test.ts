import assert from "node:assert/strict";
import test from "node:test";
import { admitOwnedProcessContinuationV2 } from "../../src/child/process-wait-owner.ts";

test("current Process owner token reaches the existing admission state machine", async () => {
  let admitted = 0;
  const result = await admitOwnedProcessContinuationV2({
    ownerToken: "process-owner-v1:current",
    captureCurrentOwnerToken: () => "process-owner-v1:current",
    async admit() { admitted += 1; return "trigger"; },
  });
  assert.equal(result, "trigger");
  assert.equal(admitted, 1);
});

test("stale or unavailable Process owner tokens fail closed before admission", async () => {
  let admitted = 0;
  const stale = await admitOwnedProcessContinuationV2({
    ownerToken: "process-owner-v1:old",
    captureCurrentOwnerToken: () => "process-owner-v1:new",
    async admit() { admitted += 1; return "trigger"; },
  });
  const unavailable = await admitOwnedProcessContinuationV2({
    ownerToken: "process-owner-v1:old",
    captureCurrentOwnerToken() { throw new Error("no active Task"); },
    async admit() { admitted += 1; return "trigger"; },
  });
  assert.equal(stale, "record-only");
  assert.equal(unavailable, "record-only");
  assert.equal(admitted, 0);
});
