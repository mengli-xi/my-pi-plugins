import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedCarrierFixture } from "../fixtures/shared-carrier.ts";

const root = dirname(fileURLToPath(import.meta.url));
const binary = process.env.MAILBOX_PI_BINARY ?? join(process.env.HOME, "bin", "pi-binary");
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), "1.5.0");
const artifact = process.env.MAILBOX_CANCEL_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "mailbox-cancel-"));
const bundle = join(artifact, "bundles"); mkdirSync(bundle, { recursive: true });
execFileSync("bun", ["build", join(root, "cancel-projection.ts"), "--target=node", "--format=esm", "--splitting", "--external=@earendil-works/*", `--outdir=${bundle}`], { stdio: "pipe" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonl = path => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const results = [];
const cases = [
  { scenario: "snapshot-restart", receiptOnly: false }, { scenario: "receipt-only-restart", receiptOnly: true },
  { scenario: "shared-generic", format: "generic", fulfilledIndex: 0, receiptOnly: true },
  ...["main", "child"].flatMap(format => [0, 1].map(fulfilledIndex => ({ scenario: `shared-${format}-${fulfilledIndex === 0 ? "card" : "outbox"}-fulfilled`, format, fulfilledIndex, receiptOnly: true }))),
  { scenario: "shared-all-cancelled", format: "main", fulfilledIndex: 0, allCancelled: true, receiptOnly: true },
];
for (const { scenario, receiptOnly, format, fulfilledIndex = 0, allCancelled = false } of cases) {
  const directory = join(artifact, scenario), shared = format ? sharedCarrierFixture(format) : undefined;
  const firstKey = shared?.keys[fulfilledIndex] ?? "fulfilled", secondKey = shared?.keys[1 - fulfilledIndex] ?? "cancelled";
  const discardedText = shared?.messages[0].content ?? "RELOAD_GATE_INPUT", retainedText = shared?.messages[0].content ?? "FULFILLED_HISTORY";
  const visible = !!shared && !allCancelled;
  const countBody = messages => messages.filter(message => message.role === "user").flatMap(message => typeof message.content === "string" ? [message.content] : message.content.filter(part => part.type === "text").map(part => part.text)).filter(text => text === discardedText).length;
  for (const name of ["home", "agent", "cwd", "tmp"]) mkdirSync(join(directory, name), { recursive: true });
  writeFileSync(join(directory, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const run = (phase, file) => {
    const log = join(directory, `${phase}.jsonl`); writeFileSync(log, "");
    const child = spawn(binary, ["--mode", "rpc", "--offline", "--approve", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", ...(file ? ["--session", file] : []), "-e", join(bundle, "cancel-projection.js"), "--provider", "mailbox-faux", "--model", "fixture", "--thinking", "off"], {
      cwd: join(directory, "cwd"), env: { PATH: process.env.PATH, HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"), TMPDIR: join(directory, "tmp"), PI_OFFLINE: "1", PI_TELEMETRY: "0", MAILBOX_NATIVE_LOG: log, MAILBOX_CANCEL_RESTORED: file ? "1" : "0", ...(format ? { MAILBOX_CANCEL_FORMAT: format, MAILBOX_CANCEL_FULFILLED_INDEX: String(fulfilledIndex) } : {}) }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", id = 0;
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    return { child, closed, rows: () => jsonl(log), send: message => child.stdin.write(JSON.stringify({ id: String(++id), type: "prompt", message }) + "\n"),
      until: async predicate => { const end = Date.now() + 20000; while (!predicate()) { if (Date.now() > end || child.exitCode !== null || child.signalCode !== null) throw Error(`timeout ${scenario}/${phase}: ${stderr}\n${stdout.slice(-3000)}`); await delay(15); } },
      save: () => { writeFileSync(join(directory, `${phase}-rpc.jsonl`), stdout); writeFileSync(join(directory, `${phase}-stderr.log`), stderr); assert.ok(!stdout.includes('"type":"extension_error"'), stdout); },
    };
  };
  let live, restarted;
  const result = { scenario };
  try {
    live = run("live"); await live.until(() => live.rows().some(row => row.stage === "start"));
    const start = live.rows().find(row => row.stage === "start");
    assert.equal(start.engineLoaded, false); assert.equal(start.engineLoading, false);
    live.send("INITIAL"); await live.until(() => live.rows().some(row => row.stage === "settled" && row.calls === 1));
    const snapshotPath = join(directory, "agent", "mailbox", "v1", start.sessionId, "pending.json");
    const snapshot = () => existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) : { pending: [], terminal: [] };
    live.send("/canceltest-fulfilled"); await live.until(() => live.rows().some(row => row.stage === "recorded" && row.key === firstKey));
    assert.equal(live.rows().filter(row => row.stage === "request").length, 1, "append does not wake");
    if (allCancelled) {
      live.send("/canceltest-cancel"); await live.until(() => live.rows().some(row => row.stage === "cancelled" && row.evidence.key === firstKey) && snapshot()?.pending.length === 0 && snapshot()?.terminal.length === 0);
    } else {
      live.send("FULFILL"); await live.until(() => live.rows().some(row => row.stage === "settled" && row.calls === 2) && snapshot()?.pending.length === 0 && snapshot()?.terminal.length === 0);
    }
    const before = allCancelled ? 1 : 2;
    live.send("/canceltest-cancelled"); await live.until(() => live.rows().some(row => row.stage === "recorded" && row.key === secondKey));
    assert.equal(live.rows().filter(row => row.stage === "request").length, before, "second append does not wake");
    live.send("/canceltest-cancel"); await live.until(() => live.rows().some(row => row.stage === "cancelled" && row.evidence.key === secondKey) && snapshot()?.pending.length === 0 && snapshot()?.terminal.length === 0);
    const session = jsonl(start.file), body = session.filter(entry => entry.type === "custom_message" && entry.content === discardedText);
    assert.equal(body.length, 1); assert.ok(session.some(entry => entry.type === "custom" && entry.customType === "agent-mailbox-delivery-v1" && entry.data.terminals.some(item => item.evidence.outcome === "cancelled")));
    live.send("AFTER_CANCEL"); await live.until(() => live.rows().some(row => row.stage === "settled" && row.calls === before + 1));
    const request = live.rows().filter(row => row.stage === "request").at(-1);
    assert.equal(countBody(request.messages), visible ? 1 : 0);
    if (!allCancelled) assert.ok(JSON.stringify(request.messages).includes(retainedText));
    live.child.kill("SIGKILL"); assert.equal((await live.closed).signal, "SIGKILL"); live.save();
    assert.equal(existsSync(dirname(snapshotPath)), false, "GC removes the empty snapshot directory");
    if (receiptOnly) rmSync(snapshotPath, { force: true }); // Receipt-only recovery is now the normal cleanup result.
    restarted = run("restarted", start.file); await restarted.until(() => restarted.rows().some(row => row.stage === "start"));
    if (receiptOnly) assert.equal(restarted.rows().find(row => row.stage === "start").engineLoaded, false, "receipt projection stays lazy until a request");
    restarted.send("AFTER_SIGKILL"); await restarted.until(() => restarted.rows().some(row => row.stage === "settled" && row.calls === 1));
    const recovered = restarted.rows().find(row => row.stage === "request");
    assert.equal(countBody(recovered.messages), visible ? 1 : 0);
    if (!allCancelled) assert.ok(JSON.stringify(recovered.messages).includes(retainedText));
    assert.equal(restarted.rows().filter(row => row.stage === "request").length, 1);
    restarted.child.stdin.end(); const exit = await restarted.closed; assert.equal(exit.code, 0); restarted.save();
    Object.assign(result, { passed: true, liveRequests: before + 1, recoveredRequests: 1, sharedCarrier: !!shared, projectedBodyCount: visible ? 1 : 0, allCancelled, sourceDisabledOnRestart: true });
  } catch (error) {
    Object.assign(result, { passed: false, error: String(error) });
  } finally {
    for (const process of [live, restarted]) if (process) {
      if (process.child.exitCode === null && process.child.signalCode === null) { process.child.kill("SIGKILL"); await process.closed; }
      process.save();
    }
  }
  results.push(result); console.log(JSON.stringify(result));
}
writeFileSync(join(artifact, "summary.json"), JSON.stringify({ version: "1.5.0", realRequests: 0, results }, null, 2));
console.log(`Artifacts: ${artifact}`); process.exitCode = results.every(result => result.passed) ? 0 : 1;
