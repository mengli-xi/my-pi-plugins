import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { getProcessWaitBridgeV2 } from "pi-runtime-contracts/process-wait-bridge-v2";
import compact from "../local/pi-session-compact/index.ts";

for (const kind of ["main", "side", "main-alone"] as const) test(`real Processes ${kind} compacts without Goal or CC and does not duplicate live recovery`, async () => {
  const root = mkdtempSync(join(tmpdir(), "processes-compact-")), agentDir = join(root, "agent");
  const previousAgent = process.env.PI_CODING_AGENT_DIR, previousTmp = process.env.TMPDIR;
  mkdirSync(agentDir); mkdirSync(join(root, "tmp"));
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.TMPDIR = join(root, "tmp");
  mkdirSync(join(agentDir, "pi-session-compact"));
  writeFileSync(join(agentDir, "pi-session-compact/config.json"), JSON.stringify({ mode: "small", outputTokens: 1024,
    retry: { network: 0, invalidOutput: 0 }, smallModel: { provider: "processes-faux", id: "small", effort: "off" } }));
  const sm = SessionManager.create(root, join(root, "sessions"));
  const processes = await import(new URL("../local/pi-processes/dist/index.js", import.meta.url).href);
  const factory = kind === "side" ? processes.createProcessesSideFactory({ sessionScopeId: sm.getSessionId(), agentDir }) : processes.default;
  const requests: Array<{ model: string; messages: Message[] }> = [], errors: string[] = [];
  const command = "printf PROCESS_COMPACT_READY; sleep 300";
  let started = false, compacting = false, nativeSummary = 0;
  const fixture: ExtensionFactory = pi => {
    const faux = fauxProvider({ provider: "processes-faux", api: "processes-faux", tokensPerSecond: 10000000,
      models: [{ id: "main", contextWindow: 200000, maxTokens: 1024 }, { id: "small", contextWindow: 200000, maxTokens: 4096 }] });
    faux.setResponses(Array.from({ length: 30 }, () => (context, _options, _state, model) => {
      requests.push({ model: model.id, messages: structuredClone(context.messages) });
      if (!started) { started = true; return fauxAssistantMessage(fauxToolCall("process", { action: "start", name: "active", command,
        continuation: { mode: "detached" }, notify: { onSuccess: "ignore", onFailure: "ignore", onKilled: "ignore", onCrash: "ignore" } }), { stopReason: "toolUse" }); }
      return fauxAssistantMessage(model.id === "small" ? "HANDOFF Continue the pending work." : compacting ? `NATIVE_HANDOFF_${++nativeSummary}` : "LOCAL_OK");
    }));
    pi.registerProvider(faux.provider);
  };
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 64 }, retry: { enabled: false }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
        systemPrompt: "Offline process integration", extensionFactories: [factory, ...(kind === "main-alone" ? [] : [compact]), fixture] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("processes-faux", "main"), tools: ["process"], thinkingLevel: "off" });
    await result.session.bindExtensions({ mode: "print", onError: event => errors.push(String(event.error)) });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: sm });
  try {
    assert.equal(runtime.session.getToolDefinition("spawn_agent"), undefined);
    assert.equal(getProcessWaitBridgeV2(sm.getSessionId()), undefined, "advertising the Process capability never creates a Subagent Task bridge");
    await runtime.session.prompt("Start the authorized local process.");
    const result = runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "process");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, false, JSON.stringify(result));
    for (let round = 0; round < 2; round++) {
      await runtime.session.prompt(`Historical work ${round}. `.repeat(150));
      await runtime.session.prompt("Preserve the active process. ".repeat(150));
      const count = requests.length;
      compacting = true;
      try { await runtime.session.compact(); }
      finally { compacting = false; }
      const entry = sm.getBranch().findLast(entry => entry.type === "compaction");
      assert.ok(entry && entry.type === "compaction");
      const details = entry.details as { recovery?: { items: Array<{ owner: string; customType: string }> } };
      const recovery = sm.getBranch().filter(item => item.type === "custom_message" && item.customType === "process-compact-state-v1");
      if (kind === "main-alone") {
        assert.equal(requests.slice(count).every(request => request.model === "main"), true, "absence of Compact uses the native faux summary request");
        assert.equal(recovery.length, round + 1, "native compaction gets one standalone live-state message");
      } else {
        assert.equal(requests.slice(count).filter(request => request.model === "small").length, 1, "the actual Compact generator reaches faux transport");
        assert.equal(details.recovery?.items.filter(item => item.owner === "pi-processes" && item.customType === "process-compact-state-v1").length, 1);
        assert.equal(entry.summary.split("这是压缩完成时的实时状态").length - 1, 1);
        assert.ok(entry.summary.includes(command));
        assert.equal(recovery.length, 0, "the real session_compact callback recognizes embedded recovery and never queues a duplicate");
      }
      await runtime.session.prompt("Continue without restarting the process.");
      assert.equal(runtime.session.getLastAssistantText(), "LOCAL_OK");
      assert.ok(JSON.stringify(requests.at(-1)!.messages).includes(command), "the next real request retains the live command");
    }
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    rmSync(root, { recursive: true, force: true });
  }
});
