import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type ExtensionContext, type ExtensionAPI, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { bindMailbox, type Mail, type ProducerEndpoint } from "../../src/mailbox-v1/index.js";
import { recoveredPending, until } from "../mailbox-harness.js";

const root = process.env.MAILBOX_FOLLOWUP_ROOT!;
const results: unknown[] = [];
async function scenario(name: string, producer: "pi-processes" | "pi-subagents", seed: boolean) {
  const directory = join(root, name), cwd = join(directory, "cwd"), agentDir = join(directory, "agent");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  let manager = SessionManager.create(cwd, join(directory, "sessions"));
  let imported: Mail | undefined;
  if (name === "legacy-pending") {
    const anchorEntryId = manager.appendMessage({ role: "user", content: "Legacy request", timestamp: Date.now() });
    imported = { producer, key: "batch:legacy-pending", anchorEntryId, policy: "next-request", wake: true,
      messages: [{ customType: "process-notification-batch-v1", content: "LEGACY_PENDING_BODY", display: false, details: { batchId: "legacy-pending" } }] };
    const carrier = imported.messages[0]!;
    manager.appendCustomMessageEntry(carrier.customType, carrier.content, carrier.display, carrier.details);
    manager.appendCustomEntry("process-notification-pending-v1", { batchId: "legacy-pending" });
    writeFileSync(manager.getSessionFile()!, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    manager = SessionManager.open(manager.getSessionFile()!);
  }
  if (seed) {
    manager.appendMessage({ role: "user", content: "Side seed", timestamp: Date.now() });
    // Side opens seed JSONL before its first user prompt, via a new public SDK object.
    writeFileSync(manager.getSessionFile()!, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    manager = SessionManager.open(manager.getSessionFile()!);
  }
  let ctx: ExtensionContext, endpoint: ProducerEndpoint, calls = 0, terminals = 0, recorded = false, project = true;
  let lastRequest: unknown[] = [];
  const errors: unknown[] = [];
  const faux = fauxProvider({ provider: `sdk-${name}`, api: `sdk-${name}`, models: [{ id: "fixture", contextWindow: 32768, maxTokens: 128 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 6 }, () => async (context, _options, state) => {
    calls = state.callCount; lastRequest = context.messages; appendFileSync(join(directory, "requests.jsonl"), JSON.stringify({ call: calls, messages: context.messages }) + "\n"); return fauxAssistantMessage(`SDK_DONE_${calls}`);
  }));
  const factory = (pi: ExtensionAPI) => {
    pi.registerProvider(faux.provider);
    const binding = bindMailbox(pi, { agentDir });
    endpoint = binding.registerProducer({ id: producer,
      checkCurrent: () => project ? { kind: "allow", project: true, wake: producer === "pi-processes" ? recorded : true }
        : { kind: "hold", reason: "fixture permission removed" },
      proveNative: (mail, branch) => ({ kind: "observed", entries: mail.messages.flatMap((message, messageIndex) => {
        const entry = branch.find(entry => entry.type === "custom_message" && entry.customType === message.customType && entry.content === message.content);
        return entry ? [{ messageIndex, entryId: entry.id }] : [];
      }) }),
      onRecorded: () => { recorded = true; }, onTerminal: () => { terminals++; },
    });
    pi.on("session_start", async (_event, context) => {
      ctx = context;
      if (imported) await endpoint.put(imported, endpoint.target(context), { recovered: true });
    });
  };
  const create = async (sessionManager: SessionManager, reason: "startup" | "resume" = "startup"): Promise<AgentSessionRuntime> => createAgentSessionRuntime(async options => {
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: false }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], systemPrompt: "Isolated mailbox SDK fixture.", extensionFactories: [factory] },
    });
    const model = services.modelRuntime.getModel(`sdk-${name}`, "fixture")!;
    const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, model, thinkingLevel: "off", tools: [], ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}) });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {}, onError: error => { errors.push(error); } });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager, sessionStartEvent: { type: "session_start", reason } });
  const mail = (key: string): Mail => ({ producer, key, anchorEntryId: manager.getLeafId(), policy: "next-request", wake: true,
    messages: [{ customType: producer === "pi-processes" ? "process-notification-batch-v1" : "subagent-completion-v1", content: `SDK_MAIL_${key}`, display: false, details: { key } }] });
  let old: Mail | undefined;
  if (name === "cold-restore") { old = mail("old-process-pending"); await recoveredPending(agentDir, manager, [old]); }
  let runtime = await create(manager);
  try {
    if (name === "revoked-recorded" || name === "projection-failure") {
      await runtime.session.prompt("BASELINE", { source: "rpc", expandPromptTemplates: false });
      assert.equal(calls, 1);
      const item = { ...mail("guard-gate"), wake: false };
      await endpoint!.put(item, endpoint!.target(ctx!)); await until(() => recorded);
      if (name === "revoked-recorded") {
        project = false;
        await runtime.session.prompt("AFTER_REVOCATION", { source: "rpc", expandPromptTemplates: false });
        assert.equal(calls, 2);
        assert.ok(!JSON.stringify(lastRequest).includes("SDK_MAIL_guard-gate"));
        assert.ok(JSON.stringify(manager.getBranch()).includes("SDK_MAIL_guard-gate"), "original history is not rewritten");
      } else {
        writeFileSync(manager.getSessionFile()!, "not JSON\n");
        await runtime.session.prompt("MUST_NOT_REACH_PROVIDER", { source: "rpc", expandPromptTemplates: false });
        assert.equal(calls, 1, "projection failure must abort before another provider request");
      }
      assert.equal(errors.length, 0, JSON.stringify(errors));
      results.push({ scenario: name, fauxRequests: calls, forbiddenCarrierSent: false, errors: errors.length, passed: true });
      return;
    }
    if (imported) {
      await until(() => recorded); await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(calls, 0, "legacy source import with no A snapshot must stay cold-held");
      await runtime.session.prompt("TRUSTED_USER_RESUMES_LEGACY", { source: "rpc", expandPromptTemplates: false });
      await until(() => terminals === 1); assert.equal(calls, 1); assert.equal(errors.length, 0, JSON.stringify(errors));
      const carriers = manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "process-notification-batch-v1");
      assert.equal(carriers.length, 1); results.push({ scenario: name, heldRequests: 0, fauxRequests: calls, terminals, errors: errors.length, passed: true });
      return;
    }
    if (seed) { await runtime.session.prompt("SIDE_USER_PROMPT", { source: "extension", expandPromptTemplates: false }); assert.equal(calls, 1); }
    const item = mail("live-completion"); await endpoint!.put(item, endpoint!.target(ctx!));
    await until(() => terminals === 1, `${name} first fulfillment`);
    assert.equal(calls, seed ? 2 : 1); assert.equal(errors.length, 0, JSON.stringify(errors));
    if (old) {
      const result = await endpoint!.put(old); assert.equal(result.kind, "accepted", "old restored key must remain held despite live extension runs");
      const snapshot = JSON.stringify(runtime.session.sessionManager.getBranch()); assert.ok(snapshot.includes("SDK_MAIL_live-completion"));
      assert.equal(snapshot.includes("SDK_MAIL_old-process-pending"), false);
    }
    if (name === "closed-reopen") {
      const file = manager.getSessionFile()!; await runtime.dispose();
      manager = SessionManager.open(file); runtime = await create(manager, "resume");
      await runtime.session.prompt("NEXT_TASK_AFTER_REOPEN", { source: "extension", expandPromptTemplates: false });
      await endpoint!.put(mail("after-reopen"), endpoint!.target(ctx!)); await until(() => terminals === 2);
      assert.equal(calls, 3); assert.equal(errors.length, 0, JSON.stringify(errors));
    }
    results.push({ scenario: name, fauxRequests: calls, terminals, errors: errors.length, passed: true });
  } finally { await runtime.dispose(); }
}
await scenario("side-seeded-process-wait", "pi-processes", true);
await scenario("subagent-main-completion", "pi-subagents", false);
await scenario("closed-reopen", "pi-subagents", false);
await scenario("cold-restore", "pi-subagents", false);
await scenario("legacy-pending", "pi-processes", false);
await scenario("revoked-recorded", "pi-processes", false);
await scenario("projection-failure", "pi-processes", false);
console.log(JSON.stringify({ results, realRequests: 0 }));
