import assert from "node:assert/strict";
import test from "node:test";
import { RunMetrics } from "../src/metrics.ts";

function usage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("tracks TTFT, thinking, tool exclusion, tokens and TPS", () => {
  let now = 1_000;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn(now);
  now = 1_200;
  metrics.handleAssistantEvent({
    type: "thinking_start",
    contentIndex: 0,
    partial: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: now,
    },
  });
  metrics.handleAssistantEvent({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "x",
    partial: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: now,
    },
  });
  now = 1_500;
  metrics.handleAssistantEvent({
    type: "thinking_end",
    contentIndex: 0,
    content: "thinking",
    partial: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: now,
    },
  });
  now = 2_000;
  metrics.pauseForTool();
  now = 7_000;
  metrics.startTurn(now);
  now = 8_000;
  metrics.handleAssistantEvent({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: usage(100, 40),
      stopReason: "stop",
      timestamp: now,
    },
  });
  const snapshot = metrics.finish("done");
  assert.equal(snapshot.ttftMs, 200);
  assert.equal(snapshot.thinkingMs, 300);
  assert.equal(snapshot.inputTokens, 100);
  assert.equal(snapshot.outputTokens, 40);
  assert.equal(snapshot.outputEstimated, false);
  assert.equal(snapshot.turnCount, 2);
  assert.equal(snapshot.elapsedMs, 7_000);
  assert.ok(snapshot.tps && snapshot.tps > 10);
});

test("clears live TPS when a new turn has not produced a measurable interval", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();

  const delta = () => metrics.handleAssistantEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: "字".repeat(100),
    partial: {
      role: "assistant",
      content: [],
      api: "other",
      provider: "test",
      model: "test",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: now,
    },
  } as never);

  delta();
  now = 1_000;
  delta();
  assert.ok((metrics.snapshot().tps ?? 0) > 0);

  metrics.startTurn();
  assert.equal(metrics.snapshot().tps, undefined);
  now = 2_000;
  delta();
  assert.equal(metrics.snapshot().tps, undefined);
});

test("measures live TPS from streamed tool arguments", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();

  const delta = () => metrics.handleAssistantEvent({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: "x".repeat(100),
    partial: {
      role: "assistant",
      content: [],
      api: "other",
      provider: "test",
      model: "test",
      usage: usage(0, 0),
      stopReason: "toolUse",
      timestamp: now,
    },
  } as never);

  delta();
  now = 1_000;
  delta();
  assert.ok((metrics.snapshot().tps ?? 0) > 0);
});

test("estimates output when provider usage is unavailable", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();
  now = 100;
  metrics.handleAssistantEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: "12345678",
    partial: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: now,
    },
  });
  now = 1_100;
  const snapshot = metrics.finish("done");
  assert.equal(snapshot.outputTokens, 3);
  assert.equal(snapshot.outputEstimated, true);
  assert.equal(snapshot.tpsEstimated, true);
});

test("does not turn a buffered provider burst into an extreme live TPS", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();

  const delta = (text: string) => metrics.handleAssistantEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: {
      role: "assistant",
      content: [],
      api: "example-api",
      provider: "example-provider",
      model: "test",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: now,
    },
  } as never);

  delta("字".repeat(100));
  now = 2;
  delta("字".repeat(100));
  now = 4;
  delta("字".repeat(100));
  assert.equal(metrics.snapshot().tps, undefined);

  now = 500;
  delta("字".repeat(50));
  assert.equal(Math.round(metrics.snapshot().tps ?? 0), 500);
});

test("does not sample a provider's terminal total usage as live TPS", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();
  const partial = () => ({
    role: "assistant",
    content: [],
    api: "another-api",
    provider: "another-provider",
    model: "test",
    usage: usage(0, 0),
    stopReason: "stop",
    timestamp: now,
  });
  metrics.handleAssistantEvent({
    type: "text_delta", contentIndex: 0, delta: "字".repeat(100), partial: partial(),
  } as never);
  now = 10;
  metrics.handleAssistantEvent({
    type: "text_delta", contentIndex: 0, delta: "字".repeat(100), partial: partial(),
  } as never);
  now = 20;
  metrics.handleAssistantEvent({
    type: "done", reason: "stop", message: { ...partial(), usage: usage(0, 300) },
  } as never);
  assert.equal(metrics.snapshot().tps, undefined);
  const finished = metrics.finish("done");
  assert.equal(finished.tps, undefined);
  assert.equal(finished.outputTokens, 300);
});

test("observes exact cumulative usage from any provider without sampling reconciliation", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();
  const partial = (output: number) => ({
    role: "assistant", content: [], api: "example-api", provider: "example-provider",
    model: "test", usage: usage(200, output), stopReason: "stop", timestamp: now,
  });
  const delta = (output: number) => metrics.handleAssistantEvent({
    type: "text_delta", contentIndex: 0, delta: "unrelated estimate", partial: partial(output),
  } as never);
  delta(10);
  now = 100;
  delta(20);
  assert.equal(metrics.snapshot().tps, undefined);
  now = 500;
  delta(60);
  assert.equal(metrics.snapshot().tps, 100);
  assert.equal(metrics.snapshot().outputTokens, 60);
  assert.equal(metrics.snapshot().outputEstimated, false);
  now = 501;
  metrics.handleAssistantEvent({ type: "done", reason: "stop", message: partial(1_000) } as never);
  assert.equal(metrics.snapshot().tps, 100, "terminal reconciliation is not a new live interval");
  assert.equal(metrics.snapshot().outputTokens, 1_000);
  const finished = metrics.finish("done");
  assert.equal(finished.outputTokens, 1_000);
  assert.equal(Math.round(finished.tps ?? 0), 1_996, "done keeps the exact whole-run average");
});

test("does not measure a jump from estimated to observed token counts", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();
  const delta = (output: number) => metrics.handleAssistantEvent({
    type: "text_delta", contentIndex: 0, delta: "字".repeat(100),
    partial: { api: "example-api", usage: usage(0, output) },
  } as never);
  delta(0);
  now = 500;
  delta(1_000);
  assert.equal(metrics.snapshot().tps, undefined);
  now = 1_000;
  delta(1_050);
  assert.equal(metrics.snapshot().tps, 100);
  now = 1_001;
  metrics.handleAssistantEvent({
    type: "error", reason: "error", error: { api: "example-api", usage: usage(200, 2_000) },
  } as never);
  assert.equal(metrics.snapshot().tps, 100);
  assert.equal(metrics.finish("failed").outputTokens, 2_000);
});

test("uses exact cumulative streaming usage for Anthropic protocol", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();
  now = 100;
  metrics.handleAssistantEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: "estimated text",
    partial: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: usage(200, 17),
      stopReason: "stop",
      timestamp: now,
    },
  });
  now = 1_100;
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.inputTokens, 200);
  assert.equal(snapshot.outputTokens, 17);
  assert.equal(snapshot.outputEstimated, false);
  assert.equal(snapshot.tpsEstimated, false);
});

test("keeps streamed token usage monotonic when a later event reports zeros", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();
  now = 100;
  metrics.handleAssistantEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: "first",
    partial: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: usage(375, 279),
      stopReason: "stop",
      timestamp: now,
    },
  });
  assert.equal(metrics.snapshot().inputTokens, 375);
  assert.equal(metrics.snapshot().outputTokens, 279);

  now = 200;
  metrics.handleAssistantEvent({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "later event",
    partial: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: now,
    },
  });
  assert.equal(metrics.snapshot().inputTokens, 375);
  assert.equal(metrics.snapshot().outputTokens, 279);
});

test("reconciles exact usage from agent end when streaming done is absent", () => {
  let now = 0;
  const metrics = new RunMetrics({ now: () => now });
  metrics.start();
  metrics.startTurn();
  now = 100;
  metrics.handleAssistantEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: "正在生成一些内容",
    partial: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: usage(800, 0),
      stopReason: "stop",
      timestamp: now,
    },
  });
  metrics.reconcileFinalUsage(usage(800, 50));
  now = 1_100;
  const snapshot = metrics.finish("done");
  assert.equal(snapshot.inputTokens, 800);
  assert.equal(snapshot.outputTokens, 50);
  assert.equal(snapshot.outputEstimated, false);
});

test("reconciles every turn when the provider emits no streaming done event", () => {
  const metrics = new RunMetrics();
  metrics.start();

  metrics.startTurn();
  metrics.reconcileTurnUsage(usage(100, 40));
  metrics.startTurn();
  metrics.reconcileTurnUsage(usage(25, 7));

  const snapshot = metrics.finish("done");
  assert.equal(snapshot.inputTokens, 125);
  assert.equal(snapshot.outputTokens, 47);
  assert.equal(snapshot.outputEstimated, false);
  assert.equal(snapshot.turnCount, 2);
});

test("the finished run reports when it ended, and a running one does not", () => {
	let now = 1_000;
	const metrics = new RunMetrics({ now: () => now });
	metrics.start();
	assert.equal(metrics.snapshot().endedAt, undefined, "还在跑就没有结束时间");

	now = 49_800;
	const finished = metrics.finish("done");
	assert.equal(finished.endedAt, 49_800);
	// Stable across re-reads: the done row is rebuilt on a theme change, and a
	// clock read there would move the reported time.
	now = 120_000;
	assert.equal(metrics.snapshot().endedAt, 49_800);
});

test("the live rate follows a change in speed instead of averaging it away", () => {
	// A cumulative average could not: after five fast seconds it still read
	// 48.9 t/s eight seconds into a 10 t/s stretch.
	let now = 0;
	const metrics = new RunMetrics({ now: () => now });
	metrics.start();
	metrics.startTurn(now);
	const stream = (tokens: number) => {
		now += 1_000;
		metrics.handleAssistantEvent({
			type: "text_delta",
			delta: "字".repeat(tokens),
			partial: { usage: usage(0, 0), api: "other" },
		} as never);
		return metrics.snapshot().tps;
	};

	for (let i = 0; i < 5; i++) stream(100);
	assert.equal(Math.round(metrics.snapshot().tps ?? 0), 100, "稳定期应当就是 100");

	// One window's worth of the new speed is what it takes to converge.
	for (let i = 0; i < 5; i++) stream(10);
	assert.equal(Math.round(metrics.snapshot().tps ?? 0), 10);
});

test("the opening rate is not doubled by tokens with no measured time behind them", () => {
	// The generation clock starts when the first delta arrives, so those tokens
	// were produced before it was running. A cumulative average counted them
	// for free and read 200 t/s on a steady 100 t/s stream.
	let now = 0;
	const metrics = new RunMetrics({ now: () => now });
	metrics.start();
	metrics.startTurn(now);
	for (let i = 0; i < 2; i++) {
		now += 1_000;
		metrics.handleAssistantEvent({
			type: "text_delta",
			delta: "字".repeat(100),
			partial: { usage: usage(0, 0), api: "other" },
		} as never);
	}
	assert.equal(Math.round(metrics.snapshot().tps ?? 0), 100);
});

test("a tool call neither dilutes the rate nor ages the window", () => {
	// The window runs on generation time, so a long tool call is simply not
	// time the model spent generating.
	let now = 0;
	const metrics = new RunMetrics({ now: () => now });
	metrics.start();
	metrics.startTurn(now);
	const delta = () => {
		metrics.handleAssistantEvent({
			type: "text_delta",
			delta: "字".repeat(100),
			partial: { usage: usage(0, 0), api: "other" },
		} as never);
	};
	now += 1_000; delta();
	now += 1_000; delta();
	const before = metrics.snapshot().tps;
	assert.equal(Math.round(before ?? 0), 100);

	metrics.pauseForTool();
	now += 60_000;
	metrics.resumeAfterTool();
	assert.equal(Math.round(metrics.snapshot().tps ?? 0), 100, "工具时间不应算进速率");

	now += 1_000; delta();
	assert.equal(Math.round(metrics.snapshot().tps ?? 0), 100, "恢复后窗口仍然连续");
});

test("a finished run reports the whole-run average, not the last window", () => {
	let now = 0;
	const metrics = new RunMetrics({ now: () => now });
	metrics.start();
	metrics.startTurn(now);
	for (let i = 0; i < 5; i++) {
		now += 1_000;
		metrics.handleAssistantEvent({
			type: "text_delta",
			delta: "字".repeat(100),
			partial: { usage: usage(0, 0), api: "other" },
		} as never);
	}
	// 500 tokens over 4s of generation: the clock starts at the first delta.
	const finished = metrics.finish("done");
	assert.equal(Math.round(finished.tps ?? 0), 125);
});
