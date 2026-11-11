import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { assembleChildSession, getSessionAssemblyPublicModules } from "../../src/session-assembly.ts";
import { loadApprovedFactoryModule } from "../../src/factory-loader.ts";

// The CLI's real extension loader supplies Main's imports. The approved loader
// supplies the child imports, and the actual SDK child executes the comparison.
export default async function (_pi: ExtensionAPI) {
  const modules = getSessionAssemblyPublicModules();
  const sdk = modules["@earendil-works/pi-coding-agent"];
  const childModule = await loadApprovedFactoryModule({
    path: fileURLToPath(new URL("./public-module-child.ts", import.meta.url)), exports: ["create"], publicModules: modules,
  });
  const create = childModule.create as typeof import("./public-module-child.ts").create;
  const model = getBuiltinModels("anthropic")[0]!;
  let observed = false;
  const runtime = await assembleChildSession({
    cwd: process.cwd(), agentDir: getAgentDir(), sessionManager: sdk.SessionManager.inMemory(process.cwd()),
    parentSettings: { packages: [], retry: { enabled: false } }, projectTrusted: false,
    provider: model.provider, model: model.id, thinkingLevel: "off", modelScope: [`${model.provider}/${model.id}`],
    tools: [], systemPrompt: "Module identity check. No provider requests.", shutdown: () => {},
    extensions: [create(child => {
        assert.equal(child.StringEnum, StringEnum, "Main/child StringEnum identity");
        assert.equal(child.openAIResponsesApi, openAIResponsesApi, "Main/child openAIResponsesApi identity");
        observed = true;
      })],
  });
  try {
    assert.equal(observed, true);
    assert.equal(runtime.session.messages.length, 0);
    console.log("PI_PUBLIC_MODULE_IDENTITY " + JSON.stringify({ version: sdk.VERSION, StringEnum: true, openAIResponsesApi: true }));
  } finally { await runtime.dispose(); }
}
