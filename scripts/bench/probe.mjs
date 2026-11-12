// 只由隔离基准加载的测试 extension。
import { emit } from "./transport.mjs";
import { performance } from "node:perf_hooks";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export default function (pi) {
  const sample = () =>
    globalThis.__piBench?.sample() ?? {
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    };
  const faux = fauxProvider({
    provider: "bench-faux",
    api: "bench-faux",
    models: [{ id: "bench", contextWindow: 100000000, maxTokens: 8192 }],
    tokensPerSecond: 1000000000,
    tokenSize: { min: 256, max: 256 },
  });
  const reply =
    "## Benchmark output\n\nA deterministic **markdown** response with `code` and a long paragraph.\n\n".repeat(
      Number(process.env.PI_BENCH_REPLY_BLOCKS),
    );
  const response = (context) => {
    const user = context.messages.findLast((m) => m.role === "user");
    const text =
      typeof user?.content === "string"
        ? user.content
        : user?.content
            ?.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
    if (!/^BENCH_ROUND_\d+$/.test(text ?? "")) return fauxAssistantMessage("Benchmark session");
    if (context.messages.at(-1)?.role !== "toolResult") {
      return fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }));
    }
    return fauxAssistantMessage(reply);
  };
  faux.setResponses(Array.from({ length: 12000 }, () => response));
  pi.registerProvider(faux.provider);
  let round = 0,
    started,
    inputAt,
    cpu;
  let ready = false;
  let frozen;
  let offInput;
  const freeze = () => {
    const snapshot = globalThis.__piBench?.stop() ?? { ...sample(), at: performance.now() };
    return round
      ? {
          ...snapshot,
          cycleCpuUs: { user: snapshot.cpu.user - cpu.user, system: snapshot.cpu.system - cpu.system },
          cycleWallMs: snapshot.at - inputAt,
        }
      : snapshot;
  };
  pi.on("session_start", (_event, ctx) => {
    offInput = ctx.ui.onTerminalInput((data) => {
      // 驱动的业务输入只有 BENCH_ROUND_*；就绪后的斜杠只用于采样/退出。
      // 在编辑器收到第一个斜杠之前冻结，兼容 PTY 分片输入。
      if (ready && data.includes("/")) frozen ??= freeze();
    });
    setImmediate(() => emit({ type: "session-started" }));
  });
  pi.on("input", (event) => {
    if (!/^BENCH_ROUND_\d+$/.test(event.text)) return;
    round = Number(event.text.slice(12));
    frozen = undefined;
    globalThis.__piBench?.reset();
    started = inputAt = performance.now();
    cpu = process.cpuUsage();
  });
  const settled = () => {
    if (!started) return;
    emit({
      type: "settled",
      round,
      elapsedMs: performance.now() - started,
      activeCpuUs: process.cpuUsage(cpu),
    });
    started = undefined;
  };
  // 等待整个 settled 分发完成，避免公共回调早于其它插件。
  if (globalThis.__piBench) globalThis.__piBench.onSettled = settled;
  else
    pi.on("agent_settled", () => {
      setImmediate(settled);
    });
  pi.on("tool_execution_end", (event) => {
    if (event.isError) emit({ type: "error", error: `工具 ${event.toolName} 执行失败` });
  });
  pi.on("message_end", (event) => {
    if (event.message?.stopReason === "error" || event.message?.stopReason === "aborted")
      emit({
        type: "error",
        error: event.message.errorMessage ?? event.message.stopReason,
      });
  });
  pi.on("session_shutdown", () => {
    offInput?.();
    emit({ type: "shutdown" });
  });
  pi.registerCommand("bench-ready", {
    handler: (_args, ctx) => {
      // 等编辑器复位后再确认就绪。
      setImmediate(() => {
        ready = true;
        emit({
          type: "ready",
          mode: ctx.mode,
          workload: {
            replyBytes: Buffer.byteLength(reply),
            toolBytes: Number(process.env.PI_BENCH_FIXTURE_BYTES),
          },
          userMessages: ctx.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user")
            .length,
          ...sample(),
          imports: globalThis.__piBench?.imports,
          factories: globalThis.__piBench?.factories,
          hooks: globalThis.__piBench?.hooks,
        });
      });
    },
  });
  pi.registerCommand("bench-sample", {
    handler: () => {
      const snapshot = frozen ?? freeze();
      frozen = undefined;
      setImmediate(() => emit({ type: "sample", round, ...snapshot }));
    },
  });
  pi.registerCommand("bench-quit", {
    handler: (_args, ctx) => {
      emit({ type: "quit-requested" });
      ctx.shutdown();
    },
  });
}
