import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Mail, ProducerEndpoint } from "pi-session-inject/mailbox-v1/light";

let producer: any;
const symbol = Symbol.for("pi-mcp-adapter.test.task-mailbox");
const globals = globalThis as typeof globalThis & { [symbol: symbol]: unknown };
globals[symbol] = { registerProducer(value: unknown) { producer = value; return {}; }, close() {} };
const fixtureUrl = new URL("./test/auth-task-mailbox-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "pi-session-inject/mailbox-v1/light") return { url: fixtureUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === fixtureUrl) return {
      format: "module", shortCircuit: true,
      source: 'export function bindMailbox() { return globalThis[Symbol.for("pi-mcp-adapter.test.task-mailbox")]; }',
    };
    return nextLoad(url, context);
  },
});
const { createMcpMailbox, captureMcpSender, proveMcpMail, readLegacyMcpEntries } = await import("./mailbox.ts");
after(() => { hooks.deregister(); delete globals[symbol]; });

const message = {
  customType: "mcp-task-result", content: "Task completed", display: true,
  details: { server: "server", deliveryId: "task:server:task-1:completed", task: { taskId: "task-1", status: "completed" } },
};
const mail: Mail = { producer: "pi-mcp-adapter", key: message.details.deliveryId, anchorEntryId: "anchor", policy: "next-request", wake: true, messages: [message] };
let state: any;
beforeEach(() => {
  state = { owner: { isActive: () => true }, config: { mcpServers: { server: {} } },
    blockedProjectServers: new Set(), consentManager: { isDenied() { throw new Error("Task results are not App consent requests"); } } };
  createMcpMailbox({ on: () => () => {} } as any, () => state);
});
const check = (value = mail) => producer.checkCurrent(value, "before-project", {});

test("Task completion passes the common source guard without changing its task fields", async () => {
  const before = structuredClone(mail);
  assert.deepEqual(await check(), { kind: "allow", project: true, wake: true });
  assert.deepEqual(mail, before);
});

test("Task completion requires top-level server and deliveryId, not nested task fields", async () => {
  for (const details of [
    { deliveryId: message.details.deliveryId, task: { server: "server", taskId: "task-1" } },
    { server: "server", task: { deliveryId: message.details.deliveryId, taskId: "task-1" } },
  ]) {
    const value = { ...mail, messages: [{ ...message, details }] };
    assert.equal((await check(value)).kind, "hold");
  }
});

test("Task completion is held for missing, disabled, or unapproved source configuration", async () => {
  delete state.config.mcpServers.server;
  assert.equal((await check()).kind, "hold");
  state.config.mcpServers.server = { disabled: true };
  assert.equal((await check()).kind, "hold");
  state.config.mcpServers.server.disabled = false;
  state.blockedProjectServers.add("server");
  assert.equal((await check()).kind, "hold");
});

test("Task completion is held when its runtime owner is unavailable or retired", async () => {
  state.owner.isActive = () => false;
  assert.equal((await check()).kind, "hold");
  state = null;
  assert.equal((await check()).kind, "hold");
});

test("legacy Task results remain history and exact native Task results can be proven", () => {
  const native = { id: "native-task", type: "custom_message", ...structuredClone(message) } as unknown as SessionEntry;
  const legacy = { id: "legacy-task", type: "custom_message", ...message, details: { server: "server", task: message.details.task } } as unknown as SessionEntry;
  assert.deepEqual(readLegacyMcpEntries([native, legacy]), ["legacy-task"]);
  assert.deepEqual(proveMcpMail(mail, [native, legacy]), { kind: "observed", entries: [{ messageIndex: 0, entryId: "native-task" }] });
  assert.equal(proveMcpMail(mail, [native, native]).kind, "conflict");
  const changed = { ...native, details: { ...message.details, task: { taskId: "different-task", status: "completed" } } } as unknown as SessionEntry;
  assert.equal(proveMcpMail(mail, [changed]).kind, "conflict");
});

test("recovered Task senders keep their original anchor and mark the durable put as recovered", async () => {
  let target = { slotKey: "original", bindingGeneration: 1 };
  let leaf: string | null = "current-descendant";
  const puts: any[][] = [];
  const endpoint = { target: () => target, put: async (...args: any[]) => { puts.push(args); } } as unknown as ProducerEndpoint;
  const ctx = { sessionManager: { getLeafId: () => leaf } } as unknown as ExtensionContext;
  const sender = captureMcpSender(endpoint, ctx, () => true, { anchorEntryId: "anchor", recovered: true });
  await sender(message, message.details.deliveryId);
  assert.equal(puts[0][0].anchorEntryId, "anchor");
  assert.equal(puts[0][0].key, message.details.deliveryId);
  assert.deepEqual(puts[0][2], { recovered: true });
  target = { slotKey: "original", bindingGeneration: 2 };
  leaf = "sibling-leaf";
  await assert.rejects(sender(message, message.details.deliveryId), /original tree scope/);
  assert.equal(puts.length, 1);
  leaf = "anchor";
  await sender(message, message.details.deliveryId);
  assert.deepEqual(puts[1][0], puts[0][0]);
  assert.deepEqual(puts[1][2], { recovered: true });
  const root = captureMcpSender(endpoint, ctx, () => true, { anchorEntryId: null, recovered: true });
  await root(message, "task:root");
  assert.equal(puts[2][0].anchorEntryId, null);
});

test("Task senders retain the captured session/branch target and reject sibling rehoming", async () => {
  const original = { slotKey: "original", bindingGeneration: 1 };
  let target = original;
  let leaf = "anchor";
  const accepted: { value: Mail; target: unknown }[] = [];
  const endpoint = { target: () => target, put: async (value: Mail, captured: unknown) => { accepted.push({ value, target: captured }); } } as unknown as ProducerEndpoint;
  const ctx = { sessionManager: { getLeafId: () => leaf } } as unknown as ExtensionContext;
  const sender = captureMcpSender(endpoint, ctx, () => true);
  await sender(message, message.details.deliveryId);
  assert.equal(accepted[0]!.target, original);
  assert.equal(accepted[0]!.value.anchorEntryId, "anchor");
  assert.deepEqual(accepted[0]!.value.messages[0]!.details, message.details);
  target = { slotKey: "sibling", bindingGeneration: 2 };
  leaf = "sibling-leaf";
  await assert.rejects(sender(message, "task:server:task-2:completed"), /original tree scope/);
  assert.equal(accepted.length, 1);
});
