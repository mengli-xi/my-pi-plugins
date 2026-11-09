import assert from "node:assert/strict";
import test from "node:test";

import { createProcessNotificationReceiptEnvelopeV1, createProcessTuiEntryEnvelopeV1 } from "../../src/notifications/broker.ts";
import { appendNotificationEntryV1 } from "../../src/notifications/tui-projection.ts";

function data(name = "demo") {
  return { version: 2, kind: "watch-match", process: { id: "proc_demo000001", name }, text: "ready", eventSequence: 1 };
}

function harness(initial: unknown[] = []) {
  const entries = [...initial];
  let appends = 0;
  return {
    entries,
    get appends() { return appends; },
    pi: {
      appendEntry(customType: string, value: unknown) {
        appends += 1;
        entries.push({ type: "custom", customType, data: value });
      },
    },
    ctx: { sessionManager: { getBranch: () => entries, getLeafEntry: () => entries.at(-1) } },
  };
}

function delivery(value = data()) {
  const envelope = createProcessTuiEntryEnvelopeV1(value);
  return { deliveryId: "tui:" + "a".repeat(64), customType: envelope.customType, data: value, dataSha256: envelope.dataSha256 } as const;
}

test("TUI projection appends once and a reload replay reuses the durable entry", () => {
  const state = harness();
  const value = delivery();
  appendNotificationEntryV1(state.pi as never, state.ctx as never, value);
  appendNotificationEntryV1(state.pi as never, state.ctx as never, value);
  assert.equal(state.appends, 1);
});

test("blocking receipt projection appends once and survives replacement replay", () => {
  const value = { version: 1, transactionId: "lease:offer:1", factId: "session:host:1", sessionScopeId: "session", target: { strategy: "child", scopeToken: "owner" }, processId: "proc_demo000001" };
  const envelope = createProcessNotificationReceiptEnvelopeV1(value);
  const delivery = { deliveryId: `receipt:${envelope.dataSha256}`, customType: envelope.customType, data: value, dataSha256: envelope.dataSha256 } as const;
  const state = harness();
  appendNotificationEntryV1(state.pi as never, state.ctx as never, delivery);
  appendNotificationEntryV1(state.pi as never, state.ctx as never, delivery);
  assert.equal(state.appends, 1);
});

test("TUI projection rejects changed data and ignores foreign or malformed branch entries", () => {
  const value = delivery();
  assert.throws(
    () => appendNotificationEntryV1(harness().pi as never, harness().ctx as never, { ...value, data: data("changed") }),
    /envelope changed/,
  );
  const state = harness([
    { type: "custom", customType: "other", data: value.data },
    { type: "custom", customType: "process-event-v2", data: { version: 999 } },
  ]);
  appendNotificationEntryV1(state.pi as never, state.ctx as never, value);
  assert.equal(state.appends, 1);
});
