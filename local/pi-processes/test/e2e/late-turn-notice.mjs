import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run only stock Pi and a deterministic provider, with no real credentials or profile.
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pi = process.env.PI_PROCESSES_TEST_PI ?? fileURLToPath(new URL("../../../../node_modules/.bin/pi", import.meta.url));
const version = execFileSync(pi, ["--version"], { encoding: "utf8" }).trim();
assert.equal(version, "1.5.0");
const root = mkdtempSync(join(process.env.PI_PROCESSES_TEST_OUTPUT ?? tmpdir(), "late-turn-"));
for (const name of ["home", "agent", "cwd", "tmp", "config", "cache", "state", "data"]) mkdirSync(join(root, name));
writeFileSync(join(root, "agent/settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
const scenario = process.env.PI_PROCESSES_TEST_SCENARIO ?? "chain";
assert.ok(["chain", "single", "context", "abort"].includes(scenario));
const fixture = join(root, "fixture.ts");
const logFile = join(root, "fixture.jsonl");
writeFileSync(fixture, `
import { appendFileSync, writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default function (pi) {
  const root = ${JSON.stringify(root)}, scenario = ${JSON.stringify(scenario)};
  const log = (value) => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ at: Date.now(), ...value }) + "\\n");
  let ctx;
  pi.on("session_start", (_event, context) => { ctx = context; });
  pi.on("agent_settled", (event) => { log({ stage: "settled", calls: faux.state.callCount, aborted: event.aborted }); });
  const command = (gate, output) => "while [ ! -f '" + root + "/" + gate + "' ]; do sleep 0.02; done; printf '" + output + "\\\\n'; sleep 0.2";
  const start = (name, gate, attention) => fauxAssistantMessage(fauxToolCall("process", {
    action: "start", name, kind: "process", command: command(gate, name === "seed" ? "SEED" : "READY"),
    notify: { onSuccess: name === "seed" ? "turn" : "context" },
    watches: name === "seed" ? [] : [{ key: "ready", pattern: "READY", mode: "literal", stream: "stdout", repeat: false, attention }],
    continuation: { mode: "wait", until: name === "seed" ? { kind: "exit" } : { kind: "watch", key: "ready" } },
  }), { stopReason: "toolUse" });
  const faux = fauxProvider({ provider: "late-turn-faux", api: "late-turn-faux", models: [{ id: "fixture", reasoning: false, contextWindow: 32768, maxTokens: 256 }], tokensPerSecond: 1000000 });
  faux.setResponses(Array.from({ length: 12 }, () => async (context, _options, state) => {
    log({ stage: "request", call: state.callCount, messages: context.messages });
    if (state.callCount === 1) return start(scenario === "chain" ? "seed" : "watcher", scenario === "chain" ? "seed-gate" : "watch-gate", scenario === "context" ? "context" : "turn");
    if (scenario === "chain" && state.callCount === 2) return fauxAssistantMessage("WAITING_FOR_SEED");
    if (scenario === "chain" && state.callCount === 3) return start("watcher", "watch-gate", "turn");
    if (state.callCount === (scenario === "chain" ? 4 : 2)) {
      log({ stage: "final-start" });
      writeFileSync(root + "/watch-gate", "ready");
      const deadline = Date.now() + 10000;
      while (!ctx.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "process-event-v2" && entry.data?.process?.name === "watcher" && entry.data?.kind === "watch-match")) {
        if (Date.now() > deadline) throw new Error("watch did not arrive during delayed final response");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      log({ stage: "watch-during-final" });
      if (scenario === "abort") {
        if (!_options.signal.aborted) await new Promise(resolve => _options.signal.addEventListener("abort", resolve, { once: true }));
        return fauxAssistantMessage("ABORTED", { stopReason: "aborted" });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      return fauxAssistantMessage("WAITING_FOR_WATCH");
    }
    return fauxAssistantMessage("WATCH_HANDLED");
  }));
  pi.registerProvider(faux.provider);
}
`);
const child = spawn(pi, ["--mode", "rpc", "--offline", "--approve", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes",
  "-e", join(packageDir, "dist/index.js"), "-e", fixture, "--provider", "late-turn-faux", "--model", "fixture", "--thinking", "off", "--tools", "process"], {
  cwd: join(root, "cwd"),
  env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "", stderr = "", buffer = "";
const events = [];
child.stdout.on("data", chunk => {
  stdout += chunk; buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n"), line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try { events.push(JSON.parse(line)); } catch {}
  }
});
child.stderr.on("data", chunk => { stderr += chunk; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let logVersion, logRows = [];
const logs = () => {
  try {
    const st = statSync(logFile, { bigint: true });
    const version = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    if (version !== logVersion) {
      logRows = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      logVersion = version;
    }
    return logRows;
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
async function until(predicate) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.equal(child.exitCode, null, stderr);
    assert.equal(events.some(event => event.type === "extension_error"), false, JSON.stringify(events));
    if (Date.now() > deadline) throw new Error(`fixture timeout: ${JSON.stringify(logs())}\n${stdout}\n${stderr}`);
    await delay(20);
  }
}
const send = value => child.stdin.write(JSON.stringify(value) + "\n");
try {
  send({ id: "initial", type: "prompt", message: "Run the deterministic process watch fixture." });
  if (scenario === "chain") {
    await until(() => logs().some(row => row.stage === "settled" && row.calls === 2));
    writeFileSync(join(root, "seed-gate"), "ready");
  }
  const finalCalls = scenario === "chain" ? 4 : 2;
  await until(() => logs().some(row => row.stage === "watch-during-final"));
  if (scenario === "abort") send({ id: "abort", type: "abort" });
  await until(() => logs().some(row => row.stage === "settled" && row.calls >= finalCalls));
  if (scenario === "abort") assert.ok(logs().some(row => row.stage === "settled" && row.aborted));
  const expectWake = !["context", "abort"].includes(scenario) && process.env.PI_PROCESSES_TEST_EXPECT_STALLED !== "1";
  // No user prompt is sent while waiting for an autonomous continuation.
  if (expectWake) {
    await until(() => logs().some(row => row.stage === "request" && row.call === finalCalls + 1));
    await until(() => logs().some(row => row.stage === "settled" && row.calls === finalCalls + 1));
    await delay(150); // Observe duplicate triggers only after the expected run completed.
  } else {
    await delay(700); // Bounded observation for context/stalled negative controls.
  }
  const calls = logs().filter(row => row.stage === "request");
  // The public provider transcript converts custom carriers to ordinary user content.
  const hasWatch = row => JSON.stringify(row.messages).includes("Process 'watcher' matched watch 'ready'.");
  const watchRequests = calls.filter(hasWatch);
  const summary = { version, scenario, root, calls: calls.length, watchProviderRequests: watchRequests.length, expectedWake: expectWake };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  assert.equal(calls.length, finalCalls + (expectWake ? 1 : 0), "unexpected provider call count");
  assert.equal(watchRequests.length, expectWake ? 1 : 0, "watch must reach exactly one autonomous provider request");
  if (!expectWake) {
    send({ id: "natural", type: "prompt", message: "Continue at this natural user boundary." });
    await until(() => logs().some(row => row.stage === "settled" && row.calls === finalCalls + 1));
    const last = logs().filter(row => row.stage === "request").at(-1);
    assert.ok(hasWatch(last), "pending watch should arrive at the next natural prompt");
  }
} finally {
  child.stdin.end();
  let exitTimer;
  const exit = await Promise.race([
    new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise(resolve => { exitTimer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timeout: true }); }, 15000); }),
  ]);
  clearTimeout(exitTimer);
  writeFileSync(join(root, "rpc.jsonl"), stdout);
  writeFileSync(join(root, "stderr.log"), stderr);
  writeFileSync(join(root, "exit.json"), JSON.stringify(exit));
  assert.deepEqual(exit, { code: 0, signal: null });
}
