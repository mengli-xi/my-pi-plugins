import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { acquireEffectiveCapture, getEffectiveContextStore, type EffectiveCaptureLease, type RequestCandidate } from "../src/effective-context.ts";
import { describeNativeContext, describeAuxiliaryPreamble, selectEffectiveContext } from "../src/native-child-context.ts";

for (const scenario of ["normal", "force", "late", "force+late", "force+late+summary"]) test(`public provider boundary captures final normalized input: ${scenario}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-provider-capture-"));
  const requests: Message[][] = [];
  const summaries: Message[][] = [];
  const auxiliary: unknown[][] = [];
  const errors: string[] = [];
  let lease: EffectiveCaptureLease | undefined;
  let candidate: RequestCandidate | undefined;
  let capturedDuringSpawn = false;
  const providerFactory = (pi: ExtensionAPI) => {
    const faux = fauxProvider({ provider: "capture-test", api: "capture-test", models: [{ id: "model", contextWindow: 64000, maxTokens: 256 }], tokensPerSecond: 100000 });
    faux.setResponses(Array.from({ length: 8 }, () => (context) => {
      if (context.messages.some((message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("SUMMARY_"))) {
        summaries.push(structuredClone(context.messages)); return fauxAssistantMessage("direct summary");
      }
      requests.push(structuredClone(context.messages));
      return requests.length === 1 ? fauxAssistantMessage(fauxToolCall("probe_spawn", {}, { id: "spawn" }), { stopReason: "toolUse" }) : fauxAssistantMessage("finished");
    }));
    pi.registerProvider(faux.provider);
    pi.registerTool({
      name: "probe_spawn", label: "Probe", description: "Inspect fork preparation while the assistant tool batch is pending.",
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      async execute(_id, _args, _signal, _update, ctx) {
        const observed = getEffectiveContextStore().get(ctx.sessionManager.getSessionId(), lease!.generation)!;
        assert.ok(observed);
        assert.equal(observed.requestOrdinal, 1);
        assert.deepEqual(observed.normalizedMessages, requests[0]);
        if (scenario.includes("summary")) {
          await ctx.modelRegistry.streamSimple(ctx.model!, { messages: [{ role: "system", content: "SUMMARY_AFTER", timestamp: 0 }, ...observed.normalizedMessages] }, { sessionId: ctx.sessionManager.getSessionId(), signal: ctx.signal }).result();
          assert.deepEqual(getEffectiveContextStore().get(ctx.sessionManager.getSessionId(), lease!.generation), observed);
        }
        const selection = selectEffectiveContext({ mode: "all", identity: observed, branch: ctx.sessionManager.getBranch(), capture: observed, requiresCapture: true });
        assert.deepEqual(selection.messages, requests[0]); // The executing tool batch has no result yet.
        capturedDuringSpawn = true;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
  };
  const transform = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.capture_test = "section";
      if (scenario.includes("force")) return { systemPrompt: "FORCED_PROMPT" };
    });
  };
  const observer = (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => { lease = acquireEffectiveCapture({ owner: "test", sessionId: ctx.sessionManager.getSessionId(), binding: ctx.sessionManager }); });
    pi.on("context_with_system", (event, ctx) => {
      auxiliary.push(structuredClone(event.messages));
      candidate = {
        leafId: ctx.sessionManager.getLeafId(), selectedModel: { provider: ctx.model!.provider, id: ctx.model!.id },
        thinkingLevel: ctx.thinkingLevel ?? "off", toolLoadoutFingerprint: "test", capabilityFingerprint: "test",
        signal: ctx.signal!, auxiliaryMessages: event.messages, nativeOrigins: describeNativeContext(ctx.sessionManager.getBranch()), knownPreamble: describeAuxiliaryPreamble(event.messages),
      };
      lease!.observe(candidate); lease!.refreshProviders(ctx.modelRegistry);
    });
    const confirm = (_event: unknown, ctx: ExtensionContext) => lease?.confirmRequest(ctx.signal);
    pi.on("before_provider_request", confirm);
    pi.on("after_provider_response", confirm);
    pi.on("session_shutdown", () => { lease?.release(); });
  };
  // R2: both calls contain the business anchor and reuse Main's public metadata.
  // They run after the observer, but they do not use Pi's business request callbacks.
  const laterSummary = (pi: ExtensionAPI) => pi.on("context_with_system", async (event, ctx) => {
    for (const marker of ["SUMMARY_BEFORE", "SUMMARY_DIFFERENT_TRANSCRIPT"]) {
      await ctx.modelRegistry.streamSimple(ctx.model!, { messages: [{ role: "system", content: marker, timestamp: 0 }, ...event.messages as Message[]] }, { sessionId: ctx.sessionManager.getSessionId(), signal: ctx.signal }).result();
      assert.equal(getEffectiveContextStore().get(ctx.sessionManager.getSessionId(), lease!.generation), undefined);
    }
  });
  const late = (pi: ExtensionAPI) => pi.on("context_with_system", (event) => ({ messages: [...event.messages, { role: "user", content: "LATE_ONLY", timestamp: 987 }] }));
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ["mcp"], systemPrompt: "BASE_PROMPT", extensionFactories: [providerFactory, transform, observer, ...(scenario.includes("summary") ? [laterSummary] : []), ...(scenario.includes("late") ? [late] : [])] },
    });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("capture-test", "model"), thinkingLevel: "off", tools: ["probe_spawn"] });
    await result.session.bindExtensions({ mode: "print", onError: (event) => errors.push(String(event.error)) });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: dir, agentDir: join(dir, "agent"), sessionManager: SessionManager.create(dir, join(dir, "sessions")) });
  try {
    await runtime.session.prompt("inspect fork");
    assert.deepEqual(errors, []);
    assert.equal(capturedDuringSpawn, true, JSON.stringify(runtime.session.sessionManager.getBranch()));
    const observed = getEffectiveContextStore().get(runtime.session.sessionId, lease!.generation)!;
    assert.deepEqual(observed.normalizedMessages, requests.at(-1));
    assert.equal(observed.requestOrdinal, 2);
    if (scenario.includes("summary")) { assert.equal(summaries.length, 5); assert.equal(requests.length, 2); assert.doesNotMatch(JSON.stringify(observed.normalizedMessages), /SUMMARY_/); }
    if (scenario !== "normal") assert.notDeepEqual(auxiliary.at(-1), requests.at(-1));
    assert.equal(observed.leafId, candidate!.leafId);
  } finally { await runtime.dispose(); await rm(dir, { recursive: true, force: true }); }
});
