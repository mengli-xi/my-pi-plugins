import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";

// This is only the offline actor. Tool selection, execution, dialogs and the
// extension under test all belong to the actual CLI and production Ask entry.
export default function (pi) {
  globalThis.fetch = async () => { throw new Error("Network is forbidden in Ask CLI integration"); };
  let hasUI;
  pi.on("before_agent_start", (_event, ctx) => { hasUI = ctx.hasUI; });
  const faux = fauxProvider({ provider: "ask-cli-faux", api: "ask-cli-faux", models: [{ id: "offline" }], tokensPerSecond: 10000000 });
  faux.setResponses([context => {
    const tools = getCurrentTools(context.messages).map(tool => tool.name);
    assert.equal(tools.includes("ask_user_question"), false, "Ask must not expand CLI selection or block a print request");
    assert.ok(process.env.ASK_TOOL_RECORD);
    writeFileSync(process.env.ASK_TOOL_RECORD, JSON.stringify({ tools, hasUI }));
    return fauxAssistantMessage("CLI_SELECTION_OK");
  }]);
  pi.registerProvider(faux.provider);
}
