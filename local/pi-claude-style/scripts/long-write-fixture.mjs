// Offline Responses transport: real Pi parser, public SDK, production presentation factories.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import xterm from "@xterm/headless";

export default async function run() {
  const root = process.env.CC_LONG_WRITE_ROOT;
  assert.ok(root, "run through benchmark-long-write.mjs (isolated HOME/agent/cwd required)");
  const scenario = process.env.CC_LONG_WRITE_SCENARIO ?? "main";
  const presentation = process.env.CC_LONG_WRITE_PRESENTATION ?? "default";
  assert.ok(["default", "native", "inline"].includes(presentation));
  const dist = process.env.CC_LONG_WRITE_DIST;
  const bundle = name => dist ? pathToFileURL(join(dist, name)).href : new URL(`../dist/${name}`, import.meta.url).href;
  const parser = process.env.CC_LONG_WRITE_PARSER !== "bypass";
  const size = Number(process.env.CC_LONG_WRITE_KIB ?? 100);
  const chunkChars = Number(process.env.CC_LONG_WRITE_CHUNK ?? 24);
  const delayMs = Number(process.env.CC_LONG_WRITE_DELAY ?? 0);
  const line = "这是一段用于长参数流式回归的中文报告，包含转义字符：\"引号\"与反斜杠\\，并保持最终内容完整。\n";
  const content = line.repeat(Math.ceil(size * 1024 / Buffer.byteLength(line))).slice(0, Math.floor(size * 1024 / 3));
  const args = { path: join(root, "report.txt"), content };
  const json = JSON.stringify(args);
  const memory = [], deltas = [], previewRows = [], rendererErrors = [];
  let previewCapturedAt;
  const sample = () => { const m = process.memoryUsage(); memory.push({ at: performance.now(), ...m }); };
  let started, parseStarted, firstCall = true, tui, mode;
  let writtenBytes = 0, frames = 0, maxFrameBytes = 0;
  // Bounded terminal grid: fullscreen transcript rows are composed by Pi's
  // renderer and are absent from the root TUI.render() chrome-only layout.
  const screen = new xterm.Terminal({ cols: 112, rows: 38, scrollback: 0, allowProposedApi: true });
  const screenRows = async () => {
    tui.renderNow(true);
    await new Promise(resolve => screen.write("", resolve));
    return Array.from({ length: screen.rows }, (_, row) =>
      screen.buffer.active.getLine(screen.buffer.active.viewportY + row)?.translateToString(true) ?? "");
  };
  const terminal = { columns: 112, rows: 38, kittyProtocolActive: false,
    start() {}, stop() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    write(data) { writtenBytes += Buffer.byteLength(data); frames++; maxFrameBytes = Math.max(maxFrameBytes, data.length); screen.write(data); } };
  const model = { id: "long-write", name: "离线长 write", api: "openai-responses", provider: "long-write-faux",
    baseUrl: "http://127.0.0.1:1/never-used", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 131072 };
  const outputMessage = () => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const output = outputMessage();
      if (!firstCall) {
        output.content = [{ type: "text", text: "离线写入完成。" }];
        stream.push({ type: "done", reason: "stop", message: output }); stream.end(output); return;
      }
      firstCall = false;
      const originalPush = stream.push.bind(stream);
      stream.push = (event) => {
        if (event.type === "toolcall_delta") deltas.push({ chars: event.delta.length,
          cumulativeChars: parseStarted.chars, parserMs: performance.now() - parseStarted.at });
        return originalPush(event);
      };
      async function* events() {
        const item = { type: "function_call", id: "fc_bench", call_id: "call_bench", name: "write", arguments: "" };
        yield { type: "response.output_item.added", output_index: 0, item };
        await tick();
        for (let offset = 0; offset < json.length; offset += chunkChars) {
          const delta = json.slice(offset, offset + chunkChars);
          parseStarted = { at: performance.now(), chars: offset + delta.length };
          yield { type: "response.function_call_arguments.delta", output_index: 0, delta };
          await tick();
          // Force a real layout each delta; terminal output is discarded without retaining frames.
          const layoutStart = performance.now();
          tui.render(112);
          const entry = deltas.at(-1);
          entry.layoutMs = performance.now() - layoutStart;
          entry.deliveryMs = performance.now() - parseStarted.at - entry.parserMs - entry.layoutMs;
          if (offset % (chunkChars * 64) === 0) sample();
          if (offset + chunkChars >= json.length) {
            previewRows.push(...await screenRows());
            previewCapturedAt = performance.now();
          }
          if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        yield { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: json } };
        yield { type: "response.completed", response: { id: "resp_bench", status: "completed", output: [],
          usage: { input_tokens: 10, output_tokens: content.length, total_tokens: content.length + 10 } } };
      }
      if (parser) await processResponsesStream(events(), output, stream, model);
      else {
        // Control transport: bounded work per delta, authoritative complete arguments at toolcall_end.
        for await (const event of events()) {
          if (event.type === "response.output_item.added") {
            output.content = [{ type: "toolCall", id: "call_bench|fc_bench", name: "write", arguments: { path: args.path } }];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          } else if (event.type === "response.function_call_arguments.delta") {
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: event.delta, partial: output });
          } else if (event.type === "response.output_item.done") {
            output.content[0].arguments = args;
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: output.content[0], partial: output });
          }
        }
        output.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end(output);
    })().catch(error => { const output = outputMessage(); output.stopReason = "error"; output.errorMessage = error.stack;
      stream.push({ type: "error", reason: "error", error: output }); stream.end(output); });
    return stream;
  };
  if (presentation !== "default") {
    const configDir = join(root, "agent", "extensions", "pi-claude-style");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ schemaVersion: 6, revision: 0,
      overrides: { transcript: { expandMode: "inline", ...(presentation === "native" ? { grouping: { write: false } } : {}) } } }));
  }
  const factories = [];
  if (scenario !== "native") {
    if (scenario === "child") {
      const { createClaudeStyleChildExtension } = await import(bundle("child.ts"));
      factories.push(createClaudeStyleChildExtension({ target: "subagent", taskName: "长写入基准", returnLabel: "Main", readOnlyStatusline: true }));
    } else factories.push((await import(bundle("index.ts"))).default);
  }
  if (scenario === "main-perf") factories.push((await import("../../pi-perf/index.ts")).default);
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], quietStartup: true,
    theme: "dark", showTerminalProgress: false, terminal: { showImages: false },
    compaction: { enabled: false }, retry: { enabled: false }, fullscreenExitOutput: "none" });
  const cwd = join(root, "cwd"), agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp"], systemPrompt: "离线基准，不允许联网。",
        extensionFactories: [(pi) => pi.registerProvider(model.provider, { api: model.api, apiKey: "faux", baseUrl: model.baseUrl,
          models: [{ ...model }], streamSimple }), ...factories, (pi) => {
          // Registered after CC: the public resolver chain puts this observer
          // immediately around the stock renderer, before CC wraps its child.
          pi.registerToolRenderer((toolName, next) => {
            const real = next();
            if (toolName !== "write" || !real) return real;
            return { ...real, ...Object.fromEntries(["renderCall", "renderResult"].filter(slot => real[slot]).map(slot =>
              [slot, (...args) => { try { return real[slot](...args); } catch (error) {
                rendererErrors.push({ slot, message: String(error) }); throw error;
              } }])) };
          });
          pi.on("session_start", (_event, ctx) => {
            if (ctx.mode !== "tui") return;
            if (presentation !== "default") ctx.ui.setToolsExpanded(true);
            ctx.ui.setWidget("bench-reference", ui => { tui = ui; return { render: () => [] }; });
          });
        }] } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: services.modelRuntime.getModel(model.provider, model.id), tools: ["write"], thinkingLevel: "off" });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  mode = new InteractiveMode(runtime, { tuiMode: "fullscreen", initialThemeSetting: "dark", terminal });
  await mode.init();
  await runtime.session.bindExtensions({ shutdownHandler: () => {} });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(tui, "public widget must capture live TUI");
  sample(); started = performance.now();
  await runtime.session.prompt("将中文长报告用一次 write 写入隔离文件。");
  const elapsedMs = performance.now() - started;
  await tick();
  let finalRows = await screenRows();
  // prompt completion precedes CC's short display-only typewriter drain.
  const displayDeadline = Date.now() + 2_000;
  while (!finalRows.join("\n").includes("离线写入完成") && Date.now() < displayDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    finalRows = await screenRows();
  }
  const finalCapturedAt = performance.now();
  sample();
  assert.equal(readFileSync(args.path, "utf8"), content);
  assert.deepEqual(rendererErrors, [], "stock renderer must not throw and silently fall back");
  assert.ok(finalCapturedAt > previewCapturedAt, "final UI must be collected after prompt completion");
  assert.ok(runtime.session.messages.some(message => message.role === "assistant" && message.content.some(block =>
    block.type === "text" && block.text === "离线写入完成。")), "prompt must finish the post-tool assistant response");
  assert.ok(finalRows.join("\n").includes("离线写入完成"), "final terminal frame must finish the display-only drain");
  const sum = key => deltas.reduce((n, row) => n + row[key], 0);
  const percentile = (key, p) => [...deltas].sort((a, b) => a[key] - b[key])[Math.floor((deltas.length - 1) * p)]?.[key];
  const result = { scenario, presentation, parser, kib: size, chunkChars, delayMs, runtime: process.versions,
    contentBytes: Buffer.byteLength(content), argumentBytes: Buffer.byteLength(json), deltaCount: deltas.length,
    elapsedMs, parserMs: sum("parserMs"), deliveryMs: sum("deliveryMs"), layoutMs: sum("layoutMs"),
    parserP50Ms: percentile("parserMs", .5), parserP95Ms: percentile("parserMs", .95),
    deliveryP95Ms: percentile("deliveryMs", .95), layoutP95Ms: percentile("layoutMs", .95),
    memoryStart: memory[0], memoryEnd: memory.at(-1), memoryPeak: Object.fromEntries(["rss", "heapUsed", "external", "arrayBuffers"].map(key => [key, Math.max(...memory.map(row => row[key]))])),
    writtenBytes, frames, maxFrameBytes, finalSha256: createHash("sha256").update(readFileSync(args.path)).digest("hex"),
    previewRows, previewCapturedAtMs: previewCapturedAt - started,
    finalRows, finalCapturedAtMs: finalCapturedAt - started,
    finalAssistantVisible: finalRows.join("\n").includes("离线写入完成"), rendererErrors, memory, deltas };
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  if (scenario === "main") {
    await runtime.session.prompt("/internals");
    await tick();
    const entry = runtime.session.sessionManager.getBranch().findLast(entry =>
      entry.type === "custom_message" && entry.customType === "internals");
    const report = entry?.details;
    assert.equal(typeof report, "string", "fresh Main must produce the complete /internals report");
    writeFileSync(join(root, "internals-full.txt"), report);
    assert.ok(!report.includes("缺失") && !report.includes("调用失败"), report);
  }
  mode.stop("none");
  screen.dispose();
  console.log(JSON.stringify({ scenario, size, parser, elapsedMs, parserMs: result.parserMs, deliveryMs: result.deliveryMs, layoutMs: result.layoutMs, peak: result.memoryPeak }));
  process.exit(0);
}

if (process.env.CC_LONG_WRITE_DIRECT === "1") await run();
