import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fulfilledFinalAckLostFixture } from "../../tests/fixtures/fulfilled-final-ack-lost.ts";
import { normalizeSchedulerRollback, schedulerRollbackInventory } from "../../src/mailbox-rollback.ts";
import { SchedulerStore } from "../../src/store.ts";
import { schedulerPaths } from "../../src/paths.ts";
import { request } from "../../src/client.ts";
import { installedPiVersion } from "../../../../scripts/pi-checks.mjs";
import { waitForDaemonLockRelease } from "../../tests/fixtures/daemon-lock.ts";
import { injectionMail } from "../../src/mailbox-adapter.ts";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.env.PI_BIN;
if (!binary) throw new Error("PI_BIN is required; use npm run check:host");
const artifact = process.env.SCHEDULER_JOINT_ARTIFACT_DIR || mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "scheduler-mailbox-joint-"));
assert.ok(!existsSync(artifact) || readdirSync(artifact).length === 0, "Joint artifact directory must be empty; preserve previous evidence and choose a fresh directory");
mkdirSync(artifact, { recursive: true });
const versionAgent = join(artifact, "version-agent"), versionHome = join(artifact, "version-home");
mkdirSync(versionAgent); mkdirSync(versionHome);
const version = execFileSync(binary, ["--version"], { cwd: artifact, env: { ...process.env, HOME: versionHome, PI_CODING_AGENT_DIR: versionAgent, PI_OFFLINE: "1" }, encoding: "utf8" }).trim();
assert.equal(version, installedPiVersion(), "test CLI matches the installed Pi SDK");
const bundle = join(artifact, "extension.js");
execFileSync("bun", ["build", join(pkg, "scripts/mailbox-joint/extension.ts"), "--target=node", "--format=esm", "--external=@earendil-works/pi-coding-agent", "--external=@earendil-works/pi-ai", "--outfile", bundle], { stdio: "pipe" });
// The test bundles the extension, so preserve its relative daemon artifact.
mkdirSync(join(artifact, "dist"));
cpSync(join(pkg, "dist/daemon.js"), join(artifact, "dist/daemon.js"));
const jointScenarios = ["fulfilled", "ack-lost", "ack-snapshot-lost", "source-disabled", "reopen", "fork-parent", "full-normal", "full-recovered-source", "full-live", "full-batch", "proof-conflict", "owner-before", "owner-after", "stale", "recorded-lost", "late", "error", "abort", "unknown-crash", "cancel-flight", "legacy-completed", "legacy-recorded-lost", "legacy-edited", "legacy-compacted", "legacy-unhandled", "legacy-missing", "legacy-fork-first", "legacy-owner-missing", "tree", "tree-accepted"];
const scenarios = process.env.SCHEDULER_JOINT_SCENARIOS?.split(",") || jointScenarios;
for (const scenario of scenarios) assert.ok(jointScenarios.includes(scenario), `Unknown joint scenario: ${scenario}`);
const results = [];
for (const scenario of scenarios) {
  const directory = join(artifact, scenario);
  for (const part of ["home", "agent", "cwd", "tmp"]) mkdirSync(join(directory, part), { recursive: true });
  const agent = join(directory, "agent"), cwd = join(directory, "cwd"), paths = schedulerPaths(agent), store = new SchedulerStore(paths.root);
  const file = join(directory, "session.jsonl"), f = fulfilledFinalAckLostFixture(file, cwd);
  const log = join(directory, "events.jsonl"); writeFileSync(log, "");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
  const recovery = ["fulfilled", "ack-lost", "ack-snapshot-lost", "source-disabled", "reopen", "fork-parent"].includes(scenario);
  let entries = recovery ? [...f.sessionEntries] : [f.sessionEntries[0], f.sessionEntries[1], { ...f.sessionEntries[3], id: "seed-assistant", parentId: "anchor-fixture" }];
  if (scenario === "tree" || scenario === "tree-accepted") entries = [f.sessionEntries[0], f.sessionEntries[1], { ...f.sessionEntries[3], id: "origin-fixture", parentId: "anchor-fixture" }, { ...f.sessionEntries[3], id: "sibling-fixture", parentId: "origin-fixture" }, { ...f.sessionEntries[3], id: "seed-assistant", parentId: "origin-fixture" }];
  const now = Date.now();
  let marker = { injectionId: f.injectionId, taskId: f.taskId, title: "Shared ACK recovery fixture", prompt: f.prompt,
    scheduledTime: f.scheduledTime, staleAt: now + 60000, createdAt: now, sessionId: f.snapshot.session.id, phase: "pending" };
  if (recovery) {
    marker = { ...marker, phase: "mailbox-owned", mailbox: { anchorEntryId: f.mail.anchorEntryId, recordedToken: "recorded-injection-fixture", entryId: "native-injection-fixture" } };
    const path = join(agent, "mailbox/v1", f.snapshot.session.id); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "pending.json"), JSON.stringify(f.snapshot));
  }
  const cold = ["full-normal", "full-batch", "proof-conflict"].includes(scenario);
  // Exercise restored A keys independently of source-only recovered admission.
  if (cold) marker = { ...marker, phase: "append-uncertain", mailbox: { anchorEntryId: "seed-assistant", legacy: false } };
  const secondMarker = { ...marker, taskId: `${f.taskId}-second`, injectionId: `${f.taskId}-second:${f.scheduledTime}`, prompt: "SCHEDULER_SECOND_BATCH_PROMPT" };
  if (cold) {
    const mails = (scenario === "full-batch" ? [marker, secondMarker] : [marker]).map(m => injectionMail({ ...m,
      anchorEntryId: m.mailbox.anchorEntryId, contentDigest: createHash("sha256").update(m.prompt).digest("hex") }));
    const pending = mails.map((mail, i) => ({ ...mail, acceptedRevision: i + 1, requiredCallbacks: { recorded: true, terminal: true }, branchEntryId: mail.anchorEntryId, nativeEntries: [], recorded: null }));
    const path = join(agent, "mailbox/v1", f.snapshot.session.id); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "pending.json"), JSON.stringify({ ...f.snapshot, revision: mails.length, pending, terminal: [] }));
  }
  const full = scenario.startsWith("full-") || scenario.startsWith("legacy-") && scenario !== "legacy-recorded-lost" || scenario === "fulfilled";
  if (scenario === "stale") {
    marker = { ...marker, staleAt: now - 1000, phase: "append-uncertain" };
    entries = [f.sessionEntries[0], f.sessionEntries[1], f.sessionEntries[2]];
  }
  if (scenario.startsWith("legacy-")) {
    entries = [f.sessionEntries[0], f.sessionEntries[1], f.sessionEntries[2]];
    if (scenario === "legacy-edited") entries.push({ type: "context_edit", id: "edit-fixture", parentId: "native-injection-fixture", timestamp: f.sessionEntries[1].timestamp, targetId: "native-injection-fixture", replacement: null });
    if (scenario === "legacy-compacted") entries.push({ type: "compaction", id: "compact-fixture", parentId: "native-injection-fixture", timestamp: f.sessionEntries[1].timestamp, summary: "Compacted fixture", firstKeptEntryId: null, tokensBefore: 2 });
    if (!["legacy-unhandled", "legacy-missing"].includes(scenario)) entries.push({ ...f.sessionEntries[3], parentId: entries.at(-1).id });
    marker = { ...marker, phase: "append-uncertain" };
    if (scenario === "legacy-missing") entries = [f.sessionEntries[0], f.sessionEntries[1], { ...f.sessionEntries[3], id: "seed-assistant", parentId: "anchor-fixture" }];
  }
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  let forkFile, forkId;
  if (scenario === "legacy-fork-first") {
    const parent = SessionManager.open(file, directory, cwd);
    forkFile = parent.createBranchedSession("assistant-fixture");
    forkId = parent.getSessionId();
    assert.ok(forkFile); assert.notEqual(forkId, f.snapshot.session.id);
  }
  const otherFile = join(directory, "other-session.jsonl");
  writeFileSync(otherFile, JSON.stringify({ ...f.sessionEntries[0], id: "00000000-0000-4000-8000-000000000003" }) + "\n");
  if (scenario.startsWith("legacy-") && !["legacy-unhandled", "legacy-missing"].includes(scenario)) {
    if (scenario !== "legacy-owner-missing") store.putTask({ id: f.taskId, title: marker.title, prompt: f.prompt,
      schedule: { kind: "once", at: f.scheduledTime }, timeZone: "UTC", toleranceMs: 60000,
      status: "paused", createdAt: now, origin: "user", target: { kind: "session", sessionId: f.snapshot.session.id, cwd } });
    store.appendRun({ taskId: f.taskId, injectionId: f.injectionId, scheduledTime: f.scheduledTime, finishedAt: now, outcome: "delivered", target: "session" }, now);
  } else if (scenario !== "full-live") {
    store.putInjection(marker);
    if (scenario === "full-batch") store.putInjection(secondMarker);
  }
  if ((!full && !recovery) || ["full-normal", "full-batch", "full-recovered-source"].includes(scenario)) store.writeOccupancy([{ sessionId: marker.sessionId, pid: process.pid, holderToken: "driver", bindingGen: 1 }]);
  const env = { PATH: process.env.PATH, HOME: join(directory, "home"), PI_CODING_AGENT_DIR: agent, PI_SCHEDULER_BINARY: binary,
    TMPDIR: tmpdir(), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  let daemonStderr = "";
  const spawnDaemon = () => {
    const child = spawn(process.execPath, [join(pkg, "dist/daemon.js")], { env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", data => daemonStderr += data);
    return child;
  };
  let daemon = spawnDaemon();
  const daemonReady = async () => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && daemon.exitCode === null && daemon.signalCode === null) {
      try {
        const reply = await request({ type: "ping" }, { socketPath: paths.socket, timeoutMs: Math.max(1, Math.min(250, deadline - Date.now())) });
        if (reply.ok) return true;
      } catch { /* the process may not have opened its socket yet */ }
      await delay(30);
    }
    return false;
  };
  let host;
  const rows = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const snapshot = () => { try { return JSON.parse(readFileSync(join(agent, "mailbox/v1", f.snapshot.session.id, "pending.json"), "utf8")); } catch (error) { if (error.code === "ENOENT") return { pending: [], terminal: [] }; throw error; } };
  const until = async (predicate, label) => { const end = Date.now() + 12000; while (!predicate()) { if (Date.now() > end || host?.child.exitCode !== null && host?.child.exitCode !== undefined) throw Error(`timeout ${label}; ${host?.stderr}\n${host?.stdout?.slice(-3000)}\n${JSON.stringify(rows().slice(-8))}`); await delay(15); } };
  const start = async (phase = 1, sessionFile = file) => {
    const configPath = join(directory, `config-${phase}.json`);
    writeFileSync(configPath, JSON.stringify({ scenario, phase, directory, log, full, socket: paths.socket, driverPid: process.pid,
      parentFile: file, parentSessionId: f.snapshot.session.id, otherFile }));
    const child = spawn(binary, ["--mode", "rpc", "--offline", "--approve", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "--session", sessionFile,
      "-e", bundle, "--provider", "scheduler-joint", "--model", "faux", "--thinking", "off"], { cwd, env: { ...env, SCHEDULER_JOINT_CONFIG: configPath }, stdio: ["pipe", "pipe", "pipe"] });
    const instance = { child, stdout: "", stderr: "", phase, id: 0 };
    child.stdout.on("data", d => instance.stdout += d); child.stderr.on("data", d => instance.stderr += d);
    instance.closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    host = instance;
    await until(() => rows().some(r => r.phase === phase && r.stage === "ready"), "host ready");
  };
  const stop = async (kill = false) => {
    if (!host) return;
    const current = host;
    if (kill) current.child.kill("SIGKILL"); else current.child.stdin.end();
    await Promise.race([current.closed, delay(5000).then(() => { current.child.kill("SIGKILL"); })]);
    writeFileSync(join(directory, `rpc-${current.phase}.jsonl`), current.stdout);
    writeFileSync(join(directory, `stderr-${current.phase}.log`), current.stderr);
    host = undefined;
  };
  const send = message => host.child.stdin.write(JSON.stringify({ id: String(++host.id), type: "prompt", message }) + "\n");
  const signal = name => writeFileSync(join(directory, name), "go");
  const requests = phase => rows().filter(r => r.stage === "request" && (phase === undefined || r.phase === phase));
  const settled = () => rows().some(r => r.stage === "settled");
  const done = () => store.listRuns(f.taskId).some(r => r.detail === "mailbox-fulfilled" || r.detail?.startsWith("mailbox-cancelled:")) && snapshot()?.terminal.length === 0;
  const result = { scenario };
  try {
    assert.ok(await daemonReady(), `daemon ready: ${daemonStderr}`);
    await start(1, forkFile || file);
    if (recovery) {
      if (scenario === "reopen" || scenario === "fork-parent") {
        await until(() => rows().some(r => r.stage === "terminal-commit"), "original terminal ACK debt");
        assert.equal(snapshot().terminal[0].terminalAck, "pending");
        send(scenario === "reopen" ? "/joint-away" : "/joint-fork");
        await until(() => rows().some(r => r.stage === "switched" && r.sessionId !== f.snapshot.session.id), "real away/fork");
        assert.equal(requests().length, 0); assert.equal(snapshot().terminal[0].terminalAck, "pending");
        signal("allow-reopen");
        send("/joint-back");
        await until(() => rows().filter(r => r.stage === "ready" && r.sessionId === f.snapshot.session.id).length === 2, "same process parent reopened");
        const bindings = rows().filter(r => r.stage === "ready" && r.sessionId === f.snapshot.session.id).map(r => r.target);
        assert.equal(bindings[1].bindingGeneration, bindings[0].bindingGeneration + 1);
      } else if (scenario === "source-disabled") {
        await delay(150); assert.equal(snapshot().terminal[0]?.terminalAck, "pending"); assert.equal(store.getInjectionReceipt(f.injectionId), undefined); await stop(); await start(2);
      } else if (scenario === "ack-lost" || scenario === "ack-snapshot-lost") {
        await until(() => rows().some(r => r.stage === (scenario === "ack-lost" ? "terminal-commit" : "terminal-wait")), "source commit");
        if (scenario === "ack-snapshot-lost") { const path = join(agent, "mailbox/v1", f.snapshot.session.id); chmodSync(path, 0o500); signal("allow-terminal"); await until(() => rows().some(r => r.stage === "terminal-return"), "callback return"); await delay(150); }
        assert.equal(snapshot().terminal[0]?.terminalAck, "pending"); await stop(true);
        if (scenario === "ack-snapshot-lost") chmodSync(join(agent, "mailbox/v1", f.snapshot.session.id), 0o700);
        if (scenario === "ack-lost") {
          const exited = new Promise(resolve => daemon.once("exit", resolve)); daemon.kill("SIGKILL"); await exited;
          await waitForDaemonLockRelease(paths.lock);
          daemon = spawnDaemon();
          assert.ok(await daemonReady(), "fresh daemon after SIGKILL"); result.daemonRestarted = true;
        }
        await start(2);
      }
      await until(done, "terminal debt repaired");
      assert.equal(store.getInjectionReceipt(f.injectionId).evidence.terminalId, f.evidence.terminalId);
      assert.equal(requests().length, 0); assert.equal(rows().filter(r => r.stage === "native-send").length, 0);
      assert.equal(store.listRuns(f.taskId).length, 1);
    } else if (scenario === "proof-conflict") {
      send("/joint-conflict"); await until(() => rows().some(r => r.stage === "conflict-ready"), "two exact original carriers");
      await until(() => readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse).filter(e => e.type === "custom_message" && e.customType === "scheduler-injection-v1").length === 2, "both native appends persisted");
      send("/mailbox resume"); await delay(300);
      assert.equal(requests().length, 0); assert.equal(snapshot().pending.length, 1);
      assert.equal(store.listRuns(f.taskId).length, 0); assert.ok(store.getInjection(f.injectionId));
      assert.equal(rows().filter(r => r.stage === "native-send" && r.customType === "agent-mailbox-trigger-v1").length, 0);
    } else if (scenario === "full-live") {
      send("WARMUP"); await until(() => rows().some(r => r.stage === "settled" && r.calls === 1), "warm live session");
      const at = Date.now();
      const created = await request({ type: "task.create", task: { id: f.taskId, title: marker.title, prompt: marker.prompt,
        schedule: { kind: "once", at }, timeZone: "UTC", toleranceMs: 60000, status: "active", createdAt: at, origin: "user",
        target: { kind: "session", sessionId: f.snapshot.session.id, cwd, sessionDir: directory } } }, { socketPath: paths.socket });
      assert.equal(created.ok, true);
      // The extension offers on real session activity; the idle poll would take
      // up to 30s. Drive a real turn so its agent_settled pumps the offer.
      send("PUMP_AFTER_CREATE");
      await until(done, "live idle automatic delivery");
      assert.equal(requests().length, 3, "warmup + pump turn + delivered injection");
    } else if (scenario === "full-normal" || scenario === "full-batch" || scenario === "full-recovered-source") {
      await until(() => snapshot()?.pending.length === (scenario === "full-batch" ? 2 : 1), "durable cold pending"); await delay(100); assert.equal(requests().length, 0);
      send("/mailbox status");
      await until(() => host.stdout.includes(`${scenario === "full-batch" ? 2 : 1} pending; recovery held`), "visible cold pending status");
      assert.equal(requests().length, 0);
      send("/mailbox resume"); await until(done, "full delivery"); assert.equal(requests().length, 1);
      if (scenario === "full-batch") {
        await until(() => store.listRuns(`${f.taskId}-second`).length === 1, "second source record");
        assert.match(JSON.stringify(requests()[0].messages), /SCHEDULER_SECOND_BATCH_PROMPT/);
      }
    } else if (scenario === "owner-before" || scenario === "owner-after") {
      assert.deepEqual(rows().find(r => r.stage === "ready").mailboxCommands, ["mailbox"]);
      send("/joint-deliver"); await until(() => rows().some(r => r.stage === "delivery-done"), "put"); send("/mailbox resume"); await until(done, "peer owner delivery"); assert.equal(requests().length, 1);
    } else if (scenario === "stale") {
      send("/joint-deliver"); await until(() => rows().some(r => r.stage === "delivery-done"), "put"); send("/mailbox resume"); await until(done, "stale cancellation"); assert.equal(requests().length, 0);
    } else if (["recorded-lost", "error", "abort", "unknown-crash", "cancel-flight"].includes(scenario)) {
      send("/joint-deliver"); await until(() => rows().some(r => r.stage === "delivery-done"), "put"); send("/mailbox resume");
      if (scenario === "recorded-lost") {
        await until(() => snapshot()?.terminal.some(r => r.recorded?.ack === "pending"), "fulfilled recorded debt"); assert.equal(requests().length, 1); await stop(true); await start(2); await until(done, "recorded repair"); assert.equal(requests(2).length, 0);
      } else if (scenario === "unknown-crash") {
        await until(() => requests().length === 1, "request start"); await stop(true); await start(2); await delay(150); assert.equal(requests(2).length, 0); assert.equal(store.listRuns(f.taskId).length, 0); assert.ok(store.getInjection(f.injectionId));
      } else if (scenario === "abort") {
        await until(() => requests().length === 1, "request start"); host.child.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n"); signal("provider-release"); await until(done, "abort failure"); assert.equal(requests().length, 1);
      } else if (scenario === "cancel-flight") {
        await until(() => rows().some(r => r.stage === "recorded-commit"), "recorded callback"); signal("cancel-go"); await until(() => rows().some(r => r.stage === "cancel-durable"), "cancel while recorded in flight"); signal("recorded-release"); signal("provider-release"); await until(done, "cancel source ACK"); assert.equal(requests().length, 1);
      } else { await until(done, "error cancellation"); assert.equal(requests().length, 1); }
    } else if (scenario === "late") {
      send("USER"); await until(done, "beforeRun late ingress"); assert.equal(requests().length, 1);
    } else if (scenario === "legacy-recorded-lost") {
      send("/joint-deliver");
      await until(() => rows().some(r => r.stage === "recorded-commit") && snapshot()?.terminal.some(r => r.recorded?.ack === "pending"), "legacy recorded reply lost");
      const terminalId = snapshot().terminal[0].evidence.terminalId;
      await stop(true);
      const exited = new Promise(resolve => daemon.once("exit", resolve)); daemon.kill("SIGTERM"); await exited;
      assert.ok(store.getLegacyInjectionReceipt(f.injectionId).recorded);
      assert.equal(store.getLegacyInjectionReceipt(f.injectionId).evidence, undefined);
      assert.equal(schedulerRollbackInventory(paths.root)[0].phase, "legacy-recorded");
      const archive = join(directory, "must-not-archive-recorded-debt");
      assert.throws(() => normalizeSchedulerRollback({ root: paths.root, archiveDir: archive, abandonIds: [f.injectionId] }), /requires original terminal evidence/);
      assert.equal(existsSync(archive), false);
      writeFileSync(join(paths.root, "runs", `${f.taskId}.jsonl`), "");
      daemon = spawnDaemon();
      assert.ok(await daemonReady(), "fresh daemon after offline history retention");
      await start(2); await until(() => snapshot()?.terminal.length === 0, "legacy recorded/final ACK repaired after history pruning");
      assert.equal(store.getLegacyInjectionReceipt(f.injectionId).evidence.terminalId, terminalId);
      assert.equal(store.listRuns(f.taskId).length, 0); assert.equal(requests().length, 0);
    } else if (scenario === "legacy-fork-first" || scenario === "legacy-owner-missing") {
      const rejectedSession = forkId || f.snapshot.session.id;
      await delay(150);
      const rejectedFile = forkFile || file;
      const rejectedEntries = readFileSync(rejectedFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
      assert.equal(rejectedEntries.filter(e => e.type === "custom_message" && e.customType === "scheduler-injection-v1" && e.details.injection_id === f.injectionId).length, 1);
      assert.ok(rejectedEntries.some(e => e.id === "assistant-fixture" && e.message.stopReason === "stop"));
      assert.equal(rejectedEntries.filter(e => e.type === "custom" && e.customType === "agent-mailbox-delivery-v1").length, 0);
      const rejectedSnapshot = join(agent, "mailbox/v1", rejectedSession, "pending.json");
      if (existsSync(rejectedSnapshot)) assert.deepEqual(JSON.parse(readFileSync(rejectedSnapshot, "utf8")).terminal, []);
      const sourceRequest = body => request(body, { socketPath: paths.socket });
      assert.equal((await sourceRequest({ type: "injection.current", injectionId: f.injectionId, sessionId: rejectedSession })).ok, false);
      assert.equal((await sourceRequest({ type: "injection.handoff", injectionId: f.injectionId, sessionId: rejectedSession,
        anchorEntryId: f.mail.anchorEntryId, recordedToken: "must-not-claim", entryId: "native-injection-fixture" })).ok, false);
      assert.equal((await sourceRequest({ type: "injection.terminal", evidence: { ...f.evidence, scope: { ...f.evidence.scope, sessionId: rejectedSession } } })).ok, false);
      assert.equal(store.getLegacyInjectionReceipt(f.injectionId), undefined);
      assert.equal(requests().length, 0);
      if (scenario === "legacy-fork-first") {
        result.forkSessionId = forkId; result.originalSessionId = f.snapshot.session.id;
        await stop(); await start(2);
        await until(() => store.getLegacyInjectionReceipt(f.injectionId)?.evidence && snapshot()?.terminal.length === 0, "original parent imports after fork refusal");
        const originalReceipt = store.getLegacyInjectionReceipt(f.injectionId);
        assert.equal(originalReceipt.evidence.scope.sessionId, f.snapshot.session.id);
        const terminalId = originalReceipt.evidence.terminalId;
        await stop(); await start(3);
        assert.equal(store.getLegacyInjectionReceipt(f.injectionId).evidence.terminalId, terminalId);
        assert.deepEqual(store.getLegacyInjectionReceipt(f.injectionId), originalReceipt);
        assert.equal(store.listRuns(f.taskId).length, 1); result.terminalId = terminalId;
      }
      assert.equal(requests().length, 0); assert.equal(rows().filter(r => r.stage === "native-send").length, 0);
    } else if (scenario.startsWith("legacy-")) {
      if (scenario === "legacy-completed") { await until(() => !!store.getLegacyInjectionReceipt(f.injectionId) && snapshot()?.terminal.length === 0, "legacy import"); assert.equal(requests().length, 0); }
      else if (scenario === "legacy-unhandled") { await until(() => snapshot()?.pending.length === 1, "legacy wake accepted"); send("/mailbox resume"); await until(done, "legacy wake"); assert.equal(requests().length, 1); }
      else {
        await delay(300); assert.equal(requests().length, 0); assert.equal(snapshot()?.pending.length || 0, 0);
        assert.equal(store.getLegacyInjectionReceipt(f.injectionId), undefined);
        const disk = readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
        assert.equal(disk.filter(e => e.type === "custom" && e.customType === "agent-mailbox-delivery-v1").length, 0);
        if (scenario === "legacy-missing") { assert.equal(store.getInjection(f.injectionId).mailbox, undefined); assert.equal(store.getInjection(f.injectionId).phase, "append-uncertain"); }
      }
    } else if (scenario === "tree-accepted") {
      send("/joint-origin"); await until(() => rows().some(r => r.stage === "navigate" && r.leaf === "origin-fixture"), "origin");
      send("/joint-ingress-tree"); await until(() => rows().some(r => r.stage === "navigate" && r.leaf === "sibling-fixture"), "navigation waited for registered ingress");
      const completions = rows().find(r => r.stage === "ready").entryCompletions;
      assert.ok(completions.empty.length > 0 && completions.partial.length > 0); assert.equal(completions.unknown, null);
      const pending = snapshot().pending[0];
      assert.equal(pending.key, f.mail.key); assert.equal(pending.anchorEntryId, "origin-fixture");
      assert.ok(pending.branchEntryId && !rows().find(r => r.stage === "navigate" && r.leaf === "sibling-fixture").branchIds.includes(pending.branchEntryId));
      send("/joint-deliver"); await until(() => rows().some(r => r.stage === "put-result" && r.result.kind === "held"), "no sibling retarget");
      send("/mailbox resume"); await delay(150); assert.equal(requests().length, 0);
      send(`/joint-entry ${pending.branchEntryId}`); await until(done, "old accepted origin restored"); assert.equal(requests().length, 1);
    } else if (scenario === "tree") {
      send("/joint-origin"); await until(() => rows().some(r => r.stage === "navigate" && r.leaf === "origin-fixture"), "origin");
      send("/joint-stage"); await until(() => rows().some(r => r.stage === "source-prepared"), "async prepared");
      send("/joint-sibling"); await until(() => rows().some(r => r.stage === "navigate" && r.leaf === "sibling-fixture"), "sibling");
      signal("put-release"); await until(() => rows().some(r => r.stage === "put-error" && r.code === "stale-binding"), "old target rejected");
      send("/joint-deliver"); await until(() => rows().some(r => r.stage === "put-result" && r.result.kind === "held"), "sibling held");
      assert.equal(snapshot()?.pending.length || 0, 0); assert.equal(requests().length, 0); assert.equal(store.getInjection(f.injectionId).mailbox.anchorEntryId, "origin-fixture");
      const trees = rows().filter(r => r.stage === "navigate"); assert.equal(trees[1].target.bindingGeneration, trees[0].target.bindingGeneration + 1);
      send("/joint-origin"); await until(() => rows().filter(r => r.stage === "navigate" && r.leaf === "origin-fixture").length === 2, "restore original scope");
      send("/joint-deliver"); await until(() => rows().some(r => r.stage === "put-result" && r.result.kind === "accepted"), "same intent accepted"); send("/mailbox resume"); await until(done, "origin delivery"); assert.equal(requests().length, 1);
    }
    if (["stale", "error", "abort", "cancel-flight"].includes(scenario)) {
      const reason = scenario === "stale" ? "injection-stale" : scenario === "cancel-flight" ? "joint-business-cancel" : `run-${scenario === "abort" ? "aborted" : "error"}`;
      assert.equal(store.listRuns(f.taskId)[0]?.detail, `mailbox-cancelled:${reason}`);
    }
    if (scenario === "unknown-crash") { assert.equal(store.getInjection(f.injectionId).mailbox.failureReason, undefined); assert.equal(snapshot().pending.length, 1); }
    if (scenario === "late") {
      assert.ok(rows().some(r => r.stage === "before-run" && r.members.length === 0));
      assert.ok(rows().some(r => r.stage === "after-run" && r.members.includes(f.mail.key)));
      await delay(150);
      assert.equal(rows().filter(r => r.stage === "native-send" && r.customType === "agent-mailbox-trigger-v1").length, 0);
    }
    if (settled()) await delay(70);
    result.providerCalls = requests().length;
    result.requestsByPhase = [requests(1).length, requests(2).length];
    const finalEntries = readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    result.nativeBodies = finalEntries.filter(e => e.type === "custom_message" && e.customType === "scheduler-injection-v1").length;
    result.sourceRecords = store.listRuns(f.taskId).length;
    result.passed = true;
  } catch (error) { result.passed = false; result.error = String(error); }
  await stop();
  if (scenario === "ack-snapshot-lost" && existsSync(join(agent, "mailbox/v1", f.snapshot.session.id))) chmodSync(join(agent, "mailbox/v1", f.snapshot.session.id), 0o700);
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise(resolve => daemon.once("exit", resolve)); daemon.kill("SIGTERM"); await exited;
  }
  writeFileSync(join(directory, "daemon-stderr.log"), daemonStderr);
  results.push(result); console.log(JSON.stringify(result));
}
writeFileSync(join(artifact, "summary.json"), JSON.stringify({ binary, version, realRequests: 0, artifact,
  extensionSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"), results }, null, 2));
console.log(`Artifacts: ${artifact}`); process.exitCode = results.every(r => r.passed) ? 0 : 1;
