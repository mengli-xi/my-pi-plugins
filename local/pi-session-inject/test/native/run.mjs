import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { fulfilledFinalAckLostFixture } from "../fixtures/fulfilled-final-ack-lost.ts";
const root = dirname(fileURLToPath(import.meta.url));
const binary = process.env.MAILBOX_PI_BINARY ?? join(process.env.HOME, "bin", "pi-binary");
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), "1.5.0");
const artifact = process.env.MAILBOX_NATIVE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "mailbox-native-"));
const bundle = join(artifact, "bundles"); mkdirSync(bundle, { recursive: true });
execFileSync("bun", ["build", join(root, "first.ts"), join(root, "second.ts"), "--target=node", "--format=esm", "--external=@earendil-works/pi-coding-agent", "--external=@earendil-works/pi-ai", `--outdir=${bundle}`], { stdio: "pipe" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scenarios = process.env.MAILBOX_NATIVE_SCENARIOS?.split(",") ?? ["active-turn-clear", "active-turn-false", "active-settle-clear", "active-settle-false", "settled-ab", "settled-ba", "deferred-user-first", "deferred-control-first", "facade-ab", "facade-ba", "fulfilled-ack-recovery", "orphan-recovery"];
const results = [];
for (const scenario of scenarios) {
  const directory = join(artifact, scenario); for (const name of ["home", "agent", "cwd", "tmp"]) mkdirSync(join(directory, name), { recursive: true });
  const logPath = join(directory, "events.jsonl"); writeFileSync(logPath, "");
  writeFileSync(join(directory, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  let sessionFile;
  if (scenario === "fulfilled-ack-recovery") {
    sessionFile = join(directory, "fulfilled-session.jsonl");
    const fixture = fulfilledFinalAckLostFixture(sessionFile, join(directory, "cwd"));
    writeFileSync(sessionFile, fixture.sessionEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const snapshotDirectory = join(directory, "agent", "mailbox", "v1", fixture.snapshot.session.id);
    mkdirSync(snapshotDirectory, { recursive: true }); writeFileSync(join(snapshotDirectory, "pending.json"), JSON.stringify(fixture.snapshot));
  }
  let orphan;
  if (scenario === "orphan-recovery") {
    const fixture = fulfilledFinalAckLostFixture(join(directory, "missing-session.jsonl"), join(directory, "cwd"));
    orphan = { ...fixture.snapshot, revision: 1, terminal: [], pending: [{ ...fixture.mail, anchorEntryId: null, acceptedRevision: 1,
      requiredCallbacks: { recorded: false, terminal: true }, branchEntryId: null, nativeEntries: [], recorded: null }] };
    const snapshotDirectory = join(directory, "agent", "mailbox", "v1", orphan.session.id);
    mkdirSync(snapshotDirectory, { recursive: true }); writeFileSync(join(snapshotDirectory, "pending.json"), JSON.stringify(orphan));
  }
  const reversed = scenario.endsWith("-ba"), extensions = reversed ? ["second.js", "first.js"] : ["first.js", "second.js"];
  const child = spawn(binary, ["--mode", "rpc", "--offline", "--approve", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", ...(sessionFile ? ["--session", sessionFile] : []), ...extensions.flatMap(name => ["-e", join(bundle, name)]), "--provider", "mailbox-faux", "--model", "fixture", "--thinking", "off"], {
    cwd: join(directory, "cwd"), env: { PATH: process.env.PATH, HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"), TMPDIR: join(directory, "tmp"), PI_OFFLINE: "1", PI_TELEMETRY: "0", MAILBOX_NATIVE_LOG: logPath, MAILBOX_NATIVE_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", id = 0;
  child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const rows = () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const send = message => child.stdin.write(JSON.stringify({ id: String(++id), type: "prompt", message }) + "\n");
  const until = async predicate => { const end = Date.now() + 25000; while (!predicate()) { if (Date.now() > end || child.exitCode !== null) throw Error(`timeout; ${stderr}\n${stdout.slice(-5000)}\n${JSON.stringify(rows().slice(-5))}`); await delay(15); } };
  const result = { scenario };
  try {
    if (scenario === "orphan-recovery") {
      // The completion uses the real resource cache, which becomes ready after
      // async snapshot discovery. Poll the public command, never fabricate IDs.
      await until(() => rows().some(row => row.stage === "scope"));
      const end = Date.now() + 10000;
      while (!rows().some(row => row.stage === "inspect" && row.answers["recover "]?.some(item => item.value === `recover ${orphan.session.id}`))) {
        if (Date.now() > end) throw Error("orphan resource completion unavailable");
        send("/mailtest-inspect-a"); await delay(50);
      }
      assert.ok(rows().some(row => row.stage === "inspect" && row.partialRecover?.answers?.some(item => item.value === `recover ${orphan.session.id}`)));
      send(`/mailbox recover ${orphan.session.id}`);
      await until(() => rows().some(row => row.stage === "scope" && row.label === "b" && row.sessionId === orphan.session.id));
      assert.equal(rows().filter(row => row.stage === "request").length, 0);
      send("/mailbox resume");
      await until(() => rows().some(row => row.stage === "terminal"));
      const requests = rows().filter(row => row.stage === "request"); assert.equal(requests.length, 1);
      const sessionsRoot = join(directory, "agent", "sessions");
      const candidates = readdirSync(sessionsRoot, { recursive: true }).filter(name => name.endsWith(".jsonl"))
        .map(name => readFileSync(join(sessionsRoot, name), "utf8").split("\n").filter(Boolean).map(JSON.parse));
      const entries = candidates.find(rows => rows[0].id === orphan.session.id); assert.ok(entries); assert.ok(entries[0].cwd);
      assert.equal(entries[0].id, orphan.session.id); assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "scheduler-injection-v1").length, 1);
      result.requests = 1; result.preservedSessionId = true; result.heldBeforeResume = true;
    } else if (scenario === "fulfilled-ack-recovery") {
      await until(() => rows().some(row => row.stage === "terminal") && rows().some(row => row.stage === "repeated-put"));
      const terminal = rows().find(row => row.stage === "terminal"), repeated = rows().find(row => row.stage === "repeated-put");
      assert.equal(terminal.evidence.terminalId, "terminal-fulfilled-fixture"); assert.equal(repeated.result.kind, "terminal");
      assert.equal(rows().filter(row => row.stage === "request").length, 0); result.requests = 0;
    } else if (scenario.startsWith("facade")) {
      const owner = reversed ? "b" : "a";
      send("/mailbox status"); send(`/mailtest-inspect-${owner}`);
      await until(() => rows().some(row => row.stage === "inspect"));
      send(`/mailtest-close-${owner}`); await until(() => rows().some(row => row.stage === "owner-closed"));
      send("/mailbox status"); send("/mailbox resume"); send(`/mailtest-inspect-${owner}`);
      await until(() => rows().filter(row => row.stage === "inspect").length === 2);
      send(`/mailtest-reload-${owner}`); await until(() => rows().some(row => row.stage === "reloaded"));
      send("/mailbox status"); send(`/mailtest-inspect-${owner}`);
      await until(() => rows().filter(row => row.stage === "inspect").length === 3);
      const all = rows(), inspections = all.filter(row => row.stage === "inspect");
      assert.equal(all.filter(row => row.stage === "request").length, 0);
      assert.equal(all.filter(row => row.stage === "registered").length, 2);
      for (const inspection of inspections) {
        assert.deepEqual(inspection.names, ["mailbox"]); assert.deepEqual(inspection.answers[""].map(item => item.value), ["status", "resume", "recover"]);
        assert.deepEqual(inspection.answers.st.map(item => item.value), ["status"]); assert.equal(inspection.answers.unknown, null);
      }
      result.requests = 0;
    } else {
      send("INITIAL");
      const expected = scenario.startsWith("deferred") ? 3 : 2;
      const expectedRuns = scenario.startsWith("active") ? 1 : expected;
      await until(() => rows().filter(row => row.stage === "request").length >= expected && rows().filter(row => row.stage === "settled" && row.label === "a").length >= expectedRuns);
      await until(() => rows().filter(row => row.stage === "terminal").length >= (scenario.startsWith("deferred") ? 1 : 2));
      const all = rows(), requests = all.filter(row => row.stage === "request"), final = all.filter(row => row.stage === "settled" && row.label === "a").at(-1);
      assert.equal(requests.length, expected); assert.equal(final.bodies, scenario.startsWith("deferred") ? 1 : 2); assert.equal(final.controls, 1);
      assert.equal(all.filter(row => row.stage === "terminal").length, scenario.startsWith("deferred") ? 1 : 2);
      if (scenario === "deferred-user-first") {
        const middle = all.filter(row => row.stage === "settled" && row.label === "a")[1];
        assert.equal(middle.idleControls.length, 1); assert.equal(middle.idleControls[0].started, false);
      }
      result.requests = requests.length; result.bodies = final.bodies; result.controls = final.controls;
    }
    assert.ok(!stdout.includes('"type":"extension_error"'), stdout); result.passed = true;
  } catch (error) { result.passed = false; result.error = String(error); }
  child.stdin.end(); let timeout;
  result.exit = await Promise.race([closed, new Promise(resolve => { timeout = setTimeout(() => { child.kill("SIGKILL"); resolve({ timeout: true }); }, 10000); })]); clearTimeout(timeout);
  if (result.exit.code !== 0) result.passed = false;
  writeFileSync(join(directory, "rpc.jsonl"), stdout); writeFileSync(join(directory, "stderr.log"), stderr); results.push(result); console.log(JSON.stringify(result));
}
writeFileSync(join(artifact, "summary.json"), JSON.stringify({ binary, version: "1.5.0", realRequests: 0, artifact, results }, null, 2));
console.log(`Artifacts: ${artifact}`); process.exitCode = results.every(result => result.passed) ? 0 : 1;
