import assert from "node:assert/strict";
import test from "node:test";
import {
  CustomMessageComponent,
  getMarkdownTheme,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CUSTOM_MESSAGES } from "../src/config.ts";
import {
  COMPACT_MESSAGE_TYPES,
  CommandOutputComponent,
  registerCompactMessageRenderers,
  stripEchoedHeading,
} from "../src/command-output.ts";
import { click } from "./native-mouse.ts";

initTheme("dark");

const plainTheme = { fg: (_c: string, text: string) => text } as unknown as Theme;

const render = (label: string, text: string, width = 70) =>
  new CommandOutputComponent(
    label,
    text,
    getMarkdownTheme(),
    DEFAULT_CUSTOM_MESSAGES,
    plainTheme,
  )
    .render(width)
    .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd());

test("drops a heading that only repeats the command name", () => {
  assert.equal(
    stripEchoedHeading("## /ctx-flush\n\nFlushed 12 pending ops.", "/ctx-flush"),
    "Flushed 12 pending ops.",
  );
  // Case and the leading slash are incidental.
  assert.equal(stripEchoedHeading("# Ctx Flush\n\nbody", "/ctx-flush"), "body");
});

test("keeps a heading that says something the label does not", () => {
  const text = "## Magic Wrapup\n\nEligible history is about 1,178,444 tokens.";
  assert.equal(stripEchoedHeading(text, "/ctx-wrapup"), text);
});

test("leaves ordinary content untouched", () => {
  assert.equal(stripEchoedHeading("Flushed 12 ops.", "/ctx-flush"), "Flushed 12 ops.");
  assert.equal(stripEchoedHeading("", "/ctx-flush"), "");
});

test("puts the command on one row and indents the body under it", () => {
  const lines = render("/ctx-flush", "## /ctx-flush\n\nFlushed 12 pending ops.");
  assert.equal(lines[0], "▸ /ctx-flush");
  const body = lines.slice(1).filter(Boolean);
  assert.deepEqual(body, ["  Flushed 12 pending ops."]);
});

test("renders a command with no output as a single row", () => {
  assert.deepEqual(render("/ctx-dream", ""), ["▸ /ctx-dream"]);
});

test("keeps the echoed heading when the option is off", () => {
  const lines = new CommandOutputComponent(
    "/ctx-flush",
    "## /ctx-flush\n\nFlushed.",
    getMarkdownTheme(),
    { ...DEFAULT_CUSTOM_MESSAGES, stripEchoedHeading: false },
    plainTheme,
  )
    .render(70)
    .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim())
    .filter(Boolean);
  assert.ok(lines.some((line) => line.includes("/ctx-flush")), lines.join("|"));
  assert.equal(lines.length, 3);
});

test("a known custom type renders compactly through Pi's renderer and opens its details", () => {
  const renderers = new Map<string, (...args: never[]) => unknown>();
  const opened: Array<{ heading: string; body: string }> = [];
  const pi = {
    registerMessageRenderer: (type: string, renderer: (...args: never[]) => unknown) => renderers.set(type, renderer),
    getSettings: () => ({}),
  } as never;
  const dispose = registerCompactMessageRenderers(pi, DEFAULT_CUSTOM_MESSAGES, (heading, body) => {
    opened.push({ heading, body });
    return true;
  });
  assert.deepEqual([...renderers.keys()], [...COMPACT_MESSAGE_TYPES]);
  assert.ok(!renderers.has("fixture-unknown"), "an unknown type keeps Pi's own box");
  const message = {
    role: "custom",
    customType: "fork-update",
    content: "pi packages updated: pi-goal",
    display: true,
    details: { markdown: "## Merged\n\n- pi-goal" },
    timestamp: 0,
  };
  // Pi's own component calls the renderer and cleans up on every rebuild.
  const component = new CustomMessageComponent(message as never, renderers.get("fork-update") as never, getMarkdownTheme());
  const row = (component as unknown as { children: Array<{ render(width: number): string[] }> }).children.at(-1)!;
  assert.deepEqual(
    row.render(70).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd()),
    ["▸ fork-update", "  pi packages updated: pi-goal"],
  );
  component.invalidate();
  component.invalidate();
  assert.equal((component as unknown as { children: unknown[] }).children.length, 2, "spacer and one row after rebuilds");
  const current = (component as unknown as { children: unknown[] }).children.at(-1) as never;
  assert.equal(click(current, 0, 0), true);
  assert.deepEqual(opened, [{ heading: "fork-update", body: "## Merged\n\n- pi-goal" }]);
  dispose();
  assert.equal(renderers.get("fork-update")!(message as never, { expanded: false, outputPad: 1 } as never, plainTheme as never), undefined,
    "after disposal Pi draws its own box again");
});


test("mcp-oauth-status preserves the producer's text and opens its authentication details", () => {
  const renderers = new Map<string, (...args: never[]) => unknown>();
  const opened: Array<{ heading: string; body: string }> = [];
  const dispose = registerCompactMessageRenderers({
    registerMessageRenderer: (type: string, renderer: (...args: never[]) => unknown) => renderers.set(type, renderer),
    getSettings: () => ({}),
  } as never, DEFAULT_CUSTOM_MESSAGES, (heading, body) => { opened.push({ heading, body }); return true; });
  const message = { role: "custom", customType: "mcp-oauth-status",
    content: [{ type: "text", text: "Authentication completed for fixture-server" }],
    display: "Authentication completed for fixture-server",
    details: { server: "fixture-server", status: "authenticated", nextAction: { connect: "fixture-server" } }, timestamp: 0 };
  try {
    assert.ok(renderers.has("mcp-oauth-status"), "the producer's actual customType is registered");
    const component = new CustomMessageComponent(message as never, renderers.get("mcp-oauth-status") as never, getMarkdownTheme());
    const row = (component as unknown as { children: Array<{ render(width: number): string[] }> }).children.at(-1)!;
    assert.deepEqual(row.render(80).map(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd()),
      ["▸ mcp-oauth-status", "  Authentication completed for fixture-server"]);
    assert.equal(click(row as never, 0, 0), true);
    assert.equal(opened[0]?.heading, "mcp-oauth-status");
    assert.match(opened[0]?.body ?? "", /"server": "fixture-server"/);
    assert.match(opened[0]?.body ?? "", /"status": "authenticated"/);
    assert.match(opened[0]?.body ?? "", /"connect": "fixture-server"/);
  } finally { dispose(); }
});
