import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { EffectiveContextSelection } from "pi-session-runtime/native-child-context";
import { SideRuntime, SideStartupCleanupError } from "../sdk-runtime.ts";

const selection: EffectiveContextSelection = { source: "request-capture", exactRequestPrefix: true,
  messages: [{ role: "system", content: "Captured Main prompt", timestamp: 1 }, { role: "user", content: "EFFECTIVE_ONLY", timestamp: 2 }],
  turnAnchors: [{ entryId: "main-user", messageIndex: 1 }], preambleMessageIndices: [0], attachedMessageIndices: [], turnMappingReliable: true };

test("SDK Side owns private seed/settings, continues and destroys only its scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-sdk-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const mainPath = join(root, "main.jsonl"); await writeFile(mainPath, "MAIN_UNCHANGED");
  const settingsPath = join(agentDir, "settings.json"); await writeFile(settingsPath, "{\"compaction\":{\"enabled\":false}}\n");
  const settings = { compaction: { enabled: false } };
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "large", contextWindow: 32000, maxTokens: 1024 }], tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage("Side answer"), fauxAssistantMessage("Side followup")]);
  let side: SideRuntime | undefined;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir, parentSettings: settings, projectTrusted: false, selection,
      provider: "fixture", model: "large", thinkingLevel: "off", modelScope: ["fixture/large"], tools: [],
      systemPrompt: "Captured Main prompt", factories: async () => [pi => pi.registerProvider(faux.provider)] });
    assert.equal((await stat(side.directory)).mode & 0o777, 0o700);
    const sessionPath = join(side.directory, "side-session.jsonl");
    assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
    assert.match(await readFile(sessionPath, "utf8"), /EFFECTIVE_ONLY/);
    assert.equal(side.inheritedEntryIds.size, 2);
    assert.equal(side.session.settingsManager.getCompactionSettings(side.session.model).enabled, true);
    await side.prompt("Side question"); await side.prompt("Follow up");
    assert.equal(side.session.messages.filter(message => message.role === "assistant").length, 2);
    assert.deepEqual(settings, { compaction: { enabled: false } });
    assert.equal(await side.pressEmptyDelete(), "armed");
    assert.ok(await stat(side.directory));
    assert.equal(await side.pressEmptyDelete(), "destroyed");
    await side.destroy();
    await assert.rejects(stat(side.directory), { code: "ENOENT" });
    assert.equal(await readFile(mainPath, "utf8"), "MAIN_UNCHANGED");
    assert.equal(await readFile(settingsPath, "utf8"), "{\"compaction\":{\"enabled\":false}}\n");
  } finally { await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("first provider prefix is exact, two native auto compactions retire it, then followup continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-compaction-"));
  const requests: string[] = [];
  let summaries = 0;
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "large", contextWindow: 32000, maxTokens: 4096 }], tokensPerSecond: 1000000 });
  // Public faux-provider boundary reports high usage to exercise Pi's real
  // threshold path without generating 100 KB of irrelevant fixture prose.
  const stream = faux.provider.streamSimple.bind(faux.provider);
  faux.provider.streamSimple = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of stream(model, context, options)) {
        if (event.type === "done" && event.message.content.some(block => block.type === "text" && block.text.startsWith("ANSWER_"))) {
          event.message.usage.input = 30000; event.message.usage.output = 1000; event.message.usage.cacheRead = 0; event.message.usage.cacheWrite = 0; event.message.usage.totalTokens = 31000;
        }
        output.push(event);
      }
      output.end();
    })();
    return output;
  };
  let business = 0;
  faux.setResponses(Array.from({ length: 30 }, () => context => {
    const body = JSON.stringify(context.messages);
    if (body.includes("structured context checkpoint") || body.includes("earlier context from an ongoing conversation") || body.includes("NEW conversation messages")) {
      summaries++;
      return fauxAssistantMessage(`NATIVE_COMPACT_${summaries}`);
    }
    requests.push(body); business++;
    if (business === 1) assert.deepEqual(context.messages.slice(0, selection.messages.length), selection.messages);
    return fauxAssistantMessage("ANSWER_" + business + " detail".repeat(1700));
  }));
  let side: SideRuntime | undefined;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: { compaction: { enabled: false }, retry: { enabled: false } }, projectTrusted: false, selection,
      provider: "fixture", model: "large", thinkingLevel: "off", modelScope: ["fixture/large"], tools: [],
      systemPrompt: "Side runtime prompt", factories: async () => [pi => pi.registerProvider(faux.provider)] });
    await side.prompt("First question" + " content".repeat(1500));
    await side.prompt("Second question" + " content".repeat(1500));
    const compactions = side.session.sessionManager.getBranch().filter(entry => entry.type === "compaction");
    assert.equal(compactions.length, 2);
    assert.ok(summaries >= 2);
    await side.prompt("Followup after two native compactions");
    assert.equal(requests.length, 3);
    assert.match(requests[2], /NATIVE_COMPACT_/);
    assert.doesNotMatch(requests[2], /EFFECTIVE_ONLY/);
  } finally { await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("small-model switch precompacts with an allowed larger model and rejects out-of-scope models", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-model-"));
  const models: string[] = [];
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "large", contextWindow: 64000, maxTokens: 4096 }, { id: "small", contextWindow: 8000, maxTokens: 1024 }, { id: "forbidden", contextWindow: 64000 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 20 }, () => (context, _options, _state, model) => {
    models.push(model.id);
    const body = JSON.stringify(context.messages);
    const summary = body.includes("structured context checkpoint") || body.includes("earlier context from an ongoing conversation") || body.includes("NEW conversation messages");
    if (summary) { assert.equal(model.id, "large"); return fauxAssistantMessage("COMPACTED_FOR_SMALL"); }
    assert.equal(model.id, "small"); assert.ok(body.length < 24000); return fauxAssistantMessage("SMALL_OK");
  }));
  const big = structuredClone(selection);
  for (let i = 0; i < 50; i++) big.messages.push({ role: "user", content: `history ${i} ` + "x".repeat(1600), timestamp: i + 10 },
    { ...fauxAssistantMessage("ack"), api: "fixture", provider: "fixture", model: "large" });
  let side: SideRuntime | undefined;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: { retry: { enabled: false } }, projectTrusted: false, selection: big,
      provider: "fixture", model: "large", thinkingLevel: "off", modelScope: ["fixture/large", "fixture/small"], tools: [],
      systemPrompt: "Side", factories: async () => [pi => pi.registerProvider(faux.provider)] });
    await assert.rejects(side.session.setModel(side.runtime.services.modelRuntime.getModel("fixture", "forbidden")!), /outside the Side scope/);
    await side.session.setModel(side.runtime.services.modelRuntime.getModel("fixture", "small")!);
    assert.equal(side.session.settingsManager.getCompactionSettings(side.session.model).reserveTokens, 1000);
    await side.prompt("Use the small model");
    assert.ok(models.includes("large")); assert.equal(models.at(-1), "small");
    assert.equal(side.session.messages.filter(message => message.role === "assistant").at(-1)?.stopReason, "stop");
    assert.equal(side.session.model?.id, "small");
    assert.equal(side.session.settingsManager.getCompactionSettings(side.session.model).reserveTokens, 1000);
    assert.ok(side.session.sessionManager.getBranch().some(entry => entry.type === "compaction"));
  } finally { await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("oversized seed with no fitting authorized summarizer fails before any provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-overflow-"));
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "small", contextWindow: 8000 }], tokensPerSecond: 100000 });
  const big = structuredClone(selection);
  big.messages.push({ role: "user", content: "x".repeat(150000), timestamp: 3 });
  let side: SideRuntime | undefined;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: {}, projectTrusted: false, selection: big,
      provider: "fixture", model: "small", thinkingLevel: "off", modelScope: ["fixture/small"], tools: [],
      systemPrompt: "Side", factories: async () => [pi => pi.registerProvider(faux.provider)] });
    await assert.rejects(side.prompt("Question"), /exceeds every allowed compaction input window/);
    assert.equal(faux.state.callCount, 0);
  } finally { await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("destroy aborts native precompaction and fences a late continuation before removing the directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-destroy-"));
  let started!: () => void;
  const summarizing = new Promise<void>(resolve => { started = resolve; });
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "large", contextWindow: 64000 }, { id: "small", contextWindow: 8000 }], tokensPerSecond: 100000 });
  faux.setResponses([async (_context, options) => {
    started();
    await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
    return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
  }]);
  const big = structuredClone(selection);
  for (let i = 0; i < 50; i++) big.messages.push({ role: "user", content: `history ${i} ` + "x".repeat(1600), timestamp: i + 10 }, { ...fauxAssistantMessage("ack"), api: "fixture", provider: "fixture", model: "large" });
  let side: SideRuntime | undefined;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: { retry: { enabled: false } }, projectTrusted: false, selection: big,
      provider: "fixture", model: "small", thinkingLevel: "off", modelScope: ["fixture/large", "fixture/small"], tools: [],
      systemPrompt: "Side", factories: async () => [pi => pi.registerProvider(faux.provider)] });
    const run = side.prompt("Question");
    const rejected = assert.rejects(run, /cancel|interrupt|abort/i);
    await summarizing;
    await side.destroy(); await rejected;
    await assert.rejects(stat(side.directory), { code: "ENOENT" });
    assert.equal(faux.state.callCount, 1);
    await assert.rejects(side.prompt("Late question"), /unavailable/);
  } finally { await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});


for (const tools of [[], ["read"]]) test(`resumed SDK Side keeps explicit ${JSON.stringify(tools)} despite inherited tools`, async () => {
  const root = await mkdtemp(join(tmpdir(), "side-tools-"));
  const inherited = structuredClone(selection);
  inherited.messages[0] = { role: "system", content: "Main", timestamp: 1,
    toolsAdded: [{ name: "main_only", description: "Unavailable in Side", parameters: { type: "object", properties: {} } }] };
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "model", contextWindow: 32000 }], tokensPerSecond: 100000 });
  let observed: string[] = [];
  faux.setResponses([context => {
    assert.deepEqual(context.messages.slice(0, inherited.messages.length), inherited.messages);
    observed = getCurrentTools(context.messages).map(tool => tool.name);
    return fauxAssistantMessage("OK");
  }]);
  let side: SideRuntime | undefined;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: {}, projectTrusted: false, selection: inherited,
      provider: "fixture", model: "model", thinkingLevel: "off", modelScope: ["fixture/model"], tools,
      systemPrompt: "Side", factories: async () => [pi => pi.registerProvider(faux.provider)] });
    assert.deepEqual(side.session.getActiveToolNames(), tools);
    await side.prompt("Question");
    assert.deepEqual(observed, tools);
    assert.deepEqual(side.session.getActiveToolNames(), tools);
  } finally { await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});

for (const stage of ["factories", "assembly"] as const) test(`failed SDK ${stage} startup removes its seed directory`, async () => {
  const root = await mkdtemp(join(tmpdir(), "side-startup-failed-"));
  try {
    await assert.rejects(SideRuntime.create({ cwd: root, agentDir: root, parentSettings: {}, projectTrusted: false, selection,
      provider: "fixture", model: "missing", thinkingLevel: "off", modelScope: ["fixture/missing"], tools: [], systemPrompt: "Side",
      factories: async () => { if (stage === "factories") throw new Error("FACTORY_START_FAILED"); return []; },
    }), stage === "factories" ? /FACTORY_START_FAILED/ : /model-unavailable/);
    assert.deepEqual(await readdir(join(root, "pi-side-chat", "runtime")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable cancellation precedes Side policy/runtime retirement and directory removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-cancel-order-"));
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "model", contextWindow: 32000 }] });
  let side: SideRuntime | undefined, release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const accepted = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  try {
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: {}, projectTrusted: false, selection,
      provider: "fixture", model: "model", thinkingLevel: "off", modelScope: ["fixture/model"], tools: [], systemPrompt: "Side",
      factories: async () => [pi => pi.registerProvider(faux.provider)], beforeDispose: async cause => { calls.push(cause); started(); await accepted; assert.ok(await stat(side!.directory)); } });
    const dispose = side.runtime.dispose.bind(side.runtime);
    side.runtime.dispose = async () => { calls.push("runtime.dispose"); await dispose(); };
    const destroying = side.destroy("main-shutdown"); await entered;
    assert.deepEqual(calls, ["main-shutdown"]); assert.ok(await stat(side.directory)); assert.equal(faux.state.callCount, 0);
    release(); await destroying; await side.destroy();
    assert.deepEqual(calls, ["main-shutdown", "runtime.dispose"]); await assert.rejects(stat(side.directory), { code: "ENOENT" });
  } finally { release?.(); await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("failed durable cancellation preserves Side and can be retried before disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-cancel-retry-"));
  const faux = fauxProvider({ provider: "fixture", api: "fixture", models: [{ id: "model", contextWindow: 32000 }] });
  let side: SideRuntime | undefined, attempts = 0, disposed = false;
  try {
    side = await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: {}, projectTrusted: false, selection,
      provider: "fixture", model: "model", thinkingLevel: "off", modelScope: ["fixture/model"], tools: [], systemPrompt: "Side",
      factories: async () => [pi => pi.registerProvider(faux.provider)], beforeDispose: async () => { if (++attempts === 1) throw new Error("FAULT durable cancel"); } });
    const dispose = side.runtime.dispose.bind(side.runtime); side.runtime.dispose = async () => { disposed = true; await dispose(); };
    await assert.rejects(side.destroy(), /FAULT durable cancel/);
    assert.equal(disposed, false); assert.ok(await stat(side.directory));
    await side.destroy(); assert.equal(disposed, true); assert.equal(attempts, 2); await assert.rejects(stat(side.directory), { code: "ENOENT" });
  } finally { await side?.destroy(); await rm(root, { recursive: true, force: true }); }
});


test("failed startup cancellation transfers a retryable cleanup owner to the caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-startup-cancel-"));
  let cleanup: SideStartupCleanupError | undefined, cancellations = 0;
  try {
    try {
      await SideRuntime.create({ cwd: root, agentDir: root, parentSettings: {}, projectTrusted: false, selection,
        provider: "fixture", model: "missing", thinkingLevel: "off", modelScope: ["fixture/missing"], tools: [], systemPrompt: "Side",
        factories: async () => { throw new Error("startup failed"); },
        beforeDispose: async cause => { assert.equal(cause, "startup-failed"); if (++cancellations === 1) throw new Error("FAULT durable cancel"); },
      });
      assert.fail("expected startup cleanup failure");
    } catch (error) { assert.ok(error instanceof SideStartupCleanupError); cleanup = error; }
    assert.ok(await stat(cleanup.directory));
    assert.equal(cancellations, 1);
    await cleanup.retryCleanup();
    assert.equal(cancellations, 2);
    await assert.rejects(stat(cleanup.directory), { code: "ENOENT" });
  } finally { await cleanup?.retryCleanup(); await rm(root, { recursive: true, force: true }); }
});
