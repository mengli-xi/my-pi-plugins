import { installedPiVersion } from "../../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.env.PI_PROCESSES_TEST_PI ?? fileURLToPath(new URL("../../../../node_modules/.bin/pi", import.meta.url));
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), installedPiVersion());
const artifact = process.env.PI_PROCESSES_TEST_OUTPUT ?? mkdtempSync(join(tmpdir(), "process-recovery-"));
mkdirSync(artifact, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const cached = new Map();
const jsonLines = source => source.split("\n").filter(Boolean).map(JSON.parse);
const readVersioned = (path, parse) => {
  const st = statSync(path, { bigint: true });
  const version = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  const prior = cached.get(path);
  if (prior?.version === version) return prior.value;
  const value = parse(readFileSync(path, "utf8"));
  cached.set(path, { version, value });
  return value;
};
for (const scenario of ["fulfilled", "cancelled", "compacted", "marker-fault"]) {
  const fulfilled = scenario !== "cancelled";
  const root = mkdtempSync(join(artifact, "recovery-" + scenario + "-"));
  for (const name of ["home", "agent", "cwd", "tmp", "config", "cache", "state", "data"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "agent/settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1000 } }));
  let file, sessionId, terminalId;
  const calls = [];
  for (const phase of [1, 2, 3]) {
    const logPath = join(root, "phase" + phase + ".jsonl"); writeFileSync(logPath, "");
    const child = spawn(binary, ["--mode", "rpc", "--offline", "--approve", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", ...(file ? ["--session", file] : []), "-e", join(pkg, "test/e2e/mailbox-recovery-fixture.ts"), "--provider", "recovery-faux", "--model", "fixture", "--thinking", "off", "--tools", ""], {
      cwd: join(root, "cwd"), env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_PROCESS_RECOVERY_ROOT: root, PI_PROCESS_RECOVERY_PHASE: String(phase), PI_PROCESS_RECOVERY_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const rows = () => readVersioned(logPath, jsonLines);
    const snapshot = () => { try { return readVersioned(join(root, "agent/mailbox/v1", sessionId, "pending.json"), JSON.parse); } catch(error) { if(error.code === "ENOENT") return { pending: [], terminal: [] }; throw error; } };
    const until = async (predicate, label) => { const end = Date.now() + 20000; while (!predicate()) { if (Date.now() > end || child.exitCode !== null) throw Error(scenario + " phase " + phase + " " + label + ": " + stderr + stdout.slice(-1200)); await delay(20); } };
    const send = message => child.stdin.write(JSON.stringify({ id: String(Date.now()), type: "prompt", message }) + "\n");
    let expectedSignal = null;
    try {
      await until(() => rows().some(row => row.stage === "ready"), "ready");
      const ready = rows().find(row => row.stage === "ready"); file = ready.file; sessionId = ready.sessionId;
      if (phase === 1) {
        send("seed fixture");
        await until(() => rows().some(row => row.stage === "accepted"), "durable accepted");
        assert.equal(snapshot().pending.length, 1);
        if (scenario === "compacted") {
          await until(() => rows().some(row => row.stage === "recorded"), "canonical body before compaction");
          child.stdin.write(JSON.stringify({ id: "compact", type: "compact" }) + "\n");
          await until(() => rows().some(row => row.stage === "compacted"), "manual compaction");
          assert.equal(snapshot().pending.length, 1);
        }
      } else {
        await delay(250);
        assert.equal(rows().filter(row => row.stage === "request").length, 0, "reopen is held");
        if (phase === 2) {
          send(fulfilled ? "/mailbox resume" : "/process-recovery-cancel");
          if (scenario === "marker-fault") {
            await until(() => rows().some(row => row.stage === "marker-fault") && snapshot().pending[0]?.recorded?.ack === "pending", "source marker ACK debt");
            await delay(150);
            assert.equal(rows().filter(row => row.stage === "request").length, 0);
            assert.equal(snapshot().pending[0].nativeEntries.length, 1);
            writeFileSync(join(root, "allow-marker"), "repair");
            send("/mailbox resume");
          }
          await until(() => rows().some(row => row.stage === "terminal") && snapshot().terminal.some(record => record.terminalAck === "pending"), "terminal with owed source ACK");
          terminalId = rows().find(row => row.stage === "terminal").evidence.terminalId;
          assert.equal(snapshot().pending.length, 0);
          assert.equal(snapshot().terminal[0].evidence.outcome, fulfilled ? "fulfilled" : "cancelled");
          if (fulfilled) await until(() => readVersioned(file, jsonLines).some(entry => entry.type === "custom" && entry.customType === "process-notification-status-v1" && entry.data.state === "turn-settled"), "source run settlement persisted");
        } else {
          await until(() => rows().some(row => row.stage === "terminal") && snapshot().terminal.length === 0, "same terminal replay and GC");
          assert.ok(rows().filter(row => row.stage === "terminal").every(row => row.evidence.terminalId === terminalId));
          assert.equal(snapshot().pending.length, 0);
          assert.deepEqual(rows().find(row => row.stage === "ready").businessPending, []);
        }
      }
      await delay(100);
      calls.push(rows().filter(row => row.stage === "request").length);
      if (phase < 3) { expectedSignal = "SIGKILL"; child.kill(expectedSignal); } else child.stdin.end();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      let timer;
      const exit = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timeout: true }); }, 15000); })]); clearTimeout(timer);
      writeFileSync(join(root, "phase" + phase + "-rpc.jsonl"), stdout); writeFileSync(join(root, "phase" + phase + "-stderr.log"), stderr);
      if (expectedSignal) assert.deepEqual(exit, { code: null, signal: expectedSignal }); else assert.deepEqual(exit, { code: 0, signal: null });
    }
  }
  const entries = readVersioned(file, jsonLines);
  const bodies = entries.filter(entry => entry.type === "custom_message" && entry.customType === "process-notification-batch-v1");
  assert.deepEqual(calls, scenario === "compacted" ? [2, 1, 0] : fulfilled ? [1, 1, 0] : [1, 0, 0]);
  assert.equal(bodies.length, fulfilled ? 1 : 0);
  const summary = { scenario, root, providerCalls: calls, nativeBodies: bodies.length, terminalId };
  results.push(summary); console.log(JSON.stringify(summary)); writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
}
writeFileSync(join(artifact, "recovery-summary.json"), JSON.stringify(results, null, 2));
