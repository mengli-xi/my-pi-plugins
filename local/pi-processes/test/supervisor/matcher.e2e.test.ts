import { currentBuild } from "../../../../scripts/retained-build.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveHelperRuntime } from "../../src/supervisor/runtime-resolver.ts";
import { startSupervisor } from "./harness.ts";

const root = new URL("../..", import.meta.url).pathname;
const supervisorPath = join(currentBuild(root), "supervisor.js");
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

test("watch sets are future-only, revision fenced and non-repeat", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  try {
    const processId = id("watch");
    ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "watcher", command: "printf 'old\\n'; sleep .2; printf 'ready one\\n'; printf 'ready two\\n'; sleep .1", cwd: root, shell,
      stopGraceMs: 200, logLimits, watches: [],
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const armed = ok(await harness.send("watchSet", {
      operationId: op(), id: processId, expectedWatchRevision: 0,
      definitions: [{ key: "ready", pattern: "ready", mode: "literal", stream: "stdout", repeat: false }],
    }));
    assert.equal(armed.watchRevision, 1);
    const conflict = await harness.send("watchSet", {
      operationId: op(), id: processId, expectedWatchRevision: 0, definitions: [],
    });
    assert.equal(conflict.payload.ok, false);
    assert.equal(conflict.payload.code, "conflict");

    const match = await harness.waitFor((frame) => frame.type === "watchMatch" && frame.payload.id === processId);
    assert.equal(match.payload.key, "ready");
    assert.equal(match.payload.text, "ready one");
    await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId);
    assert.equal(harness.frames.filter((frame) => frame.type === "watchMatch" && frame.payload.id === processId).length, 1);
  } finally { await harness.dispose(); }
});

test("log search and log page regex run through matcher worker", async () => {
  const harness = await startSupervisor({ runtime: await runtimePath(), supervisorPath });
  try {
    const processId = id("search");
    ok(await harness.send("spawn", {
      operationId: op(), id: processId, name: "searcher", command: "printf 'alpha\\nbeta 42\\ngamma 77\\n'", cwd: root, shell,
      stopGraceMs: 200, logLimits, watches: [],
    }));
    await harness.waitFor((frame) => frame.type === "terminal" && frame.payload.id === processId);
    const search = ok(await harness.send("logSearch", {
      id: processId, stream: "both", pattern: "[0-9]+", mode: "regex", pageSize: 10,
    }));
    assert.deepEqual((search.matches as Array<{ text: string }>).map((line) => line.text), ["beta 42", "gamma 77"]);
    const page = ok(await harness.send("logPage", {
      id: processId, stream: "both", tailLines: 20, pattern: "beta", mode: "literal",
    }));
    assert.deepEqual((page.lines as Array<{ text: string }>).map((line) => line.text), ["beta 42"]);
  } finally { await harness.dispose(); }
});
