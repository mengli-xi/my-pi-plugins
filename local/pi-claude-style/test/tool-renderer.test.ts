import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { click } from "./native-mouse.ts";
import { Container, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DIFF } from "../src/config.ts";
import { captureResult } from "../src/capture-result.ts";
import { GroupStore } from "../src/grouping.ts";
import { RuntimeOverlayOpeners, type GroupOpener } from "../src/openers.ts";
import {
  decorateToolRenderers,
  fitGroupSummary,
  HeaderPrefixedComponent,
  GroupedImageResultComponent,
  PrefixedComponent,
  renderGroupSummary,
} from "../src/tool-renderer.ts";
import { createDefaultToolPresentationRegistry } from "../src/presentation-adapters.ts";

initTheme("dark");

function child(lines: string[]): Component {
  return {
    render: () => lines,
    invalidate: () => {},
  };
}

function trimmed(component: Component, width = 120): string[] {
  return component.render(width).map((line) => line.trimEnd());
}

const stripAnsi = (line: string) =>
  line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("aligns expanded tool calls and results beneath their semantic prefix", () => {
  const call = new PrefixedComponent(child(["Read x", "continued"]), "● ");
  const result = new PrefixedComponent(child(["line 1", "line 2"]), "  ⎿ ");

  assert.deepEqual(call.render(40), ["● Read x", "  continued"]);
  assert.deepEqual(result.render(40), ["  ⎿ line 1", "    line 2"]);
});

test("recomputes a tool prefix when its status color changes", () => {
  let prefix = "running ";
  const component = new PrefixedComponent(child(["command"]), () => prefix);
  assert.deepEqual(component.render(40), ["running command"]);
  prefix = "success ";
  assert.deepEqual(component.render(40), ["success command"]);
});

test("caches a supplied body before its expensive renderer runs", () => {
  const identity = {};
  let bodyRenders = 0;
  const component = new HeaderPrefixedComponent(
    child(["Edit src/a.ts", "native body"]),
    "⏺ ",
    (header) => header,
    2,
    (lines) => [...lines],
    "…",
    () => ({
      identity,
      render: () => {
        bodyRenders++;
        return ["settled body"];
      },
    }),
  );

  assert.deepEqual(component.render(40), ["⏺ Edit src/a.ts", "  settled body"]);
  assert.deepEqual(component.render(40), ["⏺ Edit src/a.ts", "  settled body"]);
  assert.equal(bodyRenders, 1);
  component.render(41);
  assert.equal(bodyRenders, 2);
  const narrow = new HeaderPrefixedComponent(
    child(["H", "中"]),
    "x",
    (header) => header,
    1,
    (lines) => [...lines],
    "…",
    () => ({
      identity,
      render: () => {
        bodyRenders++;
        return ["中"];
      },
    }),
  );
  assert.deepEqual(narrow.render(2), ["H", "中"]);
  assert.equal(bodyRenders, 2);
});

test("single-file Edit removes the native leading marker before adding the CC Style marker", () => {
  for (const [id, nativeHeader] of [
    ["plain", "● Edit src/a.ts"],
    ["ansi", "\u001b[36m⏺\u001b[39m Edit src/a.ts"],
  ] as const) {
    const store = new GroupStore({ maxGroups: 10 });
    const args = { path: "src/a.ts", edits: [] };
    store.start(`edit-marker-${id}`, "edit", args, 100, "single-file-edit");
    const decorated = decorate("edit", store, {
      renderCall: () => child([nativeHeader]),
    });
    const rendered = decorated.renderCall(
      args,
      theme,
      context(`edit-marker-${id}`, args),
    ).render(40).map(stripAnsi);
    assert.deepEqual(rendered, ["⏺ Edit src/a.ts"]);
  }
});

test("removes an edit shell background while preserving inline highlights", () => {
  const shellBackground = "\u001b[48;2;71;84;83m";
  const inlineBackground = "\u001b[48;2;90;20;20m";
  const component = new HeaderPrefixedComponent(
    child([
      `${shellBackground}    \u001b[49m`,
      `${shellBackground}Edit src/a.ts\u001b[49m`,
      "",
      `${shellBackground}\u001b[31m-old\u001b[39m`,
      `${shellBackground}\u001b[32m+ne${inlineBackground}w\u001b[49m\u001b[39m`,
    ]),
    "⏺ ",
  );

  assert.deepEqual(component.render(40), [
    "⏺ Edit src/a.ts\u001b[49m",
    "\u001b[31m-old\u001b[39m",
    `\u001b[32m+ne${inlineBackground}w\u001b[49m\u001b[39m`,
  ]);
});

const theme = {
  fg: (_color: string, text: string) => text,
  getBgAnsi: (color: string) =>
    color === "toolSuccessBg" ? "\u001b[42m" : "\u001b[41m",
} as any;

function context(toolCallId: string, args: unknown, isError = false): any {
  return {
    args,
    toolCallId,
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    durationMs: undefined,
    outputPad: 0,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError,
  };
}

function definition(
  name: string,
  renderers: Record<string, unknown> = {},
): any {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    ...renderers,
  };
}

function decorate(
  name: string,
  store: GroupStore,
  renderers = {},
  openGroup?: GroupOpener,
  openImages?: (images: readonly import("../src/image-preview.ts").ToolImagePreview[]) => boolean,
): any {
  return decorateToolRenderers(name, definition(name, renderers), {
    store,
    getExpandMode: () => "overlay",
    resolvePresentation: (toolName) => {
      if (toolName === "ask_user_question") return { kind: "question" };
      if (toolName === "web_search") return { kind: "web-search" };
      if (toolName === "edit") return { kind: "single-file-edit" };
      if (toolName === "native") return { kind: "native" };
      return { kind: "grouped" };
    },
    maxResultChars: 10_000,
    openGroup,
    openImages,
    diffColors: DEFAULT_DIFF,
  });
}

test("renders completed grouped success as one indented sentence without a bullet", () => {
  const store = new GroupStore({ maxGroups: 10 });
  store.start("bash-1", "bash", {}, 100);
  store.end(
    "bash-1",
    { text: "ok", truncated: false, isError: false },
    "completed",
    200,
  );
  assert.equal(
    renderGroupSummary(store.latest()!, theme),
    "  Ran 1 shell command",
  );
  assert.equal(
    renderGroupSummary(store.latest()!, theme, undefined, 200, undefined, 65_000),
    "  Ran 1 shell command · Thinking 1m05s",
  );
});

test("uses one neutral palette and a live shimmer for folded tools", () => {
  const store = new GroupStore({ maxGroups: 10 });
  store.start("bash-1", "bash", {}, 100);
  const used: string[] = [];
  const spyTheme = {
    fg: (color: string, text: string) => {
      used.push(color);
      return text;
    },
  } as any;

  assert.equal(
    renderGroupSummary(store.latest()!, spyTheme, undefined, 1_000),
    "✳ Running 1 shell command…",
  );
  assert.deepEqual([...new Set(used)].sort(), ["dim", "muted", "text"]);

  used.length = 0;
  store.end(
    "bash-1",
    { text: "failed", truncated: false, isError: true },
    "failed",
    200,
  );
  assert.match(
    renderGroupSummary(store.latest()!, spyTheme),
    /Ran 1 shell command · 1 failed/,
  );
  assert.deepEqual([...new Set(used)], ["muted"]);
});

test("keeps successful stop summaries muted and reserves red for stop failure", () => {
  const store = new GroupStore({ maxGroups: 10 });
  store.start("process-stop", "process", { action: "stop", target: "api" }, 100);
  store.end("process-stop", { text: "stopped", truncated: false, isError: false }, "completed", 200);
  const used: string[] = [];
  const spyTheme = {
    fg: (color: string, text: string) => {
      used.push(color);
      return `{${color}:${text}}`;
    },
  } as any;
  const registry = createDefaultToolPresentationRegistry(() => ({ kind: "grouped" }));
  assert.equal(registry.groupTone(store.latest()!), undefined);
  renderGroupSummary(store.latest()!, spyTheme, (group) => registry.summarizeGroup(group));
  assert.equal(used.includes("error"), false);
  assert.ok(used.includes("muted"));

  const failed = new GroupStore({ maxGroups: 10 });
  failed.start("process-stop-fail", "process", { action: "stop", target: "api" }, 100);
  failed.end("process-stop-fail", { text: "failed", truncated: false, isError: true }, "failed", 200);
  assert.equal(registry.groupTone(failed.latest()!), "error");
});

test("uses an equally dim blue tone for process start summaries", () => {
  const store = new GroupStore({ maxGroups: 10 });
  store.start("process-1", "process", { action: "start" }, 100);
  const used: string[] = [];
  const spyTheme = {
    fg: (color: string, text: string) => {
      used.push(color);
      return `{${color}:${text}}`;
    },
  } as any;

  const rendered = renderGroupSummary(
    store.latest()!,
    spyTheme,
    () => "Starting 1 process",
    1_000,
    "customMessageLabel",
  );
  assert.match(rendered, /\{customMessageLabel:/);
  assert.match(rendered, /\x1b\[2m/);
  assert.deepEqual([...new Set(used)].sort(), ["customMessageLabel", "dim", "muted"]);
});

test("keeps running command details out of the folded transcript", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const tool = decorate("bash", store);
  const firstArgs = { command: "git diff --stat" };
  const first = tool.renderCall!(
    firstArgs,
    theme,
    context("bash-1", firstArgs),
  );

  assert.deepEqual(trimmed(first), ["✳ Running 1 shell command…"]);

  store.start("read-1", "read", { path: "src/a.ts" }, 200);
  assert.deepEqual(trimmed(first), [
    "✳ Reading 1 file, running 1 shell command…",
  ]);

  store.end(
    "read-1",
    { text: "ok", truncated: false, isError: false },
    "completed",
    300,
  );
  assert.deepEqual(trimmed(first), [
    "✳ Reading 1 file, running 1 shell command…",
  ]);
});

test("a presentation formatter owns the grouped summary only", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const tool = decorateToolRenderers("process", definition("process"), {
    store,
    getExpandMode: () => "overlay",
    resolvePresentation: () => ({ kind: "grouped" }),
    maxResultChars: 10_000,
    presenter: {
      summarizeGroup: () => "Adapter summary",
      formatActivity: () => "Adapter detail",
    },
    thinkingElapsedForToolCalls: (toolCallIds) =>
      toolCallIds.includes("process-1") ? 65_000 : undefined,
  });
  const row = tool.renderCall!(
    { action: "list" },
    theme,
    context("process-1", { action: "list" }),
  );

  assert.deepEqual(trimmed(row), ["✳ Adapter summary · Thinking 1m05s…"]);
});

test("a stateful presentation registry keeps its receiver in the render path", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const presenter = createDefaultToolPresentationRegistry(() => ({
    kind: "grouped",
  }));
  const tool = decorateToolRenderers("process", definition("process"), {
    store,
    getExpandMode: () => "overlay",
    resolvePresentation: (name, args) => presenter.resolve(name, args),
    maxResultChars: 10_000,
    presenter,
  });
  const args = { action: "output", id: "backend" };
  const row = tool.renderCall!(args, theme, context("process-1", args));

  assert.deepEqual(trimmed(row), ["✳ Process 'backend' output loading…"]);
});

test("truncates long grouped summaries to the available terminal width", () => {
  const store = new GroupStore({ maxGroups: 10 });
  for (const [index, name] of [
    "grep",
    "read",
    "ls",
    "bash",
    "unknown_tool",
  ].entries()) {
    store.start(`${index}`, name, {}, 100 + index);
    store.end(
      `${index}`,
      { text: "failed", truncated: false, isError: true },
      "failed",
      200 + index,
    );
  }
  const lines = fitGroupSummary(store.latest()!, theme, 24);
  assert.ok(lines.length <= 2);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.match(lines.at(-1) ?? "", /…/);
  assert.doesNotMatch(lines.join("\n"), /alt\+o|ctrl\+o|view/i);
});

test("renders the questionnaire header and a dark answer beneath the Agent title", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const args = { questions: [{ question: "哪个城市？", header: "城市" }] };
  store.start(
    "question-1",
    "ask_user_question",
    args,
    100,
    "question",
  );
  const tool = decorate("ask_user_question", store);
  const ctx = context("question-1", args);
  const tones: Array<[string, string]> = [];
  const answerTheme = {
    ...theme,
    fg: (color: string, text: string) => {
      tones.push([color, text]);
      return text;
    },
  } as any;
  const call = tool.renderCall!(args, answerTheme, ctx);
  const rawResult = {
    content: [{ type: "text", text: "model envelope" }],
    details: {
      answers: [{
        questionIndex: 0,
        question: "哪个城市？",
        kind: "custom",
        answer: "新加坡",
      }],
      cancelled: false,
    },
  };
  store.end(
    "question-1",
    {
      text: "model envelope",
      truncated: false,
      isError: false,
      details: rawResult.details,
    },
    "completed",
    200,
  );
  const renderedResult = tool.renderResult(
    rawResult,
    { expanded: false, isPartial: false },
    answerTheme,
    ctx,
  );

  assert.deepEqual(trimmed(call), [
    "⏺ User answered Agent's questions:",
  ]);
  const answerRows = trimmed(renderedResult);
  assert.deepEqual(answerRows.map(stripAnsi), ["  ⎿ 城市 -> 新加坡"]);
  assert.match(answerRows[0]!, /\x1b\[38;5;66m新加坡\x1b\[39m/);
  assert.ok(tones.some(([tone, text]) => tone === "muted" && text === "⏺"));
  assert.ok(tones.some(([tone, text]) =>
    tone === "text" && text === "User answered Agent's questions:"
  ));
  assert.ok(tones.some(([tone, text]) => tone === "muted" && text === "  ⎿"));
  assert.ok(tones.some(([tone, text]) => tone === "text" && text === "城市"));
  assert.ok(tones.some(([tone, text]) => tone === "muted" && text === "->"));
});

test("renders web summary while keeping raw search results out of the main row", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const args = { query: "Singapore weather" };
  store.start("web-1", "web_search", args, 1_000, "web-search");
  const tool = decorate("web_search", store);
  const ctx = context("web-1", args);
  const call = tool.renderCall!(args, theme, ctx);
  store.end(
    "web-1",
    {
      text: "1. raw result https://example.com",
      truncated: false,
      isError: false,
      details: { provider: "openai-codex", method: "ddg" },
    },
    "completed",
    8_400,
  );
  const renderedResult = tool.renderResult(
    {
      content: [{ type: "text", text: "1. raw result https://example.com" }],
    },
    { expanded: false, isPartial: false },
    theme,
    ctx,
  );

  assert.deepEqual(trimmed(call), [
    '⏺ Web Search("Singapore weather")',
  ]);
  assert.deepEqual(trimmed(renderedResult), ["  Did 1 search in 7s"]);
});

test("aligns edit line numbers to its title and backgrounds changed rows", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const args = { path: "src/a.ts", edits: [] };
  store.start("edit-1", "edit", args, 100, "single-file-edit");
  store.end(
    "edit-1",
    {
      text: "edited",
      truncated: false,
      isError: false,
      details: { diff: "-250 old\n+250 new\n 251 context" },
    },
    "completed",
    200,
  );
  const tool = decorate("edit", store, {
    renderCall: () =>
      child([
        "\u001b[48;2;71;84;83m                                        \u001b[49m",
        "\u001b[48;2;71;84;83m  edit src/a.ts                         \u001b[49m",
        "",
        "\u001b[48;2;71;84;83m -250 old                          \u001b[49m",
        "\u001b[48;2;71;84;83m +250 ne\u001b[7mw\u001b[0m\u001b[32m                    \u001b[49m",
        "\u001b[48;2;71;84;83m  251 context                       \u001b[49m",
      ]),
    renderResult: () => child(["Updated"]),
  });
  const ctx = context("edit-1", args);

  const rendered = tool.renderCall!(args, theme, ctx).render(120);
  assert.deepEqual(rendered.map(stripAnsi).map((line: string) => line.trimEnd()), [
    "⏺ Edit src/a.ts",
    "  -250 old",
    "  +250 new",
    "   251 context",
  ]);
  assert.ok(rendered[1]?.includes("\u001b[48;5;52m"));
  assert.ok(rendered[2]?.includes("\u001b[48;5;22m"));
  assert.ok(!rendered[3]?.includes("\u001b[48;5;"));
  assert.equal(visibleWidth(rendered[1] ?? ""), 120);
  assert.equal(visibleWidth(rendered[2] ?? ""), 120);
  assert.deepEqual(
    tool.renderResult(
      { content: [{ type: "text", text: "edited" }] },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    ).render(120),
    ["Updated"],
  );
  assert.deepEqual(
    tool.renderResult(
      {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }],
        details: { diff: "-250 old\n+250 new" },
      },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    ).render(120),
    [],
  );
});

test("settled inline diffs wrap the captured logical row, not native physical rows", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const args = { path: "src/long.ts", edits: [] };
  store.start("edit-wrap", "edit", args, 100, "single-file-edit");
  store.end(
    "edit-wrap",
    {
      text: "edited",
      truncated: false,
      isError: false,
      details: { diff: "+250 alpha  -123 @@ continuation-abcdefgh" },
    },
    "completed",
    200,
  );
  const tool = decorate("edit", store, {
    renderCall: () =>
      child([
        "edit src/long.ts",
        "+250 WRONG_NATIVE_BODY",
        "-123 wrongly-classified-physical-line",
      ]),
  });

  const rendered = tool.renderCall!(
    args,
    theme,
    context("edit-wrap", args),
  ).render(18);
  const plain = rendered.map((line: string) => stripAnsi(line));
  const body = plain.slice(1);

  assert.equal(plain[0], "⏺ Edit src/long.ts");
  assert.ok(body.slice(1).every((line: string) => line.startsWith("       ")));
  assert.equal(
    body.map((line: string, index: number) =>
      index === 0 ? line.slice(2) : line.slice(7)
    ).join("").trimEnd(),
    "+250 alpha  -123 @@ continuation-abcdefgh",
  );
  assert.ok(plain.every((line: string) => !line.includes("WRONG_NATIVE_BODY")));
  assert.ok(
    rendered.slice(1).every((line: string) => visibleWidth(line) === 18),
  );
});

test("Edit style shows cwd-relative paths and absolute paths outside cwd", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const inside = { path: "/tmp/src/inside.ts", edits: [] };
  store.start("edit-inside", "edit", inside, 100, "single-file-edit");
  const insideRow = decorate("edit", store, {
    renderCall: () => child(["edit /tmp/src/inside.ts"]),
  }).renderCall(inside, theme, context("edit-inside", inside)).render(80)
    .map((line: string) => stripAnsi(line));
  assert.equal(insideRow[0], "⏺ Edit src/inside.ts");

  const homeInside = { path: "~/src/inside.ts", edits: [] };
  store.start("edit-home-inside", "edit", homeInside, 100, "single-file-edit");
  const homeInsideRow = decorate("edit", store, {
    renderCall: () => child(["Edit(~/src/inside.ts)"]),
  }).renderCall(
    homeInside,
    theme,
    { ...context("edit-home-inside", homeInside), cwd: `${homedir()}` },
  ).render(80).map((line: string) => stripAnsi(line));
  assert.equal(homeInsideRow[0], "⏺ Edit src/inside.ts");

  const outside = { path: "/etc/hosts", edits: [] };
  store.start("edit-outside", "edit", outside, 100, "single-file-edit");
  const outsideRow = decorate("edit", store, {
    renderCall: () => child(["edit /etc/hosts"]),
  }).renderCall(outside, theme, context("edit-outside", outside)).render(80)
    .map((line: string) => stripAnsi(line));
  assert.equal(outsideRow[0], "⏺ Edit /etc/hosts");
});

test("running or truncated edit payloads keep Pi's native body", async (t) => {
  for (const scenario of ["running", "truncated"] as const) {
    await t.test(scenario, () => {
      const store = new GroupStore({ maxGroups: 10 });
      const id = `edit-${scenario}`;
      const args = { path: "src/native.ts", edits: [] };
      store.start(id, "edit", args, 100, "single-file-edit");
      const captured = {
        text: "edited",
        truncated: scenario === "truncated",
        isError: false,
        details: { diff: "+250 RAW_BODY" },
      };
      if (scenario === "running") {
        store.update(id, args, captured);
      } else {
        store.end(id, captured, "completed", 200);
      }
      const tool = decorate("edit", store, {
        renderCall: () => child(["edit src/native.ts", "+250 NATIVE_BODY"]),
      });
      const rendered = tool.renderCall!(args, theme, context(id, args)).render(40)
        .map((line: string) => stripAnsi(line));
      assert.ok(rendered.some((line: string) => line.includes("NATIVE_BODY")));
      assert.ok(rendered.every((line: string) => !line.includes("RAW_BODY")));
    });
  }
});

test("renders an image read as a dedicated clickable preview row", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const args = { path: "screen.png" };
  const image = { data: "aGVsbG8=", mimeType: "image/png" };
  const content = [
    { type: "text", text: "Read image file [image/png]" },
    { type: "image", ...image },
  ];
  store.start("read-image", "read", args, 100);
  store.end("read-image", captureResult({ content }, false, 10_000), "completed", 200);
  let opened: readonly unknown[] = [];
  const tool = decorate("read", store, {}, undefined, (images) => {
    opened = images;
    return true;
  });
  const call = tool.renderCall!(args, theme, context("read-image", args));
  const result = tool.renderResult(
    { content },
    { expanded: false, isPartial: false },
    theme,
    context("read-image", args),
  ) as GroupedImageResultComponent;

  assert.ok(result instanceof GroupedImageResultComponent);
  assert.deepEqual(trimmed(call), []);
  assert.deepEqual(trimmed(result), ["  ⎿ View Image (5 B)"]);
  assert.equal(click(result, 0, 0), true);
  assert.deepEqual(opened, [{ ...image, sizeBytes: 5, path: "screen.png" }]);
});

function imageGroupHarness() {
  const store = new GroupStore({ maxGroups: 10 });
  const opened: string[] = [];
  const tool = decorate("read", store, {}, undefined, (images) => {
    opened.push(images[0]!.path!);
    return true;
  });
  const transcript = new Container();
  const tools = ["a", "b", "c"].map((id) => {
    store.start(id, "read", { path: `${id}.png` }, 100);
    const component = new ToolExecutionComponent("read", id, { path: `${id}.png` },
      { showImages: false }, tool, { requestRender() {} } as TUI, "/tmp");
    transcript.addChild(component);
    return component;
  });
  const finish = (index: number) => {
    const content = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
    store.end(["a", "b", "c"][index]!, captureResult({ content }, false, 10_000), "completed", 200);
    tools[index]!.updateResult({ content, isError: false });
  };
  const rows = () => transcript.render(120).map(stripAnsi).map((line) => line.trimEnd());
  return { store, tools, transcript, finish, rows, opened };
}

test("three grouped image results have no blank rows in their native Pi shells", () => {
  const h = imageGroupHarness();
  for (let index = 0; index < 3; index++) h.finish(index);
  assert.deepEqual(h.rows(), ["", ...Array(3).fill("  ⎿ View Image (5 B)")]);
  assert.deepEqual(h.tools[1]!.render(120), []);
  assert.deepEqual(h.tools[2]!.render(120), []);
  for (let index = 0; index < 3; index++) assert.equal(click(h.transcript, index + 1, 8), true);
  assert.deepEqual(h.opened, ["a.png", "b.png", "c.png"]);
});

test("the first image container follows late results in tool order and native image toggles", () => {
  const h = imageGroupHarness();
  h.finish(2);
  assert.equal(h.rows().filter((row) => row.includes("View Image")).length, 1);
  h.finish(0);
  h.finish(1);
  assert.deepEqual(h.rows(), ["", ...Array(3).fill("  ⎿ View Image (5 B)")]);
  assert.equal(click(h.transcript, 2, 8), true);
  assert.deepEqual(h.opened, ["b.png"]);
  for (const tool of h.tools) tool.setShowImages(true);
  assert.ok(!h.rows().some((row) => row.includes("View Image")));
  for (const tool of h.tools) tool.setShowImages(false);
  assert.deepEqual(h.rows(), ["", ...Array(3).fill("  ⎿ View Image (5 B)")]);
});

test("image presentation references survive group restoration and retire with native renderers", () => {
  const h = imageGroupHarness();
  for (let index = 0; index < 3; index++) h.finish(index);
  const ids = ["a", "b", "c"];
  const captured = ids.map((id) => h.store.getActivity(id)!.result!);
  h.store.clear({ preserveInvalidators: true });
  for (const [index, id] of ids.entries()) {
    h.store.start(id, "read", { path: `${id}.png` }, 100);
    h.store.end(id, captured[index]!, "completed", 200);
  }
  assert.deepEqual(h.rows(), ["", ...Array(3).fill("  ⎿ View Image (5 B)")]);
  h.store.retainRenderers(new Set(["a"]));
  assert.deepEqual(h.store.imageRowsFor("a").map((row) => row.toolCallId), ["a"]);
  h.store.unregisterRenderer("a");
  assert.deepEqual(h.store.imageRowsFor("a"), []);
  h.store.clear();
  assert.deepEqual(h.store.imageRowsFor("a"), []);
});

test("adds one image action below a mixed grouped summary", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const content = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  store.start("read-image", "read", { path: "screen.png" }, 100);
  store.end("read-image", captureResult({ content }, false, 10_000), "completed", 200);
  store.start("shell", "bash", { command: "pwd" }, 300);
  store.end("shell", { text: "/tmp", truncated: false, isError: false }, "completed", 400);
  const tool = decorate("read", store, {}, undefined, () => true);
  const call = tool.renderCall!(
    { path: "screen.png" },
    theme,
    context("read-image", { path: "screen.png" }),
  );

  const result = tool.renderResult(
    { content },
    { expanded: false, isPartial: false },
    theme,
    context("read-image", { path: "screen.png" }),
  );

  assert.deepEqual(trimmed(call), ["  Read 1 file, ran 1 shell command"]);
  assert.deepEqual(trimmed(result), ["  ⎿ View Image (5 B)"]);
});

test("any tool's images get the row while Pi leaves them out, and none while Pi draws them", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const args = { url: "https://example.test" };
  const content = [
    { type: "text", text: "captured" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "image", data: "aGk=", mimeType: "image/jpeg" },
  ];
  store.start("shot", "mcp__browser__screenshot", args, 100);
  store.end("shot", captureResult({ content }, false, 10_000), "completed", 200);
  let opened: readonly unknown[] = [];
  const tool = decorate("mcp__browser__screenshot", store, {}, undefined, (images) => {
    opened = images;
    return true;
  });
  const render = (showImages: boolean) => ({
    call: tool.renderCall!(args, theme, { ...context("shot", args), showImages }),
    result: tool.renderResult(
      { content },
      { expanded: false, isPartial: false },
      theme,
      { ...context("shot", args), showImages },
    ),
  });

  const hidden = render(false);
  assert.equal(trimmed(hidden.call).length, 1, "a non-read keeps its summary above the row");
  assert.deepEqual(trimmed(hidden.result), ["  ⎿ View 2 Images (7 B)"]);
  assert.equal(click(hidden.result, 0, 0), true);
  assert.deepEqual(opened, [
    { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
    { data: "aGk=", mimeType: "image/jpeg", sizeBytes: 2 },
  ]);

  const shown = render(true);
  assert.equal(trimmed(shown.call).length, 1);
  assert.deepEqual(trimmed(shown.result), []);
});

test("leaves native tool rendering untouched", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const tool = decorate("native", store, {
    renderCall: () => child(["native call"]),
  });
  assert.deepEqual(
    tool.renderCall!({}, theme, context("native-1", {})).render(80),
    ["native call"],
  );
  assert.equal(store.list().length, 0);
});

test("a managed row opens its own group when clicked, a native row is untouched", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const opened: string[] = [];
  const openers = new RuntimeOverlayOpeners();
  openers.set({
    group: (toolCallId) => {
      opened.push(toolCallId);
      return true;
    },
  });

  const tool = decorate("bash", store, {}, openers.openGroupFor);
  const args = { command: "ls" };
  const call = tool.renderCall!(args, theme, context("bash-1", args)) as any;
  assert.equal(typeof call.handleMouse, "function");
  assert.equal(click(call), true);
  assert.deepEqual(opened, ["bash-1"]);
  // Wrapping is transparent: the row still draws what it drew before.
  assert.deepEqual(trimmed(call), ["✳ Running 1 shell command…"]);

  const native = decorate("native", store);
  const nativeCall = native.renderCall({}, theme, context("native-1", {})) as any;
  assert.equal(nativeCall.handleMouse, undefined);

  openers.clear();
  assert.equal(click(call, 0, 0), false, "inert once the session is gone");
});

test("an edit row and a web row are clickable too", () => {
  const store = new GroupStore({ maxGroups: 10 });
  const opened: string[] = [];
  const openers = new RuntimeOverlayOpeners();
  openers.set({
    group: (toolCallId) => {
      opened.push(toolCallId);
      return true;
    },
  });

  const edit = decorate("edit", store, {}, openers.openGroupFor);
  const editArgs = { path: "src/a.ts" };
  const editCall = edit.renderCall(editArgs, theme, context("edit-1", editArgs)) as any;
  assert.equal(click(editCall, 0, 0), true);

  const web = decorate("web_search", store, {}, openers.openGroupFor);
  const webArgs = { query: "weather" };
  const webCall = web.renderCall(webArgs, theme, context("web-1", webArgs)) as any;
  assert.equal(click(webCall, 0, 0), true);

  assert.deepEqual(opened, ["edit-1", "web-1"]);
});
