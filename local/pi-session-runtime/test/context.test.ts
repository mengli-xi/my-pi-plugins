import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, normalizeContext, type Message } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  acquireEffectiveCapture, contextFingerprint, getEffectiveContextStore, mapEffectiveTurns,
  requiresEffectiveCapture, EffectiveContextStore, type ContextIdentity, type EffectiveCapture, type NativeMessageOrigin, type RequestCandidate,
} from "../src/effective-context.ts";
import { buildNativeChildSnapshot, describeNativeContext, EffectiveContextUnavailableError, selectEffectiveContext, stableMessagePrefix, writeNativeChildSnapshot } from "../src/native-child-context.ts";

const stamp = "2026-10-15T00:00:00.000Z";
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const answer = (text: string) => fauxAssistantMessage(text);
function branchOf(messages: Message[]): SessionEntry[] { return messages.map((message, index) => ({ type: "message", message, id: `e${index}`, parentId: index ? `e${index - 1}` : null, timestamp: stamp })); }
function append(branch: SessionEntry[], payload: Record<string, unknown>): SessionEntry {
  const entry = { ...payload, id: `e${branch.length}`, parentId: branch.at(-1)?.id ?? null, timestamp: stamp } as SessionEntry;
  branch.push(entry); return entry;
}
const identity: ContextIdentity = { sessionId: "parent", generation: 1, selectedModel: { provider: "faux", id: "m" }, thinkingLevel: "off", toolLoadoutFingerprint: "tools", capabilityFingerprint: "caps" };
function capture(branch: SessionEntry[], messages = describeNativeContext(branch).map((origin) => origin.message), preambles: Message[] = []): EffectiveCapture {
  return { ...identity, requestOrdinal: 1, leafId: branch.at(-1)?.id ?? null, physicalModel: identity.selectedModel, normalizedMessages: messages, contextCandidateHash: "hash", normalizedRequestHash: contextFingerprint(messages), capturedAt: 1, wirePrefix: "unknown", ...mapEffectiveTurns(messages, describeNativeContext(branch), preambles) };
}
function select(branch: SessionEntry[], mode: "none" | "all" | `${number}`, observed?: EffectiveCapture, requiresCapture = false) {
  return selectEffectiveContext({ identity, branch, mode, capture: observed, requiresCapture });
}

test("none/N/all use one effective projection through repeated/self-retaining compaction, edits and rich tools", async () => {
  for (const selfRetaining of [false, true]) {
    const branch = branchOf([user("discarded original"), answer("old answer"), user("kept turn"), answer("kept answer")]);
    append(branch, { type: "compaction", summary: "first", firstKeptEntryId: "e2", tokensBefore: 4000 });
    const recent = append(branch, { type: "message", message: user("recent turn") });
    append(branch, { type: "message", message: answer("un-edited") });
    append(branch, { type: "context_edit", targetId: "e6", replacement: { content: [{ type: "text", text: "edited answer" }] } });
    const second = append(branch, { type: "compaction", summary: "second effective summary", firstKeptEntryId: selfRetaining ? "e8" : recent.id, tokensBefore: 8000 });
    assert.equal(second.id, "e8");
    append(branch, { type: "message", message: user("latest complete turn") });
    const calls = answer("unused");
    calls.content = [{ type: "thinking", thinking: "reasoning", thinkingSignature: "signed" }, { type: "toolCall", id: "one", name: "read", arguments: {} }, { type: "toolCall", id: "two", name: "read", arguments: {} }];
    calls.stopReason = "toolUse";
    append(branch, { type: "message", message: calls });
    for (const id of ["two", "one"]) append(branch, { type: "message", message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: id }], timestamp: 2, isError: false, nestedCalls: [{ toolName: "nested", toolCallId: "nested-id", details: { a: 1 } }], usage: calls.usage } });
    append(branch, { type: "message", message: answer("latest final") });
    const dir = await mkdtemp(join(tmpdir(), "effective-matrix-"));
    try {
      const effective = describeNativeContext(branch).map((origin) => origin.message);
      const observed = capture(branch);
      // The currently executing spawn batch is persisted but has no tool result yet.
      append(branch, { type: "message", message: user("spawn now") });
      const spawn = answer(""); spawn.content = [{ type: "toolCall", id: "spawn", name: "spawn_agent", arguments: {} }]; spawn.stopReason = "toolUse";
      append(branch, { type: "message", message: spawn });
      for (const source of [undefined, observed]) for (const mode of ["none", "1", "2", "all"] as const) {
        const selection = select(branch, mode, source);
        if (mode === "none") assert.deepEqual(selection.messages, []);
        if (mode === "all") assert.deepEqual(selection.messages, [...effective, user("spawn now")]);
        if (mode === "1") {
          assert.match(JSON.stringify(selection.messages), /latest complete turn/);
          assert.doesNotMatch(JSON.stringify(selection.messages), /recent turn|spawn now|un-edited/);
          assert.match(JSON.stringify(selection.messages), /second effective summary/);
        }
        const snapshot = buildNativeChildSnapshot({ selection, cwd: dir, boundary: { customType: "test", content: "boundary" } });
        assert.notEqual(snapshot.header.id, identity.sessionId);
        assert.ok(snapshot.inheritedEntryIds.every((id) => !branch.some((entry) => entry.id === id)));
        assert.deepEqual(snapshot.entries.filter((entry) => snapshot.inheritedEntryIds.includes(entry.id)).map((entry) => entry.type === "message" && entry.message), selection.messages);
        const path = join(dir, `${source ? "capture" : "native"}-${mode}`, "seed.jsonl"); await writeNativeChildSnapshot(path, snapshot);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const opened = SessionManager.open(path);
        assert.deepEqual(opened.buildSessionProjection().messages.slice(0, selection.messages.length), selection.messages);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("capture is authoritative: removed native text never returns and uncertain N never guesses", () => {
  const branch = branchOf([user("RAW_ONLY"), answer("old"), user("retained"), answer("new")]);
  const messages = [{ role: "system", content: "effective memory", timestamp: 0 } as Message, ...describeNativeContext(branch).slice(2).map((origin) => origin.message)];
  const observed = capture(branch, messages);
  assert.deepEqual(select(branch, "all", observed, true).messages, messages);
  assert.doesNotMatch(JSON.stringify(select(branch, "2", observed, true).messages), /RAW_ONLY/);
  const unknown = capture(branch, [user("rewritten user"), answer("rewritten answer")]);
  assert.throws(() => select(branch, "1", unknown, true), (error: unknown) => error instanceof EffectiveContextUnavailableError && error.reason.includes("turn-mapping"));
  assert.deepEqual(select(branch, "all", unknown, true).messages, unknown.normalizedMessages);
  assert.throws(() => select(branch, "all", undefined, true), /effective-context-unavailable/);
  assert.deepEqual(select(branch, "none", undefined, true).messages, []);
});

test("pending/missing/mismatched/duplicate tool batches have one maximal stable prefix", () => {
  const call = answer(""); call.stopReason = "toolUse"; call.content = [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "read", arguments: {} }];
  const result = (id: string, name = "read"): Message => ({ role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false, timestamp: 2 });
  const prefix = [user("good"), answer("complete")];
  const pending = answer("partial"); pending.stopReason = "pending";
  for (const suffix of [[pending], [call], [call, result("a")], [call, result("a", "wrong")], [call, result("a"), result("b"), result("b")], [result("orphan")], [call, answer("unexpected")]]) {
    assert.deepEqual(stableMessagePrefix([...prefix, ...suffix]), prefix);
  }
  assert.deepEqual(stableMessagePrefix([...prefix, call, result("b"), result("a")]), [...prefix, call, result("b"), result("a")]);
});

test("capture validity covers generation, branch resets, fingerprints and native-only fallback", () => {
  const branch = branchOf([user("request")]); const observed = capture(branch);
  for (const changed of [{ generation: 2 }, { thinkingLevel: "high" }, { selectedModel: { provider: "other", id: "model" } }, { toolLoadoutFingerprint: "drift" }, { capabilityFingerprint: "drift" }]) {
    assert.throws(() => selectEffectiveContext({ identity: { ...identity, ...changed }, branch, capture: observed, mode: "all", requiresCapture: true }), /effective-context-unavailable/);
  }
  assert.throws(() => select([], "all", observed, true), /capture-not-on-branch/);
  for (const payload of [{ type: "compaction", firstKeptEntryId: "e0", summary: "s", tokensBefore: 1 }, { type: "context_edit", targetId: "e0", replacement: null }, { type: "branch_summary", fromId: "other", summary: "s" }]) {
    const changed = structuredClone(branch); append(changed, payload);
    assert.throws(() => select(changed, "all", observed, true), /projection-changed/);
    assert.equal(select(changed, "all", observed).source, "native-projection");
  }
  assert.equal(requiresEffectiveCapture({ requestTransforms: "unknown" }), true);
  assert.equal(requiresEffectiveCapture({ requestTransforms: "native-only" }), false);
});

test("R1: a later transformed request revokes native-only fallback, including after invalidation", () => {
  const branch = branchOf([user("RAW_OLD_BODY"), answer("old answer"), user("recent user")]);
  const origins = describeNativeContext(branch);
  const store = new EffectiveContextStore(); store.bind(identity.sessionId, identity.generation);
  const first = capture(branch);
  store.put(first, store.revision(identity.sessionId), origins);
  assert.equal(store.requestTransforms(identity.sessionId, identity.generation, identity.capabilityFingerprint), "native-only");
  const summary = user("COMPRESSED_SUMMARY");
  const second = { ...capture(branch, [summary, user("recent user")], [summary]), requestOrdinal: 2 };
  store.put(second, store.revision(identity.sessionId), origins);
  assert.equal(store.requestTransforms(identity.sessionId, identity.generation, identity.capabilityFingerprint), "transformed");
  append(branch, { type: "context_edit", targetId: "e1", replacement: null });
  const required = () => requiresEffectiveCapture({ requestTransforms: store.requestTransforms(identity.sessionId, identity.generation, identity.capabilityFingerprint) });
  assert.throws(() => select(branch, "all", store.get(identity.sessionId, identity.generation), required()), /projection-changed/);
  store.invalidate(identity.sessionId, "native-compaction");
  assert.equal(store.requestTransforms(identity.sessionId, identity.generation, identity.capabilityFingerprint), "unknown");
  assert.throws(() => select(branch, "all", undefined, required()), /effective-context-unavailable/);
});

test("R3: compressed parent seed reopens and recaptures with summary/memory provenance for a second numeric fork", async () => {
  const branch = branchOf([user("old"), answer("old answer"), user("inherited latest"), answer("inherited answer")]);
  append(branch, { type: "compaction", firstKeptEntryId: "e2", summary: "ESSENTIAL_SUMMARY", tokensBefore: 4000 });
  const memory = user("SYNTHETIC_MEMORY");
  const parentCapture = capture(branch, [memory, ...describeNativeContext(branch).map((origin) => origin.message)], [memory]);
  const selected = select(branch, "1", parentCapture, true);
  assert.equal(selected.preambleMessageIndices.length, 2);
  const dir = await mkdtemp(join(tmpdir(), "effective-provenance-"));
  const seed = buildNativeChildSnapshot({ selection: selected, cwd: dir, boundary: { customType: "child-boundary", content: "inherited reference context" } });
  const file = join(dir, "child.jsonl");
  try {
    await writeNativeChildSnapshot(file, seed);
    const child = SessionManager.open(file);
    child.appendMessage(user("child latest")); child.appendMessage(answer("child answer"));
    const origins = describeNativeContext(child.getBranch());
    const messages = origins.map((origin) => origin.message);
    const provider: any = { streamSimple(_model: unknown, _context: unknown, options: any) { options.onResponse(); return {}; } };
    const lease = acquireEffectiveCapture({ owner: "child", sessionId: child.getSessionId(), binding: child });
    const signal = new AbortController().signal;
    const childIdentity = { ...identity, sessionId: child.getSessionId(), generation: lease.generation };
    try {
      lease.observe({ ...childIdentity, leafId: child.getLeafId(), signal, auxiliaryMessages: messages, nativeOrigins: origins, knownPreamble: [] });
      lease.refreshProviders({ getRegisteredProviderIds: () => ["faux"], getAll: () => [], getProvider: () => provider });
      provider.streamSimple(identity.selectedModel, normalizeContext({ messages }), { sessionId: childIdentity.sessionId, signal, onResponse: () => lease.confirmRequest(signal) });
      const observed = getEffectiveContextStore().get(childIdentity.sessionId, childIdentity.generation)!;
      assert.ok(observed); assert.equal(observed.turnMappingReliable, true);
      assert.equal(observed.turnAnchors.some((anchor) => anchor.entryId === seed.boundaryId), false);
      assert.ok(observed.attachedMessageIndices.some((index) => JSON.stringify(observed.normalizedMessages[index]).includes("inherited reference context")));
      for (const source of [undefined, observed]) {
        const next = selectEffectiveContext({ mode: "1", identity: childIdentity, branch: child.getBranch(), capture: source, requiresCapture: !!source });
        const text = JSON.stringify(next.messages);
        assert.match(text, /ESSENTIAL_SUMMARY/); assert.match(text, /SYNTHETIC_MEMORY/);
        assert.match(text, /child latest/); assert.doesNotMatch(text, /inherited latest|inherited reference context/);
        const grandchild = buildNativeChildSnapshot({ selection: next, cwd: dir, boundary: { customType: "next-boundary", content: "next reference boundary" } });
        assert.ok(grandchild.entries.every((entry) => !seed.entries.some((prior) => prior.id === entry.id)));
        assert.match(JSON.stringify(selectEffectiveContext({ mode: "1", identity, branch: grandchild.entries, requiresCapture: false }).messages), /ESSENTIAL_SUMMARY/);
      }
    } finally { lease.retire(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("R4: numeric forks discard older bash/custom turns while retaining only explicit summary/memory preambles", () => {
  const branch = branchOf([user("old raw"), answer("old raw answer")]);
  append(branch, { type: "compaction", firstKeptEntryId: "e2", summary: "ESSENTIAL_PREAMBLE", tokensBefore: 100 });
  append(branch, { type: "message", message: { role: "bashExecution", command: "echo old", output: "OLD_BASH_OUTPUT", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 } });
  append(branch, { type: "message", message: answer("old bash answer") });
  append(branch, { type: "custom_message", customType: "business-input", content: "OLD_CUSTOM_BODY", display: false });
  append(branch, { type: "message", message: answer("old custom answer") });
  append(branch, { type: "message", message: user("latest user") });
  append(branch, { type: "message", message: answer("latest answer") });
  const memory = user("PERSISTENT_MEMORY");
  const observed = capture(branch, [memory, ...describeNativeContext(branch).map((origin) => origin.message)], [memory]);
  for (const source of [undefined, observed]) {
    const text = JSON.stringify(select(branch, "1", source).messages);
    assert.match(text, /ESSENTIAL_PREAMBLE/); assert.match(text, /latest user/);
    assert.doesNotMatch(text, /OLD_BASH_OUTPUT|OLD_CUSTOM_BODY/);
    if (source) assert.match(text, /PERSISTENT_MEMORY/);
  }
  const customOnly: SessionEntry[] = [];
  append(customOnly, { type: "custom_message", customType: "business", content: "first custom", display: false });
  append(customOnly, { type: "message", message: answer("first response") });
  append(customOnly, { type: "custom_message", customType: "business", content: "latest custom", display: false });
  append(customOnly, { type: "message", message: answer("latest response") });
  const text = JSON.stringify(select(customOnly, "1").messages);
  assert.match(text, /latest custom/); assert.doesNotMatch(text, /first custom|first response/);
});

test("duplicate native identity refuses numeric N instead of picking one turn", () => {
  const request = user("same request");
  const origin = (kind: "turn" | "preamble" | "body", turnId: string): NativeMessageOrigin => ({ message: request, kind, turnId });
  // Two candidate turns, or a turn colliding with a retained preamble or attached body, are ambiguous.
  assert.equal(mapEffectiveTurns([request], [origin("turn", "first"), origin("turn", "second")]).turnMappingReliable, false);
  assert.equal(mapEffectiveTurns([request], [origin("turn", "only"), origin("preamble", "pre")]).turnMappingReliable, false);
  assert.equal(mapEffectiveTurns([request], [origin("turn", "only"), origin("body", "body")]).turnMappingReliable, false);
  assert.equal(mapEffectiveTurns([request], [origin("body", "left"), origin("body", "right")]).turnMappingReliable, false);
  // Repeated native preamble copies stay a retained preamble rather than becoming a turn.
  const preambleOnly = mapEffectiveTurns([request], [origin("preamble", "left"), origin("preamble", "right")]);
  assert.equal(preambleOnly.turnMappingReliable, true);
  assert.deepEqual(preambleOnly.turnAnchors, []);
  assert.deepEqual(preambleOnly.preambleMessageIndices, [0]);
});

test("a repeated request identity cannot reuse one native turn", () => {
  const request = user("repeated");
  const origins: NativeMessageOrigin[] = [{ message: request, kind: "turn", turnId: "e0" }];
  const mapping = mapEffectiveTurns([request, request], origins);
  assert.equal(mapping.turnMappingReliable, false);
  assert.deepEqual(mapping.turnAnchors, [{ entryId: "e0", messageIndex: 0 }]);
});

test("multi-block user content maps one turn only while every part stays byte-identical", () => {
  const rich = { role: "user", timestamp: 3, content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "second" }] } as Message;
  const origins: NativeMessageOrigin[] = [{ message: rich, kind: "turn", turnId: "rich" }];
  const mapping = mapEffectiveTurns([rich], origins);
  assert.equal(mapping.turnMappingReliable, true);
  assert.deepEqual(mapping.turnAnchors, [{ entryId: "rich", messageIndex: 0 }]);
  const changedImage = structuredClone(rich) as any;
  changedImage.content[0].data = "Y2hhbmdlZA==";
  assert.equal(mapEffectiveTurns([changedImage], origins).turnMappingReliable, false);
  const signed = structuredClone(rich) as any;
  signed.content[1].textSignature = "added metadata";
  assert.equal(mapEffectiveTurns([signed], origins).turnMappingReliable, false);
});

test("two identical requests against two identical native turns refuse instead of pairing", () => {
  const request = user("same request");
  const origins: NativeMessageOrigin[] = [{ message: request, kind: "turn", turnId: "e0" }, { message: request, kind: "turn", turnId: "e1" }];
  const mapping = mapEffectiveTurns([request, request], origins);
  assert.equal(mapping.turnMappingReliable, false);
  assert.deepEqual(mapping.turnAnchors, []);
});

test("a compaction entry with unknown details does not by itself require capture", () => {
  const branch = branchOf([user("kept turn"), answer("kept answer")]);
  append(branch, { type: "compaction", firstKeptEntryId: "e0", summary: "summary from an unknown producer", tokensBefore: 4000, details: { source: "fixture-compaction-producer" } });
  append(branch, { type: "message", message: answer("latest answer") });
  assert.equal(requiresEffectiveCapture({ requestTransforms: "native-only" }), false);
  const all = select(branch, "all", undefined, false);
  assert.equal(all.source, "native-projection");
  assert.equal(all.exactRequestPrefix, false);
  assert.match(JSON.stringify(all.messages), /summary from an unknown producer/);
  assert.match(JSON.stringify(select(branch, "1", undefined, false).messages), /kept turn|latest answer/);
});

test("provider ownership, one-shot request fence, frozen candidate leaf and structural invalidation", () => {
  const received: unknown[] = []; const returned = {};
  const provider: any = { streamSimple(this: unknown, model: unknown, context: unknown, options: any) { received.push({ receiver: this, model, context, options }); options?.onResponse?.(); return returned; } };
  const original = provider.streamSimple;
  let currentProvider = provider;
  const registry: any = { getRegisteredProviderIds: () => [], getAll: () => [identity.selectedModel], getProvider: () => currentProvider };
  const binding = {};
  const one = acquireEffectiveCapture({ owner: "main", sessionId: identity.sessionId, binding });
  const two = acquireEffectiveCapture({ owner: "side", sessionId: identity.sessionId, binding });
  assert.equal(one.generation, two.generation);
  const store = getEffectiveContextStore();
  const controller = new AbortController();
  const branch = branchOf([user("request")]);
  const messages = describeNativeContext(branch).map((origin) => origin.message);
  const candidate: RequestCandidate = { ...identity, leafId: "e0", signal: controller.signal, auxiliaryMessages: messages, nativeOrigins: describeNativeContext(branch), knownPreamble: [] };
  one.observe(candidate); one.refreshProviders(registry); two.refreshProviders(registry);
  const options = { sessionId: identity.sessionId, signal: controller.signal, apiKey: "DO_NOT_STORE", headers: { secret: "DO_NOT_STORE" }, onResponse: () => one.confirmRequest(controller.signal) };
  const request = normalizeContext({ messages });
  // Same session and body but a cache warmer's own signal cannot consume the candidate.
  provider.streamSimple(identity.selectedModel, request, { ...options, signal: new AbortController().signal });
  assert.equal(store.get(identity.sessionId, one.generation), undefined);
  provider.streamSimple(identity.selectedModel, request, { ...options, onResponse: undefined });
  provider.streamSimple(identity.selectedModel, normalizeContext({ messages: [user("direct summary with reused Main metadata"), ...messages] }), { ...options, onResponse: undefined });
  one.confirmRequest(controller.signal); // No provider async scope: cannot confirm an arbitrary call.
  assert.equal(store.get(identity.sessionId, one.generation), undefined);
  assert.equal(provider.streamSimple(identity.selectedModel, request, options), returned);
  let observed = store.get(identity.sessionId, one.generation)!;
  assert.deepEqual(observed.normalizedMessages, request.messages);
  assert.doesNotMatch(JSON.stringify(observed), /DO_NOT_STORE/);
  assert.equal((received.at(-1) as any).options, options);
  assert.equal((received.at(-1) as any).receiver, provider);
  // BTW/summary and replaying a consumed business signal do not overwrite capture.
  provider.streamSimple(identity.selectedModel, normalizeContext({ messages: [user("summary")] }), options);
  assert.deepEqual(store.get(identity.sessionId, one.generation), observed);
  one.observe(candidate); two.observe(candidate);
  assert.equal(store.get(identity.sessionId, one.generation), undefined);
  provider.streamSimple(identity.selectedModel, request, options);
  assert.equal(store.get(identity.sessionId, one.generation)!.requestOrdinal, observed.requestOrdinal + 1);
  one.observe({ ...candidate, leafId: "later" });
  provider.streamSimple(identity.selectedModel, request, options);
  observed = store.get(identity.sessionId, one.generation)!; assert.equal(observed.leafId, "later");
  provider.streamSimple(identity.selectedModel, request, options);
  assert.deepEqual(store.get(identity.sessionId, one.generation), observed);
  // A structural reset arrives after the context hook but before provider auth completes.
  one.observe({ ...candidate, leafId: "later-2" });
  store.invalidate(identity.sessionId, "native-compaction");
  provider.streamSimple(identity.selectedModel, request, options);
  assert.equal(store.get(identity.sessionId, one.generation), undefined);
  one.release(); assert.notEqual(provider.streamSimple, original);
  two.release(); assert.equal(provider.streamSimple, original);
  const newer = acquireEffectiveCapture({ owner: "new", sessionId: identity.sessionId, binding: {} });
  newer.refreshProviders(registry); one.release(); assert.notEqual(provider.streamSimple, original);
  const foreign = function() { return returned; }; provider.streamSimple = foreign;
  newer.refreshProviders(registry); assert.notEqual(provider.streamSimple, foreign);
  currentProvider = { streamSimple: original }; newer.refreshProviders(registry);
  assert.equal(provider.streamSimple, foreign);
  newer.release(); assert.equal(currentProvider.streamSimple, original);
  const frozen = acquireEffectiveCapture({ owner: "frozen", sessionId: "frozen", binding: {} });
  currentProvider = Object.freeze({ streamSimple: original });
  assert.equal(frozen.refreshProviders(registry), false);
  assert.equal(store.reason("frozen"), "provider-not-decoratable"); frozen.release();
});

test("an external decorator retaining a retired wrapper preserves the new Main invocation", async () => {
  const sessionId = "foreign-wrapper";
  const lease = acquireEffectiveCapture({ owner: "main", sessionId, binding: {} });
  const signal = new AbortController().signal;
  const returned = {};
  const provider: any = { async streamSimple(_model: unknown, _context: unknown, options: any) {
    await Promise.resolve(); options.onResponse(); return returned;
  } };
  const registry: any = { getRegisteredProviderIds: () => ["faux"], getAll: () => [], getProvider: () => provider };
  const store = getEffectiveContextStore();
  const request = async (ordinal: number) => {
    const branch = branchOf([user(`Main ${ordinal}`)]);
    const messages = describeNativeContext(branch).map((origin) => origin.message);
    lease.observe({ ...identity, signal, leafId: `leaf-${ordinal}`, auxiliaryMessages: messages, nativeOrigins: describeNativeContext(branch), knownPreamble: [] });
    assert.equal(await provider.streamSimple(identity.selectedModel, normalizeContext({ messages }), {
      sessionId, signal, onResponse: () => lease.confirmRequest(signal),
    }), returned);
    const observed = store.get(sessionId, lease.generation);
    assert.ok(observed, store.reason(sessionId));
    assert.equal(observed.requestOrdinal, ordinal);
    assert.equal(observed.leafId, `leaf-${ordinal}`);
    assert.deepEqual(observed.normalizedMessages, messages);
  };
  try {
    lease.refreshProviders(registry);
    await request(1);
    const inner = provider.streamSimple;
    const foreign = function(this: unknown, ...args: unknown[]) { return inner.apply(this, args); };
    provider.streamSimple = foreign;
    lease.refreshProviders(registry);
    await request(2);
    lease.release();
    assert.equal(provider.streamSimple, foreign);
  } finally { lease.release(); }
});

test("composed external decorators survive repeated refresh and retire/reacquire without leaking Main scope", () => {
  const sessionId = "composed-wrappers";
  let lease = acquireEffectiveCapture({ owner: "main", sessionId, binding: {} });
  const first = lease;
  const signal = new AbortController().signal;
  const store = getEffectiveContextStore();
  const provider: any = { streamSimple(_model: unknown, _context: unknown, options: any) { options.onResponse(); return {}; } };
  const registry: any = { getRegisteredProviderIds: () => ["faux"], getAll: () => [], getProvider: () => provider };
  const calls = [0, 0, 0];
  let foreign = provider.streamSimple;
  const request = (ordinal: number) => {
    const branch = branchOf([user(`Main ${ordinal}`)]);
    const messages = describeNativeContext(branch).map((origin) => origin.message);
    lease.observe({ ...identity, signal, leafId: `leaf-${ordinal}`, auxiliaryMessages: messages, nativeOrigins: describeNativeContext(branch), knownPreamble: [] });
    provider.streamSimple(identity.selectedModel, normalizeContext({ messages }), { sessionId, signal, onResponse() {
      // An active wrapper with no matching invocation must still isolate a nested direct call.
      provider.streamSimple(identity.selectedModel, normalizeContext({ messages: [user("direct summary")] }), {
        sessionId, signal: new AbortController().signal, onResponse: () => lease.confirmRequest(signal),
      });
      assert.equal(store.get(sessionId, lease.generation), undefined);
      lease.confirmRequest(signal);
    } });
    const observed = store.get(sessionId, lease.generation);
    assert.ok(observed, store.reason(sessionId));
    assert.equal(observed.requestOrdinal, ordinal);
    assert.deepEqual(observed.normalizedMessages, messages);
  };
  try {
    lease.refreshProviders(registry);
    for (let index = 0; index < calls.length; index++) {
      const inner = provider.streamSimple;
      foreign = function(this: unknown, ...args: unknown[]) { calls[index]++; return inner.apply(this, args); };
      provider.streamSimple = foreign;
      lease.refreshProviders(registry);
      const activeWrapper = provider.streamSimple;
      lease.refreshProviders(registry); lease.refreshProviders(registry);
      assert.equal(provider.streamSimple, activeWrapper);
      request(index + 1);
    }
    first.retire();
    assert.equal(provider.streamSimple, foreign);
    lease = acquireEffectiveCapture({ owner: "replacement", sessionId, binding: {} });
    assert.notEqual(lease.generation, first.generation);
    lease.refreshProviders(registry); lease.refreshProviders(registry);
    first.release();
    request(1);
    assert.deepEqual(calls, [8, 6, 4]);
    lease.release();
    assert.equal(provider.streamSimple, foreign);
  } finally { first.release(); lease.release(); }
});

test("a new Main candidate with an identical prefix cannot resurrect a reply removed by its transformer", () => {
  const branch = branchOf([user("current request")]);
  const lease = acquireEffectiveCapture({ owner: "new-request", sessionId: "new-request", binding: {} });
  const signal = new AbortController().signal;
  const current = { ...identity, sessionId: "new-request", generation: lease.generation };
  const provider: any = { streamSimple(_model: unknown, _context: unknown, options: any) { options.onResponse(); return {}; } };
  lease.refreshProviders({ getRegisteredProviderIds: () => ["faux"], getAll: () => [], getProvider: () => provider });
  const request = () => {
    const messages = [user("current request")];
    lease.observe({ ...current, signal, leafId: branch.at(-1)!.id, auxiliaryMessages: messages, nativeOrigins: describeNativeContext(branch), knownPreamble: [] });
    provider.streamSimple(current.selectedModel, normalizeContext({ messages }), { sessionId: current.sessionId, signal, onResponse: () => lease.confirmRequest(signal) });
  };
  try {
    request();
    append(branch, { type: "message", message: answer("REMOVED_BY_REQUEST_TRANSFORM") });
    request();
    const observed = getEffectiveContextStore().get(current.sessionId, current.generation)!;
    assert.equal(observed.requestOrdinal, 2);
    assert.equal(observed.leafId, branch.at(-1)!.id);
    const result = selectEffectiveContext({ mode: "all", identity: current, branch, capture: observed, requiresCapture: true });
    assert.deepEqual(result.messages, [user("current request")]);
    assert.doesNotMatch(JSON.stringify(result.messages), /REMOVED_BY_REQUEST_TRANSFORM/);
  } finally { lease.retire(); }
});

test("shared public providers isolate sessions and stale owners cannot retire a replacement generation", () => {
  const provider: any = { streamSimple(_model: unknown, _context: unknown, options: any) { options?.onResponse?.(); return {}; } }; const original = provider.streamSimple;
  const registry: any = { getRegisteredProviderIds: () => ["faux"], getAll: () => [], getProvider: () => provider };
  const a = acquireEffectiveCapture({ owner: "a", sessionId: "a", binding: {} });
  const b = acquireEffectiveCapture({ owner: "b", sessionId: "b", binding: {} });
  const branch = branchOf([user("same body")]);
  const messages = describeNativeContext(branch).map((origin) => origin.message);
  const signalA = new AbortController().signal, signalB = new AbortController().signal;
  const candidate = { ...identity, leafId: "e0", auxiliaryMessages: messages, nativeOrigins: describeNativeContext(branch), knownPreamble: [] };
  a.observe({ ...candidate, signal: signalA }); b.observe({ ...candidate, signal: signalB }); a.refreshProviders(registry); b.refreshProviders(registry);
  provider.streamSimple(identity.selectedModel, normalizeContext({ messages }), { sessionId: "a", signal: signalA, onResponse: () => a.confirmRequest(signalA) });
  const store = getEffectiveContextStore(); assert.ok(store.get("a", a.generation)); assert.equal(store.get("b", b.generation), undefined);
  const replacement = acquireEffectiveCapture({ owner: "new-a", sessionId: "a", binding: {} }); replacement.refreshProviders(registry);
  a.release(); assert.notEqual(provider.streamSimple, original); assert.equal(store.get("a", a.generation), undefined);
  provider.streamSimple(identity.selectedModel, normalizeContext({ messages }), { sessionId: "b", signal: signalB, onResponse: () => b.confirmRequest(signalB) });
  assert.ok(store.get("b", b.generation));
  replacement.release(); assert.notEqual(provider.streamSimple, original);
  b.release(); assert.equal(provider.streamSimple, original);
});

test("Main reload retires a generation even while Side holds a lease on the same SessionManager", () => {
  const binding = {};
  const main = acquireEffectiveCapture({ owner: "main", sessionId: "reload", binding });
  const side = acquireEffectiveCapture({ owner: "side", sessionId: "reload", binding });
  main.retire();
  const nextMain = acquireEffectiveCapture({ owner: "main", sessionId: "reload", binding });
  assert.notEqual(nextMain.generation, side.generation);
  side.release(); main.retire();
  const newSide = acquireEffectiveCapture({ owner: "side", sessionId: "reload", binding });
  assert.equal(nextMain.generation, newSide.generation);
  newSide.release(); nextMain.retire();
});
