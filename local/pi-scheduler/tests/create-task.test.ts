import assert from "node:assert/strict";
import test from "node:test";
import { createTask, CreateTaskError, MIN_INTERVAL_MS } from "../src/create-task.ts";
import type { TaskTarget } from "../src/task.ts";

const now = Date.UTC(2026, 0, 1, 0, 0);
const agent: TaskTarget = { kind: "agent", cwd: "/w", provider: "scheduler-faux", model: "faux-model" };

test("creates a valid daily agent task with defaults", () => {
  const task = createTask({
    title: "morning check",
    prompt: "check the build",
    schedule: { kind: "daily", at: "09:00" },
    target: agent,
    origin: "agent",
    now,
  });
  assert.equal(task.status, "active");
  assert.equal(task.toleranceMs, 5 * 60 * 1000);
  assert.ok(task.timeZone.length > 0);
  assert.match(task.id, /^[0-9a-f-]{36}$/);
});

test("rejects a past one-shot time", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "once", at: now - 1000 },
    target: agent, origin: "agent", now,
  }), CreateTaskError);
});

test("rejects a sub-minute interval to stop self-wake loops", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "interval", everyMs: 1000, anchor: now },
    target: agent, origin: "agent", now,
  }), new RegExp(`>= ${MIN_INTERVAL_MS}`));
});

test("rejects a malformed time-of-day", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "daily", at: "9am" },
    target: agent, origin: "agent", now,
  }), /HH:MM/);
});

test("rejects an invalid weekday", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "weekly", dayOfWeek: 9, at: "09:00" },
    target: agent, origin: "agent", now,
  }), /dayOfWeek/);
});

test("rejects an invalid time zone", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "daily", at: "09:00" },
    timeZone: "Mars/Olympus", target: agent, origin: "agent", now,
  }), /time zone/);
});

test("rejects an incomplete agent target", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "daily", at: "09:00" },
    target: { kind: "agent", cwd: "", provider: "x", model: "y" },
    origin: "agent", now,
  }), /cwd/);
});

test("session target requires a sessionId", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "daily", at: "09:00" },
    target: { kind: "session", sessionId: "", cwd: "/work" }, origin: "agent", now,
  }), /sessionId/);
});

test("session target requires a cwd", () => {
  assert.throws(() => createTask({
    title: "t", prompt: "p", schedule: { kind: "daily", at: "09:00" },
    target: { kind: "session", sessionId: "s-1", cwd: "" }, origin: "agent", now,
  }), /cwd/);
});

test("empty prompt or title is rejected", () => {
  assert.throws(() => createTask({
    title: "  ", prompt: "p", schedule: { kind: "daily", at: "09:00" },
    target: agent, origin: "agent", now,
  }), /title/);
  assert.throws(() => createTask({
    title: "t", prompt: "  ", schedule: { kind: "daily", at: "09:00" },
    target: agent, origin: "agent", now,
  }), /prompt/);
});
