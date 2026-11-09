import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  MouseRegion,
  Spacer,
  Text,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { ActivityTimelineStore, rebuildActivityTimelineFromSession } from "../src/activity-timeline.ts";
import {
  ActiveThinkingComponent,
  buildThinkingPreview,
  CollapsedThinkingComponent,
  ExpandedThinkingComponent,
  foldPreview,
  formatThinkingElapsed,
  installClaudeAssistantMessages,
  LogicalBulletComponent,
  planAssistantChildren,
  ThinkingDocument,
  thinkingRuns,
  withoutSpinnerHeadline,
} from "../src/assistant-message.ts";
import { CodeFenceMarkerHidingComponent } from "../src/code-fence.ts";
import { click } from "./native-mouse.ts";
import type { AssistantMessagesConfig } from "../src/types.ts";

const config: AssistantMessagesConfig = {
  enabled: true,
  style: "claude",
  marker: "●",
  markerColor: "accent",
  collapsedThinking: "preview",
  hideCodeFenceMarkers: true,
  typewriter: {
    enabled: false,
    adaptive: true,
    frameMs: 50,
    renderBudgetMs: 8,
    maxFrameMs: 200,
    minCharsPerFrame: 3,
    maxCharsPerFrame: 160,
    targetLagMs: 160,
    finalDrainMs: 1_200,
  },
};

initTheme("dark");

function child(lines: string[]): Component {
  return {
    render: () => lines,
    invalidate: () => {},
  };
}

function plainRows(lines: readonly string[]): string[] {
  return lines.map((line) =>
    line
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .trimEnd()
  );
}

test("marks one logical assistant block and aligns continuation lines", () => {
  const component = new LogicalBulletComponent(
    child([" first line", " wrapped line", "", " final paragraph"]),
    config,
    () => undefined,
  );
  assert.deepEqual(component.render(40), [
    "● first line",
    "  wrapped line",
    " ",
    "  final paragraph",
  ]);
});

test("preserves native rendering when the terminal is too narrow", () => {
  const component = new LogicalBulletComponent(
    child(["x"]),
    config,
    () => undefined,
  );
  assert.deepEqual(component.render(1), ["x"]);
});

test("can hide rendered Markdown code fence marker rows", () => {
  const component = new CodeFenceMarkerHidingComponent(
    child([
      "before",
      "```ts",
      "  const x = 1;",
      "```",
      "after",
    ]),
  );
  assert.deepEqual(component.render(80), [
    "before",
    "  const x = 1;",
    "after",
  ]);
});

test("fence markers are hidden in CC's assistant thinking but not in other Markdown", () => {
  const restore = installClaudeAssistantMessages({ on: () => {} } as unknown as ExtensionAPI, config);
  try {
    const strip = (lines: string[]) => lines.map((line) =>
      line
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .trimEnd()
    );
    const component = new AssistantMessageComponent(
      message([
        { type: "thinking", thinking: "plan\n\n```js\nconst thought = 1;\n```" },
        { type: "text", text: "answer" },
      ]),
      false,
    );
    const rendered = strip(component.render(80));
    assert.ok(rendered.some((line) => line.includes("const thought = 1;")), rendered.join("\n"));
    assert.ok(!rendered.some((line) => /^\s*```/u.test(line)), rendered.join("\n"));

    const standalone = strip(new Markdown("```ts\nconst other = 2;\n```", 0, 0, getMarkdownTheme()).render(80));
    assert.ok(standalone.some((line) => /^\s*```/u.test(line)), "Markdown outside CC keeps Pi's fences");
  } finally {
    restore();
  }
});

test("assistant message rendering hides code fence markers when configured", () => {
  const pi = {
    on: () => {},
  } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, config);
  const component = new AssistantMessageComponent(
    message([
      {
        type: "text",
        text: "before\n\n```ts\nconst x = 1;\n```\n\nafter",
      },
    ]),
  );
  const plain = component.render(80).map((line) =>
    line
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .trimEnd()
  );

  assert.ok(plain.some((line) => line.includes("before")));
  assert.ok(plain.some((line) => line.includes("const x = 1;")));
  assert.ok(plain.some((line) => line.includes("after")));
  assert.ok(!plain.some((line) => /^\s*```/u.test(line)));

  restore();
});

test("separates text from native thinking and preserves folding", () => {
  const pi = {
    on: () => {},
  } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, config);
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "inspect first" },
      { type: "text", text: "first answer" },
      { type: "thinking", thinking: "inspect second" },
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "x" },
      },
      { type: "text", text: "second answer" },
    ],
    stopReason: "toolUse",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  } as AssistantMessage;
  const component = new AssistantMessageComponent(message);
  const rendered = component.render(60);
  const plain = rendered.map((line) =>
    line
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .trimEnd()
  );

  assert.equal(plain.filter((line) => line.startsWith("● ")).length, 2);
  assert.ok(plain.some((line) => line.includes("inspect first")));
  assert.equal(
    plain.filter((line) => line.trim() === "Thinking：").length,
    2,
  );
  const answerIndex = plain.findIndex((line) => line.startsWith("● first answer"));
  const secondThinkingIndex = plain.findIndex((line) =>
    line.includes("inspect second")
  );
  assert.equal(secondThinkingIndex, answerIndex + 3);
  assert.equal(plain[answerIndex + 1], "");
  assert.ok(!plain.some((line) => line.startsWith("● inspect first")));

  component.setHideThinkingBlock(true);
  const collapsed = component.render(60).map((line) =>
    line
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .trimEnd()
  );
  assert.ok(
    collapsed.some((line) =>
      line.includes("Thinking: inspect first")
    ),
  );
  assert.ok(
    collapsed.some((line) =>
      line.includes("Thinking: inspect second")
    ),
  );
  assert.ok(!collapsed.some((line) => line.startsWith("● Thinking:")));
  assert.equal(collapsed.filter((line) => line.startsWith("● ")).length, 2);

  restore();
  const native = new AssistantMessageComponent(message).render(60);
  assert.ok(!native.some((line) => line.includes("● first answer")));
});

test("label mode keeps the working headline out of folded thinking", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, {
    ...config,
    collapsedThinking: "label",
  });
  const component = new AssistantMessageComponent(
    message([
      {
        type: "thinking",
        thinking: "**Avoiding duplicate summaries**\n\nInspect the renderer.",
      },
    ]),
  );

  component.setHideThinkingBlock(true);
  const plain = component.render(60).join("\n")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  assert.match(plain, /Thinking\.\.\./);
  assert.ok(!plain.includes("Avoiding duplicate summaries"));
  restore();
});

test("label mode merges consecutive thinking labels across tool calls", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, {
    ...config,
    collapsedThinking: "label",
  });
  const component = new AssistantMessageComponent(
    message([
      { type: "thinking", thinking: "First reasoning." },
      { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
      { type: "thinking", thinking: "Second reasoning." },
    ]),
  );

  component.setHideThinkingBlock(true);
  const plain = component.render(60).join("\n")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal(plain.match(/Thinking\.\.\./gu)?.length, 1, plain);
  restore();
});

test("a thinking document replays the current snapshot and streams later deltas", () => {
  const document = new ThinkingDocument("first");
  const seen: string[] = [];
  const unsubscribe = document.subscribe((body) => seen.push(body));
  document.update("first and second");
  unsubscribe();
  document.update("ignored after close");
  assert.deepEqual(seen, ["first", "first and second"]);
  assert.equal(document.snapshot(), "ignored after close");
});

test("a broken thinking listener cannot interrupt later deltas", () => {
  const document = new ThinkingDocument("first");
  const seen: string[] = [];
  const releaseBroken = document.subscribe(() => {
    throw new Error("panel closed during paint");
  });
  const releaseHealthy = document.subscribe((body) => seen.push(body));

  assert.doesNotThrow(() => document.update("second"));
  assert.deepEqual(seen, ["first", "second"]);
  releaseBroken();
  releaseHealthy();
});

test("formats a live thinking timer without fractional seconds", () => {
  assert.equal(formatThinkingElapsed(59_999), "59s");
  assert.equal(formatThinkingElapsed(65_000), "1m05s");
  assert.deepEqual(
    new ActiveThinkingComponent(1_000, 1, () => undefined, () => 66_000)
      .render(40),
    [" Thinking 1m05s"],
  );
});

test("expanded thinking uses a compact timed label and hanging body", () => {
  const component = new ExpandedThinkingComponent(
    child([" first line", "", " second line", "", "", " third line"]),
    1,
    () => undefined,
    2,
    () => "5s",
  );
  assert.deepEqual(component.render(40), [
    " Thinking 5s：",
    "   first line",
    "   second line",
    "   third line",
  ]);
});

test("activity mode keeps a completed block expanded until the next thinking block", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, {
    ...config,
    collapsedThinking: "activity",
  });
  const component = new AssistantMessageComponent(undefined, true);
  const reasoning = {
    type: "thinking",
    thinking: "**Checking the renderer**\n\nInspect the child layout.",
  };
  const plain = () => component.render(60).map((line) =>
    line
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .trimEnd()
  );

  component.updateContent(message([reasoning]), true);
  assert.ok(plain().some((line) => line.includes("▴ Thinking 0s")));
  assert.ok(plain().some((line) => line.includes("Inspect the child layout.")));
  assert.ok(!plain().some((line) => line.includes("Checking the renderer")));

  component.setHideThinkingBlock(true);
  assert.ok(
    plain().some((line) => line.includes("Inspect the child layout.")),
    "active thinking stays expanded even when historical thinking is hidden",
  );

  component.updateContent(
    message([reasoning, { type: "text", text: "Body begins." }]),
    true,
  );
  assert.ok(
    plain().some((line) => line.includes("▴ Thinking 0s")),
    "visible prose ends the block but leaves its full body expanded",
  );
  assert.ok(plain().some((line) => line.includes("Inspect the child layout.")));
  assert.ok(!plain().some((line) => line.includes("Checking the renderer")));
  assert.ok(plain().some((line) => line.startsWith("● Body begins.")));

  component.updateContent(
    message([
      reasoning,
      { type: "text", text: "Body begins." },
      { type: "thinking", thinking: "Inspect the next block." },
    ]),
    true,
  );
  assert.ok(plain().some((line) => line.includes("Thinking 0s")));
  assert.ok(!plain().some((line) => line.includes("Inspect the child layout.")));
  assert.ok(plain().some((line) => line.includes("Inspect the next block.")));

  component.updateContent(message([reasoning]), false);
  assert.ok(plain().some((line) => line.includes("Thinking 0s")));
  restore();
});

test("Thinking panel elapsed time updates without deltas and freezes when the run ends", () => {
  let now = 1_000;
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const clock = {
    now: () => now,
    setTimer: (callback: () => void, _delayMs: number) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer as unknown as number);
    },
  };
  const panelSnapshots: Array<{ body: string; note?: string }> = [];
  const document = new ThinkingDocument("Inspect the stream.", clock);
  document.updateTiming(1_000, undefined, true);
  const unsubscribe = document.subscribePanel((snapshot) => panelSnapshots.push(snapshot));
  assert.equal(panelSnapshots.at(-1)?.note, "0s");
  assert.equal(timers.size, 1);

  now = 2_000;
  const tickOne = [...timers.values()][0]!;
  timers.clear();
  tickOne();
  assert.equal(panelSnapshots.at(-1)?.note, "1s");
  assert.equal(timers.size, 1, "the active panel schedules its next elapsed tick");

  now = 3_500;
  document.updateTiming(1_000, 3_500, false);
  assert.equal(panelSnapshots.at(-1)?.note, "2s");
  assert.equal(timers.size, 0, "ending the run clears the elapsed timer");

  now = 20_000;
  assert.equal(document.panelSnapshot().note, "2s", "later reads cannot rewrite the frozen duration");
  unsubscribe();
  assert.equal(timers.size, 0);
});

test("consecutive activity thinking blocks share one row and one clickable document", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const opened: Array<{ body: string; liveBody?: string }> = [];
  const restore = installClaudeAssistantMessages(
    pi,
    { ...config, collapsedThinking: "activity" },
    undefined,
    (_heading, body, options) => {
      opened.push({ body, liveBody: options?.live?.snapshot() });
      return true;
    },
  );
  const component = new AssistantMessageComponent(undefined, true);
  component.updateContent(
    message([
      { type: "thinking", thinking: "Inspect the renderer." },
      { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "x.ts" } },
      { type: "thinking", thinking: "Verify the output." },
    ]),
    false,
  );

  const renderPlain = () => component.render(60).join("\n")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  component.setHideThinkingBlock(false);
  const expanded = renderPlain();
  assert.match(expanded, /Inspect the renderer\./u);
  assert.match(expanded, /Verify the output\./u);

  component.setHideThinkingBlock(true);
  const plain = renderPlain();
  assert.equal(plain.match(/^\s*Thinking\s*$/gmu)?.length, 1, plain);

  const children = (component as unknown as {
    contentContainer: { children: Component[] };
  }).contentContainer.children;
  const clickableRows = children.filter(
    (candidate) => typeof candidate.handleMouse === "function",
  );
  assert.equal(clickableRows.length, 1);
  assert.equal(click(clickableRows[0], 0, 2), true);
  assert.deepEqual(opened, [{
    body: "Inspect the renderer.\n\nVerify the output.",
    liveBody: "Inspect the renderer.\n\nVerify the output.",
  }]);
  restore();
});

test("a manually folded live block stays folded across a streamed tool call", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(
    pi,
    { ...config, collapsedThinking: "activity" },
  );
  const component = new AssistantMessageComponent(undefined, true);
  component.updateContent(
    message([{ type: "thinking", thinking: "First delta." }]),
    true,
  );
  component.setHideThinkingBlock(true);
  const children = (component as unknown as {
    contentContainer: { children: Component[] };
  }).contentContainer.children;
  const row = children.find((candidate) => typeof candidate.handleMouse === "function");
  assert.equal(click(row, 0, 2), true);
  assert.doesNotMatch(plainRows(component.render(60)).join("\n"), /First delta\./u);

  component.updateContent(
    message([
      { type: "thinking", thinking: "First delta." },
      { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
      { type: "thinking", thinking: "Second delta." },
    ]),
    true,
  );
  assert.doesNotMatch(plainRows(component.render(60)).join("\n"), /Second delta\./u);
  const updatedChildren = (component as unknown as {
    contentContainer: { children: Component[] };
  }).contentContainer.children;
  const updatedRow = updatedChildren.find((candidate) => typeof candidate.handleMouse === "function");
  assert.equal(click(updatedRow, 0, 2), true);
  const expanded = plainRows(component.render(60)).join("\n");
  assert.match(expanded, /First delta\./u);
  assert.match(expanded, /Second delta\./u);
  restore();
});

test("Thinking fold state uses its stable projection id after document eviction", () => {
  const timeline = new ActivityTimelineStore({ isManagedTool: () => true });
  const restore = installClaudeAssistantMessages({ on: () => {} } as unknown as ExtensionAPI,
    { ...config, collapsedThinking: "activity" }, undefined, () => true, undefined, timeline);
  const msg = { ...message([{ type: "thinking", thinking: "Reloadable analysis body." }]), timestamp: 1234 } as AssistantMessage;
  try {
    const first = new AssistantMessageComponent(undefined, true); first.updateContent(msg, true);
    const row = (first as any).contentContainer.children.find((child: Component) => typeof child.handleMouse === "function");
    assert.equal(click(row, 0, 2), true);
    timeline.finishActiveThinking();
    rebuildActivityTimelineFromSession([], timeline); timeline.retainMessages([]);
    rebuildActivityTimelineFromSession([{ type: "message", id: "restored", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: msg }], timeline);
    const second = new AssistantMessageComponent(msg, true);
    assert.doesNotMatch(plainRows(second.render(60)).join("\n"), /Reloadable analysis body/u);
    const restoredRow = (second as any).contentContainer.children.find((child: Component) => typeof child.handleMouse === "function");
    assert.equal(click(restoredRow, 0, 2), true);
    assert.match(plainRows(second.render(60)).join("\n"), /Reloadable analysis body/u);
  } finally { restore(); timeline.clear(); }
});

test("visible prose keeps later thinking in a separate activity row", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, {
    ...config,
    collapsedThinking: "activity",
  });
  const component = new AssistantMessageComponent(undefined, true);
  component.updateContent(
    message([
      { type: "thinking", thinking: "Before the answer." },
      { type: "text", text: "Visible answer." },
      { type: "thinking", thinking: "After the answer." },
    ]),
    false,
  );
  component.setHideThinkingBlock(true);
  const plain = component.render(60).join("\n")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal(plain.match(/^\s*Thinking\s*$/gmu)?.length, 2, plain);
  restore();
});

test("shared Activity projection folds the previous block when the next block starts", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const timeline = new ActivityTimelineStore({
    isManagedTool: () => true,
    isTranscriptAnchor: () => true,
  });
  const restore = installClaudeAssistantMessages(
    pi,
    { ...config, collapsedThinking: "activity" },
    undefined,
    () => true,
    undefined,
    timeline,
  );
  const firstMessage = {
    ...message([
      { type: "thinking", thinking: "First analysis." },
      { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
    ]),
    timestamp: 1_000,
  } as AssistantMessage;
  const secondMessage = {
    ...message([{ type: "thinking", thinking: "Second analysis." }]),
    timestamp: 2_000,
  } as AssistantMessage;
  timeline.observeAssistant(firstMessage, false, 1_000);
  timeline.observeAssistant(secondMessage, true, 2_000);
  const first = new AssistantMessageComponent(undefined, false);
  const second = new AssistantMessageComponent(undefined, true);
  first.updateContent(firstMessage, false);
  second.updateContent(secondMessage, true);

  assert.equal(timeline.thinkingForMessage(firstMessage)?.[0]?.visible, false);
  const firstFrame = first.render(60);
  assert.deepEqual(
    firstFrame,
    [],
    `an archived thinking-only assistant row must render zero physical rows:\n${firstFrame.join("\n")}`,
  );
  const activeFrame = plainRows(second.render(60));
  assert.equal(activeFrame.length, 4, activeFrame.join("\n"));
  assert.equal(activeFrame[0], "", "the current Thinking keeps one normal message gap");
  assert.match(activeFrame[1] ?? "", /Second analysis\./u);
  assert.equal(activeFrame[2], "");
  assert.match(activeFrame[3] ?? "", /^\s*▴ Thinking(?: \S+)?$/u);
  const toolToThinking = ["Tool transcript", ...plainRows(firstFrame), ...activeFrame];
  assert.equal(toolToThinking.length, 5, toolToThinking.join("\n"));
  assert.equal(toolToThinking[0], "Tool transcript");
  assert.equal(toolToThinking[1], "");
  assert.match(toolToThinking[2] ?? "", /Second analysis\./u);
  assert.equal(toolToThinking[3], "");
  assert.match(toolToThinking[4] ?? "", /^\s*▴ Thinking(?: \S+)?$/u);

  const progressMessage = {
    ...message([{ type: "text", text: "Visible progress." }]),
    timestamp: 3_000,
  } as AssistantMessage;
  timeline.observeAssistant(progressMessage, true, 3_000);
  assert.match(plainRows(second.render(60)).join("\n"), /Second analysis\./u);
  const thirdMessage = {
    ...message([{ type: "thinking", thinking: "Third analysis." }]),
    timestamp: 4_000,
  } as AssistantMessage;
  timeline.observeAssistant(thirdMessage, true, 4_000);
  const third = new AssistantMessageComponent(undefined, true);
  third.updateContent(thirdMessage, true);
  assert.deepEqual(second.render(60), []);
  assert.match(plainRows(third.render(60)).join("\n"), /Third analysis\./u);
  const progress = new AssistantMessageComponent(undefined, true);
  progress.updateContent(progressMessage, true);
  const progressFrame = plainRows(progress.render(60));
  assert.equal(progressFrame.length, 2, progressFrame.join("\n"));
  assert.equal(progressFrame[0], "", "visible prose keeps one normal message gap");
  assert.ok(progressFrame[1]?.includes("Visible progress."));
  assert.deepEqual(
    [
      "Tool transcript",
      ...plainRows(first.render(60)),
      ...plainRows(second.render(60)),
      ...progressFrame,
    ].map((line) => line.trim()),
    ["Tool transcript", "", "● Visible progress."],
    "archived Thinking rows cannot accumulate gaps before visible prose",
  );
  restore();
});

test("logical spacers survive merged Thinking but collapse around archived Thinking", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, {
    ...config,
    collapsedThinking: "activity",
  });
  const merged = new AssistantMessageComponent(undefined, false);
  merged.updateContent(
    message([
      { type: "thinking", thinking: "First reasoning." },
      { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
      { type: "thinking", thinking: "Second reasoning." },
      { type: "text", text: "Visible body." },
    ]),
    false,
  );
  merged.setHideThinkingBlock(true);
  const mergedRows = plainRows(merged.render(60));
  const thinking = mergedRows.findIndex((line) => /^\s*Thinking/u.test(line));
  const body = mergedRows.findIndex((line) => line.includes("Visible body."));
  assert.equal(body, thinking + 2, mergedRows.join("\n"));
  assert.equal(mergedRows[thinking + 1], "");
  restore();

  const timeline = new ActivityTimelineStore({
    isManagedTool: () => true,
    isTranscriptAnchor: () => true,
  });
  const restoreProjected = installClaudeAssistantMessages(
    pi,
    { ...config, collapsedThinking: "activity" },
    undefined,
    () => true,
    undefined,
    timeline,
  );
  const between = {
    ...message([
      { type: "text", text: "Before prose." },
      { type: "thinking", thinking: "Archived." },
      { type: "toolCall", id: "tool-2", name: "read", arguments: {} },
      { type: "text", text: "After prose." },
    ]),
    timestamp: 2_000,
  } as AssistantMessage;
  timeline.observeAssistant(between, false, 2_000);
  const projected = new AssistantMessageComponent(undefined, false);
  projected.updateContent(between, false);
  projected.setHideThinkingBlock(true);
  const projectedRows = plainRows(projected.render(60));
  const before = projectedRows.findIndex((line) => line.includes("Before prose."));
  const after = projectedRows.findIndex((line) => line.includes("After prose."));
  assert.equal(after, before + 2, projectedRows.join("\n"));
  assert.equal(projectedRows[before + 1], "");

  const narrowMessage = {
    ...message([{ type: "thinking", thinking: "Narrow." }]),
    timestamp: 3_000,
  } as AssistantMessage;
  timeline.observeAssistant(narrowMessage, true, 3_000);
  const narrow = new AssistantMessageComponent(undefined, true);
  narrow.updateContent(narrowMessage, true);
  assert.deepEqual(plainRows(narrow.render(1)), []);
  restoreProjected();
});

test("multiple archived Thinking messages add no blank rows before the next visible block", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const timeline = new ActivityTimelineStore({
    isManagedTool: () => true,
    isTranscriptAnchor: () => true,
  });
  const restore = installClaudeAssistantMessages(
    pi,
    { ...config, collapsedThinking: "activity" },
    undefined,
    () => true,
    undefined,
    timeline,
  );
  const archivedMessages = Array.from({ length: 5 }, (_, index) => ({
    ...message([
      { type: "thinking", thinking: `Analysis ${index + 1}.` },
      { type: "toolCall", id: `tool-${index + 1}`, name: "read", arguments: {} },
    ]),
    timestamp: 1_000 + index,
  } as AssistantMessage));
  const bodyMessage = {
    ...message([{ type: "text", text: "Final body." }]),
    timestamp: 2_000,
  } as AssistantMessage;
  for (const current of archivedMessages) timeline.observeAssistant(current, false, current.timestamp);
  timeline.observeAssistant(bodyMessage, false, bodyMessage.timestamp);

  const archivedFrames = archivedMessages.map((current) => {
    const component = new AssistantMessageComponent(undefined, false);
    component.updateContent(current, false);
    return plainRows(component.render(60));
  });
  assert.ok(archivedFrames.every((frame) => frame.length === 0), JSON.stringify(archivedFrames));

  const body = new AssistantMessageComponent(undefined, false);
  body.updateContent(bodyMessage, false);
  assert.deepEqual(
    ["Tool transcript", ...archivedFrames.flat(), ...plainRows(body.render(60))]
      .map((line) => line.trim()),
    ["Tool transcript", "", "● Final body."],
  );
  restore();
});

test("the latest Thinking footer toggles its body and preserves the choice across deltas", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const opened: string[] = [];
  const restore = installClaudeAssistantMessages(
    pi,
    { ...config, collapsedThinking: "activity" },
    undefined,
    (_heading, body) => {
      opened.push(body);
      return true;
    },
  );
  const component = new AssistantMessageComponent(undefined, true);
  component.updateContent(
    message([{ type: "thinking", thinking: "Inspect the live renderer." }]),
    true,
  );
  const clickable = () => (component as unknown as {
    contentContainer: { children: Component[] };
  }).contentContainer.children.find((candidate) => typeof candidate.handleMouse === "function");
  const rendered = () => plainRows(component.render(60)).join("\n");

  assert.match(rendered(), /Inspect the live renderer\.\n\n\s*▴ Thinking 0s/u);
  const expandedRow = clickable();
  assert.equal(click(expandedRow, 0, 2), false, "the Markdown body remains selectable");
  assert.equal(click(expandedRow, expandedRow!.render(60).length - 1, 2), true);
  assert.match(rendered(), /▸ Thinking 0s/u);
  assert.doesNotMatch(rendered(), /Inspect the live renderer\./u);
  assert.deepEqual(opened, [], "the disclosure click does not open the TextPanel");

  component.updateContent(
    message([{ type: "thinking", thinking: "Inspect the live renderer.\n\nRead the next delta." }]),
    true,
  );
  assert.match(rendered(), /▸ Thinking 0s/u);
  assert.doesNotMatch(rendered(), /Read the next delta\./u);
  assert.equal(clickable()?.handleMouse?.({
    type: "click",
    button: "left",
    x: 2,
    y: 0,
    screenX: 2,
    screenY: 0,
    width: 60,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  })?.handled, true);
  assert.match(rendered(), /Read the next delta\.\n\n\s*▴ Thinking 0s/u);

  const reopenedRow = clickable();
  assert.equal(click(reopenedRow, reopenedRow!.render(60).length - 1, 2), true);
  component.updateContent(
    message([
      { type: "thinking", thinking: "Inspect the live renderer.\n\nRead the next delta." },
      { type: "text", text: "Done." },
      { type: "thinking", thinking: "A new block starts expanded." },
    ]),
    true,
  );
  assert.match(rendered(), /A new block starts expanded\.\n\n\s*▴ Thinking 0s/u);
  const historicalRows = (component as unknown as {
    contentContainer: { children: Component[] };
  }).contentContainer.children.filter((candidate) => typeof candidate.handleMouse === "function");
  assert.equal(historicalRows.length, 2);
  assert.equal(click(historicalRows[0], 0, 2), true);
  assert.deepEqual(opened, ["Inspect the live renderer.\n\nRead the next delta."]);
  restore();
});

test("activity mode preserves full Markdown layout until the next thinking block", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, {
    ...config,
    collapsedThinking: "activity",
    hideCodeFenceMarkers: false,
  });
  const component = new AssistantMessageComponent(undefined, true);
  component.updateContent(
    message([{ type: "thinking", thinking: "# Plan\n\nFirst **bold** paragraph.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\nLast `inline`." }]),
    true,
  );
  component.setHideThinkingBlock(true);
  const plain = plainRows(component.render(60)).map((line) => line.trimEnd());
  const footer = plain.findIndex((line) => line.includes("▴ Thinking 0s"));
  assert.ok(footer >= 0, plain.join("\n"));
  const body = plain.slice(0, footer);
  assert.ok(body.some((line) => line.trim() === "Plan"));
  assert.ok(body.some((line) => line.trim() === "First bold paragraph."));
  assert.ok(body.some((line) => line.trim() === "- one"));
  assert.ok(body.some((line) => line.trim() === "- two"));
  assert.ok(body.some((line) => line.trim() === "const x = 1;"));
  assert.ok(body.some((line) => line.trim() === "Last inline."));
  assert.ok(body.filter((line) => line === "").length >= 4, body.join("\n"));
  assert.doesNotMatch(body.join("\n"), /\*\*bold\*\*|`inline`/u);

  component.updateContent(
    message([
      { type: "thinking", thinking: "# Plan\n\nFirst **bold** paragraph." },
      { type: "text", text: "Done." },
    ]),
    true,
  );
  const retained = plainRows(component.render(60)).join("\n");
  assert.match(retained, /▴ Thinking 0s/u);
  assert.match(retained, /First bold paragraph/u);
  component.updateContent(
    message([
      { type: "thinking", thinking: "# Plan\n\nFirst **bold** paragraph." },
      { type: "text", text: "Done." },
      { type: "thinking", thinking: "Next block." },
    ]),
    true,
  );
  const handedOff = plainRows(component.render(60)).join("\n");
  assert.doesNotMatch(handedOff, /First bold paragraph/u);
  assert.match(handedOff, /Next block\./u);
  restore();
});

test("activity mode shows full unstructured live thinking with a timer", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, {
    ...config,
    collapsedThinking: "activity",
  });
  const component = new AssistantMessageComponent(undefined, true);
  component.updateContent(
    message([{ type: "thinking", thinking: "Inspect the child layout." }]),
    true,
  );
  component.setHideThinkingBlock(true);
  const plain = component.render(60).join("\n")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(plain, /▴ Thinking \d+s/u);
  assert.match(plain, /Inspect the child layout\./u);
  restore();
});

test("live presentation removes only the spinner-owned headline", () => {
  const source = message([
    {
      type: "thinking",
      thinking: "**Checking the renderer**\n\nInspect the child layout.",
    },
  ]);
  const presentation = withoutSpinnerHeadline(source);
  assert.equal(presentation.spinnerOwnsHeadline, true);
  assert.equal(
    presentation.message.content[0]?.type === "thinking"
      ? presentation.message.content[0].thinking
      : undefined,
    "Inspect the child layout.",
  );
  assert.equal(
    source.content[0]?.type === "thinking"
      ? source.content[0].thinking
      : undefined,
    "**Checking the renderer**\n\nInspect the child layout.",
  );
});

function message(
  content: unknown[],
  stopReason = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function visiblePlans(
  plans: ReturnType<typeof planAssistantChildren>,
): Array<{ index: number; role: "text" | "thinking"; runIndex?: number }> {
  return plans.map(({ index, role, runIndex }) => ({
    index,
    role,
    ...(runIndex === undefined ? {} : { runIndex }),
  }));
}

test("classifies children by component shape, not by position", () => {
  const content = [
    { type: "thinking", thinking: "reason" },
    { type: "text", text: "answer" },
  ];
  const children: Component[] = [
    new Spacer(1),
    // An unexpected child from another extension, or a layout change in Pi.
    new Spacer(1),
    new Markdown("reason", 1, 0, undefined as never, { italic: true }),
    new Spacer(1),
    new Markdown("answer", 1, 0, undefined as never),
  ];
  assert.deepEqual(visiblePlans(planAssistantChildren(children, message(content))), [
    { index: 2, role: "thinking", runIndex: 0 },
    { index: 4, role: "text" },
  ]);
});

test("classifies Pi 1.2 thinking through its MouseRegion wrapper", () => {
  const thinking = new Markdown("reason", 1, 0, undefined as never, { italic: true });
  const children: Component[] = [
    new Spacer(1),
    new MouseRegion(thinking, () => undefined),
    new Spacer(1),
    new Markdown("answer", 1, 0, undefined as never),
  ];
  const plans = planAssistantChildren(
    children,
    message([
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "answer" },
    ]),
  );
  assert.equal(plans[0]?.component, thinking);
  assert.deepEqual(visiblePlans(plans), [
    { index: 1, role: "thinking", runIndex: 0 },
    { index: 3, role: "text" },
  ]);
});

test("a click on decorated thinking opens CC details without toggling Pi's own region", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const opened: string[] = [];
  const restore = installClaudeAssistantMessages(
    pi,
    config,
    undefined,
    (_heading, body) => {
      opened.push(body);
      return true;
    },
  );
  const component = new AssistantMessageComponent(
    message([{ type: "thinking", thinking: "reason" }]),
    false,
  );
  let nativeUpdates = 0;
  const nativeUpdate = component.updateContent.bind(component);
  component.updateContent = ((...args: Parameters<typeof component.updateContent>) => {
    nativeUpdates++;
    return nativeUpdate(...args);
  }) as typeof component.updateContent;
  const row = (component as unknown as {
    contentContainer: { children: Component[] };
  }).contentContainer.children.find((candidate) => typeof candidate.handleMouse === "function");
  assert.ok(row, "decorated thinking takes Pi's mouse events");
  const nativeResult = row.handleMouse?.({
    type: "click",
    button: "left",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 60,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  });
  assert.equal(nativeResult?.handled, true);
  assert.equal(nativeUpdates, 0, "CC action must not also toggle Pi's MouseRegion");
  assert.equal(click(row), true);
  assert.deepEqual(opened, ["reason", "reason"]);
  restore();
});

test("keeps a trailing error row out of the thinking sequence", () => {
  const content = [{ type: "text", text: "partial" }];
  const children: Component[] = [
    new Spacer(1),
    new Markdown("partial", 1, 0, undefined as never),
    new Spacer(1),
    new Text("Error: Model stopped because it reached the maximum output token limit."),
  ];
  const plans = planAssistantChildren(children, message(content, "length"));
  assert.deepEqual(visiblePlans(plans), [{ index: 1, role: "text" }]);
});

test("merges thinking across tool calls and splits only at visible prose", () => {
  assert.deepEqual(
    thinkingRuns(
      message([
        { type: "thinking", thinking: "one" },
        { type: "thinking", thinking: "" },
        { type: "thinking", thinking: "two" },
        { type: "toolCall", id: "t", name: "read", arguments: {} },
        { type: "thinking", thinking: "three" },
        { type: "text", text: "Visible answer." },
        { type: "thinking", thinking: "four" },
      ]),
    ),
    ["one\n\ntwo\n\nthree", "four"],
  );
});

test("maps native thinking children across a tool call to one logical run", () => {
  const children: Component[] = [
    new Text("Thinking..."),
    new Spacer(1),
    new Text("Thinking..."),
  ];
  assert.deepEqual(
    visiblePlans(planAssistantChildren(
      children,
      message([
        { type: "thinking", thinking: "first" },
        { type: "toolCall", id: "t", name: "read", arguments: {} },
        { type: "thinking", thinking: "second" },
      ]),
    )),
    [
      { index: 0, role: "thinking", runIndex: 0 },
      { index: 2, role: "thinking", runIndex: 0 },
    ],
  );
});

test("flattens a thinking run into one previewable line", () => {
  assert.equal(
    buildThinkingPreview("  first line\n\nsecond ```const x = 1``` tail  "),
    "first line second tail",
  );
});

test("falls back to the static label when the preview cannot fit", () => {
  const component = new CollapsedThinkingComponent("some reasoning", 1, () => undefined);
  assert.deepEqual(component.render(200), [" Thinking: some reasoning"]);
  assert.deepEqual(
    component.render(20).map((line) =>
      line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    ),
    [" Thinking..."],
  );
});

test("a long folded run runs to a second, hanging line", () => {
  const preview = "first sentence about the config, then a second one that will "
    + "not fit on one line, and a third that will not fit either";
  const rows = new CollapsedThinkingComponent(preview, 1, () => undefined)
    .render(52);

  assert.equal(rows.length, 2, "never more than two rows");
  assert.match(rows[0]!, /^ Thinking: first sentence/);
  // The continuation hangs under the first line's text, not under the prefix.
  assert.match(rows[1]!, /^ {11}\S/);
  assert.ok(rows[1]!.endsWith("…"), "and says there is more");
  for (const row of rows) assert.ok(visibleWidth(row) <= 52, row);
});

test("a folded run that fits on one line does not gain a second", () => {
  const rows = new CollapsedThinkingComponent("short thought", 1, () => undefined)
    .render(60);
  assert.deepEqual(rows, [" Thinking: short thought"]);
});

test("folded thinking keeps Markdown formatting across repeated renders", () => {
  const component = new CollapsedThinkingComponent(
    "**important** and `inline`",
    1,
    () => undefined,
  );
  const first = component.render(60);
  const second = component.render(60);

  assert.deepEqual(second, first);
  for (const row of second) {
    assert.ok(!row.includes("**"), "bold markers must be rendered, not printed");
    assert.ok(!row.includes("`inline`"), "inline-code markers must be rendered, not printed");
  }
});

test("folded thinking survives repeated streaming updates", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, config);
  const component = new AssistantMessageComponent(
    message([{ type: "thinking", thinking: "**first** thought" }]),
    true,
  );

  component.updateContent(
    message([{ type: "thinking", thinking: "**second** thought" }]),
    true,
  );
  const first = component.render(60);
  const second = component.render(60);
  const plain = second.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  assert.deepEqual(second, first);
  assert.match(plain, /Thinking: second thought/);
  assert.ok(!plain.includes("**"));
  restore();
});

test("folding breaks CJK on a column, since it has no spaces to break on", () => {
  const preview = "用户想让我先看一下配置文件，然后决定改哪里，这句话足够长了";
  const rows = foldPreview(preview, 20, 2);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(visibleWidth(row) <= 20, `${row} too wide`);
  assert.ok(rows[1]!.endsWith("…"));
  // The rows carry the start of the run, in order and without gaps.
  assert.ok(preview.startsWith(rows[0]!));
  assert.ok(preview.startsWith(rows[0]! + rows[1]!.replace("…", "")));
});

test("a reload's fresh install takes over from the previous one", () => {
  // `/reload` builds a new module instance without running the old disposer,
  // so installing again must adopt the prototype rather than bail out — a
  // stale patch keeps decorating rows on behalf of a dead session.
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  } as AssistantMessage;

  const markerOf = () =>
    new AssistantMessageComponent(message)
      .render(60)
      .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\]133;[ABC]\x07/g, ""))
      .find((line) => line.includes("answer"))
      ?.trimStart()[0];

  const restoreFirst = installClaudeAssistantMessages(pi, config);
  assert.equal(markerOf(), "●");

  const prototype = AssistantMessageComponent.prototype as unknown as Record<symbol, unknown>;
  const patchKey = Object.getOwnPropertySymbols(prototype).find((symbol) =>
    Symbol.keyFor(symbol) === "pi-claude-transcript.assistant-message.patch");
  assert.ok(patchKey);
  const previous = prototype[patchKey] as Record<string, unknown>;
  prototype[patchKey] = { ...previous, owner: Symbol("foreign reload owner") };

  const restoreSecond = installClaudeAssistantMessages(pi, {
    ...config,
    marker: "◆",
  });
  assert.equal(markerOf(), "◆", "the second install owns the prototype");

  // Whichever disposer runs, pi's own rendering comes back.
  restoreSecond();
  assert.equal(markerOf(), "a", "unmarked native text");
  restoreFirst();
  assert.equal(markerOf(), "a");
});

test("a native single assistant error sanitizes presentation without mutating its source", () => {
  const pi = { on: () => {} } as unknown as ExtensionAPI;
  const restore = installClaudeAssistantMessages(pi, config);
  const source = {
    role: "assistant",
    content: [],
    provider: "other-provider",
    api: "other-api",
    model: "model",
    stopReason: "error",
    errorMessage: "failed\u001b]8;;https://example.invalid\u0007 link\u001b]8;;\u0007\u202e",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as unknown as AssistantMessage;
  try {
    const component = new AssistantMessageComponent(source);
    assert.doesNotMatch(plainRows(component.render(120)).join("\n"), /[\u001b\u0007\u202e]/u);
    assert.strictEqual(
      (component as unknown as { lastMessage: AssistantMessage }).lastMessage,
      source,
      "the presentation clone cannot replace the provider/session message",
    );
    assert.match(source.errorMessage ?? "", /\u001b/u);
  } finally {
    restore();
  }
});
