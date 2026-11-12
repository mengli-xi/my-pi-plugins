import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import piPerf from "../index.ts";
import { getUiObservabilityRegistry } from "../src/ui-metrics.ts";

test("questionnaire close is correlated through tool resume and paint without polluting editor submit", async t => {
  const root = mkdtempSync(join(tmpdir(), "perf-input-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
  const busHandlers = new Map<string, Array<(event: any) => unknown>>();
  const on = (name: string, handler: (event: any, ctx?: any) => unknown): void => {
    const registered = handlers.get(name) ?? [];
    registered.push(handler);
    handlers.set(name, registered);
  };
  const emit = async (name: string, event: any, ctx?: any): Promise<void> => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const emitBus = (name: string, event: any): void => {
    for (const handler of busHandlers.get(name) ?? []) handler(event);
  };

  class FakeTui {
    mode = "fullscreen";
    fullRedraws = 0;
    requestRender(): void {}
    handleTerminalInput(_data: string): void {
      this.requestRender();
    }
    doRender(): void {}
  }

  const tui = new FakeTui();
  let widget: { dispose?(): void } | undefined;
  const ctx = {
    cwd: root,
    mode: "tui",
    sessionManager: { getSessionId: () => "questionnaire-test" },
    ui: {
      setWidget: (_key: string, factory: unknown) => {
        if (typeof factory === "function") widget = factory(tui as unknown as TUI);
      },
      onTerminalInput: () => () => {},
      notify: () => {},
    },
  };
  let command: any;
  const pi = {
    getSettings: () => ({}),
    getAllTools: () => [], getCommands: () => [],
    on,
    registerCommand: (_name: string, definition: any) => { command = definition; },
    events: {
      on: (name: string, handler: (event: any) => unknown) => {
        const registered = busHandlers.get(name) ?? [];
        registered.push(handler);
        busHandlers.set(name, registered);
        return () => busHandlers.set(name, (busHandlers.get(name) ?? []).filter((value) => value !== handler));
      },
    },
  };

  piPerf(pi as any);
  const registry = getUiObservabilityRegistry();
  await emit("session_start", {}, ctx);
  await command.handler("on", ctx);
  registry.reset();

  const toolCallId = "ask-1";
  await emit("tool_execution_start", {
    toolCallId,
    toolName: "ask_user_question",
    args: {},
  });
  emitBus("rpiv:ask-user:blocked", { active: true });
  tui.handleTerminalInput("\r");
  // Pi resolves ui.custom and emits tool_execution_end in a promise
  // continuation before the nextTick-rendered frame.
  emitBus("rpiv:ask-user:blocked", { active: false });
  await emit("tool_execution_end", {
    toolCallId,
    toolName: "ask_user_question",
    result: {},
    isError: false,
  });
  tui.doRender();

  const names = new Set(registry.snapshot().metrics.map(({ name }) => name));
  assert.equal(names.has("overlay-enter→request"), true);
  assert.equal(names.has("overlay-enter-handler"), true);
  assert.equal(names.has("overlay-enter→paint"), true);
  assert.equal(names.has("questionnaire-submit-handler"), true);
  assert.equal(names.has("questionnaire-submit→tool-resume"), true);
  assert.equal(names.has("questionnaire-submit→paint"), true);
  assert.equal(names.has("submit-handler"), false);
  assert.equal(names.has("submit-key→request"), false);
  assert.equal(names.has("submit-key→paint"), false);

  const cancelledToolCallId = "ask-cancelled";
  await emit("tool_execution_start", {
    toolCallId: cancelledToolCallId,
    toolName: "ask_user_question",
    args: {},
  });
  emitBus("rpiv:ask-user:blocked", { active: true });
  tui.handleTerminalInput("\r");
  tui.doRender();
  emitBus("rpiv:ask-user:blocked", { active: false });
  await emit("tool_execution_end", {
    toolCallId: cancelledToolCallId,
    toolName: "ask_user_question",
    result: { details: { cancelled: true } },
    isError: false,
  });
  const afterCancel = registry.snapshot().metrics;
  for (const name of [
    "questionnaire-submit-handler",
    "questionnaire-submit→tool-resume",
    "questionnaire-submit→paint",
  ]) {
    assert.equal(afterCancel.find((metric) => metric.name === name)?.count, 1);
  }

  widget?.dispose?.();
  await emit("session_shutdown", {});
});
