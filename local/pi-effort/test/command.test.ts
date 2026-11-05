import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the extension's agent dir at an empty temp dir: without this the
// ultra branch reads the developer's live ~/.pi/agent config and the suite
// passes or fails depending on whose machine it runs on.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-effort-agent-"));

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import piEffort from "../index.ts";
import { EFFORT_LEVELS, type EffortLevel, supportedLevels } from "../levels.ts";

const THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (color: string) => color,
  getColorMode: () => "truecolor",
} as unknown as Theme;

const TUI_STUB = { requestRender() {} } as unknown as TUI;

const REASONING_MODEL = {
  id: "test/model",
  name: "test-model",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
};

const PLAIN_MODEL = { id: "test/plain", name: "plain-model", reasoning: false };

interface Notification {
  message: string;
  type?: string;
}

/**
 * A pi stand-in that clamps the way the real one does: an unsupported level
 * falls back to the nearest supported rung below it.
 */
function harness(model: unknown = REASONING_MODEL, start: EffortLevel = "medium") {
  const supported = supportedLevels(model as { reasoning?: boolean });
  let level = start;
  let command: RegisteredCommand | undefined;
  const events: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
  const statusline: Array<{ channel: string; payload: unknown }> = [];
  const busHandlers: Array<{ channel: string; handler: (data: unknown) => void }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const widgets: Array<{ key: string; cleared: boolean }> = [];

  const pi = {
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      if (name === "effort") command = { name, sourceInfo: {}, ...options } as RegisteredCommand;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      events.push({ event, handler });
    },
    events: {
      emit: (channel: string, payload: unknown) => statusline.push({ channel, payload }),
      on: (channel: string, handler: (data: unknown) => void) => {
        busHandlers.push({ channel, handler });
        return () => {};
      },
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    getThinkingLevel: () => level,
    setThinkingLevel: (next: EffortLevel) => {
      if (supported.includes(next)) {
        level = next;
        return;
      }
      const rank = (candidate: EffortLevel) => EFFORT_LEVELS.indexOf(candidate);
      const lower = supported.filter((candidate) => rank(candidate) < rank(next));
      level = (lower[lower.length - 1] ?? supported[0] ?? "off") as EffortLevel;
    },
  } as unknown as ExtensionAPI;

  piEffort(pi);
  assert.ok(command, "the extension registers /effort");

  const notifications: Notification[] = [];
  const context = (overrides: Record<string, unknown> = {}) =>
    ({
      mode: "tui",
      hasUI: true,
      model,
      sessionManager: { getBranch: () => entries.map((e) => ({ type: "custom", customType: e.type, data: e.data })) },
      ui: {
        theme: THEME,
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        select: async () => undefined,
        custom: async () => null,
        setWidget: (key: string, content: unknown) =>
          widgets.push({ key, cleared: content === undefined }),
      },
      ...overrides,
    }) as unknown as ExtensionCommandContext;

  return {
    command,
    notifications,
    statusline,
    context,
    level: () => level,
    externalLevel: (next: EffortLevel) => { level = next; },
    entries: () => entries,
    widgets: () => widgets,
    /** Emit the owner's fragment request and collect what was contributed. */
    fragments: (selectedTools?: readonly string[]) => {
      const collected: Array<{ key: string; text: string }> = [];
      for (const entry of busHandlers) {
        if (entry.channel !== "prompt:fragments-v1") continue;
        entry.handler({
          model: "m", thinkingLevel: level, selectedTools,
          contribute: (key: string, text: string) => collected.push({ key, text }),
        });
      }
      return collected;
    },
    fire: (event: string, payload: unknown, ctx: unknown) => {
      for (const entry of events) if (entry.event === event) entry.handler(payload, ctx);
    },
    /** Answers ui.custom by feeding keys to the picker the handler builds. */
    driving: (keys: string[]) =>
      context({
        ui: {
          theme: THEME,
          notify: (message: string, type?: string) => notifications.push({ message, type }),
          select: async () => undefined,
          custom: (factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (value: unknown) => void) => Component) =>
            new Promise((resolve) => {
              const component = factory(TUI_STUB, THEME, {}, resolve);
              for (const key of keys) component.handleInput?.(key);
            }),
        },
      }),
  };
}

test("an argument sets the level and says what it means", async () => {
  const pi = harness();
  await pi.command.handler("high", pi.context());

  assert.equal(pi.level(), "high");
  assert.deepEqual(pi.notifications, [
    { message: "Reasoning effort: high — Deep reasoning (~16k tokens)", type: "info" },
  ]);
});

test("arguments accept prefixes and positions, like the picker's number keys", async () => {
  const pi = harness();
  await pi.command.handler("xh", pi.context());
  assert.equal(pi.level(), "xhigh");

  await pi.command.handler("  1 ", pi.context());
  assert.equal(pi.level(), "off");
});

test("an unusable argument is refused without touching the level", async () => {
  const pi = harness();
  await pi.command.handler("turbo", pi.context());

  assert.equal(pi.level(), "medium");
  assert.equal(pi.notifications[0]?.type, "warning");
  assert.match(pi.notifications[0]?.message ?? "", /Unknown reasoning effort "turbo"/);
});

test("asking for the level already in effect is reported, not re-applied", async () => {
  const pi = harness();
  await pi.command.handler("medium", pi.context());

  assert.equal(pi.level(), "medium");
  assert.match(pi.notifications[0]?.message ?? "", /already medium/);
});

test("a clamped level is reported as what actually took effect", async () => {
  // The picker never offers max here, but a typed argument can still ask for
  // it once the model has changed underneath us.
  const pi = harness({ ...REASONING_MODEL, thinkingLevelMap: {} });
  const context = pi.context({ model: REASONING_MODEL });

  await pi.command.handler("max", context);

  assert.notEqual(pi.level(), "max");
  assert.equal(pi.notifications[0]?.type, "warning");
  assert.match(pi.notifications[0]?.message ?? "", /max is not available on this model — using/);
});

test("no argument opens the picker and applies what it returns", async () => {
  const pi = harness();
  await pi.command.handler("", pi.driving(["7", "\r"]));

  assert.equal(pi.level(), "max");
  assert.match(pi.notifications[0]?.message ?? "", /Reasoning effort: max/);
});

test("cancelling the picker leaves the level alone", async () => {
  const pi = harness();
  await pi.command.handler("", pi.driving(["\x1b"]));

  assert.equal(pi.level(), "medium");
  assert.deepEqual(pi.notifications, []);
});

test("a model without reasoning gets a plain answer instead of a picker", async () => {
  const pi = harness(PLAIN_MODEL, "off");
  await pi.command.handler("", pi.context({ model: PLAIN_MODEL }));

  assert.equal(pi.notifications[0]?.type, "warning");
  assert.match(pi.notifications[0]?.message ?? "", /plain-model has no reasoning effort/);
});

test("without UI the command reports the level and how to change it", async () => {
  const pi = harness();
  await pi.command.handler("", pi.context({ mode: "print", hasUI: false }));

  assert.equal(pi.level(), "medium");
  assert.match(pi.notifications[0]?.message ?? "", /Reasoning effort: medium\. Pass a level/);
});

test("completions offer the levels the current model actually has", async () => {
  const pi = harness();
  pi.fire("session_start", {}, pi.context());

  const all = await pi.command.getArgumentCompletions?.("");
  assert.deepEqual(
    all?.map((item) => item.value),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );

  const filtered = await pi.command.getArgumentCompletions?.("m");
  assert.deepEqual(
    filtered?.map((item) => item.value),
    ["minimal", "medium", "max"],
  );

  pi.fire("model_select", { model: PLAIN_MODEL }, pi.context());
  const plain = await pi.command.getArgumentCompletions?.("");
  assert.deepEqual(
    plain?.map((item) => item.value),
    ["off"],
  );
});

test("completion fails closed before model discovery and for unknown input", async () => {
  const pi = harness();
  assert.equal(await pi.command.getArgumentCompletions?.(""), null);
  pi.fire("session_start", {}, pi.context());
  assert.deepEqual((await pi.command.getArgumentCompletions?.("ul"))?.map((item) => item.value), ["ultra"]);
  assert.equal(await pi.command.getArgumentCompletions?.("unknown"), null);
  assert.equal(await pi.command.getArgumentCompletions?.("maximum"), null, "aliases are not advertised");
  pi.fire("model_select", { model: undefined }, pi.context());
  assert.equal(await pi.command.getArgumentCompletions?.(""), null);
});

test("ultra diagnostics are version-deduplicated and corruption cannot contribute", async (t) => {
  const dir = process.env.PI_CODING_AGENT_DIR!;
  const path = join(dir, "pi-effort.json");
  t.after(() => rmSync(path, { force: true }));
  writeFileSync(path, "{ bad json");
  const pi = harness();
  pi.fire("session_start", {}, pi.context());
  await pi.command.handler("ultra", pi.context());
  assert.equal(pi.level(), "max", "delegation errors do not undo the real thinking level");
  assert.deepEqual(pi.fragments(["spawn_agent"]), []);
  assert.deepEqual(pi.fragments(["spawn_agent"]), []);
  assert.equal(pi.notifications.length, 1, "one warning per failed version");
  assert.match(pi.notifications[0]?.message ?? "", /pi-effort\.json.*Invalid JSON/);
  writeFileSync(path, JSON.stringify({ ultra: { subagentTool: "spawn_agent" } }));
  assert.equal(pi.fragments(["spawn_agent"]).length, 1, "a repaired file is observed next run");
});

test("an unknown toolset contributes nothing and warns only once", async () => {
  const pi = harness();
  pi.fire("session_start", {}, pi.context());
  await pi.command.handler("ultra", pi.context());
  assert.deepEqual(pi.fragments(), []);
  assert.deepEqual(pi.fragments(), []);
  assert.equal(pi.notifications.filter((n) => n.type === "warning").length, 1);
});

test("the statusline effort slot opens the same picker and applies its choice", async () => {
  const pi = harness();
  const ctx = pi.driving(["5", "\r"]);
  pi.fire("session_start", {}, ctx);

  const contribution = pi.statusline.at(-1);
  assert.equal(contribution?.channel, "statusline:row");
  const payload = contribution?.payload as {
    key?: string;
    placement?: string;
    line?: string;
    onClick?: () => boolean;
  };
  assert.deepEqual(
    { key: payload.key, placement: payload.placement, line: payload.line },
    { key: "effort", placement: "slot", line: "\x1b[34mmedium\x1b[0m" },
  );
  assert.equal(payload.onClick?.(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.level(), "high");
  assert.match(pi.notifications[0]?.message ?? "", /Reasoning effort: high/);
});

test("ultra and max are different acts: only ultra injects", async () => {
  const pi = harness();
  pi.fire("session_start", {}, pi.context());

  await pi.command.handler("max", pi.context());
  assert.equal(pi.level(), "max");
  assert.deepEqual(pi.fragments(["spawn_agent"]), [], "max alone contributes nothing");

  await pi.command.handler("ultra", pi.context());
  assert.equal(pi.level(), "max", "ultra pins the top real rung underneath");
  const contributed = pi.fragments(["spawn_agent"]);
  assert.equal(contributed.length, 1);
  assert.equal(contributed[0]?.key, "effort:ultra");
  assert.match(contributed[0]?.text ?? "", /Proactive multi-agent delegation is active/);
  assert.deepEqual(pi.entries().at(-1), { type: "pi-effort:ultra-v1", data: { enabled: true } });

  // Without the sub-agent tool the session stays ultra but injects nothing.
  assert.deepEqual(pi.fragments(["read", "bash"]), []);

  // Choosing max again leaves ultra, even though the level does not move.
  await pi.command.handler("max", pi.context());
  assert.equal(pi.level(), "max");
  assert.deepEqual(pi.fragments(["spawn_agent"]), []);
  assert.deepEqual(pi.entries().at(-1), { type: "pi-effort:ultra-v1", data: { enabled: false } });
});

test("a real native level change clears ultra after a model switch", async () => {
  const pi = harness();
  pi.fire("session_start", {}, pi.context());
  await pi.command.handler("ultra", pi.context());
  pi.fire("model_select", { model: PLAIN_MODEL }, pi.context({ model: PLAIN_MODEL }));
  assert.deepEqual(pi.statusline.at(-1)?.payload, { key: "effort" }, "non-reasoning model withdraws the slot");
  pi.externalLevel("off");
  pi.fire("thinking_level_select", { level: "off", previousLevel: "max" }, pi.context({ model: PLAIN_MODEL }));
  assert.deepEqual(pi.fragments(["spawn_agent"]), []);
  assert.deepEqual(pi.entries().at(-1), { type: "pi-effort:ultra-v1", data: { enabled: false } });
});

test("shutdown retires transient state without erasing the saved ultra flag", async () => {
  const pi = harness();
  const ctx = pi.context();
  pi.fire("session_start", {}, ctx);
  await pi.command.handler("ultra", ctx);
  const saved = [...pi.entries()];
  const onClick = (pi.statusline.at(-1)?.payload as { onClick: () => boolean }).onClick;
  pi.fire("session_shutdown", { reason: "reload" }, ctx);
  assert.deepEqual(pi.fragments(["spawn_agent"]), []);
  assert.equal(await pi.command.getArgumentCompletions?.(""), null);
  assert.equal(onClick(), false, "retired statusline callback cannot open a picker");
  assert.deepEqual(pi.entries(), saved);
  pi.fire("session_start", {}, ctx);
  assert.equal(pi.fragments(["spawn_agent"]).length, 1);
});

test("ultra survives a reload by way of the session branch", async () => {
  const first = harness();
  first.fire("session_start", {}, first.context());
  await first.command.handler("ultra", first.context());
  const branch = first.entries().map((e) => ({
    type: "custom", customType: e.type, data: e.data,
  }));

  const second = harness();
  second.fire("session_start", {}, second.context({
    sessionManager: { getBranch: () => branch },
  }));
  assert.equal(second.fragments(["spawn_agent"]).length, 1, "restored from the branch");
});
