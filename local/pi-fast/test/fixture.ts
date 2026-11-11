import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage,
  type Provider, type SimpleStreamOptions, type StreamOptions, type TranscriptContext, type Model,
} from "@earendil-works/pi-ai";

/** Test-only transport: exercise the SDK payload hook, then stream local faux responses. */
export function fastFixture() {
  const root = mkdtempSync(join(tmpdir(), "fast-sdk-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const faux = fauxProvider({ provider: "openai-codex", api: "fast-faux", tokensPerSecond: 10000000,
    models: [{ id: "fast-fixture", contextWindow: 200000, maxTokens: 1024 }] });
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("LOCAL_FAUX_OK")));
  const stream = (model: Model<string>, context: TranscriptContext, options?: StreamOptions) => {
    const outer = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const body = { model: model.id, messages: context.messages };
        const replacement = await options?.onPayload?.(body, model);
        requests.push(structuredClone((replacement ?? body) as Record<string, unknown>));
        const response = faux.provider.streamSimple(model, context, options as SimpleStreamOptions);
        for await (const event of response) outer.push(event);
        outer.end(await response.result());
      } catch (error) {
        errors.push(error);
        const message = { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) }),
          provider: model.provider, model: model.id, api: model.api };
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      }
    });
    return outer;
  };
  const provider: Provider = { ...faux.provider, stream, streamSimple: stream };
  const start = (extensions: ExtensionFactory[]) => createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false },
        compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 64 }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
        noThemes: true, disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
        systemPrompt: "Offline fast test", extensionFactories: [...extensions, pi => pi.registerProvider(provider)] },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: services.modelRuntime.getModel("openai-codex", "fast-fixture"), tools: [], thinkingLevel: "off" });
    await result.session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: SessionManager.create(root, join(root, "sessions")) });
  return { root, agentDir, requests, errors, faux, start,
    cleanup() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
