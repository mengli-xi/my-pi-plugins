import assert from "node:assert/strict";
import test from "node:test";
import { canonicalProcessNotificationValueV1, processNotificationBatchMessageV1, validProcessNotificationBatchCarrierV1, PROCESS_NOTIFICATION_BATCH_TYPE } from "../../src/notifications/main-context.ts";
import { formatProcessNotificationBatchV1 } from "../../src/notifications/formatting.ts";
import { proveProcessMailV1, scanLegacyProcessBatchesV1 } from "../../src/notifications/mailbox-proof.ts";
import type { ProcessNotificationBatchV1 } from "../../src/notifications/types.ts";
import type { Mail } from "pi-session-inject/mailbox-v1";
function batch(id: string): ProcessNotificationBatchV1 {
  return {
    version: 1,
    batchId: id,
    sessionScopeId: "session",
    epochId: "epoch",
    reason: "user-boundary",
    mode: "aggregate",
    createdAt: "2026-01-01T00:00:00.000Z",
    items: [{
      kind: "watch-match",
      processId: "proc_demo000001",
      processName: "demo",
      watchKey: "ready",
      watchGeneration: 1,
      count: 2,
      matchedCount: 2,
      suppressedCount: 0,
      firstFactId: "fact-1",
      lastFactId: "fact-2",
      hostIncarnationId: "host",
      firstNotificationSequence: 1,
      lastNotificationSequence: 2,
      firstObservedAt: "2026-01-01T00:00:00.000Z",
      lastObservedAt: "2026-01-01T00:00:01.000Z",
    }],
  };
}

function custom(value: ProcessNotificationBatchV1) {
  return { role: "custom", customType: PROCESS_NOTIFICATION_BATCH_TYPE, content: formatProcessNotificationBatchV1(value).text, display: false, details: value, timestamp: 1 };
}
function entry(value: ProcessNotificationBatchV1) {
  return { type: "custom_message", customType: PROCESS_NOTIFICATION_BATCH_TYPE, content: formatProcessNotificationBatchV1(value).text, display: false, details: value };
}


test("strict carrier proof preserves content/details and rejects conflicting native identities", () => {
  const value = batch("batch");
  const message = processNotificationBatchMessageV1(value);
  const mail: Mail = { producer: "pi-processes", key: "batch:batch", anchorEntryId: "origin", policy: "next-request", wake: true, messages: [message] };
  const native = { id: "native", ...entry(value) };
  assert.deepEqual(proveProcessMailV1(mail, [native], "session"), { kind: "observed", entries: [{ messageIndex: 0, entryId: "native" }] });
  assert.equal(proveProcessMailV1(mail, [{ ...native, content: "forged" }], "session").kind, "conflict");
  assert.equal(proveProcessMailV1(mail, [native, { ...native, id: "duplicate" }], "session").kind, "conflict");
  assert.deepEqual(proveProcessMailV1(mail, [], "session"), { kind: "observed", entries: [] });
  assert.equal(canonicalProcessNotificationValueV1(message.details), canonicalProcessNotificationValueV1(value));
  assert.equal(validProcessNotificationBatchCarrierV1({ ...message, display: true }, "session"), false);
});

test("legacy scanner includes unmarked orphans, isolates scope and honors settled status", () => {
  const orphan = { id: "orphan", ...entry(batch("orphan")) };
  const settled = { id: "settled", ...entry(batch("settled")) };
  const status = (id: string, state: string, scope = "session") => ({ type: "custom", customType: "process-notification-status-v1", data: { version: 1, sessionScopeId: scope, batchId: id, state } });
  assert.deepEqual(scanLegacyProcessBatchesV1([orphan, settled, status("orphan", "turn-settled", "other"), status("settled", "pending"), status("settled", "turn-settled")], "session").map(v => [v.batch.batchId, v.state]), [["orphan", "orphan"], ["settled", "turn-settled"]]);
});
