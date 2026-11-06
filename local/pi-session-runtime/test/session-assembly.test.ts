import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { assembleChildSession, getSessionAssemblyPublicModules, type ChildSessionAssemblyOptions } from "../src/session-assembly.ts";

test("SDK assembly isolates providers, cwd, settings, native writer and shutdown; compacts twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-assembly-"));
  const runtimes: AgentSessionRuntime[] = [];
  const parent = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 99_999, keepRecentTokens: 88_888,
    modelOverrides: { "assembly-faux/shared": { reserveTokens: 77_777 } } }, retry: { enabled: false },
    packages: [], extensions: [join(dir, "ambient.ts"), "builtin:codemode", "builtin:tool-search", "builtin:mcp", "builtin:llama.cpp", "builtin:other-owner"],
    defaultTools: ["+codemode", "+tool_search"] });
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
    for (const runtime of [a, b]) {
      assert.deepEqual(runtime.session.getActiveToolNames(), ["read"]);
      assert.ok(!runtime.session.getAllTools().some(tool => ["codemode", "tool_search"].includes(tool.name)));
      assert.ok(!runtime.services.resourceLoader.getExtensions().extensions.some(extension => extension.path.startsWith("builtin:")));
    }
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

test("explicit built-in factories preserve canonical provenance and child isolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-builtins-"));
  const runtimes: AgentSessionRuntime[] = [];
  const sdk = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
  const parentSettings = { packages: [], retry: { enabled: false },
    extensions: ["builtin:mcp", "builtin:llama.cpp", "builtin:other-owner"] };
  const before = structuredClone(parentSettings);
  try {
    const make = async (name: string, builtins: boolean) => {
      const cwd = join(dir, name); await mkdir(cwd);
      const faux = fauxProvider({ provider: "builtins-faux", api: "builtins-faux", models: [{ id: "local", contextWindow: 32768, maxTokens: 256 }], tokensPerSecond: 1_000_000 });
      faux.setResponses(builtins ? [
        fauxAssistantMessage(fauxToolCall("tool_search", { query: "read" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("codemode", { code: "return 'BUILTIN_LOCAL_OK';" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("CHILD_DONE"),
      ] : [fauxAssistantMessage("PLAIN_CHILD_DONE")]);
      const runtime = await assembleChildSession({ cwd, agentDir: dir, sessionManager: sdk.SessionManager.inMemory(cwd),
        parentSettings, projectTrusted: false, provider: "builtins-faux", model: "local", thinkingLevel: "off",
        modelScope: ["builtins-faux/local"], tools: builtins ? ["read", "codemode", "tool_search"] : ["read"],
        systemPrompt: "Only the explicit local child tools are available.",
        extensions: [pi => pi.registerProvider(faux.provider), ...(builtins ? [
          { name: "codemode", builtin: true, factory: sdk.createCodemodeExtension({ mode: "on", models: false }) },
          { name: "tool-search", builtin: true, factory: sdk.createToolSearchExtension() },
        ] : [])],
        ...(builtins ? { approvedBuiltinExtensions: ["codemode", "tool-search"] as const } : {}),
        shutdown: () => {},
      });
      runtimes.push(runtime); return runtime;
    };
    const builtin = await make("builtin", true), plain = await make("plain", false);
    assert.deepEqual(new Set(builtin.session.getActiveToolNames()), new Set(["read", "codemode", "tool_search"]));
    for (const [toolName, owner] of [["codemode", "codemode"], ["tool_search", "tool-search"]]) {
      const tool = builtin.session.getAllTools().find(tool => tool.name === toolName)!;
      assert.ok(tool);
      assert.equal(tool.sourceInfo.path, `builtin:${owner}`);
      assert.equal(tool.sourceInfo.source, "builtin");
    }
    assert.deepEqual(builtin.services.resourceLoader.getExtensions().extensions.filter(extension => extension.path.startsWith("builtin:")).map(extension => extension.path).sort(), ["builtin:codemode", "builtin:tool-search"]);
    assert.ok(!plain.session.getAllTools().some(tool => ["codemode", "tool_search"].includes(tool.name)));
    assert.notEqual(builtin.services.resourceLoader, plain.services.resourceLoader);
    await builtin.session.prompt("Use the two local built-in tools");
    const results = builtin.session.messages.filter(message => message.role === "toolResult");
    assert.deepEqual(results.map(message => message.toolName), ["tool_search", "codemode"]);
    assert.ok(results.every(message => !message.isError));
    assert.match(JSON.stringify(results), /BUILTIN_LOCAL_OK/);
    await builtin.dispose(); runtimes.splice(runtimes.indexOf(builtin), 1);
    await plain.session.prompt("Continue independently");
    assert.match(JSON.stringify(plain.session.messages), /PLAIN_CHILD_DONE/);
    assert.deepEqual(plain.session.getActiveToolNames(), ["read"]);
    assert.deepEqual(parentSettings, before);
  } finally { for (const runtime of runtimes.reverse()) await runtime.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("built-in approvals reject unknown, duplicate, missing and unapproved factories before loading", async () => {
  let factoryCalls = 0;
  const factory = () => { factoryCalls++; };
  const manager = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"].SessionManager.inMemory();
  const base: ChildSessionAssemblyOptions = {
    cwd: tmpdir(), agentDir: tmpdir(), sessionManager: manager, parentSettings: {}, projectTrusted: false,
    provider: "unused", model: "unused", thinkingLevel: "off", modelScope: [], tools: [],
    systemPrompt: "No services should be created.", extensions: [], shutdown: () => {},
  };
  const cases: [Partial<Pick<ChildSessionAssemblyOptions, "approvedBuiltinExtensions" | "extensions">>, RegExp][] = [
    [{ approvedBuiltinExtensions: ["llama.cpp"] as unknown as ChildSessionAssemblyOptions["approvedBuiltinExtensions"] }, /Unknown approved/],
    [{ approvedBuiltinExtensions: ["../other"] as unknown as ChildSessionAssemblyOptions["approvedBuiltinExtensions"] }, /Unknown approved/],
    [{ approvedBuiltinExtensions: null as unknown as ChildSessionAssemblyOptions["approvedBuiltinExtensions"] }, /explicit array/],
    [{ approvedBuiltinExtensions: ["codemode", "codemode"] }, /Duplicate approved/],
    [{ approvedBuiltinExtensions: ["codemode"] }, /Missing built-in/],
    [{ approvedBuiltinExtensions: ["codemode"], extensions: [{ name: "codemode", factory }] }, /Missing built-in/],
    [{ extensions: [{ name: "codemode", builtin: true, factory }] }, /Unapproved built-in/],
    [{ extensions: [{ name: "other-owner", builtin: true, factory }] }, /Unapproved built-in/],
    [{ approvedBuiltinExtensions: ["codemode"], extensions: [
      { name: "codemode", builtin: true, factory }, { name: "codemode", builtin: true, factory },
    ] }, /Duplicate built-in/],
    [{ approvedBuiltinExtensions: ["codemode"], extensions: [{ name: "codemode", builtin: true, factory: undefined as unknown as typeof factory }] }, /Invalid built-in/],
  ];
  for (const [options, error] of cases) await assert.rejects(assembleChildSession({ ...base, ...options }), error);
  assert.equal(factoryCalls, 0);
});

test("explicit MCP assembly uses only the consumer's empty configuration and never connects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-mcp-"));
  const sdk = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
  let runtime: AgentSessionRuntime | undefined;
  let configLoads = 0, transportCalls = 0;
  try {
    const faux = fauxProvider({ provider: "mcp-assembly-faux", api: "mcp-assembly-faux", models: [{ id: "local", contextWindow: 32768, maxTokens: 256 }], tokensPerSecond: 1_000_000 });
    faux.setResponses([fauxAssistantMessage("EMPTY_MCP_OK")]);
    runtime = await assembleChildSession({ cwd: dir, agentDir: dir, sessionManager: sdk.SessionManager.inMemory(dir),
      parentSettings: { packages: [], retry: { enabled: false } }, projectTrusted: false,
      provider: "mcp-assembly-faux", model: "local", thinkingLevel: "off", modelScope: ["mcp-assembly-faux/local"], tools: [],
      systemPrompt: "No server is configured.", approvedBuiltinExtensions: ["mcp"],
      extensions: [pi => pi.registerProvider(faux.provider), { name: "mcp", builtin: true,
        factory: sdk.createMcpExtension({ loadConfig: () => { configLoads++; return { servers: [], errors: [] }; },
          createTransport: () => { transportCalls++; throw new Error("MCP transport must never be created"); } }),
      }], shutdown: () => {},
    });
    const extension = runtime.services.resourceLoader.getExtensions().extensions.find(extension => extension.path === "builtin:mcp")!;
    assert.ok(extension);
    assert.equal(extension.sourceInfo.path, "builtin:mcp");
    assert.equal(extension.sourceInfo.source, "builtin");
    assert.ok(configLoads > 0);
    await runtime.session.prompt("Confirm local assembly");
    assert.match(JSON.stringify(runtime.session.messages), /EMPTY_MCP_OK/);
    assert.equal(transportCalls, 0);
    assert.deepEqual(runtime.session.getActiveToolNames(), []);
  } finally { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
