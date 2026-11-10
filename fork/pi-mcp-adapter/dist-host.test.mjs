import { piBin, installedPiVersion } from "../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { offlineGuard, sourceResolver, testSandbox } from "./scripts/test-env.mjs";
import test from "node:test";

test("Pi 1.5 loads production per-file dist and validates proxy arguments without loading optional implementations", () => {
  const binary = piBin();
  assert.ok(binary && isAbsolute(binary), "set PI_BIN to an explicit stock Pi binary");
  const actualBinary = realpathSync(binary);
  let hostRoot = dirname(actualBinary);
  while (!existsSync(join(hostRoot, "package.json"))) {
    const parent = dirname(hostRoot);
    assert.notEqual(parent, hostRoot, "the explicit Pi binary must belong to a stock npm installation");
    hostRoot = parent;
  }
  const hostManifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
  assert.equal(hostManifest.name, "@earendil-works/pi-coding-agent");
  assert.equal(hostManifest.version, installedPiVersion());
  assert.equal(realpathSync(resolve(hostRoot, hostManifest.bin.pi)), actualBinary);
  const hostEntry = pathToFileURL(resolve(hostRoot, hostManifest.exports["."].import)).href;
  for (const asset of ["index.js", "index.d.ts", "types.d.ts", "oauth.d.ts", "host-managed.d.ts", "config.d.ts", "metadata-cache.d.ts", "app-bridge.bundle.js", "mcp-keyring-helper.cjs", "semantic-search.js", "ui-session.js"]) {
    assert.ok(existsSync(new URL(`./dist/${asset}`, import.meta.url)), `missing production asset: ${asset}`);
  }
  const sandbox = testSandbox("pi-mcp-dist-host-");
  const root = sandbox.root;
  try {
    // Resolve the import-only public main from the explicit host's dependency
    // graph. require.resolve selects a condition pi-ai intentionally omits.
    const fauxEntry = execFileSync(process.execPath, ["--input-type=module", "--eval", 'process.stdout.write(import.meta.resolve("@earendil-works/pi-ai"))'], {
      cwd: hostRoot, env: sandbox.env, encoding: "utf8", timeout: 30_000,
    }).trim();
    const version = execFileSync(process.execPath, ["--import", sourceResolver, "--import", offlineGuard, actualBinary, "--version"], { env: sandbox.env, encoding: "utf8", timeout: 30_000 }).trim();
    assert.equal(version, installedPiVersion());
    execFileSync(process.execPath, ["--import", sourceResolver, "--import", offlineGuard, "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import { join } from "node:path";
      const loaded = new Set();
      registerHooks({ load(url, context, nextLoad) { loaded.add(url); return nextLoad(url, context); } });
      const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, initTheme, VERSION } = await import(${JSON.stringify(hostEntry)});
      const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(${JSON.stringify(fauxEntry)});
      assert.equal(VERSION, ${JSON.stringify(installedPiVersion())}); initTheme("dark");
      const root = process.env.FORK15_TEST_ROOT, cwd = join(root, "cwd"), agentDir = join(root, "agent");
      const faux = fauxProvider({ provider: "mcp-fixture", api: "mcp-fixture", models: [{ id: "offline" }], tokensPerSecond: 100000 });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("mcp", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("mcp", { search: "offline" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("mcp", { search: "offline", limit: -1 }), { stopReason: "toolUse" }),
        fauxAssistantMessage("MCP offline complete"),
      ]);
      const services = await createAgentSessionServices({ cwd, agentDir,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
          additionalExtensionPaths: [join(process.cwd(), "dist/index.js")], extensionFactories: [pi => pi.registerProvider(faux.provider)] },
      });
      const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model: services.modelRuntime.getModel("mcp-fixture", "offline"), tools: ["mcp"] });
      const errors = [];
      try {
        await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
        assert.ok(session.getActiveToolNames().includes("mcp"));
        assert.equal(session.getToolDefinition("mcp").renderShell, "self");
        await session.prompt("Run only the offline MCP fixture calls.");
        const results = session.messages.filter(message => message.role === "toolResult");
        assert.equal(results.length, 3);
        assert.deepEqual(results.map(result => result.isError), [false, false, true]);
        assert.match(results[2].content[0].text, /limit:/);
        assert.equal(session.getLastAssistantText(), "MCP offline complete");
        assert.deepEqual(errors, []);
        for (const fragment of ["/semantic-search.js", "/ui-session.js", "/mcp-panel.js", "/mcp-setup-panel.js", "/oauth-handler.js", "/@typesafe-ai/sdk/"]) {
          assert.equal([...loaded].some(url => url.includes(fragment)), false, fragment + " must stay lazy");
        }
      } finally { session.dispose(); }
    `], { cwd: new URL(".", import.meta.url), encoding: "utf8", timeout: 30_000,
      env: { ...sandbox.env, FORK15_TEST_ROOT: root },
    });
  } finally { sandbox.cleanup(); }
});
