import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import sessionCompact from "../index.ts";
import { installCompactionSkillRecovery } from "../../pi-skills/compact-recovery.ts";
import todo from "../../pi-todo/index.ts";
import { createCompactReinjection as processRecovery } from "../../pi-processes/src/compact-reinject.ts";
import { createCompactReinjection as subagentRecovery } from "../../pi-subagents/src/host/compact-reinject.ts";
import { recoveryText } from "../src/recovery.ts";

test("threshold compaction during a tool continuation commits every recovery before the first request", async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-streaming-")), agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "pi-session-compact"), { recursive: true });
  writeFileSync(join(agentDir, "pi-session-compact/config.json"), JSON.stringify({ mode: "small", outputTokens: 1024, retry: { network: 0, invalidOutput: 0 }, smallModel: { provider: "recovery-faux", id: "small", effort: "off" } }));
  const requests: Message[][] = [], errors: string[] = [], stops: string[] = [];
  let streaming = false, compacted = false;
  const fixture = (pi: ExtensionAPI) => {
    const faux = fauxProvider({ provider: "recovery-faux", api: "recovery-faux", models: [{ id: "main", contextWindow: 40000, maxTokens: 1000 }, { id: "small", contextWindow: 200000, maxTokens: 4000 }], tokensPerSecond: 10000000 });
    faux.setResponses(Array.from({ length: 10 }, () => (context, _options, _state, model) => {
      if (model.id === "small") return fauxAssistantMessage("HANDOFF Continue the pending task.");
      requests.push(structuredClone(context.messages));
      if (requests.length === 1) return fauxAssistantMessage([{ type: "text", text: "OLD_COMPLETED_WORK ".repeat(7200) }, fauxToolCall("seed", {}, { id: "seed-1" })], { stopReason: "toolUse" });
      if (requests.length === 2) return fauxAssistantMessage(fauxToolCall("seed", {}, { id: "seed-2" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("TASK_FINISHED");
    }));
    pi.registerProvider(faux.provider);
    pi.registerTool({ name: "seed", label: "Seed", description: "Seed rules and tool output", parameters: { type: "object", properties: {} } as never,
      async execute(id) {
        pi.appendEntry("pi-skills:binding-v1", { version: 1, skills: [{ name: "required", path: "/required/SKILL.md", contents: "SKILL_RULES_REQUIRED" }] });
        return { content: [{ type: "text", text: id === "seed-1" ? "TOOL_RESULT" : "RECENT_TOOL_OUTPUT ".repeat(1500) }], details: {} };
      } });
    pi.on("session_compact", (_e, ctx) => { compacted = true; streaming = !ctx.isIdle(); });
    pi.on("turn_end", event => { if (event.message.role === "assistant") stops.push(event.message.stopReason); });
    // Production snapshot renderers with minimal existing owner state; no helper or SDK child starts.
    const processHandler = processRecovery(pi, () => ({ records: () => [{ id: "proc_live", name: "PROCESS_RUNNING", state: "running" }], command: () => "sleep 300", logPath: () => "/owned/records/proc_live.*.jsonl" }) as any);
    const subagentHandler = subagentRecovery(pi, () => ({ host: { snapshot: () => ({ agents: [{ agent: { agent_id: "agent_live", task_name: "SUBAGENT_RUNNING", task_path: "/root/live" }, tasks: [{ task_id: "task_live", phase: "running" }] }] }) }, runtime: { taskProgress: () => "Checking tests" } }) as any);
    pi.on("session_compact", processHandler);
    pi.on("session_compact", subagentHandler);
  };
  const sm = SessionManager.create(root, join(root, "sessions"));
  sm.appendCustomMessageEntry("todo-state", "", false, { todos: [{ id: 1, content: "TODO_PENDING", activeForm: "Checking", status: "in_progress" }] });
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 100 }, cacheWarming: "off" }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ["mcp"], systemPrompt: "Fixture", extensionFactories: [sessionCompact, installCompactionSkillRecovery, todo, fixture] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("recovery-faux", "main"), tools: ["seed"], thinkingLevel: "off" });
    await result.session.bindExtensions({ mode: "print", onError: event => errors.push(String(event.error)) });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: sm });
  try {
    await runtime.session.prompt("Perform the task and finish after the tool result.");
    assert.deepEqual(errors, []);
    assert.equal(compacted, true, "native threshold hook committed compaction");
    assert.equal(streaming, true, "compaction happened while the task was streaming");
    const branch = sm.getBranch();
    assert.deepEqual(stops, ["toolUse", "toolUse", "stop"], `task must continue without abort; actual stops=${JSON.stringify(stops)}, requests=${requests.length}, failures=${JSON.stringify(branch.flatMap(e => e.type === "message" && e.message.role === "assistant" && e.message.errorMessage ? [e.message.errorMessage] : []))}`);
    assert.equal(requests.length, 3);
    const checkpoint = branch.findLast(e => e.type === "compaction")!;
    for (const marker of ["SKILL_RULES_REQUIRED", recoveryText(), "TODO_PENDING", "PROCESS_RUNNING", "SUBAGENT_RUNNING"]) {
      assert.ok(JSON.stringify(requests[2]).includes(marker), marker);
      assert.ok(checkpoint.summary.includes(marker), marker);
    }
    const details = checkpoint.details as { recovery: { version: number; items: Array<{ owner: string }> }; runLog: string };
    assert.deepEqual(details.recovery.items.map(item => item.owner), ["pi-session-compact", "pi-skills", "pi-todo", "pi-processes", "pi-subagents"]);
    const run = JSON.parse(readFileSync(join(agentDir, details.runLog), "utf8"));
    assert.ok(run.contextSizes.after.estimated.recoveryPackage > 0);
    const types = ["pi-session-compact:recovery-v1", "pi-skills:compact-restored-v1", "todo-state", "process-compact-state-v1", "subagent-compact-state-v1"];
    assert.equal(branch.slice(branch.indexOf(checkpoint) + 1).filter(e => e.type === "custom_message" && types.includes(e.customType)).length, 0, "no queued duplicate recovery messages");
  } finally {
    await runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
