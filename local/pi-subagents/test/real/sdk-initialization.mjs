import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import xterm from "@xterm/headless";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.argv[2] ?? process.env.PI_BINARY;
if (!binary) throw new Error("Usage: bun test/real/sdk-initialization.mjs /path/to/pi-next");
const root = process.env.PI_SDK_INITIALIZATION_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "pi-sdk-initialization-"));
mkdirSync(root, { recursive: true });
const agent = join(root, "agent"); mkdirSync(agent, { recursive: true });
const home = join(root, "home"); mkdirSync(join(home, ".config"), { recursive: true });

mkdirSync(join(agent, "pi-subagents"), { recursive: true, mode: 0o700 });
writeFileSync(join(agent, "pi-subagents/config.json"), JSON.stringify({ schemaVersion: 2 }));
const gate = join(root, "footer-ready");
writeFileSync(gate, "ready");
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const statusCommand = `cat >/dev/null; test -f ${shellQuote(gate)} && printf 'CC_COMMAND [[pi:slot:model]] [[pi:slot:effort]]\\ncache [[pi:slot:cache-quality]]\\n'`;
const themeFile = join(agent, "themes", "b3-theme.json"); mkdirSync(dirname(themeFile), { recursive: true });
const theme = JSON.parse(readFileSync(join(pkg, "../pi-claude-style/themes/cc-style-soft.json"), "utf8")); theme.name = "b3-theme";
writeFileSync(themeFile, JSON.stringify(theme));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"], quietStartup: true, theme: "b3-theme", tuiMode: "fullscreen", retry: { enabled: false },
  statusLine: { type: "command", command: statusCommand, debounceMs: 10 } }));
writeFileSync(join(root, "fixture.txt"), "Shared native CC fullscreen tool rendering\n");
writeFileSync(join(root, "main.jsonl"), JSON.stringify({ type: "session", version: 3, id: "b3-main", timestamp: new Date().toISOString(), cwd: root }) + "\n");
const term = new xterm.Terminal({ cols: 112, rows: 38, allowProposedApi: true, scrollback: 2000 });
let raw = "", serial = 0;
const chunks = [];
const child = Bun.spawn({ cmd: [binary, "--offline", "--session", join(root, "main.jsonl"), "--tui-mode", "fullscreen", "--no-extensions",
  "-e", join(pkg, "../pi-claude-style/dist/index.ts"), "-e", join(pkg, "test/fixtures/test-commands.ts"),
  "-e", join(pkg, "test/fixtures/sdk-view-main.mjs"), "--provider", "fixture", "--model", "faux-view", "--thinking", "off", "--approve"],
  cwd: root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PI_CODING_AGENT_DIR: agent, PI_NEXT_AGENT_DIR: agent, PI_OFFLINE: "1",
    PI_SDK_VIEW_ROOT: root, PI_SDK_VIEW_STATUSLINE: "1", PI_SUBAGENTS_TEST_MESSAGE: "TOOL_FIRST", PI_SUBAGENTS_TEST_TASK_NAME: "view_child", TERM: "xterm-256color" },
  stdin: "ignore", stderr: "pipe", terminal: { cols: 112, rows: 38, data(_pty, data) {
    const text = Buffer.from(data).toString();
    chunks.push({ at: Date.now(), data: text }); raw += text; term.write(data);
  } } });
const stderr = new Response(child.stderr).text();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let eventsVersion, cachedEvents = [];
const events = () => {
  const path = join(root, "events.jsonl");
  if (!existsSync(path)) return [];
  const stat = statSync(path), version = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (version !== eventsVersion) {
    cachedEvents = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    eventsVersion = version;
  }
  return cachedEvents;
};
const screen = () => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
const send = text => child.terminal.write(text);
async function wait(label, condition, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; if (child.exitCode !== null) throw new Error(`Exited ${child.exitCode}: ${label}`); await delay(25); }
  throw new Error(`Timeout ${label}\n${screen()}`);
}
async function control(op, params = {}) {
  const id = ++serial;
  appendFileSync(join(root, "commands.jsonl"), JSON.stringify({ id, op, ...params }) + "\n");
  await wait(`control ${op}`, () => events().some(event => event.event === "control" && event.id === id));
  const event = events().find(event => event.event === "control" && event.id === id);
  if (event.error) throw new Error(event.error + "\n" + event.stack);
  return event.result;
}
function shot(name) {
  writeFileSync(join(root, `${name}.txt`), screen());
  const cells = Array.from({ length: term.rows }, (_, row) => Array.from({ length: term.cols }, (_, column) => {
    const cell = term.buffer.active.getLine(term.buffer.active.viewportY + row)?.getCell(column);
    return cell ? { text: cell.getChars(), width: cell.getWidth(), fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode(), bold: cell.isBold() } : null;
  }));
  writeFileSync(join(root, `${name}.cells.json`), JSON.stringify(cells));
}
const views = [];
const boundaries = (view, kind) => events().filter(event => event.event === "view-boundary" && event.token === view.token && event.kind === kind);
async function startView(label) {
  const view = { token: String(views.length + 1), label }; views.push(view);
  await control("observe-view", { token: view.token });
  await control("open");
  await wait(`ManagedInteractive.open init-start for ${label}; missing actual child.view wrapper is an observation failure`, () => boundaries(view, "init-start").length === 1);
  return view;
}
async function ready(view) {
  await wait(`view ${view.label} completes its own onLoaded`, async () => {
    if (!boundaries(view, "ready").length) return false;
    const state = await control("snapshot");
    return state.viewObservation?.token === view.token && !state.viewObservation.closed && state.childMode === "tui" && screen().includes("Alt+/ Main");
  });
}
async function open() { const view = await startView("warm"); await ready(view); await delay(100); return view; }
async function back(key = "\x1b/") { send(key); await wait("Main restored", async () => ["print", "disposed"].includes((await control("snapshot")).childMode)); await delay(100); }
// A failed/blocked first command must not expose Pi's native footer. Restore
// the real command output after the first entry, then repeat warm handoffs.
const plain = value => value.replace(/\x1b\[[0-9;]*m/g, "");
const footer = (state, role) => state.footerHosts?.filter(host => host.role === role).at(-1);
const footerText = (state, role) => plain(footer(state, role)?.rows?.join("\n") ?? "");
const mainSegments = text => text.match(/(?:CP|MEM|CH):\S+/g);
const deadlineDiagnostics = state => state.diagnostics.filter(item => item.message.includes("initialization exceeded 2000 ms"));
const returned = token => events().some(event => event.event === "load-returned" && event.token === token);
async function auditViews() {
  const state = await control("snapshot");
  let deadlines = 0;
  for (const view of views) {
    const start = boundaries(view, "init-start"), expired = boundaries(view, "deadline"), loaded = boundaries(view, "ready"), closed = boundaries(view, "close");
    assert.equal(start.length, 1, `${view.label}: observe the real open entry exactly once`);
    assert.ok(expired.length <= 1, `${view.label}: at most one deadline per initialization`);
    assert.ok(loaded.length <= 1 && closed.length <= 1, `${view.label}: ready/close occur at most once`);
    if (view.expectedDeadlines !== undefined) assert.equal(expired.length, view.expectedDeadlines, `${view.label}: deadline count`);
    // A 2000 ms setTimeout request does not guarantee an exact wall-clock lower bound.
    // Record same-process monotonic timings; retain the original visible-frame >=1700 ms check below.
    if (expired.length) assert.ok(expired[0].monotonicAt >= start[0].monotonicAt, `${view.label}: deadline follows init-start`);
    if (expired.length && closed.length) assert.ok(expired[0].monotonicAt <= closed[0].monotonicAt, `${view.label}: no deadline after close`);
    if (loaded.length && closed.length) assert.ok(loaded[0].monotonicAt <= closed[0].monotonicAt, `${view.label}: abandoned callback cannot become ready`);
    deadlines += expired.length;
  }
  assert.equal(deadlineDiagnostics(state).length, deadlines, "every initialization diagnostic has an exact open token");
}
function assertEarly(view, elapsed, stage, expired = false) {
  assert.ok(elapsed >= 0 && elapsed < 2000 && !expired && boundaries(view, "deadline").length === 0,
    `early scenario not covered: ${stage} at ${elapsed} ms from init-start (deadline count ${boundaries(view, "deadline").length}, expired ${expired})`);
}
async function hold(token) {
  await control("hold-loaded", { token });
  const view = await startView(token);
  await wait("real markViewLoaded held", () => events().some(event => event.event === "load-held" && event.token === token));
  const held = events().find(event => event.event === "load-held" && event.token === token);
  assert.equal(held.viewToken, view.token, "held onLoaded retains its open async context");
  if (token === "early") assertEarly(view, held.monotonicAt - boundaries(view, "init-start")[0].monotonicAt, "onLoaded held");
  return view;
}
async function leave(token, view, heldEvent = "load-returned") {
  const armingAt = performance.now(), observation = await control("observe-return", { token });
  assert.equal(observation.viewToken, view.token);
  // The fixture measures init elapsed in its own process. Adding the entire control round trip
  // conservatively bounds elapsed at send without comparing performance origins across processes.
  const initElapsedUpperBoundMs = observation.initElapsedMs + performance.now() - armingAt;
  if (token === "early") assertEarly(view, initElapsedUpperBoundMs, "return key sent (upper bound)", observation.expired);
  const at = Date.now(); send("\x1b/");
  await wait("runtime restore recorded", () => events().some(event => event.event === "main-restored" && event.token === token));
  const restored = events().find(event => event.event === "main-restored" && event.token === token);
  const elapsed = restored.completedAt - at;
  assert.equal(restored.mainForeground, true);
  assert.equal(restored.viewToken, view.token);
  assert.equal(boundaries(view, "close").length, 1);
  // Log polling is not part of the runtime budget. Independently verify Main and the still-held callback.
  await wait("Main returns without releasing initialization", async () => (await control("snapshot")).childMode === "print");
  assert.ok(!events().some(event => event.event === heldEvent && event.token === token));
  appendFileSync(join(root, "return-proof.jsonl"), JSON.stringify({ sentAt: at, initStartedAt: boundaries(view, "init-start")[0].at, initElapsedUpperBoundMs, observedAt: Date.now(), ...restored, elapsed }) + "\n");
  assert.ok(elapsed >= 0 && elapsed < 1000, `runtime return took ${elapsed} ms`);
  return elapsed;
}
const proof = [];
let result;
try {
  await wait("Main ready", () => events().some(event => event.event === "main-ready"));
  await wait("Main CC", async () => footerText(await control("snapshot"), "main").includes("CC_COMMAND"));
  send("TOOL_MAIN\r"); await wait("Main reply", () => screen().includes("VIEW_REPLY"));
  send("/subagents-test-spawn\r");
  await wait("child settled", async () => (await control("snapshot")).agents?.[0]?.tasks[0]?.phase === "settled");
  // Task settlement can precede its mailbox owner turn. Freeze the baseline
  // only after that durable delivery settles, not during the pre-wake idle gap.
  await wait("Main completion owner turn settled", async () => (await control("delivery")).outboxes.every(outbox => outbox.state === "delivered" && outbox.turnSettlement === "settled") && (await control("snapshot")).mainIdle);
  await wait("Main cache", async () => footerText(await control("snapshot"), "main").includes("CH:"));
  await control("main-draft", { text: "MAIN_PENDING" });
  const baseline = await control("snapshot"), segments = mainSegments(footerText(baseline, "main"));
  const assertMain = async () => {
    const state = await control("snapshot");
    assert.equal(state.childMode, "print"); assert.equal(state.mainDraft, "MAIN_PENDING");
    assert.equal(await control("main-foreground"), true);
    assert.equal(state.editorSame, true); assert.equal(state.starts, 1);
    assert.deepEqual(mainSegments(footerText(state, "main")), segments);
    assert.deepEqual(state.theme, baseline.theme);
    assert.deepEqual(state.listeners, baseline.listeners);
    assert.ok(!screen().split("\n").slice(-5).join("\n").includes("Alt+/ Main"));
    return state;
  };
  const early = await hold("early"); early.expectedDeadlines = 0;
  const earlyMs = await leave("early", early);
  shot("returned-before-deadline");
  await wait("Main frame restored", () => screen().includes("CP:2") && screen().includes("MEM:3"));
  await assertMain();
  // A new view can finish before the abandoned callback completes. Releasing the old one cannot steal it.
  const warm = await open();
  const oldDeadlines = boundaries(early, "deadline").length;
  writeFileSync(join(root, "release-load-early"), "release");
  await wait("abandoned callback eventually returns", () => returned("early"));
  await delay(150);
  const current = await control("snapshot");
  assert.equal(current.childMode, "tui");
  assert.ok(screen().includes("Alt+/ Main") && screen().includes("faux-view(fixture)"));
  assert.deepEqual(current.viewObservation, { token: warm.token, closed: false });
  assert.equal(await control("main-foreground"), false);
  assert.equal(boundaries(early, "ready").length, 0);
  assert.equal(boundaries(early, "deadline").length, oldDeadlines, "late old callback cannot add an old-token diagnostic");
  await auditViews(); await back(); await assertMain();
  proof.push({ mode: "early-return", viewToken: early.token, returnMs: earlyMs });
  for (const token of ["deadline-return", "deadline-recover"]) {
    const view = await hold(token); view.expectedDeadlines = 1;
    await wait("deadline reveals current frame", () => boundaries(view, "deadline").length === 1 && screen().includes("Alt+/ Main") && screen().includes("faux-view(fixture)"), 4000);
    const visibleMs = Date.now() - boundaries(view, "init-start")[0].at;
    assert.ok(visibleMs >= 1700, "do not publish initial frames before the watchdog");
    assert.equal(returned(token), false);
    await auditViews();
    shot(token + "-visible");
    let returnMs;
    if (token === "deadline-return") {
      returnMs = await leave(token, view); await assertMain();
      writeFileSync(join(root, `release-load-${token}`), "release");
      await wait("late callback returned", () => returned(token));
      await delay(150); await assertMain();
      assert.equal(boundaries(view, "ready").length, 0);
    } else {
      writeFileSync(join(root, `release-load-${token}`), "release");
      await wait("callback completes normally after deadline", () => returned(token));
      await ready(view);
      await delay(150); assert.equal((await control("snapshot")).childMode, "tui");
      await back(); await assertMain();
    }
    await auditViews();
    proof.push({ mode: token, viewToken: view.token, visibleMs, deadlineElapsedMs: boundaries(view, "deadline")[0].monotonicAt - boundaries(view, "init-start")[0].monotonicAt, returnMs });
  }
  for (const nth of [1, 2]) {
    const token = `bind-${nth}`;
    await control("hold-binding", { token, nth });
    const view = await startView(token); view.expectedDeadlines = 1;
    await wait("real extension binding held", () => events().some(event => event.event === "binding-held" && event.token === token));
    await wait("deadline reveals pending binding", () => boundaries(view, "deadline").length === 1 && screen().trim() !== "", 4000);
    await auditViews();
    shot(token + "-visible");
    const returnMs = await leave(token, view, "binding-returned");
    await wait("Main frame after pending bind", () => screen().includes("CP:2") && screen().includes("MEM:3"));
    await assertMain();
    writeFileSync(join(root, `release-binding-${token}`), "release");
    await wait("late binding handler returns", () => events().some(event => event.event === "binding-returned" && event.token === token));
    await delay(200); await assertMain();
    assert.equal(boundaries(view, "ready").length, 0);
    await auditViews();
    proof.push({ mode: token, viewToken: view.token, returnMs });
  }
  await auditViews();
  for (const view of views) assert.equal(boundaries(view, "close").length, 1, `${view.label}: view closed`);
  send("X"); await wait("Main input survives late completion", async () => (await control("snapshot")).mainDraft === "MAIN_PENDINGX");
  shot("main-final");
  send("\x05\x15/quit\r"); await Promise.race([child.exited, delay(8000)]); assert.equal(child.exitCode, 0);
  result = { passed: true, root, proof };
} catch (error) { shot("failure"); result = { passed: false, root, error: String(error), stack: error.stack }; process.exitCode = 1; }
finally {
  if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  child.terminal?.close(); term.dispose();
  writeFileSync(join(root, "terminal.raw"), raw); writeFileSync(join(root, "stderr.txt"), await stderr);
  writeFileSync(join(root, "chunks.json"), JSON.stringify(chunks));
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
