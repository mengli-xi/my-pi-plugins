import assert from "node:assert/strict";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  InteractiveMode, SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";

assert.equal(VERSION, "1.5.0");
globalThis.fetch = async () => { throw new Error("Network is forbidden in the questionnaire fixture"); };
const root = process.env.FORK15_TEST_ROOT;
assert.ok(root);
const cwd = join(root, "cwd"), agentDir = join(root, "agent");
const extensionPath = new URL("../../index.ts", import.meta.url).pathname;
const params = {
  context: "You are checking checkout totals. This choice decides when discounts appear; Live updates the open page immediately.",
  questions: [{ question: "When should totals refresh?", header: "Refresh", options: [
    { label: "Live", description: "Update while the page is open." },
    { label: "On reopen", description: "Update when the page opens again." },
  ] }],
};

async function make() {
  const faux = fauxProvider({ provider: "ask-fixture", api: "ask-fixture", models: [{ id: "offline" }], tokensPerSecond: 100000 });
  const errors = [];
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ quietStartup: true, retry: { enabled: false }, compaction: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [extensionPath], extensionFactories: [pi => pi.registerProvider(faux.provider)],
      },
    });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: services.modelRuntime.getModel("ask-fixture", "offline"), tools: ["ask_user_question"],
    });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  runtime.session.subscribe(event => { if (event.type === "extension_error") errors.push(event); });
  return { runtime, faux, errors };
}

for (const tuiMode of ["regular", "fullscreen"]) {
  const { runtime, faux, errors } = await make();
  const writes = new EventEmitter();
  let send, output = "";
  const terminal = {
    columns: 120, rows: 40, kittyProtocolActive: false,
    start(input) { send = input; }, stop() {},
    write(text) { output += text; writes.emit("write"); },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {}, async drainInput() {},
  };
  const view = new InteractiveMode(runtime, { terminal, tuiMode });
  function visible(text) {
    if (output.includes(text)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`UI did not render ${text}: ${output.slice(-3000)}`)); }, 5000);
      const check = () => { if (output.includes(text)) { cleanup(); resolve(); } };
      const cleanup = () => { clearTimeout(timer); writes.off("write", check); };
      writes.on("write", check);
    });
  }
  try {
    await view.init();
    assert.equal(runtime.session.getToolDefinition("ask_user_question").exposure, "model-only");
    for (const scenario of ["answer", "chat", "explain"]) {
      console.log(`${tuiMode}: ${scenario}`);
      output = "";
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ask_user_question", params), { stopReason: "toolUse" }),
        fauxAssistantMessage(`Finished ${scenario}`),
      ]);
      const shown = visible("5. Explain More");
      const run = runtime.session.prompt(`Run ${scenario} questionnaire.`);
      await shown;
      if (scenario === "chat") for (let i = 0; i < 3; i++) { send("\u001b[B"); await setImmediate(); }
      if (scenario === "explain") for (let i = 0; i < 4; i++) { send("\u001b[B"); await setImmediate(); }
      send("\r");
      if (scenario === "explain") {
        await visible("What would you like explained?");
        send("Why live?"); send("\r");
      }
      await run;
      const result = runtime.session.messages.filter(message => message.role === "toolResult").at(-1);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.details.error, undefined);
      if (scenario === "answer") {
        assert.equal(result.details.cancelled, false);
        assert.equal(result.details.answers[0].answer, "Live");
      } else if (scenario === "chat") {
        assert.equal(result.details.chat.question, params.questions[0].question);
        assert.equal(result.details.explain, undefined);
      } else {
        assert.equal(result.details.explain.notes, "Why live?");
        assert.equal(result.details.chat, undefined);
      }
      assert.equal(runtime.session.getLastAssistantText(), `Finished ${scenario}`);
    }
    for (const cancellation of ["abort", "replacement"]) {
      console.log(`${tuiMode}: ${cancellation}`);
      output = "";
      faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_user_question", params), { stopReason: "toolUse" })]);
      const originalSession = runtime.session;
      const shown = visible("5. Explain More");
      const run = originalSession.prompt(`Cancel via ${cancellation}.`);
      await shown;
      if (cancellation === "abort") await originalSession.abort();
      else await runtime.newSession();
      await run;
      const result = originalSession.messages.filter(message => message.role === "toolResult").at(-1);
      assert.ok(result?.isError || result?.details?.cancelled, JSON.stringify(result));
      // The fresh/current host must remain usable after closing the questionnaire.
      faux.setResponses([fauxAssistantMessage(`Recovered ${cancellation}`)]);
      await runtime.session.prompt("Continue without a questionnaire.");
      assert.equal(runtime.session.getLastAssistantText(), `Recovered ${cancellation}`);
    }
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user_question", { ...params, questions: [] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("ask_user_question", { ...params, questions: [{ ...params.questions[0], options: [
        { label: "Chat about this", description: "Reserved control label." }, params.questions[0].options[1],
      ] }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Validation complete"),
    ]);
    await runtime.session.prompt("Check schema and reserved-label rejection without opening UI.");
    const rejected = runtime.session.messages.filter(message => message.role === "toolResult").slice(-2);
    assert.equal(rejected[0].isError, true);
    assert.match(rejected[0].content[0].text, /questions:/);
    assert.equal(rejected[1].details.error, "reserved_label");
    assert.deepEqual(errors, []);
  } finally {
    view.stop(); await runtime.dispose();
  }
}

const { runtime, faux, errors } = await make();
try {
  await runtime.session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  faux.setResponses([context => {
    assert.equal(getCurrentTools(context.messages).some(tool => tool.name === "ask_user_question"), false);
    return fauxAssistantMessage("Noninteractive complete");
  }]);
  await runtime.session.prompt("Do not ask a blocking question.");
  assert.equal(runtime.session.getActiveToolNames().includes("ask_user_question"), false);
  assert.equal(runtime.session.getLastAssistantText(), "Noninteractive complete");
  assert.deepEqual(errors, []);
} finally {
  await runtime.dispose();
}
console.log("Pi 1.5.0 questionnaire: 6 answer/control interactions, 4 cancellation/replacement interactions, 4 validation cases and 1 noninteractive scenario passed");
