import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// All runtime modules load after selecting a disposable profile. No real agent
// config, keyring, server process or network is used by these tests.
test("runtime paths, config imports and persistent caches stay in the selected profile", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-path-profile-"));
  const keys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_MCP_CONFIG_MODE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "NPM_CONFIG_CACHE", "npm_config_cache"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const agent = join(root, "agent");
  const claude = join(root, "claude-profile");
  const codex = join(root, "codex-profile");
  const cwd = join(root, "project");
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_MCP_CONFIG_MODE: "exclusive", CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, NPM_CONFIG_CACHE: join(root, "npm"), npm_config_cache: join(root, "npm") });
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  mkdirSync(cwd, { recursive: true });
  put(join(home, ".claude.json"), { mcpServers: { wrongClaudeAccount: { command: "never-run" } } });
  put(join(home, ".codex", "config.toml"), '[mcp_servers.wrongCodexAccount]\ncommand="never-run"');
  put(`${claude}.json`, { mcpServers: { wrongSibling: { command: "never-run" } } });
  put(join(claude, ".claude.json"), { mcpServers: { claudeSelected: { command: "never-run" } } });
  put(join(codex, "config.toml"), '[mcp_servers.codexSelected]\ncommand="never-run"');
  const configPath = join(agent, "mcp-adapter.json");
  put(configPath, { imports: ["claude-code", "codex"], mcpServers: {}, settings: { semanticSearch: false, extraction: { allowedServers: ["claudeSelected"] } }, scriptTools: { sample: { description: "fixture", file: "sample.js" } } });

  const paths = await import("../agent-dir.ts");
  const config = await import("../config.ts");
  const metadata = await import("../metadata-cache.ts");
  const onboarding = await import("../onboarding-state.ts");
  const trust = await import("../project-server-trust.ts");
  const npx = await import("../npx-resolver.ts");
  assert.equal(paths.getAgentDir(), agent);
  assert.equal(config.getPiGlobalConfigPath(), configPath);
  assert.equal(metadata.getMetadataCachePath(), join(agent, "mcp-cache.json"));
  assert.equal(onboarding.getOnboardingStatePath(), join(agent, "mcp-onboarding.json"));
  const load = () => config.loadMcpConfigWithSources(configPath, cwd).config;
  const loaded = load();
  assert.deepEqual(Object.keys(loaded.mcpServers).sort(), ["claudeSelected", "codexSelected"]);
  assert.equal(loaded.settings?.semanticSearch, false);
  assert.deepEqual(loaded.settings?.extraction, { allowedServers: ["claudeSelected"] });
  assert.equal(loaded.scriptTools?.sample.file, join(agent, "sample.js"));
  assert.equal("getPiMcpAuthPath" in config, false);
  // Public Pi mcp.json remains a supported input, independently of private sign-ins.
  put(config.getPiMcpGlobalConfigPath(), { mcpServers: { native: { command: "never-run" } } });
  config.setPiMcpConfigEnabled(true);
  process.env.PI_MCP_CONFIG_MODE = "";
  assert.equal(config.loadMcpConfigWithSources(undefined, cwd).config.mcpServers.native?.command, "never-run");
  process.env.PI_MCP_CONFIG_MODE = "exclusive";
  // A caller mutating its copy must not poison parsed config held in the cache.
  loaded.mcpServers.claudeSelected!.command = "changed";
  assert.equal(load().mcpServers.claudeSelected?.command, "never-run");
  process.env.CLAUDE_CONFIG_DIR = join(root, "missing-claude");
  process.env.CODEX_HOME = join(root, "missing-codex");
  assert.deepEqual(Object.keys(load().mcpServers), []);
  process.env.CLAUDE_CONFIG_DIR = "";
  process.env.CODEX_HOME = "";
  const warnings: string[] = [];
  const warn = t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
  assert.deepEqual(Object.keys(load().mcpServers), []);
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_HOME = codex;
  put(join(claude, ".claude.json"), '{"secret":"DO_NOT_LOG" broken}');
  put(join(codex, "config.toml"), '[broken\nsecret="DO_NOT_LOG"');
  assert.deepEqual(Object.keys(load().mcpServers), []);
  assert.ok(warnings.some(message => message.includes("malformed")));
  assert.ok(warnings.every(message => !message.includes("DO_NOT_LOG")));

  config.writeSharedServerEntry(configPath, "own", { command: "never-run" });
  const version = (path: string) => { const s = statSync(path, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; };
  const before = version(configPath);
  config.writeSharedServerEntry(configPath, "own", { command: "never-run" });
  assert.equal(version(configPath), before);
  const replacement = join(root, "replacement.json");
  put(replacement, { mcpServers: { external: { command: "never-run" } } });
  renameSync(replacement, configPath);
  assert.deepEqual(Object.keys(load().mcpServers), ["external"]);
  const malformed = '{"secret":"DO_NOT_LOG" broken}';
  put(configPath, malformed);
  assert.throws(() => config.writeSharedServerEntry(configPath, "bad", { command: "never-run" }), /malformed/);
  assert.equal(readFileSync(configPath, "utf8"), malformed);

  onboarding.saveOnboardingState({ version: 1, sharedConfigHintShown: false, setupCompleted: false });
  const onboardingVersion = version(onboarding.getOnboardingStatePath());
  onboarding.saveOnboardingState(onboarding.loadOnboardingState());
  assert.equal(version(onboarding.getOnboardingStatePath()), onboardingVersion);
  put(onboarding.getOnboardingStatePath(), malformed);
  assert.throws(() => onboarding.markSetupCompleted(), /malformed/);
  assert.equal(readFileSync(onboarding.getOnboardingStatePath(), "utf8"), malformed);

  const definition = { command: "never-run" };
  trust.approveProjectServer(cwd, "fixture", definition);
  const approvalsPath = join(agent, "mcp-project-approvals.json");
  const approvalVersion = version(approvalsPath);
  trust.approveProjectServer(cwd, "fixture", definition);
  assert.equal(version(approvalsPath), approvalVersion);
  put(approvalsPath, malformed);
  assert.throws(() => trust.approveProjectServer(cwd, "other", definition), /malformed/);
  assert.equal(readFileSync(approvalsPath, "utf8"), malformed);

  const bin = join(root, "fixture.js");
  put(bin, "// never executed");
  const key = JSON.stringify(["npx", "fixture@1.0.0", ""]);
  const npxPath = join(agent, "mcp-npx-cache.json");
  put(npxPath, { version: 2, entries: { [key]: { resolvedBin: bin, resolvedAt: Date.now(), packageVersion: "1.0.0", isJs: true } } });
  assert.deepEqual(await npx.resolveNpxBinary("npx", ["fixture@1.0.0", "--flag"]), { binPath: bin, extraArgs: ["--flag"], isJs: true });
  // Seed npm's on-disk cache so the malformed-cache fallback never runs npm or a network request.
  const packageDir = join(root, "npm", "_npx", "fixture", "node_modules", "fixture");
  put(join(packageDir, "package.json"), { name: "fixture", version: "1.0.0", bin: "fixture.js" });
  put(join(packageDir, "fixture.js"), "// never executed");
  put(npxPath, malformed);
  assert.equal((await npx.resolveNpxBinary("npx", ["fixture@1.0.0"]))?.binPath, join(packageDir, "fixture.js"));
  assert.equal(readFileSync(npxPath, "utf8"), malformed);
  // The same module must not retain the first Pi profile's path or payload.
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-two");
  assert.equal(metadata.loadMetadataCache(), null);
  assert.equal(onboarding.loadOnboardingState().setupCompleted, false);
  assert.equal(paths.getAgentPath("mcp-cache.json"), join(root, "agent-two", "mcp-cache.json"));
  process.env.PI_CODING_AGENT_DIR = agent;

  const cachePath = metadata.getMetadataCachePath();
  const hash = metadata.computeServerHash(definition);
  const tool = { name: "fixture", inputSchema: { type: "object" } };
  const entry = { configHash: hash, cachedAt: 10, tools: [tool], resources: [] };
  const catalog = { tools: [], total: 0, cap: 100, fetchedAt: 10 };
  const output = { source: "structuredContent" as const, shape: "external" };
  metadata.saveMetadataCache({ version: 1, servers: { fixture: entry } });
  const cacheVersion = version(cachePath);
  metadata.saveMetadataCache({ version: 1, servers: { fixture: entry } });
  assert.equal(version(cachePath), cacheVersion);
  // External catalog/output-shape updates survive a startup listing merge.
  put(cachePath, { version: 1, servers: { fixture: { ...entry, outputShapes: { fixture: output }, executorApps: catalog }, external: entry } });
  metadata.saveMetadataCache({ version: 1, servers: { fixture: { ...entry, cachedAt: 20 } } }, { startupSnapshot: { fixture: entry } });
  const merged = metadata.loadMetadataCache()!;
  assert.ok(merged.servers.external);
  assert.deepEqual(merged.servers.fixture?.executorApps, catalog);
  assert.deepEqual(merged.servers.fixture?.outputShapes, { fixture: output });
  metadata.saveMetadataCache({ version: 1, servers: {
    private: { ...entry, cacheScope: "private", executorApps: catalog },
    zeroTtl: { ...entry, ttlMs: 0, executorApps: catalog },
  } });
  assert.equal(metadata.loadMetadataCache()?.servers.private?.executorApps, undefined);
  assert.equal(metadata.loadMetadataCache()?.servers.zeroTtl?.executorApps, undefined);
  put(cachePath, malformed);
  assert.equal(metadata.loadMetadataCache(), null);
  assert.throws(() => metadata.saveMetadataCache({ version: 1, servers: {} }), /malformed/);
  assert.equal(readFileSync(cachePath, "utf8"), malformed);
  warn.mock.restore();
});
