import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  SessionManager, SettingsManager, initTheme, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import installStatusLine from "../../src/statusline/install.ts";
import { MAIN_INITIAL_LINES, MAIN_INITIAL_CONTRIBUTION_LINE } from "../../src/statusline/initial-lines.ts";
import { clearConfigCache } from "../../src/statusline/config.ts";

test("Pi 1.5 SDK displays built-in output without a command or any provider request", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cc-statusline-sdk-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), "{}");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    clearConfigCache(root);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const provider = fauxProvider({ provider: "cc-statusline-faux", api: "cc-statusline-faux",
    models: [{ id: "statusline-model", contextWindow: 32_768, maxTokens: 128 }] });
  let footer: Component | undefined;
  const errors: unknown[] = [];
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], extensionFactories: [pi => {
          pi.registerProvider(provider.provider);
          installStatusLine(pi, undefined, { initialLines: MAIN_INITIAL_LINES, initialContributionLine: MAIN_INITIAL_CONTRIBUTION_LINE });
        }] } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: services.modelRuntime.getModel("cc-statusline-faux", "statusline-model"), tools: [] });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: SessionManager.inMemory(root) });
  try {
    initTheme("dark", false);
    const ui: ExtensionUIContext = {
      ...runtime.session.extensionRunner!.getUIContext(),
      setFooter(factory) {
        footer = factory?.({ requestRender() {} } as TUI, undefined as never, undefined as never);
      },
    };
    await runtime.session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error) });
    const render = () => footer?.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "") ?? "";
    assert.deepEqual(errors, []);
    assert.match(render(), /statusline-model\(cc-statusline-faux\)/, "synchronous fallback");
    assert.equal(footer?.render(120).length, 2, "fallback uses the normal two-row layout");
    const deadline = Date.now() + 8_000;
    // R/W accounting is produced by the asset, not by MAIN_INITIAL_LINES.
    while (!render().includes("R:0·W:0") && Date.now() < deadline) await delay(20);
    assert.match(render(), /↑0·↓0.*R:0·W:0/, "external default script replaced the fallback");
    assert.equal(footer?.render(120).length, 2, "default command does not change height without contributions");
    assert.match(render(), /statusline-model\(cc-statusline-faux\)/);
    assert.doesNotMatch(render(), /\[\[pi:slot:/, "host composed semantic slots");
    assert.deepEqual(errors, []);
    assert.equal(provider.state.callCount, 0, "no prompt and no real provider traffic");
  } finally {
    await runtime.dispose();
  }
});
