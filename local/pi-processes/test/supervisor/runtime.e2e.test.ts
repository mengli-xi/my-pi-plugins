import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { SupervisorClient } from "../../src/host/supervisor-client.ts";
import { resolveHelperRuntime } from "../../src/supervisor/runtime-resolver.ts";
import { startSupervisor } from "./harness.ts";
import { SUPERVISOR_EXECUTION_ISOLATION_ENV } from "../../src/execution-isolation.ts";

const root = new URL("../..", import.meta.url).pathname;
const supervisorPath = join(root, "dist/supervisor.js");
const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/sh";
const op = (): string => crypto.randomUUID();
const id = (suffix: string): string => `proc_${suffix.padStart(12, "0").slice(-12)}`;
const logLimits = { perProcessBytes: 1_048_576, sessionBytes: 16_777_216, lineBytes: 65_536 };

async function runtimePath(): Promise<string> {
  const resolved = await resolveHelperRuntime({ helperRuntime: "auto", supervisorPath, processExecPath: process.execPath });
  assert.ok(resolved.runtime, JSON.stringify(resolved.attempts));
  return resolved.runtime.candidate.path;
}

function ok(frame: { payload: Record<string, unknown> }): Record<string, unknown> {
  assert.equal(frame.payload.ok, true, JSON.stringify(frame.payload));
  return frame.payload.result as Record<string, unknown>;
}

function nodeCommand(source: string): string {
  return `exec ${JSON.stringify(process.execPath)} -e '${source.replaceAll("'", "'\\''")}'`;
}

test("external runtime probe and immediate terminal ordering", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  try {
    const processId = id("1");
    const response = await harness.send("spawn", {
      operationId: op(), id: processId, name: "quick", command: "printf 'done\\n'", cwd: root, shell,
      stopGraceMs: 200, logLimits, watches: [],
    });
    const started = ok(response);
    assert.equal(new Date(started.startedAt as string).toISOString(), started.startedAt);
    assert.equal("deadlineAt" in started, false);
    assert.equal("timeoutMs" in started, false);
    const terminal = await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId);
    assert.ok(harness.frames.indexOf(response) < harness.frames.indexOf(terminal));
    const page = ok(await harness.send("logPage", { id: processId, stream: "both", tailLines: 20 }));
    assert.deepEqual((page.lines as Array<{ text: string }>).map((line) => line.text), ["done"]);
  } finally { await harness.dispose(); }
});

test("Host launches both Supervisor and regex matcher through the configured wrapper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-processes-helper-wrapper-"));
  const callsPath = join(directory, "calls");
  const wrapperPath = join(directory, "bun");
  const runtime = await runtimePath();
  await writeFile(wrapperPath, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(callsPath)}\nexec ${JSON.stringify(runtime)} "$@"\n`, { mode: 0o700 });
  let client: SupervisorClient | undefined;
  try {
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    const processId = id("wrapper");
    client = await SupervisorClient.launch({
      // A fresh executable script can start slowly in the parallel macOS suite.
      runtimePath: wrapperPath, supervisorPath, sessionScopeId: "wrapper-e2e", generation: 1, launchTimeoutMs: 15_000,
      onEvent: (event) => { if (event.type === "terminal" && event.payload.id === processId) resolveTerminal(); },
    });
    await client.request("spawn", {
      operationId: op(), id: processId, name: "wrapper", command: "printf 'ready-123\\n'", cwd: root, shell,
      stopGraceMs: 100, logLimits,
      watches: [{ key: "ready", pattern: "^ready-[0-9]+$", mode: "regex", stream: "stdout", repeat: false }],
    });
    await Promise.race([terminalPromise, delay(5_000, undefined, { ref: false }).then(() => { throw new Error("wrapper terminal timed out"); })]);
    const page = await client.request("logPage", { id: processId, stream: "both", tailLines: 20, pattern: "^ready-[0-9]+$", mode: "regex" });
    assert.deepEqual((page.lines as Array<{ text: string }>).map((line) => line.text), ["ready-123"]);
    assert.deepEqual((await readFile(callsPath, "utf8")).trim().split("\n"), [supervisorPath, join(root, "dist/matcher-worker.js")]);
    await client.cleanup("scope-ended");
    await client.waitForExit();
  } finally {
    if (client) {
      client.terminate("SIGKILL");
      await client.waitForExit();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Supervisor rejects an explicit invalid helper before its ready handshake", async () => {
  const runtime = await runtimePath();
  for (const helperRuntime of ["", "relative/bun", join(tmpdir(), `missing-helper-${op()}`)]) {
    const result = spawnSync(runtime, [supervisorPath], {
      env: { ...process.env, PI_PROCESSES_SUPERVISOR_HELPER_RUNTIME: helperRuntime },
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /\[process\/protocol-handshake\] invalid supervisor helper runtime/u);
  }
});

test("spawn rejects invalid timeoutMs across the supervisor protocol", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  try {
    for (const timeoutMs of [0, -1, 1.5, "100", null, true, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await harness.send("spawn", {
        operationId: op(), id: id("8"), name: "invalid-timeout", command: "exit 0", cwd: root, shell,
        stopGraceMs: 100, timeoutMs, logLimits, watches: [],
      });
      assert.equal(response.payload.ok, false, JSON.stringify({ timeoutMs, response: response.payload }));
      assert.equal(response.payload.code, "protocol-invalid");
    }
    assert.equal(ok(await harness.send("health", {})).live, 0);
  } finally { await harness.dispose(); }
});

test("timeout gives the entire group five seconds even when its leader exits after TERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-processes-term-dispatch-"));
  const termPath = join(directory, "term-at.json");
  const wrapperPath = join(directory, "supervisor.mjs");
  // Observe successful TERM dispatch, not a descendant's scheduling/file-write
  // latency. Keep the real signals, monotonic deadline and five-second grace.
  await writeFile(wrapperPath, `
import { writeFileSync } from "node:fs";
const kill = process.kill.bind(process);
let recorded = false;
process.kill = (pid, signal) => {
  const result = kill(pid, signal);
  if (pid < 0 && signal === "SIGTERM" && !recorded) {
    const at = Date.now();
    recorded = true;
    writeFileSync(${JSON.stringify(termPath)}, JSON.stringify({ at, pgid: -pid }));
  }
  return result;
};
await import(${JSON.stringify(pathToFileURL(supervisorPath).href)});
`);
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath: wrapperPath });
  let pgid: number | undefined;
  try {
    const processId = id("9");
    const command = "trap 'exit 0' TERM; (trap '' TERM; printf 'ready\\n'; while :; do :; done) & wait";
    // The deadline only has to outlive the shell installing both traps; the
    // five-second grace it measures starts at the deadline either way.
    const started = ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "timeout-group", command, cwd: root, shell,
      stopGraceMs: 30_000, timeoutMs: 6_000, logLimits, watches: [],
    }));
    pgid = started.pgid as number;
    assert.equal(Date.parse(started.deadlineAt as string) - Date.parse(started.startedAt as string), 6_000);
    assert.equal(started.timeoutMs, 6_000);
    await harness.waitFor((frame) => frame.type === "logCursorAdvanced" && frame.payload.id === processId, 30_000);
    // Wait for the dispatch marker itself: a fixed sleep measured the scheduler,
    // and the grace below is measured from the marker's timestamp.
    const markerDeadline = Date.now() + 30_000;
    let markerText = "";
    for (;;) {
      try { markerText = await readFile(termPath, "utf8"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        assert.ok(Date.now() < markerDeadline, "the timeout never dispatched SIGTERM");
        await delay(10);
      }
    }
    const marker = JSON.parse(markerText);
    assert.equal(marker.pgid, pgid);
    const termAt = marker.at as number;
    assert.ok(termAt >= Date.parse(started.deadlineAt as string) - 20);
    assert.doesNotThrow(() => process.kill(-pgid!, 0));
    assert.throws(() => process.kill(pgid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    ok(await harness.send("stop", { operationId: op(), id: processId }));
    const terminal = await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId, 30_000);
    assert.equal(terminal.payload.classification, "timeout");
    assert.equal(terminal.payload.cause, "timeout");
    assert.equal(terminal.payload.timeoutMs, 6_000);
    const graceMs = Date.parse(terminal.payload.endedAt as string) - termAt;
    // Still the five-second grace: the lower bound is the contract, the upper
    // bound only absorbs a loaded machine's timer and reap latency.
    assert.ok(graceMs >= 4_800 && graceMs < 9_000, `graceMs=${graceMs}`);
    assert.throws(() => process.kill(-pgid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    await delay(100);
    assert.equal(harness.frames.filter((frame) => frame.type === "terminal" && frame.payload.id === processId).length, 1);
    assert.equal(ok(await harness.send("health", {})).terminal, 1);
  } finally {
    await harness.dispose();
    if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exit inside timeout grace still terminalizes as timeout only once", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  try {
    const processId = id("a");
    const started = ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "grace-exit", cwd: root, shell,
      // Install the signal handler without racing the shell's own startup: the
      // deadline stays far behind it, the exit stays inside the grace.
      command: "trap 'sleep 0.2; exit 0' TERM; while :; do :; done",
      stopGraceMs: 100, timeoutMs: 6_000, logLimits, watches: [],
    }));
    const terminal = await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId, 25_000);
    assert.equal(terminal.payload.exitCode, 0);
    assert.equal(terminal.payload.classification, "timeout");
    assert.equal(terminal.payload.cause, "timeout");
    assert.equal(terminal.payload.timeoutMs, 6_000);
    assert.ok(Date.parse(terminal.payload.endedAt as string) - Date.parse(started.deadlineAt as string) >= 150);
    await delay(500);
    assert.equal(harness.frames.filter((frame) => frame.type === "terminal" && frame.payload.id === processId).length, 1);
  } finally { await harness.dispose(); }
});

test("natural exit wins before deadline and long safe timeouts never overflow a timer", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  try {
    // The short deadline only has to outlive a cold `exit 0`; the long one must
    // not overflow a timer.
    for (const [index, timeoutMs] of [6_000, 2_147_484_000].entries()) {
      const processId = id(`b${index}`);
      const started = ok(await harness.send("spawn", {
        operationId: op(), id: processId, name: "natural", cwd: root, shell,
        command: "exit 0",
        stopGraceMs: 100, timeoutMs, logLimits, watches: [],
      }));
      assert.equal(typeof started.deadlineAt, "string");
      assert.equal(Date.parse(started.deadlineAt as string) - Date.parse(started.startedAt as string), timeoutMs);
      const terminal = await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId);
      assert.equal(terminal.payload.classification, "natural");
      assert.equal("cause" in terminal.payload, false);
      assert.equal("timeoutMs" in terminal.payload, false);
    }
    // Outlive the short deadline so a late timeout would still show up.
    await delay(6_400);
    assert.equal(harness.frames.filter((frame) => frame.type === "terminal").length, 2);
  } finally { await harness.dispose(); }
});

test("natural terminalization crossing its deadline is not reclassified as timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-processes-terminalizing-"));
  const markerPath = join(directory, "terminalizing.json");
  const wrapperPath = join(directory, "supervisor.mjs");
  // Keep the real spawn/exit and SIGKILL, but model slow kernel group convergence.
  // The first group KILL proves natural terminalization has started before deadline.
  await writeFile(wrapperPath, `
import { renameSync, writeFileSync } from "node:fs";
const kill = process.kill.bind(process);
let heldGroup, releaseAt = 0;
process.kill = (pid, signal) => {
  if (pid === heldGroup && signal === 0 && performance.now() < releaseAt) return true;
  const result = kill(pid, signal);
  if (pid < 0 && signal === "SIGKILL" && heldGroup === undefined) {
    heldGroup = pid;
    releaseAt = performance.now() + 10000;
    writeFileSync(${JSON.stringify(`${markerPath}.tmp`)}, JSON.stringify({ at: Date.now(), pgid: -pid }));
    renameSync(${JSON.stringify(`${markerPath}.tmp`)}, ${JSON.stringify(markerPath)});
  }
  return result;
};
await import(${JSON.stringify(pathToFileURL(supervisorPath).href)});
`);
  let harness: Awaited<ReturnType<typeof startSupervisor>> | undefined;
  let pgid: number | undefined;
  try {
    harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath: wrapperPath });
    const processId = id("cross");
    const started = ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "natural-crossing", cwd: root, shell,
      command: nodeCommand('const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref();'),
      // The natural exit only has to land before the deadline, and the modelled
      // group convergence has to outlast it; both spans keep cold-start slack.
      stopGraceMs: 100, timeoutMs: 6_000, logLimits, watches: [],
    }));
    pgid = started.pgid as number;
    let marker: { at: number; pgid: number } | undefined;
    const markerDeadline = Date.now() + 15_000;
    while (!marker) {
      try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      assert.ok(Date.now() < markerDeadline, "natural terminalization did not start");
      if (!marker) await delay(10);
    }
    assert.equal(marker.pgid, pgid);
    const deadlineAt = Date.parse(started.deadlineAt as string);
    assert.ok(marker.at < deadlineAt, "natural terminalization must start before deadline");
    await delay(Math.max(0, deadlineAt - Date.now()) + 100);
    assert.equal(harness.frames.some((frame) => frame.type === "terminal" && frame.payload.id === processId), false);
    const terminal = await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId);
    assert.ok(Date.parse(terminal.payload.endedAt as string) > deadlineAt);
    assert.equal(terminal.payload.exitCode, 0);
    assert.equal(terminal.payload.classification, "natural");
    assert.equal("cause" in terminal.payload, false);
    assert.equal("timeoutMs" in terminal.payload, false);
    await delay(100);
    assert.equal(harness.frames.filter((frame) => frame.type === "terminal" && frame.payload.id === processId).length, 1);
    assert.equal(ok(await harness.send("health", {})).terminal, 1);
    assert.throws(() => process.kill(-pgid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  } finally {
    if (harness) await harness.dispose();
    if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

test("scope cleanup cannot postpone the command deadline with a longer stop grace", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  let pgid: number | undefined;
  try {
    const processId = id("c");
    const started = ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "cleanup-deadline", cwd: root, shell,
      command: "trap '' TERM; printf 'ready\\n'; while :; do :; done",
      // The deadline only has to outlive the shell installing the trap; the
      // cleanup must still end it with the five-second timeout grace, not with
      // the much longer stop grace requested here.
      stopGraceMs: 30_000, timeoutMs: 8_000, logLimits, watches: [],
    }));
    pgid = started.pgid as number;
    await harness.waitFor((frame) => frame.type === "logCursorAdvanced" && frame.payload.id === processId, 30_000);
    const { requestId } = harness.write("cleanup", { operationId: op(), reason: "scope-ended" });
    const cleaned = ok(await harness.waitFor((frame) => frame.type === "response" && frame.requestId === requestId, 35_000));
    assert.equal(cleaned.unresolved, 0);
    // Deadline plus five-second grace plus load slack, still far below the 30s
    // stop grace the request asks for.
    assert.ok(Date.now() - Date.parse(started.startedAt as string) < 20_000);
    await harness.waitForExit(30_000);
    assert.throws(() => process.kill(-pgid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  } finally {
    await harness.dispose();
    if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  }
});

test("commands do not inherit Bun mode, bootstrap or declared owner and collaboration markers", async () => {
  const runtime = await runtimePath();
  const keys = ["BUN_BE_BUN", "EXAMPLE_OWNER_ACTIVE", "EXAMPLE_PROVIDER", "EXAMPLE_REQUEST_FD", "EXAMPLE_REPLY_FD", "EXAMPLE_PARENT_PID", "EXAMPLE_PAUSE", "EXAMPLE_SCHEMA", "EXAMPLE_MODE", SUPERVISOR_EXECUTION_ISOLATION_ENV];
  const previous = keys.map((key) => process.env[key]);
  let harness: Awaited<ReturnType<typeof startSupervisor>>;
  try {
    for (const key of keys) process.env[key] = "1";
    process.env[SUPERVISOR_EXECUTION_ISOLATION_ENV] = JSON.stringify({ version: 1,
      policy: { version: 1, owner: "example-owner", revision: 1, removeEnv: keys.slice(1, -1) }, required: null });
    harness = await startSupervisor({ runtime, supervisorPath });
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
  try {
    const processId = id("d");
    ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "safe-environment", cwd: root, shell,
      command: nodeCommand(`console.log(JSON.stringify(${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined)));`),
      stopGraceMs: 100, logLimits, watches: [],
    }));
    await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId);
    const page = ok(await harness.send("logPage", { id: processId, stream: "both", tailLines: 20 }));
    assert.deepEqual((page.lines as Array<{ text: string }>).map((line) => line.text), ["[]"]);
  } finally { await harness.dispose(); }
});

test("invalid cleanup request returns an error without abandoning a live group", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  let pgid: number | undefined;
  try {
    const started = ok(await harness.send("spawn", {
      operationId: op(), id: id("6"), name: "invalid-cleanup", command: "trap '' TERM; while :; do sleep 1; done", cwd: root, shell,
      stopGraceMs: 100, logLimits, watches: [],
    }));
    pgid = started.pgid as number;
    const response = await harness.send("cleanup", { operationId: op(), reason: "invalid" });
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.code, "protocol-invalid");
    assert.equal(harness.child.exitCode, null);
    assert.equal(ok(await harness.send("health", {})).live, 1);
    ok(await harness.send("cleanup", { operationId: op(), reason: "scope-ended" }));
    await harness.waitForExit();
    assert.throws(
      () => process.kill(-pgid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    await harness.dispose();
    if (pgid) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
  }
});

test("parent EOF after an unobserved spawn request still cleans the spawned group", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  let pgid: number | undefined;
  try {
    const { requestId } = harness.write("spawn", {
      operationId: op(), id: id("5"), name: "unobserved", command: "trap '' TERM; while :; do sleep 1; done", cwd: root, shell,
      stopGraceMs: 100, logLimits, watches: [],
    });
    harness.closeInput();
    const response = ok(await harness.waitFor((frame) => frame.type === "response" && frame.requestId === requestId));
    pgid = response.pgid as number;
    await harness.waitForExit(5_000);
    assert.throws(
      () => process.kill(-pgid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    await harness.dispose();
    if (pgid) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
  }
});

test("terminalization kills descendants left in the command process group", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  let pgid: number | undefined;
  try {
    const processId = id("7");
    const started = ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "descendant", command: `${JSON.stringify(process.execPath)} -e 'const { spawn } = require("node:child_process"); const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" }); child.unref()'`, cwd: root, shell,
      stopGraceMs: 100, logLimits, watches: [],
    }));
    pgid = started.pgid as number;
    await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId, 5_000);
    assert.throws(
      () => process.kill(-pgid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    ok(await harness.send("cleanup", { operationId: op(), reason: "scope-ended" }));
    await harness.waitForExit();
  } finally {
    await harness.dispose();
    if (pgid) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
  }
});

test("parent pipe EOF kills owned groups, removes its root, and exits", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  let pgid: number | undefined;
  try {
    const started = ok(await harness.send("spawn", {
      operationId: op(), id: id("4"), name: "parent-eof", command: "trap '' TERM; while :; do sleep 1; done", cwd: root, shell,
      stopGraceMs: 100, logLimits, watches: [],
    }));
    pgid = started.pgid as number;
    harness.closeInput();
    await harness.waitForExit(5_000);
    assert.throws(
      () => process.kill(-pgid!, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    await assert.rejects(access(harness.root));
  } finally {
    await harness.dispose();
    if (pgid) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
  }
});

test("stdin EOF, stdout/stderr storage, stop, health and cleanup", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  try {
    const catId = id("2");
    ok(await harness.send("spawn", {
      operationId: op(), id: catId, name: "pipe", command: "cat; printf 'warn\\n' >&2", cwd: root, shell,
      stopGraceMs: 200, logLimits, watches: [],
    }));
    ok(await harness.send("input", { operationId: op(), id: catId, dataBase64: Buffer.from("hello\\n").toString("base64"), eof: true }));
    await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === catId);
    const page = ok(await harness.send("logPage", { id: catId, stream: "both", tailLines: 20 }));
    const lines = page.lines as Array<{ sequence: number; stream: string; text: string }>;
    assert.deepEqual(lines.map((line) => line.sequence), [...lines.map((line) => line.sequence)].sort((a, b) => a - b));
    assert.deepEqual(new Set(lines.map((line) => `${line.stream}:${line.text}`)), new Set(["stdout:hello\\n", "stderr:warn"]));

    const sleepId = id("3");
    ok(await harness.send("spawn", {
      operationId: op(), id: sleepId, name: "sleep", command: "trap '' TERM; sleep 30", cwd: root, shell,
      stopGraceMs: 100, logLimits, watches: [],
    }));
    ok(await harness.send("stop", { operationId: op(), id: sleepId }));
    const stopped = await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === sleepId, 5_000);
    assert.equal(stopped.payload.classification, "stopped");

    const health = ok(await harness.send("health", {}));
    assert.equal(health.live, 0);
    assert.equal(health.terminal, 2);
    const cleanup = ok(await harness.send("cleanup", { operationId: op(), reason: "scope-ended" }));
    assert.equal(cleanup.unresolved, 0);
    await harness.waitForExit();
    await assert.rejects(access(harness.root));
  } finally {
    await harness.dispose();
  }
});
