import assert from "node:assert/strict";
import test from "node:test";
import { formatProcessNotificationBatchV1, NotificationFormattingErrorV1 } from "../../src/notifications/formatting.ts";
import type { ProcessNotificationBatchItemV1, ProcessNotificationBatchV1 } from "../../src/notifications/types.ts";

function item(overrides: Partial<ProcessNotificationBatchItemV1> = {}): ProcessNotificationBatchItemV1 {
  return {
    kind: "watch-match", processId: "proc_000000000001", processName: "build", watchKey: "progress", watchGeneration: 1,
    count: 100, matchedCount: 20, suppressedCount: 80,
    firstFactId: "session:host:1", lastFactId: "session:host:100", hostIncarnationId: "host",
    firstNotificationSequence: 1, lastNotificationSequence: 100,
    firstObservedAt: "2026-09-04T00:00:00.000Z", lastObservedAt: "2026-09-04T00:01:00.000Z",
    ...overrides,
  };
}
function batch(items: ProcessNotificationBatchItemV1[], overrides: Partial<ProcessNotificationBatchV1> = {}): ProcessNotificationBatchV1 {
  return { version: 1, batchId: "batch", sessionScopeId: "session", epochId: "epoch", reason: "user-boundary", mode: "aggregate", createdAt: "2026-09-04T00:02:00.000Z", items, ...overrides };
}

test("formatter reports exact watch counts and mandatory ranges", () => {
  const value = formatProcessNotificationBatchV1(batch([item()]));
  assert.match(value.text, /matched watch 'progress' 100 times \(20 reported, 80 suppressed\)/);
  assert.match(value.text, /facts session:host:1\.\.session:host:100/);
  assert.match(value.text, /notifications 1\.\.100/);
  assert.equal(value.excerptsIncluded, 0);
});

test("formatter emits precise wording for every terminal cause", () => {
  const cases: Array<{
    terminal: NonNullable<ProcessNotificationBatchItemV1["terminal"]>;
    expected: RegExp;
  }> = [
    { terminal: { outcome: "succeeded", cause: "completed", durationMs: 16_000 }, expected: /Process 'build' succeeded after 16s\./ },
    { terminal: { outcome: "failed", cause: "exit-code", durationMs: 16_000, exitCode: 7 }, expected: /Process 'build' failed after 16s due to exit code 7\./ },
    { terminal: { outcome: "failed", cause: "signal", durationMs: 16_000, signal: "SIGTERM" }, expected: /Process 'build' failed after 16s due to signal SIGTERM\./ },
    { terminal: { outcome: "failed", cause: "timeout", durationMs: 16_000, timeoutMs: 15_000 }, expected: /Process 'build' timed out after 16s \(limit 15s\)\./ },
    { terminal: { outcome: "stopped", cause: "stopped", durationMs: 16_000 }, expected: /Process 'build' stopped after 16s\./ },
    { terminal: { outcome: "killed", cause: "killed", durationMs: 16_000, signal: "SIGKILL" }, expected: /Process 'build' was killed after 16s by SIGKILL\./ },
    { terminal: { outcome: "crashed", cause: "runtime-error", durationMs: 16_000 }, expected: /Process 'build' crashed after 16s\./ },
  ];
  for (const { terminal, expected } of cases) {
    const value = formatProcessNotificationBatchV1(batch([item({
      kind: "terminal",
      count: 1,
      matchedCount: undefined,
      suppressedCount: undefined,
      terminal,
    })]));
    assert.match(value.text, expected);
  }
});

test("formatter sanitizes controls and escapes quoted Unicode identities", () => {
  const value = formatProcessNotificationBatchV1(batch([item({
    processName: "bad'\n\\\u0007界",
    watchKey: "watch\tline'\\\u007f尾",
    count: 1,
    matchedCount: 1,
    suppressedCount: 0,
  })]));
  assert.ok(!value.text.includes("\u0007"));
  assert.ok(!value.text.includes("\u007f"));
  assert.ok(!value.text.includes("\t"));
  assert.match(value.text, /Process 'bad\\' \\\\界' matched watch 'watch line\\'\\\\尾'\./);
});

test("formatter keeps UTF-8 valid and truncates excerpts within item and batch budgets", () => {
  const source = "界".repeat(2000);
  const value = formatProcessNotificationBatchV1(batch([
    item({ latestExcerpt: { stream: "stdout", text: source, truncated: false } }),
    item({ firstFactId: "f2", lastFactId: "f2", firstNotificationSequence: 101, lastNotificationSequence: 101, latestExcerpt: { stream: "stderr", text: source, truncated: false } }),
  ]), { maxBytes: 3000, maxExcerptBytes: 2000 });
  assert.ok(value.bytes <= 3000);
  assert.equal(new TextEncoder().encode(value.text).byteLength, value.bytes);
  assert.ok(!value.text.includes("�"));
  assert.equal(value.excerptsIncluded, 2);
  assert.equal(value.excerptsOmitted, 0);
  assert.equal(value.excerptsTruncated, 2);
});

test("formatter respects exact mandatory byte boundaries", () => {
  const mandatory = formatProcessNotificationBatchV1(batch([item({ count: 1, matchedCount: 1, suppressedCount: 0 })]));
  const exact = formatProcessNotificationBatchV1(
    batch([item({ count: 1, matchedCount: 1, suppressedCount: 0 })]),
    { maxBytes: mandatory.bytes },
  );
  assert.equal(exact.bytes, mandatory.bytes);
  assert.throws(
    () => formatProcessNotificationBatchV1(
      batch([item({ count: 1, matchedCount: 1, suppressedCount: 0 })]),
      { maxBytes: mandatory.bytes - 1 },
    ),
    (error) => error instanceof NotificationFormattingErrorV1 && error.code === "mandatory-content-too-large",
  );
});

test("formatter never drops mandatory content to fit the budget", () => {
  assert.throws(() => formatProcessNotificationBatchV1(batch([item({ processName: "x".repeat(2000) })]), { maxBytes: 100 }), (error) => error instanceof NotificationFormattingErrorV1 && error.code === "mandatory-content-too-large");
});

test("formatter preserves UTF-8 code points at 1/2/3/4-byte excerpt boundaries", () => {
  const cases = [
    { text: "A", bytes: 1 },
    { text: "¢", bytes: 2 },
    { text: "界", bytes: 3 },
    { text: "😀", bytes: 4 },
  ];
  for (const { text, bytes } of cases) {
    const value = formatProcessNotificationBatchV1(
      batch([item({ latestExcerpt: { stream: "stdout", text, truncated: false } })]),
      { maxExcerptBytes: bytes },
    );
    assert.match(value.text, new RegExp(`\\[stdout\\] ${text}`));
    assert.ok(!value.text.includes("�"));
    assert.equal(value.excerptBytes, bytes);
    assert.equal(value.excerptsTruncated, 0);
  }
});

test("formatter records source truncation even when the excerpt is already short", () => {
  const value = formatProcessNotificationBatchV1(batch([item({
    latestExcerpt: { stream: "stderr", text: "short", truncated: true },
  })]));
  assert.match(value.text, /\[stderr\] short/);
  assert.equal(value.excerptsIncluded, 1);
  assert.equal(value.excerptsTruncated, 1);
});

test("zero excerpt budget omits excerpts without dropping mandatory content", () => {
  const value = formatProcessNotificationBatchV1(
    batch([item({ latestExcerpt: { stream: "stdout", text: "output", truncated: false } })]),
    { maxExcerptBytes: 0 },
  );
  assert.ok(!value.text.includes("[stdout]"));
  assert.match(value.text, /facts session:host:1\.\.session:host:100/);
  assert.equal(value.excerptsIncluded, 0);
  assert.equal(value.excerptsOmitted, 1);
});

test("minimal continuation supports one to fifty mandatory items and prompts explicit process queries", () => {
  const value = formatProcessNotificationBatchV1(batch([item({ count: 1, matchedCount: 1, suppressedCount: 0, watchKey: "ready" }), item({ processId: "proc_000000000002", processName: "second" })], { mode: "minimal-continuation", reason: "subagent-admission" }));
  assert.match(value.text, /wait condition is satisfied/);
  assert.match(value.text, /process list or process logs/);
  assert.throws(() => formatProcessNotificationBatchV1(batch([], { mode: "minimal-continuation" })), NotificationFormattingErrorV1);
  assert.throws(() => formatProcessNotificationBatchV1(batch(Array.from({ length: 51 }, () => item()), { mode: "minimal-continuation" })), NotificationFormattingErrorV1);
});

test("fifty items retain mandatory metadata within the default batch budget", () => {
  const items = Array.from({ length: 50 }, (_, index) => item({
    processId: `proc_${String(index).padStart(12, "0")}`,
    processName: `process-${index}`,
    watchKey: `watch-${index}`,
    count: 1,
    matchedCount: 1,
    suppressedCount: 0,
    firstFactId: `f${index}`,
    lastFactId: `f${index}`,
    firstNotificationSequence: index + 1,
    lastNotificationSequence: index + 1,
    latestExcerpt: { stream: "stdout", text: "界".repeat(1000), truncated: false },
  }));
  const value = formatProcessNotificationBatchV1(batch(items, {
    overflow: { omittedItems: 12, byKind: { terminal: 2, "watch-match": 10 } },
  }));
  assert.ok(value.bytes <= 32 * 1024);
  assert.equal((value.text.match(/^-/gmu) ?? []).length, 50);
  assert.ok(value.excerptsIncluded < 50);
  for (let index = 0; index < 50; index++) assert.match(value.text, new RegExp(`facts f${index}\\.\\.f${index}`));
  assert.match(value.text, /12 additional updates \(terminal: 2, watch-match: 10\)/);
});

test("overflow footer is mandatory and deterministic", () => {
  const value = formatProcessNotificationBatchV1(batch([item()], { overflow: { omittedItems: 12, byKind: { terminal: 2, "watch-match": 10 } } }));
  assert.match(value.text, /12 additional updates \(terminal: 2, watch-match: 10\)/);
});
