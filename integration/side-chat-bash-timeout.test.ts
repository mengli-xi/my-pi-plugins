import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { captureEntrypointDescriptorV1, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { contextFingerprint } from "pi-session-runtime/effective-context";
import { createBashTimeoutTool } from "../local/pi-bash-timeout/extensions/tool.ts";
import { sideExecutionPlan } from "../local/pi-side-chat/sdk-factories.ts";
import { SideRuntime } from "../local/pi-side-chat/sdk-runtime.ts";

const directory = fileURLToPath(new URL("../local/pi-bash-timeout/extensions/", import.meta.url));
const main = captureEntrypointDescriptorV1(join(directory, "index.ts"));
const child = captureEntrypointDescriptorV1(join(directory, "child.ts"));
const model = fauxProvider({ provider: "timeout-fixture", api: "timeout-fixture", models: [{ id: "fixture" }] }).getModel();

function fixture(options: { active?: boolean; builtin?: boolean; target?: boolean; hash?: string; path?: string; drift?: boolean } = {}) {
  const sessionId = randomUUID();
  const registry = getOrCreateChildCapabilityRegistryV1();
  const entry = options.path ? captureEntrypointDescriptorV1(options.path) : child;
  const target = { child_entrypoint: { ...entry, sha256: options.hash ?? entry.sha256 }, activation: "required-only" as const,
    commands: [], tools: ["bash"], providers: [], hooks: [], requires: [] };
  const registration = registry.register({ version: 1, manifest: { version: 1, owner_id: "pi-bash-timeout", main_entrypoint: main,
    targets: { "pi-subagents": target, ...(options.target === false ? {} : { "pi-side-chat": target }) } } });
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: sessionId, runtime_generation: 1, mode: "rpc" });
  const definition = createBashTimeoutTool(() => ({}));
  const mainTool = { ...definition, ...(options.drift ? { description: "Changed Main definition" } : {}),
    exposure: "direct", sourceInfo: { path: options.builtin ? "builtin:bash" : main.canonical_path, source: options.builtin ? "builtin" : "local", scope: "temporary", origin: "top-level" } };
  const pi = { getActiveTools: () => options.active === false ? [] : ["bash"], getAllTools: () => [mainTool] } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => sessionId }, model, scopedModels: [], modelRegistry: { getAvailable: () => [], getRegisteredProviderIds: () => [] } } as unknown as ExtensionContext;
  return { pi, ctx, mainTool, release() { binding.release(); registration.release(); } };
}

for (const options of [{ active: false }, { builtin: true }]) test(`Timeout is required-only for Side: ${JSON.stringify(options)}`, async () => {
  const source = fixture(options);
  try {
    const plan = await sideExecutionPlan(source.pi, source.ctx, "unused-agent");
    assert.equal((await plan.factories("side")).length, 0);
    assert.deepEqual(plan.tools, options.active === false ? [] : ["bash"]);
  } finally { source.release(); }
});

for (const options of [{ target: false }, { hash: "0".repeat(64) }, { path: main.canonical_path, hash: main.sha256 }]) test(`Timeout catalog rejects descriptor drift: ${JSON.stringify(options)}`, async () => {
  await assert.rejects(async () => {
    const source = fixture(options);
    try { await sideExecutionPlan(source.pi, source.ctx, "unused-agent"); }
    finally { source.release(); }
  }, /Side factory|Unapproved Side factory|live file identity/);
});

test("Timeout catalog rejects a loaded child definition that differs from Main", async () => {
  const source = fixture({ drift: true });
  try {
    const plan = await sideExecutionPlan(source.pi, source.ctx, "unused-agent");
    const [factory] = await plan.factories("side");
    assert.throws(() => factory!({ registerTool() { assert.fail("drifted definition must not register"); } } as unknown as ExtensionAPI), /Side bash definition changed/);
  } finally { source.release(); }
});

test("Side's audited Timeout factory keeps the Main fingerprint and real schema/execution isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-timeout-"));
  const source = fixture();
  const parentSettings = { shellCommandPrefix: "export SIDE_TIMEOUT_SCOPE=SIDE_ONLY", retry: { enabled: false }, compaction: { enabled: false } };
  const settingsBefore = structuredClone(parentSettings);
  const mainFile = join(root, "main.jsonl");
  await writeFile(mainFile, "MAIN_UNCHANGED");
  const faux = fauxProvider({ provider: model.provider, api: model.api, models: [{ id: model.id }], tokensPerSecond: 1000000 });
  const cases: Array<{ name: string; args: Record<string, string | number> }> = [{ name: "missing", args: {} }, { name: "zero", args: { timeout: 0 } }, { name: "negative", args: { timeout: -1 } }, { name: "invalid", args: { timeout: "invalid" } }];
  faux.setResponses([
    ...cases.flatMap(item => [fauxAssistantMessage(fauxToolCall("bash", { command: `printf BAD > '${join(root, item.name)}'`, ...item.args }), { stopReason: "toolUse" }), fauxAssistantMessage("SCHEMA_REJECTED")]),
    fauxAssistantMessage(fauxToolCall("bash", { command: `printf "$SIDE_TIMEOUT_SCOPE" > '${join(root, "valid")}'`, timeout: 2 }), { stopReason: "toolUse" }), fauxAssistantMessage("LOCAL_BASH_DONE"),
  ]);
  let side: SideRuntime | undefined;
  try {
    const plan = await sideExecutionPlan(source.pi, source.ctx, join(root, "agent"));
    side = await SideRuntime.create({ cwd: root, agentDir: join(root, "agent"), parentSettings, projectTrusted: false,
      selection: { source: "request-capture", exactRequestPrefix: false, messages: [], turnAnchors: [], preambleMessageIndices: [], attachedMessageIndices: [], turnMappingReliable: false },
      provider: model.provider, model: model.id, thinkingLevel: "off", systemPrompt: "Fixture", modelScope: plan.modelScope, tools: plan.tools,
      factories: async id => [pi => pi.registerProvider(faux.provider), ...await plan.factories(id)] });
    const fingerprint = (tool: { name: string; description: string; parameters: unknown; promptGuidelines?: readonly string[]; exposure?: string }) => contextFingerprint({
      name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines ?? [], exposure: tool.exposure ?? "direct" });
    const sideTool = side.session.getAllTools().find(tool => tool.name === "bash")!;
    assert.equal(fingerprint(sideTool), fingerprint(source.mainTool));
    assert.deepEqual(side.session.getActiveToolNames(), ["bash"]);
    for (const item of cases) {
      await side.prompt(item.name);
      const result: AgentMessage = side.session.messages.filter(message => message.role === "toolResult").at(-1)!;
      assert.equal(result.role === "toolResult" && result.isError, true);
      assert.match(JSON.stringify(result), /timeout/);
      await assert.rejects(readFile(join(root, item.name)), { code: "ENOENT" });
    }
    await side.prompt("valid timeout");
    const result = side.session.messages.filter(message => message.role === "toolResult").at(-1)!;
    assert.equal(result.role === "toolResult" && result.isError, false);
    assert.equal(await readFile(join(root, "valid"), "utf8"), "SIDE_ONLY");
    assert.equal(await readFile(mainFile, "utf8"), "MAIN_UNCHANGED");
    assert.deepEqual(parentSettings, settingsBefore);
    assert.equal(faux.state.callCount, (cases.length + 1) * 2);
  } finally { await side?.destroy(); source.release(); await rm(root, { recursive: true, force: true }); }
});
