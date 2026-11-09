import { installMailboxBindingStub } from "../fixtures/mailbox-binding-stub.ts";
installMailboxBindingStub();
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Check } from "typebox/value";
import { getProcessHost } from "../../src/host/registry.ts";

/**
 * 隔离 startup scavenging：dist/index.js 的一次性清理只扫本文件自己的 temp base，不碰机器上的历史 root。
 * 用标准 TMPDIR 隔离——node --test 每个测试文件是独立子进程，os.tmpdir() 每次调用都读 TMPDIR，
 * 本文件真实启动的 Supervisor 造 root 也落在同一个 base 里。
 */
const scavengeBase = mkdtempSync(join(tmpdir(), "pi-processes-scavenge-lifecycle-"));
process.env.TMPDIR = scavengeBase;
process.env.PI_CODING_AGENT_DIR = join(scavengeBase, "agent");
after(() => { rmSync(scavengeBase, { recursive: true, force: true }); });

interface RegisteredTool {
  parameters: Parameters<typeof Check>[0];
  prepareArguments?(args: unknown): unknown;
  execute(toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: () => void, context: { cwd: string }): Promise<{ content: unknown[]; details: unknown }>;
}

interface RegisteredCommand {
  handler(args: string, context: any): Promise<void> | void;
}

interface CustomMount {
  component: { render(width: number): string[]; handleInput?(data: string): void };
  close(): void;
}

interface FakeRuntime {
  handlers: Map<string, Array<(event: any, context: any) => unknown>>;
  eventHandlers: Map<string, Array<(value: unknown) => void>>;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, unknown>;
  widgets: Map<string, unknown>;
  messages: unknown[];
  messageOptions: unknown[];
  entries: Array<{ customType: string; data: unknown }>;
  sessionEntries: Array<Record<string, unknown>>;
  notifications: string[];
  customMounts: CustomMount[];
  deferredMessages: Array<Record<string, unknown>>;
  idle: boolean;
  api: any;
}

function createRuntime(runtimeOptions: { deferTurnMessages?: boolean } = {}): FakeRuntime {
  const handlers = new Map<string, Array<(event: any, context: any) => unknown>>();
  const eventHandlers = new Map<string, Array<(value: unknown) => void>>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, unknown>();
  const widgets = new Map<string, unknown>();
  const messages: unknown[] = [];
  const messageOptions: unknown[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const sessionEntries: Array<Record<string, unknown>> = [];
  const notifications: string[] = [];
  const customMounts: CustomMount[] = [];
  const deferredMessages: Array<Record<string, unknown>> = [];
  const api = {
    on(name: string, handler: (event: any, context: any) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    events: {
      on(name: string, handler: (value: unknown) => void) {
        const current = eventHandlers.get(name) ?? [];
        current.push(handler);
        eventHandlers.set(name, current);
        return () => {
          const next = (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler);
          if (next.length === 0) eventHandlers.delete(name);
          else eventHandlers.set(name, next);
        };
      },
      emit(name: string, value: unknown) {
        for (const handler of eventHandlers.get(name) ?? []) handler(value);
      },
    },
    registerTool(tool: RegisteredTool & { name: string }) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
      sessionEntries.push({ type: "custom", id: crypto.randomUUID(), customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push(message);
      messageOptions.push(options);
      const delivery = options as { triggerTurn?: boolean; deliverAs?: string } | undefined;
      const custom = message as { customType?: string; content?: unknown; display?: boolean; details?: unknown };
      if (delivery?.triggerTurn === false && typeof custom.customType === "string") {
        const entry = { type: "custom_message", id: crypto.randomUUID(), customType: custom.customType, content: custom.content, display: custom.display, details: custom.details };
        if (runtimeOptions.deferTurnMessages) deferredMessages.push(entry);
        else sessionEntries.push(entry);
      }
    },
  };
  return { handlers, eventHandlers, tools, commands, widgets, messages, messageOptions, entries, sessionEntries, notifications, customMounts, deferredMessages, idle: true, api };
}

/** Minimal editor-slot TUI so `/ps` can mount and render its real manager component. */
function overlayTui() {
  const coreEditor = {
    getText: () => "draft",
    setText() {},
    handleInput() {},
    render: () => ["editor"],
    invalidate() {},
  };
  return {
    terminal: { rows: 24, columns: 80, write: () => {} },
    children: [
      { render: () => ["transcript"], invalidate() {} },
      { children: [coreEditor], render: () => coreEditor.render(), invalidate() {} },
      { render: () => ["statusline"], invalidate() {} },
    ],
    requestRender() {},
  };
}

async function emit(runtime: FakeRuntime, name: string, event: unknown, context?: unknown): Promise<unknown[]> {
  if (name === "agent_start" || name === "turn_start") runtime.idle = false;
  if (name === "agent_settled") runtime.idle = true;
  const results: unknown[] = [];
  for (const handler of runtime.handlers.get(name) ?? []) results.push(await handler(event, context));
  if (name === "turn_end" && runtime.deferredMessages.length > 0) {
    runtime.sessionEntries.push(...runtime.deferredMessages.splice(0));
  }
  return results;
}

function sessionContext(sessionId: string, cwd: string, runtime: FakeRuntime): any {
  let editorFactory: unknown;
  let editorText = "draft";
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => runtime.idle,
    signal: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => runtime.sessionEntries.at(-1)?.id ?? null,
      getBranch: () => runtime.sessionEntries,
      getEntries: () => runtime.sessionEntries,
      getLeafEntry: () => runtime.sessionEntries.at(-1),
    },
    ui: {
      notify: (message: string) => runtime.notifications.push(message),
      setWidget: (key: string, value: unknown) => value === undefined ? runtime.widgets.delete(key) : runtime.widgets.set(key, value),
      getEditorComponent: () => editorFactory,
      setEditorComponent: (value: unknown) => { editorFactory = value; },
      getEditorText: () => editorText,
      setEditorText: (value: string) => { editorText = value; },
      custom(factory: (...args: any[]) => any, _options?: unknown) {
        return new Promise<void>((resolve) => {
          const done = (): void => resolve();
          const component = factory(overlayTui(), { borderColor: () => "", selectList: {}, editor: {} }, { matches: () => false, getKeybindings: () => [] }, done);
          runtime.customMounts.push({ component, close: done });
        });
      },
      theme: {
        fg: (_name: string, text: string) => text,
        bg: (_name: string, text: string) => text,
        bold: (text: string) => text,
        inverse: (text: string) => text,
      },
    },
  };
}

function processData(result: { details: unknown }): { process: { id: string; pid?: number } } {
  return (result.details as { data: { process: { id: string; pid?: number } } }).data;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForValue<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("compiled extension never starts an empty supervisor on session replacement", async () => {
  const extensionUrl = new URL("../../dist/index.js", import.meta.url).href;
  const extension = (await import(extensionUrl)).default as (api: any) => void;
  const runtime = createRuntime();
  extension(runtime.api);
  const context = sessionContext(`integration-empty-${crypto.randomUUID()}`, process.cwd(), runtime);

  await emit(runtime, "session_start", { reason: "startup" }, context);
  assert.equal(getProcessHost(context.sessionManager.getSessionId())?.supervisorPid, undefined);
  assert.ok(runtime.tools.has("process"));
  assert.ok(runtime.commands.has("ps"));
  const startedAt = Date.now();
  await emit(runtime, "session_shutdown", { reason: "new" }, context);

  assert.ok(Date.now() - startedAt < 5_000, "empty supervisor cleanup stays within the session-replacement budget");
  assert.equal(runtime.notifications.some((message) => message.includes("cleanup")), false);
});

test("compiled extension replaces a disposed host after supervisor loss", async (t) => {
  let cleanupRuntime: FakeRuntime | undefined;
  let cleanupContext: unknown;
  t.after(async () => {
    if (!cleanupRuntime) return;
    await emit(cleanupRuntime, "session_shutdown", { reason: "quit" }, cleanupContext).catch(() => {});
  });

  const extensionUrl = new URL("../../dist/index.js", import.meta.url).href;
  const extension = (await import(extensionUrl)).default as (api: any) => void;
  const runtime = createRuntime();
  extension(runtime.api);
  const cwd = process.cwd();
  const context = sessionContext(`integration-recovery-${crypto.randomUUID()}`, cwd, runtime);
  cleanupRuntime = runtime;
  cleanupContext = context;
  await emit(runtime, "session_start", { reason: "startup" }, context);
  await emit(runtime, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, context);

  const tool = runtime.tools.get("process")!;
  const started = await tool.execute(
    "tool-before-loss",
    { action: "start", name: "before-loss", command: "sleep 300" },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const managed = processData(started).process;
  assert.equal(typeof managed.pid, "number");
  const supervisorPid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(managed.pid)], { encoding: "utf8" }).trim());
  assert.ok(Number.isSafeInteger(supervisorPid) && supervisorPid > 0);
  process.kill(supervisorPid, "SIGKILL");

  await waitFor(() => runtime.notifications.some((message) => message.includes("channel lost")), "supervisor channel loss", 10_000);
  await waitFor(() => {
    try { process.kill(managed.pid!, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }, "managed process containment", 10_000);

  const listed = await tool.execute(
    "tool-recover-list",
    { action: "list" },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  assert.deepEqual((listed.details as { data: { items: unknown[] } }).data.items, []);

  const recovered = await tool.execute(
    "tool-after-loss",
    { action: "start", name: "after-loss", command: "printf 'recovered\\n'" },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const replacement = processData(recovered).process;
  assert.notEqual(replacement.id, managed.id);
  await waitFor(() => runtime.entries.some((entry) => (entry.data as { kind?: string; process?: { id?: string } }).kind === "terminal" && (entry.data as any).process?.id === replacement.id), "replacement terminal TUI entry", 10_000);
  await emit(runtime, "turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
  await waitFor(() => runtime.sessionEntries.some(entry => entry.customType === "process-notification-intent-v1" && (entry.data as any)?.mail?.messages?.[0]?.details?.items?.some((item: any) => item.processId === replacement.id)), "replacement terminal source intent", 10_000);

  await emit(runtime, "session_shutdown", { reason: "quit" }, context);
  cleanupRuntime = undefined;
  cleanupContext = undefined;
});

test("compiled extension reports contained processes as terminal to /ps opened before any recovery call", async (t) => {
  let cleanupRuntime: FakeRuntime | undefined;
  let cleanupContext: unknown;
  const scratch = mkdtempSync(join(tmpdir(), "pi-processes-containment-"));
  const marker = join(scratch, "original-runs");
  t.after(async () => {
    if (cleanupRuntime) await emit(cleanupRuntime, "session_shutdown", { reason: "quit" }, cleanupContext).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  });

  const extension = (await import(new URL("../../dist/index.js", import.meta.url).href)).default as (api: any) => void;
  const runtime = createRuntime();
  extension(runtime.api);
  const cwd = process.cwd();
  const sessionId = `integration-containment-${crypto.randomUUID()}`;
  const context = sessionContext(sessionId, cwd, runtime);
  cleanupRuntime = runtime;
  cleanupContext = context;
  const snapshots: Array<{ processes: Array<{ id: string }> }> = [];
  runtime.api.events.on("statusline:processes-snapshot-v2", (value: unknown) => { snapshots.push(value as { processes: Array<{ id: string }> }); });

  await emit(runtime, "session_start", { reason: "startup" }, context);
  await emit(runtime, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, context);

  const tool = runtime.tools.get("process")!;
  const started = await tool.execute(
    "tool-contained-start",
    { action: "start", name: "fault-recovery", command: `printf 'ORIGINAL\\n' >> ${JSON.stringify(marker)}; sleep 30` },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const managed = processData(started).process;
  const originalRuns = (): number => {
    try { return readFileSync(marker, "utf8").split("\n").filter((line) => line === "ORIGINAL").length; }
    catch { return 0; }
  };
  await waitFor(() => originalRuns() === 1, "original command first execution", 10_000);

  const supervisorPid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(managed.pid)], { encoding: "utf8" }).trim());
  assert.ok(Number.isSafeInteger(supervisorPid) && supervisorPid > 0);
  process.kill(supervisorPid, "SIGKILL");

  await waitFor(() => runtime.notifications.some((message) => message.includes("channel lost")), "supervisor channel loss", 10_000);
  await waitFor(() => runtime.notifications.some((message) => message.includes("runtime containment completed")), "runtime containment", 15_000);
  await waitFor(() => {
    try { process.kill(managed.pid!, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }, "managed process containment", 10_000);

  // /ps opens before any process tool call, so it must not present the dead record as live.
  const psCommand = runtime.commands.get("ps") as RegisteredCommand;
  await psCommand.handler("", context);
  await waitFor(() => runtime.customMounts.length > 0, "first-use process manager");
  const mounted = runtime.customMounts.at(-1);
  assert.ok(mounted, "/ps mounted a manager after containment");
  // One short-named record leaves the shared status column enough width at 80
  // columns, so the list spells the cause rather than falling back to `crashed`.
  const listView = mounted.component.render(80).join("\n");
  assert.match(listView, /fault-recovery/);
  assert.match(listView, /crashed/, "contained record must carry a terminal state");
  assert.match(listView, /crashed · runtime-contained/, "at this width the status column can spell the cause");
  assert.doesNotMatch(listView, /\brunning\b/, "contained record must not still claim it is running");

  // Entering the detail must not be blocked by the one request that needs a Supervisor.
  (mounted.component as { focused?: boolean }).focused = true;
  mounted.component.handleInput?.("\r");
  await waitFor(() => mounted.component.render(80).join("\n").includes("Logs unavailable"), "contained process detail", 5_000);
  const detailView = mounted.component.render(80).join("\n");
  assert.match(detailView, /── fault-recovery · process ─+/);
  assert.match(detailView, /Status: crashed · runtime-contained/);
  assert.match(detailView, /Scripts: printf 'ORIGINAL/, "the full command stays readable without the supervisor");
  assert.match(detailView, /Cause: runtime-contained · supervisor channel lost/);
  assert.match(detailView, /Logs unavailable: runtime contained; the supervisor is gone\./);
  assert.doesNotMatch(detailView, /\[process\/supervisor-unavailable\]/, "a failed log request must not replace the detail");

  mounted.close();
  await Promise.resolve();

  // The same state provider feeds the statusline snapshot; it must lose the dead process too.
  runtime.api.events.emit("processes:snapshot-request-v2", { version: 2, requestId: crypto.randomUUID(), sessionScopeId: sessionId, source: "statusline" });
  assert.deepEqual(snapshots.at(-1)?.processes, [], "statusline snapshot must not keep a contained process live");

  // The first ordinary input after containment must not report the disposed broker.
  const beforeInput = runtime.notifications.length;
  await emit(runtime, "input", { type: "input", text: "ping", source: "interactive" }, context);
  await emit(runtime, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "ping", systemPrompt: "", systemPromptOptions: {} }, context);
  assert.deepEqual(runtime.notifications.slice(beforeInput), [], "stale coordinators must stay quiet on a contained runtime");

  // An explicit process call still recovers into a fresh generation without re-running the command.
  const recovered = await tool.execute(
    "tool-contained-recover",
    { action: "start", name: "after-contained", command: "printf 'recovered\\n'" },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const replacement = processData(recovered).process;
  assert.notEqual(replacement.id, managed.id);
  const listed = await tool.execute("tool-contained-list", { action: "list" }, new AbortController().signal, () => {}, { cwd });
  const items = (listed.details as { data: { items: Array<{ id: string }> } }).data.items;
  assert.equal(items.some((item) => item.id === managed.id), false, "recovery starts an empty generation");
  assert.equal(originalRuns(), 1, "the contained command must never run a second time");

  await emit(runtime, "session_shutdown", { reason: "quit" }, context);
  cleanupRuntime = undefined;
  cleanupContext = undefined;
});

test("compiled extension registers one process tool and preserves a live process across reload", async (t) => {
  let cleanupRuntime: FakeRuntime | undefined;
  let cleanupContext: unknown;
  t.after(async () => {
    if (!cleanupRuntime) return;
    await emit(cleanupRuntime, "session_shutdown", { reason: "quit" }, cleanupContext).catch(() => {});
  });

  const extensionUrl = new URL("../../dist/index.js", import.meta.url).href;
  const extension = (await import(extensionUrl)).default as (api: any) => void;
  const sessionId = `integration-${crypto.randomUUID()}`;
  const cwd = process.cwd();
  const first = createRuntime();
  extension(first.api);
  assert.deepEqual([...first.tools.keys()], ["process"]);
  assert.deepEqual([...first.commands.keys()], ["ps"]);
  const registeredProcessTool = first.tools.get("process")!;
  assert.equal(Check(registeredProcessTool.parameters, { action: "logs", target: "reload-live", tailLines: 10 }), true);
  assert.equal(Check(registeredProcessTool.parameters, { action: "logs", target: { name: "reload-live" }, tailLines: 10 }), false);
  const firstContext = sessionContext(sessionId, cwd, first);
  await emit(first, "session_start", { reason: "startup" }, firstContext);
  await emit(first, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, firstContext);
  cleanupRuntime = first;
  cleanupContext = firstContext;
  assert.equal(first.widgets.has("pi-processes:strip"), true);

  const started = await first.tools.get("process")!.execute(
    "tool-start",
    {
      action: "start",
      name: "reload-live",
      command: "printf 'ready\\n'; while :; do sleep 1; done",
      watches: [{ key: "ready", pattern: "ready", stream: "stdout", repeat: false, attention: "turn" }],
    },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const original = processData(started).process;
  assert.equal(typeof original.pid, "number");
  await waitFor(() => first.entries.length === 1, "ready watch TUI delivery");
  await emit(first, "turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, firstContext);
  const watchIntent = first.sessionEntries.find(entry => entry.customType === "process-notification-intent-v1");
  assert.ok(watchIntent, "compiled extension hands the prepared source intent to the endpoint");
  assert.deepEqual(first.messages, [], "Processes never owns native delivery");

  await emit(first, "session_shutdown", { reason: "reload" }, firstContext);
  assert.equal(first.widgets.has("pi-processes:strip"), false);

  const second = createRuntime();
  extension(second.api);
  const secondContext = sessionContext(sessionId, cwd, second);
  await emit(second, "session_start", { reason: "reload" }, secondContext);
  assert.equal(second.messages.length, 0, "reload session_start cannot trigger model delivery before global readiness");
  await emit(second, "input", { type: "input", text: "inspect after reload", source: "interactive" }, secondContext);
  assert.equal(second.messages.length, 0, "external input activation cannot replay an old producer trigger");
  await emit(second, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "inspect after reload", systemPrompt: "", systemPromptOptions: {} }, secondContext);
  await emit(second, "agent_settled", { type: "agent_settled" }, secondContext);
  await new Promise((resolve) => setTimeout(resolve, 5));
  cleanupRuntime = second;
  cleanupContext = secondContext;
  assert.equal(second.widgets.has("pi-processes:strip"), true);
  const listed = await second.tools.get("process")!.execute(
    "tool-list",
    { action: "list", states: ["running"] },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const items = (listed.details as { data: { items: Array<{ id: string; pid?: number }> } }).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, original.id);
  assert.equal(items[0]!.pid, original.pid);

  const secondProcessTool = second.tools.get("process")!;
  const rawLogsInput = { action: "logs", target: original.id, tailLines: 10 };
  const preparedLogsInput = secondProcessTool.prepareArguments?.(rawLogsInput) ?? rawLogsInput;
  assert.equal(Object.hasOwn(preparedLogsInput as object, "mode"), false);
  const logs = await secondProcessTool.execute(
    "tool-logs",
    preparedLogsInput,
    new AbortController().signal,
    () => {},
    { cwd },
  );
  assert.equal((logs.details as { action: string }).action, "logs");
  const logLines = (logs.details as { data: { lines: Array<{ text: string }> } }).data.lines;
  assert.deepEqual(logLines.map((line) => line.text), ["ready"]);
  const content = logs.content as Array<{ type?: string; text?: string }>;
  assert.equal(content[0]?.type, "text");
  assert.equal(content[0]?.text, "Read 1 process log line\n[stdout] ready");

  await secondProcessTool.execute(
    "tool-stop",
    { action: "stop", target: "reload-live" },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const terminalList = await waitForValue(
    () => secondProcessTool.execute("tool-terminal-list", { action: "list" }, new AbortController().signal, () => {}, { cwd }),
    (result) => (result.details as { data: { items: Array<{ id: string; state: string }> } }).data.items.some((item) => item.id === original.id && item.state === "stopped"),
    "terminal state",
    10_000,
  );
  const terminalItems = (terminalList.details as { data: { items: Array<{ id: string; state: string }> } }).data.items;
  assert.equal(terminalItems.find((item) => item.id === original.id)?.state, "stopped");
  assert.equal(second.messages.some((message) => (message as { customType?: string; details?: { kind?: string } }).customType === "process-event-v2" && (message as any).details?.kind === "terminal"), false);
  await emit(second, "input", { type: "input", text: "inspect stop", source: "interactive" }, secondContext);
  const terminalStarts = await emit(second, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "inspect stop", systemPrompt: "", systemPromptOptions: {} }, secondContext);

  const terminalLogs = await secondProcessTool.execute(
    "tool-terminal-logs",
    { action: "logs", target: "reload-live", tailLines: 10 },
    new AbortController().signal,
    () => {},
    { cwd },
  );
  const terminalLogLines = (terminalLogs.details as { data: { lines: Array<{ text: string }> } }).data.lines;
  assert.deepEqual(terminalLogLines.map((line) => line.text), ["ready"]);
  const terminalContent = terminalLogs.content as Array<{ type?: string; text?: string }>;
  assert.equal(terminalContent[0]?.text, "Read 1 process log line\n[stdout] ready");

  await emit(second, "session_shutdown", { reason: "quit" }, secondContext);
  cleanupRuntime = undefined;
  cleanupContext = undefined;
  assert.throws(() => process.kill(original.pid!, 0));
});
