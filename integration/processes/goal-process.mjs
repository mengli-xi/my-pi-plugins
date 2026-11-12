import { installedPiVersion } from "../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = join(repo, "local/pi-processes");
const binary = process.env.PI_PROCESSES_TEST_PI ?? join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const goal = process.env.PI_PROCESSES_TEST_GOAL_ENTRY;
assert.ok(goal && existsSync(goal), "Set PI_PROCESSES_TEST_GOAL_ENTRY to the built entry of an actual pi-goal package.");
const artifact = process.env.PI_PROCESSES_TEST_OUTPUT ?? mkdtempSync(join(tmpdir(), "goal-process-joint-"));
mkdirSync(artifact, { recursive: true });
const withChild = process.env.PI_PROCESSES_GOAL_WITH_SUBAGENTS === "1";
const subagents = join(repo, "local/pi-subagents");
const results = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scenarios = process.env.PI_PROCESSES_GOAL_SCENARIOS?.split(",") ?? ["active-pg", "active-gp", "paused-pg", "paused-gp"];
assert.ok(scenarios.every(value => ["active-pg", "active-gp", "paused-pg", "paused-gp"].includes(value)));
for (const scenario of scenarios) {
  const root = mkdtempSync(join(artifact, (withChild ? "triple-" : "") + scenario + "-"));
  for (const name of ["home", "agent", "cwd", "tmp"]) mkdirSync(join(root, name));
  assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), TMPDIR: join(root, "tmp"), NODE_OPTIONS: process.env.NODE_OPTIONS } }).trim(), installedPiVersion());
  writeFileSync(join(root, "events.jsonl"), "");
  writeFileSync(join(root, "agent/settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  writeFileSync(join(root, "agent/pi-goal.json"), JSON.stringify({ rpc: { enabled: true }, backgroundWaitCheckInMs: null, continuationLimits: { automaticTurns: 10, noProgressTurns: 3 } }));
  const fixture = fileURLToPath(new URL("./goal-process-fixture.ts", import.meta.url));
  const extensions = scenario.endsWith("pg") ? [join(pkg, "dist/index.js"), goal, fixture] : [goal, join(pkg, "dist/index.js"), fixture];
  if (withChild) {
    if (scenario.endsWith("pg")) extensions.unshift(join(subagents, "dist/index.js"));
    else extensions.splice(2, 0, join(subagents, "dist/index.js"));
    extensions.push(join(subagents, "test/fixtures/faux-subagent-provider.ts"));
  }
  const child = spawn(binary, ["--mode", "rpc", "--offline", "--approve", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", ...extensions.flatMap(path => ["-e", path]), "--provider", "goal-process-faux", "--model", "fixture", "--thinking", "off", "--tools", (withChild ? "process,spawn_agent,goal_complete,goal_blocked" : "process,goal_complete,goal_blocked")], {
    cwd: join(root, "cwd"), env: { PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), TMPDIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_PROCESS_GOAL_ROOT: root, PI_PROCESS_GOAL_SCENARIO: scenario, PI_PROCESS_GOAL_CHILD: withChild ? "1" : "0", NODE_OPTIONS: process.env.NODE_OPTIONS }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", buffer = "";
  const rpc = [];
  child.stdout.on("data", chunk => { stdout += chunk; buffer += chunk; for (let at; (at = buffer.indexOf("\n")) >= 0;) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { rpc.push(JSON.parse(line)); } catch {} } });
  child.stderr.on("data", chunk => stderr += chunk);
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  let rowVersion, cachedRows = [];
  const rows = () => {
    const path = join(root, "events.jsonl"), stat = statSync(path, { bigint: true });
    const version = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    if (version !== rowVersion) {
      cachedRows = readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse);
      rowVersion = version;
    }
    return cachedRows;
  };
  const until = async (predicate, label) => { const end = Date.now() + 25000; while (!predicate()) { if (Date.now() > end || child.exitCode !== null) throw Error(scenario + ": " + label + "; " + stderr + "; " + JSON.stringify(rpc.filter(r => r.type === "extension_error")).slice(-1500)); await delay(20); } };
  const send = (id, message) => child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
  try {
    send("prepare", "PREPARE_JOINT");
    await until(() => rows().some(r => r.stage === "settled" && r.calls === 1), "accepted user seed");
    send("goal", "/goal Verify the background Process result");
    await until(() => rows().some(r => r.stage === "settled" && r.calls === 3), "initial wait");
    if (scenario.startsWith("paused")) { send("pause", "/goal pause"); await until(() => rpc.some(r => r.id === "pause" && r.type === "response"), "pause"); }
    writeFileSync(join(root, "gate"), "ready");
    await until(() => rows().some(r => r.stage === "settled" && r.calls >= 4), "completion wake");
    await delay(250);
    child.stdin.write(JSON.stringify({ id: "entries", type: "get_entries" }) + "\n");
    await until(() => rpc.some(r => r.id === "entries" && r.type === "response"), "entries");
    const entries = rpc.find(r => r.id === "entries" && r.type === "response").data.entries;
    const requests = rows().filter(r => r.stage === "request"), goals = entries.filter(e => e.type === "custom" && e.customType === "goal-state").map(e => e.data.goal).filter(Boolean);
    const summary = { scenario, root, calls: requests.length, processRequests: requests.filter(r => JSON.stringify(r.messages).includes(withChild ? "PROCESS_PARENT_DONE" : "Process 'goal-wait' succeeded")).length, nativeBatches: entries.filter(e => e.type === "custom_message" && e.customType === "process-notification-batch-v1").length, claims: entries.filter(e => e.type === "custom" && e.customType === "process-notification-claim-v1").length, maxAutomatic: Math.max(0, ...goals.map(g => g.automaticModelTurns)), finalGoal: entries.filter(e => e.type === "custom" && e.customType === "goal-state").at(-1)?.data.goal?.status ?? null };
    summary.goalClaims = new Set(entries.filter(e => e.type === "custom" && e.customType === "goal-state" && e.data.pendingContinuation).map(e => e.data.pendingContinuation.continuationId)).size;
    const attempts = entries.filter(e => e.type === "custom" && e.customType === "agent-mailbox-attempt-v1");
    summary.controls = attempts.length;
    summary.emptyControls = attempts.filter(e => e.data.members.length === 0).length;
    summary.fallbacks = entries.filter(e => e.type === "custom_message" && e.customType === "subagent-continuation-v1").length;
    if (withChild) {
      const observed = rows().findLast(row => row.stage === "children");
      assert.ok(observed, "test extension must observe native child sessions through the SDK service");
      summary.childCalls = observed.calls;
      summary.childBatches = observed.batches;
      assert.equal(summary.childCalls, 4); assert.equal(summary.childBatches, 1);
    }
    writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary)); results.push(summary);
    assert.equal(summary.calls, 4); assert.equal(summary.processRequests, 1); assert.equal(summary.nativeBatches, withChild ? 0 : 1);
    assert.equal(withChild ? summary.goalClaims : summary.claims, scenario.startsWith("active") ? 1 : 0);
    assert.equal(summary.finalGoal, scenario.startsWith("active") ? null : "paused");
    assert.ok(summary.maxAutomatic <= 1);
    assert.equal(summary.controls, 1); assert.equal(summary.emptyControls, 0);
    assert.equal(summary.fallbacks, withChild && scenario.startsWith("paused") ? 1 : 0);
    assert.equal(rpc.filter(r => r.type === "extension_error").length, 0);
  } finally {
    child.stdin.end(); let timer;
    const exit = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timeout: true }); }, 15000); })]); clearTimeout(timer);
    writeFileSync(join(root, "rpc.jsonl"), stdout); writeFileSync(join(root, "stderr.log"), stderr); writeFileSync(join(root, "exit.json"), JSON.stringify(exit));
    assert.deepEqual(exit, { code: 0, signal: null });
  }
}
for (const status of ["active", "paused"]) {
  const pair = results.filter(r => r.scenario.startsWith(status));
  if (pair.length === 2) { assert.equal(pair[0].calls, pair[1].calls); assert.equal(pair[0].maxAutomatic, pair[1].maxAutomatic); }
}
writeFileSync(join(artifact, withChild ? "triple-summary.json" : "goal-process-summary.json"), JSON.stringify(results, null, 2));
