import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { SideRuntime, SideStartupCleanupError } from "../sdk-runtime.ts";

const coordinatorUrl = new URL("../sdk-coordinator.ts?opening-cleanup", import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === coordinatorUrl && specifier === "./sdk-factories.ts") return { url: new URL("./fixtures/opening-factories.ts", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { SdkSideCoordinator } = await import(coordinatorUrl);
hook.deregister();
const context = {
  cwd: "/tmp", model: { provider: "fixture", id: "model" }, hasUI: false, thinkingLevel: "off",
  isProjectTrusted: () => false, getSystemPrompt: () => "Side",
  sessionManager: { getSessionId: () => "main" }, ui: { notify() {} },
};

for (const startupFailed of [false, true]) test(`shutdown retains ${startupFailed ? "startup cleanup" : "unpublished Side"} when durable cancel fails, then retries`, async t => {
  let created!: (side: SideRuntime) => void, failed!: (error: unknown) => void, started!: () => void;
  const pending = new Promise<SideRuntime>((resolve, reject) => { created = resolve; failed = reject; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const construction = t.mock.method(SideRuntime, "create", () => { started(); return pending; });
  const owner = new SdkSideCoordinator({ getSettings: () => ({}) } as never, { select: () => ({}) } as never);
  let cancellations = startupFailed ? 1 : 0;
  const side = { async destroy() { if (++cancellations === 1) throw new Error("FAULT durable cancel"); } } as SideRuntime;
  const opening = owner.open(context as never);
  const openingFailed = assert.rejects(opening, /FAULT durable cancel|startup cleanup failed/);
  await began;
  const shutdownFailed = assert.rejects(owner.shutdown("quit"), /FAULT durable cancel|startup cleanup failed/);
  if (startupFailed) failed(new SideStartupCleanupError(new Error("startup failed"), new Error("FAULT durable cancel"), "/tmp/owned-seed", async () => { cancellations++; }));
  else created(side);
  await Promise.all([openingFailed, shutdownFailed]);
  assert.equal(cancellations, 1, "the first shutdown must propagate the failure instead of silently retrying");
  assert.equal(owner.side, startupFailed ? undefined : side);
  await assert.rejects(owner.open(context as never), /cleanup is pending/);
  assert.equal(construction.mock.callCount(), 1, "failed cleanup must not start a replacement");
  assert.equal(await owner.destroy(), true, "the retained cleanup owner is reachable by the next destroy");
  assert.equal(cancellations, 2);
  assert.equal(owner.side, undefined);
  assert.equal(await owner.destroy(), false);
});
