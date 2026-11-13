import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultProcessesConfig, loadProcessesConfig, validateProcessesConfig } from "../src/config.js";
import { isolationFixture } from "./isolation-fixture.ts";

test("exposes exact defaults and validates cross-field limits", () => {
  const defaults = defaultProcessesConfig();
  assert.equal(defaults.schemaVersion, 1);
  assert.equal(defaults.limits.maxLiveProcesses, 32);
  assert.equal(defaults.limits.maxTerminalRecords, 500);
  assert.equal(defaults.execution.stopGraceMs, 3000);
  assert.equal(defaults.managed, undefined);
  assert.throws(() => validateProcessesConfig({ ...defaults, limits: { ...defaults.limits, sessionLogBytes: 16_777_216, perProcessLogBytes: 67_108_864 } }), /must be >=/);
  assert.throws(() => validateProcessesConfig({ ...defaults, unknown: true }), /unknown key/);
});

test("validates complete managed policies and the frozen timeout ceiling", () => {
  const managed = { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" };
  assert.throws(() => validateProcessesConfig({ schemaVersion: 1, managed }), /execution.isolation.*required/);
  assert.deepEqual(validateProcessesConfig({ schemaVersion: 1, managed, execution: { isolation: isolationFixture } }).managed, managed);
  assert.equal(validateProcessesConfig({ schemaVersion: 1, managed: { ...managed, requireTimeout: false, maxTimeoutSeconds: 1 }, execution: { isolation: isolationFixture } }).managed?.requireTimeout, false);
  for (const value of [null, {}, { ...managed, requireTimeout: "true" }, { ...managed, terminalWake: "context" }, { ...managed, extra: true }]) {
    assert.throws(() => validateProcessesConfig({ schemaVersion: 1, managed: value }), /\$config\.managed/);
  }
  for (const value of [undefined, null, "7200", 0, -1, 1.5, 7201, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateProcessesConfig({ schemaVersion: 1, managed: { ...managed, maxTimeoutSeconds: value } }), /managed.maxTimeoutSeconds/);
  }
});

test("loads global/project config only for trusted projects and rejects duplicate keys", async (t) => {
  const home = join(tmpdir(), `pi-processes-home-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const cwd = join(tmpdir(), `pi-processes-cwd-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(home, "pi-processes"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })])); });
  await writeFile(join(home, "pi-processes", "config.json"), JSON.stringify({ schemaVersion: 1, limits: { maxLiveProcesses: 7 } }));
  await writeFile(join(cwd, ".pi", "pi-processes.json"), JSON.stringify({ schemaVersion: 1, limits: { maxLiveProcesses: 9 } }));
  const untrusted = await loadProcessesConfig({ agentDir: home, cwd, projectTrusted: false });
  assert.equal(untrusted.ok, true); if (untrusted.ok) assert.equal(untrusted.config.limits.maxLiveProcesses, 7);
  const trusted = await loadProcessesConfig({ agentDir: home, cwd, projectTrusted: true });
  assert.equal(trusted.ok, true); if (trusted.ok) assert.equal(trusted.config.limits.maxLiveProcesses, 9);
  await writeFile(join(cwd, ".pi", "pi-processes.json"), '{"schemaVersion":1,"limits":{"maxLiveProcesses":9,"maxLiveProcesses":10}}');
  const duplicate = await loadProcessesConfig({ agentDir: home, cwd, projectTrusted: true });
  assert.equal(duplicate.ok, false); if (!duplicate.ok) assert.match(duplicate.diagnostic.message, /duplicate key/);
});

test("accepts managed policy only from agentDir and locks its helper runtime before project merge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-processes-managed-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  const globalPath = join(agentDir, "pi-processes", "config.json"), projectPath = join(cwd, ".pi", "pi-processes.json");
  await mkdir(join(agentDir, "pi-processes"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const managed = { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" };
  const global = { schemaVersion: 1, execution: { shell: "/bin/sh", helperRuntime: process.execPath, isolation: isolationFixture }, managed };
  await writeFile(globalPath, JSON.stringify(global));
  await writeFile(projectPath, JSON.stringify({ schemaVersion: 1, execution: { stopGraceMs: 500 }, notifications: { onSuccess: "ignore" } }));
  const allowed = await loadProcessesConfig({ agentDir, cwd, projectTrusted: true });
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.deepEqual(allowed.config.managed, managed);
    assert.equal(allowed.config.execution.helperRuntime, process.execPath);
    assert.equal(allowed.config.execution.stopGraceMs, 500);
    assert.equal(allowed.config.notifications.onSuccess, "ignore");
  }
  for (const project of [
    { managed },
    { managed: null },
    { execution: { helperRuntime: process.execPath } },
    { execution: { helperRuntime: "auto" } },
    { execution: { helperRuntime: null } },
    { execution: null },
  ]) {
    await writeFile(projectPath, JSON.stringify({ schemaVersion: 1, ...project }));
    const result = await loadProcessesConfig({ agentDir, cwd, projectTrusted: true });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostic.source, "project");
      assert.ok(result.diagnostic.path.startsWith(projectPath));
    }
  }
  await writeFile(projectPath, JSON.stringify({ schemaVersion: 1, managed: { requireTimeout: false } }));
  const untrusted = await loadProcessesConfig({ agentDir, cwd, projectTrusted: false });
  assert.equal(untrusted.ok, true);
  if (untrusted.ok) assert.deepEqual(untrusted.config.managed, managed);
  await writeFile(globalPath, JSON.stringify({ ...global, managed: { ...managed, maxTimeoutSeconds: 7201 } }));
  const invalidGlobal = await loadProcessesConfig({ agentDir, cwd, projectTrusted: true });
  assert.equal(invalidGlobal.ok, false);
  if (!invalidGlobal.ok) {
    assert.equal(invalidGlobal.diagnostic.source, "global");
    assert.match(invalidGlobal.diagnostic.message, /managed.maxTimeoutSeconds/);
  }
  await writeFile(globalPath, JSON.stringify({ schemaVersion: 1, execution: { shell: global.execution.shell, helperRuntime: global.execution.helperRuntime } }));
  const projectOnly = await loadProcessesConfig({ agentDir, cwd, projectTrusted: true });
  assert.equal(projectOnly.ok, false);
  if (!projectOnly.ok) assert.match(projectOnly.diagnostic.message, /managed: is only allowed in agentDir config/);
  await writeFile(projectPath, JSON.stringify({ schemaVersion: 1, execution: { helperRuntime: "/bin/sh" } }));
  const daily = await loadProcessesConfig({ agentDir, cwd, projectTrusted: true });
  assert.equal(daily.ok, true);
  if (daily.ok) {
    assert.equal(daily.config.managed, undefined);
    assert.equal(daily.config.execution.helperRuntime, "/bin/sh");
  }
});

test("accepts a shell symlink resolving to dash while retaining executable policy checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-processes-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), config = join(agentDir, "pi-processes", "config.json");
  await mkdir(join(agentDir, "pi-processes"), { recursive: true });
  // Only executable admission is exercised; this self-owned fixture is never run.
  const dash = join(root, "dash"), shell = join(root, "shell-link"), other = join(root, "fish");
  await writeFile(dash, "shell fixture", { mode: 0o700 });
  await writeFile(other, "shell fixture", { mode: 0o700 });
  await symlink(dash, shell);
  const load = async (path: string) => {
    await writeFile(config, JSON.stringify({ schemaVersion: 1, execution: { shell: path } }));
    return loadProcessesConfig({ agentDir, cwd: root, projectTrusted: false });
  };
  const accepted = await load(shell);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  if (accepted.ok) assert.equal(accepted.config.execution.shell, shell);
  const relative = await load("relative/dash");
  assert.equal(relative.ok, false);
  if (!relative.ok) assert.match(relative.diagnostic.message, /must be absolute/);
  await chmod(dash, 0o600);
  const notExecutable = await load(shell);
  assert.equal(notExecutable.ok, false);
  if (!notExecutable.ok) assert.match(notExecutable.diagnostic.message, /EACCES/);
  const unsupported = await load(other);
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.diagnostic.message, /unsupported executable basename/);
});
