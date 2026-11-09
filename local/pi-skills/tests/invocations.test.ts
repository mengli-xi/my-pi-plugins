import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  InvocationStore,
  LEGACY_SKILL_BINDING_ENTRY_TYPE,
  SKILL_BINDING_ENTRY_TYPE,
  SKILL_INJECTION_MESSAGE_TYPE,
} from "../invocations.ts";
import type { LoadedSkill } from "../skills.ts";

const loaded: LoadedSkill = {
  name: "deploy",
  path: "/skills/deploy/SKILL.md",
  contents: "Deploy instructions",
};

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

test("injection is request-only and immediately follows its user message", async () => {
  const store = new InvocationStore();
  const message = user("Use $deploy", 10);
  store.stage("Use $deploy", [loaded]);
  store.captureUserMessage(message, []);
  const original: AgentMessage[] = [
    message,
    { role: "assistant", content: [], timestamp: 11 } as unknown as AgentMessage,
  ];
  const injected = await store.inject(original, async () => []);
  assert.equal(original.length, 2, "the stored transcript is not mutated");
  assert.equal(injected.length, 3);
  assert.equal(injected[1].role, "custom");
  assert.equal(injected[1].customType, SKILL_INJECTION_MESSAGE_TYPE);
  assert.match(String(injected[1].content), /<name>deploy<\/name>/);
});

test("rewind before the user removes the injection source", async () => {
  const store = new InvocationStore();
  const message = user("Use $deploy", 10);
  store.stage("Use $deploy", [loaded]);
  store.captureUserMessage(message, []);
  const beforeUser: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "Earlier" }], timestamp: 1 }];
  const injected = await store.inject(beforeUser, async () => []);
  assert.equal(injected.some((item) => item.role === "custom"), false);
});

test("persisted sidecar restores the exact path without joining model context", async () => {
  const first = new InvocationStore();
  const message = user("Use $deploy", 10);
  first.stage("Use $deploy", [loaded]);
  first.captureUserMessage(message, []);
  const [snapshot] = first.takeUnpersisted();
  assert.ok(snapshot);

  const restored = new InvocationStore();
  restored.restore([{ type: "custom", customType: SKILL_BINDING_ENTRY_TYPE, data: snapshot, id: "x", parentId: null, timestamp: "now" }]);
  const injected = await restored.inject([message], async () => {
    throw new Error("fallback should not run");
  });
  assert.equal((injected[1] as { details?: { path?: string } }).details?.path, loaded.path);
});

test("sidecars written under the previous package name remain readable", async () => {
  const first = new InvocationStore();
  const message = user("Use $deploy", 10);
  first.stage("Use $deploy", [loaded]);
  first.captureUserMessage(message, []);
  const [snapshot] = first.takeUnpersisted();
  assert.ok(snapshot);

  const restored = new InvocationStore();
  restored.restore([{
    type: "custom",
    customType: LEGACY_SKILL_BINDING_ENTRY_TYPE,
    data: snapshot,
    id: "legacy",
    parentId: null,
    timestamp: "now",
  }]);
  const injected = await restored.inject([message], async () => []);
  assert.equal((injected[1] as { details?: { path?: string } }).details?.path, loaded.path);
});

test("sidecars containing the old truncated body are refreshed and repersisted", async () => {
  const first = new InvocationStore();
  const message = user("Use $deploy", 10);
  first.stage("Use $deploy", [{ ...loaded, contents: "Partial instructions", truncated: true }]);
  first.captureUserMessage(message, []);
  const [snapshot] = first.takeUnpersisted();
  assert.ok(snapshot);

  const restored = new InvocationStore();
  restored.restore([{
    type: "custom",
    customType: SKILL_BINDING_ENTRY_TYPE,
    data: snapshot,
    id: "old-truncated",
    parentId: null,
    timestamp: "now",
  }]);
  const injected = await restored.inject(
    [message],
    async () => [],
    async (skill) => {
      const { truncated: _legacy, ...current } = skill;
      return { ...current, contents: "Complete instructions" };
    },
  );
  const migratedContent = String((injected[1] as { content?: unknown } | undefined)?.content);
  assert.match(migratedContent, /Complete instructions/);
  assert.doesNotMatch(migratedContent, /Partial instructions/);
  const [migrated] = restored.takeUnpersisted();
  assert.equal(migrated?.skills[0]?.truncated, undefined);
});
