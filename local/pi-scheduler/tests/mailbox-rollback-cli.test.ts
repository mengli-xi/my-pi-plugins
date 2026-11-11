import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { request } from "../src/client.ts";
import { SchedulerRuntime } from "../src/runtime.ts";
import { SchedulerStore } from "../src/store.ts";

const cli = fileURLToPath(new URL("../scripts/mailbox-rollback.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../../ts-resolve.mjs", import.meta.url));

test("rollback CLI inventories, refuses active ownership and inexact approval, then archives exact abandonment", async t => {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-rollback-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent"), root = join(agentDir, "scheduler");
  const archive = join(directory, "archive");
  const store = new SchedulerStore(root);
  const marker = { injectionId: "cli-task:1800000000000", taskId: "cli-task", title: "CLI rollback", prompt: "offline only",
    scheduledTime: 1800000000000, staleAt: 1800000060000, createdAt: 1800000000000,
    sessionId: "cli-session", phase: "pending" as const, mailbox: { anchorEntryId: null } };
  store.putInjection(marker);
  const original = readFileSync(join(root, "injection", `${marker.injectionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), "utf8");
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", loader, cli, "--store", root, ...args], {
    encoding: "utf8", timeout: 15000,
  });
  const inventory = run("--check");
  assert.equal(inventory.status, 1, inventory.stderr);
  assert.equal(JSON.parse(inventory.stdout).blockers[0].injectionId, marker.injectionId);
  for (const ids of [[], ["unknown:1"], [marker.injectionId, marker.injectionId]]) {
    const refused = run("--archive", archive, ...ids.flatMap(id => ["--abandon", id]));
    assert.notEqual(refused.status, 0);
    assert.equal(existsSync(archive), false, "refusal precedes any archive/mutation");
    assert.equal(store.getInjection(marker.injectionId)?.phase, "pending");
  }
  let onDrained!: () => void;
  const drained = new Promise<void>(resolve => { onDrained = resolve; });
  const runtime = new SchedulerRuntime({ agentDir, piBinary: "/bin/false", onDrained, runner: async () => assert.fail("must not execute") });
  await runtime.start();
  try {
    const locked = run("--archive", archive, "--abandon", marker.injectionId);
    assert.notEqual(locked.status, 0, "CLI must acquire the same kernel lock as daemon");
    assert.equal(existsSync(archive), false);
  } finally {
    await request({ type: "daemon.update" }, { socketPath: runtime.paths.socket });
    await drained;
    runtime.stop();
  }
  const result = run("--archive", archive, "--abandon", marker.injectionId);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(archive, "injection", `${marker.injectionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), "utf8"), original);
  assert.equal(store.getInjection(marker.injectionId), undefined);
  assert.equal(store.listRuns(marker.taskId)[0]?.detail, "user-abandoned delivery");
  assert.equal(store.listRuns(marker.taskId)[0]?.outcome, "failure");
  assert.equal(JSON.parse(readFileSync(join(archive, "mailbox-rollback-audit.json"), "utf8")).audit[0].injectionId, marker.injectionId);
  assert.equal(run("--check").status, 0);
});
