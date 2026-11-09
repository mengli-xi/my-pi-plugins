import assert from "node:assert/strict";
import test from "node:test";
import { pid as ownPid } from "node:process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ProcessSummary } from "../../src/domain/types.ts";
import { isolatedProcessesConfig as defaultProcessesConfig } from "../isolation-fixture.ts";
import { ProcessHost, type TransportCallbacks, type HostTransport } from "../../src/host/process-host.ts";
import {
  installProcessesStatusProtocol,
  PROCESSES_OPEN_REQUEST_CHANNEL,
  PROCESSES_MANAGED_SNAPSHOT_CHANNEL,
  PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL,
  type ProcessesManagedSnapshotV1,
  PROCESSES_SNAPSHOT_REQUEST_CHANNEL,
  PROCESSES_STATUS_SNAPSHOT_CHANNEL,
  type ProcessesStatusSnapshotV2,
} from "../../src/integrations/status-protocol.ts";

class EventBus {
  readonly handlers = new Map<string, Array<(value: unknown) => void>>();
  readonly emitted: Array<{ channel: string; value: unknown }> = [];

  on(channel: string, handler: (value: unknown) => void): void {
    const values = this.handlers.get(channel) ?? [];
    values.push(handler);
    this.handlers.set(channel, values);
  }

  emit(channel: string, value: unknown): void {
    this.emitted.push({ channel, value });
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }
}

function process(id: string, name: string, state: ProcessSummary["state"]): ProcessSummary {
  return {
    id,
    name,
    kind: "process",
    state,
    commandPreview: "sleep 10",
    commandTruncated: false,
    cwd: "/tmp",
    startedAt: new Date(0).toISOString(),
    runtimeMs: 1,
    pid: 10,
    pgid: 10,
    stdinOpen: true,
    continuation: { mode: "detached" },
    watches: { count: 0, keys: [], failedKeys: [] },
    logs: { revision: 0, earliestSequence: 0, nextSequence: 0, droppedBytes: 0, droppedLines: 0 },
  };
}

function host(records: ProcessSummary[] = []): ProcessHost {
  return {
    hostRevision: 4,
    records: () => records,
    summary: (id: string) => records.find((record) => record.id === id),
  } as unknown as ProcessHost;
}

test("publishes session-scoped semantic snapshots and responds to deduplicated requests", () => {
  const bus = new EventBus();
  const opened: Array<string | undefined> = [];
  const reports: string[] = [];
  let runtime = {
    sessionScopeId: "session-a",
    host: host([
      process("proc_a", "api", "running"),
      process("proc_b", "done", "succeeded"),
    ]),
    hasUI: true,
    open: (id?: string) => opened.push(id),
    report: (message: string) => reports.push(message),
  };
  const protocol = installProcessesStatusProtocol(
    { events: bus } as unknown as Pick<ExtensionAPI, "events">,
    () => runtime,
  );

  protocol.attach(runtime);
  const first = bus.emitted.at(-1)?.value as ProcessesStatusSnapshotV2;
  assert.equal(first.version, 2);
  assert.equal(first.sessionScopeId, "session-a");
  assert.equal(first.revision, 4);
  assert.deepEqual(first.processes, [{ id: "proc_a", name: "api", kind: "process", state: "running" }]);
  assert.equal("row" in first, false);
  assert.equal("line" in first, false);

  const request = { version: 2, requestId: "request-1", sessionScopeId: "session-a", source: "statusline" };
  bus.emit(PROCESSES_SNAPSHOT_REQUEST_CHANNEL, request);
  bus.emit(PROCESSES_SNAPSHOT_REQUEST_CHANNEL, request);
  assert.equal(bus.emitted.filter((item) => item.channel === PROCESSES_STATUS_SNAPSHOT_CHANNEL).length, 2);

  bus.emit(PROCESSES_SNAPSHOT_REQUEST_CHANNEL, { ...request, requestId: "wrong", sessionScopeId: "session-b" });
  assert.equal(bus.emitted.filter((item) => item.channel === PROCESSES_STATUS_SNAPSHOT_CHANNEL).length, 2);

  protocol.detach();
  protocol.publish();
  assert.equal(bus.emitted.filter((item) => item.channel === PROCESSES_STATUS_SNAPSHOT_CHANNEL).length, 2);
  assert.deepEqual(reports, []);
});

test("managed snapshots atomically project pending starts, ownership and mailbox wake without changing statusline v2", async () => {
  const bus = new EventBus();
  let callbacks!: TransportCallbacks;
  let finishSpawn!: () => void;
  const spawning = new Promise<void>(resolve => { finishSpawn = resolve; });
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  const transport: HostTransport = {
    supervisorPid: 4101, closed: false,
    async request(type, payload) {
      if (type === "spawn") { await spawning; return { pid: 4102, pgid: 4102, startedAt, deadlineAt, stdinOpen: true, logRevision: 0, watchRevision: 0 }; }
      if (type === "clearRecords") return { outcomes: Object.fromEntries((payload.ids as string[]).map(id => [id, { cleared: true }])) };
      return { signal: "SIGTERM", delivered: true };
    },
    async cleanup() { return { unresolved: 0 }; }, async waitForExit() {}, terminate() {}, close() {},
  };
  const owner = new ProcessHost({ sessionScopeId: "managed-a", launch: async value => { callbacks = value; return transport; } });
  const runtime = { sessionScopeId: "managed-a", host: owner, managed: true, hasUI: false, open() {}, report() {} };
  const protocol = installProcessesStatusProtocol({ events: bus } as unknown as Pick<ExtensionAPI, "events">, () => runtime);
  const snapshots = () => bus.emitted.filter(event => event.channel === PROCESSES_MANAGED_SNAPSHOT_CHANNEL).map(event => event.value as ProcessesManagedSnapshotV1);
  const binding = owner.bind({ deliver() {} });
  await binding.markReady();
  protocol.attach(runtime);
  const first = snapshots().at(-1)!;
  assert.equal(first.revision, 0);
  assert.equal(first.supervisor_key, null);
  const config = defaultProcessesConfig();
  const start = owner.start({ action: "start", name: "private-name", command: "PRIVATE_SCRIPT", kind: "process", timeoutMs: 60_000, watches: [], continuation: { mode: "detached" }, notify: { onSuccess: "ignore" } }, { ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } }, "/tmp/private-cwd");
  const pending = snapshots().at(-1)!;
  assert.equal(pending.starting_count, 1);
  assert.deepEqual(pending.processes[0], { id: pending.processes[0]!.id, state: "starting", timeoutMs: 60_000, deadlineAt: null, group_key: null });
  finishSpawn();
  const record = await start;
  const running = snapshots().at(-1)!;
  assert.equal(running.running_count, 1);
  assert.equal(running.starting_count, 0);
  assert.equal(running.processes[0]!.deadlineAt, deadlineAt);
  assert.deepEqual(running.groups.map(({ kind, pid, pgid, parent_pid }) => ({ kind, pid, pgid, parent_pid })), [
    { kind: "supervisor", pid: 4101, pgid: 4101, parent_pid: ownPid },
    { kind: "command", pid: 4102, pgid: 4102, parent_pid: 4101 },
  ]);
  assert.equal(running.processes[0]!.group_key, running.groups[1]!.key);
  const beforeRepeat = owner.managedSnapshot().revision;
  protocol.publish();
  assert.equal(owner.managedSnapshot().revision, beforeRepeat);
  await owner.stop({ action: "stop", target: record.id });
  assert.equal(snapshots().at(-1)!.stopping_count, 1);
  callbacks.onEvent({ type: "terminal", eventSequence: 1, payload: { id: record.id, classification: "timeout", timeoutMs: 60_000, exitCode: null, signal: "SIGTERM" } });
  const ended = snapshots().at(-1)!;
  assert.equal(ended.wakePending, true);
  assert.deepEqual(ended.processes, []);
  assert.deepEqual(ended.release_groups, [running.groups[1]!.key]);
  assert.equal(owner.summary(record.id)!.terminal?.cause, "timeout");
  assert.equal(owner.summary(record.id)!.state, "failed");
  assert.equal(owner.managedSnapshot().host_generation, first.host_generation);
  for (const snapshot of snapshots()) {
    assert.equal(snapshot.starting_count + snapshot.running_count + snapshot.stopping_count, snapshot.processes.length);
    assert.equal(snapshot.processes.filter(record => record.state === "starting").length, snapshot.starting_count);
    assert.equal(snapshot.processes.filter(record => record.state === "running").length, snapshot.running_count);
    assert.equal(snapshot.processes.filter(record => record.state === "stopping").length, snapshot.stopping_count);
    assert.equal(JSON.stringify(snapshot).includes("PRIVATE_SCRIPT"), false);
    assert.equal(JSON.stringify(snapshot).includes("private-cwd"), false);
    assert.equal(JSON.stringify(snapshot).includes("private-name"), false);
    if (snapshot.revision > running.revision && snapshot.processes.length === 0) assert.equal(snapshot.wakePending, true);
  }
  const request = { version: 1, scope_id: "managed-a", requestId: "managed-1" };
  const count = snapshots().length;
  bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { ...request, scope_id: "foreign" });
  bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { ...request, requestId: "" });
  bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { ...request, requestId: "x".repeat(257) });
  bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { ...request, version: 2 });
  assert.equal(snapshots().length, count);
  bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, request);
  bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, request);
  assert.equal(snapshots().length, count + 1);
  bus.emit(PROCESSES_MANAGED_SNAPSHOT_REQUEST_CHANNEL, { ...request, requestId: "neutral-caller", source: "test-observer" });
  assert.equal(snapshots().length, count + 2, "caller labels never authorize or prevent a read-only snapshot");
  await owner.clear();
  assert.deepEqual(owner.managedSnapshot().groups, ended.groups, "short terminal candidates survive clear until bridge ACK");
  await binding.retire("scope-ended");
  assert.equal(snapshots().at(-1)!.cleanup, "closed");
  assert.deepEqual(new Set(snapshots().at(-1)!.release_groups), new Set(ended.groups.map(group => group.key)));
  protocol.detach();
  const replacement = new ProcessHost({ sessionScopeId: "managed-a", launch: async () => transport });
  assert.notEqual(replacement.managedSnapshot().host_generation, first.host_generation);
  await replacement.dispose("scope-ended");
});

test("managed short commands retain identity and wake when terminal arrives before spawn response", async () => {
  let callbacks!: TransportCallbacks;
  const transport: HostTransport = {
    supervisorPid: 4201, closed: false,
    async request(type, payload) {
      assert.equal(type, "spawn");
      callbacks.onEvent({ type: "terminal", eventSequence: 1, payload: { id: payload.id, classification: "natural", exitCode: 0, signal: null } });
      return { pid: 4202, pgid: 4202, stdinOpen: true, logRevision: 0, watchRevision: 0, startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 1000).toISOString() };
    },
    async cleanup() { return { unresolved: 0 }; }, async waitForExit() {}, terminate() {}, close() {},
  };
  const owner = new ProcessHost({ sessionScopeId: "early-terminal", launch: async value => { callbacks = value; return transport; } });
  const observations: ProcessesManagedSnapshotV1[] = [];
  owner.subscribeManagedState(() => { observations.push(owner.managedSnapshot()); });
  const config = defaultProcessesConfig();
  const result = await owner.start({ action: "start", name: "short", command: "true", kind: "process", timeoutMs: 1000, watches: [], continuation: { mode: "detached" } }, { ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } }, "/tmp");
  assert.equal(result.state, "succeeded");
  const last = observations.at(-1)!;
  assert.deepEqual(last.processes, []);
  assert.equal(last.wakePending, true);
  assert.equal(last.groups.length, 2);
  assert.deepEqual(last.release_groups, [last.groups[1]!.key]);
  assert.ok(observations.every(snapshot => snapshot.processes.length > 0 || snapshot.wakePending));
  await owner.dispose("scope-ended");
});

test("managed starting count clears after bounded Supervisor startup failure", async () => {
  const owner = new ProcessHost({ sessionScopeId: "failed-start", launch: async () => { throw new Error("FAULT startup"); } });
  const counts: number[] = [];
  owner.subscribeManagedState(() => { counts.push(owner.managedSnapshot().starting_count); });
  const config = defaultProcessesConfig();
  await assert.rejects(owner.start({ action: "start", name: "failed", command: "true", kind: "process", timeoutMs: 1000, watches: [], continuation: { mode: "detached" } }, { ...config, managed: { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" } }, "/tmp"), /FAULT startup/);
  assert.deepEqual(counts, [1, 0]);
  assert.equal(owner.managedSnapshot().supervisor_key, null);
  assert.deepEqual(owner.managedSnapshot().groups, []);
  await owner.dispose("scope-ended");
});

test("opens current targets once and rejects future/headless requests", () => {
  const bus = new EventBus();
  const opened: Array<string | undefined> = [];
  const reports: string[] = [];
  let runtime = {
    sessionScopeId: "session-a",
    host: host([process("proc_a", "api", "running")]),
    hasUI: true,
    open: (id?: string) => opened.push(id),
    report: (message: string) => reports.push(message),
  };
  const protocol = installProcessesStatusProtocol(
    { events: bus } as unknown as Pick<ExtensionAPI, "events">,
    () => runtime,
  );
  protocol.attach(runtime);

  const current = {
    version: 2,
    requestId: "open-1",
    sessionScopeId: "session-a",
    observedRevision: 4,
    source: "statusline",
    targetId: "proc_a",
  };
  bus.emit(PROCESSES_OPEN_REQUEST_CHANNEL, current);
  bus.emit(PROCESSES_OPEN_REQUEST_CHANNEL, current);
  assert.deepEqual(opened, ["proc_a"]);

  bus.emit(PROCESSES_OPEN_REQUEST_CHANNEL, { ...current, requestId: "missing", targetId: "proc_missing" });
  assert.deepEqual(opened, ["proc_a", undefined]);

  bus.emit(PROCESSES_OPEN_REQUEST_CHANNEL, { ...current, requestId: "future", observedRevision: 5 });
  assert.equal(reports.at(-1), "Ignored future process open request future");

  runtime = { ...runtime, hasUI: false };
  bus.emit(PROCESSES_OPEN_REQUEST_CHANNEL, { ...current, requestId: "headless" });
  assert.equal(reports.at(-1), "Ignored process open request without an active TUI");
});
