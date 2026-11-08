import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getEffectiveContextGeneration, getEffectiveContextStore } from "pi-session-runtime/effective-context";
import { selectEffectiveContext } from "pi-session-runtime/native-child-context";
import { describeMainEffectiveContext, mainRequiresEffectiveCapture } from "../../src/context/effective.ts";
import { installEffectiveContextCapture } from "../../src/context/capture.ts";
import { prepareEffectiveChildSession } from "../../src/context/prepare.ts";

test("capture adapter never subscribes to epoch and retires structural/reload ownership", async () => {
  const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
  const provider: any = { streamSimple(_model: unknown, _context: unknown, options: any) { options?.onResponse?.(); return {}; } };
  const original = provider.streamSimple;
  const model = { provider: "faux", id: "model", api: "faux", input: ["text"], contextWindow: 64000, maxTokens: 512, reasoning: false };
  const pi: any = {
    on(name: string, callback: (...args: any[]) => unknown) { const list = hooks.get(name) ?? []; list.push(callback); hooks.set(name, list); },
    getActiveTools: () => [], getAllTools: () => [], getCommands: () => [],
    events: { on(name: string) { assert.notEqual(name, "magic-context:context-epoch"); return () => {}; } },
  };
  const sessionManager = SessionManager.inMemory("/tmp");
  sessionManager.appendMessage({ role: "user", content: "request", timestamp: 1 });
  const ctx: any = { cwd: "/tmp", sessionManager, model, thinkingLevel: "off", signal: new AbortController().signal,
    modelRegistry: { getRegisteredProviderIds: () => [], getAll: () => [model], getProvider: () => provider } };
  const fire = async (name: string, event = {}) => { for (const callback of hooks.get(name) ?? []) await callback(event, ctx); };
  installEffectiveContextCapture(pi, () => import("../../src/context/effective.ts"));
  await fire("session_start");
  assert.equal(provider.streamSimple, original); // No eager provider enumeration or projection.
  let identity = await describeMainEffectiveContext(pi, ctx);
  assert.equal(mainRequiresEffectiveCapture(pi, ctx, identity), true); // unknown before any request
  const messages = sessionManager.buildSessionProjection().messages;
  await fire("context_with_system", { messages });
  identity = await describeMainEffectiveContext(pi, ctx);
  provider.streamSimple(model, normalizeContext({ messages: messages as never }), { sessionId: identity.sessionId, signal: ctx.signal, onResponse: () => fire("after_provider_response") });
  const store = getEffectiveContextStore();
  const capture = store.get(identity.sessionId, identity.generation)!;
  assert.deepEqual(capture.normalizedMessages, messages);
  assert.equal(mainRequiresEffectiveCapture(pi, ctx, identity), false);
  sessionManager.appendContextEdit(sessionManager.getLeafId()!, { content: "edited after capture" });
  await assert.rejects(prepareEffectiveChildSession(pi, ctx, { forkTurns: "all", model: { provider: model.provider, modelId: model.id, thinkingLevel: "off" } }), /projection-changed/);
  assert.equal(mainRequiresEffectiveCapture(pi, ctx, identity), true);
  await fire("session_compact");
  assert.equal(store.get(identity.sessionId, identity.generation), undefined);
  assert.throws(() => selectEffectiveContext({ mode: "all", identity, branch: sessionManager.getBranch(), capture: store.get(identity.sessionId, identity.generation), requiresCapture: true, unavailableReason: store.reason(identity.sessionId) }), /effective-context-unavailable/);
  await fire("session_shutdown");
  assert.equal(provider.streamSimple, original);
  assert.equal(getEffectiveContextGeneration(identity.sessionId), undefined);
  await fire("session_start");
  assert.notEqual(getEffectiveContextGeneration(identity.sessionId), identity.generation);
  await fire("session_shutdown");
});
