import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ProcessHost, type TransportCallbacks } from "../../src/host/process-host.ts";
import { SupervisorClient } from "../../src/host/supervisor-client.ts";
import { resolveHelperRuntime } from "../../src/supervisor/runtime-resolver.ts";

const root = new URL("../..", import.meta.url).pathname;
const supervisorPath = join(root, "dist/supervisor.js");
const shell = process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/sh";

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function resolveRuntime(): Promise<string> {
  const result = await resolveHelperRuntime({ helperRuntime: "auto", supervisorPath, processExecPath: process.execPath });
  assert.ok(result.runtime, JSON.stringify(result.attempts));
  return result.runtime.candidate.path;
}

test("reload binding replacement preserves supervisor and managed process identity", async () => {
  const runtimePath = await resolveRuntime();
  const sessionScopeId = `session-${crypto.randomUUID()}`;
  const host = new ProcessHost({
    sessionScopeId,
    launch: async (callbacks: TransportCallbacks) => await SupervisorClient.launch({
      runtimePath,
      supervisorPath,
      sessionScopeId,
      generation: 1,
      onEvent: callbacks.onEvent,
      onChannelLost: callbacks.onChannelLost,
    }),
  });
  const first = host.bind({ deliver() {} });
  await first.markReady();
  const processId = `proc_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const started = await host.request("spawn", {
    operationId: crypto.randomUUID(),
    id: processId,
    name: "reload-live",
    command: "trap '' TERM; while :; do sleep 1; done",
    cwd: root,
    shell,
    stopGraceMs: 100,
    logLimits: { perProcessBytes: 1_048_576, sessionBytes: 16_777_216, lineBytes: 65_536 },
    watches: [],
  });
  const managedPid = started.pid as number;
  const supervisorPid = host.supervisorPid;
  if (typeof supervisorPid !== "number") {
    throw new Error("supervisor pid was not available after binding became ready");
  }
  assert.ok(isAlive(managedPid));
  await first.retire("reload");
  const second = host.bind({ deliver() {} });
  await second.markReady();
  assert.equal(host.supervisorPid, supervisorPid);
  assert.ok(isAlive(managedPid));
  const health = await host.request("health", {});
  assert.equal(health.supervisorPid, supervisorPid);
  await second.retire("scope-ended");
  assert.equal(host.disposed, true);
  assert.equal(isAlive(managedPid), false);
  assert.equal(isAlive(supervisorPid), false);
});
