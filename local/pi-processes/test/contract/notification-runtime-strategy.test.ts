import assert from "node:assert/strict";
import test from "node:test";

import { registerProcessWaitBridgeV2 } from "pi-runtime-contracts/process-wait-bridge-v2";
import {
  createChildNotificationStrategyV1,
  createMainNotificationStrategyV1,
} from "../../src/notifications/runtime-strategy.ts";

test("Main notification owner is the stable session scope", () => {
  const strategy = createMainNotificationStrategyV1("session-main");
  assert.deepEqual(strategy.captureTarget(), { strategy: "main", scopeToken: "session-main" });
  assert.deepEqual(strategy.captureTarget(), { strategy: "main", scopeToken: "session-main" });
});

test("Subagent notification owner is captured from the active bridge", (t) => {
  const sessionId = `owner-${crypto.randomUUID()}`;
  const registration = registerProcessWaitBridgeV2({
    version: 2,
    sessionId,
    captureOwnerToken: () => "process-owner-v1:task-runtime",
    admitContinuation: async () => "record-only",
  });
  t.after(() => registration.dispose());
  assert.deepEqual(createChildNotificationStrategyV1(sessionId).captureTarget(), {
    strategy: "child",
    scopeToken: "process-owner-v1:task-runtime",
  });
});

test("Subagent notification owner capture fails closed without a valid bridge token", (t) => {
  const missing = createChildNotificationStrategyV1(`missing-${crypto.randomUUID()}`);
  assert.throws(() => missing.captureTarget(), /owner bridge is unavailable/);

  const sessionId = `invalid-${crypto.randomUUID()}`;
  const registration = registerProcessWaitBridgeV2({
    version: 2,
    sessionId,
    captureOwnerToken: () => "",
    admitContinuation: async () => "record-only",
  });
  t.after(() => registration.dispose());
  assert.throws(() => createChildNotificationStrategyV1(sessionId).captureTarget(), /owner token is invalid/);
});
