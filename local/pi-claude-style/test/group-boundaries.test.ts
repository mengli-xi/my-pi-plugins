import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GROUPING, DEFAULT_IMPORTANT_TOOLS } from "../src/config.ts";
import { assistantContentItems, assistantEndsGroup, assistantItemsShape } from "../src/group-boundaries.ts";
import { GroupStore } from "../src/grouping.ts";
import { rebuildGroupsFromSession } from "../src/history.ts";
import { resolveToolPresentation } from "../src/presentation-policy.ts";

const resolve = (name: string, args: unknown) =>
  resolveToolPresentation(name, args, { grouping: DEFAULT_GROUPING, importantTools: DEFAULT_IMPORTANT_TOOLS });

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
const text = (value: string): Block => ({ type: "text", text: value });
const thinking = (): Block => ({ type: "thinking", thinking: "…" });
const bash = (id: string): Block => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
const todo = (id: string): Block => ({ type: "toolCall", id, name: "todo", arguments: {} });
const edit = (id: string, path?: string): Block => ({ type: "toolCall", id, name: "edit", arguments: path ? { path } : {} });
const memoryPath = `/agent/pi-cc-memory/projects/${"ab".repeat(32)}/memory/topic.md`;

type Event =
  | { user: true }
  | { compact: true }
  | { runEnd: true }
  | { assistant: Block[][]; stopReason?: "toolUse" | "stop" | "error" | "aborted" };

/** Group membership in store order, comparable across stores. */
function layout(store: GroupStore): string[][] {
  return store.list().map((group) => group.activities.map((activity) => activity.id)).filter((ids) => ids.length > 0);
}

function finalContent(event: { assistant: Block[][] }): Block[] {
  return event.assistant.at(-1)!;
}

function replay(events: Event[]): string[][] {
  const entries: SessionEntry[] = [];
  const push = (message: unknown) => entries.push({
    type: "message", id: String(entries.length), parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message,
  } as SessionEntry);
  for (const event of events) {
    if ("user" in event) push({ role: "user", content: [text("go")], timestamp: 1 });
    else if ("compact" in event) {
      entries.push({ type: "compaction", id: String(entries.length), parentId: null, timestamp: "2026-01-01T00:00:00.000Z" } as SessionEntry);
    } else if ("assistant" in event) {
      const content = finalContent(event);
      const stopReason = event.stopReason ?? (content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
      push({ role: "assistant", content, stopReason, timestamp: 1 });
      if (stopReason !== "toolUse") continue;
      for (const block of content) {
        if (block.type !== "toolCall") continue;
        push({ role: "toolResult", toolCallId: block.id, toolName: block.name, content: [text("ok")], isError: false, timestamp: 1 });
      }
    }
  }
  const store = new GroupStore({ maxGroups: 100 });
  rebuildGroupsFromSession(entries, store, { maxResultChars: 1_000, resolvePresentation: resolve });
  return layout(store);
}

/**
 * Pi's live order: each update runs extension handlers (alignment) before the
 * row renders and registers its call; an edit row registers only once its
 * arguments are complete, which Pi marks after message_end; then tools start
 * in content order and finish.
 */
function live(events: Event[], store = new GroupStore({ maxGroups: 100 })): string[][] {
  let shape = "";
  const align = (content: Block[], force = false) => {
    const items = assistantContentItems(content, resolve);
    const next = assistantItemsShape(items, (id) => store.has(id));
    if (!force && next === shape) return;
    shape = next;
    store.alignAssistantMessage(items);
  };
  const render = (content: Block[], complete: boolean) => {
    for (const block of content) {
      if (block.type !== "toolCall") continue;
      const kind = resolve(block.name!, block.arguments).kind;
      if (kind === "native" || (kind === "single-file-edit" && !complete)) continue;
      store.ensure(block.id!, block.name!, block.arguments, 1, kind);
    }
  };
  for (const event of events) {
    if ("user" in event || "compact" in event) store.closeBoundary();
    else if ("runEnd" in event) store.finish("completed");
    else {
      store.beginAssistantMessage();
      shape = "";
      for (const content of event.assistant) {
        align(content);
        render(content, false);
      }
      const content = finalContent(event);
      align(content, true);
      if (assistantEndsGroup({ content, stopReason: event.stopReason })) store.closeBoundary();
      render(content, true);
      if ((event.stopReason ?? "toolUse") !== "toolUse") continue;
      for (const block of content) {
        if (block.type !== "toolCall") continue;
        const kind = resolve(block.name!, block.arguments).kind;
        if (kind === "native") continue;
        store.start(block.id!, block.name!, block.arguments, 1, kind);
        align(content);
      }
      for (const block of content) {
        if (block.type === "toolCall" && store.has(block.id!)) store.end(block.id!, { text: "ok", truncated: false, isError: false }, "completed");
      }
    }
  }
  return layout(store);
}

const cases: Array<{ name: string; events: Event[]; expected: string[][] }> = [
  {
    name: "text before calls",
    events: [{ user: true }, { assistant: [[text("checking")], [text("checking"), bash("a")], [text("checking"), bash("a"), bash("b")]] }],
    expected: [["a", "b"]],
  },
  {
    name: "leading text filled after the calls started, after a tool-only message",
    events: [
      { assistant: [[bash("p")]] },
      { assistant: [[thinking(), text(""), bash("a"), bash("b")], [thinking(), text("checking"), bash("a"), bash("b")]] },
    ],
    expected: [["p"], ["a", "b"]],
  },
  {
    name: "text between calls filled after the later call started",
    events: [{ assistant: [[bash("a"), text(" "), bash("b")], [bash("a"), text("then"), bash("b")]] }],
    expected: [["a"], ["b"]],
  },
  {
    name: "two boundaries filled late in one update",
    events: [{
      assistant: [
        [bash("a"), text(""), bash("b"), text(""), bash("c")],
        [bash("a"), text("x"), bash("b"), text("y"), bash("c")],
      ],
    }],
    expected: [["a"], ["b"], ["c"]],
  },
  {
    name: "whitespace-only text does not separate",
    events: [{ assistant: [[bash("p")]] }, { assistant: [[text("  \n"), bash("a"), text("\t"), bash("b")]] }],
    expected: [["p", "a", "b"]],
  },
  {
    name: "an edit registered after the call behind it keeps its place",
    events: [
      { assistant: [[bash("a"), edit("e", "src/a.ts"), bash("b")]] },
      { assistant: [[bash("c")]] },
    ],
    expected: [["a"], ["e"], ["b", "c"]],
  },
  {
    name: "a memory edit that is standalone until its path streams merges back",
    events: [{
      assistant: [
        [bash("a")],
        [bash("a"), edit("e")],
        [bash("a"), edit("e"), bash("b")],
        [bash("a"), edit("e", memoryPath), bash("b")],
      ],
    }],
    expected: [["a", "e", "b"]],
  },
  {
    name: "a native call separates by position only, not again when it runs",
    events: [{ assistant: [[bash("a"), todo("n"), bash("b")]] }, { assistant: [[bash("c")]] }],
    expected: [["a"], ["b", "c"]],
  },
  {
    name: "run lifecycle is not a boundary",
    events: [{ assistant: [[bash("a")]] }, { runEnd: true }, { assistant: [[bash("b")]] }],
    expected: [["a", "b"]],
  },
  {
    name: "a tool-less reply ends the group even without visible text",
    events: [{ assistant: [[bash("a")]] }, { assistant: [[thinking()]] }, { assistant: [[bash("b")]] }],
    expected: [["a"], ["b"]],
  },
  {
    name: "user messages and compactions end the group",
    events: [{ assistant: [[bash("a")]] }, { user: true }, { assistant: [[bash("b")]] }, { compact: true }, { assistant: [[bash("c")]] }],
    expected: [["a"], ["b"], ["c"]],
  },
  {
    name: "a failed reply ends the group",
    events: [{ assistant: [[bash("a")]] }, { assistant: [[bash("x")]], stopReason: "error" }, { assistant: [[bash("b")]] }],
    expected: [["a", "x"], ["b"]],
  },
];

for (const { name, events, expected } of cases) {
  test(`live grouping matches history: ${name}`, () => {
    assert.deepEqual(replay(events), expected, "history");
    assert.deepEqual(live(events), expected, "live");
  });
}

test("realignment keeps nested calls with their root and recounts both groups", () => {
  const store = new GroupStore({ maxGroups: 100 });
  store.beginAssistantMessage();
  store.ensure("a", "bash", {});
  store.ensure("b", "bash", {});
  store.start("a-child", "read", {}, 1, "grouped", "a");
  store.start("b-child", "read", {}, 1, "grouped", "b");
  store.end("a-child", { text: "", truncated: false, isError: true }, "failed");
  const before = store.getByToolCallId("a")!.id;
  store.alignAssistantMessage(assistantContentItems([bash("a"), text("then"), bash("b")], resolve));
  assert.deepEqual(layout(store), [["a", "a-child"], ["b", "b-child"]]);
  assert.equal(store.getByToolCallId("a")!.id, before, "the first group keeps its identity");
  assert.equal(store.getByToolCallId("b")!.anchorToolCallId, "b");
  assert.equal(store.getByToolCallId("a")!.failureCount, 1);
  assert.equal(store.getByToolCallId("b")!.failureCount, 0);
  assert.equal(store.getByToolCallId("b")!.runningCount, 2);
  // The last group stays open for the next call of the same run of calls.
  store.ensure("c", "bash", {});
  assert.deepEqual(layout(store), [["a", "a-child"], ["b", "b-child", "c"]]);
});

test("realignment keeps the group budget", () => {
  const store = new GroupStore({ maxGroups: 1 });
  store.beginAssistantMessage();
  store.ensure("a", "bash", {});
  store.ensure("b", "bash", {});
  store.alignAssistantMessage(assistantContentItems([bash("a"), text("then"), bash("b")], resolve));
  store.finish("failed");
  assert.equal(store.listInspectable().length, 1);
});

test("realignment keeps captured results oldest-first", () => {
  const store = new GroupStore({ maxGroups: 100, maxCapturedBytes: 100 });
  const result = (size: number) => ({ text: "x".repeat(size), truncated: false, isError: false });
  store.beginAssistantMessage();
  store.ensure("a", "bash", undefined);
  store.ensure("b", "bash", undefined);
  store.start("a-child", "read", undefined, 1, "grouped", "a");
  store.start("b-child", "read", undefined, 1, "grouped", "b");
  store.end("a", result(80), "completed");
  store.end("b", result(80), "completed");
  store.end("a-child", result(30), "completed");
  store.end("b-child", result(30), "completed");
  store.alignAssistantMessage(assistantContentItems([bash("a"), text("then"), bash("b")], resolve));
  store.closeBoundary();
  store.start("c", "bash", undefined);
  store.end("c", result(80), "completed");
  const retained = store.list().flatMap((group) => group.activities).filter((activity) => activity.result?.text);
  assert.deepEqual(retained.map((activity) => activity.id), ["c"]);
  assert.ok(store.capturedPayloadBytes() <= 100);
});

test("a call that turns native is no longer tracked", () => {
  const store = new GroupStore({ maxGroups: 100 });
  store.beginAssistantMessage();
  store.ensure("a", "bash", {});
  store.ensure("t", "todo", {});
  store.ensure("b", "bash", {});
  store.alignAssistantMessage(assistantContentItems([bash("a"), todo("t"), bash("b")], resolve));
  assert.equal(store.has("t"), false);
  assert.deepEqual(layout(store), [["a"], ["b"]]);
});

test("text replaced in place is re-read, as Pi's text_end does", () => {
  const cases: Array<[string, string, string[][]]> = [[" ", "x", [["a"], ["b"]]], ["xxx", "  ", [["a", "b"]]]];
  for (const [before, after, expected] of cases) {
    const block = text(before);
    const content = [bash("a"), block, bash("b")];
    const store = new GroupStore({ maxGroups: 100 });
    store.beginAssistantMessage();
    store.ensure("a", "bash", {});
    store.ensure("b", "bash", {});
    store.alignAssistantMessage(assistantContentItems(content, resolve));
    block.text = after;
    store.alignAssistantMessage(assistantContentItems(content, resolve));
    assert.deepEqual(layout(store), expected, `live ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    assert.deepEqual(replay([{ assistant: [JSON.parse(JSON.stringify(content)) as Block[]] }]), expected, "history");
  }
});
