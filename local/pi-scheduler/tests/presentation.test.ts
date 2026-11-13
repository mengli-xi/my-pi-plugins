import assert from "node:assert/strict";
import test from "node:test";
import { describeFailure, describeInjectionPrompt, describeSchedule, describeTask, formatLocalTime } from "../src/presentation.ts";
import type { Task } from "../src/task.ts";

// Display helpers intentionally use the process local timezone.
process.env.TZ = "Asia/Shanghai";

const instant = Date.UTC(2026, 0, 2, 1, 4, 5);

const task: Task = {
  id: "12345678-1234-1234-1234-123456789abc",
  title: "Morning check",
  prompt: "check",
  schedule: { kind: "once", at: instant },
  timeZone: "Asia/Shanghai",
  toleranceMs: 300_000,
  target: { kind: "session", sessionId: "abcdefgh-1234", cwd: "/work" },
  status: "active",
  createdAt: 0,
  origin: "user",
};

test("absolute timestamps render in the requested local timezone, not UTC ISO", () => {
  assert.equal(formatLocalTime(instant, "Asia/Shanghai"), "2026-01-02 09:04:05 GMT+8");
  assert.match(describeSchedule(task), /2026-01-02 09:04:05 GMT\+8/);
  assert.doesNotMatch(describeSchedule(task), /T01:04:05\.000Z/);
});

test("task output is scannable and preserves schedule timezone semantics", () => {
  const daily = { ...task, schedule: { kind: "daily" as const, at: "09:00" } };
  const text = describeTask(daily);
  assert.match(text, /^Morning check  \[运行中\]/);
  assert.match(text, /计划: 每天 09:00（Asia\/Shanghai）/);
  assert.match(text, /目标: 会话 · abcdefgh · \/work/);
});

test("failure output uses local display time", () => {
  const text = describeFailure({
    taskId: task.id,
    scheduledTime: instant,
    finishedAt: instant,
    outcome: "failure",
    detail: "late-beyond-tolerance",
    target: "session",
  });
  assert.match(text, /2026-01-02 09:04:05 GMT\+8/);
  assert.match(text, /12345678  失败 · late-beyond-tolerance/);
});

test("injected task prompts render as task while preserving prompt preview", () => {
  assert.deepEqual(
    describeInjectionPrompt("check status\nthen summarize", { title: "Morning check" }),
    {
      summary: "task · Morning check",
      preview: ["check status", "then summarize"],
    },
  );

  assert.deepEqual(
    describeInjectionPrompt("check status\nthen summarize"),
    {
      summary: "task · check status",
      preview: ["then summarize"],
    },
  );
});

test("injected task prompt display strips terminal control sequences", () => {
  assert.deepEqual(
    describeInjectionPrompt("first\u001b[31m line\n\u001b]8;;https://example.com\u0007second", { title: "daily\u001b[0m\u202etest" }),
    {
      summary: "task · daily�test",
      preview: ["first line", "second"],
    },
  );
});
