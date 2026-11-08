import assert from "node:assert/strict";
import test from "node:test";
import { assertSdkOnlyBackend } from "../../src/host/service-cell.js";

test("all former backend settings are rejected with removal instructions", () => {
  const before = process.env.PI_SUBAGENTS_BACKEND;
  try {
    delete process.env.PI_SUBAGENTS_BACKEND;
    assert.doesNotThrow(assertSdkOnlyBackend);
    for (const value of ["sdk", "process", "", "unknown"]) {
      process.env.PI_SUBAGENTS_BACKEND = value;
      assert.throws(assertSdkOnlyBackend, /PI_SUBAGENTS_BACKEND.*后端选择已移除.*删除此变量/);
    }
  } finally {
    if (before === undefined) delete process.env.PI_SUBAGENTS_BACKEND;
    else process.env.PI_SUBAGENTS_BACKEND = before;
  }
});
