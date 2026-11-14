import { pathToFileURL } from "node:url";
import { currentBuild } from "../../../../scripts/retained-build.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(20); }
  assert.fail("timed out waiting for process notification or cleanup");
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("SDK child factories isolate scopes, notifications and shutdown from siblings and Main", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-processes-sdk-"));
  const pids: number[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  // Keep Main's startup scavenger away from unrelated temporary process roots.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "main", "agent");
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const child = await import(pathToFileURL(join(currentBuild(new URL("../../", import.meta.url)), "child-factory.js")).href);
  const main = await import(new URL("../../dist/index.js", import.meta.url).href);
  const runtimes: Awaited<ReturnType<typeof make>>[] = [];
  async function make(name: string, kind: "main" | "child" | "side") {
    const cwd = join(root, name); mkdirSync(cwd);
    const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
    const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
    const sessionScopeId = manager.getSessionId();
    const admissions: string[] = [];
    const errors: string[] = [];
    let nextCall: { args: Record<string, unknown>; id: string } | undefined, callOrdinal = 0;
    const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "fixture", reasoning: false }], tokensPerSecond: 100000 });
    faux.setResponses(Array.from({ length: 100 }, () => () => {
      const call = nextCall; nextCall = undefined;
      return call ? fauxAssistantMessage(fauxToolCall("process", call.args as Parameters<typeof fauxToolCall>[1], { id: call.id }), { stopReason: "toolUse" }) : fauxAssistantMessage("OK");
    }));
    const extension = kind === "side" ? main.createProcessesSideFactory({ sessionScopeId, agentDir }) : kind === "child" ? child.createProcessesChildFactory({ sessionScopeId, agentDir, getBridge: (scope: string) => {
      assert.equal(scope, sessionScopeId);
      return { version: 2, sessionId: scope, captureOwnerToken: () => `owner:${name}`, async admitContinuation(input: { ownerToken: string }) {
        admissions.push(input.ownerToken); assert.equal(input.ownerToken, `owner:${name}`); return "trigger" as const;
      } };
    } }) : main.default;
    const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, disabledBuiltinExtensions: ["mcp"],
        extensionFactories: [pi => pi.registerProvider(faux.provider), extension],
      } });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("fixture", "fixture"), tools: ["process"] });
      await result.session.bindExtensions({ mode: "rpc", onError: error => errors.push(JSON.stringify(error)) });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd, agentDir, sessionManager: manager });
    async function call(args: Record<string, unknown>): Promise<any> {
      await until(() => runtime.session.isIdle);
      const id = "fixture-" + (++callOrdinal);
      nextCall = { args, id };
      await runtime.session.prompt("Run the fixture process operation.");
      await until(() => runtime.session.messages.some(m => m.role === "toolResult" && m.toolCallId === id));
      const message = runtime.session.messages.find(m => m.role === "toolResult" && m.toolCallId === id);
      assert.ok(message && message.role === "toolResult");
      assert.equal(message.isError, false, JSON.stringify(message));
      return (message.details as any).data;
    }
    return { runtime, call, sessionScopeId, admissions, errors };
  }
  try {
    const registry = getOrCreateChildCapabilityRegistryV1();
    runtimes.push(await make("main", "main"));
    const advertised = registry.snapshot(runtimes[0].sessionScopeId);
    assert.deepEqual(advertised.registrations.map(item => item.owner_id), ["pi-processes"]);
    runtimes.push(await make("a", "child"), await make("b", "child"), await make("side", "side"));
    const [mainSession, a, b, side] = runtimes;
    assert.deepEqual(registry.snapshot(mainSession.sessionScopeId), advertised);
    for (const item of [a, b, side]) {
      assert.deepEqual(registry.snapshot(item.sessionScopeId).registrations, [], "SDK children execute the Host profile without advertising owners");
    }
    await mainSession.runtime.session.bindExtensions({ mode: "rpc", onError: error => mainSession.errors.push(JSON.stringify(error)) });
    const rebound = registry.snapshot(mainSession.sessionScopeId);
    assert.deepEqual(rebound.registrations.map(item => item.manifest), advertised.registrations.map(item => item.manifest));
    await a.runtime.session.bindExtensions({ mode: "rpc", onError: error => a.errors.push(JSON.stringify(error)) });
    assert.deepEqual(registry.snapshot(mainSession.sessionScopeId), rebound);
    assert.deepEqual(runtimes.flatMap(item => item.errors), []);
    for (const item of runtimes) {
      const result = await item.call({ action: "start", name: "same-name", command: "printf 'READY\\n'; sleep 300", watches: [{ key: "ready", pattern: "READY", attention: "turn" }] });
      pids.push(result.process.pid);
      pids.push(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(result.process.pid)], { encoding: "utf8" }).trim()));
    }
    for (const item of runtimes) {
      await until(() => item.runtime.session.messages.some((m: any) => m.customType === "process-notification-batch-v1"));
      const batches = item.runtime.session.messages.filter((m: any) => m.customType === "process-notification-batch-v1") as any[];
      assert.ok(batches.every(m => m.details.sessionScopeId === item.sessionScopeId));
      const listed = await item.call({ action: "list" });
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].name, "same-name");
    }
    assert.ok(a.admissions.length && b.admissions.length);
    await a.runtime.dispose();
    await side.runtime.dispose();
    assert.deepEqual(registry.snapshot(mainSession.sessionScopeId), rebound);
    assert.deepEqual(registry.snapshot(b.sessionScopeId).registrations, []);
    await until(() => !alive(pids[2]) && !alive(pids[3]) && !alive(pids[6]) && !alive(pids[7]));
    for (const item of [b, mainSession]) {
      assert.ok(item.runtime.session.getToolDefinition("process"));
      assert.ok(item.runtime.services.modelRuntime.getModel("fixture", "fixture"));
      assert.equal((await item.call({ action: "list" })).items[0].state, "running");
      await item.call({ action: "stop", target: "same-name" });
    }
    assert.deepEqual(runtimes.flatMap(item => item.errors), []);
    assert.deepEqual(warnings, []);
  } finally {
    for (const item of runtimes) await item.runtime.dispose();
    console.warn = originalWarn;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    rmSync(root, { recursive: true, force: true });
  }
  await until(() => pids.every(pid => !alive(pid)));
});
