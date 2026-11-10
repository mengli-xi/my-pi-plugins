import assert from "node:assert/strict";
import test from "node:test";
import { formatQuestionDisplay } from "../src/question-format.ts";
import {
  formatWebDuration,
  formatWebHeader,
  formatWebStatus,
} from "../src/web-format.ts";
import type { CapturedResult, ToolActivity } from "../src/types.ts";

function result(
  details: unknown,
  options: Partial<CapturedResult> = {},
): CapturedResult {
  return {
    text: "",
    truncated: false,
    isError: false,
    details,
    ...options,
  };
}

test("formats answered questions from structured details in argument order", () => {
  const display = formatQuestionDisplay(
    {
      questions: [
        { question: "哪个城市？", header: "城市" },
        { question: "需要哪些指标？" },
      ],
    },
    result({
      answers: [
        {
          questionIndex: 1,
          question: "ignored fallback",
          kind: "multi",
          answer: null,
          selected: ["温度", "湿度"],
          notes: "摄氏度",
        },
        {
          questionIndex: 0,
          question: "ignored fallback",
          kind: "custom",
          answer: "新加坡",
        },
      ],
      cancelled: false,
    }),
  );
  assert.equal(display.title, "User answered Agent's questions:");
  assert.deepEqual(display.rows, [
    { kind: "answer", title: "城市", answer: "新加坡" },
    { kind: "answer", title: "需要哪些指标？", answer: "温度, 湿度" },
    { kind: "note", text: "摄氏度" },
  ]);
});

test("keeps selected labels and custom text in multi answers", () => {
  for (const [selected, answer, expected] of [
    [["Redis", "Memory"], "Local disk", "Redis, Memory, Local disk"],
    [undefined, "Local disk", "Local disk"],
    [[], null, "No selection"],
  ] as const) {
    const display = formatQuestionDisplay({}, result({
      answers: [{ questionIndex: 0, kind: "multi", answer, selected }],
      cancelled: false,
    }));
    assert.deepEqual(display.rows, [
      { kind: "answer", title: "Question 1", answer: expected },
    ]);
  }
});

test("shows global notes and only explicitly unanswered question indexes", () => {
  const args = { questions: [
    { question: "Which cache?", header: "Cache" },
    { question: "When to refresh?" },
    { question: "How long?", header: "TTL" },
  ] };
  const display = formatQuestionDisplay(args, result({
    answers: [{ questionIndex: 0, kind: "option", answer: "Redis", notes: "Shared" }],
    cancelled: false,
    unanswered: [2],
    globalNote: "Keep the current fallback.\nReview later.",
  }));
  assert.equal(display.state, "answered");
  assert.deepEqual(display.rows, [
    { kind: "answer", title: "Cache", answer: "Redis" },
    { kind: "note", text: "Shared" },
    { kind: "text", text: "  ⎿ Unanswered: Question 3 (TTL)" },
    { kind: "text", text: "  ⎿ Global note: Keep the current fallback.\nReview later." },
  ]);
  assert.deepEqual(formatQuestionDisplay(args, result({
    answers: [{ questionIndex: 0, kind: "option", answer: "Redis" }],
    cancelled: false,
  })).rows, [{ kind: "answer", title: "Cache", answer: "Redis" }]);
});

test("keeps global notes without treating them as question answers", () => {
  for (const cancelled of [false, true]) {
    const display = formatQuestionDisplay({}, result({
      answers: [],
      cancelled,
      globalNote: "Need more time.",
    }));
    assert.equal(display.state, cancelled ? "declined" : "answered");
    assert.deepEqual(display.rows, [{ kind: "text", text: "  ⎿ Global note: Need more time." }]);
  }
  for (const details of [
    { answers: [], cancelled: false, globalNote: 42 },
    { answers: [], cancelled: false, unanswered: [-1] },
    { answers: [], cancelled: false, unanswered: ["1"] },
  ]) {
    assert.equal(formatQuestionDisplay({}, result(details)).title, "Questionnaire completed");
  }
});

test("treats questionnaire errors as failures rather than user declines", () => {
  for (const details of [
    { answers: [], cancelled: true, error: "no_ui" },
    { error: "no_ui" },
  ]) {
    const display = formatQuestionDisplay({}, result(details, {
      text: "User declined to answer questions",
    }));
    assert.equal(display.state, "failed");
    assert.equal(display.title, "Questionnaire failed");
    assert.deepEqual(display.rows, [{ kind: "text", text: "  ⎿ no_ui" }]);
  }
  assert.equal(formatQuestionDisplay({}, result({
    answers: [], cancelled: true, error: false,
  })).state, "declined");
});

test("formats declined, partial cancellation, malformed and failed questions", () => {
  assert.equal(
    formatQuestionDisplay(
      {},
      result({ answers: [], cancelled: true }),
    ).title,
    "User declined the questions",
  );
  const partial = formatQuestionDisplay(
    { questions: [{ question: "继续？" }] },
    result({
      answers: [
        {
          questionIndex: 0,
          question: "继续？",
          kind: "option",
          answer: "是",
        },
      ],
      cancelled: true,
    }),
  );
  assert.equal(partial.state, "cancelled");
  assert.deepEqual(partial.rows, [{ kind: "answer", title: "继续？", answer: "是" }]);
  assert.equal(
    formatQuestionDisplay({}, result({ broken: true })).title,
    "Questionnaire completed",
  );
  assert.deepEqual(
    formatQuestionDisplay(
      {},
      result(undefined, { isError: true, text: "boom\nfull trace" }),
    ).rows,
    [{ kind: "text", text: "  ⎿ boom" }],
  );
});

test("formats discussion and explanation controls as distinct states", () => {
  const args = { questions: [{ question: "Which cache should this endpoint use?" }] };
  const chat = formatQuestionDisplay(args, result({
    answers: [],
    cancelled: false,
    chat: {
      questionIndex: 0,
      question: "ignored fallback",
      notes: "The options miss a local cache.",
    },
  }));
  assert.equal(chat.state, "chat");
  assert.equal(chat.title, "Chat about this:");
  assert.deepEqual(chat.rows, [
    { kind: "text", text: "  ⎿ Which cache should this endpoint use?" },
    { kind: "note", text: "The options miss a local cache." },
  ]);

  const explain = formatQuestionDisplay(args, result({
    answers: [],
    cancelled: false,
    explain: {
      questionIndex: 0,
      question: "ignored fallback",
    },
  }));
  assert.equal(explain.state, "explain");
  assert.equal(explain.title, "Explain More:");
  assert.deepEqual(explain.rows, [
    { kind: "text", text: "  ⎿ Which cache should this endpoint use?" },
  ]);

  assert.equal(formatQuestionDisplay(args, result({
    answers: [],
    cancelled: false,
    chat: { questionIndex: 0 },
    explain: { questionIndex: 0 },
  })).title, "Questionnaire completed");
});

function activity(
  status: ToolActivity["status"],
  options: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    id: "web-1",
    groupId: "group-1",
    toolName: "web_search",
    args: { query: "weather" },
    status,
    startedAt: 1_000,
    endedAt: status === "running" ? undefined : 8_400,
    ...options,
  };
}

test("formats web headers, duration and terminal status without raw results", () => {
  assert.equal(
    formatWebHeader("web-search", { query: 'Singapore "weather"' }),
    'Web Search("Singapore \\"weather\\"")',
  );
  assert.equal(
    formatWebHeader("web-fetch", { url: "https://example.com" }),
    'Web Fetch("https://example.com")',
  );
  assert.equal(formatWebDuration(1), "1s");
  assert.equal(formatWebDuration(7_400), "7s");
  assert.equal(formatWebStatus("web-search", activity("running")), "Searching…");
  assert.equal(
    formatWebStatus("web-search", activity("completed")),
    "Did 1 search in 7s",
  );
  assert.equal(
    formatWebStatus("web-fetch", activity("completed")),
    "Fetched in 7s",
  );
  assert.equal(
    formatWebStatus(
      "web-search",
      activity("failed", {
        result: {
          text: "network unavailable\nstack",
          truncated: false,
          isError: true,
        },
      }),
    ),
    "Search failed in 7s · network unavailable",
  );
});

for (const kind of ["chat", "explain"] as const) {
  test(`keeps prior answers and notes before mixed ${kind} control`, () => {
    const args = { questions: [{ header: "Cache", question: "Which cache?" }, { question: "When to refresh?" }] };
    const display = formatQuestionDisplay(args, result({
      answers: [{ questionIndex: 0, question: "Which cache?", kind: "option", answer: "Redis", notes: "Use shared cache" }],
      cancelled: false,
      [kind]: { questionIndex: 1, question: "When to refresh?", notes: "Explain the tradeoff" },
    }));
    assert.equal(display.state, kind);
    assert.deepEqual(display.rows, [
      { kind: "answer", title: "Cache", answer: "Redis" },
      { kind: "note", text: "Use shared cache" },
      { kind: "text", text: "  ⎿ When to refresh?" },
      { kind: "note", text: "Explain the tradeoff" },
    ]);
  });
}
