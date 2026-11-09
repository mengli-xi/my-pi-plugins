import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  StreamingTypewriter,
  type TypewriterClock,
  type TypewriterObservability,
} from "../src/streaming-typewriter.ts";
import type { AssistantTypewriterConfig } from "../src/types.ts";

const config: AssistantTypewriterConfig = {
  enabled: true,
  adaptive: true,
  frameMs: 50,
  renderBudgetMs: 8,
  maxFrameMs: 200,
  minCharsPerFrame: 3,
  maxCharsPerFrame: 10,
  targetLagMs: 100,
  finalDrainMs: 100,
};

function message(text: string, extra: unknown[] = []): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }, ...extra],
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  } as AssistantMessage;
}

function visibleText(value: AssistantMessage): string {
  const block = value.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : "";
}

class FakeClock implements TypewriterClock {
  current = 0;
  private nextId = 1;
  private timers = new Map<number, { due: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { due: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    const end = this.current + ms;
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.current = next[1].due;
      next[1].callback();
    }
    this.current = end;
  }
}

class Metrics implements TypewriterObservability {
  observations: Array<[string, number, string]> = [];
  gauges = new Map<string, number>();
  counters = new Map<string, number>();

  record(): void {}
  observe(name: string, value: number, unit: string): void {
    this.observations.push([name, value, unit]);
  }
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }
  increment(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }
}

test("coalesces snapshots and advances Markdown on the frame budget", () => {
  const clock = new FakeClock();
  const metrics = new Metrics();
  const typewriter = new StreamingTypewriter(config, metrics, clock);
  const key = {};
  const frames: string[] = [];
  const present = (value: AssistantMessage) => frames.push(visibleText(value));

  typewriter.update(key, message("abcdefghij"), true, present);
  typewriter.update(key, message("abcdefghijklmnopqrst"), true, present);

  assert.deepEqual(frames, ["abc"]);
  assert.equal(metrics.counters.get("cc-style.typewriter.coalesced-updates"), 1);
  assert.equal(metrics.gauges.get("cc-style.typewriter.backlog-current"), 17);

  clock.advance(50);
  assert.equal(frames.at(-1), "abcdefghijkl");
  assert.ok(
    metrics.observations.some(([name, value, unit]) =>
      name === "cc-style.typewriter.batch" && value === 9 && unit === "chars"
    ),
  );
});

test("message_end drains its tail across frames and finishes as non-streaming", () => {
  const clock = new FakeClock();
  const typewriter = new StreamingTypewriter(config, undefined, clock);
  const key = {};
  const frames: Array<{ text: string; streaming: boolean }> = [];
  const present = (value: AssistantMessage, streaming: boolean) => {
    frames.push({ text: visibleText(value), streaming });
  };

  const final = message("abcdefghijklmnop");
  typewriter.update(key, final, true, present);
  typewriter.update(key, final, false, present);

  assert.deepEqual(frames.map(({ text }) => text), ["abc"]);
  clock.advance(50);
  assert.equal(frames.at(-1)?.text, "abcdefghij");
  assert.equal(frames.at(-1)?.streaming, false);
  clock.advance(50);
  assert.equal(frames.at(-1)?.text, "abcdefghijklmnop");
  assert.equal(frames.at(-1)?.streaming, false);
});

test("a trailing tool call bypasses the visual queue", () => {
  const clock = new FakeClock();
  const typewriter = new StreamingTypewriter(config, undefined, clock);
  const key = {};
  const frames: string[] = [];
  const present = (value: AssistantMessage) => frames.push(visibleText(value));

  typewriter.update(key, message("abcdefghij"), true, present);
  typewriter.update(
    key,
    message("abcdefghij", [{ type: "toolCall", id: "t", name: "read", arguments: {} }]),
    true,
    present,
  );

  assert.deepEqual(frames, ["abc", "abcdefghij"]);
  clock.advance(500);
  assert.deepEqual(frames, ["abc", "abcdefghij"]);
});

test("an error ending bypasses the tail drain so its status is immediate", () => {
  const clock = new FakeClock();
  const typewriter = new StreamingTypewriter(config, undefined, clock);
  const key = {};
  const frames: Array<{ text: string; streaming: boolean }> = [];
  const present = (value: AssistantMessage, streaming: boolean) => {
    frames.push({ text: visibleText(value), streaming });
  };

  typewriter.update(key, message("abcdefghij"), true, present);
  const failed = { ...message("abcdefghij"), stopReason: "error" } as AssistantMessage;
  typewriter.update(key, failed, false, present);

  assert.deepEqual(frames, [
    { text: "abc", streaming: true },
    { text: "abcdefghij", streaming: false },
  ]);
  clock.advance(500);
  assert.equal(frames.length, 2);
});

test("never slices an emoji between its surrogate halves", () => {
  const clock = new FakeClock();
  const typewriter = new StreamingTypewriter(
    { ...config, minCharsPerFrame: 2 },
    undefined,
    clock,
  );
  const frames: string[] = [];
  typewriter.update({}, message("a😀b"), true, (value) => frames.push(visibleText(value)));
  assert.deepEqual(frames, ["a😀"]);
});

test("dispose flushes pending content and releases the active stream", () => {
  const clock = new FakeClock();
  const metrics = new Metrics();
  const typewriter = new StreamingTypewriter(config, metrics, clock);
  const frames: string[] = [];
  typewriter.update({}, message("abcdefghij"), true, (value) => frames.push(visibleText(value)));

  typewriter.dispose();

  assert.equal(frames.at(-1), "abcdefghij");
  assert.equal(metrics.gauges.get("cc-style.typewriter.active-streams"), 0);
  clock.advance(500);
  assert.equal(frames.length, 2);
});

test("paint pressure spaces Markdown rebuilds and increases the catch-up batch", () => {
  const clock = new FakeClock();
  const metrics = new Metrics();
  const frames: string[] = [];
  const typewriter = new StreamingTypewriter(
    config,
    metrics,
    clock,
    () => ({ renderMs: 20, eventLoopDelayMs: 0 }),
  );

  typewriter.update({}, message("abcdefghijklmnopqrst"), true, (value) => {
    frames.push(visibleText(value));
  });
  assert.deepEqual(frames, ["abc"]);
  clock.advance(50);
  assert.equal(frames.length, 1, "the base 50ms cadence is throttled under paint pressure");
  clock.advance(75);
  assert.equal(frames.at(-1), "abcdefghijklm");
  assert.ok((metrics.counters.get("cc-style.typewriter.adaptive-throttles") ?? 0) > 0);
  assert.ok(metrics.observations.some(([name, value]) =>
    name === "cc-style.typewriter.frame-delay" && value === 125
  ));
});
