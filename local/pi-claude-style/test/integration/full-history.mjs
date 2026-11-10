import { piBin } from "../../../../scripts/pi-checks.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const binary = piBin();
const root = mkdtempSync(join(tmpdir(), "cc-history-test-"));
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cols = Number(process.env.CC_FULL_HISTORY_COLS ?? 120);
const inputs = process.env.CC_FULL_HISTORY_INPUTS === "1";
const unload = process.env.CC_FULL_HISTORY_UNLOAD === "1";
const session = join(root, "home/agent/sessions/history.jsonl");
for (const dir of ["home/agent/sessions", "work"]) mkdirSync(join(root, dir), { recursive: true });
const rows = [{ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-10-19T00:00:00.000Z", cwd: join(root, "work") }];
let parentId = null;
const append = data => { const id = `entry-${rows.length}`; rows.push({ id, parentId, timestamp: "2026-10-19T00:00:00.000Z", ...data }); parentId = id; };
for (let index = 0; index < (inputs ? 150 : unload ? 1400 : 520); index++) {
  append({ type: "message", message: { role: "user", content: inputs ? `  HISTORY_USER_${index}  ` : `HISTORY_USER_${index}`, timestamp: index * 2 } });
  for (let response = 0; response < (inputs ? 10 : 1); response++) {
  append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `HISTORY_ANSWER_${index}` }], api: "history-test-api", provider: "history-test", model: "offline", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: index * 2 + 1 } });
  }
  if (!inputs && (unload ? [50, 700, 1100].includes(index) : [50, 360].includes(index))) append({ type: "compaction", summary: `SUMMARY_AT_${index}`, firstKeptEntryId: index === 50 ? "entry-41" : rows.find(entry => entry.message?.content === `HISTORY_USER_${unload ? 680 : 340}`).id, tokensBefore: unload ? 10000 + index : 10000 });
}
writeFileSync(session, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
writeFileSync(join(root, "home/agent/settings.json"), JSON.stringify({ quietStartup: true, terminal: { showImages: false }, compaction: { enabled: false, keepRecentTokens: 1000 } }));
const result = join(root, "events.jsonl");
const term = new xterm.Terminal({ cols, rows: 40, allowProposedApi: true });
const child = Bun.spawn({ cmd: [binary, "--offline", "--session", session, "--approve", "--no-extensions", "--no-skills", "--no-context-files", "--no-themes", "--no-prompt-templates", "--tui-mode", "fullscreen", "--provider", "history-test", "--model", "offline", "--api-key", "offline", "--extension", join(packageRoot, "dist/index.ts"), "--extension", join(packageRoot, "test/integration/full-history-extension.mts")],
  cwd: join(root, "work"), env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/.config"), PI_CODING_AGENT_DIR: join(root, "home/agent"), PI_OFFLINE: "1", TERM: "xterm-256color", CC_FULL_HISTORY_RESULT: result, CC_FULL_HISTORY_SESSION: session },
  stdin: "ignore", stderr: "pipe", terminal: { cols, rows: 40, data(_pty, data) { term.write(data); } } });
const stderr = new Response(child.stderr).text();
const delay = ms => new Promise(done => setTimeout(done, ms));
const events = () => existsSync(result) ? readFileSync(result, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const screen = () => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n");
const send = data => child.terminal.write(data);
async function wait(label, previous = 0, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const matching = events().filter(row => row.label === label);
    if (matching.length > previous) return matching.at(-1);
    if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}: ${await stderr}\n${screen()}`);
    await delay(30);
  }
  throw new Error(`timeout ${label}\n${JSON.stringify(events().map(({label, reason, live}) => ({label, reason, live})))}\n${screen()}`);
}
try {
  const initial = await wait("ready");
  if (inputs) {
    assert.equal(initial.users, 19, JSON.stringify(initial));
    const expected = Array.from({ length: 100 }, (_, i) => `HISTORY_USER_${149 - i}`);
    assert.deepEqual(initial.inputHistory, expected);
    let count = 0, top;
    do { send("\x1bt"); top = await wait("top", count++); } while (top.hidden > 0 && count < 20);
    assert.equal(top.users, 150); assert.equal(top.unique, 150);
    assert.deepEqual(top.inputHistory, expected);
    send("/fixture-redraw\r"); const redraw = await wait("redraw"); assert.equal(redraw.users, 19);
    send("\x1bf"); const fallback = await wait("runtime-fallback");
    assert.equal(fallback.hidden, 0); assert.equal(fallback.users, 150); assert.equal(fallback.unique, 150);
    assert.deepEqual(fallback.inputHistory, redraw.inputHistory);
    assert.ok(fallback.health.some(row => row.id === "history.renderEntries" && row.state === "broken"));
    if (process.env.CC_FULL_HISTORY_ARTIFACTS) writeFileSync(join(process.env.CC_FULL_HISTORY_ARTIFACTS, `history-inputs-${cols}.json`), JSON.stringify(events(), null, 2));
    console.log(JSON.stringify({ ok: true, scenarios: ["independent-input-history", "input-history-after-prepend", "live-native-fallback"], events: events() }, null, 2));
  } else if (unload) {
    const seen = new Set(initial.userIds);
    let count = 0, top;
    do {
      send("\x1bt"); top = await wait("top", count++);
      for (const id of top.userIds) seen.add(id);
    } while (top.hidden > 0 && count < 30);
    assert.equal(top.hidden, 0); assert.equal(seen.size, 1400);
    assert.ok(top.anchors > 0 && top.users < 1400, JSON.stringify(top));
    for (const row of events().filter(event => event.label === "top")) {
      assert.equal(row.chronological, true); assert.equal(row.users, row.unique);
      if (row.boundary) assert.equal(row.boundaryBeforeKept, true);
    }
    send("\x1bt"); top = await wait("top", count++);
    send("\x1be"); const expanded = await wait("expanded"); assert.equal(expanded.firstSummaryExpanded, true);
    send("\x1bb"); const bottom = await wait("bottom"); assert.equal(bottom.last, 1399);
    send("\x1bg"); const gap = await wait("gap"); assert.equal(gap.firstSummaryResident, false, JSON.stringify(gap));
    send("\x1bt"); const restored = await wait("top", count++);
    assert.equal(restored.firstSummaryExpanded, true, JSON.stringify(restored));
    send("\x1bp"); await wait("prepared");
    send("\x1b[<0;8;10M"); send("\x1b[<32;30;12M"); send("\x1b[<0;30;12m");
    await delay(100); send("\x1bs"); const selected = await wait("snapshot"); assert.ok(selected.selection);
    send("\x1bg"); const protectedGap = await wait("gap", 1);
    assert.equal(protectedGap.selection, selected.selection);
    assert.equal(protectedGap.firstSummaryResident, true);
    send("/fixture-boundary\r"); const compacted = await wait("boundary-event");
    assert.ok(compacted.anchors > 0 && compacted.users < 1400, "compaction must not hydrate every unloaded batch");
    assert.equal(compacted.selection, selected.selection);
    if (process.env.CC_FULL_HISTORY_ARTIFACTS) writeFileSync(join(process.env.CC_FULL_HISTORY_ARTIFACTS, `history-unload-${cols}.json`), JSON.stringify(events(), null, 2));
    console.log(JSON.stringify({ ok: true, scenarios: ["distance-eviction", "bidirectional-reload", "height-anchors", "fold-restoration", "selection-protection", "multiple-compactions"], events: events() }, null, 2));
  } else {
  assert.ok(initial.hidden > 700 && initial.users <= 110, JSON.stringify(initial));
  assert.deepEqual(initial.inputHistory, Array.from({ length: 100 }, (_, i) => `HISTORY_USER_${519 - i}`));
  send("\x1bp"); await wait("prepared");
  send("\x1b[<0;8;10M"); send("\x1b[<32;30;12M"); send("\x1b[<0;30;12m");
  await delay(100);
  send("\x1bl");
  const prepend = await wait("prepend");
  assert.equal(prepend.hadSelection, true, JSON.stringify(prepend));
  for (const key of ["sameSelection", "sameViewport", "identitiesKept", "shifted"]) assert.equal(prepend[key], true, JSON.stringify(prepend));
  let count = 0, top;
  do { send("\x1bt"); top = await wait("top", count++); } while (top.hidden > 0 && count < 10);
  assert.equal(top.users, 520, JSON.stringify(top)); assert.equal(top.unique, 520); assert.equal(top.chronological, true);
  assert.equal(top.compactions, 2); assert.equal(top.boundaryBeforeKept, true);
  send("/compact\r");
  await delay(2000); send("\x1bs");
  const compact = await wait("snapshot");
  assert.equal(compact.users, 520, JSON.stringify(compact));
  assert.equal(compact.compactions, 3, JSON.stringify(compact));
  assert.equal(compact.unique, 520);
  send("/fixture-boundary\r");
  const boundary = await wait("boundary-event");
  assert.equal(boundary.compactions, 4); assert.equal(boundary.unique, 520);
  send("/reload\r"); const reloaded = await wait("ready", 1);
  assert.ok(reloaded.hidden > 700, JSON.stringify(reloaded)); assert.ok(reloaded.users <= 110, JSON.stringify(reloaded));
  assert.deepEqual(reloaded.inputHistory, Array.from({ length: 100 }, (_, i) => `HISTORY_USER_${519 - i}`));
  send("/fixture-redraw\r"); const redraw = await wait("redraw"); assert.equal(redraw.users, reloaded.users);
  send("/fixture-tree\r"); const tree = await wait("tree"); assert.equal(tree.last, 249); assert.equal(tree.chronological, true);
  send("/fixture-fork\r"); const fork = await wait("ready", 2); assert.equal(fork.last, 199);
  assert.deepEqual(fork.inputHistory, Array.from({ length: 100 }, (_, i) => `HISTORY_USER_${199 - i}`));
  send("/fixture-new\r"); const fresh = await wait("ready", 3); assert.equal(fresh.users, 0);
  send("/fixture-resume\r"); const resumed = await wait("ready", 4); assert.ok(resumed.users > 0);
  assert.equal(resumed.inputHistory.length, 100);
  send("/internals\r"); await delay(600);
  const entries = readFileSync(session, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const internals = entries.filter(entry => entry.type === "custom_message" && entry.customType === "internals").at(-1);
  assert.ok(internals, "fresh /internals result was persisted");
  const report = JSON.stringify(internals);
  assert.ok(!report.includes("缺失") && !report.includes("调用失败"), report);
  if (process.env.CC_FULL_HISTORY_ARTIFACTS) {
    mkdirSync(process.env.CC_FULL_HISTORY_ARTIFACTS, { recursive: true });
    writeFileSync(join(process.env.CC_FULL_HISTORY_ARTIFACTS, `internals-${cols}.json`), JSON.stringify(internals, null, 2));
    writeFileSync(join(process.env.CC_FULL_HISTORY_ARTIFACTS, `history-${cols}.json`), JSON.stringify(events(), null, 2));
  }
  console.log(JSON.stringify({ ok: true, scenarios: ["recent-tail", "prepend-selection-viewport", "all-history", "manual-compaction", "boundary-compaction", "reload", "settings-rebuild", "tree", "fork", "new", "resume", "internals"], events: events() }, null, 2));
  }
} finally {
  if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  child.terminal?.close(); term.dispose(); rmSync(root, { recursive: true, force: true });
}
if (!inputs && !unload) {
  for (const variant of ["inputs", "unload"]) {
    const followup = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
      env: { ...process.env, CC_FULL_HISTORY_INPUTS: variant === "inputs" ? "1" : "0", CC_FULL_HISTORY_UNLOAD: variant === "unload" ? "1" : "0" }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    assert.equal(await followup.exited, 0, `${variant} host regression`);
  }
}
