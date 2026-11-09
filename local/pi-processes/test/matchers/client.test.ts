import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MatcherClient } from "../../src/matchers/client.ts";
import { resolveHelperRuntime } from "../../src/supervisor/runtime-resolver.ts";

const packageRoot = new URL("../..", import.meta.url).pathname;
const workerPath = join(packageRoot, "dist/matcher-worker.js");
const supervisorPath = join(packageRoot, "dist/supervisor.js");

async function helperRuntime(): Promise<string> {
  const resolved = await resolveHelperRuntime({ helperRuntime: "auto", supervisorPath, processExecPath: process.execPath });
  assert.ok(resolved.runtime, JSON.stringify(resolved.attempts));
  return resolved.runtime.candidate.path;
}

test("matcher worker handles literal, regex, and task errors", async () => {
  const client = new MatcherClient({ runtimePath: await helperRuntime(), workerPath, deadlineMs: 500 });
  try {
    assert.deepEqual(await client.match({
      mode: "literal",
      pattern: "ready",
      records: [
        { sequence: 1, text: "booting" },
        { sequence: 2, text: "server ready" },
      ],
    }), { matches: [2], lastSequence: 2 });

    assert.deepEqual(await client.match({
      mode: "regex",
      pattern: "^err(?:or)?$",
      records: [
        { sequence: 3, text: "error" },
        { sequence: 4, text: "warning" },
      ],
    }), { matches: [3], lastSequence: 4 });

    await assert.rejects(
      client.match({ mode: "regex", pattern: "[", records: [{ sequence: 5, text: "x" }] }),
      /\[process\/matcher-error\]/,
    );
    assert.equal(client.consecutiveFaults, 0, "invalid user regex is not a worker fault");
    assert.equal(client.circuitOpen, false);
  } finally {
    client.close();
  }
});

test("matcher timeout opens a three-fault circuit and reset restores it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-processes-matcher-"));
  const hangingWorker = join(root, "hanging-worker.mjs");
  await writeFile(hangingWorker, `process.stdout.write(JSON.stringify({ type: "matcher-ready", version: 1 }) + "\\n");
process.stdin.resume();
`, { mode: 0o700 });
  await chmod(hangingWorker, 0o700);
  const client = new MatcherClient({ runtimePath: await helperRuntime(), workerPath: hangingWorker, deadlineMs: 25 });
  try {
    for (let fault = 1; fault <= 3; fault += 1) {
      await assert.rejects(
        client.match({ mode: "literal", pattern: "x", records: [{ sequence: fault, text: "x" }] }),
        /\[process\/regex-timeout\]/,
      );
      assert.equal(client.consecutiveFaults, fault);
    }
    assert.equal(client.circuitOpen, true);
    await assert.rejects(
      client.match({ mode: "literal", pattern: "x", records: [] }),
      /\[process\/matcher-disabled\]/,
    );
    client.resetCircuit();
    assert.equal(client.circuitOpen, false);
    assert.equal(client.consecutiveFaults, 0);
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful task clears prior consecutive worker faults", async () => {
  const runtimePath = await helperRuntime();
  const root = await mkdtemp(join(tmpdir(), "pi-processes-matcher-reset-"));
  const flakyWorker = join(root, "flaky-worker.mjs");
  const marker = join(root, "marker");
  await writeFile(flakyWorker, `
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(marker)};
process.stdout.write(JSON.stringify({ type: "matcher-ready", version: 1 }) + "\\n");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.once("line", (line) => {
  const task = JSON.parse(line);
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: true, result: { taskId: task.taskId, matches: [], lastSequence: 0 } }) + "\\n");
});
`, { mode: 0o700 });
  const client = new MatcherClient({ runtimePath, workerPath: flakyWorker, deadlineMs: 500 });
  try {
    await assert.rejects(
      client.match({ mode: "literal", pattern: "x", records: [] }),
      /\[process\/matcher-crashed\]/,
    );
    assert.equal(client.consecutiveFaults, 1);
    assert.deepEqual(await client.match({ mode: "literal", pattern: "x", records: [] }), {
      matches: [],
      lastSequence: 0,
    });
    assert.equal(client.consecutiveFaults, 0);
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});
