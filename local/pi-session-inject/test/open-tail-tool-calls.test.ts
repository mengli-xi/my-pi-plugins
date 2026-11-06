import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openTailToolCallIds } from "../src/open-tail-tool-calls-v1.ts";

function assistant(toolCalls: { id: string }[], stopReason = "toolUse"): never {
  return {
    role: "assistant",
    content: toolCalls.map((tc) => ({ type: "toolCall", id: tc.id, name: "bash", arguments: {} })),
    api: "pi-messages",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as never;
}

function toolResult(id: string): never {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  } as never;
}

test("openTailToolCallIds returns empty for a clean branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-tail-clean-"));
  try {
    const session = SessionManager.create(root);
    assert.deepEqual(openTailToolCallIds(session), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("openTailToolCallIds reports unresolved tool calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-tail-open-"));
  try {
    const session = SessionManager.create(root);
    session.appendMessage(assistant([{ id: "call-1" }]));
    assert.deepEqual(openTailToolCallIds(session), ["call-1"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("openTailToolCallIds clears when the tool result lands", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-tail-closed-"));
  try {
    const session = SessionManager.create(root);
    session.appendMessage(assistant([{ id: "call-1" }]));
    session.appendMessage(toolResult("call-1"));
    assert.deepEqual(openTailToolCallIds(session), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("openTailToolCallIds reports multiple open calls and clears partially", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-tail-multi-"));
  try {
    const session = SessionManager.create(root);
    session.appendMessage(assistant([{ id: "a" }, { id: "b" }]));
    assert.deepEqual(openTailToolCallIds(session), ["a", "b"]);
    session.appendMessage(toolResult("a"));
    assert.deepEqual(openTailToolCallIds(session), ["b"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("openTailToolCallIds ignores tool calls from an aborted assistant (fail-open)", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-tail-aborted-"));
  try {
    const session = SessionManager.create(root);
    session.appendMessage(assistant([{ id: "abandoned" }], "aborted"));
    assert.deepEqual(openTailToolCallIds(session), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("openTailToolCallIds ignores tool calls from an errored assistant", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-tail-error-"));
  try {
    const session = SessionManager.create(root);
    session.appendMessage(assistant([{ id: "abandoned" }], "error"));
    assert.deepEqual(openTailToolCallIds(session), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("openTailToolCallIds clears on a user message (fail-open for malformed branch)", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-tail-user-"));
  try {
    const session = SessionManager.create(root);
    session.appendMessage(assistant([{ id: "call-1" }]));
    session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
    assert.deepEqual(openTailToolCallIds(session), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
