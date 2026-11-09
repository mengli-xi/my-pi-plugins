import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ModelSelectorComponent,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import claudeStyleExtension, { teardownLifecycleForEvent } from "../src/bootstrap.ts";
import { PROVIDER_ACTIVITY_CHANNEL } from "pi-runtime-contracts/provider-activity-v1";
import { ConfigService } from "../src/config/service.ts";
import { LifecycleManager } from "../src/lifecycle.ts";
import {
  MODEL_CAPACITY_READY_CHANNEL,
  MODEL_CAPACITY_SNAPSHOT_CHANNEL,
  PROCESSES_STATUS_SNAPSHOT_CHANNEL,
  STATUS_LINE_REFRESH_CHANNEL,
  STATUS_LINE_ROW_CHANNEL,
} from "../src/integration-contracts.ts";

const SHUTDOWN_REASONS = {
  quit: true,
  reload: true,
  new: true,
  resume: true,
  fork: true,
} satisfies Record<SessionShutdownEvent["reason"], true>;

const shutdownReasons = Object.keys(SHUTDOWN_REASONS) as SessionShutdownEvent["reason"][];

test("every session shutdown retires the current runtime", async (t) => {
  for (const reason of shutdownReasons) {
    await t.test(reason, async () => {
      const lifecycle = new LifecycleManager();
      let disposed = 0;
      lifecycle.install({
        id: "prototype-patches",
        install: () => ({ dispose: () => { disposed++; } }),
        health: () => ({ status: "ok" }),
      }, undefined);

      await teardownLifecycleForEvent(lifecycle, { reason });

      assert.deepEqual(lifecycle.activeIds, []);
      assert.equal(lifecycle.isClosed, true);
      assert.equal(disposed, 1);
    });
  }
});

test("a replacement runtime does not share lifecycle resources with the old one", async () => {
  let liveResources = 0;
  const createRuntime = () => {
    const lifecycle = new LifecycleManager();
    lifecycle.install({
      id: "prototype-patches",
      install: () => {
        liveResources++;
        return { dispose: () => { liveResources--; } };
      },
      health: () => ({ status: "ok" }),
    }, undefined);
    return lifecycle;
  };

  const first = createRuntime();
  assert.equal(liveResources, 1);
  await teardownLifecycleForEvent(first, { reason: "resume" });
  assert.equal(liveResources, 0);

  const second = createRuntime();
  assert.equal(liveResources, 1, "the replacement owns exactly one resource");
  await teardownLifecycleForEvent(second, { reason: "quit" });
  assert.equal(liveResources, 0);
});

class Lines {
  readonly lines: string[];
  constructor(lines: string[]) { this.lines = lines; }
  render(): string[] { return this.lines; }
  invalidate(): void {}
}

class Box {
  children: Array<{ render(width: number): string[]; invalidate(): void }> = [];
  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }
}

class RuntimeTui extends Box {
  terminal = { rows: 24, columns: 80, write: (_data: string) => {} };
  renderRequests = 0;
  requestRender(): void { this.renderRequests++; }
  hasOverlay(): boolean { return false; }
}

interface RuntimeCounters {
  timers: Set<ReturnType<typeof setTimeout>>;
  subscriptions: number;
  subscriptionChannels: Map<string, number>;
  terminalInputs: number;
}

interface RuntimeHarness {
  api: unknown;
  commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> | void }>;
  sent: Array<{ content?: unknown }>;
  emit(type: string, event: unknown): Promise<void>;
  invalidate(): void;
}

function trackTimers(t: TestContext) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;

  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    let timer: ReturnType<typeof setTimeout>;
    timer = realSetTimeout((...values: unknown[]) => {
      timers.delete(timer);
      handler(...values);
    }, delay, ...args);
    timers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.setInterval = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = realSetInterval(handler, delay, ...args) as ReturnType<typeof setTimeout>;
    timers.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer);
    realClearTimeout(timer);
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    timers.delete(timer as ReturnType<typeof setTimeout>);
    realClearInterval(timer);
  }) as typeof clearInterval;

  t.after(() => {
    for (const timer of timers) realClearTimeout(timer);
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.clearInterval = realClearInterval;
  });
  return timers;
}

function makeRuntimeHarness(
  cwd: string,
  tui: RuntimeTui,
  widgetAbove: Box,
  counters: RuntimeCounters,
  buildContextEntries: () => unknown[] = () => [],
): RuntimeHarness {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const busHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> | void }>();
  const sent: Array<{ content?: unknown }> = [];
  const widgets = new Map<string, unknown>();
  const inputDisposers = new Set<() => void>();

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd,
    model: undefined,
    thinkingLevel: "off",
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionId: () => "factory-cycle",
      getSessionFile: () => join(cwd, "session.jsonl"),
      getBranch: () => [],
      buildContextEntries,
    },
    ui: {
      theme: { fg: (_tone: string, text: string) => text },
      setWidget(key: string, content: unknown) {
        const previous = widgets.get(key) as { component?: unknown } | undefined;
        if (previous?.component) {
          widgetAbove.children = widgetAbove.children.filter((child) => child !== previous.component);
        }
        if (content === undefined) {
          widgets.delete(key);
          return;
        }
        let component: unknown;
        if (typeof content === "function") component = content(tui, this.theme);
        widgets.set(key, { content, component });
        if (component && typeof (component as { render?: unknown }).render === "function") {
          widgetAbove.children.push(component as never);
        }
      },
      onTerminalInput() {
        counters.terminalInputs++;
        let active = true;
        const dispose = () => {
          if (!active) return;
          active = false;
          counters.terminalInputs--;
          inputDisposers.delete(dispose);
        };
        inputDisposers.add(dispose);
        return dispose;
      },
      setFooter() {},
      setStatus() {},
      setHiddenThinkingLabel() {},
      notify() {},
    },
  };

  return {
    api: {
      on(type: string, handler: (event: unknown, context: unknown) => unknown) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      events: {
        on(channel: string, handler: (payload: unknown) => void) {
          const list = busHandlers.get(channel) ?? new Set();
          list.add(handler);
          busHandlers.set(channel, list);
          counters.subscriptions++;
          counters.subscriptionChannels.set(channel, (counters.subscriptionChannels.get(channel) ?? 0) + 1);
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            list.delete(handler);
            counters.subscriptions--;
            const remaining = (counters.subscriptionChannels.get(channel) ?? 1) - 1;
            if (remaining > 0) counters.subscriptionChannels.set(channel, remaining);
            else counters.subscriptionChannels.delete(channel);
          };
        },
        emit(channel: string, payload: unknown) {
          for (const handler of busHandlers.get(channel) ?? []) handler(payload);
        },
      },
      getSessionName() { return undefined; },
      registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> | void }) {
        commands.set(name, command);
      },
      registerShortcut() {},
      registerMarkdownTransformer() {},
      registerEntryRenderer() {},
      registerMessageRenderer() {},
      registerTool() {},
      registerToolRenderer() {},
      appendEntry() {},
      sendMessage(message: { content?: unknown }) { sent.push(message); },
    },
    commands,
    sent,
    async emit(type, event) {
      for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
    },
    invalidate() {
      for (const dispose of [...inputDisposers]) dispose();
      widgetAbove.children = [];
      widgets.clear();
      for (const list of busHandlers.values()) {
        counters.subscriptions -= list.size;
        list.clear();
      }
      counters.subscriptionChannels.clear();
      handlers.clear();
    },
  };
}

test("session tree reprojects transcript state while a cancellable switch preserves it", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "cc-style-tree-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const service = new ConfigService({ agentDir, env: {} });
  service.set("features.transcript", true);
  const counters: RuntimeCounters = {
    timers: trackTimers(t),
    subscriptions: 0,
    subscriptionChannels: new Map(),
    terminalInputs: 0,
  };
  const tui = new RuntimeTui();
  const widgetAbove = new Box();
  tui.children.push(new Box(), new Box(), new Box(), new Box(), new Box(), widgetAbove);
  const assistant = (id: string, toolName: string) => ({
    type: "message",
    id: `entry-${id}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
      stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      timestamp: 1_000,
      api: "anthropic-messages",
      provider: "test",
      model: "model",
    },
  });
  let entries: unknown[] = [assistant("read-branch", "read")];
  const runtime = makeRuntimeHarness(agentDir, tui, widgetAbove, counters, () => entries);
  await claudeStyleExtension(runtime.api as never);
  try {
    await runtime.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(counters.subscriptionChannels.get(PROVIDER_ACTIVITY_CHANNEL), 1,
      "transcript owns one provider-neutral observation subscription");
    const command = runtime.commands.get("tool-transcript")!;
    const print = { hasUI: false, mode: "print" };

    await command.handler("", print);
    assert.match(String(runtime.sent.at(-1)?.content), /read/u);
    await runtime.emit("session_before_switch", { type: "session_before_switch", reason: "resume" });
    await command.handler("", print);
    assert.match(String(runtime.sent.at(-1)?.content), /read/u, "a cancelled switch keeps the active projection");

    entries = [assistant("bash-branch", "bash")];
    await runtime.emit("session_tree", {
      type: "session_tree",
      oldLeafId: "read-branch",
      newLeafId: "bash-branch",
    });
    await command.handler("", print);
    const projected = String(runtime.sent.at(-1)?.content);
    assert.match(projected, /bash/u);
    assert.doesNotMatch(projected, /read/u);
  } finally {
    await runtime.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    assert.equal(counters.subscriptionChannels.has(PROVIDER_ACTIVITY_CHANNEL), false);
    runtime.invalidate();
  }
});

test("the real extension factory releases core-owned resources across replacements", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "cc-style-runtime-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const service = new ConfigService({ agentDir, env: {} });
  service.set("features.transcript", false);

  const timers = trackTimers(t);
  const counters: RuntimeCounters = { timers, subscriptions: 0, subscriptionChannels: new Map(), terminalInputs: 0 };
  const tui = new RuntimeTui();
  const chat = new Box();
  for (let index = 0; index < 100; index++) chat.children.push(new Lines([`chat-${index}`]));
  const widgetAbove = new Box();
  tui.children.push(new Box(), new Box(), chat, new Box(), new Box(), widgetAbove, new Box(), new Box(), new Box());
  const originalFilter = (ModelSelectorComponent.prototype as any).filterModels;

  const replacementReasons: SessionShutdownEvent["reason"][] = ["new", "resume", "fork", "reload"];
  for (const reason of [...replacementReasons, "quit" as const]) {
    const runtime = makeRuntimeHarness(agentDir, tui, widgetAbove, counters);
    await claudeStyleExtension(runtime.api as never);
    await runtime.emit("session_start", { type: "session_start", reason });

    const expectedChannels = [
      MODEL_CAPACITY_READY_CHANNEL,
      MODEL_CAPACITY_SNAPSHOT_CHANNEL,
      PROCESSES_STATUS_SNAPSHOT_CHANNEL,
      STATUS_LINE_REFRESH_CHANNEL,
      STATUS_LINE_ROW_CHANNEL,
    ].sort();
    assert.equal(counters.subscriptions, expectedChannels.length, `${reason}: one runtime owns each domain subscription`);
    assert.deepEqual(
      [...counters.subscriptionChannels.keys()].sort(),
      expectedChannels,
      `${reason}: subscriptions stay on their declared domain channels`,
    );
    assert.equal(counters.terminalInputs, 0, `${reason}: CC core no longer owns layout input`);
    assert.equal(
      timers.size,
      2,
      `${reason}: one pending statusline refresh and one session clock`,
    );
    assert.notEqual((ModelSelectorComponent.prototype as any).filterModels, originalFilter);
    assert.equal(Object.hasOwn(tui, "render"), false, `${reason}: CC core does not wrap TUI.render`);

    const command = runtime.commands.get("cc-style")!;
    await command.handler("status", { hasUI: false });
    assert.match(
      String(runtime.sent.at(-1)?.content),
      /lifecycle features: observability, ui-scheduler, fullscreen-host, editor-chrome, statusline, model-capacity-client, processes-status-consumer, model-capacity-status-consumer, model-selector-tabs, internals-monitor/,
    );

    await runtime.emit("session_shutdown", { type: "session_shutdown", reason });
    await command.handler("status", { hasUI: false });
    assert.match(String(runtime.sent.at(-1)?.content), /lifecycle features: none/);
    assert.equal(counters.subscriptionChannels.get(MODEL_CAPACITY_READY_CHANNEL) ?? 0, 0,
      `${reason}: capacity owner-ready lease released before the host invalidates its bus`);
    assert.equal(timers.size, 0, `${reason}: timers released`);
    assert.equal(counters.terminalInputs, 0, `${reason}: terminal input released`);
    assert.equal((ModelSelectorComponent.prototype as any).filterModels, originalFilter);

    runtime.invalidate(); // Pi invalidates the runtime-owned event bus and widgets next.
    assert.equal(counters.subscriptions, 0, `${reason}: runtime bus released`);
    assert.equal(widgetAbove.children.length, 0, `${reason}: extension widgets reset`);

    assert.equal(Object.hasOwn(tui, "render"), false, `${reason}: shutdown leaves TUI ownership external`);
  }
});
