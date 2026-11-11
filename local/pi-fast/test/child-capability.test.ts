import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "fast-child-capability-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
test.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(root, { recursive: true, force: true }); });
const { default: piFast } = await import("../index.ts");

function fixture() {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const notifications: string[] = [];
  let command!: RegisteredCommand;
  const pi = { on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
    handlers.set(event, [...handlers.get(event) ?? [], handler]);
  }, events: { emit() {} }, appendEntry() {}, registerCommand(_name: string, registered: RegisteredCommand) { command = registered; } } as unknown as ExtensionAPI;
  piFast(pi);
  const context = (sessionId: string) => ({ mode: "rpc", sessionManager: { getSessionId: () => sessionId, getBranch: () => [] }, model: { provider: "openai-codex" }, ui: { notify: (message: string) => notifications.push(message) } }) as unknown as ExtensionContext;
  return { command, context, notifications, emit(event: string, ctx: ExtensionContext) {
    return handlers.get(event)!.map(handler => handler({}, ctx));
  }, request: (ctx: ExtensionContext) => handlers.get("before_provider_request")![0]!({ payload: { model: "fixture" } }, ctx) };
}

test("shutdown disposes all session bindings and allows a changed manifest in the same process", t => {
  const f = fixture(), registry = getOrCreateChildCapabilityRegistryV1();
  const first = randomUUID(), second = randomUUID();
  const ctx = f.context(first);
  t.after(() => f.emit("session_shutdown", ctx));
  f.emit("session_start", ctx); f.emit("session_start", f.context(second));
  const manifest = registry.snapshot(first).registrations.find(item => item.owner_id === "pi-fast")!.manifest;
  assert.ok(registry.snapshot(second).registrations.some(item => item.owner_id === "pi-fast"), "binding a second session does not retire the first");
  assert.ok(registry.snapshot(first).registrations.some(item => item.owner_id === "pi-fast"));
  assert.deepEqual(manifest.targets["pi-subagents"]!.hooks, []);
  f.emit("session_shutdown", ctx);
  assert.deepEqual(registry.snapshot(first).registrations, []);
  assert.deepEqual(registry.snapshot(second).registrations, []);
  const registration = registry.register({ version: 1, manifest: { ...manifest, targets: {
    ...manifest.targets, "pi-subagents": { ...manifest.targets["pi-subagents"]!, activation: "required-only" },
  } } });
  t.after(() => registration.release());
  const binding = registry.bind({ version: 1, registrationToken: registration.registrationToken, session_id: first, runtime_generation: 1, mode: "rpc" });
  t.after(() => binding.release());
  assert.deepEqual(registry.snapshot(first).conflicts, []);
  assert.equal(registry.snapshot(first).registrations[0]!.manifest.targets["pi-subagents"]!.activation, "required-only");
});

test("failed binding reports a diagnostic without disabling /fast or request injection", async t => {
  const f = fixture(), registry = getOrCreateChildCapabilityRegistryV1();
  const ctx = f.context(randomUUID());
  t.after(() => f.emit("session_shutdown", ctx));
  f.emit("session_start", ctx);
  const manifest = registry.snapshot(ctx.sessionManager.getSessionId()).registrations.find(item => item.owner_id === "pi-fast")!.manifest;
  const conflicting = registry.register({ version: 1, manifest: { ...manifest, targets: {
    ...manifest.targets, "pi-subagents": { ...manifest.targets["pi-subagents"]!, activation: "required-only" },
  } } });
  t.after(() => conflicting.release());
  assert.doesNotThrow(() => f.emit("session_start", ctx));
  assert.match(f.notifications[0]!, /Fast child capability unavailable/);
  await f.command.handler("on", ctx as never);
  assert.deepEqual(f.request(ctx), { model: "fixture", service_tier: "priority" });
});

test("a failed rebind keeps the previous session binding usable", async t => {
  const f = fixture(), registry = getOrCreateChildCapabilityRegistryV1();
  const ctx = f.context(randomUUID()), sessionId = ctx.sessionManager.getSessionId();
  t.after(() => f.emit("session_shutdown", ctx));
  f.emit("session_start", ctx);
  await f.command.handler("on", ctx as never);
  const manifest = registry.snapshot(sessionId).registrations.find(item => item.owner_id === "pi-fast")!.manifest;
  const conflicting = registry.register({ version: 1, manifest: { ...manifest, targets: {
    ...manifest.targets, "pi-subagents": { ...manifest.targets["pi-subagents"]!, activation: "required-only" },
  } } });
  t.after(() => conflicting.release());
  f.notifications.splice(0);
  assert.doesNotThrow(() => f.emit("session_start", ctx));
  assert.match(f.notifications[0]!, /Fast child capability unavailable/);
  conflicting.release();
  // The fake Main branch is static, so restore the fixture state after its replay.
  await f.command.handler("on", ctx as never);
  const registration = registry.snapshot(sessionId).registrations.find(item => item.owner_id === "pi-fast");
  assert.ok(registration, "the original binding survives a rejected replacement");
  assert.deepEqual(registration.factory_context, { enabled: true });
  assert.deepEqual(f.request(ctx), { model: "fixture", service_tier: "priority" });
});
