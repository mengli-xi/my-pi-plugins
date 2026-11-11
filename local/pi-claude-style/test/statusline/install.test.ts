import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import { click as clickAt } from "../native-mouse.ts";
import installStatusLine, { compactHome } from "../../src/statusline/install.ts";
import { MAIN_INITIAL_LINES } from "../../src/statusline/initial-lines.ts";
import { renderTodoStatusLine, TodoSnapshot, TodoWidget, toggleTodoView } from "../../src/todo-state.ts";

const UI_KEY = "pi-statusline";
const SESSION_ID = `pi-claude-style-statusline-test-${process.pid}`;
const TRANSCRIPT = join(homedir(), ".pi", "agent", "statusline-transcripts", `${SESSION_ID}.jsonl`);

/**
 * A statusline command that fails its first `failures` runs and then succeeds,
 * printing which run it is on so one frame can be told from the next.
 */
function assistantUsageEntry(
  id: string,
  usage: { input: number; cacheRead: number; cacheWrite: number },
  timestamp: number,
) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      stopReason: "stop",
      provider: "test",
      model: "test-model",
      timestamp,
      usage: { ...usage, output: 1, totalTokens: 1, cost: {} },
    },
  };
}

// These UI fixtures only need stdin draining and a counter. Shell builtins
// avoid two extra cat processes per refresh. Under full-suite load those child
// starts can outlive the frame deadline even while the parent loop is responsive.
function writeFlakyCommand(dir: string, failures: number): string {
  const counter = join(dir, "runs");
  const script = join(dir, "statusline.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "while IFS= read -r line; do :; done",
      `n=0; if [ -r "${counter}" ]; then IFS= read -r n < "${counter}" || :; fi`,
      "n=$((n+1))",
      `printf '%s' "$n" > "${counter}"`,
      `[ "$n" -le ${failures} ] && exit 1`,
      "printf 'run %s\\n' \"$n\"",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(script, 0o755);
  return script;
}

function makeWorkspace(failures: number): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
  const command = writeFlakyCommand(dir, failures);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "settings.json"),
    JSON.stringify({
      statusLine: {
        type: "command",
        // The PID written by the script is then Node's direct child, not an
        // orphaned nested shell whose reaping belongs to the operating system.
        command: `exec "${command}"`,
        placement: "widget",
        widgetPlacement: "belowEditor",
        padding: 0,
        debounceMs: 10,
        timeoutMs: 5_000,
      },
    }),
    "utf8",
  );
  return dir;
}

interface Harness {
  api: unknown;
  emit(type: string, event: Record<string, unknown>): Promise<void>;
  widget(): string[] | undefined;
  clearWidgets(): void;
  eventChannels(): string[];
  emitEvent(channel: string, payload: unknown): void;
  click(row: number, column: number): boolean;
  customCalls(): number;
  modelSelectorCalls(): number;
}

function harness(cwd: string, branch: unknown[] = []): Harness {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const widgets = new Map<string, unknown>();
  const eventChannels = new Set<string>();
  const eventHandlers = new Map<string, (payload: unknown) => void>();
  let customCallCount = 0;
  let modelSelectorCallCount = 0;
  const editor = Object.create(CustomEditor.prototype) as CustomEditor;
  editor.actionHandlers = new Map([
    ["app.model.select", () => { modelSelectorCallCount++; }],
  ]);
  const tui = Object.create(TuiMainScreen.prototype) as TuiMainScreen;
  tui.getFocusedComponent = () => editor;

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd,
    model: { id: "test-model", displayName: "Test Model", provider: "test" },
    thinkingLevel: "medium",
    getContextUsage: () => ({ contextWindow: 200_000, percent: 10 }),
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getSessionFile: () => join(cwd, "session.jsonl"),
      getBranch: () => branch,
    },
    ui: {
      setWidget(key: string, content: unknown) {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
      setFooter() {},
      async custom() {
        customCallCount++;
      },
      notify() {},
    },
  };

  return {
    api: {
      on(type: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      events: {
        on(channel: string, handler: (payload: unknown) => void) {
          eventChannels.add(channel);
          eventHandlers.set(channel, handler);
          return () => eventHandlers.delete(channel);
        },
      },
    },
    async emit(type, event) {
      for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
    },
    widget() {
      const factory = widgets.get(UI_KEY) as
        | ((tui: unknown) => { render(width: number): string[] })
        | undefined;
      return factory?.(tui).render(80).map((line) => line.trimEnd());
    },
    clearWidgets() {
      widgets.clear();
    },
    eventChannels() {
      return [...eventChannels].sort();
    },
    emitEvent(channel, payload) {
      eventHandlers.get(channel)?.(payload);
    },
    click(row, column) {
      const factory = widgets.get(UI_KEY) as ((tui: unknown) => Component) | undefined;
      return clickAt(factory?.(tui), row, column);
    },
    customCalls() {
      return customCallCount;
    },
    modelSelectorCalls() {
      return modelSelectorCallCount;
    },
  };
}

/**
 * Install into a fresh workspace, and make sure the instance is shut down
 * before the workspace goes: a timer that outlives the directory it runs a
 * command in spawns into nothing and fails the *next* test instead of this one.
 */
function session(t: TestContext, cwd: string, options?: Parameters<typeof installStatusLine>[2]): Harness {
  const pi = harness(cwd);
  t.after(async () => {
    await pi.emit("session_shutdown", { reason: "quit" });
  });
  installStatusLine(pi.api as never, undefined, options);
  return pi;
}

function workspace(t: TestContext, failures: number): string {
  const cwd = makeWorkspace(failures);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

/** Poll rather than sleep a fixed span: a cold first payload build is not quick. */
async function waitForFrame(pi: Harness, expected: string[]): Promise<void> {
  // A statusline command is a fresh shell: on a busy machine its start alone can
  // take seconds, so the cap stays well above one command's own timeout.
  const until = Date.now() + 20_000;
  for (;;) {
    const frame = pi.widget();
    if (frame !== undefined && frame[0] === expected[0]) {
      assert.deepEqual(frame, expected);
      return;
    }
    if (Date.now() > until) assert.deepEqual(frame, expected, "timed out waiting for the frame");
    await delay(20);
  }
}

test.after(() => {
  rmSync(TRANSCRIPT, { force: true });
});

test("the Subagent statusline keeps read-only model and effort slots without Main contributors", async (t) => {
  const cwd = workspace(t, 0);
  const script = join(cwd, "statusline.sh");
  writeFileSync(script, ["#!/bin/sh", "while IFS= read -r line; do :; done", "printf '[[pi:slot:model]] [[pi:slot:effort]] [[pi:slot:path-short]]\\n'", ""].join("\n"), "utf8");
  const pi = session(t, cwd, { interactiveSlots: false, acceptContributions: false });
  await pi.emit("session_start", { reason: "startup" });
  const expected = `\x1b[1m\x1b[35mtest-model(test)\x1b[0m \x1b[34mmedium\x1b[0m ${basename(cwd)}`;
  await waitForFrame(pi, [expected]);
  assert.deepEqual(pi.eventChannels(), []);
  assert.equal(pi.click(0, 0), false);
  assert.equal(pi.modelSelectorCalls(), 0);
  assert.equal(pi.customCalls(), 0);
});

test("a child mounts its own read-only first frame synchronously and keeps it on command failure", async (t) => {
  const cwd = workspace(t, 999);
  const pi = session(t, cwd, {
    interactiveSlots: false, isolatedFrame: true, acceptContributions: false,
    initialLines: ["[[pi:slot:model]] [[pi:slot:effort]]"],
  });
  await pi.emit("session_start", { reason: "startup" });
  const expected = ["\x1b[1m\x1b[35mtest-model(test)\x1b[0m \x1b[34mmedium\x1b[0m"];
  assert.deepEqual(pi.widget(), expected, "mount before the command has a chance to run");
  await delay(200);
  assert.deepEqual(pi.widget(), expected, "command failure must retain the CC frame");
  assert.equal(pi.click(0, 0), false);
  assert.deepEqual(pi.eventChannels(), []);
  writeFileSync(join(cwd, "statusline.sh"), "#!/bin/sh\nwhile IFS= read -r line; do :; done\nprintf 'ready\\n'\n");
  await pi.emit("turn_end", {});
  await waitForFrame(pi, ["ready"]);
});

test("Main mounts a synchronous CC fallback and keeps live contributions when its command fails", async (t) => {
  const cwd = workspace(t, 999);
  const pi = session(t, cwd, { initialLines: MAIN_INITIAL_LINES });
  await pi.emit("session_start", { reason: "startup" });
  const first = pi.widget()!;
  assert.match(first[0]!, /test-model\(test\).*medium/);
  assert.equal(first.length, 3, "keep contributor row targets before the command succeeds");
  pi.emitEvent("statusline:row", { key: "compact", placement: "inline", row: 2, line: "CP:0", order: 10 });
  pi.emitEvent("statusline:row", { key: "memory", placement: "inline", row: 2, line: "MEM:3", order: 20 });
  assert.equal(pi.widget()![1], "CP:0 │ MEM:3");
  await delay(200);
  assert.equal(pi.widget()![0], first[0], "failure keeps CC identity");
  pi.emitEvent("statusline:row", { key: "compact", placement: "inline", row: 2, line: "CP:1", order: 10 });
  assert.equal(pi.widget()![1], "CP:1 │ MEM:3", "compaction contribution updates without a shell success");
});

test("Main updates its fallback cache slot before a slow command returns", async (t) => {
  const cwd = workspace(t, 0);
  writeFileSync(join(cwd, "statusline.sh"), "#!/bin/sh\nwhile IFS= read -r line; do :; done\nsleep 30\n");
  const branch = [assistantUsageEntry("a", { input: 2_000, cacheRead: 8_000, cacheWrite: 0 }, 1_000)];
  const pi = harness(cwd, branch);
  t.after(async () => pi.emit("session_shutdown", { reason: "quit" }));
  installStatusLine(pi.api as never, undefined, { initialLines: MAIN_INITIAL_LINES });
  await pi.emit("session_start", {});
  const until = Date.now() + 5_000;
  while (!pi.widget()?.[1]?.includes("CH:80.0%") && Date.now() < until) await delay(20);
  assert.match(pi.widget()![1]!, /CH:80\.0%/);
  branch.push(assistantUsageEntry("b", { input: 1_000, cacheRead: 9_000, cacheWrite: 0 }, 2_000));
  await pi.emit("turn_end", {});
  const updatedUntil = Date.now() + 5_000;
  while (!pi.widget()?.[1]?.includes("CH:90.0%") && Date.now() < updatedUntil) await delay(20);
  assert.match(pi.widget()![1]!, /CH:90\.0%/);
});

test("Main fallback retains Todo updates, withdrawal and completed-list clicks while its command fails", async (t) => {
  const cwd = workspace(t, 999);
  const pi = session(t, cwd, { initialLines: MAIN_INITIAL_LINES });
  await pi.emit("session_start", {});
  const todos = new TodoSnapshot();
  const publish = () => pi.emitEvent("statusline:row", {
    key: "todo", placement: "slot", line: renderTodoStatusLine(todos.visible()),
    onClick: () => toggleTodoView(todos, publish),
  });
  const checklist = new TodoWidget(todos, () => toggleTodoView(todos, publish));
  const tasks = [
    { id: 1, subject: "First fallback task", status: "completed" as const },
    { id: 2, subject: "Second fallback task", status: "pending" as const },
  ];
  todos.replace(tasks);
  publish();
  assert.match(pi.widget()![2]!, /todo 1\/2/);
  pi.emitEvent("statusline:row", { key: "goal", placement: "inline", row: 3, align: "right", line: "Goal active" });
  pi.emitEvent("statusline:row", { key: "fast", placement: "slot", line: "⚡fast" });
  assert.match(pi.widget()![0]!, /⚡fast/);
  assert.match(pi.widget()![2]!, /Goal active/);
  await delay(200);
  assert.match(pi.widget()![2]!, /todo 1\/2/, "failed command must not hide the slot");
  todos.replace(tasks.map((task) => ({ ...task, status: "completed" as const })));
  publish();
  assert.match(pi.widget()![2]!, /✓ todo 2\/2/);
  assert.deepEqual(checklist.render(80), [], "completion moves the list to the footer");
  assert.equal(pi.click(2, 2), true);
  assert.ok(checklist.render(80).some((line) => line.includes("Second fallback task")), "footer click reopens completed tasks");
  todos.clear();
  publish();
  assert.doesNotMatch(pi.widget()![2]!, /todo/);
  assert.match(pi.widget()![2]!, /Goal active/, "Todo withdrawal preserves inline peers");
  assert.equal(pi.click(2, 2), false, "withdrawn slot leaves no stale click span");
});

test("disposing a view waits for its in-flight command group to exit", async (t) => {
  const cwd = workspace(t, 0), pidFile = join(cwd, "command.pid");
  writeFileSync(join(cwd, "statusline.sh"), `#!/bin/sh
while IFS= read -r line; do :; done
trap '' TERM
echo "$$" > "${pidFile}"
sleep 30
`);
  const pi = harness(cwd);
  const statusline = installStatusLine(pi.api as never);
  t.after(() => statusline.dispose());
  await pi.emit("session_start", { reason: "startup" });
  const deadline = Date.now() + 20_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8")), started = Date.now();
  await statusline.dispose();
  assert.ok(Date.now() - started >= 200, "detach awaits termination escalation");
  assert.ok(Date.now() - started < 1_500, "detach has a 1s cleanup budget plus scheduling slack");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("session_shutdown closes inherited pipes even after the command's group has exited", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const cwd = workspace(t, 0), pidFile = join(cwd, "tree.json"), ready = join(cwd, "ready");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(cwd, "holder.cjs"), `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
// Leaving the command's session makes group signalling insufficient. Closing
// the read end must release this writer too, rather than leave our fds open.
process.stdout.on("error", () => process.exit(0));
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => process.stdout.write("held pipe\\n"), 20);
`);
  writeFileSync(join(cwd, "launcher.cjs"), `
const fs = require("node:fs"), { spawn } = require("node:child_process");
const child = spawn(process.execPath, [${JSON.stringify(join(cwd, "holder.cjs"))}], {
  detached: true, stdio: ["ignore", 1, 2],
});
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ root: process.pid, holder: child.pid }));
child.unref();
process.exit(0);
`);
  const settings = join(cwd, ".pi/settings.json");
  writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", placement: "widget",
    command: `exec ${quote(process.execPath)} ${quote(join(cwd, "launcher.cjs"))}`, debounceMs: 10, timeoutMs: 15_000 } }));
  const pi = session(t, cwd);
  t.after(() => {
    if (existsSync(pidFile)) {
      const { holder } = JSON.parse(readFileSync(pidFile, "utf8"));
      try { process.kill(-holder, "SIGKILL"); } catch { /* Already exited on EPIPE. */ }
    }
  });
  await pi.emit("session_start", { reason: "startup" });
  const deadline = Date.now() + 5_000;
  while (!existsSync(ready) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(ready), "the inherited writer must start");
  const { root, holder } = JSON.parse(readFileSync(pidFile, "utf8"));
  // The direct child is gone and reaped, but its stdout/stderr are still open.
  while (Date.now() < deadline) {
    try { process.kill(root, 0); await delay(10); } catch { break; }
  }
  assert.throws(() => process.kill(root, 0), { code: "ESRCH" });
  process.kill(holder, 0);
  const started = Date.now();
  await pi.emit("session_shutdown", { reason: "quit" });
  assert.ok(Date.now() - started < 2_000, "shutdown has a 1s cleanup budget plus scheduling slack");
  const drained = Date.now() + 2_000;
  let alive = true;
  while (alive && Date.now() < drained) {
    try { process.kill(holder, 0); await delay(10); } catch { alive = false; }
  }
  assert.equal(alive, false, "closing our pipe fds makes the escaped writer exit on EPIPE");
  assert.throws(() => process.kill(-root, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(-holder, 0), { code: "ESRCH" });
});

test("session_shutdown does not poll group existence forever after SIGKILL", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  const cwd = workspace(t, 0), pidFile = join(cwd, "command.pid");
  writeFileSync(join(cwd, "statusline.sh"), `#!/bin/sh
while IFS= read -r line; do :; done
trap '' TERM
echo "$$" > "${pidFile}"
exec sleep 30
`);
  const pi = session(t, cwd);
  await pi.emit("session_start", { reason: "startup" });
  const deadline = Date.now() + 20_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  const kill = process.kill.bind(process);
  // A zombie/group lookup can report existence after all executable work has
  // stopped. Keep real TERM/KILL delivery; only simulate this ambiguous probe.
  const probe = t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals | number) =>
    target < 0 && signal === 0 ? true : kill(target, signal));
  const started = Date.now();
  await pi.emit("session_shutdown", { reason: "quit" });
  probe.mock.restore();
  // The cleanup budget is 1s (250ms before SIGKILL, 750ms of drain). Anything
  // near the 30s command would mean shutdown is polling group existence again;
  // the extra seconds only cover a loaded machine's timer and signal latency.
  assert.ok(Date.now() - started < 5_000, "group existence cannot extend shutdown past its cleanup budget");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the direct child is reaped");
});

test("the generic statusline does not subscribe to process-domain channels", (t) => {
  const cwd = workspace(t, 0);
  const pi = session(t, cwd);

  assert.deepEqual(pi.eventChannels(), ["statusline:refresh", "statusline:row"]);
});

test("the Side statusline accepts only the side-chat contribution key", async (t) => {
  const cwd = workspace(t, 0);
  const pi = session(t, cwd, { interactiveSlots: false, acceptedContributionKeys: ["side-chat"] });
  await pi.emit("session_start", { reason: "startup" });
  await waitForFrame(pi, ["run 1"]);

  let rejected = false;
  pi.emitEvent("statusline:row", { key: "goal", line: "goal", reply: () => { rejected = true; } });
  assert.equal(rejected, false);
  assert.deepEqual(pi.widget(), ["run 1"]);

  let accepted = false;
  pi.emitEvent("statusline:row", { key: "side-chat", line: "side", reply: () => { accepted = true; } });
  assert.equal(accepted, true);
  assert.deepEqual(pi.widget(), ["run 1", "side"]);

  let withdrawn = false;
  pi.emitEvent("statusline:row", { key: "side-chat", reply: () => { withdrawn = true; } });
  assert.equal(withdrawn, true);
  assert.deepEqual(pi.widget(), ["run 1"]);
  assert.deepEqual(pi.eventChannels(), ["statusline:row"]);
});

test("the selected working-directory slot is clickable and opens the full path", async (t) => {
  const cwd = workspace(t, 0);
  const script = join(cwd, "statusline.sh");
  writeFileSync(
    script,
    ["#!/bin/sh", "while IFS= read -r line; do :; done", "printf '[[pi:slot:path-short]]\\n'", ""].join("\n"),
    "utf8",
  );
  const pi = session(t, cwd);

  await pi.emit("session_start", { reason: "startup" });
  await waitForFrame(pi, [basename(cwd)]);
  assert.equal(pi.click(0, 0), true);

  const until = Date.now() + 1_000;
  while (pi.customCalls() === 0 && Date.now() <= until) await delay(10);
  assert.equal(pi.customCalls(), 1);
});

test("the model slot opens Pi's native model selector action", async (t) => {
  const cwd = workspace(t, 0);
  const script = join(cwd, "statusline.sh");
  writeFileSync(
    script,
    ["#!/bin/sh", "while IFS= read -r line; do :; done", "printf '[[pi:slot:model]]\\n'", ""].join("\n"),
    "utf8",
  );
  const pi = session(t, cwd);

  await pi.emit("session_start", { reason: "startup" });
  await waitForFrame(pi, ["\x1b[1m\x1b[35mtest-model(test)\x1b[0m"]);
  assert.equal(pi.click(0, 0), true);
  assert.equal(pi.modelSelectorCalls(), 1);
});

test("a right-aligned cache slot opens its active-branch panel", async (t) => {
  const cwd = workspace(t, 0);
  const script = join(cwd, "statusline.sh");
  writeFileSync(
    script,
    ["#!/bin/sh", "while IFS= read -r line; do :; done", "printf 'left\\t[[pi:slot:cache-quality]]\\n'", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      statusLine: {
        type: "command",
        command: script,
        placement: "widget",
        widgetPlacement: "belowEditor",
        padding: 3,
        debounceMs: 10,
        timeoutMs: 5_000,
      },
    }),
    "utf8",
  );
  const branch = [
    assistantUsageEntry("a", { input: 2_000, cacheRead: 8_000, cacheWrite: 0 }, 1_000),
    assistantUsageEntry("b", { input: 1_000, cacheRead: 9_000, cacheWrite: 0 }, 2_000),
  ];
  const pi = harness(cwd, branch);
  t.after(async () => pi.emit("session_shutdown", { reason: "quit" }));
  installStatusLine(pi.api as never);

  await pi.emit("session_start", { reason: "startup" });
  const cacheLabel = "CH:90.0%·RU:90.0%·M:1k";
  const untilFrame = Date.now() + 5_000;
  for (;;) {
    const frame = pi.widget();
    const plain = frame?.[0]?.replace(/\x1b\[[0-9;]*m/g, "");
    if (plain?.endsWith(cacheLabel)) break;
    if (Date.now() > untilFrame) assert.fail(`timed out waiting for cache slot: ${plain}`);
    await delay(20);
  }
  assert.equal(pi.click(0, 0), false, "left padding must remain inert");
  assert.equal(pi.click(0, 80 - cacheLabel.length), true);
  const until = Date.now() + 1_000;
  while (pi.customCalls() === 0 && Date.now() <= until) await delay(10);
  assert.equal(pi.customCalls(), 1);
});

test("a shortened active branch rebuilds the cache slot instead of retaining removed requests", async (t) => {
  const cwd = workspace(t, 0);
  const script = join(cwd, "statusline.sh");
  writeFileSync(
    script,
    ["#!/bin/sh", "while IFS= read -r line; do :; done", "printf '[[pi:slot:cache-quality]]\\n'", ""].join("\n"),
    "utf8",
  );
  const branch = [
    assistantUsageEntry("a", { input: 2_000, cacheRead: 8_000, cacheWrite: 0 }, 1_000),
    assistantUsageEntry("b", { input: 1_000, cacheRead: 9_000, cacheWrite: 0 }, 2_000),
  ];
  const pi = harness(cwd, branch);
  t.after(async () => pi.emit("session_shutdown", { reason: "quit" }));
  installStatusLine(pi.api as never);

  await pi.emit("session_start", { reason: "startup" });
  await waitForFrame(pi, [
    "\x1b[36mCH:90.0%\x1b[0m\x1b[90m·\x1b[0m\x1b[33mRU:90.0%\x1b[0m\x1b[90m·\x1b[0m\x1b[90mM:1k\x1b[0m",
  ]);

  branch.splice(1);
  await pi.emit("turn_end", {});
  await waitForFrame(pi, ["\x1b[36mCH:80.0%\x1b[0m"]);
});

test("the full working-directory slot compacts only the home prefix", () => {
  assert.equal(compactHome("/Users/me", "/Users/me"), "~");
  assert.equal(compactHome("/Users/me/work/repo", "/Users/me"), "~/work/repo");
  assert.equal(compactHome("/Users/meanwhile/repo", "/Users/me"), "/Users/meanwhile/repo");
});

test("retries a first frame the command failed to produce", async (t) => {
  // The regression: at startup and after a reload there is no previous frame,
  // so `reclaimLastGood` is a no-op and one failed run left the statusline
  // blank until the next turn ended — which is the user sending a message.
  const cwd = workspace(t, 1);
  const pi = session(t, cwd);

  await pi.emit("session_start", { reason: "startup" });

  // Well inside the first backoff step, so nothing has been retried yet.
  await delay(400);
  assert.equal(pi.widget(), undefined, "a failed run must not mount a frame");

  await waitForFrame(pi, ["run 2"]);
});

test("a reloaded instance re-mounts the frame from before the reload", async (t) => {
  const cwd = workspace(t, 0);

  const before = session(t, cwd);
  await before.emit("session_start", { reason: "startup" });
  await waitForFrame(before, ["run 1"]);
  await before.emit("session_shutdown", { reason: "reload" });

  // What pi does across a reload: `resetExtensionUI()` drops every extension
  // widget, then the factory runs again against a fresh closure.
  const after = session(t, cwd);
  after.clearWidgets();
  await after.emit("session_start", { reason: "reload" });

  assert.deepEqual(
    after.widget(),
    ["run 1"],
    "the frame from before the reload should be back before the command answers",
  );

  await waitForFrame(after, ["run 2"]);
});

test("a session that is not reloading takes its frame down with it", async (t) => {
  const cwd = workspace(t, 0);

  const before = session(t, cwd);
  await before.emit("session_start", { reason: "startup" });
  await waitForFrame(before, ["run 1"]);
  await before.emit("session_shutdown", { reason: "new" });

  const after = session(t, cwd);
  await after.emit("session_start", { reason: "new" });
  assert.equal(after.widget(), undefined, "a switched-away frame described a session that is gone");

  await waitForFrame(after, ["run 2"]);
});
