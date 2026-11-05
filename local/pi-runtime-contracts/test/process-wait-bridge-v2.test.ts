import assert from "node:assert/strict";
import test from "node:test";
import {
  getProcessWaitBridgeV2,
  registerProcessWaitBridgeV2,
} from "../src/process-wait-bridge-v2.ts";

function session(): string {
  return `process-wait-v2-${crypto.randomUUID()}`;
}

test("Process wait bridge captures an opaque owner and returns explicit continuation admission", async () => {
  const sessionId = session();
  const registration = registerProcessWaitBridgeV2({
    version: 2,
    sessionId,
    captureOwnerToken: () => "process-owner-v1:test",
    admitContinuation: async () => "record-only",
  });
  assert.equal(getProcessWaitBridgeV2(sessionId)?.captureOwnerToken(), "process-owner-v1:test");
  assert.equal(await getProcessWaitBridgeV2(sessionId)?.admitContinuation({ admissionId: "batch-test", ownerToken: "process-owner-v1:test", continuationSignal: true }), "record-only");
  registration.dispose();
  assert.equal(getProcessWaitBridgeV2(sessionId), undefined);
});

test("Process wait bridge rejects duplicate ownership and stale disposal is harmless", async () => {
  const sessionId = session();
  const first = registerProcessWaitBridgeV2({ version: 2, sessionId, captureOwnerToken: () => "process-owner-v1:first", admitContinuation: async () => "trigger" });
  assert.throws(
    () => registerProcessWaitBridgeV2({ version: 2, sessionId, captureOwnerToken: () => "process-owner-v1:duplicate", admitContinuation: async () => "record-only" }),
    /already registered/,
  );
  first.dispose();
  const replacement = registerProcessWaitBridgeV2({ version: 2, sessionId, captureOwnerToken: () => "process-owner-v1:replacement", admitContinuation: async () => "record-only" });
  first.dispose();
  assert.equal(getProcessWaitBridgeV2(sessionId)?.captureOwnerToken(), "process-owner-v1:replacement");
  assert.equal(await getProcessWaitBridgeV2(sessionId)?.admitContinuation({ admissionId: "batch-replacement", ownerToken: "process-owner-v1:replacement", continuationSignal: true }), "record-only");
  replacement.dispose();
});

test("Process wait bridge requires owner capture", () => {
  assert.throws(
    () => registerProcessWaitBridgeV2({ version: 2, sessionId: session(), admitContinuation: async () => "record-only" } as never),
    /invalid Process wait bridge/,
  );
});
