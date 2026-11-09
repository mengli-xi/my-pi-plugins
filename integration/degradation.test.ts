import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import effort from "../local/pi-effort/index.ts";
import { streamingRecovery } from "../local/pi-session-compact/tests/fixtures/streaming-recovery.ts";

test("compact completes without pi-cc-memory or pi-todo installed in the profile", () => streamingRecovery(false));

test("effort changes real thinking levels without pi-model-prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "effort-degrade-"));
  const agentDir = join(root, "agent"), oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let requests = 0;
  const errors: string[] = [];
  const fixture = (pi: ExtensionAPI) => {
    const faux = fauxProvider({ provider: "effort-faux", api: "effort-faux", models: [{ id: "reasoning", reasoning: true, contextWindow: 32000, maxTokens: 1024 }] });
    faux.setResponses([() => { requests++; return fauxAssistantMessage("LOCAL_FAUX_OK"); }]);
    pi.registerProvider(faux.provider);
  };
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ["mcp"], extensionFactories: [effort, fixture] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("effort-faux", "reasoning"), tools: [], thinkingLevel: "off" });
    await result.session.bindExtensions({ mode: "print", onError: event => errors.push(String(event.error)) });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: SessionManager.create(root, join(root, "sessions")) });
  try {
    await runtime.session.prompt("/effort high");
    assert.equal(runtime.session.thinkingLevel, "high");
    await runtime.session.prompt("/effort ultra");
    assert.notEqual(runtime.session.thinkingLevel, "off");
    await runtime.session.prompt("/effort low");
    assert.equal(runtime.session.thinkingLevel, "low");
    assert.equal(requests, 0, "changing effort must not start a provider request");
    await runtime.session.prompt("Reply locally");
    assert.equal(requests, 1, "a subsequent ordinary request still completes with the faux provider");
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});
