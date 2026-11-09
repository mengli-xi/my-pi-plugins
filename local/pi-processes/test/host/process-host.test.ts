import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultProcessesConfig } from "../../src/config.ts";
import { ProcessHost, RECLAIM_WINDOW_MS, type HostClock, type HostTransport, type TransportCallbacks } from "../../src/host/process-host.ts";
import type { ToolInput } from "../../src/tool/input.ts";
import type { SupervisorEvent } from "../../src/host/supervisor-client.ts";
import { getContinuationRegistryV1, type BlockingLeaseHandleV1, type ContinuationRegistryV1, type WakeSettlementV1 } from "pi-runtime-contracts/continuation-v1";

class FakeClock implements HostClock {
  now = 0;
  next = 1;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.tasks.set(id, { at: this.now + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number); }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, task] of [...this.tasks].sort((a, b) => a[1].at - b[1].at)) {
      if (task.at <= this.now && this.tasks.delete(id)) task.callback();
    }
  }
}

class FakeTransport implements HostTransport {
  supervisorPid = 42;
  hostNonce = "a".repeat(64);
  generation = 1;
  closed = false;
  terminated: NodeJS.Signals[] = [];
  cleanupReasons: string[] = [];
  requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
  async request(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requests.push({ type, payload });
    if (type === "spawn") return { pid: 100 + this.requests.length, pgid: 100 + this.requests.length, stdinOpen: true, logRevision: 0, watchRevision: 0 };
    return { ok: true };
  }
  async cleanup(reason: string): Promise<Record<string, unknown>> { this.cleanupReasons.push(reason); return { unresolved: 0 }; }
  async waitForExit(): Promise<void> {}
  terminate(signal: NodeJS.Signals = "SIGTERM"): void { this.terminated.push(signal); }
  close(): void { this.closed = true; }
}

class FailedCleanupTransport extends FakeTransport {
  exited = false;
  beforeCleanupFailure?: () => void;
  override async cleanup(reason: string): Promise<Record<string, unknown>> {
    this.cleanupReasons.push(reason);
    this.beforeCleanupFailure?.();
    throw new Error("cleanup transport failed");
  }
  override terminate(signal: NodeJS.Signals = "SIGTERM"): void {
    super.terminate(signal);
    this.exited = true;
  }
  override async waitForExit(): Promise<void> {
    if (!this.exited) throw new Error("supervisor still running");
  }
}

class FakeProcessControl {
  alive = new Set<number>();
  signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
    this.signals.push({ pgid, signal });
    if (signal === "SIGKILL") this.alive.delete(pgid);
    return true;
  }
  groupAlive(pgid: number): boolean { return this.alive.has(pgid); }
}

class DeferredStopTransport extends FakeTransport {
  readonly stopResponse: Promise<Record<string, unknown>>;
  resolveStop!: (value: Record<string, unknown>) => void;
  rejectStop!: (error: Error) => void;

  constructor() {
    super();
    this.stopResponse = new Promise((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
  }

  override async request(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (type !== "stop") return super.request(type, payload);
    this.requests.push({ type, payload });
    return this.stopResponse;
  }
}

function event(type: string, payload: Record<string, unknown> = {}): SupervisorEvent {
  return { type, payload, eventSequence: 1 };
}

test("reload retires the binding but replacement reclaims the same host", async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId: "session", clock, launch: async (value) => { callbacks = value; return transport; } });
  await host.ensureStarted();
  const oldDeliveries: string[] = [];
  const first = host.bind({ deliver: (item) => { oldDeliveries.push(item.type); } });
  await first.markReady();
  await first.retire("reload");
  callbacks.onEvent(event("terminal", { id: "proc_1" }));
  assert.equal(host.pendingDeliveryCount, 1);
  clock.advance(RECLAIM_WINDOW_MS - 1);
  assert.equal(host.disposed, false);
  const newDeliveries: string[] = [];
  const second = host.bind({ deliver: (item) => { newDeliveries.push(item.type); } });
  await second.markReady();
  assert.deepEqual(newDeliveries, ["terminal"]);
  clock.advance(1);
  assert.equal(host.disposed, false);
  await first.retire("scope-ended");
  assert.equal(host.disposed, false, "stale binding cannot dispose replacement");
  await second.retire("scope-ended");
  assert.equal(host.disposed, true);
  assert.deepEqual(transport.cleanupReasons, ["scope-ended"]);
  assert.deepEqual(oldDeliveries, []);
});

test("cleanup failure falls back to bounded host-owned group and supervisor termination", async () => {
  const clock = new FakeClock();
  const transport = new FailedCleanupTransport();
  const processControl = new FakeProcessControl();
  const reports: string[] = [];
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId: "session", clock, processControl, launch: async (value) => { callbacks = value; return transport; } });
  transport.beforeCleanupFailure = () => callbacks.onChannelLost(new Error("cleanup channel timed out"));
  const lease = host.bind({ deliver() {}, report: (message) => reports.push(message) });
  await lease.markReady();
  const record = await host.start({
    action: "start",
    name: "cleanup",
    kind: "process",
    command: "sleep 30",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  processControl.alive.add(record.pgid!);

  const retiring = lease.retire("scope-ended");
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1_000);
  await retiring;

  assert.deepEqual(processControl.signals, [
    { pgid: record.pgid, signal: "SIGTERM" },
    { pgid: record.pgid, signal: "SIGKILL" },
  ]);
  assert.deepEqual(transport.terminated, ["SIGKILL"]);
  assert.equal(transport.closed, true);
  assert.match(reports.at(-1) ?? "", /cleanup failed; runtime containment completed/);
});

test("channel loss closes the pipe and lets the supervisor self-clean before forced termination", async () => {
  const operations: string[] = [];
  class SelfCleaningTransport extends FakeTransport {
    override close(): void { operations.push("close"); super.close(); }
    override async waitForExit(): Promise<void> { operations.push("wait"); }
    override terminate(signal: NodeJS.Signals = "SIGTERM"): void { operations.push(`terminate:${signal}`); }
  }
  const transport = new SelfCleaningTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  const lease = host.bind({ deliver() {} });
  await lease.markReady();
  await host.ensureStarted();

  callbacks.onChannelLost(new Error("lost"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(host.disposed, true);
  assert.deepEqual(operations, ["close", "wait", "close"]);
});

test("channel loss before launch completion fences the late transport and releases registry ownership", async () => {
  let callbacks!: TransportCallbacks;
  let resolveLaunch!: (transport: HostTransport) => void;
  const launching = new Promise<HostTransport>((resolve) => { resolveLaunch = resolve; });
  const transport = new FakeTransport();
  let disposedCount = 0;
  const host = new ProcessHost({
    sessionScopeId: "session",
    launch: async (value) => { callbacks = value; return await launching; },
    onDisposed: () => { disposedCount += 1; },
  });

  const starting = host.ensureStarted();
  await new Promise((resolve) => setImmediate(resolve));
  callbacks.onChannelLost(new Error("lost during launch"));
  await new Promise((resolve) => setImmediate(resolve));
  resolveLaunch(transport);

  await assert.rejects(starting, /supervisor channel closed during launch/);
  assert.equal(host.disposed, true);
  assert.equal(transport.closed, true);
  assert.equal(disposedCount, 1);
});

test("cleanup failure remains visible when emergency cleanup cannot reap owned groups", async () => {
  const clock = new FakeClock();
  const transport = new FailedCleanupTransport();
  const processControl = new FakeProcessControl();
  processControl.signalGroup = function (pgid, signal) {
    this.signals.push({ pgid, signal });
    return true;
  };
  const host = new ProcessHost({ sessionScopeId: "session", clock, processControl, launch: async () => transport });
  const record = await host.start({
    action: "start",
    name: "stuck",
    kind: "process",
    command: "sleep 30",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  processControl.alive.add(record.pgid!);

  const disposing = host.endScope();
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1_000);
  await assert.rejects(disposing, /emergency cleanup left 1 process groups/);
  assert.match(host.cleanupError?.message ?? "", /cleanup-incomplete/);
  assert.equal(transport.closed, true);
  assert.equal(host.disposed, true);
  assert.equal(host.runtimeContainmentComplete, false, "a failed cleanup never claims containment completed");
  assert.equal(host.containment, "failed", "the Host stays in quarantine, so readers must not see 'contained'");
  assert.equal(host.records()[0]?.state, "running", "an unreaped group stays live instead of being declared terminal");
});

test("runtime containment terminalizes contained records with a truthful terminal cause", async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  const processControl = new FakeProcessControl();
  const renderedStates: Array<string | undefined> = [];
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId: "session", clock, processControl, launch: async (value) => { callbacks = value; return transport; } });
  const lease = host.bind({ deliver() {}, requestRender: () => { renderedStates.push(host.records()[0]?.state); } });
  await lease.markReady();
  const record = await host.start({
    action: "start",
    name: "contained",
    kind: "process",
    command: "sleep 30",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  processControl.alive.add(record.pgid!);
  assert.equal(host.records()[0]?.state, "running");

  callbacks.onChannelLost(new Error("supervisor exited"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.disposed, true, "disposal is marked before cleanup settles");
  assert.equal(host.runtimeContainmentComplete, false);
  assert.equal(host.containment, "pending", "disposed alone must not read as contained");
  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(host.disposed, true);
  assert.equal(host.runtimeContainmentComplete, true, "containment completed and left no error");
  assert.equal(host.cleanupError, undefined);
  assert.equal(host.containment, "contained");
  assert.deepEqual(processControl.signals, [
    { pgid: record.pgid, signal: "SIGTERM" },
    { pgid: record.pgid, signal: "SIGKILL" },
  ]);
  const contained = host.records()[0]!;
  assert.equal(contained.state, "crashed");
  assert.equal(contained.stdinOpen, false);
  assert.ok(contained.endedAt, "a contained record records when containment ended it");
  assert.equal(contained.terminal?.exitCode, null, "containment never fabricates an exit code");
  assert.equal(contained.terminal?.signal, null);
  assert.equal(contained.terminal?.errorCode, "runtime-contained");
  assert.match(contained.terminal?.messagePreview ?? "", /supervisor channel lost/);
  assert.equal(renderedStates.at(-1), "crashed", "containment re-renders the runtime it just terminalized");
});

test("reclaim timeout observes cleanup failure and keeps its diagnostic", async () => {
  const clock = new FakeClock();
  const transport = new FailedCleanupTransport();
  const processControl = new FakeProcessControl();
  processControl.signalGroup = function (pgid, signal) {
    this.signals.push({ pgid, signal });
    return true;
  };
  const host = new ProcessHost({ sessionScopeId: "session", clock, processControl, launch: async () => transport });
  const lease = host.bind({ deliver() {} });
  await lease.markReady();
  const record = await host.start({
    action: "start",
    name: "reclaim-stuck",
    kind: "process",
    command: "sleep 30",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  processControl.alive.add(record.pgid!);

  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    await lease.retire("reload");
    clock.advance(RECLAIM_WINDOW_MS);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.match(host.cleanupError?.message ?? "", /cleanup-incomplete/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("unreclaimed reload cleans the supervisor after exactly 15 seconds", async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  const host = new ProcessHost({ sessionScopeId: "session", clock, launch: async () => transport });
  await host.ensureStarted();
  const lease = host.bind({ deliver() {} });
  await lease.markReady();
  await lease.retire("reload");
  clock.advance(RECLAIM_WINDOW_MS - 1);
  assert.equal(host.disposed, false);
  clock.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.disposed, true);
  assert.deepEqual(transport.cleanupReasons, ["reclaim-timeout"]);
});

test("coalesces replaceable deliveries and preserves unique lifecycle events", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  await host.ensureStarted();
  for (let sequence = 1; sequence <= 300; sequence++) callbacks.onEvent(event("logCursorAdvanced", { id: "proc_1", sequence }));
  callbacks.onEvent(event("terminal", { id: "proc_1", outcome: "succeeded" }));
  assert.equal(host.pendingDeliveryCount, 2);
  const delivered: SupervisorEvent[] = [];
  const lease = host.bind({ deliver: (item) => { delivered.push(item); } });
  await lease.markReady();
  assert.equal(delivered[0]?.payload.sequence, 300);
  assert.equal(delivered[1]?.type, "terminal");
});

test("shadow notifications freeze owner, coalesce repeat watches, and retry TUI append across binding replacement", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let captureCount = 0;
  const target = { strategy: "child" as const, scopeToken: "process-owner-v1:task-a" };
  const host = new ProcessHost({
    sessionScopeId: "session",
    captureNotificationTarget: () => { captureCount += 1; return target; },
    launch: async (value) => { callbacks = value; return transport; },
  });
  const firstEntries: unknown[] = [];
  const first = host.bind({
    deliver() {},
    appendNotificationEntry(entry) { firstEntries.push(entry); throw new Error("append unavailable"); },
  });
  await first.markReady();
  const record = await host.start({
    action: "start",
    name: "shadow",
    kind: "monitor",
    command: "true",
    watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: true, attention: "context" }],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  assert.equal(captureCount, 1);
  callbacks.onEvent(event("watchMatch", { id: record.id, key: "ready", generation: 1, sequence: 1, stream: "stdout", text: "ready one" }));
  callbacks.onEvent({ type: "watchMatch", eventSequence: 2, payload: { id: record.id, key: "ready", generation: 1, sequence: 2, stream: "stdout", text: "ready two" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.pendingNotificationEntries().length, 1);
  assert.equal(host.notificationSnapshot().watches[0]?.matchedCount, 2);
  assert.ok(firstEntries.length >= 1);

  await first.retire("reload");
  const replacementEntries: unknown[] = [];
  const second = host.bind({
    deliver() {},
    appendNotificationEntry(entry) { replacementEntries.push(entry); },
  });
  await second.markReady();
  assert.equal(replacementEntries.length, 1);
  assert.equal(host.pendingNotificationEntries().length, 0);
  await second.retire("scope-ended");
});

test("repeat watch appends one TUI row while every legacy model event stays hidden", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const appended: string[] = [];
  const ownership: boolean[] = [];
  const reports: string[] = [];
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  const binding = host.bind({
    deliver(_event, state) { ownership.push(state?.tuiOwned === true); },
    appendNotificationEntry(entry) { appended.push(entry.deliveryId); },
    report(message) { reports.push(message); },
  });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "repeat", kind: "monitor", command: "true",
    watches: [{ key: "tick", pattern: "tick", mode: "literal", stream: "stdout", repeat: true, attention: "context" }],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent(event("watchMatch", { id: record.id, key: "tick", generation: 1, sequence: 1, text: "tick" }));
  callbacks.onEvent({ type: "watchMatch", eventSequence: 2, payload: { id: record.id, key: "tick", generation: 1, sequence: 2, text: "tick" } });
  callbacks.onEvent({ type: "watchMatch", eventSequence: 3, payload: { id: record.id, key: "tick", generation: 1, sequence: 3, text: "x".repeat(65_536) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended.length, 1);
  assert.deepEqual(ownership, [true, true, true]);
  assert.deepEqual(reports, []);
  assert.equal(host.notificationSnapshot().watches[0]?.matchedCount, 3);
  await binding.retire("scope-ended");
});

test("model target overflow remains broker-owned and never falls back to legacy context delivery", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let owner = 0;
  const deliveries: Array<{ modelOwned?: boolean; modelLane?: string }> = [];
  const host = new ProcessHost({
    sessionScopeId: "session",
    captureNotificationTarget: () => ({ strategy: "child", scopeToken: `owner-${++owner}` }),
    launch: async (value) => { callbacks = value; return transport; },
  });
  const binding = host.bind({ deliver(_event, state) { deliveries.push(state ?? {}); }, appendNotificationEntry() {} });
  await binding.markReady();
  const records = [];
  const config = { ...defaultProcessesConfig(), limits: { ...defaultProcessesConfig().limits, maxLiveProcesses: 64 } };
  for (let index = 0; index < 33; index++) {
    records.push(await host.start({
      action: "start", name: `p${index}`, kind: "monitor", command: "true",
      watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: true, attention: "context" }],
      continuation: { mode: "detached" },
    }, config, process.cwd()));
  }
  records.forEach((record, index) => callbacks.onEvent({ type: "watchMatch", eventSequence: index + 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries.length, 33);
  assert.equal(deliveries.every((value) => value.modelOwned === true && value.modelLane === "context"), true);
  await binding.retire("scope-ended");
});

test("abort signal fences events before agent_end and shadow failure cannot restore the original turn lane", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let aborted = true;
  const lanes: string[] = [];
  const reports: string[] = [];
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  const first = host.bind({ deliver(_event, state) { lanes.push(state?.modelLane ?? "none"); }, appendNotificationEntry() {}, currentRunAborted: () => aborted, report(message) { reports.push(message); } });
  await first.markReady();
  const record = await host.start({
    action: "start", name: "fenced", kind: "monitor", command: "true",
    watches: [{ key: "tick", pattern: "tick", mode: "literal", stream: "stdout", repeat: true, attention: "turn" }],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "tick" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.notificationRunAbortFence(), true);
  assert.deepEqual(lanes, ["none"]);
  await first.retire("reload");
  const second = host.bind({ deliver(_event, state) { lanes.push(state?.modelLane ?? "none"); }, appendNotificationEntry() {}, report(message) { reports.push(message); } });
  await second.markReady();
  callbacks.onEvent({ type: "watchMatch", eventSequence: 2, payload: { id: record.id, key: "tick", generation: 1, sequence: 2, text: "tick" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.notificationRunAbortFence(), true);
  assert.deepEqual(lanes, ["none", "context"], reports.join("\n"));
  aborted = false;
  host.clearNotificationRunAbortFence();
  callbacks.onEvent({ type: "watchMatch", eventSequence: 3, payload: { id: record.id, key: "tick", generation: 1, sequence: 3, text: "tick" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lanes, ["none", "context", "turn"]);
  await second.retire("scope-ended");
});

test("abort during asynchronous TUI append records TUI state and discards the legacy-owned turn window", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let aborted = false;
  let releaseAppend!: () => void;
  const appendBlocked = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const legacyTurns: string[] = [];
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  const binding = host.bind({
    currentRunAborted: () => aborted,
    appendNotificationEntry: () => appendBlocked,
    deliver(event) {
      const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
      if (aborted && id) {
        host.setNotificationRunAbortFence();
        host.discardNotificationTurnWindow(id);
        return;
      }
      legacyTurns.push(event.type);
    },
  });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "append-race", kind: "monitor", command: "true",
    watches: [{ key: "tick", pattern: "tick", mode: "literal", stream: "stdout", repeat: true, attention: "turn" }],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "tick", generation: 1, sequence: 1, text: "tick" } });
  aborted = true;
  releaseAppend();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(legacyTurns, []);
  assert.equal(host.notificationRunAbortFence(), true);
  assert.equal(host.prepareNotificationBatch({ target: { strategy: "main", scopeToken: "session" }, lane: "turn", batchId: "race-turn", epochId: "epoch", reason: "main-admission", createdAt: new Date().toISOString() }), undefined);
  assert.equal(host.prepareNotificationBatch({ target: { strategy: "main", scopeToken: "session" }, lane: "context", batchId: "race-context", epochId: "epoch", reason: "user-boundary", createdAt: new Date().toISOString() }), undefined);
  assert.equal(host.notificationSnapshot().watches[0]?.matchedCount, 1);
  await binding.retire("scope-ended");
});

test("claimed Process wait wake remains open until its persistent notification batch commits", async () => {
  const sessionScopeId = `claimed-wake-${Date.now()}-${Math.random()}`;
  const registry = getContinuationRegistryV1();
  const settlements: WakeSettlementV1[] = [];
  const consumer = registry.registerWakeConsumer({
    sessionId: sessionScopeId,
    consumerId: "host-test",
    onOffer(_offer, claim) {
      const claimed = claim();
      assert.equal(claimed.ok, true);
      if (!claimed.ok) return;
      const listener = claimed.value.onSettled((settlement) => settlements.push(settlement));
      assert.equal(listener.ok, true);
    },
  });
  assert.equal(consumer.ok, true);
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  const binding = host.bind({ deliver() { return { deferWake: true }; }, appendNotificationEntry() {} });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "claimed", kind: "monitor", command: "true",
    watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "turn" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 1);
  assert.equal(settlements.length, 0);
  const prepared = host.prepareNotificationBatch({ target: { strategy: "main", scopeToken: sessionScopeId }, lane: "turn", batchId: "claimed-batch", epochId: "background", reason: "main-admission", createdAt: new Date().toISOString() });
  assert.ok(prepared);
  assert.equal(host.notificationBatchClaimed("claimed-batch"), true);
  host.commitNotificationBatch("claimed-batch");
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.delivery, "delivered");
  host.commitNotificationBatch("claimed-batch");
  assert.equal(settlements.length, 1);
  if (consumer.ok) consumer.value.dispose();
  await binding.retire("scope-ended");
});

test("record-only settlement waits for a stopped lease artifact and retries a failed Wake commit", async () => {
  const sessionScopeId = `record-only-retry-${Date.now()}-${Math.random()}`;
  const delegate = getContinuationRegistryV1();
  let failCommit = true;
  const registry: ContinuationRegistryV1 = {
    apiVersion: 1,
    acquireBlocking(input) {
      const acquired = delegate.acquireBlocking(input);
      if (!acquired.ok) return acquired;
      const lease = acquired.value;
      const wrapped: BlockingLeaseHandleV1 = {
        snapshot: () => lease.snapshot(), updateReason: (reason) => lease.updateReason(reason), checkIn: () => lease.checkIn(),
        releaseWithoutWake: (value) => lease.releaseWithoutWake(value),
        releaseAndOfferWake(value) {
          const offered = lease.releaseAndOfferWake(value);
          if (!offered.ok) return offered;
          const wake = offered.value;
          return { ok: true, value: {
            snapshot: () => wake.snapshot(), hasClaim: () => wake.hasClaim(), abort: (message) => wake.abort(message),
            commit(delivery) {
              if (failCommit) { failCommit = false; return { ok: false, error: "invalid-input" as const, message: "transient Wake commit failure" }; }
              return wake.commit(delivery);
            },
          } };
        },
      };
      return { ok: true, value: wrapped };
    },
    offerWake: (input) => delegate.offerWake(input), snapshot: (sessionId) => delegate.snapshot(sessionId),
    subscribe: (sessionId, listener) => delegate.subscribe(sessionId, listener),
    registerWakeConsumer: (input) => delegate.registerWakeConsumer(input),
  };
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const entries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const reports: string[] = [];
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  const binding = host.bind({
    deliver() { return { deferWake: true }; },
    appendNotificationEntry(entry) { entries.push({ customType: entry.customType, data: entry.data as Record<string, unknown> }); },
    report(message) { reports.push(message); },
  });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "stopped-wait", kind: "monitor", command: "sleep 1", watches: [],
    continuation: { mode: "wait", until: { kind: "exit" } }, notify: { onKilled: "context" },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent(event("terminal", { id: record.id, classification: "stopped", exitCode: null, signal: "SIGTERM" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entries.filter((entry) => entry.customType === "process-event-v2").length, 0, reports.join("\n"));
  assert.equal(entries.filter((entry) => entry.customType === "process-notification-receipt-v1").length, 1, reports.join("\n"));
  const prepared = host.prepareNotificationContinuation({
    target: { strategy: "main", scopeToken: sessionScopeId }, lane: "context", batchId: "record-only-batch",
    epochId: "record-only", reason: "subagent-admission", createdAt: new Date().toISOString(),
  });
  assert.equal(prepared?.leaseWakeTransactionIds.length, 1);
  assert.throws(() => host.settleNotificationBatchRecordOnly("record-only-batch"), /transient Wake commit failure/);
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 1);
  await binding.retire("reload");
  const replacement = host.bind({ deliver() {}, appendNotificationEntry() {} });
  await replacement.markReady();
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
  await replacement.retire("scope-ended");
});

test("scope teardown aborts a wake created without a ready binding even when projection fails", async () => {
  const sessionScopeId = `unbound-wake-${Date.now()}-${Math.random()}`;
  const registry = getContinuationRegistryV1();
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  const record = await host.start({
    action: "start", name: "unbound", kind: "monitor", command: "true",
    watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "turn" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
  }, defaultProcessesConfig(), process.cwd());
  // Missing generation makes notification projection fail after the wake transaction exists.
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", sequence: 1, text: "ready" } });
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 1);
  await host.endScope();
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
});

test("projection failure through a ready binding settles delivery-failed instead of hanging", async () => {
  const sessionScopeId = `projection-wake-${Date.now()}-${Math.random()}`;
  const registry = getContinuationRegistryV1();
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  let deliveries = 0;
  const binding = host.bind({ deliver() { deliveries++; return { deferWake: true }; }, appendNotificationEntry() {} });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "projection", kind: "monitor", command: "true",
    watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "turn" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", sequence: 1, text: "ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
  assert.equal(deliveries, 0);
  await binding.retire("scope-ended");
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
});

test("blocking wake waits for receipt retry across binding replacement", async () => {
  const sessionScopeId = `receipt-retry-${Date.now()}-${Math.random()}`;
  const registry = getContinuationRegistryV1();
  const settlements: WakeSettlementV1[] = [];
  const consumer = registry.registerWakeConsumer({ sessionId: sessionScopeId, consumerId: "receipt-retry", onOffer(_offer, claim) { const result = claim(); if (result.ok) result.value.onSettled((settlement) => settlements.push(settlement)); } });
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let delivered = 0;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  const first = host.bind({ deliver() { delivered++; }, appendNotificationEntry(entry) { if (entry.customType === "process-notification-receipt-v1") throw new Error("disk unavailable"); } });
  await first.markReady();
  const record = await host.start({ action: "start", name: "receipt-retry", kind: "monitor", command: "true", watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "context" }], continuation: { mode: "wait", until: { kind: "watch", key: "ready" } } }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 1);
  assert.equal(delivered, 0);
  await first.retire("reload");
  const second = host.bind({ deliver() { delivered++; }, appendNotificationEntry() {} });
  await second.markReady();
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
  assert.equal(settlements[0]?.delivery, "delivered");
  assert.equal(delivered, 1);
  if (consumer.ok) consumer.value.dispose();
  await second.retire("scope-ended");
});

test("blocking wake remains delivered when the model delivery callback throws after receipt persistence", async () => {
  const sessionScopeId = `receipt-callback-${Date.now()}-${Math.random()}`;
  const registry = getContinuationRegistryV1();
  const settlements: WakeSettlementV1[] = [];
  const consumer = registry.registerWakeConsumer({ sessionId: sessionScopeId, consumerId: "receipt-callback", onOffer(_offer, claim) { const result = claim(); if (result.ok) result.value.onSettled((settlement) => settlements.push(settlement)); } });
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  const binding = host.bind({ deliver() { throw new Error("model delivery failed"); }, appendNotificationEntry() {} });
  await binding.markReady();
  const record = await host.start({ action: "start", name: "receipt-callback", kind: "monitor", command: "true", watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "context" }], continuation: { mode: "wait", until: { kind: "watch", key: "ready" } } }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
  assert.equal(settlements[0]?.delivery, "delivered");
  if (consumer.ok) consumer.value.dispose();
  await binding.retire("scope-ended");
});

test("scope teardown aborts a deferred claimed wake before releasing Host ownership", async () => {
  const sessionScopeId = `teardown-wake-${Date.now()}-${Math.random()}`;
  const registry = getContinuationRegistryV1();
  const settlements: WakeSettlementV1[] = [];
  const consumer = registry.registerWakeConsumer({
    sessionId: sessionScopeId,
    consumerId: "teardown-test",
    onOffer(_offer, claim) {
      const claimed = claim();
      if (!claimed.ok) return;
      claimed.value.onSettled((settlement) => settlements.push(settlement));
    },
  });
  assert.equal(consumer.ok, true);
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  const binding = host.bind({ deliver() { return { deferWake: true }; }, appendNotificationEntry() {} });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "teardown", kind: "monitor", command: "true",
    watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "turn" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 1);
  await binding.retire("scope-ended");
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
  assert.equal(settlements[0]?.state, "aborted");
  if (consumer.ok) consumer.value.dispose();
});

test("a sealed Main epoch preserves a new wait wake but still defers detached, context and fenced facts", async () => {
  const cases = [
    { wait: true, attention: "turn", fenced: false, lane: "turn" },
    { wait: false, attention: "turn", fenced: false, lane: "context" },
    { wait: true, attention: "context", fenced: false, lane: "context" },
    { wait: true, attention: "turn", fenced: true, lane: "context" },
  ] as const;
  for (const [index, scenario] of cases.entries()) {
    const transport = new FakeTransport();
    let callbacks!: TransportCallbacks;
    const lanes: string[] = [];
    const host = new ProcessHost({ sessionScopeId: `sealed-wait-${index}`, launch: async value => { callbacks = value; return transport; } });
    const binding = host.bind({ deliver(_event, state) { lanes.push(state?.modelLane ?? "none"); }, appendNotificationEntry() {} });
    try {
      await binding.markReady();
      host.setNotificationTurnEpochSealed(true);
      if (scenario.fenced) host.setNotificationRunAbortFence();
      const record = await host.start({
        action: "start", name: "late-wait", kind: "monitor", command: "true",
        watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: true, attention: scenario.attention }],
        continuation: scenario.wait ? { mode: "wait", until: { kind: "watch", key: "ready" } } : { mode: "detached" },
      }, defaultProcessesConfig(), process.cwd());
      callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(lanes, [scenario.lane], JSON.stringify(scenario));
      if (scenario.wait && scenario.attention === "turn" && !scenario.fenced) {
        callbacks.onEvent({ type: "watchMatch", eventSequence: 2, payload: { id: record.id, key: "ready", generation: 1, sequence: 2, text: "ready" } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(lanes, ["turn", "context"], "the consumed lease does not give repeat matches another wake");
        await host.configure({ action: "configure", target: record.id, continuation: { mode: "wait", until: { kind: "watch", key: "ready" } } });
        callbacks.onEvent({ type: "watchMatch", eventSequence: 3, payload: { id: record.id, key: "ready", generation: 1, sequence: 3, text: "ready" } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(lanes, ["turn", "context", "turn"], "explicit re-arm gives the next wait its own wake");
      }
    } finally { await binding.retire("scope-ended"); }
  }
});

test("external user epoch settles a persisted deferred receipt before clearing its authority", async () => {
  const sessionScopeId = `user-boundary-wake-${Date.now()}-${Math.random()}`;
  const registry = getContinuationRegistryV1();
  const settlements: WakeSettlementV1[] = [];
  const consumer = registry.registerWakeConsumer({
    sessionId: sessionScopeId,
    consumerId: "user-boundary-test",
    onOffer(_offer, claim) {
      const claimed = claim();
      if (claimed.ok) claimed.value.onSettled((settlement) => settlements.push(settlement));
    },
  });
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; } });
  const binding = host.bind({ deliver() { return { deferWake: true }; }, appendNotificationEntry() {} });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "boundary", kind: "monitor", command: "true",
    watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "turn" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  const prepared = host.prepareNotificationBatch({ target: { strategy: "main", scopeToken: sessionScopeId }, lane: "turn", batchId: "boundary-batch", epochId: "background", reason: "main-admission", createdAt: new Date().toISOString() });
  assert.ok(prepared);
  host.setMainTurnNotificationReceipt({ batch: prepared.batch, persisted: true, wakeSettled: false });
  assert.equal(host.beginNotificationUserEpoch(), true);
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
  assert.equal(settlements[0]?.delivery, "delivered");
  assert.equal(host.mainTurnNotificationReceipt(), undefined);
  if (consumer.ok) consumer.value.dispose();
  await binding.retire("scope-ended");
});

test("quarantined Host replays a partially failed notification retirement plan", async () => {
  const sessionScopeId = `retry-retirement-${Date.now()}-${Math.random()}`;
  const delegate = getContinuationRegistryV1();
  let failAbort = true;
  const registry: ContinuationRegistryV1 = {
    apiVersion: 1,
    acquireBlocking(input) {
      const acquired = delegate.acquireBlocking(input);
      if (!acquired.ok) return acquired;
      const lease = acquired.value;
      const wrapped: BlockingLeaseHandleV1 = {
        snapshot: () => lease.snapshot(), updateReason: (reason) => lease.updateReason(reason), checkIn: () => lease.checkIn(),
        releaseWithoutWake: (value) => lease.releaseWithoutWake(value),
        releaseAndOfferWake(value) {
          const offered = lease.releaseAndOfferWake(value);
          if (!offered.ok) return offered;
          const wake = offered.value;
          return { ok: true, value: {
            snapshot: () => wake.snapshot(), hasClaim: () => wake.hasClaim(), commit: (delivery) => wake.commit(delivery),
            abort(message) {
              if (failAbort) { failAbort = false; return { ok: false, error: "invalid-input" as const, message: "transient abort failure" }; }
              return wake.abort(message);
            },
          } };
        },
      };
      return { ok: true, value: wrapped };
    },
    offerWake: (input) => delegate.offerWake(input), snapshot: (sessionId) => delegate.snapshot(sessionId),
    subscribe: (sessionId, listener) => delegate.subscribe(sessionId, listener),
    registerWakeConsumer: (input) => delegate.registerWakeConsumer(input),
  };
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let disposed = 0;
  const host = new ProcessHost({ sessionScopeId, continuationRegistry: registry, launch: async (value) => { callbacks = value; return transport; }, onDisposed: () => { disposed += 1; } });
  const binding = host.bind({ deliver() { return { deferWake: true }; }, appendNotificationEntry() {} });
  await binding.markReady();
  const record = await host.start({
    action: "start", name: "retry", kind: "monitor", command: "true",
    watches: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false, attention: "turn" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
  }, defaultProcessesConfig(), process.cwd());
  callbacks.onEvent({ type: "watchMatch", eventSequence: 1, payload: { id: record.id, key: "ready", generation: 1, sequence: 1, text: "ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(binding.retire("scope-ended"), /transient abort failure/);
  assert.equal(disposed, 0);
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 1);
  await host.dispose("scope-ended");
  assert.equal(disposed, 1);
  assert.equal(registry.snapshot(sessionScopeId).openOffers, 0);
});

test("resolves lifecycle attention from watch and terminal process policy", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  const record = await host.start({
    action: "start",
    name: "attention",
    kind: "process",
    command: "true",
    watches: [{
      key: "ready",
      pattern: "ready",
      mode: "literal",
      stream: "stdout",
      repeat: false,
      attention: "context",
    }],
    continuation: { mode: "detached" },
    notify: { onSuccess: "ignore" },
  }, defaultProcessesConfig(), process.cwd());

  const watch = event("watchMatch", { id: record.id, key: "ready" });
  callbacks.onEvent(watch);
  assert.equal(host.lifecycleAttention(watch), "context");

  const terminal = event("terminal", {
    id: record.id,
    classification: "natural",
    exitCode: 0,
    signal: null,
  });
  callbacks.onEvent(terminal);
  assert.equal(host.lifecycleAttention(terminal), "ignore");
});

test("terminal events win over a late stop response", async () => {
  const transport = new DeferredStopTransport();
  let callbacks!: TransportCallbacks;
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  const record = await host.start({
    action: "start",
    name: "quick-stop",
    kind: "process",
    command: "sleep 1",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());

  const stopping = host.stop({ action: "stop", target: record.id });
  assert.equal(host.summary(record.id)?.state, "stopping");
  callbacks.onEvent(event("terminal", { id: record.id, classification: "stopped", exitCode: null, signal: "SIGTERM" }));
  transport.resolveStop({ signal: "SIGTERM", delivered: true });

  const result = await stopping;
  assert.equal(result.process.state, "stopped");
  assert.equal(host.summary(record.id)?.state, "stopped");
});

test("failed stop requests restore the previous live state when no terminal event arrived", async () => {
  const transport = new DeferredStopTransport();
  const host = new ProcessHost({ sessionScopeId: "session", launch: async () => transport });
  const record = await host.start({
    action: "start",
    name: "stop-fails",
    kind: "process",
    command: "sleep 1",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());

  const stopping = host.stop({ action: "stop", target: record.id });
  assert.equal(host.summary(record.id)?.state, "stopping");
  transport.rejectStop(new Error("stop transport failed"));

  await assert.rejects(stopping, /stop transport failed/);
  assert.equal(host.summary(record.id)?.state, "running");
});

test("retains terminal strip tokens for exactly five seconds without deleting records", async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let renders = 0;
  const host = new ProcessHost({ sessionScopeId: "session", clock, now: () => clock.now, launch: async (value) => { callbacks = value; return transport; } });
  const lease = host.bind({ deliver() {}, requestRender: () => { renders += 1; } });
  await lease.markReady();
  const record = await host.start({
    action: "start",
    name: "build",
    kind: "service",
    command: "true",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  assert.equal(host.summary(record.id)?.kind, "service");

  callbacks.onEvent(event("terminal", { id: record.id, classification: "natural", exitCode: 0, signal: null }));
  assert.equal(host.stripRecords().length, 1);
  const rendersAfterTerminal = renders;
  clock.advance(4_999);
  assert.equal(host.stripRecords().length, 1);
  assert.equal(renders, rendersAfterTerminal);
  clock.advance(1);
  assert.equal(host.stripRecords().length, 0);
  assert.equal(host.records().length, 1, "terminal records remain available until clear");
  assert.equal(renders, rendersAfterTerminal + 1, "expiry actively redraws the strip");
});

test("configure changes the explicit process kind", async () => {
  const transport = new FakeTransport();
  const host = new ProcessHost({ sessionScopeId: "session", launch: async () => transport });
  const record = await host.start({
    action: "start",
    name: "logs",
    kind: "process",
    command: "tail -f app.log",
    watches: [],
    continuation: { mode: "detached" },
  }, defaultProcessesConfig(), process.cwd());
  const configured = await host.configure({ action: "configure", target: record.id, kind: "monitor" });
  assert.deepEqual(configured.changed, ["kind"]);
  assert.equal(configured.process.kind, "monitor");
  assert.equal(host.command(record.id), "tail -f app.log", "trusted local UI can show the full script");
});

test("resolves terminal names without weakening live-name identity", async () => {
  const transport = new FakeTransport();
  let callbacks!: TransportCallbacks;
  let eventSequence = 0;
  const host = new ProcessHost({ sessionScopeId: "session", launch: async (value) => { callbacks = value; return transport; } });
  const start = async (name: string) => await host.start({
    action: "start",
    name,
    kind: "process",
    command: "true",
    watches: [],
    continuation: { mode: "detached" },
  } satisfies Extract<ToolInput, { action: "start" }>, defaultProcessesConfig(), process.cwd());
  const finish = (id: string) => callbacks.onEvent({
    type: "terminal",
    eventSequence: ++eventSequence,
    payload: { id, classification: "natural", exitCode: 0, signal: null },
  });

  const unique = await start("unique");
  finish(unique.id);
  assert.equal(host.resolveTarget(unique.id).id, unique.id, "id lookup remains direct");
  assert.equal(host.resolveTarget("unique").id, unique.id, "a unique terminal name remains readable");
  assert.throws(() => host.resolveTarget("unique", { liveOnly: true }), /live process 'unique' was not found/);

  const first = await start("reused");
  finish(first.id);
  const second = await start("reused");
  finish(second.id);
  assert.throws(() => host.resolveTarget("reused"), /terminal process name 'reused' is ambiguous; use a process id/);

  const current = await start("reused");
  assert.equal(host.resolveTarget("reused").id, current.id, "the live process wins over historical names");
  assert.equal(host.resolveTarget("reused", { liveOnly: true }).id, current.id);
});


test("empty binding readiness does not launch a supervisor; concurrent first requests await one launch", async () => {
  let launches = 0;
  let resolveLaunch!: (transport: HostTransport) => void;
  const launch = new Promise<HostTransport>((resolve) => { resolveLaunch = resolve; });
  const host = new ProcessHost({ sessionScopeId: "lazy-empty", launch: async () => { launches++; return launch; } });
  const binding = host.bind({ deliver() {} });
  await binding.markReady();
  assert.equal(launches, 0);
  assert.equal(host.supervisorPid, undefined);
  const first = host.request("snapshot", {});
  const second = host.request("snapshot", {});
  assert.equal(launches, 1);
  const transport = new FakeTransport();
  assert.deepEqual(transport.requests, [], "no request precedes transport readiness");
  resolveLaunch(transport);
  await Promise.all([first, second]);
  assert.equal(transport.requests.length, 2);
  await binding.retire("reload");
  const replacement = host.bind({ deliver() {} });
  await replacement.markReady();
  assert.equal(launches, 1, "reload reclaims the active transport rather than starting another helper");
  await replacement.retire("scope-ended");
});

test("first-use launch failure stays closed and may be retried", async () => {
  let launches = 0;
  const transport = new FakeTransport();
  const host = new ProcessHost({ sessionScopeId: "lazy-retry", launch: async () => {
    if (++launches === 1) throw new Error("handshake rejected");
    return transport;
  } });
  const binding = host.bind({ deliver() {} });
  await binding.markReady();
  await assert.rejects(host.request("snapshot", {}), /handshake rejected/);
  assert.equal(host.supervisorPid, undefined);
  assert.deepEqual(transport.requests, []);
  await host.request("snapshot", {});
  assert.equal(launches, 2);
  await binding.retire("scope-ended");
});
