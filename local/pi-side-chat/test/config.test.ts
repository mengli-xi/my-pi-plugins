import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSdkOnlyEnvironment, loadConfig, parseConfig } from "../config.ts";

test("SDK-only config preserves shortcut and ignores unrelated fields", () => {
  assert.deepEqual(parseConfig({}), { shortcut: "alt+/" });
  assert.deepEqual(parseConfig({ shortcut: " alt+s ", futureSetting: true }), { shortcut: "alt+s" });
  assert.throws(() => parseConfig({ shortcut: " " }), /shortcut 必须是非空快捷键/);
});

test("retired config keys are rejected even with empty or SDK values", () => {
  for (const value of ["sdk", "handoff", undefined]) {
    assert.throws(() => parseConfig({ defaultBackend: value }), /删除 defaultBackend；Side Chat 现在只支持同进程运行/);
  }
  for (const value of [[], null, undefined]) {
    assert.throws(() => parseConfig({ extensionCommands: value }), /删除 extensionCommands；Side Chat 现在只支持同进程运行/);
  }
});

test("retired backend environment is rejected instead of silently selecting a backend", () => {
  assert.doesNotThrow(() => assertSdkOnlyEnvironment({}));
  for (const value of ["sdk", "pty", "", "unknown"]) {
    assert.throws(() => assertSdkOnlyEnvironment({ PI_SIDE_BACKEND: value }), /只支持同进程运行。请移除环境变量 PI_SIDE_BACKEND 后重启 pi/);
  }
});

test("config diagnostics identify the actual file and the key to remove", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-side-config-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  for (const key of ["defaultBackend", "extensionCommands"]) {
    writeFileSync(path, JSON.stringify({ [key]: [] }));
    assert.throws(() => loadConfig(path), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`请从 ${path} 删除 ${key}`));
      assert.ok(error.message.includes("修改后请重启 pi"));
      return true;
    });
  }
});
