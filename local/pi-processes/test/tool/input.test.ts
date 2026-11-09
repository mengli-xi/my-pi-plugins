import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import type { ManagedProcessesPolicy } from "../../src/config.js";
import { isolatedProcessesConfig as defaultProcessesConfig } from "../isolation-fixture.ts";
import { ProcessHost, type HostTransport } from "../../src/host/process-host.js";
import { ProcessInputError, parseToolInput } from "../../src/tool/input.js";
import { createProcessToolSchema, registerProcessTool, type ProcessToolRuntime } from "../../src/tool/register.js";

test("parses all seven actions with defaults", () => {
  assert.deepEqual(parseToolInput({ action: "start", name: "api", command: "npm start" }), {
    action: "start", name: "api", kind: "process", command: "npm start", watches: [], continuation: { mode: "detached" },
  });
  assert.deepEqual(parseToolInput({ action: "list" }), { action: "list", sort: "started-desc", limit: 50 });
  assert.deepEqual(parseToolInput({ action: "logs", target: "api" }), { action: "logs", target: "api", stream: "both", tailLines: 100, mode: "literal" });
  assert.deepEqual(parseToolInput({ action: "input", target: "api", eof: true }), { action: "input", target: "api", eof: true });
  assert.deepEqual(parseToolInput({ action: "configure", target: "api", name: "web" }), { action: "configure", target: "api", name: "web" });
  assert.deepEqual(parseToolInput({ action: "configure", target: "api", kind: "service" }), { action: "configure", target: "api", kind: "service" });
  assert.deepEqual(parseToolInput({ action: "stop", target: "api" }), { action: "stop", target: "api" });
  assert.deepEqual(parseToolInput({ action: "clear" }), { action: "clear" });
});

test("converts start timeout seconds to safe milliseconds without imposing the managed ceiling on daily use", () => {
  const start = { action: "start", name: "api", command: "npm start" };
  for (const seconds of [1, 7200, 7201, Math.floor(Number.MAX_SAFE_INTEGER / 1000)]) {
    const input = parseToolInput({ ...start, timeout: seconds });
    assert.equal(input.action, "start");
    assert.equal(input.timeoutMs, seconds * 1000);
    assert.equal(Number.isSafeInteger(input.timeoutMs), true);
    assert.equal(Object.hasOwn(input, "timeout"), false);
  }
  for (const timeout of [undefined, null, "60", 0, -1, 1.5, NaN, Infinity, Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => parseToolInput({ ...start, timeout }), /\$input.timeout must be an integer/);
  }
});

test("requires and caps managed start timeout while leaving other actions usable", () => {
  const managed: ManagedProcessesPolicy = { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" };
  const start = { action: "start", name: "api", command: "npm start" };
  assert.throws(() => parseToolInput(start, managed), /\$input.timeout is required/);
  for (const timeout of [1, managed.maxTimeoutSeconds]) {
    const input = parseToolInput({ ...start, timeout }, managed);
    assert.equal(input.action, "start");
    assert.equal(input.timeoutMs, timeout * 1000);
  }
  assert.throws(() => parseToolInput({ ...start, timeout: 7201 }, managed), /1..7200/);
  const optional = { ...managed, requireTimeout: false, maxTimeoutSeconds: 60 };
  assert.deepEqual(parseToolInput(start, optional), parseToolInput(start));
  assert.throws(() => parseToolInput({ ...start, timeout: 61 }, optional), /1..60/);
  for (const action of [
    { action: "list" }, { action: "logs", target: "api" }, { action: "input", target: "api", eof: true },
    { action: "configure", target: "api", name: "web" }, { action: "stop", target: "api" }, { action: "clear" },
  ]) {
    assert.doesNotThrow(() => parseToolInput(action, managed));
    assert.throws(() => parseToolInput({ ...action, timeout: 60 }, managed), /\$input.timeout is not valid for this action/);
    assert.throws(() => parseToolInput({ ...action, timeout: 60 }), /\$input.timeout is not valid for this action/);
  }
});

test("publishes current managed timeout requirements only for start and refreshes changed policy", () => {
  const managed: ManagedProcessesPolicy = { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" };
  const start = { action: "start", name: "api", command: "npm start" };
  const schema = createProcessToolSchema(managed);
  assert.equal(Check(schema, start), false);
  assert.equal(Check(schema, { ...start, timeout: 1 }), true);
  assert.equal(Check(schema, { ...start, timeout: 7201 }), false);
  assert.equal(Check(schema, { action: "list" }), true);
  assert.equal(Check(createProcessToolSchema(), start), true);
  assert.equal(Check(createProcessToolSchema(), { ...start, timeout: 7201 }), true);
  let runtime: ProcessToolRuntime | undefined;
  const definitions: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
  const pi = { registerTool(definition: Parameters<ExtensionAPI["registerTool"]>[0]) { definitions.push(definition); } } as unknown as ExtensionAPI;
  const refreshSchema = registerProcessTool(pi, () => runtime);
  assert.equal(definitions.length, 1);
  assert.equal(Check(definitions.at(-1)!.parameters, start), true);
  runtime = { config: { ...defaultProcessesConfig(), managed }, host: {} as ProcessToolRuntime["host"], cwd: "/" };
  assert.throws(() => definitions.at(-1)!.prepareArguments!(start), /timeout is required/);
  refreshSchema();
  assert.equal(definitions.length, 2);
  assert.equal(Check(definitions.at(-1)!.parameters, start), false);
  refreshSchema();
  assert.equal(definitions.length, 2);
  runtime.config = { ...runtime.config, managed: { ...managed, maxTimeoutSeconds: 60 } };
  refreshSchema();
  assert.equal(definitions.length, 3);
  assert.equal(Check(definitions.at(-1)!.parameters, { ...start, timeout: 61 }), false);
  assert.throws(() => definitions.at(-1)!.prepareArguments!({ ...start, timeout: 61 }), /1..60/);
  runtime.config = defaultProcessesConfig();
  refreshSchema();
  assert.equal(definitions.length, 4);
  assert.equal(Check(definitions.at(-1)!.parameters, start), true);
  assert.deepEqual(definitions.at(-1)!.prepareArguments!(start), start);
});

test("public start counts cold Supervisor admission and keeps omitted daily timeout unlimited", async () => {
  let release!: (transport: HostTransport) => void;
  const cold = new Promise<HostTransport>(resolve => { release = resolve; });
  const host = new ProcessHost({ sessionScopeId: "tool-cold", launch: () => cold });
  const managed: ManagedProcessesPolicy = { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" };
  const runtime = { host, config: { ...defaultProcessesConfig(), managed }, cwd: "/tmp" } as ProcessToolRuntime;
  let definition!: Parameters<ExtensionAPI["registerTool"]>[0];
  const pi = { registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) { definition = value; } } as unknown as ExtensionAPI;
  registerProcessTool(pi, () => runtime);
  const execute = (input: Record<string, unknown>) => definition.execute("tool-cold", input, undefined, undefined, { cwd: "/tmp" } as ExtensionToolContext);
  await assert.rejects(execute({ action: "start", name: "api", command: "true" }), /timeout is required/);
  assert.equal(host.managedSnapshot().starting_count, 0);
  const started = execute({ action: "start", name: "api", command: "true", timeout: 1 });
  assert.equal(host.managedSnapshot().starting_count, 1, "tool must not await helper before pending start registration");
  release({
    supervisorPid: 4301, closed: false,
    async request() { return { pid: 4302, pgid: 4302, stdinOpen: true, logRevision: 0, watchRevision: 0 }; },
    async cleanup() { return { unresolved: 0 }; }, async waitForExit() {}, terminate() {}, close() {},
  });
  await started;
  assert.equal(host.records()[0]!.timeoutMs, 1000);
  runtime.config = defaultProcessesConfig();
  await execute({ action: "start", name: "daily", command: "true" });
  assert.equal(host.records().find(record => record.name === "daily")!.timeoutMs, undefined);
  await host.dispose("scope-ended");
});

test("validates nested watch and continuation branches", () => {
  const parsed = parseToolInput({
    action: "start", name: "api", command: "npm start",
    watches: [{ key: "ready", pattern: "listening", mode: "regex", stream: "stdout", repeat: true, attention: "context" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
  });
  assert.equal(parsed.action, "start");
  assert.deepEqual(parsed.watches[0], { key: "ready", pattern: "listening", mode: "regex", stream: "stdout", repeat: true, attention: "context" });
  assert.deepEqual(parsed.continuation, { mode: "wait", until: { kind: "watch", key: "ready" } });
});

test("rejects action-inapplicable, inherited, accessor and symbol keys", () => {
  assert.throws(() => parseToolInput({ action: "start", name: "api", command: "x", tailLines: 3 }), ProcessInputError);
  const inherited = Object.create({ target: "api" }) as Record<string, unknown>;
  inherited.action = "stop";
  assert.throws(() => parseToolInput(inherited), /plain object/);
  const accessor = { action: "clear" } as Record<string, unknown>;
  Object.defineProperty(accessor, "surprise", { enumerable: true, get: () => 1 });
  assert.throws(() => parseToolInput(accessor), /accessor/);
  const symbolic = { action: "clear", [Symbol("x")]: true };
  assert.throws(() => parseToolInput(symbolic), /symbol keys/);
});

test("enforces identity, byte and exact mutation constraints", () => {
  assert.throws(() => parseToolInput({ action: "start", name: "abcdefghijklmnopq", command: "x" }), /1..16 terminal columns/);
  assert.throws(() => parseToolInput({ action: "start", name: "api", command: "x", continuation: { mode: "wait", until: { kind: "watch", key: "ready" } } }), /configured watch/);
  assert.throws(() => parseToolInput({ action: "logs", target: "api", mode: "regex" }), /requires pattern/);
  assert.throws(() => parseToolInput({ action: "input", target: "api", eof: false }), /requires non-empty data/);
  assert.throws(() => parseToolInput({ action: "configure", target: "api" }), /at least one mutation/);
  assert.throws(() => parseToolInput({ action: "configure", target: "api", watchUpdate: { operation: "remove", keys: [] } }), /1..20 keys/);
  assert.throws(() => parseToolInput({ action: "list", states: [] }), /non-empty array/);
  assert.throws(() => parseToolInput({ action: "start", name: "api", command: "x", kind: "daemon" }), /unsupported value/);
  assert.throws(() => parseToolInput({ action: "configure", target: "api", kind: "daemon" }), /unsupported value/);
});
