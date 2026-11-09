import assert from "node:assert/strict";
import test from "node:test";

import {
  PROCESSES_OPEN_REQUEST_CHANNEL,
  PROCESSES_SNAPSHOT_REQUEST_CHANNEL,
  PROCESSES_STATUS_SNAPSHOT_CHANNEL,
  STATUS_LINE_ROW_CHANNEL,
} from "../src/integration-contracts.ts";
import { installProcessesStatusConsumer } from "../src/statusline/processes.ts";
import { ContributedRows } from "../src/statusline/extra-lines.ts";

class Bus {
  readonly emitted: Array<{ channel: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  on(channel: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? [];
    handlers.push(handler);
    this.handlers.set(channel, handlers);
    return () => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  }

  emit(channel: string, payload: unknown): void {
    this.emitted.push({ channel, payload });
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

function setup() {
  const bus = new Bus();
  const rows = new ContributedRows();
  bus.on(STATUS_LINE_ROW_CHANNEL, (payload) => rows.handle(payload));
  const lifecycle = new Map<string, Array<(event: unknown, ctx: any) => void>>();
  const pi = {
    events: bus,
    on(name: string, handler: (event: unknown, ctx: any) => void) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
  } as never;
  const installed = installProcessesStatusConsumer(pi);
  const ctx = {
    sessionManager: { getSessionId: () => "session-a" },
    ui: { theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } },
  };
  for (const handler of lifecycle.get("session_start") ?? []) handler({}, ctx);
  return { bus, rows, lifecycle, installed };
}

test("semantic snapshots become a clickable color-coded role summary on row three", () => {
  const { bus, rows, installed } = setup();
  assert.equal(bus.emitted.some((entry) => entry.channel === PROCESSES_SNAPSHOT_REQUEST_CHANNEL), true);

  bus.emit(PROCESSES_STATUS_SNAPSHOT_CHANNEL, {
    version: 2,
    sessionScopeId: "session-a",
    revision: 2,
    emittedAt: new Date().toISOString(),
    processes: [
      { id: "proc_1", name: "api", kind: "service", state: "running" },
      { id: "proc_2", name: "watch", kind: "monitor", state: "running" },
      { id: "proc_3", name: "build", kind: "process", state: "starting" },
      { id: "proc_4", name: "worker", kind: "service", state: "stopping" },
    ],
  });

  const composed = rows.spliceInline(["project", "model", "todo"]);
  assert.deepEqual(
    composed.lines,
    [
      "project",
      "model",
      "todo │ <customMessageLabel>process 1</customMessageLabel><muted> · </muted><accent>monitor 1</accent><muted> · </muted><success>service 2</success>",
    ],
  );
  assert.equal(composed.spans[2]?.[0]?.onClick?.(), true);
  const opened = [...bus.emitted]
    .reverse()
    .find((entry) => entry.channel === PROCESSES_OPEN_REQUEST_CHANNEL);
  assert.equal((opened?.payload as { observedRevision?: unknown }).observedRevision, 2);
  installed.dispose();
});

test("consumer rejects stale, foreign, and malformed snapshots and withdraws on shutdown", () => {
  const { bus, rows, lifecycle, installed } = setup();
  const emit = (sessionScopeId: string, revision: number, count: number) => {
    bus.emit(PROCESSES_STATUS_SNAPSHOT_CHANNEL, {
      version: 2,
      sessionScopeId,
      revision,
      emittedAt: new Date().toISOString(),
      processes: Array.from({ length: count }, (_, index) => ({
        id: `proc_${index}`,
        name: `p${index}`,
        kind: index % 2 === 0 ? "monitor" : "service",
        state: "running",
      })),
    });
  };

  emit("session-a", 3, 2);
  emit("session-a", 2, 1);
  emit("session-b", 4, 4);
  assert.deepEqual(
    rows.spliceInline(["a", "b", "c"]).lines,
    [
      "a",
      "b",
      "c │ <accent>monitor 1</accent><muted> · </muted><success>service 1</success>",
    ],
  );

  for (const handler of lifecycle.get("session_shutdown") ?? []) handler({}, undefined);
  assert.deepEqual(rows.spliceInline(["a", "b", "c"]).lines, ["a", "b", "c"]);
  installed.dispose();
});
