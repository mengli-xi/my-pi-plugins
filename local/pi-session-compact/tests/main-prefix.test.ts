import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai";
import { acquireEffectiveCapture, getEffectiveContextStore } from "pi-session-runtime/effective-context";
import { mainPrefix, rebuildMainPrefix, MainPrefixUnavailableError, canRebuildMainPrefix } from "../src/main.ts";

test("only explicit capture absence reasons permit rebuilding", () => {
  for (const reason of ["no-capture", "awaiting-provider-capture", "native-compaction", "provider-not-decoratable"]) assert.equal(canRebuildMainPrefix(new MainPrefixUnavailableError({ generation: 1, reason })), true);
  for (const reason of ["fingerprint-changed", "projection-changed", "capture-not-on-branch", "generation-changed", "capture-copy-failed", "capture-observation-unavailable", "unknown-future-reason"]) assert.equal(canRebuildMainPrefix(new MainPrefixUnavailableError({ generation: 1, reason })), false, reason);
  assert.equal(canRebuildMainPrefix(new Error("effective-prefix-unavailable")), false);
});

test("missing main prefix preserves absent lease, fresh resume and invalidation reasons without creating a capture", () => {
  const manager = SessionManager.inMemory("/workspace");
  const sessionId = manager.getSessionId();
  const ctx = { sessionManager: manager, model: { provider: "fixture", id: "main" } } as unknown as ExtensionContext;
  const pi = {} as ExtensionAPI;
  const check = (generation: number | null, reason: string) => {
    assert.throws(() => mainPrefix(pi, ctx, []), (error: unknown) => {
      assert.ok(error instanceof MainPrefixUnavailableError);
      assert.deepEqual(error.diagnostic, { generation, reason });
      assert.match(error.message, /effective-prefix-unavailable/);
      assert.ok(error.message.includes(reason));
      return true;
    });
  };
  check(null, "no-capture");
  const lease = acquireEffectiveCapture({ owner: "prefix-test", sessionId, binding: manager });
  try {
    check(lease.generation, "no-capture");
    for (const reason of ["awaiting-provider-capture", "provider-not-decoratable", "capture-observation-unavailable"]) {
      getEffectiveContextStore().invalidate(sessionId, reason);
      check(lease.generation, reason);
      assert.equal(getEffectiveContextStore().get(sessionId, lease.generation), undefined);
    }
  } finally { lease.retire(); }
});

test("rebuilt prefix uses current prompt/tools and public compaction/edit projection, never discarded history", async () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({ role: "system", content: "STALE_PROMPT", toolsAdded: [{ name: "stale", description: "stale", parameters: { type: "object" } }], timestamp: 0 });
  manager.appendMessage({ role: "user", content: "DISCARDED_RAW_HISTORY", timestamp: 1 });
  const retained = manager.appendMessage({ role: "user", content: "OLD_USER_TEXT", timestamp: 2 });
  manager.appendCompaction("CURRENT_SUMMARY", retained, 100);
  manager.appendContextEdit(retained, { content: "EDITED_USER_TEXT" });
  const tools = [{ name: "current", description: "CURRENT_TOOL", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  const pi = { getActiveTools: () => ["current"], getAllTools: () => tools } as unknown as ExtensionAPI;
  const ctx = { getSystemPrompt: () => "CURRENT_PROMPT" } as ExtensionContext;
  const prefix = await rebuildMainPrefix(pi, ctx, manager.getBranch());
  assert.equal(prefix[0]?.role, "system");
  assert.equal(prefix[0]?.content, "CURRENT_PROMPT");
  assert.deepEqual(getCurrentTools(prefix), tools.map(toToolDeclaration));
  const body = JSON.stringify(prefix);
  assert.match(body, /CURRENT_SUMMARY/);
  assert.match(body, /EDITED_USER_TEXT/);
  assert.doesNotMatch(body, /DISCARDED_RAW_HISTORY|OLD_USER_TEXT|STALE_PROMPT|stale/);
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "unfinished", name: "current", arguments: {} }], api: "fixture", provider: "fixture", model: "main", stopReason: "toolUse", timestamp: 3,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await assert.rejects(rebuildMainPrefix(pi, ctx, manager.getBranch()), /effective-prefix-incomplete/);
});
