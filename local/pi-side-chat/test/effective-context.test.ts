import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MainContextSource } from "../effective-context.ts";
import { SideRuntime } from "../sdk-runtime.ts";

test("provider capture survives force/late transform, Side excludes removed raw history and BTW keeps separate system/no tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-source-"));
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: "RAW_REMOVED_HISTORY", timestamp: 1 });
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "model", contextWindow: 32000 }], tokensPerSecond: 100000 });
  let actual: unknown[] = [];
  let force = true;
  faux.setResponses([context => { actual = structuredClone(context.messages); return fauxAssistantMessage("Main answer"); }, () => fauxAssistantMessage("Second Main answer")]);
  let source!: MainContextSource;
  let ctx!: ExtensionContext;
  const main = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), resourceLoaderOptions: {
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
      extensionFactories: [pi => {
        pi.registerProvider(faux.provider);
        source = new MainContextSource(pi);
        pi.on("session_start", (_event, context) => { ctx = context; });
        pi.on("before_agent_start", () => force ? { systemPrompt: "FORCED_MAIN_SYSTEM" } : undefined);
        pi.on("context_with_system", event => ({ messages: [
          ...event.messages.filter(message => !JSON.stringify(message).includes("RAW_REMOVED_HISTORY")),
          { role: "system", content: [{ type: "text", text: "LATE_EFFECTIVE_MEMORY" }], sections: { fixture: "CURRENT_SECTION" }, timestamp: 9 },
        ] }));
      }],
    } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: services.modelRuntime.getModel("fixture", "model"), tools: [] });
    await result.session.bindExtensions({ mode: "rpc" });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir: root, sessionManager: manager });
  let side: SideRuntime | undefined;
  try {
    assert.throws(() => source.select(ctx), /Complete one Main turn/);
    assert.equal(source.select(ctx, true).source, "native-projection");
    await main.session.prompt("Capture current request");
    const selected = source.select(ctx);
    assert.equal(selected.source, "request-capture");
    assert.deepEqual(selected.messages.slice(0, actual.length), actual);
    assert.doesNotMatch(JSON.stringify(selected), /RAW_REMOVED_HISTORY/);
    const snapshot = source.snapshot(ctx);
    assert.ok(snapshot.messages.every(message => message.role !== "system"));
    assert.equal(snapshot.systemPrompt, "FORCED_MAIN_SYSTEM");
    const sideFaux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "model", contextWindow: 32000 }], tokensPerSecond: 100000 });
    sideFaux.setResponses([context => {
      assert.deepEqual(context.messages.slice(0, actual.length), actual);
      assert.doesNotMatch(JSON.stringify(context), /RAW_REMOVED_HISTORY/);
      return fauxAssistantMessage("Side answer");
    }]);
    const mainBefore = await readFile(manager.getSessionFile()!, "utf8");
    const settingsBefore = structuredClone(main.services.settingsManager.getSettings());
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: { compaction: { enabled: false } }, projectTrusted: false,
      selection: selected, provider: "fixture", model: "model", thinkingLevel: "off", modelScope: ["fixture/model"], tools: [],
      systemPrompt: snapshot.systemPrompt, factories: async () => [pi => pi.registerProvider(sideFaux.provider)] });
    await side.prompt("Side question");
    assert.equal(side.session.messages.filter(message => message.role === "assistant").at(-1)?.stopReason, "stop");
    assert.equal(await readFile(manager.getSessionFile()!, "utf8"), mainBefore);
    assert.deepEqual(main.services.settingsManager.getSettings(), settingsBefore);
    force = false;
    await main.session.prompt("Capture structured system deltas");
    const structured = source.snapshot(ctx);
    assert.match(structured.systemPrompt, /LATE_EFFECTIVE_MEMORY/);
    assert.match(structured.systemPrompt, /CURRENT_SECTION/);
    assert.doesNotMatch(structured.systemPrompt, /\[object Object\]/);
    assert.ok(structured.messages.every(message => message.role !== "system"));
  } finally { await side?.destroy(); await main.dispose(); await rm(root, { recursive: true, force: true }); }
});
