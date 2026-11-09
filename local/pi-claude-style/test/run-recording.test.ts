import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { RunMetricsSnapshot } from "../src/types.ts";

test("child run facts survive headless execution, attach, and detach during a real SDK run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cc-run-recording-")), previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const { createClaudeStyleChildExtension } = await import("../src/child-factory.ts");
  const attaches = new Set<() => void>(), detaches = new Set<() => Promise<void>>();
  const viewLifecycle = {
    onAttach(fn: () => void) { attaches.add(fn); return () => { attaches.delete(fn); }; },
    onDetach(fn: () => Promise<void>) { detaches.add(fn); return () => { detaches.delete(fn); }; },
  };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { entered = resolve; });
  const provider = fauxProvider({ provider: "cc-run-faux", api: "cc-run-faux", models: [{ id: "faux", name: "Faux", contextWindow: 32768, maxTokens: 256, reasoning: false }], tokensPerSecond: 100000 });
  provider.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("attached"), async () => {
    entered(); await gate; return fauxAssistantMessage("detached");
  }]);
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], extensionFactories: [pi => { pi.registerProvider(provider.provider); },
          createClaudeStyleChildExtension({ target: "subagent", taskName: "recording", returnLabel: "Main", readOnlyStatusline: true, viewLifecycle })] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("cc-run-faux", "faux"), tools: [] });
    await result.session.bindExtensions({ mode: "print" });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: directory, agentDir: directory, sessionManager: SessionManager.create(directory, join(directory, "sessions")) });
  const snapshots = () => runtime.session.sessionManager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === "pi-claude-transcript:run-separator"
    ? [(entry.data as { snapshot: RunMetricsSnapshot }).snapshot] : []);
  try {
    const firstStart = Date.now(); await runtime.session.prompt("first");
    assert.equal(snapshots().length, 1);
    const first = snapshots()[0]!;
    assert.equal(first.status, "done"); assert.equal(first.turnCount, 1);
    assert.ok(first.endedAt! >= firstStart && first.endedAt! <= Date.now());
    assert.ok(first.elapsedMs >= 0 && first.elapsedMs <= Date.now() - firstStart);
    for (const attach of attaches) attach();
    await runtime.session.bindExtensions({ mode: "print" });
    assert.deepEqual(snapshots(), [first], "entering never fabricates a past run");
    await runtime.session.prompt("attached");
    assert.equal(snapshots().length, 2); assert.equal(snapshots()[1]!.turnCount, 1, "view does not double-count metric events");
    const run = runtime.session.prompt("detach while running"); await running;
    await new Promise(resolve => setTimeout(resolve, 25));
    for (const detach of detaches) await detach();
    await runtime.session.bindExtensions({ mode: "print" });
    release(); await run;
    const recorded = structuredClone(snapshots());
    assert.equal(recorded.length, 3); assert.ok(recorded[2]!.elapsedMs >= 25); assert.equal(recorded[2]!.turnCount, 1);
    for (const attach of attaches) attach();
    await runtime.session.bindExtensions({ mode: "print" });
    assert.deepEqual(snapshots(), recorded, "re-entry preserves real times and writes no extra separator");
  } finally {
    release(); await runtime.dispose();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(directory, { recursive: true, force: true });
  }
});
