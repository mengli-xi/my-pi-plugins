import assert from "node:assert/strict";
import test from "node:test";

import type { ProcessSummary } from "../../src/domain/types.ts";
import type { SupervisorEvent } from "../../src/host/supervisor-client.ts";
import {
  PROCESS_NOTIFICATION_RECEIPT_TYPE,
  PROCESS_NOTIFICATION_STATUS_TYPE,
  lifecycleMessage,
  registerNotificationReceiptRenderer,
  registerNotificationStatusRenderer,
} from "../../src/integrations/lifecycle-entry.ts";

function process(
  outcome: NonNullable<ProcessSummary["terminal"]>["outcome"],
  options: { exitCode?: number | null; signal?: string | null; runtimeMs?: number } = {},
): ProcessSummary {
  return {
    id: "proc_demo000001",
    name: "demo",
    kind: "process",
    state: outcome,
    commandPreview: "demo",
    commandTruncated: false,
    cwd: "/tmp",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:16.000Z",
    runtimeMs: options.runtimeMs ?? 16_000,
    stdinOpen: false,
    continuation: { mode: "detached" },
    watches: { count: 0, keys: [], failedKeys: [] },
    logs: { revision: 1, earliestSequence: 1, nextSequence: 2, droppedBytes: 0, droppedLines: 0 },
    terminal: {
      outcome,
      exitCode: options.exitCode ?? null,
      signal: options.signal ?? null,
    },
  };
}

function terminalEvent(payload: Record<string, unknown>): SupervisorEvent {
  return { type: "terminal", eventSequence: 1, payload: { id: "proc_demo000001", ...payload } };
}

test("notification control-plane entries create no transcript component", () => {
  const renderers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    registerEntryRenderer(type: string, renderer: (...args: unknown[]) => unknown) {
      renderers.set(type, renderer);
    },
  } as unknown as Parameters<typeof registerNotificationStatusRenderer>[0];
  registerNotificationStatusRenderer(pi);
  registerNotificationReceiptRenderer(pi);
  assert.equal(renderers.get(PROCESS_NOTIFICATION_STATUS_TYPE)?.(), undefined);
  assert.equal(renderers.get(PROCESS_NOTIFICATION_RECEIPT_TYPE)?.(), undefined);
});

test("publishes structured terminal causes and precise fallback text", () => {
  const succeeded = lifecycleMessage(
    terminalEvent({ classification: "natural", exitCode: 0, signal: null }),
    process("succeeded", { exitCode: 0 }),
  );
  assert.equal(succeeded?.text, "Process 'demo' succeeded after 16s.");
  assert.deepEqual(succeeded?.terminal, {
    outcome: "succeeded",
    cause: "completed",
    durationMs: 16_000,
    exitCode: 0,
  });

  const failed = lifecycleMessage(
    terminalEvent({ classification: "failed", exitCode: 7, signal: null }),
    process("failed", { exitCode: 7 }),
  );
  assert.equal(failed?.text, "Process 'demo' failed after 16s due to exit code 7.");
  assert.deepEqual(failed?.terminal, {
    outcome: "failed",
    cause: "exit-code",
    durationMs: 16_000,
    exitCode: 7,
  });

  const signalled = lifecycleMessage(
    terminalEvent({ classification: "failed", exitCode: null, signal: "SIGTERM" }),
    process("killed", { signal: "SIGTERM" }),
  );
  assert.equal(signalled?.text, "Process 'demo' was killed after 16s by SIGTERM.");
  assert.equal(signalled?.terminal?.cause, "killed");
  assert.equal(signalled?.terminal?.signal, "SIGTERM");

  const timedOut = lifecycleMessage(
    terminalEvent({ classification: "timeout", exitCode: null, signal: "SIGKILL", timeoutMs: 15_000 }),
    process("failed", { signal: "SIGKILL" }),
  );
  assert.equal(timedOut?.text, "Process 'demo' timed out after 16s (limit 15s).");
  assert.deepEqual(timedOut?.terminal, {
    outcome: "failed",
    cause: "timeout",
    durationMs: 16_000,
    signal: "SIGKILL",
    timeoutMs: 15_000,
  });
});
