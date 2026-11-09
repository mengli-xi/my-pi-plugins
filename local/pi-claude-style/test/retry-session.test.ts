import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, InteractiveMode, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { installRetryRecording, type RetryRecording } from "../src/compat/retry-session.ts";
import type { RetrySnapshot } from "../src/working-retry.ts";

for (const cancel of [false, true]) test(`session snapshot clears on ${cancel ? "cancel" : "next request"} and shutdown without a view`, async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-retry-recording-"));
  let recording!: RetryRecording, observed: RetrySnapshot | undefined;
  let retry!: () => void, next!: () => void, release!: () => void;
  const retryStarted = new Promise<void>(resolve => { retry = resolve; });
  const requestStarted = new Promise<void>(resolve => { next = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bind = AgentSession.prototype.bindExtensions, init = InteractiveMode.prototype.init;
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const faux = fauxProvider({ provider: "retry-session", api: "retry-session", models: [{ id: "faux", name: "faux", contextWindow: 32768, maxTokens: 128, reasoning: false }] });
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 overloaded" }), async () => {
      next(); await gate; return fauxAssistantMessage("success");
    }]);
    const services = await createAgentSessionServices({ cwd: root, agentDir: root,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: true, maxRetries: 10, baseDelayMs: cancel ? 15000 : 10 }, compaction: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], extensionFactories: [pi => {
          pi.registerProvider(faux.provider); recording = installRetryRecording(pi);
        }] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("retry-session", "faux"), tools: [] });
    await result.session.bindExtensions({ mode: "print" });
    result.session.subscribe(event => {
      if (event.type === "auto_retry_start") { observed = recording.snapshot(); retry(); }
    });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root) });
  let run: Promise<void> | undefined;
  try {
    run = runtime.session.prompt("retry without a view");
    await retryStarted;
    assert.ok(observed);
    assert.equal(observed.category, "上游不可用");
    assert.equal(observed.attempt, 1); assert.equal(observed.maxAttempts, 10);
    assert.ok(Object.isFrozen(observed));
    assert.ok(!("errorMessage" in observed));
    await runtime.session.bindExtensions({ mode: "print" });
    if (cancel) runtime.session.abortRetry();
    else {
      await requestStarted;
      assert.equal(recording.snapshot(), undefined, "request start invalidates the wait before provider output");
      release();
    }
    await run;
    assert.equal(recording.snapshot(), undefined);
    await runtime.dispose();
    assert.equal(recording.snapshot(), undefined);
    assert.equal(AgentSession.prototype.bindExtensions, bind, "session shutdown releases bind wrapper");
    assert.equal(InteractiveMode.prototype.init, init, "session shutdown releases init wrapper");
  } finally {
    release(); runtime.session.abortRetry(); await run?.catch(() => {}); await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
