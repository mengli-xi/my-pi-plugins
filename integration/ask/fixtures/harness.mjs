import { installedPiVersion } from "../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  InteractiveMode, SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";

assert.equal(VERSION, installedPiVersion());
export const root = process.env.ASK_TEST_ROOT;
assert.ok(root, "the parent must supply an isolated artifact directory");
globalThis.fetch = async () => { throw new Error("Network is forbidden in Ask integration"); };
export const askPath = fileURLToPath(new URL("../../../fork/pi-ask-user-question/index.ts", import.meta.url));
export const ccPath = fileURLToPath(new URL("../../../local/pi-claude-style/dist/index.ts", import.meta.url));
export const plain = value => stripVTControlCharacters(value);
export { fauxAssistantMessage, fauxToolCall };
export const params = {
  context: "You are reviewing checkout totals. This choice changes when discounts appear; Live updates the open page immediately.",
  questions: [{ question: "When should totals refresh?", header: "Refresh", options: [
    { label: "Live", description: "Update the open page immediately." },
    { label: "On reopen", description: "Wait until the page opens again." },
  ] }],
};

export function packageDirectory(name) {
  let current = dirname(realpathSync(fileURLToPath(import.meta.resolve(name))));
  while (current !== parse(current).root) {
    try { if (JSON.parse(readFileSync(join(current, "package.json"), "utf8")).name === name) return current; } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  throw new Error(`Cannot find package root for ${name}`);
}

/** Copy the actual consumer, not an imitation. Only its required peers are
 * linked: an absent SDK cannot leak in through the workspace's node_modules. */
export async function isolatedConsumer(i18n) {
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  const source = dirname(askPath);
  for (const name of ["package.json", "index.ts", "ask-user-question.ts", "answer-channel.ts", "config.ts", "context.ts", "events.ts", "presentation.ts", "reconcile.ts", "rpc-fallback.ts", "state", "tool", "view", "locales"]) {
    cpSync(join(source, name), join(consumer, name), { recursive: true });
  }
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox", "@juicesharp/rpiv-config", ...(i18n === "installed" ? ["@juicesharp/rpiv-i18n"] : [])]) {
    const target = join(consumer, "node_modules", name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(packageDirectory(name), target, "dir");
  }
  writeFileSync(join(consumer, "probe.mjs"), 'export const resolve = () => import.meta.resolve("@juicesharp/rpiv-i18n/loader");\n');
  const probe = await import(pathToFileURL(join(consumer, "probe.mjs")).href);
  if (i18n === "absent") assert.throws(probe.resolve, { code: "ERR_MODULE_NOT_FOUND" }, "SDK absence is physical consumer resolution failure, not an unloaded extension");
  else assert.match(probe.resolve(), /rpiv-i18n/);
  return join(consumer, "index.ts");
}

let sequence = 0;
export async function make({ entry = askPath, cc = "none", selection = {} } = {}) {
  const cwd = join(root, "cwd"), agentDir = join(root, "agent", `session-${++sequence}`);
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const faux = fauxProvider({ provider: "ask-joint-faux", api: "ask-joint-faux", models: [{ id: "offline" }], tokensPerSecond: 10000000 });
  const errors = [], requests = [];
  let responses = [];
  const paths = cc === "before" ? [ccPath, entry] : cc === "after" ? [entry, ccPath] : [entry];
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], quietStartup: true,
        retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], additionalExtensionPaths: paths,
        extensionFactories: [pi => pi.registerProvider(faux.provider)],
      },
    });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: services.modelRuntime.getModel("ask-joint-faux", "offline"), thinkingLevel: "off", ...selection });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  runtime.session.subscribe(event => { if (event.type === "extension_error") errors.push(event); });
  return { runtime, errors, requests,
    respond(values) {
      responses = [...values];
      faux.setResponses(values.map(response => async context => {
        requests.push({ messages: structuredClone(context.messages), tools: getCurrentTools(context.messages).map(tool => tool.name) });
        responses.shift();
        return typeof response === "function" ? response(context) : response;
      }));
    },
    assertComplete() { assert.equal(responses.length, 0); assert.deepEqual(errors, []); },
  };
}

/** Pi's public Terminal interface, owned entirely by the test. No process TTY,
 * clipboard, external editor, renderer or questionnaire object is replaced. */
export async function interactive(runtime) {
  const writes = new EventEmitter();
  let input, output = "";
  const terminal = {
    columns: 120, rows: 50, kittyProtocolActive: false,
    start(callback) { input = callback; }, stop() {},
    write(text) { output += text; writes.emit("write"); },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {}, async drainInput() {},
  };
  const view = new InteractiveMode(runtime, { terminal, tuiMode: "regular" });
  await view.init();
  return { view, clear() { output = ""; }, get output() { return plain(output); },
    async send(...keys) { for (const key of keys) { input(key); await setImmediate(); } },
    visible(text) {
      if (plain(output).includes(text)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); writes.off("write", check); };
        const check = () => { if (plain(output).includes(text)) { cleanup(); resolve(); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`UI did not render ${text}: ${plain(output).slice(-6000)}`)); }, 10000);
        writes.on("write", check);
      });
    },
  };
}

export function receipt(runtime, result, args, expanded = false) {
  const runner = runtime.session.extensionRunner;
  const definition = runtime.session.getToolDefinition("ask_user_question");
  assert.ok(definition?.renderResult, "the real Ask definition retains its native receipt");
  const renderers = runner.resolveToolRenderers("ask_user_question", () => definition);
  assert.ok(renderers?.renderResult);
  const context = { args, toolCallId: result.toolCallId, invalidate() {}, lastComponent: undefined, state: {},
    cwd: join(root, "cwd"), executionStarted: true, argsComplete: true, isPartial: false, expanded,
    showImages: false, isError: result.isError, durationMs: 0, outputPad: 0, keyHint: () => "", keyText: () => "" };
  const theme = runner.createContext().ui.theme;
  const call = renderers.renderCall?.(args, theme, context).render(120) ?? [];
  const response = renderers.renderResult(result, { expanded, isPartial: false }, theme, context).render(120);
  return plain([...call, ...response].join("\n"));
}
