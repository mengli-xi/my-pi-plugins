import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { GroupStore } from "../src/grouping.ts";
import { rebuildGroupsFromSession } from "../src/history.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, message: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-01-01T00:00:0${id}.000Z`,
    message,
  } as SessionEntry;
}

test("rebuilds grouped calls and results from an existing session", () => {
  const entries = [
    entry("1", {
      role: "user",
      content: [{ type: "text", text: "inspect" }],
      timestamp: 1_000,
    }),
    entry("2", {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        {
          type: "toolCall",
          id: "read-1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "toolUse",
      usage,
      timestamp: 2_000,
    }),
    entry("3", {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 3_000,
    }),
    entry("4", {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "edit-1",
          name: "edit",
          arguments: { path: "a.ts" },
        },
      ],
      stopReason: "toolUse",
      usage,
      timestamp: 4_000,
    }),
    entry("5", {
      role: "toolResult",
      toolCallId: "edit-1",
      toolName: "edit",
      content: [{ type: "text", text: "edited" }],
      details: { diff: "-1 old\n+1 new" },
      isError: false,
      timestamp: 5_000,
    }),
    entry("6", {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage,
      timestamp: 6_000,
    }),
  ];
  const store = new GroupStore({ maxGroups: 10 });

  rebuildGroupsFromSession(entries, store, {
    maxResultChars: 10_000,
    resolvePresentation: () => ({ kind: "grouped" }),
  });

  const groups = store.list();
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.status, "completed");
  assert.deepEqual(
    groups[0]?.activities.map((activity) => activity.toolName),
    ["read", "edit"],
  );
  assert.deepEqual(groups[0]?.activities[1]?.result?.details, {
    diff: "-1 old\n+1 new",
  });
  assert.equal(groups[0]?.createdAt, 2_000);
  assert.equal(groups[0]?.updatedAt, 5_000);
});

test("restores aborted and errored assistant tool calls as terminal activities", () => {
  const entries = [
    entry("1", {
      role: "assistant",
      content: [{ type: "toolCall", id: "spawn-aborted", name: "spawn_agent", arguments: { task_name: "child" } }],
      stopReason: "aborted",
      usage,
      timestamp: 1_000,
    }),
    entry("2", {
      role: "assistant",
      content: [{ type: "toolCall", id: "spawn-error", name: "spawn_agent", arguments: { task_name: "child" } }],
      stopReason: "error",
      errorMessage: "Provider failed",
      usage,
      timestamp: 2_000,
    }),
  ];
  const store = new GroupStore({ maxGroups: 10 });

  rebuildGroupsFromSession(entries, store, {
    maxResultChars: 10_000,
    resolvePresentation: () => ({ kind: "grouped" }),
  });

  assert.deepEqual(store.list().map((group) => ({
    status: group.status,
    activity: group.activities[0] && {
      status: group.activities[0].status,
      text: group.activities[0].result?.text,
    },
  })), [
    { status: "cancelled", activity: { status: "cancelled", text: "Operation aborted" } },
    { status: "failed", activity: { status: "failed", text: "Provider failed" } },
  ]);
  assert.equal(store.list().some((group) => group.runningCount > 0), false);
});

test("restores an image read's image count from the persisted tool result", () => {
  const image = "aGVsbG8=";
  const entries = [
    entry("1", {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "read-image",
        name: "read",
        arguments: { path: "screen.png" },
      }],
      stopReason: "toolUse",
      usage,
      timestamp: 1_000,
    }),
    entry("2", {
      role: "toolResult",
      toolCallId: "read-image",
      toolName: "read",
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: image, mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 2_000,
    }),
  ];
  const store = new GroupStore({ maxGroups: 10 });

  rebuildGroupsFromSession(entries, store, {
    maxResultChars: 10_000,
    resolvePresentation: () => ({ kind: "grouped" }),
  });

  assert.deepEqual(store.getActivity("read-image")?.result?.imageSummary, { count: 1, totalBytes: 5 });
});

test("rebuilds history without an invalidation storm", () => {
  const entries = [
    entry("1", {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "a.ts" },
      }],
      stopReason: "toolUse",
      usage,
      timestamp: 1_000,
    }),
    entry("2", {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 2_000,
    }),
  ];
  const store = new GroupStore({ maxGroups: 10 });
  let invalidations = 0;
  store.registerRenderer("read-1", () => invalidations++);

  rebuildGroupsFromSession(entries, store, {
    maxResultChars: 10_000,
    resolvePresentation: () => ({ kind: "grouped" }),
  });

  assert.equal(invalidations, 0);
  assert.equal(store.latest()?.status, "completed");
  store.invalidateAll();
  assert.equal(invalidations, 1);
});

test("rebuilds important calls as stable isolated timeline items", () => {
  const entries = [
    entry("1", {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "a.ts" },
      }],
      stopReason: "toolUse",
      usage,
      timestamp: 1_000,
    }),
    entry("2", {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 2_000,
    }),
    entry("3", {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "question-1",
        name: "ask_user_question",
        arguments: { questions: [{ question: "哪个城市？" }] },
      }],
      stopReason: "toolUse",
      usage,
      timestamp: 3_000,
    }),
    entry("4", {
      role: "toolResult",
      toolCallId: "question-1",
      toolName: "ask_user_question",
      content: [{ type: "text", text: "answered" }],
      details: {
        answers: [{
          questionIndex: 0,
          question: "哪个城市？",
          kind: "custom",
          answer: "新加坡",
        }],
        cancelled: false,
      },
      isError: false,
      timestamp: 4_000,
    }),
    entry("5", {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "web-1",
        name: "web_search",
        arguments: { query: "Singapore weather" },
      }],
      stopReason: "toolUse",
      usage,
      timestamp: 5_000,
    }),
    entry("6", {
      role: "toolResult",
      toolCallId: "web-1",
      toolName: "web_search",
      content: [{ type: "text", text: "1. result" }],
      details: { provider: "openai-codex", method: "ddg" },
      isError: false,
      timestamp: 12_400,
    }),
    entry("7", {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "edit-1",
        name: "edit",
        arguments: { path: "a.ts", edits: [] },
      }],
      stopReason: "toolUse",
      usage,
      timestamp: 13_000,
    }),
    entry("8", {
      role: "toolResult",
      toolCallId: "edit-1",
      toolName: "edit",
      content: [{ type: "text", text: "edited" }],
      details: { diff: "-old\n+new", firstChangedLine: 1 },
      isError: false,
      timestamp: 14_000,
    }),
  ];
  const resolvePresentation = (toolName: string) => {
    if (toolName === "ask_user_question") return { kind: "question" } as const;
    if (toolName === "web_search") return { kind: "web-search" } as const;
    if (toolName === "edit") return { kind: "single-file-edit" } as const;
    return { kind: "grouped" } as const;
  };
  const store = new GroupStore({ maxGroups: 10 });
  const options = { maxResultChars: 10_000, resolvePresentation };

  rebuildGroupsFromSession(entries, store, options);
  const first = store.list();
  assert.deepEqual(
    first.map((item) => item.presentation),
    ["grouped", "question", "web-search", "single-file-edit"],
  );
  assert.equal(first[2]?.createdAt, 5_000);
  assert.equal(first[2]?.updatedAt, 12_400);
  assert.deepEqual(first[1]?.activities[0]?.result?.details, {
    answers: [{
      questionIndex: 0,
      question: "哪个城市？",
      kind: "custom",
      answer: "新加坡",
    }],
    cancelled: false,
  });
  assert.deepEqual(first[3]?.activities[0]?.result?.details, {
    diff: "-old\n+new",
    firstChangedLine: 1,
  });

  rebuildGroupsFromSession(entries, store, options);
  assert.deepEqual(store.list(), first);
});

test("projects the latest todo snapshot during the same history pass", () => {
  const entries = [
    entry("1", {
      role: "toolResult",
      toolCallId: "todo-1",
      toolName: "todo_write",
      content: [{ type: "text", text: "updated" }],
      details: { tasks: [{ id: "a", content: "old", status: "pending" }] },
      isError: false,
      timestamp: 1_000,
    }),
    entry("2", {
      role: "toolResult",
      toolCallId: "todo-2",
      toolName: "todo_write",
      content: [{ type: "text", text: "updated" }],
      details: { tasks: [{ id: "b", content: "latest", status: "completed" }] },
      isError: false,
      timestamp: 2_000,
    }),
  ];
  const store = new GroupStore({ maxGroups: 10 });

  const projection = rebuildGroupsFromSession(entries, store, {
    maxResultChars: 10_000,
    resolvePresentation: () => ({ kind: "grouped" }),
    isTodoTool: (name) => name === "todo_write",
  });

  assert.deepEqual(projection.latestTasks, [
    { id: "b", content: "latest", subject: "latest", status: "completed" },
  ]);
  assert.equal(store.groupCount(), 1);
});

test("codemode children stay with their parent in live and resumed grouped history", () => {
  const live = new GroupStore({ maxGroups: 10 });
  live.start("code", "codemode", { code: "tools.read()" }, 10);
  live.closeBoundary();
  live.start("read", "read", { path: "a.ts" }, 11, "grouped", "code");
  live.start("deep", "bash", { command: "echo ok" }, 12, "grouped", "read");
  const result = { text: "ok", truncated: false, isError: false };
  live.end("read", result, "completed", 13);
  live.end("deep", result, "completed", 14);
  live.end("code", result, "completed", 15);
  const resumed = new GroupStore({ maxGroups: 10 });
  rebuildGroupsFromSession([
    entry("1", { role: "assistant", content: [{ type: "toolCall", id: "code", name: "codemode", arguments: { code: "tools.read()" } }], usage, stopReason: "toolUse", timestamp: 10 }),
    entry("2", { role: "toolResult", toolCallId: "code", toolName: "codemode", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 15,
      nestedCalls: { complete: true, calls: [
        { id: "read", name: "read", arguments: { path: "a.ts" }, status: "ok", durationMs: 2 },
        { id: "deep", name: "bash", arguments: { command: "echo ok" }, status: "ok", durationMs: 2 },
      ] } }),
  ], resumed, { maxResultChars: 1000, resolvePresentation: () => ({ kind: "grouped" }) });
  const membership = (store: GroupStore) => store.getByToolCallId("code")?.activities.map(({ id, parentToolCallId, toolName, status }) => ({ id, parentToolCallId, toolName, status }));
  assert.deepEqual(membership(resumed), membership(live));
  assert.equal(live.list().length, 1);
  assert.equal(resumed.list().length, 1);
  assert.equal(resumed.getByToolCallId("read")?.anchorToolCallId, "code");
  assert.match(resumed.getActivity("read")?.result?.text ?? "", /not retained/);
});

test("bounded nested history retains omitted args and errors without independent groups", () => {
  const store = new GroupStore({ maxGroups: 10 });
  rebuildGroupsFromSession([
    entry("1", { role: "toolResult", toolCallId: "code", toolName: "codemode", content: [], isError: false, timestamp: 10,
      nestedCalls: { complete: false, calls: [
        { id: "error", name: "edit", argumentsBytes: 10000, status: "error", error: "denied" },
        { id: "unfinished", name: "read", status: "unfinished" },
      ] } }),
  ], store, { maxResultChars: 1000, resolvePresentation: () => ({ kind: "grouped" }) });
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.getActivity("error")?.args, {});
  assert.equal(store.getActivity("error")?.status, "failed");
  assert.equal(store.getActivity("unfinished")?.parentToolCallId, "code");
});

test("recorded execution duration survives resume independently of assistant timestamps", () => {
  const store = new GroupStore({ maxGroups: 10 });
  rebuildGroupsFromSession([
    entry("1", { role: "assistant", content: [{ type: "toolCall", id: "code", name: "codemode", arguments: {} }], usage, stopReason: "toolUse", timestamp: 1000 }),
    entry("2", { role: "toolResult", toolCallId: "code", toolName: "codemode", content: [], isError: false, timestamp: 8000, durationMs: 250,
      nestedCalls: { complete: true, calls: [{ id: "child", name: "read", status: "ok", durationMs: 0 }] } }),
  ], store, { maxResultChars: 1000, resolvePresentation: () => ({ kind: "grouped" }) });
  assert.equal(store.getActivity("code")?.durationMs, 250);
  assert.equal(store.getActivity("child")?.durationMs, 0);
  const live = new GroupStore({ maxGroups: 10 });
  live.start("code", "codemode", {}, 1000);
  live.end("code", { text: "", truncated: false, isError: false }, "completed", 1250, 250);
  assert.equal(live.getActivity("code")?.durationMs, store.getActivity("code")?.durationMs);
});
