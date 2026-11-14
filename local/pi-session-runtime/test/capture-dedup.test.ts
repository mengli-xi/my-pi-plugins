import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { acquireEffectiveCapture, contextFingerprint, getEffectiveContextStore, type EffectiveCaptureLease, type RequestCandidate } from "../src/effective-context.ts";

const model = { provider: "dedup-faux", id: "model" };
const messages = (): Message[] => [{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 }];
function candidate(auxiliaryMessages = messages()): RequestCandidate {
  return { selectedModel: model, thinkingLevel: "off", toolLoadoutFingerprint: "tools", capabilityFingerprint: "caps",
    leafId: "leaf", signal: new AbortController().signal, auxiliaryMessages,
    nativeOrigins: [{ message: auxiliaryMessages[0]!, kind: "turn", turnId: "leaf" }], knownPreamble: [] };
}

test("observers reuse only the unchanged private snapshot; rewrites, requests, revisions and generations rehash", (t) => {
  const sessionId = "capture-dedup";
  const binding = {};
  const first = acquireEffectiveCapture({ owner: "first", sessionId, binding });
  const second = acquireEffectiveCapture({ owner: "second", sessionId, binding });
  const store = getEffectiveContextStore();
  const hash = t.mock.method(crypto, "createHash");
  syncBuiltinESMExports();
  let replacement: EffectiveCaptureLease | undefined;
  const observe = (lease: EffectiveCaptureLease, input: RequestCandidate, hashes: number) => {
    const before = hash.mock.callCount();
    lease.observe(input);
    assert.equal(hash.mock.callCount() - before, hashes);
  };
  const confirm = (lease: EffectiveCaptureLease, input: RequestCandidate, ordinal: number) => {
    const provider: any = { streamSimple() { lease.confirmRequest(input.signal); return {}; } };
    lease.refreshProviders({ getRegisteredProviderIds: () => [model.provider], getAll: () => [], getProvider: () => provider });
    provider.streamSimple(model, normalizeContext({ messages: input.auxiliaryMessages as Message[] }), { sessionId, signal: input.signal });
    const capture = store.get(sessionId, lease.generation)!;
    assert.equal(capture.requestOrdinal, ordinal);
    assert.equal(capture.contextCandidateHash, contextFingerprint(input.auxiliaryMessages));
    return capture;
  };
  try {
    const input = candidate();
    observe(first, input, 1);
    const revision = store.revision(sessionId);
    // A different array with identical contents also deduplicates, not just one object.
    observe(second, { ...input, auxiliaryMessages: structuredClone(input.auxiliaryMessages) }, 0);
    assert.equal(store.revision(sessionId), revision);
    confirm(first, input, 1);

    // The same observer represents a new request even with unchanged signal/leaf/messages.
    observe(first, input, 1);
    assert.equal(store.get(sessionId, first.generation), undefined);
    // An in-place nested edit between observers cannot reuse the old snapshot's hash.
    (input.auxiliaryMessages[0] as any).content[0].text = "rewritten";
    observe(second, input, 1);
    assert.equal(store.revision(sessionId), revision + 2);
    const rewritten = confirm(second, input, 3);
    assert.match(JSON.stringify(rewritten.normalizedMessages), /rewritten/);

    const next = { ...input, signal: new AbortController().signal };
    observe(first, next, 1);
    observe(second, next, 0);
    confirm(first, next, 4);
    store.invalidate(sessionId, "projection-reset");
    observe(first, next, 1);
    confirm(first, next, 5);
    first.endRequest();
    observe(second, next, 1);
    confirm(second, next, 6);

    replacement = acquireEffectiveCapture({ owner: "replacement", sessionId, binding: {} });
    assert.notEqual(replacement.generation, first.generation);
    observe(first, next, 0); // Retired generation cannot populate the replacement.
    observe(replacement, next, 1);
    confirm(replacement, next, 1);
    assert.equal(store.get(sessionId, first.generation), undefined);
  } finally {
    replacement?.retire(); first.release(); second.release();
    hash.mock.restore(); syncBuiltinESMExports();
  }
});

test("strict snapshot comparison preserves the canonical dedup fallback", () => {
  const sessionId = "capture-canonical-dedup";
  const binding = {};
  const first = acquireEffectiveCapture({ owner: "first", sessionId, binding });
  const second = acquireEffectiveCapture({ owner: "second", sessionId, binding });
  const store = getEffectiveContextStore();
  try {
    const input = candidate();
    first.observe(input);
    const revision = store.revision(sessionId);
    const equivalent = structuredClone(input.auxiliaryMessages) as any[];
    equivalent[0].optional = undefined;
    second.observe({ ...input, auxiliaryMessages: equivalent });
    assert.equal(store.revision(sessionId), revision);
    // Auxiliary extension data may be hashable but not structured-cloneable.
    const uncloneable = { ...input, auxiliaryMessages: [...input.auxiliaryMessages, { callback() {} }] };
    first.observe(uncloneable);
    const nextRevision = store.revision(sessionId);
    second.observe(uncloneable);
    assert.equal(store.revision(sessionId), nextRevision);
  } finally { first.release(); second.release(); }
});
