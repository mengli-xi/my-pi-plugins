import assert from "node:assert/strict";
import test from "node:test";

import type { ProcessSummary } from "../../src/domain/types.ts";
import { projectNotificationV1 } from "../../src/notifications/projection.ts";

const process: ProcessSummary = {
  id: "proc_demo000001",
  name: "demo",
  kind: "monitor",
  state: "running",
  commandPreview: "demo",
  commandTruncated: false,
  cwd: "/tmp",
  startedAt: "2026-01-01T00:00:00.000Z",
  runtimeMs: 1_000,
  stdinOpen: true,
  continuation: { mode: "detached" },
  watches: { count: 1, keys: ["ready"], failedKeys: [] },
  logs: { revision: 1, earliestSequence: 1, nextSequence: 2, droppedBytes: 0, droppedLines: 0 },
};

const base = {
  sessionScopeId: "session",
  hostIncarnationId: "host",
  target: { strategy: "main" as const, scopeToken: "session" },
  process,
  attention: "context" as const,
  observedAt: "2026-01-01T00:00:01.000Z",
};

test("projection binds repeat watch semantics and immutable TUI entry to the source event", () => {
  const projected = projectNotificationV1({
    ...base,
    notificationSequence: 1,
    watchRepeat: true,
    supervisor: { nonce: "nonce", generation: 2 },
    event: { type: "watchMatch", eventSequence: 7, payload: { id: process.id, key: "ready", generation: 3, sequence: 11, text: "ready" } },
  });
  assert.ok(projected);
  assert.deepEqual(projected.observe.fact.watch, { key: "ready", generation: 3, repeat: true, firstSequence: 11, lastSequence: 11, count: 1 });
  assert.deepEqual(projected.observe.fact.source.supervisor, { nonce: "nonce", generation: 2, eventSequence: 7 });
  assert.equal(projected.observe.tuiEntry?.customType, "process-event-v2");
  assert.equal(JSON.parse(projected.observe.tuiEntry!.dataJson).eventSequence, 7);
});

test("projection bounds a maximum legal watch line without changing legacy lifecycle data", () => {
  const text = "x".repeat(65_536);
  const projected = projectNotificationV1({
    ...base,
    notificationSequence: 1,
    watchRepeat: true,
    supervisor: { nonce: "nonce", generation: 2 },
    event: { type: "watchMatch", eventSequence: 7, payload: { id: process.id, key: "ready", generation: 3, sequence: 11, text } },
  });
  assert.ok(projected);
  assert.equal(projected.lifecycle.details?.text, text);
  assert.ok(Buffer.byteLength(projected.observe.tuiEntry!.dataJson, "utf8") < 65_536);
  const entry = JSON.parse(projected.observe.tuiEntry!.dataJson);
  assert.equal(entry.details.text, undefined);
  assert.equal(entry.details.textBytes, 65_536);
  assert.equal(entry.details.textTruncated, true);
  assert.ok(Buffer.byteLength(entry.details.textExcerpt, "utf8") <= 2_000);
});

test("projection rejects incomplete watch identity instead of inventing sequence or generation", () => {
  assert.equal(projectNotificationV1({
    ...base,
    notificationSequence: 1,
    event: { type: "watchMatch", eventSequence: 7, payload: { id: process.id, key: "ready" } },
  }), undefined);
});

test("intentional stopped terminal is aggregated without a TUI entry", () => {
  const stopped: ProcessSummary = {
    ...process,
    state: "stopped",
    endedAt: "2026-01-01T00:00:01.000Z",
    stdinOpen: false,
    terminal: { outcome: "stopped", exitCode: null, signal: null },
  };
  const projected = projectNotificationV1({
    ...base,
    process: stopped,
    notificationSequence: 1,
    event: { type: "terminal", eventSequence: 8, payload: { id: stopped.id, classification: "stopped" } },
  });
  assert.ok(projected);
  assert.equal(projected.observe.fact.terminal?.cause, "stopped");
  assert.equal(projected.observe.tuiEntry, undefined);
});
