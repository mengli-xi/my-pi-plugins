import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { make, interactive, params, root, askPath, packageDirectory, fauxAssistantMessage, fauxToolCall } from "./harness.mjs";

for (const selection of [{ tools: ["read"] }, { noTools: "all" }, { excludeTools: ["ask_user_question"] }]) {
  const f = await make({ selection });
  const ui = await interactive(f.runtime);
  try {
    for (let turn = 0; turn < 2; turn++) {
      assert.equal(f.runtime.session.getActiveToolNames().includes("ask_user_question"), false, JSON.stringify(selection));
      f.respond([fauxAssistantMessage("SELECTION_OK")]);
      await f.runtime.session.prompt(`Check explicit selection ${turn}.`);
      assert.equal(f.requests.at(-1).tools.includes("ask_user_question"), false, "agent lifecycle cannot reactivate an explicitly excluded tool");
      if (selection.tools) assert.deepEqual(f.requests.at(-1).tools, ["read"]);
      if (selection.noTools) assert.deepEqual(f.requests.at(-1).tools, []);
      f.assertComplete();
    }
  } finally { ui.view.stop(); await f.runtime.dispose(); }
}

// A headless bind removes Ask. Merely acquiring a UI is not a new grant;
// only the host's public, explicit selection makes the tool available again.
{
  const f = await make({ selection: { tools: ["ask_user_question"] } });
  let ui;
  try {
    await f.runtime.session.bindExtensions({ mode: "print", onError: error => f.errors.push(error) });
    f.respond([fauxAssistantMessage("PRINT_NO_WAIT")]);
    await f.runtime.session.prompt("Finish without a UI.");
    assert.equal(f.runtime.session.getActiveToolNames().includes("ask_user_question"), false);
    assert.equal(f.requests.at(-1).tools.includes("ask_user_question"), false);
    ui = await interactive(f.runtime);
    assert.equal(f.runtime.session.getActiveToolNames().includes("ask_user_question"), false, "headless to UI never silently restores permission");
    f.respond([fauxAssistantMessage("UI_STILL_EXCLUDED")]);
    await f.runtime.session.prompt("A UI is not authorization.");
    assert.equal(f.requests.at(-1).tools.includes("ask_user_question"), false);
    f.runtime.session.setActiveToolsByName(["ask_user_question"]);
    f.respond([fauxAssistantMessage(fauxToolCall("ask_user_question", params), { stopReason: "toolUse" }), fauxAssistantMessage("HOST_ALLOWED")]);
    ui.clear();
    const shown = ui.visible(params.questions[0].question);
    const run = f.runtime.session.prompt("Host explicitly allowed this question.");
    await shown; await ui.send("\r"); await run;
    const result = f.runtime.session.messages.filter(message => message.role === "toolResult").at(-1);
    assert.equal(result.isError, false);
    assert.equal(result.details.answers[0].answer, "Live");
    assert.equal(f.runtime.session.getLastAssistantText(), "HOST_ALLOWED");
    f.assertComplete();
  } finally { ui?.view.stop(); await f.runtime.dispose(); }
}

const piPackage = packageDirectory("@earendil-works/pi-coding-agent");
const cliPath = join(piPackage, JSON.parse(readFileSync(join(piPackage, "package.json"), "utf8")).bin.pi);
const providerPath = fileURLToPath(new URL("./selection-provider.mjs", import.meta.url));
const base = ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--offline",
  "--extension", askPath, "--extension", providerPath, "--model", "ask-cli-faux/offline", "--thinking", "off"];
for (const [name, args, expected] of [
  ["allowlist", ["--tools", "read"], ["read"]],
  ["none", ["--no-tools"], []],
  ["exclude", ["--exclude-tools", "ask_user_question"], undefined],
]) {
  const agentDir = join(root, `cli-${name}`); mkdirSync(agentDir);
  const record = join(root, `cli-${name}.json`);
  const client = new RpcClient({ cliPath, cwd: join(root, "cwd"), env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ASK_TOOL_RECORD: record }, args: [...base, ...args] });
  try {
    await client.start();
    await client.promptAndWait("CHECK_EXPLICIT_SELECTION");
    const actual = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(actual.tools.includes("ask_user_question"), false, `real CLI ${name} selection must survive session_start and agent lifecycle`);
    assert.equal(actual.hasUI, true, "RPC supplies native dialogs; absence is selection, not a missing UI");
    if (expected) assert.deepEqual(actual.tools, expected);
    assert.equal((await client.getState()).isStreaming, false);
  } finally { await client.stop(); }
}
const printDir = join(root, "cli-print"); mkdirSync(printDir);
const printRecord = join(root, "cli-print.json");
const output = execFileSync(process.execPath, [cliPath, ...base, "--tools", "ask_user_question", "--print", "PRINT_WITHOUT_UI"], {
  cwd: join(root, "cwd"), encoding: "utf8", timeout: 15000,
  env: { ...process.env, PI_CODING_AGENT_DIR: printDir, ASK_TOOL_RECORD: printRecord },
});
assert.match(output, /CLI_SELECTION_OK/);
const printed = JSON.parse(readFileSync(printRecord, "utf8"));
assert.equal(printed.hasUI, false);
assert.equal(printed.tools.includes("ask_user_question"), false, "even an explicit initial selection cannot make print block for a questionnaire");
console.log("ASK_INTEGRATION_OK explicit SDK/CLI selection, no implicit restoration, explicit Host grant and print");
