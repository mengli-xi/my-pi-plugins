import { currentBuild } from "../../../../scripts/retained-build.mjs";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SupervisorClient, type SupervisorEvent } from "../../src/host/supervisor-client.ts";
import { resolveHelperRuntime } from "../../src/supervisor/runtime-resolver.ts";

const root = new URL("../..", import.meta.url).pathname;
const supervisorPath = join(currentBuild(root), "supervisor.js");
const shell = process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/sh";

async function runtimePath(): Promise<string> {
  const result = await resolveHelperRuntime({ helperRuntime: "auto", supervisorPath, processExecPath: process.execPath });
  assert.ok(result.runtime, JSON.stringify(result.attempts));
  return result.runtime.candidate.path;
}

function waitForEvent(events: SupervisorEvent[], predicate: (event: SupervisorEvent) => boolean, timeoutMs = 20_000): Promise<SupervisorEvent> {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error("event timeout"));
      }
    }, 5);
  });
}

test("SupervisorClient drives a real generation and ACKs events", async () => {
  const events: SupervisorEvent[] = [];
  const client = await SupervisorClient.launch({
    runtimePath: await runtimePath(), supervisorPath, sessionScopeId: `session-${crypto.randomUUID()}`, generation: 1,
    onEvent: (event) => { events.push(event); },
  });
  const processId = `proc_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    const health = await client.request("health", {});
    assert.equal(health.supervisorPid, client.supervisorPid);
    const started = await client.request("spawn", {
      operationId: crypto.randomUUID(), id: processId, name: "client", command: "printf 'ok\\n'", cwd: root, shell,
      stopGraceMs: 100, logLimits: { perProcessBytes: 1_048_576, sessionBytes: 16_777_216, lineBytes: 65_536 }, watches: [],
    });
    assert.equal(typeof started.pid, "number");
    await waitForEvent(events, (event) => event.type === "terminal" && event.payload.id === processId);
    const page = await client.request("logPage", { id: processId, stream: "both", tailLines: 20 });
    assert.deepEqual((page.lines as Array<{ text: string }>).map((line) => line.text), ["ok"]);
    const cleanup = await client.cleanup("scope-ended");
    assert.equal(cleanup.unresolved, 0);
    await client.waitForExit();
  } finally {
    client.close();
  }
});

test("same-session generations use isolated roots and cleanup cannot break a peer", async () => {
  const runtime = await runtimePath();
  const sessionScopeId = `session-${crypto.randomUUID()}`;
  const first = await SupervisorClient.launch({ runtimePath: runtime, supervisorPath, sessionScopeId, generation: 1 });
  const second = await SupervisorClient.launch({ runtimePath: runtime, supervisorPath, sessionScopeId, generation: 1 });
  const processId = `proc_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    assert.notEqual(first.root, second.root);
    assert.match(first.root, new RegExp(`pi-processes-${process.pid}-[0-9a-f]{64}$`));
    assert.match(second.root, new RegExp(`pi-processes-${process.pid}-[0-9a-f]{64}$`));

    const cleanup = await first.cleanup("scope-ended");
    assert.equal(cleanup.unresolved, 0);
    await first.waitForExit();

    const started = await second.request("spawn", {
      operationId: crypto.randomUUID(), id: processId, name: "peer", command: "printf 'first\\n'\nprintf 'second\\n'", cwd: root, shell,
      stopGraceMs: 100, logLimits: { perProcessBytes: 1_048_576, sessionBytes: 16_777_216, lineBytes: 65_536 }, watches: [],
    });
    assert.equal(typeof started.pid, "number");
    // The command may already be terminal; polling the retained log is the
    // ownership assertion and does not depend on event timing. Keep polling for
    // a loaded machine's spawn latency instead of counting a fixed attempt count.
    const logDeadline = Date.now() + 30_000;
    for (;;) {
      const page = await second.request("logPage", { id: processId, stream: "both", tailLines: 20 });
      const lines = (page.lines as Array<{ text: string }>).map((line) => line.text);
      if (lines.length === 2) {
        assert.deepEqual(lines, ["first", "second"]);
        break;
      }
      if (Date.now() > logDeadline) assert.fail(`peer log did not persist: ${JSON.stringify(lines)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const secondCleanup = await second.cleanup("scope-ended");
    assert.equal(secondCleanup.unresolved, 0);
    await second.waitForExit();
  } finally {
    first.close();
    second.close();
  }
});

test("concurrent short processes persist independent indexes", async () => {
  const client = await SupervisorClient.launch({
    runtimePath: await runtimePath(), supervisorPath, sessionScopeId: `session-${crypto.randomUUID()}`, generation: 1,
  });
  const ids = Array.from({ length: 20 }, () => `proc_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`);
  try {
    await Promise.all(ids.map((id, index) => client.request("spawn", {
      operationId: crypto.randomUUID(), id, name: `p${index}`, command: `printf 'line ${index}\\n'`, cwd: root, shell,
      stopGraceMs: 100, logLimits: { perProcessBytes: 1_048_576, sessionBytes: 32_000_000, lineBytes: 65_536 }, watches: [],
    })));
    await Promise.all(ids.map(async (id, index) => {
      // Twenty short commands start behind each other; a fixed attempt count
      // measured a quiet machine, not the assertion that each log lands in its
      // own index.
      const logDeadline = Date.now() + 30_000;
      for (;;) {
        const page = await client.request("logPage", { id, stream: "both", tailLines: 10 });
        const lines = (page.lines as Array<{ text: string }>).map((line) => line.text);
        if (lines.length === 1) {
          assert.deepEqual(lines, [`line ${index}`]);
          return;
        }
        if (Date.now() > logDeadline) assert.fail(`log did not persist for ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }));
    const cleanup = await client.cleanup("scope-ended");
    assert.equal(cleanup.unresolved, 0);
    await client.waitForExit();
  } finally {
    client.close();
  }
});

test("request deadline closes an uncertain channel", async () => {
  let lost: Error | undefined;
  const client = await SupervisorClient.launch({
    runtimePath: await runtimePath(), supervisorPath, sessionScopeId: `session-${crypto.randomUUID()}`, generation: 1,
    requestTimeoutMs: () => 1,
    onChannelLost: (error) => { lost = error; },
  });
  try {
    await assert.rejects(client.request("shellProbe", { shell: "/bin/sh" }), /protocol-timeout/);
    assert.equal(client.closed, true);
    assert.match(lost?.message ?? "", /protocol-timeout/);
  } finally {
    client.terminate("SIGKILL");
    await client.waitForExit();
    client.close();
    await rm(client.root, { recursive: true, force: true });
  }
});
