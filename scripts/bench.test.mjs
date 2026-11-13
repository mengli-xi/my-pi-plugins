import { withThinking, thinkingBody } from "./bench/with-thinking.mjs";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { summarize } from "./bench/stats.mjs";
import { checkEnvironment } from "./pi-checks.mjs";
import { cleanupMeasurement } from "./bench/cleanup.mjs";

const source = (path) => fileURLToPath(new URL(path, import.meta.url));

test("运行中取消 fixture 已输出正文，AbortSignal 立即结束而非等 provider timer", async () => {
  const { activeStream } = await import("./bench/active-stream.mjs");
  const controller = new AbortController();
  const stream = activeStream({ id: "bench", provider: "bench-faux", api: "bench-faux" }, {}, { signal: controller.signal });
  const types = [];
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === "text_delta") {
      assert.match(event.partial.content[0].text, /in progress/);
      controller.abort();
    }
  }
  assert.deepEqual(types, ["start", "text_start", "text_delta", "error"]);
  assert.equal((await stream.result()).stopReason, "aborted");
});

test("Thinking 轨迹保留工具消息与父子关系，每轮只增加一个推理段", () => {
  const entries = [
    { type: "session", id: "fixture" },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "question" } },
    { type: "message", id: "call", parentId: "u", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] } },
    { type: "message", id: "tool", parentId: "call", message: { role: "toolResult", content: [{ type: "text", text: "result" }] } },
    { type: "message", id: "answer", parentId: "tool", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ];
  const result = withThinking(entries.map(e => JSON.stringify(e)).join("\n"));
  const actual = result.jsonl.trim().split("\n").map(JSON.parse);
  assert.deepEqual(actual.slice(0, 4), entries.slice(0, 4));
  assert.deepEqual(actual.map(e => [e.id, e.parentId]), entries.map(e => [e.id, e.parentId]));
  assert.deepEqual(actual[4].message.content, [{ type: "thinking", thinking: thinkingBody }, { type: "text", text: "answer" }]);
  assert.equal(result.users, 1); assert.equal(result.thinkingMessages, 1);
  assert.throws(() => withThinking(result.jsonl), /已经有 Thinking/);
  entries[4].message.content[0].text = "heading\n\nanswer";
  const independent = withThinking(entries.map(e => JSON.stringify(e)).join("\n"), true);
  const answer = JSON.parse(independent.jsonl.trim().split("\n").at(-1)).message.content;
  assert.deepEqual(answer.map(part => part.type), ["text", "thinking", "text"]);
  assert.equal(answer.filter(part => part.type === "text").map(part => part.text).join(""), "heading\n\nanswer");
});

test("统计保留慢样本并使用 nearest-rank p90", () => {
  const values = [10, 2, 4, 6];
  assert.deepEqual(summarize(values), {
    n: 4,
    median: 5,
    p90: 10,
    mean: 5.5,
    variance: 8.75,
    min: 2,
    max: 10,
  });
  assert.deepEqual(values, [10, 2, 4, 6]);
  assert.equal(summarize([]), null);
});

test("定时器钩子保留 handle、receiver、参数与校验", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-timers-"));
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        source("./bench/instrument.mjs"),
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      assert.throws(() => setTimeout(null, 1), TypeError);
      let handle;
      await new Promise(resolve => {
        handle = setTimeout(function(value) { assert.equal(this, handle); assert.equal(value, 42); resolve(); }, 1, 42);
        assert.equal(handle.ref(), handle);
        assert.equal(typeof handle.unref, 'function');
      });
      let fired = false;
      const interval = setInterval(() => { fired = true; }, 1); clearInterval(interval);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(fired, false);
      assert.ok(globalThis.__piBench.sample().timers.some(t => t.calls > 0));
    `,
      ],
      {
        env: checkEnvironment(root, {
          PI_BENCH_TIMERS: "1",
          PI_BENCH_METRICS: join(root, "metrics.jsonl"),
        }),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handler 同步段不计入排队任务的墙钟", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-timing-"));
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        source("./bench/instrument.mjs"),
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      await globalThis.__piBench.timed('context', 'owner', () => {
        queueMicrotask(() => { const end = performance.now() + 30; while (performance.now() < end) {} });
      });
      const timing = globalThis.__piBench.sample().handlers['owner:context'];
      assert.ok(timing.ms - timing.syncMs >= 20, JSON.stringify(timing));
    `,
      ],
      {
        env: checkEnvironment(root, {
          PI_BENCH_METRICS: join(root, "metrics.jsonl"),
        }),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("诊断将 await 文件操作和期间的绘制归到正确 handler", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-await-"));
  try {
    const path = join(root, "fixture");
    writeFileSync(path, "fixture");
    execFileSync(process.execPath, ["--import", source("./bench/instrument.mjs"), "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { readFile, stat } from 'node:fs/promises';
      const bench = globalThis.__piBench;
      await bench.timed('session_start', 'fixture', async () => {
        assert.equal(await readFile(${JSON.stringify(path)}, 'utf8'), 'fixture');
        bench.frame(3, 4);
        await stat(${JSON.stringify(path)});
      });
      const sample = bench.sample();
      assert.equal(sample.handlers['fixture:session_start'].renderMs, 3);
      assert.equal(sample.handlers['fixture:session_start'].calls, 1);
      assert.deepEqual(sample.io.map(row => [row.owner, row.name]),
        [['fixture:session_start', 'readFile'], ['fixture:session_start', 'stat']]);
      assert.equal(sample.spans[0].renderMs, 3);
    `], { env: checkEnvironment(root, { PI_BENCH_DETAIL: "1", PI_BENCH_METRICS: join(root, "metrics.jsonl") }) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("settled 边界等待全部异步 handler", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-settled-"));
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        source("./bench/instrument.mjs"),
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      const { ExtensionRunner } = await import(${JSON.stringify(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js", import.meta.url).href)});
      const sequence = [], runner = Object.create(ExtensionRunner.prototype);
      runner.createContext = () => ({});
      runner.extensions = [{ handlers: new Map([['agent_settled', [async () => {
        await new Promise(resolve => setTimeout(resolve, 20)); sequence.push('handler-done');
      }]]]) }];
      globalThis.__piBench.onSettled = () => sequence.push('acknowledged');
      await runner.emit({ type: 'agent_settled' });
      assert.deepEqual(sequence, ['handler-done', 'acknowledged']);
    `,
      ],
      {
        env: checkEnvironment(root, {
          PI_BENCH_METRICS: join(root, "metrics.jsonl"),
        }),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话切换计时等待新 runtime 和异步 UI rebind，不以 session_start 提前结束", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-switch-"));
  try {
    execFileSync(process.execPath, ["--import", source("./bench/instrument.mjs"), "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const { AgentSessionRuntime } = await import(${JSON.stringify(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js", import.meta.url).href)});
      const sequence = [];
      const old = { sessionFile: undefined, sessionManager: { getSessionDir() { return undefined; }, isPersisted() { return false; } },
        abort: async () => {}, extensionRunner: { hasHandlers(event) { return event === 'session_shutdown'; }, emit: async () => { sequence.push('shutdown'); } },
        dispose() { sequence.push('disposed'); } };
      const next = {};
      const runtime = new AgentSessionRuntime(old, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR }, async () => {
        await globalThis.__piBench.timed('factory', 'fixture', () => {});
        return { session: next, services: {} };
      });
      runtime.setRebindSession(async session => {
        assert.equal(session, next);
        sequence.push('session_start');
        await new Promise(resolve => setTimeout(resolve, 20));
        sequence.push('editable');
      });
      await runtime.newSession();
      assert.deepEqual(sequence, ['shutdown', 'disposed', 'session_start', 'editable']);
      const event = readFileSync(process.env.PI_BENCH_METRICS, 'utf8').trim().split('\\n').map(JSON.parse).at(-1);
      assert.equal(event.type, 'switch-complete');
      assert.equal(event.method, 'newSession');
      assert.ok(event.handlers['host:finishSessionReplacement'].ms >= 15);
      assert.equal(event.factories.length, 1);
    `], { env: checkEnvironment(root, { PI_BENCH_METRICS: join(root, "metrics.jsonl") }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("指标 socket 与原始 JSONL 内容一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-stream-")),
    lines = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n")) >= 0; ) {
        lines.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  try {
    await new Promise((resolve) => server.listen(join(root, "stream.sock"), resolve));
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { emit } from ${JSON.stringify(new URL("./bench/transport.mjs", import.meta.url).href)};
      emit({ type: 'first', text: '中文\\u2028line' }); emit({ type: 'second' });
      await new Promise(resolve => setTimeout(resolve, 50));
    `,
      ],
      {
        env: checkEnvironment(root, {
          PI_BENCH_SOCKET: join(root, "stream.sock"),
          PI_BENCH_METRICS: join(root, "raw.jsonl"),
        }),
      },
    );
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => (code ? reject(new Error(`子进程退出 ${code}`)) : resolve()));
    });
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(lines, readFileSync(join(root, "raw.jsonl"), "utf8").trimEnd().split("\n"));
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).type),
      ["first", "second"],
    );
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("分析器区分冷启动与恢复，计算 CPU/帧并正确归属包路径", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-analysis-"));
  const sample = {
    at: 3,
    userMessages: 0,
    memory: { rss: 2 ** 20, heapUsed: 2 ** 19 },
    cpu: { user: 1000, system: 1000 },
  };
  try {
    mkdirSync(join(root, "run"));
    writeFileSync(
      join(root, "results.json"),
      JSON.stringify({
        repositoryRoot: "/usr/local/checkout",
        machine: {},
        failures: [],
        runs: [
          {
            configuration: "all",
            readyMs: 10,
            ready: sample,
            rounds: [],
            idle: [],
          },
          {
            configuration: "all",
            readyMs: 20,
            ready: { ...sample, userMessages: 200 },
            resumesFrom: "session-200.jsonl",
            rounds: [],
            idle: [],
          },
          {
            configuration: "all",
            id: "run",
            readyMs: 10,
            ready: sample,
            idle: [],
            rounds: [
              {
                round: 1,
                at: 23,
                cpu: { user: 2000, system: 4000 },
                elapsedMs: 10,
                memory: sample.memory,
                activeCpuUs: { user: 1000, system: 2000 },
                renderMs: 2,
                frames: [{ ms: 2, latency: 5 }],
                handlers: {
                  "/usr/local/checkout/local/pi-todo/index.ts:input": { ms: 1 },
                  "/usr/local/lib/node_modules/x.js:context": { ms: 3 },
                  "/usr/local/checkout/local/pi-goal/node_modules/local/foo.js:context": { ms: 4 },
                  "/usr/local/checkout/fork/pi-goal/index.ts:context": {
                    ms: 2,
                  },
                },
              },
            ],
          },
          {
            configuration: "all",
            readyMs: 10,
            ready: {
              ...sample,
              timers: [
                {
                  name: "setTimeout",
                  delay: 999.8,
                  stack: "clock",
                  calls: 1,
                  ms: 0.2,
                },
              ],
            },
            rounds: [],
            idle: [
              { ...sample, at: 1003, cpu: { user: 2000, system: 2000 } },
              {
                ...sample,
                at: 2003,
                cpu: { user: 3000, system: 3000 },
                timers: [
                  {
                    name: "setTimeout",
                    delay: 999.8,
                    stack: "clock",
                    calls: 2,
                    ms: 2,
                  },
                  {
                    name: "setTimeout",
                    delay: 999.9,
                    stack: "clock",
                    calls: 3,
                    ms: 3,
                  },
                ],
              },
            ],
          },
          {
            configuration: "all",
            readyMs: 99,
            ready: sample,
            resumesFrom: "switch-target.jsonl",
            rounds: [],
            idle: [],
            switches: [{ command: "resume", elapsedMs: 30, chooserMs: 4,
              replacement: { elapsedMs: 25, renderMs: 7 } }],
          },
          {
            configuration: "modern",
            readyMs: 10,
            ready: sample,
            idle: [],
            rounds: [
              {
                round: 1,
                at: 23,
                cpu: { user: 2000, system: 4000 },
                cycleCpuUs: { user: 500, system: 500 },
                cycleWallMs: 4,
                elapsedMs: 10,
                activeCpuUs: { user: 1000, system: 2000 },
                memory: sample.memory,
              },
            ],
          },
        ],
      }),
    );
    const frame = {
      functionName: "hot",
      url: "file:///hot.js",
      lineNumber: 1,
      columnNumber: 2,
    };
    writeFileSync(
      join(root, "run", "test.cpuprofile"),
      JSON.stringify({
        startTime: 0,
        endTime: 5000,
        nodes: [
          { id: 1, callFrame: frame },
          { id: 2, callFrame: frame },
        ],
        samples: [1, 2],
        timeDeltas: [3000, 2000],
      }),
    );
    writeFileSync(
      join(root, "run", "test.heapprofile"),
      JSON.stringify({
        head: {
          callFrame: frame,
          selfSize: 1000,
          children: [{ callFrame: frame, selfSize: 2000, children: [] }],
        },
      }),
    );
    execFileSync(process.execPath, [source("./bench/analyze.mjs"), root]);
    const result = JSON.parse(readFileSync(join(root, "summary.json"), "utf8")),
      group = result.groups.all;
    assert.equal(result.profiles.find((p) => p.kind.includes("CPU")).top[0].ms, 2);
    assert.equal(result.profiles.find((p) => p.kind.includes("CPU")).wholeProcessTop[0].ms, 5);
    assert.equal(result.profiles.find((p) => p.kind.includes("allocation")).top[0].bytes, 3000);
    assert.equal(group.coldMs.n, 1);
    assert.equal(group.resume[0].users, 200);
    assert.equal(group.resume.length, 1, "会话内切换不是冷启动 resume");
    assert.equal(group.switches.resume.readyMs.median, 30);
    assert.equal(group.switches.resume.chooserMs.median, 4);
    assert.equal(group.switches.resume.renderMs.median, 7);
    assert.equal(group.long[0].windows[0].cpuPercentOneCore, 30);
    assert.equal(group.long[0].windows[0].cycleCpuPercentOneCore, 20);
    assert.equal(result.groups.modern.long[0].windows[0].cycleCpuMsPerRound, 1);
    assert.equal(result.groups.modern.long[0].windows[0].cycleCpuPercentOneCore, 25);
    assert.equal(group.long[0].windows[0].frameLatencyMs.median, 5);
    assert.equal(group.long[0].windows[0].handlersMsPerRound["pi-todo"], 1);
    assert.equal(group.long[0].windows[0].handlersMsPerRound["pi-goal"], 6);
    assert.equal(group.long[0].windows[0].handlersMsPerRound["host/probe"], 3);
    assert.equal(group.long[0].windows[0].handlersMsPerRound.lib, undefined);
    assert.equal(group.long[0].windows[0].handlersMsPerRound["foo.js"], undefined);
    assert.equal(group.long[0].windows[0].handlersMsPerRound.checkout, undefined);
    assert.equal(group.long[0].windows[0].handlersSyncMsPerRound, null);
    assert.equal(group.idle[0].cpuPercentOneCore, 0.2);
    assert.equal(group.idle[0].steady.cpuPercentOneCore, 0.2);
    assert.equal(group.idle[0].timers.length, 1);
    assert.equal(group.idle[0].timers[0].delay, 1000);
    assert.equal(group.idle[0].timers[0].calls, 4);
    assert.equal(group.idle[0].timers[0].ms, 4.8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("实际导入 loader 与 TUI 时验证全部源码钩子", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-hooks-"));
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        source("./bench/instrument.mjs"),
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      await import(${JSON.stringify(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url).href)});
      await import(${JSON.stringify(new URL("../node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js", import.meta.url).href)});
      await import(${JSON.stringify(new URL("../node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js", import.meta.url).href)});
      for (const hook of ['import', 'factory', 'handler', 'loadErrors', 'requestRender', 'TuiMainScreen']) {
        assert.ok(globalThis.__piBench.hooks.includes(hook), '缺少钩子：' + hook);
      }
    `,
      ],
      {
        env: checkEnvironment(root, {
          PI_BENCH_METRICS: join(root, "metrics.jsonl"),
        }),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("采样命令冻结统计及时间戳，后续绘制与 handler 不污染该轮", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-sample-"));
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        source("./bench/instrument.mjs"),
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const { default: install } = await import(${JSON.stringify(new URL("./bench/probe.mjs", import.meta.url).href)});
      const commands = new Map(), handlers = new Map();
      install({ registerProvider() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, fn) { handlers.set(name, fn); } });
      const bench = globalThis.__piBench;
      let terminalInput;
      handlers.get('session_start')({}, { ui: { onTerminalInput(fn) { terminalInput = fn; return () => {}; } } });
      commands.get('bench-ready').handler('', { mode: 'tui', sessionManager: { getEntries() { return []; } } });
      await new Promise(resolve => setImmediate(resolve));
      handlers.get('input')({ text: 'BENCH_ROUND_1' });
      bench.frame(2, 5);
      terminalInput('/');
      bench.frame(11, 13);
      commands.get('bench-sample').handler();
      await bench.timed('context', '采样后', () => {});
      bench.frame(7, 9);
      const end = performance.now() + 30;
      while (performance.now() < end) {}
      await new Promise(resolve => setImmediate(resolve));
      const row = readFileSync(process.env.PI_BENCH_METRICS, 'utf8').trim().split('\\n').map(JSON.parse).find(row => row.type === 'sample');
      assert.deepEqual(row.frames, [{ ms: 2, latency: 5 }]);
      assert.equal(row.handlers['采样后:context'], undefined);
      assert.ok(performance.now() - row.at >= 30, '应保留冻结时刻而非发送时刻');
      assert.ok(row.cycleWallMs >= 0);
      handlers.get('input')({ text: 'BENCH_ROUND_2' });
      bench.frame(3, 4);
      assert.equal(bench.sample().renderMs, 3);
    `,
      ],
      {
        env: checkEnvironment(root, {
          PI_BENCH_METRICS: join(root, "metrics.jsonl"),
          PI_BENCH_REPLY_BLOCKS: "24",
        }),
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("交互计时从确认键或中断键起算，排除选择器和流开始前的绘制", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-arm-"));
  try {
    execFileSync(process.execPath, ["--import", source("./bench/instrument.mjs"), "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const { default: install } = await import(${JSON.stringify(new URL("./bench/probe.mjs", import.meta.url).href)});
      const commands = new Map(), handlers = new Map();
      install({ registerProvider() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, fn) { handlers.set(name, fn); } });
      let input;
      handlers.get('session_start')({}, { ui: { onTerminalInput(fn) { input = fn; return () => {}; } } });
      const bench = globalThis.__piBench;
      commands.get('bench-arm').handler('2');
      bench.frame(90, 90);
      input('/rewind\\r');
      assert.equal(bench.sample().renderMs, 90);
      input('BENCH_ROUND_200'); input('\\r');
      assert.equal(bench.sample().renderMs, 0);
      bench.frame(3, 3);
      assert.equal(bench.sample().renderMs, 3);
      handlers.get('input')({ text: 'BENCH_ABORT' });
      bench.frame(50, 50); input('\\x1b');
      assert.equal(bench.sample().renderMs, 0);
    `], { env: checkEnvironment(root, { PI_BENCH_METRICS: join(root, "metrics.jsonl"), PI_BENCH_REPLY_BLOCKS: "24" }) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("稳态帧采样逐次等待公开 UI 更新的实际绘制，并记录 RSS", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-frames-"));
  try {
    execFileSync(process.execPath, ["--import", source("./bench/instrument.mjs"), "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const { default: install } = await import(${JSON.stringify(new URL("./bench/probe.mjs", import.meta.url).href)});
      const commands = new Map();
      install({ registerProvider() {}, registerCommand(k,v) { commands.set(k,v); }, on() {} });
      const bench = globalThis.__piBench; let requested = 0;
      await commands.get('bench-frames').handler('5', { ui: { setStatus(k,value) {
        if(value !== undefined) { requested++; queueMicrotask(() => bench.frame(2, 3, performance.now())); }
      } } });
      assert.equal(requested, 5); assert.equal(bench.onFrame, undefined);
      const event = fs.readFileSync(process.env.PI_BENCH_METRICS,'utf8').trim().split('\\n').map(JSON.parse).find(e=>e.type==='frames-sampled');
      assert.equal(event.steadyFrames.length, 5);
      assert.ok(event.steadyFrames.every(f=>f.ms===2 && f.rss>0));
    `], { env: checkEnvironment(root, { PI_BENCH_METRICS: join(root, "metrics.jsonl"), PI_BENCH_REPLY_BLOCKS: "24" }) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("清理遇到 EPERM、PTY 或日志错误仍删除目录并保留原始异常", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-cleanup-"));
  const messages = [];
  t.mock.method(childProcess, "spawnSync", (command) =>
    command === "ps" ? { status: 0, stdout: `node ${root}/owned.js` } : { status: 1, stdout: "" },
  );
  const kill = t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("无权限"), { code: "EPERM" });
  });
  t.mock.method(console, "error", (text) => messages.push(text));
  const original = new Error("测量原始错误");
  try {
    assert.throws(
      () => {
        try {
          throw original;
        } finally {
          cleanupMeasurement({
            root,
            artifacts: join(root, "不存在"),
            pids: [999999],
            server: {
              close() {
                throw new Error("socket 错误");
              },
            },
            child: {
              exitCode: 0,
              terminal: {
                close() {
                  throw new Error("PTY 错误");
                },
              },
            },
          });
        }
      },
      (error) => error === original,
    );
    assert.throws(() => readFileSync(root), { code: "ENOENT" });
    assert.ok(messages.some((text) => text.includes("PTY")));
    assert.equal(kill.mock.callCount(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("清理前核对快照 PID，跳过已复用或无法核对的进程", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-pid-"));
  const commands = new Map([
    ["101", { status: 0, stdout: "node /other/profile/daemon.js" }],
    ["102", { status: 0, stdout: `node ${root}/owned.js` }],
    ["103", { status: 1, stdout: "" }],
  ]);
  const ps = t.mock.method(childProcess, "spawnSync", (command, args) => {
    if (command !== "ps") return { status: 1, stdout: "" };
    assert.deepEqual(args.slice(2), ["-o", "command="]);
    return commands.get(args[1]);
  });
  const kill = t.mock.method(process, "kill", () => true);
  t.mock.method(console, "error", () => {});
  try {
    cleanupMeasurement({ root, artifacts: root, pids: [101, 102, 103] });
    assert.deepEqual(
      kill.mock.calls.map((call) => call.arguments),
      [[102, "SIGKILL"]],
    );
    assert.equal(ps.mock.calls.filter((call) => call.arguments[0] === "ps").length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all 编排把 SIGTERM 转发给当前阶段", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bench-signal-"));
  const flag = join(root, "terminated");
  const script = `#!${process.execPath}\nprocess.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(flag)}, 'yes'); process.exit(143); });\nconsole.log('stage-ready');\nsetInterval(() => {}, 1000);\n`;
  writeFileSync(join(root, "perl"), script, { mode: 0o755 });
  const child = spawn("bun", [source("./bench/run.mjs"), "--suite", "all", "--output", join(root, "output")], {
    env: checkEnvironment(root, { PATH: `${root}:${process.env.PATH}` }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (bytes) => {
        output += bytes;
        if (output.includes("stage-ready")) resolve();
      });
      child.once("exit", () => reject(new Error("阶段就绪前退出")));
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    assert.equal(await exited, 143);
    assert.equal(readFileSync(flag, "utf8"), "yes");
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
