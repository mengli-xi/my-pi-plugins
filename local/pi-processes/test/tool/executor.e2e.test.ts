import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { defaultProcessesConfig } from "../../src/config.ts";
import { ProcessHost, type TransportCallbacks } from "../../src/host/process-host.ts";
import { SupervisorClient, type SupervisorEvent } from "../../src/host/supervisor-client.ts";
import { resolveHelperRuntime } from "../../src/supervisor/runtime-resolver.ts";
import { ProcessToolExecutor } from "../../src/tool/executor.ts";

const root = new URL("../..", import.meta.url).pathname;
const supervisorPath = join(root, "dist/supervisor.js");

function deferredEvent(predicate: (event: SupervisorEvent) => boolean): {
  readonly promise: Promise<SupervisorEvent>;
  readonly deliver: (event: SupervisorEvent) => void;
} {
  let resolve!: (event: SupervisorEvent) => void;
  const promise = new Promise<SupervisorEvent>((next) => { resolve = next; });
  let settled = false;
  return {
    promise,
    deliver(event) {
      if (!settled && predicate(event)) {
        settled = true;
        resolve(event);
      }
    },
  };
}

async function runtimePath(): Promise<string> {
  const result = await resolveHelperRuntime({ helperRuntime: "auto", supervisorPath, processExecPath: process.execPath });
  assert.ok(result.runtime, JSON.stringify(result.attempts));
  return result.runtime.candidate.path;
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("two first-use starts share one cold supervisor launch", async () => {
  const sessionScopeId = `session-${crypto.randomUUID()}`;
  const host = new ProcessHost({
    sessionScopeId,
    launch: async (callbacks: TransportCallbacks) => await SupervisorClient.launch({
      runtimePath: await runtimePath(),
      supervisorPath,
      sessionScopeId,
      generation: 1,
      onEvent: callbacks.onEvent,
      onChannelLost: callbacks.onChannelLost,
    }),
  });
  const config = defaultProcessesConfig();
  const executor = new ProcessToolExecutor({ host, config: () => config, defaultCwd: () => root });

  try {
    const [first, second] = await within(Promise.all([
      executor.execute({ action: "start", name: "cold-a", command: "sleep 30" }),
      executor.execute({ action: "start", name: "cold-b", command: "sleep 30" }),
    ]), "parallel cold starts", 5_000);
    assert.equal(first.action, "start");
    assert.equal(second.action, "start");
    assert.equal(host.records().filter((record) => record.state === "running").length, 2);
    assert.ok(host.supervisorPid);
  } finally {
    if (!host.disposed) await within(host.endScope("scope-ended"), "host cleanup");
  }
});

test("seven-action executor drives the real supervisor and canonical host records", async () => {
  const watch = deferredEvent((event) => event.type === "watchMatch" && event.payload.key === "ready");
  const echoed = deferredEvent((event) => event.type === "logCursorAdvanced" && Number(event.payload.nextSequence) >= 2);
  const terminal = deferredEvent((event) => event.type === "terminal");
  const sessionScopeId = `session-${crypto.randomUUID()}`;
  const host = new ProcessHost({
    sessionScopeId,
    launch: async (callbacks: TransportCallbacks) => await SupervisorClient.launch({
      runtimePath: await runtimePath(),
      supervisorPath,
      sessionScopeId,
      generation: 1,
      onEvent: callbacks.onEvent,
      onChannelLost: callbacks.onChannelLost,
    }),
  });
  const binding = host.bind({
    deliver(event) {
      watch.deliver(event);
      echoed.deliver(event);
      terminal.deliver(event);
    },
    appendNotificationEntry() {},
  });
  await binding.markReady();
  const config = defaultProcessesConfig();
  const executor = new ProcessToolExecutor({ host, config: () => config, defaultCwd: () => root });

  try {
    const started = await executor.execute({
      action: "start",
      name: "journey",
      command: "printf 'ready\\n'; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done",
      watches: [{ key: "ready", pattern: "ready", stream: "stdout", repeat: false, attention: "ignore" }],
      continuation: { mode: "wait", until: { kind: "watch", key: "ready" } },
    });
    assert.equal(started.action, "start");
    const process = (started.data as { process: { id: string; name: string } }).process;
    assert.equal(process.name, "journey");
    await within(watch.promise, "watch match");

    const listed = await executor.execute({ action: "list", states: ["running"], sort: "started-desc", limit: 50 });
    assert.equal((listed.data as { returned: number }).returned, 1);

    const input = await executor.execute({ action: "input", target: process.id, data: "hello\n", eof: false });
    assert.equal((input.data as { bytesAccepted: number }).bytesAccepted, 6);
    await within(echoed.promise, "stdin echo log");

    const logs = await executor.execute({ action: "logs", target: "journey", stream: "both", tailLines: 100 });
    const texts = (logs.data as unknown as { lines: Array<{ text: string }> }).lines.map((line) => line.text);
    assert.ok(texts.includes("ready"));
    assert.ok(texts.includes("echo:hello"));

    const configured = await executor.execute({
      action: "configure",
      target: process.id,
      name: "renamed",
      watchUpdate: { operation: "clear" },
      continuation: { mode: "detached" },
      notify: { onSuccess: "ignore" },
    });
    assert.deepEqual((configured.data as unknown as { changed: string[] }).changed, ["name", "watches", "continuation", "notify"]);

    const stopped = await executor.execute({ action: "stop", target: "renamed" });
    assert.equal((stopped.data as { delivered: boolean }).delivered, true);
    await within(terminal.promise, "terminal event");

    const terminalList = await executor.execute({ action: "list", states: ["stopped", "killed"], sort: "started-desc", limit: 50 });
    assert.equal((terminalList.data as { returned: number }).returned, 1);

    const cleared = await executor.execute({ action: "clear" });
    assert.equal((cleared.data as { clearedCount: number }).clearedCount, 1);
    assert.equal(host.records().length, 0);
  } finally {
    if (!host.disposed) await within(host.endScope("scope-ended"), "host cleanup");
  }
});
