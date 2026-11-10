import { grantTemporarySdkFixture } from "../../../local/pi-subagents/test/fixtures/sdk-grant.ts";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { captureEntrypointDescriptorV1, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { createSdkFixtureFactory } from "./sdk-view-provider/src/child-factory.ts";

const root = process.env.PI_S2_VIEW_ROOT;
const log = value => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ at: Date.now(), ...value }) + "\n");
export default function fixture(pi) {
  createSdkFixtureFactory()(pi);
  const descriptor = captureEntrypointDescriptorV1(join(dirname(fileURLToPath(import.meta.url)), "sdk-view-provider/src/child.ts"));
  const registry = getOrCreateChildCapabilityRegistryV1();
  const manifest = { version: 1, owner_id: "side-view-fixture", main_entrypoint: captureEntrypointDescriptorV1(fileURLToPath(import.meta.url)),
    targets: { "pi-side-chat": { child_entrypoint: descriptor, activation: "required-only", commands: [], tools: [],
      providers: [{ provider_id: "side-fixture", service_tiers: [], service_tier_application: "none" }], hooks: [], requires: [],
      sdk_provider_factory: { provider_id: "side-fixture", package_manifest: captureEntrypointDescriptorV1(fileURLToPath(new URL("./sdk-view-provider/package.json", import.meta.url))), module: captureEntrypointDescriptorV1(fileURLToPath(new URL("./sdk-view-provider/src/child-factory.ts", import.meta.url))), export: "createSdkFixtureFactory", config: {}, artifacts: [] },
    } } };
  grantTemporarySdkFixture(manifest, "pi-side-chat");
  const registration = registry.register({ version: 1, manifest });
  let ctx, editor, originalEditor, starts = 0, bindingLease, generation = 0, working = false;
  const cursor = globalThis[Symbol.for("s2-controls")] ??= { processed: 0 };
  pi.on("session_start", (_event, context) => {
    ctx = context; starts++;
    bindingLease?.release();
    bindingLease = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: ctx.sessionManager.getSessionId(), runtime_generation: ++generation, mode: ctx.mode });
    if (ctx.hasUI) {
      // Capture a real stock editor through the public factory API when CC is absent.
      const factory = ctx.ui.getEditorComponent() ?? ((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }));
      ctx.ui.setEditorComponent(new Proxy(factory, { apply(target, receiver, args) { editor = Reflect.apply(target, receiver, args); originalEditor ??= editor; return editor; } }));
    }
    log({ event: "main-ready", starts });
  });
  pi.on("session_shutdown", event => { log({ event: "main-shutdown", reason: event.reason }); bindingLease?.release(); clearInterval(timer); registration.release(); });
  const snapshot = () => {
    const side = globalThis[Symbol.for("s2-view-fixture")]?.contexts.get("side");
    let sideState;
    try { sideState = { sideDraft: side?.hasUI ? side.ui.getEditorText() : undefined, sideMode: side?.mode, sideModel: side?.model?.id, sideThinking: side?.thinkingLevel, sideIdle: side?.isIdle(), sideFile: side?.sessionManager.getSessionFile() }; }
    catch { sideState = { sideMode: "disposed" }; }
    return { mainDraft: ctx.ui.getEditorText(), mainIdle: ctx.isIdle(), mainModel: ctx.model.id, mainThinking: ctx.thinkingLevel, editorSame: !!editor && editor === originalEditor, starts, ...sideState,
      listeners: { stdin: process.stdin.listenerCount("data"), sigterm: process.listenerCount("SIGTERM"), sighup: process.listenerCount("SIGHUP"), uncaught: process.listenerCount("uncaughtException"), raw: process.stdin.isRaw } };
  };
  const execute = async command => {
    if (command.op === "snapshot") return snapshot();
    if (command.op === "main-settings") return pi.getSettings();
    if (command.op === "bash-definitions") return {
      main: pi.getAllTools().find(tool => tool.name === "bash"),
      side: globalThis[Symbol.for("s2-view-fixture")]?.apis.get("side")?.getAllTools().find(tool => tool.name === "bash"),
    };
    if (command.op === "main-draft") return ctx.ui.setEditorText(command.text);
    if (command.op === "background") return pi.sendUserMessage(command.text, { deliverAs: "followUp" });
    if (command.op === "side-shutdown") return globalThis[Symbol.for("s2-view-fixture")].contexts.get("side").shutdown();
    if (command.op === "main-quit") { void editor.onSubmit("/quit"); return; }
    if (command.op === "main-reload") { void editor.onSubmit("/reload"); return; }
    if (command.op === "main-new") { void editor.onSubmit("/new"); return; }
    if (command.op === "drift") {
      // Inject a failed Side probe, not a bundled-host prototype from a different module identity.
      // The behavior tests separately exercise no-op/changed native methods at the probe boundary.
      const ids = { renderSessionEntries: "side-chat.child.render-session-entries", addMessageToChat: "side-chat.child.compaction-display" };
      const probe = globalThis[Symbol.for("pi.claude-style.internals.v1")]?.probes.get(ids[command.method]);
      if (!probe) throw new Error(`Side probe not installed for ${command.method}`);
      probe.check = () => false;
      return;
    }
    throw new Error(`Unknown control ${command.op}`);
  };
  const timer = setInterval(async () => {
    if (working || !ctx || !existsSync(join(root, "commands.jsonl"))) return;
    working = true;
    try {
      const commands = readFileSync(join(root, "commands.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      for (const command of commands.slice(cursor.processed)) {
        cursor.processed++;
        try { log({ event: "control", id: command.id, result: await execute(command) }); }
        catch (error) { log({ event: "control", id: command.id, error: String(error), stack: error.stack }); }
      }
    } finally { working = false; }
  }, 20);
  timer.unref();
}
