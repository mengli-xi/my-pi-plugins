import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { contextFingerprint, mapEffectiveTurns, type EffectiveCapture, type NativeMessageOrigin } from "../src/effective-context.ts";
import { selectEffectiveContext, buildNativeChildSnapshot, describeNativeContext } from "../src/native-child-context.ts";

// Frozen legacy 0.41.1 request-format samples, not a Magic Context producer.
// Explicit decorated bodies exercise only our decoder/selection/seed behavior;
// no installed package, database, tag allocator or producer source is required.
const EMPTY_M1 = "<session-history-since>(no new content since last materialization)</session-history-since>";
const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const originals: Message[] = [user("earlier", 1), { ...fauxAssistantMessage("old answer"), timestamp: 2 },
  user("继续", 600_002), { ...fauxAssistantMessage("middle answer"), timestamp: 600_003 },
  user("继续", 1_200_003), { ...fauxAssistantMessage("latest answer"), timestamp: 1_200_004 }];
const tagged: Message[] = [user("§1§ earlier", 1), originals[1]!,
  user("§3§ <!-- +10m -->\n继续", 600_002), originals[3]!,
  user("§5§ <!-- +10m -->\n继续", 1_200_003), originals[5]!];
const origins = originals.map((message, index): NativeMessageOrigin => ({ message, kind: message.role === "user" ? "turn" : "body", ...(message.role === "user" ? { turnId: `e${index}` } : {}) }));
function legacyRequest(body = tagged, m0 = "<session-history></session-history>", m1 = EMPTY_M1): Message[] {
  return structuredClone([{ role: "system", content: "Main effective system", timestamp: 0 },
    user(m0, body[0]!.timestamp - 2), user(m1, body[0]!.timestamp - 1), ...body]);
}
function captureFor(branch: readonly { id: string }[], messages: Message[], nativeOrigins: readonly NativeMessageOrigin[]): EffectiveCapture {
  return { sessionId: "main", generation: 1, selectedModel: { provider: "faux", id: "m" }, physicalModel: { provider: "faux", id: "m" }, thinkingLevel: "off", toolLoadoutFingerprint: "tools", capabilityFingerprint: "caps", requestOrdinal: 1, leafId: branch.at(-1)?.id ?? null, normalizedMessages: messages, normalizedRequestHash: contextFingerprint(messages), contextCandidateHash: "c", capturedAt: 1, wirePrefix: "unknown", ...mapEffectiveTurns(messages, nativeOrigins) };
}

test("legacy tags, temporal comments and m[0]/m[1] map repeated text without changing request bytes", () => {
  const messages = legacyRequest(), saved = structuredClone(messages);
  const mapping = mapEffectiveTurns(messages, origins);
  assert.equal(mapping.turnMappingReliable, true);
  assert.deepEqual(mapping.turnAnchors, [{ entryId: "e0", messageIndex: 3 }, { entryId: "e2", messageIndex: 5 }, { entryId: "e4", messageIndex: 7 }]);
  assert.deepEqual(mapping.preambleMessageIndices, [0, 1, 2]);
  const branch: any[] = originals.map((message, index) => ({ type: "message", message, id: `e${index}`, parentId: index ? `e${index - 1}` : null, timestamp: "2026-10-16T00:00:00.000Z" }));
  const capture = captureFor(branch, messages, origins);
  for (const mode of ["1", "2", "all"] as const) {
    const selection = selectEffectiveContext({ mode, identity: capture, branch, capture, requiresCapture: true });
    assert.deepEqual(selection.messages, mode === "all" ? messages : [...messages.slice(0, 3), ...messages.slice(mode === "1" ? 7 : 5)]);
    const seed = buildNativeChildSnapshot({ selection, cwd: "/tmp", boundary: { customType: "test", content: "boundary" } });
    assert.deepEqual(seed.entries.filter(entry => seed.inheritedEntryIds.includes(entry.id)).map((entry: any) => entry.message), selection.messages);
  }
  assert.deepEqual(messages, saved);
});

test("legacy preamble fixtures preserve folded history, memories and delta blocks", () => {
  for (const m1 of [EMPTY_M1, "<session-history-since>\n<memory-updates>\n  <removed id=\"1\"/>\n</memory-updates>\n<new-compartments>summary delta</new-compartments>\n<new-memories>memory delta</new-memories>\n<new-user-profile>profile delta</new-user-profile>\n</session-history-since>", "<knowledge-updates>\n<new-memories>memory</new-memories>\n</knowledge-updates>"]) {
    const messages = legacyRequest(tagged.slice(2), "<project-docs>docs</project-docs>\n\n<user-profile>profile</user-profile>\n\n<session-history>FOLDED_SUMMARY</session-history>\n\n<project-memory>memory</project-memory>", m1);
    const mapping = mapEffectiveTurns(messages, origins);
    assert.equal(mapping.turnMappingReliable, true);
    assert.deepEqual(mapping.turnAnchors.map(anchor => anchor.entryId), ["e2", "e4"]);
    assert.deepEqual(mapping.preambleMessageIndices, [0, 1, 2]);
    assert.doesNotMatch(JSON.stringify(messages), /old answer|earlier/u);
  }
});

test("unrecognized edits, malformed envelopes and ambiguous duplicate identities refuse N", () => {
  const valid = legacyRequest();
  const change = (edit: (messages: any[]) => void) => { const messages = structuredClone(valid); edit(messages); assert.equal(mapEffectiveTurns(messages, origins).turnMappingReliable, false); };
  change(messages => { messages[5].content[0].text += " unknown edit"; });
  change(messages => { messages[3].content[0].text = "§1§ [removed legacy user sentinel]"; });
  change(messages => { messages[5].timestamp++; });
  change(messages => { messages[5].content[0].text = "§2§ <!-- +2x -->\n继续"; });
  change(messages => { messages[5].content[0].text = "§2§ §200§ <!-- +10m -->\n继续"; });
  change(messages => { messages[5].content[0].textSignature = "changed metadata"; });
  change(messages => { messages[1].content[0].text += "\n<unknown>extra</unknown>"; });
  change(messages => { messages[2].timestamp++; });
  change(messages => { messages[2].content[0].text = "<session-history-since>unknown</session-history-since>"; });
  change(messages => { messages[2].content[0].text = "<session-history-since>\n\n</session-history-since>"; });
  change(messages => { messages[2].content[0].text = "<session-history-since>\n<unknown>extra</unknown>\n</session-history-since>"; });
  assert.equal(mapEffectiveTurns(valid.slice(3), origins).turnMappingReliable, false);
  const duplicate = [user("继续", 1), user("继续", 1)];
  const duplicateOrigins = duplicate.map((message, index): NativeMessageOrigin => ({ message, kind: "turn", turnId: `d${index}` }));
  assert.equal(mapEffectiveTurns(legacyRequest([user("§1§ 继续", 1), user("§2§ 继续", 1)]), duplicateOrigins).turnMappingReliable, false);
  const collision = [...origins, { message: valid[5]!, kind: "turn", turnId: "collision" } satisfies NativeMessageOrigin];
  assert.equal(mapEffectiveTurns(valid, collision).turnMappingReliable, false);
  const envelopeCollision = [...origins, { message: valid[1]!, kind: "turn", turnId: "envelope-collision" } satisfies NativeMessageOrigin];
  assert.equal(mapEffectiveTurns(valid, envelopeCollision).turnMappingReliable, false);
});

test("legacy multi-block/image/string samples map exactly; native tag collisions refuse lossy rewrites", () => {
  const rich: Message = { role: "user", timestamp: 3, content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "second §23§ literal" }] };
  const decorated: Message = { role: "user", timestamp: 3, content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: "§1§ first" }, { type: "text", text: "§2§ second §23§ literal" }] };
  const nativeOrigins: NativeMessageOrigin[] = [{ message: rich, kind: "turn", turnId: "rich" }];
  const request = legacyRequest([decorated]);
  assert.equal(mapEffectiveTurns(request, nativeOrigins).turnMappingReliable, true);
  const changed = structuredClone(request) as any[]; changed[3].content[0].data = "changed";
  assert.equal(mapEffectiveTurns(changed, nativeOrigins).turnMappingReliable, false);
  const stringMessage: Message = { role: "user", content: "plain string input", timestamp: 8 };
  assert.equal(mapEffectiveTurns(legacyRequest([{ ...stringMessage, content: "§1§ plain string input" }]), [{ message: stringMessage, kind: "turn", turnId: "string" }]).turnMappingReliable, true);
  for (const text of ["§2§ unchanged native text", '§3\">§ same', "§3 same", "§3.1 same"]) {
    const literal = user(text, 8), literalOrigins: NativeMessageOrigin[] = [{ message: literal, kind: "turn", turnId: "literal" }];
    assert.equal(mapEffectiveTurns(legacyRequest([user("§1§ same", 8)]), literalOrigins).turnMappingReliable, false);
    assert.equal(mapEffectiveTurns([literal], literalOrigins).turnMappingReliable, true);
  }
});

test("review A: a legacy lossy tag fixture cannot map a surviving user to the removed old turn", () => {
  const native = [user("same", 100), user("§3§ same", 100), { ...fauxAssistantMessage("current answer"), timestamp: 101 }];
  const branch: any[] = native.map((message, index) => ({ type: "message", message, id: ["old", "current", "reply"][index]!, parentId: [null, "old", "current"][index], timestamp: "2026-10-16T00:00:00.000Z" }));
  const nativeOrigins = describeNativeContext(branch);
  // Captured shape after the old turn was trimmed and the current native tag was replaced.
  const messages = legacyRequest([user("§11§ same", 100), native[2]!]);
  const capture = captureFor(branch, messages, nativeOrigins);
  assert.equal(capture.turnMappingReliable, false);
  assert.deepEqual(capture.turnAnchors, []);
  assert.throws(() => selectEffectiveContext({ mode: "1", identity: capture, branch, capture, requiresCapture: true }), /turn-mapping-unreliable/u);
});

test("review B: a lossy user tag fixture cannot become a persistent native preamble", () => {
  const messages = [user("<session-history></session-history>", 100), user("§3§ <session-history></session-history>", 100),
    { ...fauxAssistantMessage("old answer"), timestamp: 101 }, user("latest", 200), { ...fauxAssistantMessage("latest answer"), timestamp: 201 }];
  const seed = buildNativeChildSnapshot({ cwd: "/tmp", boundary: { customType: "test", content: "boundary" }, selection: {
    messages, source: "native-projection", exactRequestPrefix: false, turnAnchors: [{ entryId: "old", messageIndex: 1 }, { entryId: "latest", messageIndex: 3 }],
    preambleMessageIndices: [0], attachedMessageIndices: [], turnMappingReliable: true,
  } });
  const branch = seed.entries.slice(0, -1);
  const nativeOrigins = describeNativeContext(branch);
  assert.deepEqual(nativeOrigins.map(origin => origin.kind), ["preamble", "turn", "body", "turn", "body"]);
  const effective = legacyRequest([user("§1§ <session-history></session-history>", 100), user("§2§ <session-history></session-history>", 100),
    messages[2]!, user("§4§ latest", 200), messages[4]!]);
  const capture = captureFor(branch, effective, nativeOrigins);
  assert.equal(capture.turnMappingReliable, false);
  assert.equal(capture.preambleMessageIndices.includes(4), false);
  assert.throws(() => selectEffectiveContext({ mode: "1", identity: capture, branch, capture, requiresCapture: true }), /turn-mapping-unreliable/u);
  assert.deepEqual(selectEffectiveContext({ mode: "all", identity: capture, branch, capture, requiresCapture: true }).messages, effective);
});

test("legacy identity collisions refuse regardless of native turn, preamble or body kind", () => {
  const message = user("same", 100);
  for (const left of ["turn", "preamble", "body"] as const) for (const right of ["turn", "preamble", "body"] as const) {
    const nativeOrigins: NativeMessageOrigin[] = [{ message, kind: left, turnId: "left" }, { message, kind: right, turnId: "right" }];
    assert.equal(mapEffectiveTurns(legacyRequest([user("§1§ same", 100)]), nativeOrigins).turnMappingReliable, false, `${left}/${right}`);
  }
});
