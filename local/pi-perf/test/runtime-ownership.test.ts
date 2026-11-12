import assert from "node:assert/strict";
import test from "node:test";
import { acquirePerfRuntimeOwnership, PERF_RUNTIME_KEY } from "../src/runtime-ownership.ts";

test("a reloaded perf runtime synchronously retires the previous owner", () => {
  const host = globalThis as Record<PropertyKey, unknown>;
  Reflect.deleteProperty(host, PERF_RUNTIME_KEY);
  const retired: string[] = [];
  const first = acquirePerfRuntimeOwnership(() => retired.push("first"));
  assert.equal(first.replaced, false);

  const second = acquirePerfRuntimeOwnership(() => retired.push("second"));
  assert.equal(second.replaced, true);
  assert.deepEqual(retired, ["first"]);

  first.release();
  assert.notEqual(host[PERF_RUNTIME_KEY], undefined, "a stale release must not clear the replacement");
  second.release();
  assert.equal(host[PERF_RUNTIME_KEY], undefined);
});

test("retirement and release are idempotent across another takeover", () => {
  const host = globalThis as Record<PropertyKey, unknown>;
  Reflect.deleteProperty(host, PERF_RUNTIME_KEY);
  let retired = 0;
  const first = acquirePerfRuntimeOwnership(() => retired++);
  const second = acquirePerfRuntimeOwnership(() => retired++);
  first.release();
  first.release();
  const third = acquirePerfRuntimeOwnership(() => retired++);
  assert.equal(retired, 2);
  second.release();
  third.release();
  assert.equal(host[PERF_RUNTIME_KEY], undefined);
});
