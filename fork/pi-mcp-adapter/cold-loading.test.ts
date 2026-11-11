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
