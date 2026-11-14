import { currentBuild } from "../../../../scripts/retained-build.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { assertProcessesExecutionIsolationCurrent, loadProcessesConfig } from "../../src/config.ts";
import { executionIsolationBootstrap, parseExecutionIsolationBootstrap, readRequiredExecutionIsolation, REQUIRED_EXECUTION_ISOLATION_ENV, SUPERVISOR_EXECUTION_ISOLATION_ENV, validateExecutionIsolation } from "../../src/execution-isolation.ts";
import { createProcessHost } from "../../src/process-runtime.ts";
import { commandEnvironment } from "../../src/supervisor/command-environment.ts";
import { SupervisorClient } from "../../src/host/supervisor-client.ts";
import { ProcessHost, type HostTransport } from "../../src/host/process-host.ts";
import { isolationFixture } from "../isolation-fixture.ts";

const distDirectory = currentBuild(new URL("../../", import.meta.url));
const managed = { requireTimeout: true, maxTimeoutSeconds: 7200, terminalWake: "required" };
const identity = { version: 1, owner: isolationFixture.owner, revision: isolationFixture.revision };

function setEnvironment(t: test.TestContext, values: Record<string, string | undefined>): void {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = (env: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => { apply(before); });
}

async function profile(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "process-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  await mkdir(join(agentDir, "pi-processes"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const globalPath = join(agentDir, "pi-processes", "config.json"), projectPath = join(cwd, ".pi", "pi-processes.json");
  const config = { schemaVersion: 1, managed, execution: { shell: "/bin/sh", helperRuntime: process.execPath, isolation: isolationFixture } };
  await writeFile(globalPath, JSON.stringify(config));
  return { root, agentDir, cwd, globalPath, projectPath, config };
}

async function rejection(operation: () => void | Promise<void>): Promise<unknown> {
  try { await operation(); } catch (error) { return error; }
  assert.fail("expected rejection");
}

test("required declarations and isolation policies are strict, bounded and deeply frozen", () => {
  const policy = validateExecutionIsolation({ ...isolationFixture, removeEnv: ["Z_PRIVATE", "A_PRIVATE"] });
  assert.deepEqual(policy.removeEnv, ["A_PRIVATE", "Z_PRIVATE"]);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.removeEnv));
  for (const value of [null, {}, { ...identity, removeEnv: ["X", "X"] }, { ...identity, removeEnv: ["BAD=KEY"] }, { ...identity, removeEnv: [], extra: true }, { ...identity, revision: 0, removeEnv: [] }]) {
    assert.throws(() => validateExecutionIsolation(value), /execution-isolation/);
  }
  for (const value of ["", "null", "{}", '{"version":1,"owner":"one","owner":"two","revision":1}', JSON.stringify({ ...identity, revision: "1" }), JSON.stringify({ ...identity, extra: true })]) {
    assert.throws(() => readRequiredExecutionIsolation({ [REQUIRED_EXECUTION_ISOLATION_ENV]: value }));
  }
  const raw = JSON.stringify(identity);
  const required = readRequiredExecutionIsolation({ [REQUIRED_EXECUTION_ISOLATION_ENV]: raw });
  assert.deepEqual(required, identity);
  assert.equal(readRequiredExecutionIsolation({ [REQUIRED_EXECUTION_ISOLATION_ENV]: raw }), required, "unchanged declaration reuses its parsed identity");
});

test("required isolation rejects missing/mismatched global policy, invalid declarations and project overrides", async t => {
  const p = await profile(t);
  setEnvironment(t, { [REQUIRED_EXECUTION_ISOLATION_ENV]: JSON.stringify(identity) });
  assert.equal((await loadProcessesConfig({ ...p, projectTrusted: true })).ok, true);
  for (const config of [
    { schemaVersion: 1 },
    { schemaVersion: 1, managed },
    { ...p.config, execution: { ...p.config.execution, isolation: { ...isolationFixture, revision: 2 } } },
  ]) {
    await writeFile(p.globalPath, JSON.stringify(config));
    assert.equal((await loadProcessesConfig({ ...p, projectTrusted: true })).ok, false);
  }
  await writeFile(p.globalPath, JSON.stringify({ schemaVersion: 1, execution: p.config.execution }));
  await writeFile(p.projectPath, JSON.stringify({ schemaVersion: 1, execution: { helperRuntime: process.execPath } }));
  delete process.env[REQUIRED_EXECUTION_ISOLATION_ENV];
  const helperOverride = await loadProcessesConfig({ ...p, projectTrusted: true });
  assert.equal(helperOverride.ok, false, "isolation alone locks the owner helper, even without managed or required markers");
  process.env[REQUIRED_EXECUTION_ISOLATION_ENV] = JSON.stringify(identity);
  await writeFile(p.globalPath, JSON.stringify(p.config));
  for (const value of [null, isolationFixture, { ...isolationFixture, removeEnv: [] }]) {
    await writeFile(p.projectPath, JSON.stringify({ schemaVersion: 1, execution: { isolation: value } }));
    const result = await loadProcessesConfig({ ...p, projectTrusted: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostic.message, /only allowed in agentDir/);
    assert.equal((await loadProcessesConfig({ ...p, projectTrusted: false })).ok, true);
  }
  await rm(p.projectPath);
  process.env[REQUIRED_EXECUTION_ISOLATION_ENV] = "";
  assert.equal((await loadProcessesConfig({ ...p, projectTrusted: true })).ok, false);
  delete process.env[REQUIRED_EXECUTION_ISOLATION_ENV];
  await writeFile(p.globalPath, JSON.stringify({ schemaVersion: 1, managed }));
  assert.equal((await loadProcessesConfig({ ...p, projectTrusted: true })).ok, false, "explicit managed configuration must never fall back without isolation");
});

test("frozen authority detects declaration removal, key drift, inode replacement and late project override", async t => {
  const p = await profile(t);
  setEnvironment(t, { [REQUIRED_EXECUTION_ISOLATION_ENV]: JSON.stringify(identity) });
  const loaded = await loadProcessesConfig({ ...p, projectTrusted: true });
  assert.ok(loaded.ok);
  assert.ok(Object.isFrozen(loaded.config));
  assert.ok(Object.isFrozen(loaded.config.execution.isolation!.removeEnv));
  await assertProcessesExecutionIsolationCurrent(loaded.config);
  delete process.env[REQUIRED_EXECUTION_ISOLATION_ENV];
  await assert.rejects(async () => assertProcessesExecutionIsolationCurrent(loaded.config), /drifted/);
  process.env[REQUIRED_EXECUTION_ISOLATION_ENV] = JSON.stringify(identity);
  const before = await stat(p.globalPath);
  const replacementPath = `${p.globalPath}.replacement`;
  const changed = JSON.stringify(p.config).replace("TEST_REPLY_FD", "TEST_OTHER_FD");
  assert.equal(Buffer.byteLength(changed), before.size);
  await writeFile(replacementPath, changed);
  await utimes(replacementPath, before.atime, before.mtime);
  await rename(replacementPath, p.globalPath);
  await assert.rejects(async () => assertProcessesExecutionIsolationCurrent(loaded.config), /authority drifted/);
  await writeFile(p.globalPath, JSON.stringify(p.config));
  await assertProcessesExecutionIsolationCurrent(loaded.config);
  await writeFile(p.projectPath, JSON.stringify({ schemaVersion: 1, execution: { isolation: isolationFixture } }));
  await assert.rejects(async () => assertProcessesExecutionIsolationCurrent(loaded.config), /only allowed in agentDir/);
  await rm(p.projectPath);
  await writeFile(p.globalPath, '{"schemaVersion":1,"schemaVersion":1}');
  const first = await rejection(() => assertProcessesExecutionIsolationCurrent(loaded.config));
  const second = await rejection(() => assertProcessesExecutionIsolationCurrent(loaded.config));
  assert.equal(first, second, "unchanged invalid JSON reuses the cached parse failure");
  await writeFile(p.globalPath, JSON.stringify(p.config));
  await assertProcessesExecutionIsolationCurrent(loaded.config);
});

test("late required declarations cannot turn a previously ordinary scope into an authorized one", async t => {
  const p = await profile(t);
  setEnvironment(t, { [REQUIRED_EXECUTION_ISOLATION_ENV]: undefined });
  await writeFile(p.globalPath, JSON.stringify({ schemaVersion: 1 }));
  const loaded = await loadProcessesConfig({ ...p, projectTrusted: true });
  assert.ok(loaded.ok);
  const host = createProcessHost(`late-isolation-${crypto.randomUUID()}`, () => loaded.config, distDirectory);
  try {
    process.env[REQUIRED_EXECUTION_ISOLATION_ENV] = JSON.stringify(identity);
    await assert.rejects(host.start({ action: "start", name: "denied", command: "exit 0", kind: "process", watches: [], continuation: { mode: "detached" } }, loaded.config, p.cwd), /required policy is missing/);
    assert.equal(host.records().length, 0);
    await writeFile(p.globalPath, JSON.stringify(p.config));
    const fresh = await loadProcessesConfig({ ...p, projectTrusted: true });
    assert.ok(fresh.ok);
    assert.throws(() => createProcessHost(host.sessionScopeId, () => fresh.config, distDirectory), /cannot rebind/);
  } finally { await host.dispose("scope-ended"); }
});

test("declaration drift during cold Supervisor startup rejects the command before spawn", async t => {
  const p = await profile(t);
  setEnvironment(t, { [REQUIRED_EXECUTION_ISOLATION_ENV]: JSON.stringify(identity) });
  const loaded = await loadProcessesConfig({ ...p, projectTrusted: true });
  assert.ok(loaded.ok);
  let ready!: (transport: HostTransport) => void;
  let launchStarted!: () => void;
  const started = new Promise<void>(resolve => { launchStarted = resolve; });
  const cold = new Promise<HostTransport>(resolve => { ready = resolve; });
  let spawnCount = 0;
  const host = new ProcessHost({ sessionScopeId: "cold-isolation", launch: () => { launchStarted(); return cold; } });
  const request = host.start({ action: "start", name: "cold", command: "exit 0", kind: "process", timeoutMs: 1000, watches: [], continuation: { mode: "detached" } }, loaded.config, p.cwd);
  await started;
  delete process.env[REQUIRED_EXECUTION_ISOLATION_ENV];
  ready({ supervisorPid: process.pid, closed: false, async request() { spawnCount += 1; return {}; }, async cleanup() { return { unresolved: 0 }; }, async waitForExit() {}, terminate() {}, close() {} });
  await assert.rejects(request, /declaration drifted/);
  assert.equal(spawnCount, 0);
  assert.equal(host.managedSnapshot().starting_count, 0);
  await host.dispose("scope-ended");
});

test("command isolation removes only declared owner keys and preserves ordinary environment", () => {
  const keys = ["EXAMPLE_OWNER_ACTIVE", "EXAMPLE_PROVIDER", "EXAMPLE_REQUEST_FD", "EXAMPLE_REPLY_FD", "EXAMPLE_PARENT_PID", "EXAMPLE_PAUSE", "EXAMPLE_SCHEMA", "EXAMPLE_MODE"];
  const env = { ...Object.fromEntries(keys.map(key => [key, "private"])), BUN_BE_BUN: "1", PI_PROCESSES_SUPERVISOR_NONCE: "private", [REQUIRED_EXECUTION_ISOLATION_ENV]: JSON.stringify(identity), TEST_BROKER_ID: "private", TEST_REPLY_FD: "99", PATH: "/bin", PUBLIC_ENV: "keep" };
  const policy = { ...isolationFixture, removeEnv: [...isolationFixture.removeEnv, ...keys] };
  const clean = commandEnvironment(env, policy);
  assert.deepEqual(clean, { PATH: "/bin", PUBLIC_ENV: "keep" });
  const ordinary = commandEnvironment(env);
  for (const key of keys) assert.equal(ordinary[key], "private", "unknown identities are not inferred without a policy");
  assert.equal(ordinary.TEST_BROKER_ID, "private", "ordinary mode preserves undeclared environment");
  assert.equal(ordinary.BUN_BE_BUN, undefined);
  assert.equal(ordinary.PI_PROCESSES_SUPERVISOR_NONCE, undefined);
  assert.equal(ordinary[REQUIRED_EXECUTION_ISOLATION_ENV], undefined);
  assert.equal(env.TEST_BROKER_ID, "private", "never mutate the owner environment");
});

test("real Host serializes frozen isolation to Supervisor and rejects drift before another command", async t => {
  const p = await profile(t);
  setEnvironment(t, { [REQUIRED_EXECUTION_ISOLATION_ENV]: JSON.stringify(identity), TEST_BROKER_ID: "private", TEST_REPLY_FD: "99", TEST_PUBLIC_ENV: "keep" });
  const loaded = await loadProcessesConfig({ ...p, projectTrusted: true });
  assert.ok(loaded.ok);
  let current = loaded.config;
  const host = createProcessHost(`isolation-${crypto.randomUUID()}`, () => current, distDirectory);
  let terminal!: () => void;
  const ended = new Promise<void>(resolve => { terminal = resolve; });
  const binding = host.bind({ deliver(event) { if (event.type === "terminal") terminal(); } });
  await binding.markReady();
  try {
    const input = { action: "start" as const, name: "isolated", command: 'printf "%s|%s|%s|%s\\n" "${TEST_BROKER_ID-unset}" "${TEST_REPLY_FD-unset}" "${PI_PROCESSES_REQUIRED_ISOLATION-unset}" "$TEST_PUBLIC_ENV"', kind: "process" as const, timeoutMs: 2000, watches: [], continuation: { mode: "detached" as const } };
    const result = await host.start(input, current, p.cwd);
    await Promise.race([ended, delay(5000, undefined, { ref: false }).then(() => { throw new Error("terminal timed out"); })]);
    const page = await host.logs({ action: "logs", target: result.id, stream: "both", tailLines: 20, mode: "literal" });
    assert.deepEqual(page.lines.map(line => line.text), ["unset|unset|unset|keep"]);
    process.env[REQUIRED_EXECUTION_ISOLATION_ENV] = JSON.stringify({ ...identity, revision: 2 });
    await assert.rejects(host.start({ ...input, name: "drifted" }, current, p.cwd), /execution-isolation/);
    process.env[REQUIRED_EXECUTION_ISOLATION_ENV] = JSON.stringify(identity);
    const changed = { ...p.config, execution: { ...p.config.execution, isolation: { ...isolationFixture, removeEnv: [] } } };
    await writeFile(p.globalPath, JSON.stringify(changed));
    const replacement = await loadProcessesConfig({ ...p, projectTrusted: true });
    assert.ok(replacement.ok);
    current = replacement.config;
    assert.throws(() => createProcessHost(host.sessionScopeId, () => current, distDirectory), /cannot rebind/);
    await assert.rejects(host.start({ ...input, name: "changed" }, current, p.cwd), /Host execution authority drifted/);
  } finally { await binding.retire("scope-ended"); }
});

test("Supervisor launch rejects missing required policy and malformed or drifted bootstrap before ready", async t => {
  setEnvironment(t, { [REQUIRED_EXECUTION_ISOLATION_ENV]: JSON.stringify(identity) });
  await assert.rejects(SupervisorClient.launch({ runtimePath: process.execPath, supervisorPath: join(distDirectory, "supervisor.js"), sessionScopeId: "missing", generation: 1 }), /required policy is missing/);
  assert.throws(() => parseExecutionIsolationBootstrap(undefined), /required policy is missing/);
  const bootstrap = executionIsolationBootstrap(isolationFixture);
  assert.ok(Object.isFrozen(bootstrap.policy!.removeEnv));
  for (const raw of ["{}", JSON.stringify({ ...bootstrap, policy: null }), JSON.stringify({ ...bootstrap, required: null }), JSON.stringify({ ...bootstrap, policy: { ...isolationFixture, revision: 2 } })]) {
    const result = spawnSync(process.execPath, [join(distDirectory, "supervisor.js")], {
      env: { ...process.env, PI_PROCESSES_SUPERVISOR_NONCE: "a".repeat(64), PI_PROCESSES_SUPERVISOR_GENERATION: "1", PI_PROCESSES_SESSION_SCOPE: "scope-a", PI_PROCESSES_PI_PID: String(process.pid), PI_PROCESSES_SUPERVISOR_ROOT: tmpdir(), PI_PROCESSES_SUPERVISOR_HELPER_RUNTIME: process.execPath, [SUPERVISOR_EXECUTION_ISOLATION_ENV]: raw },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /execution-isolation/);
  }
});
