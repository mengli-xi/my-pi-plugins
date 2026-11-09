import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  ActivityTimelineStore,
  rebuildActivityTimelineFromSession,
} from "../src/activity-timeline.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(timestamp: number, content: unknown[], stopReason = "toolUse"): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    usage,
    timestamp,
    api: "anthropic-messages",
    provider: "test",
    model: "model",
  } as AssistantMessage;
}

function timeline() {
  return new ActivityTimelineStore({
    isManagedTool: (name) => name !== "native",
  });
}

test("unloaded assistant messages release renderer invalidators", () => {
  const store = timeline();
  const keptMessage = assistant(1, []), unloadedMessage = assistant(2, []);
  let kept = 0, unloaded = 0;
  store.registerMessage(keptMessage, () => kept++);
  store.registerMessage(unloadedMessage, () => unloaded++);
  store.retainMessages([keptMessage]);
  rebuildActivityTimelineFromSession([entry("1", keptMessage)], store);
  assert.ok(kept > 0); assert.equal(unloaded, 0);
});

function entry(id: string, message: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    message,
  } as SessionEntry;
}

test("keeps cross-message thinking and tools in one phase until visible prose", () => {
  const store = timeline();
  const first = assistant(1_000, [
    { type: "thinking", thinking: "Inspect the code." },
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
  ]);
  const second = assistant(2_000, [
    { type: "thinking", thinking: "Check the tests." },
    { type: "toolCall", id: "grep-1", name: "grep", arguments: { pattern: "x" } },
  ]);
  const final = assistant(3_000, [
    { type: "thinking", thinking: "Write the answer." },
    { type: "text", text: "Done." },
  ], "stop");

  store.observeAssistant(first, false, 1_000);
  store.observeAssistant(second, false, 2_000);
  store.observeAssistant(final, false, 3_000);

  const phases = store.list();
  assert.equal(phases.length, 1);
  assert.equal(phases[0]?.status, "completed");
  assert.deepEqual(
    phases[0]?.items.map((item) => item.kind === "thinking"
      ? `thinking:${item.body}`
      : `tools:${item.toolCallIds.join(",")}`),
    [
      "thinking:Inspect the code.",
      "tools:read-1",
      "thinking:Check the tests.",
      "tools:grep-1",
      "thinking:Write the answer.",
    ],
  );
  assert.equal(store.thinkingForMessage(first)?.[0]?.visible, false);
  assert.equal(store.thinkingForMessage(second)?.[0]?.visible, false);
  assert.equal(store.phaseForToolCall("read-1")?.id, phases[0]?.id);
  assert.equal(store.phaseForToolCall("grep-1")?.id, phases[0]?.id);
});

test("visible prose splits phases at its exact content position", () => {
  const store = timeline();
  const message = assistant(1_000, [
    { type: "thinking", thinking: "Before." },
    { type: "toolCall", id: "before-1", name: "read", arguments: {} },
    { type: "text", text: "Progress." },
    { type: "thinking", thinking: "After." },
    { type: "toolCall", id: "after-1", name: "bash", arguments: {} },
  ]);

  store.observeAssistant(message, false, 1_000);
  assert.deepEqual(
    store.list().map((phase) => phase.items.map((item) => item.kind === "thinking"
      ? `thinking:${item.body}`
      : `tools:${item.toolCallIds.join(",")}`)),
    [
      ["thinking:Before.", "tools:before-1"],
      ["thinking:After.", "tools:after-1"],
    ],
  );
  assert.notEqual(
    store.phaseForToolCall("before-1")?.id,
    store.phaseForToolCall("after-1")?.id,
  );
});

test("chat shows only active thinking when a transcript anchor exists", () => {
  let now = 1_000;
  const store = new ActivityTimelineStore({
    clock: {
      now: () => now,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    },
    isManagedTool: () => true,
  });
  const first = assistant(1_000, [
    { type: "thinking", thinking: "First." },
    { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
  ]);
  store.observeAssistant(first, false, now);
  assert.equal(store.thinkingForMessage(first)?.[0]?.visible, false);

  now = 2_000;
  const current = assistant(2_000, [{ type: "thinking", thinking: "Current." }]);
  store.observeAssistant(current, true, now);
  assert.deepEqual(
    store.thinkingForMessage(current)?.map((item) => ({ active: item.active, visible: item.visible })),
    [{ active: true, visible: true }],
  );

  now = 3_000;
  store.observeAssistant(
    assistant(2_000, [
      { type: "thinking", thinking: "Current." },
      { type: "text", text: "Answer." },
    ], "stop"),
    false,
    now,
  );
  assert.equal(store.thinkingForMessage(current)?.[0]?.visible, false);
});

test("retains completed standalone thinking when no transcript anchor exists", () => {
  const store = timeline();
  const message = assistant(1_000, [
    { type: "thinking", thinking: "Standalone." },
    { type: "text", text: "Answer." },
  ], "stop");
  store.observeAssistant(message, false, 2_000);
  assert.equal(store.thinkingForMessage(message)?.[0]?.visible, true);
});

test("attributes archived Thinking time once to the first grouped transcript row", () => {
  const store = timeline();
  const first = assistant(1_000, [{ type: "thinking", thinking: "First." }]);
  store.observeAssistant(first, true, 1_000);
  store.observeAssistant(assistant(1_000, [
    { type: "thinking", thinking: "First." },
    { type: "toolCall", id: "read-1", name: "read", arguments: {} },
  ]), false, 4_000);

  const second = assistant(5_000, [{ type: "thinking", thinking: "Second." }]);
  store.observeAssistant(second, true, 5_000);
  store.observeAssistant(assistant(5_000, [
    { type: "thinking", thinking: "Second." },
    { type: "toolCall", id: "bash-1", name: "bash", arguments: {} },
  ]), false, 7_000);

  assert.equal(store.thinkingElapsedForToolCalls(["read-1"]), 3_000);
  assert.equal(store.thinkingElapsedForToolCalls(["bash-1"]), 2_000);
  assert.equal(store.thinkingElapsedForToolCalls(["read-1", "bash-1"]), 5_000);
  assert.equal(store.thinkingElapsedForToolCalls(["missing"]), undefined);
});

test("does not fabricate folded Thinking time from historical messages without timing", () => {
  const store = timeline();
  const message = assistant(1_000, [
    { type: "thinking", thinking: "Historical." },
    { type: "toolCall", id: "read-1", name: "read", arguments: {} },
  ]);
  store.observeAssistant(message, false, 2_000);
  assert.equal(store.thinkingElapsedForToolCalls(["read-1"]), undefined);
});

test("regression: progress prose splits the reported multi-message tool loop", () => {
  const store = timeline();
  const initial = assistant(10, [
    { type: "thinking", thinking: "Initial inspection." },
    { type: "text", text: "I have the first findings; now inspect the code." },
    { type: "toolCall", id: "tool-a", name: "read", arguments: {} },
  ]);
  const compare = assistant(20, [
    { type: "thinking", thinking: "Compare the implementation." },
    { type: "toolCall", id: "tool-b", name: "grep", arguments: {} },
  ]);
  const check = assistant(30, [
    { type: "thinking", thinking: "Check one more path." },
    { type: "toolCall", id: "tool-c", name: "bash", arguments: {} },
  ]);
  const final = assistant(40, [
    { type: "thinking", thinking: "Write the final answer." },
    { type: "text", text: "Final answer." },
  ]);
  store.observeAssistant(initial, false, 10);
  store.observeAssistant(compare, false, 20);
  store.observeAssistant(check, false, 30);
  store.observeAssistant(final, false, 40);

  const phases = store.list();
  assert.equal(phases.length, 2);
  assert.deepEqual(phases[0]?.items.map((item) => item.kind), ["thinking"]);
  assert.deepEqual(phases[1]?.items.map((item) => item.kind), [
    "tools",
    "thinking",
    "tools",
    "thinking",
    "tools",
    "thinking",
  ]);
  assert.equal(phases[1]?.hasTranscriptAnchor, true);
  assert.equal(phases[1]?.status, "completed");
  for (const message of [compare, check, final]) {
    assert.ok(store.thinkingForMessage(message)?.every((item) => !item.visible));
  }
});

test("user and compaction entries do not split a phase without visible assistant prose", () => {
  const store = timeline();
  const before = assistant(1_000, [
    { type: "thinking", thinking: "Before follow-up." },
    { type: "toolCall", id: "read-1", name: "read", arguments: {} },
  ]);
  const after = assistant(3_000, [
    { type: "thinking", thinking: "After follow-up." },
    { type: "toolCall", id: "read-2", name: "read", arguments: {} },
  ]);
  const entries = [
    entry("1", before),
    entry("2", {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 2_000,
    }),
    {
      type: "compaction",
      id: "compaction",
      parentId: null,
      timestamp: "2026-01-01T00:00:02.500Z",
      summary: "compacted",
      firstKeptEntryId: "3",
      tokensBefore: 100,
    } as SessionEntry,
    entry("3", after),
  ];
  rebuildActivityTimelineFromSession(entries, store);
  assert.equal(store.list().length, 1);
  assert.deepEqual(
    store.list()[0]?.items.flatMap((item) =>
      item.kind === "tools" ? item.toolCallIds : []
    ),
    ["read-1", "read-2"],
  );
});

test("late response identity aliases back to the provisional streaming message", () => {
  const store = timeline();
  const started = assistant(1_000, [{ type: "thinking", thinking: "First." }]);
  const updated = {
    ...assistant(1_000, [
      { type: "thinking", thinking: "First, continued." },
      { type: "toolCall", id: "read-late", name: "read", arguments: {} },
    ]),
    responseId: "response-late",
  } as AssistantMessage;
  store.observeAssistant(started, true, 1_000);
  const document = store.thinkingForMessage(started)?.[0]?.document;
  store.observeAssistant(updated, false, 2_000);

  assert.equal(store.list().length, 1);
  assert.deepEqual(store.list()[0]?.items.map((item) => item.kind), ["thinking", "tools"]);
  assert.equal(store.thinkingForMessage(updated)?.[0]?.document, document);
  assert.equal(store.thinkingForMessage(updated)?.[0]?.document.snapshot(), "First, continued.");
});

test("response identity distinguishes assistant messages sharing one timestamp", () => {
  const store = timeline();
  const first = {
    ...assistant(1_000, [{ type: "thinking", thinking: "First." }]),
    responseId: "response-1",
  } as AssistantMessage;
  const second = {
    ...assistant(1_000, [{ type: "thinking", thinking: "Second." }]),
    responseId: "response-2",
  } as AssistantMessage;
  store.observeAssistant(first, false, 1_000);
  store.observeAssistant(second, true, 2_000);
  assert.equal(store.list()[0]?.items.filter((item) => item.kind === "thinking").length, 2);
  assert.equal(store.thinkingForMessage(first)?.[0]?.document.snapshot(), "First.");
  assert.equal(store.thinkingForMessage(second)?.[0]?.document.snapshot(), "Second.");
});

test("history rebuild preserves provisional Thinking document identity", () => {
  const store = timeline();
  const message = assistant(1_000, [
    { type: "thinking", thinking: "Historical." },
    { type: "toolCall", id: "read-1", name: "read", arguments: {} },
  ]);
  store.ensureAssistant(message, false, 1_000);
  const before = store.thinkingForMessage(message)?.[0]?.document;
  assert.ok(before);
  rebuildActivityTimelineFromSession([entry("1", message)], store);
  assert.equal(store.thinkingForMessage(message)?.[0]?.document, before);
  assert.equal(store.thinkingForMessage(message)?.[0]?.visible, false);
});

test("completed Activity payloads obey phase and UTF-8 byte budgets", () => {
  const store = new ActivityTimelineStore({
    isManagedTool: () => true,
    maxPhases: 1,
    maxCapturedBytes: 8,
  });
  const first = assistant(1_000, [
    { type: "thinking", thinking: "first payload" },
    { type: "toolCall", id: "read-1", name: "read", arguments: {} },
    { type: "text", text: "First answer." },
  ]);
  const second = assistant(2_000, [
    { type: "thinking", thinking: "second payload" },
    { type: "toolCall", id: "read-2", name: "read", arguments: {} },
    { type: "text", text: "Second answer." },
  ]);
  store.observeAssistant(first, false, 1_000);
  store.observeAssistant(second, false, 2_000);

  const phases = store.list();
  assert.equal(phases.length, 2, "lightweight historical order stays stable");
  assert.equal(phases[0]?.pruned, true);
  const released = phases[0]?.items.find((item) => item.kind === "thinking");
  assert.equal(released?.kind, "thinking");
  assert.match(released?.body ?? "", /details were released/u);
  assert.equal(store.thinkingForMessage(first)?.[0]?.visible, false);
  assert.equal(store.phaseForToolCall("read-1")?.id, phases[0]?.id);
  assert.ok(store.retainedPayloadBytes() <= 8);
  assert.equal(store.retainedPhaseCount(), 0);
});

test("an active Activity phase is never pruned while it is streaming", () => {
  const store = new ActivityTimelineStore({
    isManagedTool: () => true,
    maxPhases: 1,
    maxCapturedBytes: 1,
  });
  const message = assistant(1_000, [{ type: "thinking", thinking: "still streaming" }]);
  store.observeAssistant(message, true, 1_000);
  assert.equal(store.list()[0]?.pruned, undefined);
  assert.equal(store.thinkingForMessage(message)?.[0]?.document.snapshot(), "still streaming");
});

test("history rebuild reproduces cross-message phases", () => {
  const first = assistant(1_000, [
    { type: "thinking", thinking: "First." },
    { type: "toolCall", id: "read-1", name: "read", arguments: {} },
  ]);
  const second = assistant(3_000, [
    { type: "thinking", thinking: "Second." },
    { type: "text", text: "Answer." },
  ], "stop");
  const entries = [
    entry("1", first),
    entry("2", {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 2_000,
    }),
    entry("3", second),
  ];
  const store = timeline();
  rebuildActivityTimelineFromSession(entries, store);

  assert.deepEqual(
    store.list().map((phase) => phase.items.map((item) => item.kind)),
    [["thinking", "tools", "thinking"]],
  );
  assert.equal(store.list()[0]?.status, "completed");
});
