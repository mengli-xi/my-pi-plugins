import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "./index.ts";
import { validateSemanticSearchSettings } from "./semantic-settings.ts";
import { createMcpRuntimeOwner } from "./runtime-owner.ts";
import { offlineGuard, testSandbox } from "./scripts/test-env.mjs";

function semanticFixture(settings: unknown = {}) {
  const owner = createMcpRuntimeOwner();
  const classifier = {
    findOfType: vi.fn(), getProviderAuthStatus: vi.fn(),
    classify: vi.fn(async () => { throw new Error("Unexpected provider request"); }),
  };
  const state = { owner, config: { settings: { semanticSearch: settings }, mcpServers: {} } } as never;
  return { owner, state, classifier };
}

describe("cold registration and optional client boundaries", () => {
  it("keeps config validation and tool/command/runtime registration synchronous without a classifier", () => {
    const tools: string[] = [], commands: string[] = [], events: string[] = [];
    const api = {
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      registerFlag: vi.fn(), on: vi.fn(), getAllTools: () => [],
      events: { on: (name: string) => events.push(name), emit: vi.fn() },
    };
    const result = createMcpAdapter({ config: { mcpServers: {} } })(api as never);
    expect(result).not.toBeInstanceOf(Promise);
    expect(tools).toContain("mcp");
    expect(tools).not.toContain("mcpScript");
    expect(commands).toEqual(expect.arrayContaining(["mcp-adapter", "mcp-auth"]));
    expect(events).toContain("pi-mcp-adapter:protocol:v1");
    expect(events).toContain("pi-mcp-adapter:runtime-register:v1");
    expect(() => validateSemanticSearchSettings({ model: "missing-provider" })).toThrow("provider/id");
    expect(() => validateSemanticSearchSettings({ minProbability: -1 })).toThrow();
  });

  it("does not call a classifier for disabled, invalid or aborted searches", async () => {
    const { semanticSearch } = await import("./semantic-search.ts");
    const { findTools } = await import("./proxy-modes.ts");
    const disabled = semanticFixture(false);
    expect(await semanticSearch(disabled.state, "offline", undefined, undefined, disabled.classifier)).toMatchObject({ ok: false, error: { code: "disabled" } });
    const invalid = semanticFixture({ candidateLimit: -1 });
    expect(await semanticSearch(invalid.state, "offline", undefined, undefined, invalid.classifier)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const controller = new AbortController(); controller.abort(new Error("stale request"));
    const enabled = semanticFixture();
    await expect(findTools(enabled.state, { query: "offline", searchMode: "semantic", signal: controller.signal, classifier: enabled.classifier })).rejects.toThrow("stale request");
    for (const fixture of [disabled, invalid, enabled]) {
      expect(fixture.classifier.findOfType).not.toHaveBeenCalled();
      expect(fixture.classifier.classify).not.toHaveBeenCalled();
    }
  });

  it("fails closed if the runtime retires while the semantic implementation loads", async () => {
    const { findTools } = await import("./proxy-modes.ts");
    const { owner, state, classifier } = semanticFixture();
    const search = findTools(state, { query: "offline", searchMode: "semantic", classifier });
    const rejected = expect(search).rejects.toThrow();
    await owner.stop("session replaced during semantic import");
    await rejected;
    expect(classifier.findOfType).not.toHaveBeenCalled();
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});

describe("public exports and real startup module graph", () => {
  it("keeps an empty session cold without a cache, then discovers and gates servers added before its first MCP request", () => {
    const sandbox = testSandbox("mcp-empty-session-");
    try {
      const result = spawnSync(process.execPath, ["--import", offlineGuard, "--import", "tsx", "--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        const modules = new Set();
        registerHooks({ resolve(specifier, context, next) {
          const result = next(specifier, context); modules.add(result.url); return result;
        } });
        const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, initTheme } = await import("@earendil-works/pi-coding-agent");
        const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
        const { createMcpAdapter } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
        const root = process.env.MCP_EMPTY_TEST_ROOT, cwd = join(root, "cwd");
        const configPath = join(root, "empty.json");
        writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
        initTheme("dark");
        const faux = fauxProvider({ provider: "empty-fixture", api: "empty-fixture", models: [{ id: "offline" }], tokensPerSecond: 100000 });
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("mcp", { search: "later" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("done"),
        ]);
        const snapshots = [], errors = [];
        const services = await createAgentSessionServices({ cwd, agentDir: join(root, "agent"),
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
          resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
            extensionFactories: [createMcpAdapter({ configPath }), pi => {
              pi.registerProvider(faux.provider);
              pi.events.on("pi-mcp-adapter/status/v1", snapshot => snapshots.push(snapshot));
            }] },
        });
        const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd),
          model: services.modelRuntime.getModel("empty-fixture", "offline"), tools: ["mcp"] });
        try {
          await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
          assert.ok(session.getActiveToolNames().includes("mcp"));
          for (const name of ["init", "mcp-auth-flow", "lifecycle"]) {
            assert.equal([...modules].some(url => url.endsWith("/" + name + ".ts")), false, name + " must stay cold for an empty session without a metadata cache");
          }
          // Empty server configuration must not suppress held Task recovery.
          session.sessionManager.appendCustomEntry("mcp-task-v1", {
            version: 1, kind: "pending", sessionId: session.sessionManager.getSessionId(),
            key: "removed/t1", server: "removed", tool: "build",
            reference: { endpointId: "old-endpoint", generation: "v2", taskId: "t1", originalOperation: "tools/call" },
            deliveryId: "task:held", anchorEntryId: "original-leaf", scope: "origin-leaf",
          });
          let recovered;
          const recovery = new Promise(resolve => { recovered = resolve; });
          await session.bindExtensions({ mode: "tui", uiContext: {
            notify(message) { if (message.includes("held for their original branch")) recovered(); },
            setStatus() {}, theme: { fg: (_color, text) => text },
          } });
          let timer;
          try {
            await Promise.race([recovery, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("empty configuration suppressed held Task recovery")), 10000); })]);
          } finally { clearTimeout(timer); }
          // Return to the empty/deferred state before adding new configuration.
          await session.bindExtensions({ mode: "rpc" });
          // This command would fail the test if approval were bypassed. A project
          // server added after startup must be discovered by the first operation.
          writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
            later: { command: process.execPath, args: ["-e", "throw new Error('unapproved server ran')"] },
          } }));
          await session.prompt("Search MCP without approving project servers.");
          assert.ok([...modules].some(url => url.endsWith("/init.ts")), "the first operation initializes the runtime");
          assert.ok(snapshots.some(snapshot => snapshot.servers.some(server => server.name === "later" && server.status === "blocked")), "new configuration and project trust are resolved before the tool completes");
          assert.equal(session.messages.filter(message => message.role === "toolResult").length, 1);
          assert.equal(session.getLastAssistantText(), "done");
          assert.deepEqual(errors, []);
        } finally { session.dispose(); }
      `], { cwd: new URL(".", import.meta.url), env: { ...sandbox.env, MCP_EMPTY_TEST_ROOT: sandbox.root }, encoding: "utf8", timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally { sandbox.cleanup(); }
  }, 35_000);

  it("keeps every public runtime identity and Apps schema export", async () => {
    const publicTypes = await import("./types.ts");
    const runtime = await import("./runtime-types.ts");
    for (const [name, value] of Object.entries(runtime)) expect(publicTypes[name], name).toBe(value);
    expect(publicTypes.MCP_STATUS_SNAPSHOT_VERSION).toBe(1);
    expect(publicTypes.uiStreamModeSchema.safeParse("stream-first").success).toBe(true);
    expect(publicTypes.formatToolName("x".repeat(80), "demo", "server")).toHaveLength(64);
  });

  it("does not traverse optional clients or Apps implementations on a fresh import and registration", () => {
    const sandbox = testSandbox("mcp-cold-import-");
    const trace = join(sandbox.root, "trace.txt");
    const tracer = join(sandbox.root, "trace.mjs");
    // Trace resolution instead of load: every module that is loaded is resolved first,
    // and synchronous resolve hooks also cover createRequire(). A synchronous load hook
    // that wraps the async loader chain (tsx) receives `{ format: "commonjs", source: null }`
    // from Node's async defaultLoad and fails strict load validation before Node 24.12.
    writeFileSync(tracer, `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  appendFileSync(${JSON.stringify(trace)}, result.url + "\\n");
  return result;
} });`);
    try {
      const result = spawnSync(process.execPath, ["--import", offlineGuard, "--import", tracer, "--import", "tsx", "--input-type=module", "-e", `
        const { createMcpAdapter } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
        createMcpAdapter({ config: { mcpServers: {} } })({ registerTool() {}, registerCommand() {}, registerFlag() {}, on() {}, getAllTools() { return []; }, events: { on() {}, emit() {} } });
      `], { cwd: new URL(".", import.meta.url), env: sandbox.env, encoding: "utf8", timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const modules = readFileSync(trace, "utf8").split("\n");
      expect(modules.some(url => url.endsWith("/index.ts"))).toBe(true);
      for (const name of ["jev-client", "jev-key-store", "ui-stream-types", "ui-session", "mcp-panel", "mcp-auth-flow", "semantic-search", "extraction"]) {
        expect(modules.some(url => url.endsWith(`/${name}.ts`)), name).toBe(false);
      }
      for (const fragment of ["/@typesafe-ai/sdk/", "/zod/", "/@modelcontextprotocol/client/"]) {
        expect(modules.some(url => url.includes(fragment)), fragment).toBe(false);
      }
    } finally { sandbox.cleanup(); }
  }, 35_000);
});
