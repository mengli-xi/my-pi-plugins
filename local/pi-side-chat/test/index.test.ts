import assert from "node:assert/strict";
import test from "node:test";
import sideChatExtension, { parseAction, parseBtwAction } from "../index.ts";

test("/side action parsing exposes only open and permanent destroy", () => {
  assert.equal(parseAction(""), "open");
  assert.equal(parseAction("DESTROY"), "destroy");
});

test("/side action parsing rejects retired and unknown lifecycle verbs", () => {
  for (const value of ["overlay", "handoff", "close"]) {
    assert.throws(() => parseAction(value), /Usage: \/side \[destroy\]/u);
  }
});

test("/side completion exposes canonical grammar for empty, partial and unknown prefixes", async () => {
  const commands = new Map<string, { getArgumentCompletions(prefix: string): Array<{ value: string }> | null }>();
  await sideChatExtension({ on() {}, registerCommand(name: string, command: never) { commands.set(name, command); }, registerShortcut() {} } as never);
  const complete = commands.get("side")!.getArgumentCompletions;
  assert.deepEqual(complete("")?.map(item => item.value), ["destroy"]);
  assert.deepEqual(complete("de")?.map(item => item.value), ["destroy"]);
  assert.deepEqual(complete("unknown"), []);
});

test("/btw parser distinguishes the finite cancel action from free-text questions", () => {
  assert.deepEqual(parseBtwAction("  "), { kind: "open" });
  assert.deepEqual(parseBtwAction(" CANCEL "), { kind: "cancel" });
  assert.deepEqual(parseBtwAction("cancel this question?"), { kind: "ask", question: "cancel this question?" });
});

test("/btw completion exposes cancel for empty and partial prefixes, but not unknown input", async () => {
  const commands = new Map<string, { getArgumentCompletions(prefix: string): Array<{ value: string }> | null }>();
  await sideChatExtension({ on() {}, registerCommand(name: string, command: never) { commands.set(name, command); }, registerShortcut() {} } as never);
  const complete = commands.get("btw")!.getArgumentCompletions;
  assert.deepEqual(complete("")?.map(item => item.value), ["cancel"]);
  assert.deepEqual(complete("CA")?.map(item => item.value), ["cancel"]);
  assert.deepEqual(complete("unknown"), []);
});

test("invalid config keeps the factory alive and blocks every Side entry before runtime setup", async (t) => {
  const previous = process.env.PI_SIDE_BACKEND;
  process.env.PI_SIDE_BACKEND = "sdk";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SIDE_BACKEND;
    else process.env.PI_SIDE_BACKEND = previous;
  });
  const events = new Map<string, (event: unknown, ctx: never) => void>();
  const commands = new Map<string, {
    handler(args: string, ctx: never): Promise<void>;
    getArgumentCompletions(prefix: string): Array<{ value: string }>;
  }>();
  let shortcut!: (ctx: never) => Promise<void>;
  await sideChatExtension({
    on(name: string, handler: never) { events.set(name, handler); },
    registerCommand(name: string, command: never) { commands.set(name, command); },
    registerShortcut(_key: string, definition: { handler: typeof shortcut }) { shortcut = definition.handler; },
  } as never);
  assert.deepEqual([...events.keys()], ["session_start"], "Side capture and lifecycle hooks must not be installed");
  const notices: Array<{ message: string; type: string }> = [];
  const ctx = { mode: "tui", ui: { notify(message: string, type: string) { notices.push({ message, type }); } } } as never;
  events.get("session_start")!({}, ctx);
  events.get("session_start")!({}, ctx);
  assert.equal(notices.length, 1, "startup diagnostic is shown once");
  for (const [name, candidates] of [["side", ["destroy"]], ["btw", ["cancel"]]] as const) {
    const command = commands.get(name)!;
    assert.deepEqual(command.getArgumentCompletions("").map(item => item.value), candidates);
    assert.deepEqual(command.getArgumentCompletions(candidates[0].slice(0, 2)).map(item => item.value), candidates);
    assert.deepEqual(command.getArgumentCompletions("unknown"), []);
    for (const args of ["", candidates[0], "question"]) await command.handler(args, ctx);
  }
  await shortcut(ctx);
  assert.equal(notices.length, 8);
  assert.ok(notices.every(notice => notice.type === "error" && notice.message === notices[0].message));
  assert.match(notices[0].message, /请移除环境变量 PI_SIDE_BACKEND 后重启 pi/);
});
