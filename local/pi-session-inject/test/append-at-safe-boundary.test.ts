import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendAtSafeBoundary, proveNativeEntry, type SafeAppendOptions } from "../src/append-at-safe-boundary-v1.ts";
import type { IdleAppendBoundary, LiveMessagePort } from "../src/types.ts";

const CUSTOM_TYPE = "scheduler-injection-v1";

function options(injectionId: string, content: string): SafeAppendOptions {
  return {
    customType: CUSTOM_TYPE,
    content,
    details: { version: 1, injection_id: injectionId, task_id: "t1", title: "Test", scheduled_time: 0 },
    identityKey: injectionId,
    identityField: "injection_id",
    contentDigest: createHash("sha256").update(content).digest("hex"),
    triggerTurn: true,
    deliverAs: "steer",
    entryDeadlineMs: 500,
  };
}

function idleBoundary(): IdleAppendBoundary {
  return { waitForIdle: async () => {}, isIdle: () => true, isCurrent: () => true };
}

function livePort(session: SessionManager): LiveMessagePort {
  return {
    send(message, _opts) {
      session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
}

test("appendAtSafeBoundary injects at an idle boundary and returns proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-safe-basic-"));
  try {
    const session = SessionManager.create(root);
    const result = await appendAtSafeBoundary(session, idleBoundary(), livePort(session), options("t1:100", "do work"));
    assert.equal(result.state, "injected");
    assert.ok((result as { entryId: string }).entryId);
    assert.equal(session.getEntries().filter((e) => e.type === "custom_message" && e.customType === CUSTOM_TYPE).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("appendAtSafeBoundary replays an existing entry idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-safe-replay-"));
  try {
    const session = SessionManager.create(root);
    const port = livePort(session);
    const opts = options("t1:100", "do work");
    const first = await appendAtSafeBoundary(session, idleBoundary(), port, opts);
    const second = await appendAtSafeBoundary(session, idleBoundary(), port, opts);
    assert.equal(first.state, "injected");
    assert.equal(second.state, "injected");
    assert.equal((first as { entryId: string }).entryId, (second as { entryId: string }).entryId);
    assert.equal(session.getEntries().filter((e) => e.type === "custom_message" && e.customType === CUSTOM_TYPE).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("appendAtSafeBoundary throws on a content conflict in replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-safe-conflict-"));
  try {
    const session = SessionManager.create(root);
    const port = livePort(session);
    await appendAtSafeBoundary(session, idleBoundary(), port, options("t1:100", "original"));
    await assert.rejects(
      appendAtSafeBoundary(session, idleBoundary(), port, options("t1:100", "different content")),
      /conflicts/,
    );
    assert.equal(session.getEntries().filter((e) => e.type === "custom_message" && e.customType === CUSTOM_TYPE).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("proveNativeEntry verifies an existing identity without appending", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-proof-"));
  try {
    const session = SessionManager.create(root);
    const opts = options("t1:100", "do work");
    await appendAtSafeBoundary(session, idleBoundary(), livePort(session), opts);
    const proof = proveNativeEntry(
      session,
      opts.customType,
      opts.identityField,
      opts.identityKey,
      opts.content,
      opts.contentDigest,
    );
    assert.ok(proof);
    assert.equal(session.getEntries().filter((e) => e.type === "custom_message" && e.customType === CUSTOM_TYPE).length, 1);
    assert.equal(proveNativeEntry(session, opts.customType, opts.identityField, "other", opts.content, opts.contentDigest), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("appendAtSafeBoundary returns not-appended when the boundary is not current", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-safe-not-current-"));
  try {
    const session = SessionManager.create(root);
    const boundary: IdleAppendBoundary = { waitForIdle: async () => {}, isIdle: () => true, isCurrent: () => false };
    const result = await appendAtSafeBoundary(session, boundary, livePort(session), options("t1:100", "do work"));
    assert.equal(result.state, "not-appended");
    assert.equal(session.getEntries().length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("appendAtSafeBoundary returns not-appended when the model is not idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-safe-busy-"));
  try {
    const session = SessionManager.create(root);
    const boundary: IdleAppendBoundary = { waitForIdle: async () => {}, isIdle: () => false, isCurrent: () => true };
    const result = await appendAtSafeBoundary(session, boundary, livePort(session), options("t1:100", "do work"));
    assert.equal(result.state, "not-appended");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("appendAtSafeBoundary returns not-appended when tool calls are unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-safe-tool-tail-"));
  try {
    const session = SessionManager.create(root);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
      api: "pi-messages", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: Date.now(),
    } as never);
    const result = await appendAtSafeBoundary(session, idleBoundary(), livePort(session), options("t1:100", "do work"));
    assert.equal(result.state, "not-appended");
    assert.equal(session.getEntries().filter((e) => e.type === "custom_message").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("appendAtSafeBoundary returns append-unknown when the native entry does not appear", async () => {
  const root = await mkdtemp(join(tmpdir(), "inject-safe-unknown-"));
  try {
    const session = SessionManager.create(root);
    const port: LiveMessagePort = { send() { /* swallow: no append */ } };
    const result = await appendAtSafeBoundary(session, idleBoundary(), port, options("t1:100", "do work"));
    assert.equal(result.state, "append-unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});
