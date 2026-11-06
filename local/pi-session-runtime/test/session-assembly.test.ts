import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { assembleChildSession } from "../src/session-assembly.ts";

test("SDK assembly isolates providers, cwd, settings, native writer and shutdown; compacts twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-assembly-"));
  const runtimes: AgentSessionRuntime[] = [];
  const parent = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 99_999, keepRecentTokens: 88_888,
    modelOverrides: { "assembly-faux/shared": { reserveTokens: 77_777 } } }, retry: { enabled: false },
    packages: [], extensions: [join(dir, "ambient.ts")] });
  const before = parent.getSettings();
  await writeFile(join(dir, "ambient.ts"), "throw new Error('ambient extension loaded');");
  let shutdowns = 0;
  try {
    const make = async (name: string, small = false) => {
      const cwd = join(dir, name); await mkdir(cwd);
      await writeFile(join(cwd, "identity.txt"), name);
      const faux = fauxProvider({ provider: "assembly-faux", api: "assembly-faux", models: [{ id: "shared", name,
        contextWindow: small ? 4096 : 32768, maxTokens: 256, reasoning: false }], tokensPerSecond: 1_000_000 });
      faux.setResponses(Array.from({ length: 100 }, () => context => small
        ? fauxAssistantMessage(context.messages.some(m => JSON.stringify(m).includes("summariz")) ? "COMPACT SUMMARY" : "answer ".repeat(180))
        : context.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage(`done ${name}`)
          : fauxAssistantMessage(fauxToolCall("read", { path: "identity.txt" }), { stopReason: "toolUse" })));
      const runtime = await assembleChildSession({ cwd, agentDir: dir, sessionManager: SessionManager.create(cwd, join(dir, "sessions", name)),
        parentSettings: parent.getSettings(), projectTrusted: false, provider: "assembly-faux", model: "shared", thinkingLevel: "off",
        modelScope: ["assembly-faux/shared"], tools: ["read"], systemPrompt: "Deterministic local fixture.",
        extensions: [pi => { pi.registerProvider(faux.provider); pi.registerCommand("child-exit", { description: "Exit this child", handler: async (_args, ctx) => ctx.shutdown() }); }],
        shutdown: () => { shutdowns++; } });
      runtimes.push(runtime); return runtime;
    };
    const a = await make("a"), b = await make("b");
    assert.notEqual(a.services.modelRuntime, b.services.modelRuntime);
    assert.notEqual(a.services.resourceLoader, b.services.resourceLoader);
    await Promise.all([a.session.prompt("read"), b.session.prompt("read")]);
    assert.match(JSON.stringify(a.session.messages), /done a/);
    assert.doesNotMatch(JSON.stringify(a.session.messages), /done b/);
    assert.match(JSON.stringify(b.session.messages), /done b/);
    await a.session.prompt("/child-exit"); assert.equal(shutdowns, 1);
    await a.dispose(); runtimes.splice(runtimes.indexOf(a), 1);
    await b.session.prompt("read again"); assert.match(JSON.stringify(b.session.messages), /done b/);
    const small = await make("small", true);
    assert.deepEqual(small.services.settingsManager.getCompactionSettings(small.session.model), { enabled: true, reserveTokens: 512, keepRecentTokens: 256 });
    let compactions = 0;
    small.session.subscribe(event => { if (event.type === "compaction_end" && event.result) compactions++; });
    for (let i = 0; i < 20 && compactions < 2; i++) await small.session.prompt(`round ${i} ` + "large context text ".repeat(230));
    assert.ok(compactions >= 2, `only ${compactions} compactions`);
    await small.session.prompt("followup after compaction");
    assert.ok(small.session.sessionManager.getEntries().filter(entry => entry.type === "compaction").length >= 2);
    assert.deepEqual(parent.getSettings(), before);
    assert.equal(parent.getCompactionEnabled(), false);
  } finally { for (const runtime of runtimes.reverse()) await runtime.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("resumed child assembly replaces persisted tools with the frozen explicit allowlist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-resume-tools-"));
  let runtime: AgentSessionRuntime | undefined;
  try {
    const provider = () => {
      const faux = fauxProvider({ provider: "resume-faux", api: "resume-faux", models: [{ id: "local", contextWindow: 32768, maxTokens: 256 }], tokensPerSecond: 1_000_000 });
      faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("LOCAL_OK")));
      return faux;
    };
    const create = async (manager: SessionManager, tools: string[]) => assembleChildSession({
      cwd: dir, agentDir: dir, sessionManager: manager, parentSettings: { packages: [], retry: { enabled: false } },
      projectTrusted: false, provider: "resume-faux", model: "local", thinkingLevel: "off",
      modelScope: ["resume-faux/local"], tools, systemPrompt: "Local resume permissions fixture.",
      extensions: [pi => pi.registerProvider(provider().provider)], shutdown: () => {},
    });
    runtime = await create(SessionManager.create(dir, join(dir, "sessions")), ["read", "bash", "write"]);
    await runtime.session.prompt("Persist the broad loadout");
    const sessionFile = runtime.session.sessionFile!;
    await runtime.dispose(); runtime = undefined;
    for (const tools of [["read"], []]) {
      runtime = await create(SessionManager.open(sessionFile), tools);
      assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...tools].sort());
      await runtime.session.prompt("Resume with the frozen permissions");
      assert.deepEqual(runtime.session.getActiveToolNames().sort(), [...tools].sort());
      assert.ok(!runtime.session.getActiveToolNames().includes("bash"));
      assert.ok(!runtime.session.getActiveToolNames().includes("write"));
      await runtime.dispose(); runtime = undefined;
    }
  } finally { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
