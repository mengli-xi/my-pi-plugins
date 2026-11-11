/**
 * Real host smoke: run the BUNDLED daemon (dist/daemon.js) under a real node
 * runtime, drive it over the actual Unix socket with a stub "pi" binary, and
 * prove the persistent-execution promise:
 *   1. daemon answers ping,
 *   2. a due agent task actually spawns the pi binary with frozen argv,
 *   3. the run is recorded to disk,
 *   4. the daemon keeps running with no Pi process attached (decision #2/#12).
 *
 * No mocks: a genuine child process, socket, and filesystem store.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ping, request } from "../src/client.ts";
import { schedulerPaths } from "../src/paths.ts";
import { waitForDaemonLockRelease } from "./fixtures/daemon-lock.ts";
import type { Task } from "../src/task.ts";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const daemonJs = join(pkgRoot, "dist", "daemon.js");

function agentTask(id: string, at: number, markerPath: string): Task {
  return {
    id,
    title: id,
    prompt: `write ${markerPath}`,
    schedule: { kind: "once", at },
    timeZone: "UTC",
    toleranceMs: 10 * 60 * 1000,
    // The stub pi ignores provider/model; it just records that it ran.
    target: { kind: "agent", cwd: pkgRoot, provider: "scheduler-faux", model: "stub" },
    status: "active",
    createdAt: at - 1000,
    origin: "agent",
  };
}

test("bundled daemon runs a task via a real pi spawn and survives with no Pi attached", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-scheduler-host-"));
  const agentDir = join(home, "agent");
  const paths = schedulerPaths(agentDir);
  const marker = join(home, "ran.txt");

  // Stub pi: writes a marker with its argv so we can prove the frozen prompt
  // and flags reached a real spawned process, then exits 0.
  const stubPi = join(home, "pi-stub.mjs");
  writeFileSync(
    stubPi,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR }));
process.exit(0);
`,
  );
  const stubBin = join(home, "pi");
  // A tiny shell shim so PI_SCHEDULER_BINARY is a normal executable.
  writeFileSync(stubBin, `#!/bin/sh\nexec "${process.execPath}" "${stubPi}" "$@"\n`);
  chmodSync(stubBin, 0o755);

  const daemon = spawn(process.execPath, [daemonJs], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SCHEDULER_BINARY: stubBin,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    const exited = new Promise(resolve => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await exited;
    await waitForDaemonLockRelease(paths.lock);
    rmSync(home, { recursive: true, force: true });
  });

  // 1. Wait for the daemon to answer on the socket.
  const up = await (async () => {
    for (let i = 0; i < 150; i++) {
      if (await ping(paths.socket)) return true;
      await delay(100);
    }
    return false;
  })();
  assert.equal(up, true, "daemon came up and answered ping");

  // 2. Create a due task; the create triggers an immediate plan+dispatch.
  const created = await request(
    { type: "task.create", task: agentTask("a", Date.now(), marker) },
    { socketPath: paths.socket },
  );
  assert.equal(created.ok, true);

  // 3. The stub pi should run and drop its marker with our frozen prompt.
  const ran = await (async () => {
    for (let i = 0; i < 150; i++) {
      try {
        const argv = JSON.parse(readFileSync(marker, "utf8")) as { argv: string[]; agentDir: string };
        return argv;
      } catch { await delay(100); }
    }
    return undefined;
  })();
  const diagnostics = await request({ type: "task.runs", id: "a" }, { socketPath: paths.socket });
  assert.ok(ran, `stub pi was spawned: ${JSON.stringify(diagnostics)}`);
  assert.equal(ran.agentDir, agentDir, "the task uses the daemon profile rather than the daily agent dir");
  assert.ok(ran!.argv.includes("--print"), "ran with --print");
  assert.ok(ran!.argv.includes("--session-id"), "agent target used a fresh session");
  assert.equal(ran!.argv.at(-1), `write ${marker}`, "frozen prompt was passed");

  // 4. The run is recorded, and the daemon is still alive with no Pi attached.
  const runs = await request({ type: "task.runs", id: "a" }, { socketPath: paths.socket });
  assert.ok(runs.ok && runs.type === "runs" && runs.runs.at(-1)?.outcome === "success");
  assert.equal(daemon.exitCode, null, "daemon keeps running independent of any Pi process");
});

test("bundled daemon recovers the shared A/E final-ACK fixture over real IPC after SIGKILL", async (t) => {
  const { fulfilledFinalAckLostFixture } = await import("./fixtures/fulfilled-final-ack-lost.ts");
  const { SchedulerStore } = await import("../src/store.ts");
  const { schedulerProducer } = await import("../src/mailbox-adapter.ts");
  const home = mkdtempSync(join(tmpdir(), "pi-scheduler-mailbox-host-"));
  const agentDir = join(home, "agent");
  const paths = schedulerPaths(agentDir);
  const f = fulfilledFinalAckLostFixture(join(home, "session.jsonl"), home);
  const store = new SchedulerStore(paths.root);
  store.putInjection({ injectionId: f.injectionId, taskId: f.taskId, prompt: f.prompt,
    title: "Shared ACK recovery fixture", scheduledTime: f.scheduledTime, createdAt: f.scheduledTime,
    staleAt: f.scheduledTime + 1, sessionId: f.snapshot.session.id, phase: f.sourceMarkerPhase,
    mailbox: { anchorEntryId: f.mail.anchorEntryId, recordedToken: "recorded-injection-fixture", entryId: "native-injection-fixture" } });
  const spawnEvidence = join(home, "unexpected-pi-spawn");
  const forbiddenPi = join(home, "pi-forbidden");
  writeFileSync(forbiddenPi, `#!/bin/sh\nprintf unexpected > '${spawnEvidence}'\nexit 99\n`);
  chmodSync(forbiddenPi, 0o755);
  const startDaemon = () => {
    const child = spawn(process.execPath, [daemonJs], { env: { ...process.env, HOME: home,
      PI_CODING_AGENT_DIR: agentDir, PI_SCHEDULER_BINARY: forbiddenPi }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    return { child, stderr: () => stderr };
  };
  let daemon = startDaemon();
  t.after(async () => {
    const exited = new Promise(resolve => daemon.child.once("exit", resolve));
    daemon.child.kill("SIGTERM"); await exited;
    await waitForDaemonLockRelease(paths.lock);
    rmSync(home, { recursive: true, force: true });
  });
  const waitUp = async () => {
    for (let i = 0; i < 200; i++) {
      if (await ping(paths.socket)) return;
      if (daemon.child.exitCode !== null) break;
      await delay(50);
    }
    assert.fail(`mailbox daemon did not become ready: ${daemon.stderr()}`);
  };
  await waitUp();
  let loseReply = true;
  const source = schedulerProducer(async (body) => {
    const response = await request(body, { socketPath: paths.socket });
    if (loseReply) { loseReply = false; throw new Error("lost callback reply after source commit"); }
    return response;
  });
  const fence = { slotKey: JSON.stringify([agentDir, f.snapshot.session.id]), session: f.snapshot.session,
    bindingGeneration: 1, ownerEpoch: 1, producerToken: Symbol("scheduler-test"), attemptId: null };
  await assert.rejects(async () => source.onTerminal!(f.evidence, fence), /lost callback reply/);
  assert.equal(store.getInjectionReceipt(f.injectionId)?.evidence.terminalId, f.evidence.terminalId);
  const exited = new Promise<void>((resolve) => daemon.child.once("exit", () => resolve()));
  daemon.child.kill("SIGKILL");
  await exited;
  await waitForDaemonLockRelease(paths.lock);
  daemon = startDaemon();
  await waitUp();
  await source.onTerminal!(f.evidence, { ...fence, ownerEpoch: 2 });
  assert.equal(store.listRuns(f.taskId).length, f.expected.terminalTransitions);
  assert.equal(store.getInjection(f.injectionId), undefined);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(spawnEvidence), false, "ACK recovery never re-executes pi --print");
});
