import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import register from "../src/index.ts";
import {
  sanitizeName,
  SessionNamingController,
} from "../src/naming.ts";

test("sanitizes quotes, punctuation, ANSI and character length", () => {
  assert.equal(sanitizeName('\x1b[31m“修复终端卡顿。”\x1b[0m', 24), "修复终端卡顿");
  assert.equal(sanitizeName("abcdefghijklmnop", 8), "abcdefgh");
  assert.equal(sanitizeName("first\nsecond", 24), "first");
  assert.equal(sanitizeName("\x1b]0;hidden\x07安全\u202e\u2066\x00\x7f标题", 24), "安全标题");
});

test("generation prefers ModelRegistry.complete for native providers", async () => {
  const lifecycle = new Map<string, Array<(event: any, ctx: any) => void>>();
  let sessionName: string | undefined;
  let completionCalls = 0;
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
    events: { on: () => () => {} },
    getSessionName: () => sessionName,
    setSessionName(value: string) {
      sessionName = value;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    model: { provider: "native-test", id: "model" },
    sessionManager: { getSessionId: () => "real-pi-session-id" },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: () => {
        throw new Error("compat auth must not run for ModelRegistry.complete");
      },
      async complete(
        _model: unknown,
        context: { messages?: unknown[] },
        options: { sessionId?: string; maxTokens?: number; reasoning?: string },
      ) {
        completionCalls++;
        assert.equal(context.messages?.length, 1);
        assert.equal(options.sessionId, "real-pi-session-id");
        assert.equal(options.maxTokens, 128);
        assert.equal(options.reasoning, undefined);
        return {
          content: [{ type: "text", text: "修复原生模型命名。" }],
          stopReason: "stop",
        };
      },
    },
  } as unknown as ExtensionContext;
  new SessionNamingController(pi, () => DEFAULT_CONFIG).install();
  lifecycle.get("session_start")?.[0]?.({}, ctx);
  lifecycle.get("agent_end")?.[0]?.({
    messages: [
      { role: "user", content: "请修复命名" },
      { role: "assistant", content: "已经处理" },
    ],
  }, ctx);
  lifecycle.get("agent_settled")?.[0]?.({}, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completionCalls, 1);
  assert.equal(sessionName, "修复原生模型命名");
});

test("generation has a bounded timeout when a provider never settles", async () => {
  const lifecycle = new Map<string, Array<(event: any, ctx: any) => void>>();
  let sessionName: string | undefined;
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
    events: { on: () => () => {} },
    getSessionName: () => sessionName,
    setSessionName(value: string) {
      sessionName = value;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    model: { provider: "hanging-test", id: "model" },
    sessionManager: { getSessionId: () => "hanging-session" },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: () => new Promise(() => {}),
    },
  } as unknown as ExtensionContext;
  const controller = new SessionNamingController(pi, () => ({
    ...DEFAULT_CONFIG,
    timeoutMs: 10,
  }));
  controller.install();
  lifecycle.get("session_start")?.[0]?.({}, ctx);
  lifecycle.get("agent_end")?.[0]?.({
    messages: [{ role: "user", content: "never settle" }],
  }, ctx);
  lifecycle.get("agent_settled")?.[0]?.({}, ctx);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(controller.status.lastOutcome, "timeout");
  assert.equal(sessionName, undefined);
});

interface CompletionResponse {
  content?: Array<Record<string, unknown>>;
  stopReason?: string;
}

interface PendingCall {
  options: { signal?: AbortSignal };
  resolve: (value: CompletionResponse) => void;
  reject: (reason?: unknown) => void;
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

function ownTimer(controller: SessionNamingController): unknown {
  return (controller as unknown as { pendingTimer?: unknown }).pendingTimer;
}

/** Drives real lifecycle handlers; the fake only owns ModelRegistry.complete settlement. */
function harness(getConfig: () => typeof DEFAULT_CONFIG) {
  const lifecycle = new Map<string, Array<(event: any, ctx: any) => void>>();
  const calls: PendingCall[] = [];
  let sessionName: string | undefined;
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
    events: { on: () => () => {} },
    getSessionName: () => sessionName,
    setSessionName(value: string) {
      sessionName = value;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    model: { provider: "deadline-test", id: "model" },
    sessionManager: { getSessionId: () => "deadline-session" },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) =>
        new Promise<CompletionResponse>((resolve, reject) => {
          calls.push({ options, resolve, reject });
        }),
    },
  } as unknown as ExtensionContext;
  const controller = new SessionNamingController(pi, getConfig);
  controller.install();
  const emit = (name: string, event: unknown = {}) => {
    for (const handler of lifecycle.get(name) ?? []) handler(event, ctx);
  };
  return {
    controller,
    ctx,
    calls,
    emit,
    name: () => sessionName,
    // One settled run of a fresh session; complete() is invoked before the first await.
    startRequest(): PendingCall {
      emit("session_start");
      emit("agent_end", {
        messages: [
          { role: "user", content: "命名这次会话" },
          { role: "assistant", content: "好" },
        ],
      });
      emit("agent_settled");
      return calls[calls.length - 1];
    },
  };
}

test("a stale request resolving late keeps the newer request's own deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let timeoutMs = 5_000;
  const rig = harness(() => ({ ...DEFAULT_CONFIG, timeoutMs }));
  const older = rig.startRequest();
  timeoutMs = 20;
  const newer = rig.startRequest();
  assert.equal(rig.calls.length, 2);
  older.resolve({ content: [{ type: "text", text: "旧标题" }], stopReason: "stop" });
  await flush();
  assert.equal(rig.controller.status.lastOutcome, "generating");
  t.mock.timers.tick(19);
  await flush();
  assert.equal(newer.options.signal?.aborted, false, "newer deadline fires on its own timeoutMs, not earlier");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(newer.options.signal?.aborted, true, "an older finally must not clear the newer request timer");
  assert.equal(rig.controller.status.lastOutcome, "timeout");
  assert.equal(rig.name(), undefined);
});

test("a stale request rejecting late keeps the newer request's own deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = harness(() => ({ ...DEFAULT_CONFIG, timeoutMs: 20 }));
  const older = rig.startRequest();
  const newer = rig.startRequest();
  older.reject(new Error("provider rejected"));
  await flush();
  assert.equal(
    rig.controller.status.lastOutcome,
    "generating",
    "the stale rejection is telemetry-only; the newer request still owns the reported outcome",
  );
  t.mock.timers.tick(20);
  await flush();
  assert.equal(newer.options.signal?.aborted, true, "a rejected older finally must not clear the newer request timer");
  assert.equal(rig.controller.status.lastOutcome, "timeout");
  assert.equal(rig.name(), undefined);
});

test("a completed request clears its own deadline timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = harness(() => ({ ...DEFAULT_CONFIG, timeoutMs: 20 }));
  const call = rig.startRequest();
  call.resolve({ content: [{ type: "text", text: "命名会话" }], stopReason: "stop" });
  await flush();
  assert.equal(rig.name(), "命名会话");
  assert.equal(rig.controller.status.lastOutcome, "success");
  assert.equal(ownTimer(rig.controller), undefined);
  t.mock.timers.tick(200);
  await flush();
  assert.equal(call.options.signal?.aborted, false);
  assert.equal(rig.controller.status.lastOutcome, "success");
});

test("session_shutdown cancels the in-flight deadline timer and abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = harness(() => ({ ...DEFAULT_CONFIG, timeoutMs: 20 }));
  const call = rig.startRequest();
  rig.emit("session_shutdown");
  assert.equal(call.options.signal?.aborted, true);
  assert.equal(ownTimer(rig.controller), undefined);
  t.mock.timers.tick(200);
  await flush();
  assert.equal(rig.controller.status.lastOutcome, "generating");
  assert.equal(rig.name(), undefined);
});

test("automatic naming registers no command alongside Pi's built-in /name", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-naming-no-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const commands: string[] = [];
  register({ on() {}, getSessionName() {}, registerCommand(name: string) { commands.push(name); } } as never);
  assert.deepEqual(commands, []);
});

test("default naming effort follows the cheapest level accepted by the session model", async () => {
  const rig = harness(() => DEFAULT_CONFIG);
  (rig.ctx as any).model = { provider: "native-test", id: "reasoning-only", reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" } };
  const call = rig.startRequest();
  assert.equal((call.options as any).reasoning, "low");
  call.resolve({ content: [{ type: "text", text: "有效命名" }], stopReason: "stop" });
  await flush();
  assert.equal(rig.name(), "有效命名");
  assert.equal(rig.controller.status.lastOutcome, "success");
});

test("explicit model selection never falls back and preserves a literal model suffix", async () => {
  const missing = harness(() => ({ ...DEFAULT_CONFIG, model: "provider-a/missing@off" }));
  missing.startRequest();
  await flush();
  assert.equal(missing.calls.length, 0, "unknown explicit model must not use the session provider");
  assert.equal(missing.controller.status.lastOutcome, "model-unavailable");
  const present = harness(() => ({ ...DEFAULT_CONFIG, model: "provider-a/fast@off" }));
  const model = { provider: "provider-a", id: "fast@off", reasoning: false };
  (present.ctx.modelRegistry as any).find = (provider: string, id: string) => {
    assert.equal(provider, "provider-a");
    assert.equal(id, "fast@off");
    return model;
  };
  const original = present.ctx.modelRegistry.complete.bind(present.ctx.modelRegistry);
  (present.ctx.modelRegistry as any).complete = (selected: unknown, ...args: any[]) => {
    assert.equal(selected, model);
    return (original as any)(selected, ...args);
  };
  const call = present.startRequest();
  assert.equal((call.options as any).reasoning, undefined);
  call.resolve({ content: [{ type: "text", text: "定向命名" }], stopReason: "stop" });
  await flush();
  assert.equal(present.name(), "定向命名");
});

test("provider error results leave a truthful terminal outcome", async () => {
  const rig = harness(() => DEFAULT_CONFIG);
  const call = rig.startRequest();
  call.resolve({ content: [], stopReason: "error" });
  await flush();
  assert.equal(rig.controller.status.lastOutcome, "error");
  assert.equal(rig.name(), undefined);
});
