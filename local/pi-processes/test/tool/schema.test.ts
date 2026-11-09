import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import { PROCESS_TOOL_SCHEMA } from "../../src/tool/register.js";
import { parseSpawn } from "../../src/supervisor/types.js";
import { parseToolInput } from "../../src/tool/input.js";

const validInputs: readonly Record<string, unknown>[] = [
  {
    action: "start",
    name: "api",
    kind: "monitor",
    command: "npm run dev",
    watches: [{ key: "ready", pattern: "listening", mode: "literal", stream: "both", repeat: false, attention: "turn" }],
    continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
    notify: { onSuccess: "turn", onFailure: "context", onKilled: "ignore", onCrash: "turn" },
  },
  { action: "list", states: ["running", "succeeded"], sort: "name-asc", limit: 20 },
  { action: "logs", target: "api", stream: "both", tailLines: 25, pattern: "ready", mode: "literal" },
  { action: "input", target: "api", data: "reload\n", eof: false },
  {
    action: "configure",
    target: "api",
    name: "api-next",
    kind: "service",
    watchUpdate: { operation: "upsert", items: [{ key: "done", pattern: "complete", attention: "context" }] },
    continuation: { mode: "detached" },
    notify: { onSuccess: null, onCrash: "turn" },
  },
  { action: "stop", target: "api" },
  { action: "clear" },
];

test("every valid strict action also passes the provider-facing schema", () => {
  for (const input of validInputs) {
    assert.equal(Check(PROCESS_TOOL_SCHEMA, input), true, JSON.stringify(input));
    assert.doesNotThrow(() => parseToolInput(input));
  }
});

test("provider kind shape matches the strict role contract", () => {
  for (const kind of ["process", "monitor", "service"]) {
    assert.equal(Check(PROCESS_TOOL_SCHEMA, { action: "start", name: "api", kind, command: "x" }), true);
    assert.doesNotThrow(() => parseToolInput({ action: "start", name: "api", kind, command: "x" }));
  }
  assert.throws(() => parseToolInput({ action: "start", name: "api", kind: "daemon", command: "x" }), /unsupported value/);
});

test("provider target shape matches the strict string target contract", () => {
  assert.equal(Check(PROCESS_TOOL_SCHEMA, { action: "logs", target: "api", tailLines: 10 }), true);
  assert.equal(Check(PROCESS_TOOL_SCHEMA, { action: "logs", target: { name: "api" }, tailLines: 10 }), false);
  assert.throws(
    () => parseToolInput({ action: "logs", target: { name: "api" }, tailLines: 10 }),
    /target must be a string/,
  );
});

test("provider descriptions expose strict list and notification values", () => {
  const properties = (PROCESS_TOOL_SCHEMA as unknown as { properties: Record<string, { description?: string }> }).properties;
  assert.match(properties.states.description ?? "", /starting, running, stopping, succeeded, failed, stopped, killed, crashed/);
  assert.match(properties.sort.description ?? "", /started-desc, started-asc, name-asc, or state/);
  assert.match(properties.notify.description ?? "", /Do not pass a boolean or string/);
  assert.match(properties.command.description ?? "", /multiline source/);
});

test("common guessed values fail at the public action boundary", () => {
  assert.throws(() => parseToolInput({ action: "list", states: ["exited"] }), /states\[0\].*unsupported value/);
  assert.throws(() => parseToolInput({ action: "list", sort: "recent" }), /sort.*unsupported value/);
  assert.throws(() => parseToolInput({ action: "start", name: "api", command: "x", notify: false }), /notify must be an object/);
  assert.throws(() => parseToolInput({ action: "start", name: "api", command: "x", notify: "turn" }), /notify must be an object/);
  assert.throws(() => parseToolInput({ action: "start", name: "name-is-far-too-long", command: "x" }), /name.*16 terminal columns/);
});

test("multiline shell source survives public and supervisor validation", () => {
  const command = "printf 'first\\n'\nprintf 'second\\n'";
  const parsed = parseToolInput({ action: "start", name: "multi", command });
  assert.equal(parsed.action, "start");
  if (parsed.action !== "start") assert.fail("expected start input");
  assert.equal(parsed.command, command);
  assert.equal(parseSpawn({
    operationId: crypto.randomUUID(),
    id: `proc_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    name: "multi",
    command,
    cwd: process.cwd(),
    shell: "/bin/sh",
    stopGraceMs: 100,
    logLimits: { perProcessBytes: 1_048_576, sessionBytes: 16_777_216, lineBytes: 65_536 },
    watches: [],
  }).command, command);
});
