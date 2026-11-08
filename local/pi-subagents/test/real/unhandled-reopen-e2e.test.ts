import { prepareFreshProfile, piBinary } from "../fixtures/fresh-profile.js";
// SUB-PENDING-STATE-003 regression: owner-level turn settlement (DELIVERY_PROTOCOL §7.9) under a real
// stock Pi 1.5.0 RPC Main with the deterministic faux provider.
//   abort line   - Main spawns one Subagent; the completion card and the producer continuation land and
//                  the Outbox terminalizes as delivered, but the continuation-driven Main run is aborted
//                  before the model answers. A second host must reopen the session with the Outbox turn
//                  still `pending` (zero model requests at open), the next ordinary prompt handles the
//                  recorded card exactly once and settles it, and a third host reopens it `settled`.
//   control line - the continuation-driven run answers normally, so the turn is already `settled` when
//                  the first host exits and a reopen shows nothing pending.
// Both lines keep one card, one continuation, one Task, one wake receipt: nothing is re-run or re-appended.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pi = piBinary;
const cwd = await realpath(process.cwd());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };
async function waitFor(check: () => Promise<boolean>, label: string, ms: number): Promise<void> { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await sleep(25); } }

interface Line { readonly root: string; readonly home: string; readonly agentDir: string; readonly session: string; readonly gate: string; readonly streams: string; readonly dump: string }
interface Host { readonly rpc: (id: string, type: string, extra?: Record<string, unknown>) => Promise<any>; readonly entries: (tag: string) => Promise<any[]>; readonly snapshot: (tag: string) => Promise<any>; readonly exit: () => Promise<{ code: number | null; signal: string | null }>; readonly kill: () => Promise<void>; readonly stderr: () => string }

async function prepareLine(t: test.TestContext, prefix: string): Promise<Line> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `pi-subagents-${prefix}-`)));
  const home = join(root, "home");
  await mkdir(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const session = join(home, "main.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: `unhandled-${prefix}`, timestamp: new Date().toISOString(), cwd })}\n`, { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = await prepareFreshProfile(home);
  return { root, home, agentDir, session, gate: join(root, "gate.json"), streams: join(root, "streams.jsonl"), dump: join(root, "snapshot.json") };
}

/** `mode` is the faux gate for this host only: `abort` parks the first card-carrying request until RPC abort; `answer` answers it. */
async function startHost(t: test.TestContext, line: Line, mode: "abort" | "answer", fault?: string): Promise<Host> {
  const child = spawn(pi, ["--mode", "rpc", "--session", line.session, "--no-extensions", "-e", join(cwd, "dist", "index.js"), "-e", join(cwd, "test", "fixtures", "faux-subagent-provider.ts"), "-e", join(cwd, "test", "fixtures", "host-snapshot-dump.ts"), "-e", join(cwd, "test", "fixtures", "main-turn-commit-crash.ts"), "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "fixture", "--model", "faux-1", "--thinking", "off"], {
    cwd,
    env: { ...process.env, HOME: line.home, PI_CODING_AGENT_DIR: line.agentDir, TMPDIR: line.root, PI_SUBAGENTS_SNAPSHOT_DUMP: line.dump, UNHANDLED_GATE_FILE: line.gate, UNHANDLED_GATE_MODE: mode, UNHANDLED_STREAM_LOG: line.streams, PI_MAIN_TURN_COMMIT_FAULT: fault ?? "", PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const records: any[] = []; const stderr: Buffer[] = []; let buffer = "";
  child.stdout.on("data", (chunk) => { buffer += chunk; for (let at; (at = buffer.indexOf("\n")) >= 0;) { const text = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (text) { try { records.push(JSON.parse(text)); } catch {} } } });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const rpc = async (id: string, type: string, extra: Record<string, unknown> = {}) => {
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) { const hit = records.find((record) => record.id === id && record.type === "response"); if (hit) return hit; await sleep(15); }
    throw new Error(`timeout ${id}: ${Buffer.concat(stderr)}`);
  };
  let sequence = 0;
  const entries = async (tag: string) => (await rpc(`entries-${tag}-${sequence++}`, "get_entries")).data.entries as any[];
  const snapshot = async (tag: string) => { await rm(line.dump, { force: true }); await rpc(`dump-${tag}-${sequence++}`, "prompt", { message: "/subagents-snapshot-dump" }); await waitFor(() => exists(line.dump), "snapshot dump", 10_000); return JSON.parse(await readFile(line.dump, "utf8")).snapshot; };
  const exit = () => new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("host did not exit")); }, 20_000); child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); child.stdin.end(); });
  const kill = () => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return { rpc, entries, snapshot, exit, kill, stderr: () => Buffer.concat(stderr).toString("utf8") };
}

const cards = (entries: any[], customType: string) => entries.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
const assistants = (entries: any[]) => entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").map((entry) => ({ stop: entry.message.stopReason, text: (entry.message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join(" ") }));
const outboxes = (snapshot: any) => [snapshot.root, ...snapshot.agents].flatMap((partition: any) => partition.outbox) as any[];
const tasks = (snapshot: any) => snapshot.agents.flatMap((partition: any) => partition.tasks) as any[];
const receipts = (snapshot: any) => [snapshot.root, ...snapshot.agents].flatMap((partition: any) => partition.wake_receipts) as any[];
async function streams(line: Line): Promise<any[]> { return existsSync(line.streams) ? (await readFile(line.streams, "utf8")).trim().split("\n").filter(Boolean).map((text) => JSON.parse(text)) : []; }
/** The single delivered Outbox of the line, once its turn settlement reaches `state` (bounded wait). */
async function turnState(host: Host, tag: string, state: "pending" | "settled"): Promise<any> {
  let snapshot: any;
  await waitFor(async () => { snapshot = await host.snapshot(tag); const outbox = outboxes(snapshot); return outbox.length === 1 && outbox[0].state === "delivered" && outbox[0].turn_settlement?.state === state; }, `turn ${state} (${tag})`, 15_000);
  return snapshot;
}
function assertSingleCarrier(snapshot: any, entries: any[], label: string): void {
  assert.equal(cards(entries, "subagent-completion-v1").length, 1, `${label}: one card`);
  assert.equal(cards(entries, "subagent-continuation-v1").length, 1, `${label}: one continuation`);
  assert.equal(tasks(snapshot).length, 1, `${label}: one Task`);
  assert.equal(tasks(snapshot)[0].phase, "settled", `${label}: Task not re-run`);
  assert.equal(outboxes(snapshot).length, 1, `${label}: one Outbox`);
  assert.equal(receipts(snapshot).length, 1, `${label}: one wake receipt`);
}
const SPAWN = "UNHANDLED_MAIN: spawn one Subagent with spawn_agent. The child must reply exactly SUBAGENT_OK. Do not wait manually.";
const HANDLE = "UNHANDLED_MAIN: please handle whatever background results are already recorded in this session; do not spawn anything.";

test("a completion aborted before Main handled it reopens pending, is handled once by the next ordinary prompt, and reopens settled", { timeout: 240_000 }, async (t) => {
  const line = await prepareLine(t, "unhandled-abort");
  // host 1: deliver, then abort the continuation-driven run while it is gated inside the provider.
  const host1 = await startHost(t, line, "abort");
  void host1.rpc("prompt-1", "prompt", { message: SPAWN });
  await waitFor(async () => (await exists(line.gate)) && JSON.parse(await readFile(line.gate, "utf8")).entered === true, "continuation-driven request entered the abort-aware gate", 120_000);
  const gate = JSON.parse(await readFile(line.gate, "utf8"));
  assert.deepEqual({ cards: gate.cards, conts: gate.conts }, { cards: 1, conts: 1 }, "the gated request already carried the card and the continuation");
  await host1.rpc("abort-1", "abort");
  await waitFor(async () => JSON.parse(await readFile(line.gate, "utf8")).aborted === true, "gate released by abort", 30_000);
  await waitFor(async () => assistants(await host1.entries("aborted")).some((entry) => entry.stop === "aborted"), "aborted assistant entry persisted", 30_000);
  const exit1Snapshot = await turnState(host1, "host1-exit", "pending");
  assertSingleCarrier(exit1Snapshot, await host1.entries("host1-exit"), "host1 exit");
  assert.equal(outboxes(exit1Snapshot)[0].turn_settlement.wake_epoch, 1);
  assert.equal((await host1.entries("failed-run-proof")).some(entry => entry.type === "custom" && entry.customType === "subagent-main-run-completed-v1"), false, "aborted runs have no source success observation");
  assert.equal(outboxes(exit1Snapshot)[0].turn_settlement.continuation_identity, receipts(exit1Snapshot)[0].continuation_identity, "the pending turn is keyed by the settlement receipt's continuation");
  const streamsAtExit1 = (await streams(line)).length;
  assert.deepEqual(await host1.exit(), { code: 0, signal: null });

  // host 2: reopen. Nothing is re-sent, the turn is still pending, the ordinary prompt handles the card once.
  const host2 = await startHost(t, line, "answer");
  const openSnapshot = await turnState(host2, "host2-open", "pending");
  const openEntries = await host2.entries("host2-open");
  assertSingleCarrier(openSnapshot, openEntries, "host2 open");
  assert.equal((await streams(line)).length, streamsAtExit1, "reopening issues no model request");
  assert.equal(outboxes(openSnapshot)[0].turn_settlement.pending_at, outboxes(exit1Snapshot)[0].turn_settlement.pending_at, "the pending turn is the persisted one, not a fresh guess");
  await host2.rpc("prompt-2", "prompt", { message: HANDLE });
  await waitFor(async () => assistants(await host2.entries("handled")).some((entry) => entry.text.includes("MAIN_HANDLED_OK")), "ordinary prompt answered", 120_000);
  const afterSnapshot = await turnState(host2, "host2-after", "settled");
  const afterEntries = await host2.entries("host2-after");
  assertSingleCarrier(afterSnapshot, afterEntries, "host2 after");
  const mainStreams = await streams(line);
  assert.equal(mainStreams.length - streamsAtExit1, 1, "exactly one Main model request since reopening");
  assert.deepEqual({ cards: mainStreams.at(-1).cards, conts: mainStreams.at(-1).conts }, { cards: 1, conts: 1 }, "the ordinary prompt carried the recorded card exactly once");
  assert.equal(outboxes(afterSnapshot)[0].turn_settlement.pending_at, outboxes(exit1Snapshot)[0].turn_settlement.pending_at);
  assert.deepEqual(await host2.exit(), { code: 0, signal: null });

  // host 3: reopen again; the settled turn stays settled and nothing is pending or re-sent.
  const streamsAtExit2 = (await streams(line)).length;
  const host3 = await startHost(t, line, "answer");
  const finalSnapshot = await turnState(host3, "host3-open", "settled");
  assertSingleCarrier(finalSnapshot, await host3.entries("host3-open"), "host3 open");
  assert.equal((await streams(line)).length, streamsAtExit2, "the third host issues no model request either");
  assert.deepEqual(await host3.exit(), { code: 0, signal: null });
});

test("a completion handled by the continuation-driven run is already settled when the host exits and reopens settled", { timeout: 180_000 }, async (t) => {
  const line = await prepareLine(t, "unhandled-control");
  const host1 = await startHost(t, line, "answer");
  await host1.rpc("prompt-1", "prompt", { message: SPAWN });
  await waitFor(async () => assistants(await host1.entries("handled")).some((entry) => entry.text.includes("MAIN_HANDLED_OK")), "continuation-driven request answered", 120_000);
  const exitSnapshot = await turnState(host1, "host1-exit", "settled");
  assertSingleCarrier(exitSnapshot, await host1.entries("host1-exit"), "control host1 exit");
  const streamsAtExit = (await streams(line)).length;
  assert.deepEqual(await host1.exit(), { code: 0, signal: null });
  const host2 = await startHost(t, line, "answer");
  const openSnapshot = await turnState(host2, "host2-open", "settled");
  assertSingleCarrier(openSnapshot, await host2.entries("host2-open"), "control host2 open");
  assert.equal((await streams(line)).length, streamsAtExit, "reopening a settled turn issues no model request");
  assert.deepEqual(await host2.exit(), { code: 0, signal: null });
});

test("SIGKILL after successful Main observation but before source turn commit recovers the original debt with zero requests", { timeout: 180_000 }, async t => {
  const line = await prepareLine(t, "turn-commit-crash"), faultFile = join(line.root, "before-turn-commit.json");
  const host1 = await startHost(t, line, "answer", faultFile);
  await host1.rpc("prompt-fault", "prompt", { message: SPAWN });
  await waitFor(() => exists(faultFile), "real Host reached the source turn transaction", 120_000);
  const fault = JSON.parse(await readFile(faultFile, "utf8"));
  assert.equal(outboxes(fault.snapshot)[0].state, "delivered");
  assert.equal(outboxes(fault.snapshot)[0].turn_settlement.state, "pending");
  assertSingleCarrier(fault.snapshot, fault.branch, "before source commit");
  const cardEntryId = cards(fault.branch, "subagent-completion-v1")[0].id;
  assert.equal(fault.branch.filter((entry: any) => entry.type === "custom" && entry.customType === "subagent-main-run-completed-v1").length, 1);
  assert.ok(fault.branch.some((entry: any) => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1"
    && entry.data?.terminals?.some((terminal: any) => terminal.mail.producer === "pi-subagents" && terminal.evidence.outcome === "fulfilled"
      && terminal.evidence.nativeEntryIds.includes(cardEntryId))), "the original card already has A's fulfilled receipt");
  await host1.kill();
  const countBefore = (await streams(line)).length;
  const host2 = await startHost(t, line, "answer");
  const repaired = await turnState(host2, "repaired-debt", "settled");
  const repairedEntries = await host2.entries("repaired-debt");
  assertSingleCarrier(repaired, repairedEntries, "after reopen");
  assert.equal(outboxes(repaired)[0].outbox_id, fault.input.outboxId);
  assert.equal(outboxes(repaired)[0].turn_settlement.wake_epoch, fault.input.wakeEpoch);
  assert.equal(outboxes(repaired)[0].turn_settlement.continuation_identity, fault.input.continuationIdentity);
  assert.equal(outboxes(repaired)[0].turn_settlement.pending_at, outboxes(fault.snapshot)[0].turn_settlement.pending_at);
  assert.equal((await streams(line)).length, countBefore, "source commit recovery performs zero provider requests");
  assert.deepEqual(await host2.exit(), { code: 0, signal: null });
  const host3 = await startHost(t, line, "answer");
  await turnState(host3, "second-reopen", "settled");
  assert.equal((await streams(line)).length, countBefore, "a second reopen does not re-wake or repeat the run");
  assert.deepEqual(await host3.exit(), { code: 0, signal: null });
  const summary = { fault: "SIGKILL before settleOutboxTurn", before: "delivered/pending", after: "delivered/settled", reopenProviderRequests: (await streams(line)).length - countBefore,
    originalOutboxId: fault.input.outboxId, originalEpoch: fault.input.wakeEpoch, originalContinuation: fault.input.continuationIdentity };
  if (process.env.PI_MAILBOX_JOINT_EVIDENCE) {
    const directory = join(process.env.PI_MAILBOX_JOINT_EVIDENCE, "turn-commit-crash"); await mkdir(directory, { recursive: true });
    await Promise.all([writeFile(join(directory, "fault.json"), JSON.stringify(fault)), writeFile(join(directory, "repaired.json"), JSON.stringify(repaired)),
      writeFile(join(directory, "entries.json"), JSON.stringify(repairedEntries)), writeFile(join(directory, "provider.jsonl"), await readFile(line.streams)),
      writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2))]);
  }
  t.diagnostic(JSON.stringify(summary));
});
