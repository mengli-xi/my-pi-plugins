import { pathToFileURL } from "node:url";
import { currentBuild } from "../../../../scripts/retained-build.mjs";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ProcessMailboxSourceV1, readProcessMailIntentsV1 } from "../../src/notifications/mailbox-source.ts";
import type { ProcessNotificationBatchV1 } from "../../src/notifications/types.ts";

const [root, scenario, phase] = process.argv.slice(2) as [string, "changed" | "same" | "unknown" | "late-changed" | "late-same", string];
const agentDir = join(root, "agent"), cwd = join(root, "cwd"), errors: string[] = [];
for (const path of [agentDir, cwd]) mkdirSync(path, { recursive: true });
const previous = phase === "1" ? undefined : JSON.parse(readFileSync(join(root, "sessions.json"), "utf8"));
const { createProcessesChildFactory } = await import(pathToFileURL(join(currentBuild(new URL("../../", import.meta.url)), "child-factory.js")).href);
const { default: mainFactory } = await import(new URL("../../dist/index.js", import.meta.url).href);
const late = scenario.startsWith("late-"), oldOwner = "task-1-generation-1", owner = ["same", "late-same"].includes(scenario) ? oldOwner : "task-2-generation-2";
let ownerKnown = !late;
let source!: ProcessMailboxSourceV1, ctx!: ExtensionContext;
const seeding = (pi: ExtensionAPI) => {
  source = new ProcessMailboxSourceV1({ pi, agentDir, getContext: () => ctx, callbacks: {
    checkCurrent: () => late ? { kind: "allow", project: true, wake: false } : { kind: "hold", reason: "fixture Task is parked before process restart" },
    ...(late ? { onRecorded: notice => source.recorded(notice) } : {}),
  } });
  pi.on("session_start", (_event, current) => { ctx = current; });
};
async function make(role: "main" | "child") {
  const manager = previous ? SessionManager.open(previous[role], cwd) : SessionManager.create(cwd, join(agentDir, role));
  const provider = "restart-" + role;
  const faux = fauxProvider({ provider, api: provider, models: [{ id: "fixture" }], tokensPerSecond: 1000000 });
  const requests: unknown[] = [];
  faux.setResponses(Array.from({ length: 10 }, () => context => { requests.push(context.messages); return fauxAssistantMessage(role + " handled"); }));
  const extension = role === "main" ? mainFactory : phase === "1" ? seeding : createProcessesChildFactory({ agentDir, sessionScopeId: manager.getSessionId(), getBridge: (sessionId: string) => ({
    version: 2, sessionId,
    captureOwnerToken() { if (!ownerKnown || scenario === "unknown") throw new Error("no active Task yet"); return owner; },
    async admitContinuation(input: { ownerToken: string }) { assert.equal(input.ownerToken, oldOwner); assert.equal(scenario, "same", "new Task must never admit old Process mail"); return "trigger" as const; },
  }) });
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
      extensionFactories: [pi => pi.registerProvider(faux.provider), extension],
    } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel(provider, "fixture"), tools: [] });
    await created.session.bindExtensions({ mode: "rpc", onError: error => errors.push(JSON.stringify(error)) });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: manager });
  return { runtime, manager, requests };
}
const main = await make("main");
let child: Awaited<ReturnType<typeof make>> | undefined;
const snapshot = () => { try { return JSON.parse(readFileSync(join(agentDir, "mailbox/v1", child!.manager.getSessionId(), "pending.json"), "utf8")); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], terminal: [] }; throw error; } };
const delay = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "child recovery/ACK did not settle"); await delay(); }
}
try {
  child = await make("child");
  if (phase === "1") {
    await main.runtime.session.prompt("seed Main"); await child.runtime.session.prompt("seed original child");
    const now = new Date().toISOString();
    const batch: ProcessNotificationBatchV1 = { version: 1, batchId: "old-child-key", sessionScopeId: child.manager.getSessionId(), epochId: "old-task-epoch", reason: "subagent-admission", mode: "aggregate", createdAt: now,
      items: [{ kind: "watch-match", processId: "proc_restart000001", processName: "original-process", watchKey: "ready", watchGeneration: 1, count: 1, matchedCount: 1, suppressedCount: 0, firstFactId: "restart:host:1", lastFactId: "restart:host:1", hostIncarnationId: "host", firstNotificationSequence: 1, lastNotificationSequence: 1, firstObservedAt: now, lastObservedAt: now }] };
    const prepared = source.prepare(batch, "next-request", true, undefined, { ownerToken: oldOwner, continuationSignal: true });
    await source.endpoint.put(prepared.mail, prepared.target);
    if (late) await until(() => snapshot().pending[0]?.nativeEntries.length === 1 && snapshot().pending[0]?.recorded?.ack === "acknowledged");
    assert.equal(snapshot().pending.length, 1); assert.equal(snapshot().terminal.length, 0);
    writeFileSync(join(root, "frozen-mail.json"), JSON.stringify(prepared.mail));
    writeFileSync(join(root, "sessions.json"), JSON.stringify({ main: main.manager.getSessionFile(), child: child.manager.getSessionFile() }));
  } else {
    const original = JSON.parse(readFileSync(join(root, "frozen-mail.json"), "utf8"));
    assert.deepEqual(readProcessMailIntentsV1(child.manager.getEntries(), child.manager.getSessionId()).get(original.key), original);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(main.requests.length, 0); assert.equal(child.requests.length, 0, "cold recovery cannot wake a provider");
    if (late) {
      assert.equal(snapshot().pending.length, 1); assert.equal(snapshot().terminal.length, 0, "idle attach has no Task owner yet");
      ownerKnown = true;
      // Faithful D ordering: reuse the idle resident, assign a Task/grant, then
      // deliver extension input. This is not a trusted user recovery gesture.
      await child.runtime.session.prompt("D_FOLLOWUP: a new Task is now active", { source: "extension", expandPromptTemplates: false });
      assert.equal(child.requests.length, 1, "only the explicitly started Task may request a model");
      const body = original.messages[0].content as string;
      const containsBody = (child.requests[0] as any[]).some(message => {
        const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        return text.includes(body);
      });
      assert.equal(containsBody, false, "held old Process body cannot enter the new Task request");
      if (scenario === "late-changed") {
        await until(() => snapshot().pending.length === 0 && snapshot().terminal.length === 0);
        const receipts = child.manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1" ? (entry.data as any).terminals : [])
          .filter(terminal => terminal.mail.key === original.key);
        assert.equal(receipts.length, 1); assert.equal(receipts[0].evidence.outcome, "cancelled"); assert.deepEqual(receipts[0].mail, original);
      } else {
        assert.equal(snapshot().pending.length, 1, "the same owner remains recovery-held after extension input");
        assert.equal(snapshot().terminal.length, 0);
      }
    } else if (scenario === "changed") {
      await until(() => snapshot().pending.length === 0 && snapshot().terminal.length === 0);
      const receipts = child.manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1" ? (entry.data as any).terminals : [])
        .filter(terminal => terminal.mail.key === original.key);
      assert.equal(receipts.length, 1); assert.equal(receipts[0].evidence.outcome, "cancelled"); assert.deepEqual(receipts[0].mail, original);
      await child.runtime.session.prompt("/mailbox resume"); await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(child.requests.length, 0, "the old key cannot be projected into the new Task");
    } else {
      assert.equal(snapshot().pending.length, 1); assert.equal(snapshot().terminal.length, 0, "live or unknown authority cannot be cancelled speculatively");
      if (scenario === "same") {
        await child.runtime.session.prompt("/mailbox resume");
        await until(() => snapshot().pending.length === 0 && snapshot().terminal.length === 0);
        assert.equal(child.requests.length, 1, "same owner resumes the original key once");
      }
    }
    assert.equal(main.requests.length, 0);
    assert.equal(main.manager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === "process-notification-batch-v1"), false);
    assert.equal(child.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "process-notification-batch-v1").length, scenario === "same" || late ? 1 : 0);
  }
  assert.deepEqual(errors, []);
  const summary = { phase, scenario, mainRequests: main.requests.length, childRequests: child.requests.length, pending: snapshot().pending.length, terminal: snapshot().terminal.length, errors };
  writeFileSync(join(root, "phase" + phase + ".json"), JSON.stringify(summary)); console.log(JSON.stringify(summary));
  if (phase === "1") {
    // No business process/helper was started. Kill the entire SDK host before
    // shutdown/cancellation hooks, leaving the real A pending bytes on disk.
    process.kill(process.pid, "SIGKILL"); await new Promise<never>(() => {});
  }
} finally { await child?.runtime.dispose(); source?.close(); await main.runtime.dispose(); }
