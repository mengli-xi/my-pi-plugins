import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionDeadline, TOTAL_DEADLINE_REASON, type DeadlineClock } from "../src/deadline.ts";
import { DEFAULT_CONFIG, readConfig } from "../src/config.ts";
import { generate, type Attempt } from "../src/generate.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { withRequestRetries } from "../src/retry.ts";
import { describeCompaction } from "../src/show.ts";
class Clock implements DeadlineClock {
  time = 0; sequence = 0; tasks = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, ms: number) { const id = ++this.sequence; this.tasks.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(timer: unknown) { this.tasks.delete(timer as number); }
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) { const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > target) break; this.time = next[1].at; this.tasks.delete(next[0]); next[1].callback(); }
    this.time = target;
  }
}
function fixture(ms = 100, clock = new Clock(), startedAt = clock.now(), queuePauseCapMinutes?: number) {
  const handlers = new Set<(event: unknown) => void>();
  const deadline = new CompactionDeadline({ sessionId: "ours", minutes: ms / 60000, queuePauseCapMinutes, clock, startedAt, subscribe: handle => { handlers.add(handle); return () => { handlers.delete(handle); }; } });
  const emit = (payload: unknown) => { for (const handle of handlers) handle(payload); };
  const queue = (type: string, fields: Record<string, unknown> = {}, sessionId = "ours", provider = "fake") => emit({ version: 1, provider, sessionId, kind: "lifecycle", event: { channel: "lifecycle", source: "upstream", type, ...fields } });
  return { deadline, clock, queue, emit, handlers };
}

test("total starts at operation entry, absent events count, and zero disables only the total", () => {
  const clock = new Clock(); clock.advance(30); const f = fixture(100, clock, 0);
  assert.equal(f.deadline.remainingMs(), 70); clock.advance(70); assert.equal(f.deadline.signal.aborted, true); assert.match(String(f.deadline.signal.reason), new RegExp(TOTAL_DEADLINE_REASON)); assert.equal(f.handlers.size, 0);
  const unlimited = fixture(0); let single = false; const attempt = unlimited.deadline.attempt("other", 30, () => single = true);
  unlimited.clock.advance(10000); assert.ok(single); assert.equal(unlimited.deadline.signal.aborted, false); attempt.stop(); unlimited.deadline.finish(); assert.equal(unlimited.handlers.size, 0);
});

test("queue pauses both clocks and each resumes with only its remaining budget", () => {
  const f = fixture(); let single = false; const a = f.deadline.attempt("fake", 50, () => single = true);
  f.clock.advance(10); f.queue("queue.enter"); f.clock.advance(80); assert.equal(single, false); assert.equal(f.deadline.signal.aborted, false);
  f.queue("queue.leave", { queuedMs: 80 }); assert.equal(f.deadline.snapshot().queuePausedMs, 80);
  f.clock.advance(39); assert.equal(single, false); f.clock.advance(1); assert.ok(single); a.stop();
  f.clock.advance(50); assert.ok(f.deadline.signal.aborted); assert.equal(f.deadline.snapshot().activeElapsedMs, 100);
});

test("upstream queuedMs overrides observed time, including shorter corrections", () => {
  const f = fixture(200); const a = f.deadline.attempt("fake", 500, () => {});
  f.clock.advance(10); f.queue("queue.enter"); f.clock.advance(80); f.queue("queue.update", { queuedMs: 40 });
  assert.equal(f.deadline.snapshot().queuePausedMs, 40); assert.equal(f.deadline.snapshot().activeElapsedMs, 50);
  f.clock.advance(10); f.queue("queue.leave", { queuedMs: 30 }); assert.equal(f.deadline.snapshot().queuePausedMs, 30); assert.equal(f.deadline.snapshot().activeElapsedMs, 70);
  a.stop(); f.deadline.finish();
});

test("concurrent source/attempt queues are unioned; unrelated provider clocks keep running", () => {
  const f = fixture(1000); const a = f.deadline.attempt("fake", 1000, () => {}), b = f.deadline.attempt("fake", 1000, () => {}); let otherExpired = false;
  const other = f.deadline.attempt("other", 30, () => otherExpired = true);
  f.clock.advance(10); f.queue("queue.enter"); f.clock.advance(10); f.queue("queue.enter", { source: "local", attempt: 1 });
  f.clock.advance(20); f.queue("queue.leave", { queuedMs: 30 }); f.clock.advance(20); f.queue("queue.leave", { source: "local", attempt: 1, queuedMs: 40 });
  assert.ok(otherExpired); assert.equal(f.deadline.snapshot().queuePausedMs, 50); assert.equal(a.snapshot().queueMs, 50); assert.equal(b.snapshot().queueMs, 50);
  a.stop(); b.stop(); other.stop(); f.deadline.finish();
});

test("wrong-session and malformed events, idle periods, and late queue events cannot pause", () => {
  const f = fixture(); f.queue("queue.enter"); const a = f.deadline.attempt("fake", 1000, () => {});
  f.queue("queue.enter", {}, "other"); f.queue("queue.enter", { queuedMs: -1 }); f.queue("queue.enter", { source: "unknown" });
  f.clock.advance(20); f.queue("queue.enter"); f.clock.advance(10); a.stop();
  f.queue("queue.leave", { queuedMs: 1000 }); f.clock.advance(80);
  assert.ok(f.deadline.signal.aborted); assert.equal(f.deadline.snapshot().queuePausedMs, 10);
});

test("provider windows isolate queue pauses, first progress, late corrections and retry cleanup", () => {
  const f = fixture(1000), a = f.deadline.attempt("fake", 1000, () => {}), b = f.deadline.attempt("second", 1000, () => {});
  f.queue("queue.enter"); f.clock.advance(10);
  f.queue("queue.enter", {}, "ours", "second"); f.clock.advance(10); a.progress();
  f.clock.advance(10);
  f.queue("queue.leave", { queuedMs: 5 });
  assert.equal(a.snapshot().queueMs, 5);
  assert.equal(b.snapshot().queueMs, 20, "another provider's progress cannot end this queue");
  assert.equal(f.deadline.snapshot().queuePausedMs, 20, "overlapping providers spend the union, not the sum");
  a.stop();
  f.queue("queue.update", { queuedMs: 1000 });
  assert.equal(f.deadline.snapshot().queuePausedMs, 20, "idle provider cannot revise an earlier window");
  const retry = f.deadline.attempt("fake", 1000, () => {});
  f.clock.advance(10); f.queue("queue.leave", { queuedMs: 1000 });
  assert.equal(retry.snapshot().queueMs, 10, "authoritative values cannot precede the retry window");
  f.queue("queue.leave", {}, "ours", "second");
  assert.equal(b.snapshot().queueMs, 30);
  assert.equal(a.snapshot().queueMs, 5, "stopped attempt keeps its first-progress cutoff");
  retry.stop(); b.stop(); f.deadline.finish();
});

test("unknown and malformed activity payloads cannot pause or correct clocks", () => {
  const f = fixture(), a = f.deadline.attempt("fake", 1000, () => {});
  const valid = { version: 1, provider: "fake", sessionId: "ours", kind: "lifecycle", event: { channel: "lifecycle", type: "queue.enter", source: "local" } };
  for (const payload of [undefined, null, [], "queue.enter", 1, {},
    { ...valid, version: 2 }, { ...valid, provider: "inactive" }, { ...valid, sessionId: "elsewhere" },
    { ...valid, kind: "unknown" }, { ...valid, kind: "turn.end" },
    ...[{ type: "attempt.start" }, { type: "load.update" }, { type: "unknown" }, { channel: "unknown" }, { source: undefined }, { source: "unknown" },
      { queuedMs: -1 }, { queuedMs: Infinity }, { queuedMs: "10" }, { attempt: 0.5 }, { queueEnteredAt: NaN }, { load: { active: 0 } }]
      .map(event => ({ ...valid, event: { ...valid.event, ...event } })),
  ]) f.emit(payload);
  f.clock.advance(30);
  assert.equal(f.deadline.snapshot().queuePausedMs, 0);
  assert.equal(a.snapshot().activeElapsedMs, 30);
  f.queue("queue.enter", { source: "local" }); f.clock.advance(10); a.progress();
  f.emit({ ...valid, event: { ...valid.event, type: "queue.leave", queuedMs: "100" } });
  assert.equal(f.deadline.snapshot().queuePausedMs, 10);
  a.stop(); f.deadline.finish();
});

test("configuration accepts default ten, fractions and zero; rejects invalid values", async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-total-config-")); mkdirSync(join(root, "pi-session-compact"));
  try {
    assert.equal((await readConfig(root)).totalTimeoutMinutes, 10);
    for (const totalTimeoutMinutes of [0, 0.25, 10]) { writeFileSync(join(root, "pi-session-compact/config.json"), JSON.stringify({ totalTimeoutMinutes })); assert.equal((await readConfig(root)).totalTimeoutMinutes, totalTimeoutMinutes); }
    for (const totalTimeoutMinutes of [-1, "10", null, true]) { writeFileSync(join(root, "pi-session-compact/config.json"), JSON.stringify({ totalTimeoutMinutes })); await assert.rejects(readConfig(root), /Invalid totalTimeoutMinutes/); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generation uses the shorter single/remaining total limit and total expiry is terminal", async () => {
  for (const shortSingle of [false, true]) {
    const f = fixture(100), attempts: Attempt[] = []; let sent = false;
    const config = shortSingle ? { ...DEFAULT_CONFIG, throughput: { "fake/test/off": { version: "test", measuredAt: new Date().toISOString(), inputTokensPerSecond: 1e12, outputTokensPerSecond: 1e12, safetyFactor: 1, cache: "cold" as const, concurrency: "single" as const } } } : DEFAULT_CONFIG;
    const ctx: any = { sessionManager: { getSessionId: () => "ours" }, ui: { notify() {} }, modelRegistry: { streamSimple(_m: unknown, _c: unknown, options: any) { sent = true; const stream = createAssistantMessageEventStream(); options.signal.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} } } as any }), { once: true }); return stream; } } };
    const result = generate(ctx, config, { provider: "fake", id: "test", maxTokens: 32000, contextWindow: 200000 } as any, { messages: [] }, "off", f.deadline.signal, attempts, [], "main", "main", {}, async () => true, "plugin", undefined, f.deadline);
    await Promise.resolve(); assert.ok(sent); assert.equal(attempts[0]!.effectiveDeadlineMs, shortSingle ? 1 : 100);
    f.clock.advance(shortSingle ? 1 : 100);
    await assert.rejects(result, shortSingle ? /dynamic-deadline-exceeded/ : /compaction-total-deadline-exceeded/);
    assert.equal(f.deadline.signal.aborted, !shortSingle); f.deadline.finish();
  }
});

test("retry backoff shares the total signal and cannot launch another attempt after expiry", async () => {
  const f = fixture(20); let calls = 0; const attempts: Attempt[] = [];
  const result = withRequestRetries(DEFAULT_CONFIG, f.deadline.signal, attempts, async () => true, { enabled: true, pi: { maxRetries: 10, baseDelayMs: 1000 } }, async () => { calls++; attempts.push({ stopReason: "error", usageKnown: false, sent: true } as Attempt); throw new Error("HTTP 503"); });
  await Promise.resolve(); await Promise.resolve(); f.clock.advance(20);
  await assert.rejects(result, /compaction-total-deadline-exceeded/); assert.equal(calls, 1); assert.equal(attempts.length, 1);
});

test("show renders charged time and excluded queue time", () => {
  const entry: any = { type: "compaction", id: "c", timestamp: "2026-10-19", summary: "summary", firstKeptEntryId: "u", tokensBefore: 1 };
  assert.match(describeCompaction(entry, [entry], { adopted: { slot: "native" }, totalDeadline: { activeElapsedMs: 65000, queuePausedMs: 12000, limitMinutes: 10 } }), /用时 1 分 5 秒（不含排队 0 分 12 秒）/);
});

test("expiry during the pre-send checkpoint settles the attempt without issuing a request", async () => {
  const f = fixture(20), attempts: Attempt[] = []; let sent = false, checkpoints = 0;
  const ctx: any = { ui: { notify() {} }, modelRegistry: { streamSimple() { sent = true; throw new Error("must not send"); } } };
  await assert.rejects(generate(ctx, DEFAULT_CONFIG, { provider: "fake", id: "test", maxTokens: 32000, contextWindow: 200000 } as any, { messages: [] }, "off", f.deadline.signal, attempts, [], "main", "main", {}, async () => { if (++checkpoints === 1) f.clock.advance(30); return true; }, "plugin", undefined, f.deadline), /compaction-total-deadline-exceeded/);
  assert.equal(sent, false); assert.equal(attempts[0]!.status, "settled"); assert.equal(attempts[0]!.sent, undefined); assert.equal(f.handlers.size, 0);
});

test("successive content retries spend one total budget instead of resetting it", async () => {
  const f = fixture(100), attempts: Attempt[] = []; let calls = 0;
  const result = withRequestRetries({ ...DEFAULT_CONFIG, retry: { invalidOutput: 10, network: 0 } }, f.deadline.signal, attempts, async () => true, { enabled: true }, async () => {
    calls++; attempts.push({ stopReason: "stop", usageKnown: true, sent: true } as Attempt); f.clock.advance(60);
    f.deadline.signal.throwIfAborted(); throw new SyntaxError("invalid JSON");
  });
  await assert.rejects(result, /compaction-total-deadline-exceeded/); assert.equal(calls, 2); assert.equal(f.deadline.snapshot().activeElapsedMs, 100);
});

test("missing leave and no progress cannot pause indefinitely; the independent cap restores both clocks", () => {
  const f = fixture(600000); let singleExpired = false;
  const a = f.deadline.attempt("fake", 30000, () => singleExpired = true);
  f.clock.advance(1000); f.queue("queue.enter"); f.clock.advance(86400000);
  const snapshot = f.deadline.snapshot();
  assert.ok(singleExpired); assert.ok(snapshot.expired); assert.equal(snapshot.queuePausedMs, 1800000); assert.equal(snapshot.activeElapsedMs, 600000);
  assert.equal(snapshot.wallElapsedMs, 2400000); assert.equal(snapshot.queueDiagnostics.filter(d => d.kind === "queue-pause-cap").length, 1); assert.equal(f.clock.tasks.size, 0); a.stop();
});

test("normal twenty-minute queues with updates remain fully excluded under the thirty-minute cap", () => {
  const f = fixture(600000); const a = f.deadline.attempt("fake", 30000, () => assert.fail("single clock should be paused"));
  f.clock.advance(1000); f.queue("queue.enter"); f.clock.advance(600000); f.queue("queue.update", { queuedMs: 600000 });
  f.clock.advance(600000); f.queue("queue.leave", { queuedMs: 1200000 });
  assert.equal(f.deadline.snapshot().queuePausedMs, 1200000); assert.equal(f.deadline.snapshot().activeElapsedMs, 1000); assert.equal(f.deadline.signal.aborted, false);
  assert.equal(f.deadline.snapshot().queueDiagnostics.length, 0); a.stop(); f.deadline.finish();
});

test("generation progress closes a missing leave, and later queuedMs corrects only that past span", () => {
  const f = fixture(); const a = f.deadline.attempt("fake", 1000, () => {});
  f.clock.advance(10); f.queue("queue.enter"); f.clock.advance(40); a.progress();
  assert.equal(f.deadline.snapshot().queuePausedMs, 40); f.clock.advance(20);
  f.queue("queue.leave", { queuedMs: 20 });
  assert.equal(f.deadline.snapshot().queuePausedMs, 20); assert.equal(a.snapshot().queueMs, 20); assert.equal(f.deadline.snapshot().activeElapsedMs, 50);
  f.queue("queue.update", { queuedMs: 20 }); f.clock.advance(49); assert.equal(f.deadline.signal.aborted, false);
  f.clock.advance(1); assert.equal(f.deadline.snapshot().queuePausedMs, 20); assert.equal(f.deadline.snapshot().activeElapsedMs, 100); assert.ok(f.deadline.signal.aborted);
  assert.equal(f.deadline.snapshot().queueDiagnostics[0]!.kind, "generation-progress"); a.stop();
});

test("late authoritative values never move queue end beyond first progress or exceed the cap", () => {
  const f = fixture(1000, new Clock(), 0, 100 / 60000); const a = f.deadline.attempt("fake", 2000, () => {});
  f.clock.advance(20); f.queue("queue.enter"); f.clock.advance(30); a.progress(); f.clock.advance(200);
  f.queue("queue.leave", { queuedMs: 1000 });
  assert.equal(f.deadline.snapshot().queuePausedMs, 50); assert.equal(a.snapshot().queueMs, 50);
  f.clock.advance(800); assert.ok(f.deadline.signal.aborted); assert.equal(f.deadline.snapshot().wallElapsedMs, 1050); a.stop();
});

test("the queue cap is cumulative across requests and cannot be renewed by later queue events", () => {
  const f = fixture(1000, new Clock(), 0, 100 / 60000);
  const a = f.deadline.attempt("fake", 2000, () => {}); f.queue("queue.enter"); f.clock.advance(60); f.queue("queue.leave", { queuedMs: 60 }); a.stop();
  const b = f.deadline.attempt("fake", 2000, () => {}); f.queue("queue.enter"); f.clock.advance(50);
  assert.equal(f.deadline.snapshot().queuePausedMs, 100); assert.equal(f.deadline.snapshot().activeElapsedMs, 10); b.stop();
  const c = f.deadline.attempt("fake", 2000, () => {}); f.queue("queue.update"); f.clock.advance(1000);
  assert.ok(f.deadline.signal.aborted); assert.equal(f.deadline.snapshot().queuePausedMs, 100); assert.equal(f.deadline.snapshot().activeElapsedMs, 1000);
  assert.equal(f.deadline.snapshot().queueDiagnostics.filter(d => d.kind === "queue-pause-cap").length, 1); c.stop();
});

test("queue pause cap configuration defaults to thirty, accepts fractions and rejects unlimited values", async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-pause-config-")); mkdirSync(join(root, "pi-session-compact"));
  try {
    assert.equal((await readConfig(root)).queuePauseCapMinutes, 30);
    for (const queuePauseCapMinutes of [0.25, 30, 60]) { writeFileSync(join(root, "pi-session-compact/config.json"), JSON.stringify({ queuePauseCapMinutes })); assert.equal((await readConfig(root)).queuePauseCapMinutes, queuePauseCapMinutes); }
    for (const queuePauseCapMinutes of [0, -1, "30", null, false]) { writeFileSync(join(root, "pi-session-compact/config.json"), JSON.stringify({ queuePauseCapMinutes })); await assert.rejects(readConfig(root), /Invalid queuePauseCapMinutes/); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("text, thinking and toolcall deltas each restore generation clocks when leave is missing", async () => {
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    const f = fixture(), attempts: Attempt[] = [], stream = createAssistantMessageEventStream();
    const ctx: any = { sessionManager: { getSessionId: () => "ours" }, ui: { notify() {} }, modelRegistry: { streamSimple(_m: unknown, _c: unknown, options: any) {
      f.queue("queue.enter"); options.signal.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} } } as any }), { once: true }); return stream;
    } } };
    const result = generate(ctx, DEFAULT_CONFIG, { provider: "fake", id: "test", maxTokens: 32000, contextWindow: 200000 } as any, { messages: [] }, "off", f.deadline.signal, attempts, [], "main", "main", {}, async () => true, "plugin", undefined, f.deadline);
    await Promise.resolve(); f.clock.advance(20); stream.push({ type, contentIndex: 0, delta: "progress", partial: {} } as any);
    for (let i = 0; i < 20 && attempts[0]!.timings.ttftMs === null; i++) await Promise.resolve();
    assert.notEqual(attempts[0]!.timings.ttftMs, null);
    f.clock.advance(100);
    await assert.rejects(result, /compaction-total-deadline-exceeded/); assert.equal(f.deadline.snapshot().queuePausedMs, 20); assert.equal(attempts[0]!.timings.queueMs, 20);
  }
});

test("late queuedMs after the cap can revise only the capped past and cannot renew pauses", () => {
  const f = fixture(2000, new Clock(), 0, 100 / 60000), a = f.deadline.attempt("fake", 4000, () => {});
  f.clock.advance(10); f.queue("queue.enter"); f.clock.advance(100); f.clock.advance(200);
  f.queue("queue.leave", { queuedMs: 10000 }); assert.equal(f.deadline.snapshot().queuePausedMs, 100);
  f.clock.advance(10); f.queue("queue.update", { queuedMs: 20 }); assert.equal(f.deadline.snapshot().queuePausedMs, 20);
  f.queue("queue.enter"); f.clock.advance(1700);
  assert.ok(f.deadline.signal.aborted); assert.equal(f.deadline.snapshot().queuePausedMs, 20); assert.equal(f.deadline.snapshot().wallElapsedMs, 2020);
  assert.equal(f.deadline.snapshot().queueDiagnostics.filter(d => d.kind === "queue-pause-cap").length, 1); a.stop();
});
