import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneJson, parseMailboxSnapshot } from "../src/mailbox-v1/validation.js";
import type { Mail, MailboxSnapshot, NativeEntryRef, PendingRecord, RecordedNotification, TerminalRecord } from "../src/mailbox-v1/types.js";

const sessionId = "validation-session";
function mail(): Mail {
  return {
    producer: "pi-processes", key: "validation-mail", anchorEntryId: null, policy: "next-request", wake: false,
    messages: [
      { customType: "fixture", content: "first", display: false },
      { customType: "fixture", content: "second", display: false },
    ],
  };
}
function entries(): NativeEntryRef[] {
  return [{ messageIndex: 0, entryId: "native-first" }, { messageIndex: 1, entryId: "native-second" }];
}
function recorded(): RecordedNotification {
  return {
    notice: { producer: "pi-processes", key: "validation-mail", scope: { sessionId, anchorEntryId: null }, recordedToken: "recorded-token", entries: entries() },
    ack: "pending",
  };
}
function pending(): PendingRecord {
  return { ...mail(), acceptedRevision: 1, requiredCallbacks: { recorded: true, terminal: true }, branchEntryId: null, nativeEntries: entries(), recorded: recorded() };
}
function fulfilled(): TerminalRecord {
  return {
    mail: mail(), branchEntryId: null, requiredCallbacks: { recorded: true, terminal: true }, recorded: recorded(), terminalAck: "pending", backingReceiptEntryId: null,
    evidence: {
      producer: "pi-processes", key: "validation-mail", terminalId: "terminal-token", scope: { sessionId, anchorEntryId: null }, outcome: "fulfilled",
      receiptEntryId: "receipt-entry", assistantEntryId: "assistant-entry", nativeEntryIds: ["native-first", "native-second"],
    },
  };
}
function snapshot(pending: readonly PendingRecord[] = [], terminal: readonly TerminalRecord[] = []): MailboxSnapshot {
  return { version: 1, session: { id: sessionId, file: null }, revision: 1, suspended: null, pending, terminal };
}

test("plain JSON arrays and frozen snapshots remain lossless independent clones", () => {
  const plain = [null, true, 3, "text", [], Object.assign(Object.create(null), { nested: [1, 2] })];
  Object.freeze(plain);
  const clone = cloneJson(plain);
  assert.deepEqual(clone, [null, true, 3, "text", [], { nested: [1, 2] }]);
  assert.notEqual(clone, plain);
  const parsed = parseMailboxSnapshot(snapshot([pending()]));
  assert.deepEqual(parseMailboxSnapshot(parsed), parsed);
  assert.ok(Object.isFrozen(parsed.pending[0]!.messages));
});

for (const decoration of ["hidden", "toJSON", "symbol", "iterator", "iterator-function", "index-accessor", "hidden-index"] as const) {
  test(`cloneJson rejects array ${decoration} without executing user code`, () => {
    let calls = 0;
    const value = ["original"];
    const execute = () => { calls++; return "replacement"; };
    if (decoration === "hidden") Object.defineProperty(value, "hidden", { value: 1 });
    if (decoration === "toJSON") Object.defineProperty(value, "toJSON", { value: execute });
    if (decoration === "symbol") Object.defineProperty(value, Symbol("hidden"), { value: true });
    if (decoration === "iterator") Object.defineProperty(value, Symbol.iterator, { get: execute });
    if (decoration === "iterator-function") Object.defineProperty(value, Symbol.iterator, { value: execute });
    if (decoration === "index-accessor") Object.defineProperty(value, "0", { get: execute, enumerable: true });
    if (decoration === "hidden-index") Object.defineProperty(value, "0", { value: "original", enumerable: false });
    const descriptors = Object.getOwnPropertyDescriptors(value);
    assert.throws(() => cloneJson(value), { code: "conflict" });
    assert.equal(calls, 0);
    assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors);
  });
}

test("cloneJson rejects sparse, decorated and nonstandard-prototype arrays", () => {
  const sparse = Array(1);
  const compensated = Object.assign(Array(1), { extra: "not index zero" });
  const decorated = Object.assign([1], { extra: true });
  const nullPrototype = Object.setPrototypeOf([1], null);
  class CustomArray extends Array {}
  for (const value of [sparse, compensated, decorated, nullPrototype, new CustomArray(1)])
    assert.throws(() => cloneJson(value), { code: "conflict" });
});

test("cloneJson refuses inherited array toJSON without invoking it", () => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  let calls = 0;
  try {
    Object.defineProperty(Array.prototype, "toJSON", { configurable: true, get: () => { calls++; return () => []; } });
    assert.throws(() => cloneJson(["original"]), { code: "conflict" });
    assert.equal(calls, 0);
  } finally {
    if (previous) Object.defineProperty(Array.prototype, "toJSON", previous);
    else Reflect.deleteProperty(Array.prototype, "toJSON");
  }
});

test("pending recorded proof must match nativeEntries by messageIndex", () => {
  const value = pending();
  assert.doesNotThrow(() => parseMailboxSnapshot(snapshot([{ ...value, nativeEntries: [...entries()].reverse() }])));
  for (const mismatched of [
    [{ messageIndex: 0, entryId: "wrong-entry" }, entries()[1]!],
    [{ messageIndex: 0, entryId: "native-second" }, { messageIndex: 1, entryId: "native-first" }],
    [entries()[0]!],
  ]) {
    assert.throws(() => parseMailboxSnapshot(snapshot([{ ...value, nativeEntries: mismatched }])), { code: "conflict" });
  }
  const notice = value.recorded!.notice;
  assert.throws(() => parseMailboxSnapshot(snapshot([{ ...value, recorded: { ...value.recorded!, notice: { ...notice, entries: [{ ...entries()[0]!, entryId: "changed-notice" }, entries()[1]!] } } }])), { code: "conflict" });
});

test("fulfilled nativeEntryIds correspond to recorded messageIndex, not proof array order", () => {
  const value = fulfilled();
  const reordered = { ...value, recorded: { ...value.recorded!, notice: { ...value.recorded!.notice, entries: entries().reverse() } } };
  assert.doesNotThrow(() => parseMailboxSnapshot(snapshot([], [reordered])));
  const evidence = value.evidence;
  assert.equal(evidence.outcome, "fulfilled");
  if (evidence.outcome !== "fulfilled") throw new Error("fixture must be fulfilled");
  for (const nativeEntryIds of [["wrong-entry", "native-second"], ["native-second", "native-first"]]) {
    assert.throws(() => parseMailboxSnapshot(snapshot([], [{ ...value, evidence: { ...evidence, nativeEntryIds } }])), { code: "conflict" });
  }
});

test("legacy import accepts proof ordering differences but rejects inconsistent IDs", () => {
  const value = pending();
  const legacyImport = {
    proof: { sourceReceiptEntryId: "source-entry", assistantEntryId: "assistant-entry" },
    evidence: {
      producer: value.producer, key: value.key, terminalId: "legacy-terminal", scope: { sessionId, anchorEntryId: null },
      outcome: "fulfilled" as const, assistantEntryId: "assistant-entry", nativeEntryIds: ["native-first", "native-second"],
    },
  };
  const imported = { ...value, nativeEntries: entries().reverse(), legacyImport };
  assert.doesNotThrow(() => parseMailboxSnapshot(snapshot([imported])));
  assert.throws(() => parseMailboxSnapshot(snapshot([{ ...imported, legacyImport: { ...legacyImport, evidence: { ...legacyImport.evidence, nativeEntryIds: ["native-second", "native-first"] } } }])), { code: "conflict" });
});

test("cancelled superseded notifications and old snapshots without optional proofs stay valid", () => {
  const value = fulfilled();
  const cancelled: TerminalRecord = {
    ...value, recorded: { ...recorded(), ack: "superseded-by-cancel" },
    evidence: { producer: "pi-processes", key: "validation-mail", terminalId: "cancelled-token", scope: { sessionId, anchorEntryId: null }, outcome: "cancelled", reason: "cancelled fixture" },
  };
  assert.doesNotThrow(() => parseMailboxSnapshot(snapshot([], [cancelled])));
  assert.doesNotThrow(() => parseMailboxSnapshot(snapshot([{ ...pending(), nativeEntries: [], recorded: null }])));
  assert.doesNotThrow(() => parseMailboxSnapshot(snapshot([], [{ ...value, recorded: null, requiredCallbacks: { recorded: false, terminal: true } }])));
  assert.throws(() => parseMailboxSnapshot(snapshot([], [{ ...value, recorded: { ...recorded(), ack: "superseded-by-cancel" } }])), { code: "conflict" });
});
