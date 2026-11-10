import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import xterm from "@xterm/headless";
import { execFileSync } from "node:child_process";
import { testPiExecutable } from "../../local/pi-side-chat/test/pi-executable.ts";

const pkg = fileURLToPath(new URL("../../local/pi-side-chat/", import.meta.url));
const binary = process.argv[2] ?? testPiExecutable();
const nativePresentation = process.env.PI_S2_NATIVE_PRESENTATION === "1";
if (!binary) throw new Error("Usage: bun integration/side-chat/sdk-view-e2e.mjs /path/to/stock-pi-1.5.0");
const root = process.env.PI_S2_VIEW_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "pi-s2-view-"));
mkdirSync(root, { recursive: true });
const agent = join(root, "agent"); mkdirSync(agent, { recursive: true });
const home = join(root, "home"); mkdirSync(join(home, ".config"), { recursive: true });
for (const name of ["tmp", "cache", "state", "data"]) mkdirSync(join(root, name), { recursive: true });
const themeFile = join(agent, "themes", "s2-theme.json"); mkdirSync(dirname(themeFile), { recursive: true });
if (!nativePresentation) {
  const theme = JSON.parse(readFileSync(join(pkg, "../pi-claude-style/themes/cc-style-soft.json"), "utf8")); theme.name = "s2-theme";
  writeFileSync(themeFile, JSON.stringify(theme));
}
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], quietStartup: true, theme: nativePresentation ? "dark" : "s2-theme", tuiMode: "fullscreen", retry: { enabled: false },
  defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  statusLine: { type: "command", command: "cat >/dev/null; printf '[[pi:slot:model]] [[pi:slot:effort]]\\n'", debounceMs: 10 } }));
writeFileSync(join(root, "fixture.txt"), "Shared native CC fullscreen tool rendering. ".repeat(220) + "\n");
writeFileSync(join(root, "main.jsonl"), JSON.stringify({ type: "session", version: 3, id: "s2-main", timestamp: new Date().toISOString(), cwd: root }) + "\n");
writeFileSync(join(root, "editor.cjs"), "const fs=require('node:fs'); fs.writeFileSync(process.env.PI_S2_VIEW_ROOT+'/editor.pid',String(process.pid)); if(process.env.PI_S2_EDITOR_HOLD) setInterval(()=>{},1000); else fs.writeFileSync(process.argv[2], 'EXTERNAL_EDITED_DRAFT\\n');");
const term = new xterm.Terminal({ cols: 112, rows: 38, allowProposedApi: true, scrollback: 2000 });
let raw = "", serial = 0;
const child = Bun.spawn({ cmd: [binary, "--offline", "--session", join(root, "main.jsonl"), "--tui-mode", "fullscreen", "--no-extensions",
  ...(nativePresentation ? [] : ["-e", join(pkg, "../pi-claude-style/dist/index.ts")]),
  ...(process.env.PI_S2_BASH_TIMEOUT ? ["-e", join(pkg, "../pi-bash-timeout/extensions/index.ts")] : []),
  "-e", join(pkg, "index.ts"),
  "-e", fileURLToPath(new URL("./fixtures/sdk-view-main.mjs", import.meta.url)), "--provider", "side-fixture", "--model", "faux-view", "--thinking", "off", "--models", "side-fixture/faux-view,side-fixture/faux-small", "--approve"],
  cwd: root, env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
    PI_S2_VIEW_ROOT: root, PI_S2_P3_FIXES: process.env.PI_S2_P3_FIXES, PI_S2_SLOW_SHUTDOWN: process.env.PI_S2_SLOW_SHUTDOWN, PI_S2_EDITOR_HOLD: process.env.PI_S2_EDITOR_HOLD, PI_CLIPBOARD_OSC52: "1", EDITOR: "node " + join(root, "editor.cjs"), TERM: "xterm-256color" },
  stdin: "ignore", stderr: "pipe", terminal: { cols: 112, rows: 38, data(_pty, data) { raw += Buffer.from(data).toString(); term.write(data); } } });
const stderr = new Response(child.stderr).text();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const texts = new Map();
function readText(path) {
  const st = statSync(path, { bigint: true }), version = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  const prior = texts.get(path);
  if (prior?.version === version) return prior.text;
  const text = readFileSync(path, "utf8"); texts.set(path, { version, text }); return text;
}
let eventText, eventRows = [];
const events = () => {
  const path = join(root, "events.jsonl"); if (!existsSync(path)) return [];
  const text = readText(path);
  if (text !== eventText) { eventRows = text.split("\n").filter(Boolean).map(JSON.parse); eventText = text; }
  return eventRows;
};
const screen = () => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
const send = text => child.terminal.write(text);
function finalTerminalState() {
  const modes = { bracketedPaste: undefined, cursorVisible: undefined };
  for (const match of raw.matchAll(/\x1b\[\?(2004|25)([hl])/g)) {
    if (match[1] === "2004") modes.bracketedPaste = match[2] === "h";
    else modes.cursorVisible = match[2] === "h";
  }
  return modes;
}
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
async function open(key = "\x1b/") { send(key); await wait("Side ready", async () => (await control("snapshot")).sideMode === "tui" && screen().includes(nativePresentation ? "Side · ephemeral" : "Alt+/ Main")); await delay(150); }
async function back(key = "\x1b/") { send(key); await wait("Main restored", async () => (await control("snapshot")).sideMode === "print"); await delay(150); }
const processSamples = [];
async function assertNoChildProcess(label) {
  const deadline = Date.now() + 5000;
  const transientChildren = new Map();
  let children;
  do {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n").map(line => {
      const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
      return { pid: Number(pid), ppid: Number(ppid), command };
    });
    const descendants = new Set([child.pid]);
    let count;
    do { count = descendants.size; for (const row of rows) if (descendants.has(row.ppid)) descendants.add(row.pid); } while (count !== descendants.size);
    children = rows.filter(row => row.pid !== child.pid && descendants.has(row.pid));
    if (children.length === 0) break;
    for (const process of children) transientChildren.set(process.pid, process);
    // CC's Git/statusline refresh can be in flight; a persistent Side child still fails below.
    await delay(50);
  } while (Date.now() < deadline);
  processSamples.push({ label, pid: child.pid, children, transientChildren: [...transientChildren.values()] });
  assert.deepEqual(children, [], `Unexpected descendant process at ${label}: ${JSON.stringify(children)}`);
}
const clear = () => send("\x05\x15");
let result;
try {
  await wait("Main ready", () => events().some(event => event.event === "main-ready")); await delay(250);
  send("TOOL_MAIN_INHERITED_SECRET\r");
  await wait("Main response", () => screen().includes("MAIN_REPLY") && screen().includes("complete"));
  await wait("Main idle", async () => (await control("snapshot")).mainIdle);
  await delay(250); shot("main-before");
  await control("main-draft", { text: "MAIN_DRAFT" });
  if (process.env.PI_S2_VIEW_DRIFT) {
    await open(); await back();
    await control("drift", { method: process.env.PI_S2_VIEW_DRIFT });
  }
  if (process.env.PI_S2_VIEW_DRIFT) {
    send("\x1b/"); await wait("probe rejected", () => screen().includes("incompatible Pi"));
    const state = await control("snapshot"); assert.equal(state.mainDraft, "MAIN_DRAFT"); assert.equal(state.listeners.stdin, 1); assert.equal(state.editorSame, true);
    shot("probe-rejected"); result = { passed: true, drift: process.env.PI_S2_VIEW_DRIFT, state };
    await control("main-quit");
  } else if (nativePresentation) {
    const before = await control("snapshot"), settings = await control("main-settings");
    await open();
    const first = await control("snapshot");
    assert.equal(first.sideModel, "faux-view");
    send("NATIVE_SIDE\r");
    await wait("native Side response", () => screen().includes("SIDE_REPLY") && screen().includes("NATIVE_SIDE"));
    await wait("native Side idle", async () => (await control("snapshot")).sideIdle);
    send("/model side-fixture/faux-small\r");
    await wait("native Side model", async () => (await control("snapshot")).sideModel === "faux-small");
    for (let round = 0; round < 10; round++) {
      await back();
      const state = await control("snapshot");
      assert.equal(state.editorSame, true);
      assert.equal(state.mainDraft, "MAIN_DRAFT");
      assert.equal(state.mainModel, before.mainModel);
      assert.equal(state.mainThinking, before.mainThinking);
      assert.deepEqual(await control("main-settings"), settings);
      await open();
      assert.equal((await control("snapshot")).sideModel, "faux-small");
    }
    const sideRequests = events().filter(event => event.event === "request" && event.role === "side");
    assert.ok(sideRequests.length > 0);
    assert.ok(sideRequests.every(event => event.pid === child.pid));
    await assertNoChildProcess("native-side");
    await back(); clear(); send("/side destroy\r");
    await wait("native Side destroyed", () => !existsSync(first.sideFile));
    assert.equal((await control("snapshot")).editorSame, true);
    shot("native-side-destroyed");
    result = { passed: true, nativePresentation: true, roundTrips: 10, samePid: child.pid };
    await control("main-quit");
  } else if (process.env.PI_S2_BASH_TIMEOUT) {
    const settingsBefore = await control("main-settings");
    const diskBefore = readFileSync(join(agent, "settings.json"), "utf8");
    await open();
    const first = await control("snapshot");
    const definitions = await control("bash-definitions");
    const fingerprint = tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines ?? [], exposure: tool.exposure ?? "direct" });
    assert.ok(definitions.main.sourceInfo.path.endsWith("/pi-bash-timeout/extensions/index.ts"));
    assert.deepEqual(fingerprint(definitions.side), fingerprint(definitions.main));
    assert.deepEqual(definitions.side.parameters.required, ["command", "timeout"]);
    for (const name of ["missing", "invalid", "valid"]) {
      clear(); send(`BASH_TIMEOUT_${name.toUpperCase()}\r`);
      await wait(`Timeout ${name} answer`, () => screen().includes(`BASH_TIMEOUT_${name.toUpperCase()}`) && screen().includes("complete"));
      await wait(`Timeout ${name} idle`, async () => (await control("snapshot")).sideIdle);
      const records = readFileSync(first.sideFile, "utf8").trim().split("\n").map(JSON.parse);
      const toolResult = records.filter(entry => entry.type === "message" && entry.message.role === "toolResult").at(-1).message;
      assert.equal(toolResult.toolName, "bash");
      assert.equal(toolResult.isError, name !== "valid");
      if (name === "valid") assert.equal(readFileSync(join(root, "timeout-valid"), "utf8"), "SIDE_OK");
      else { assert.match(JSON.stringify(toolResult), /timeout/); assert.equal(existsSync(join(root, `timeout-${name}`)), false); }
    }
    clear(); send("/compact\r");
    await wait("Timeout Side compaction", () => readText(first.sideFile).includes('"type":"compaction"'));
    await wait("Timeout compaction idle", async () => (await control("snapshot")).sideIdle);
    assert.ok(!screen().includes("COMPACTION_PRIVATE_MAIN_SECRET") && !screen().includes("MAIN_INHERITED_SECRET"));
    await back();
    const main = await control("snapshot");
    assert.equal(main.mainDraft, "MAIN_DRAFT"); assert.equal(main.editorSame, true); assert.equal(main.listeners.stdin, 1);
    assert.deepEqual(await control("main-settings"), settingsBefore);
    assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), diskBefore);
    assert.ok(!readFileSync(join(root, "main.jsonl"), "utf8").includes("BASH_TIMEOUT_"));
    await open();
    const reopened = await control("bash-definitions");
    assert.deepEqual(fingerprint(reopened.side), fingerprint(definitions.main));
    send("\x04\x04"); await wait("Timeout Side destroyed", () => !existsSync(first.sideFile));
    result = { passed: true, bashTimeout: true, toolFingerprintEqual: true, missingRejected: true, invalidRejected: true,
      validExecuted: true, compactionHidden: true, mainSettingsUnchanged: true, returnAndReopen: true };
    await control("main-quit");
  } else if (process.env.PI_S2_P3_FIXES) {
    const calls = events().filter(event => event.event === "request").length;
    send("\x1b/"); await wait("Side assembly paused", () => events().some(event => event.event === "opening-paused"));
    await control("main-draft", { text: "" });
    send("OPENING_DRAFT\r"); await wait("opening submission rejected", () => screen().includes("Side is opening"));
    assert.equal((await control("snapshot")).mainDraft, "OPENING_DRAFT");
    assert.equal(events().filter(event => event.event === "request").length, calls);
    assert.ok(!readFileSync(join(root, "main.jsonl"), "utf8").includes("OPENING_DRAFT"));
    shot("opening-rejected"); writeFileSync(join(root, "open-release"), "release");
    await wait("Side mounted", async () => (await control("snapshot")).sideMode === "tui" && screen().includes("Alt+/ Main"));
    for (let n = 1; n <= 2; n++) {
      send(`CACHE_QUERY_${n}\r`);
      await wait(`cache answer ${n}`, () => screen().includes(`CACHE_QUERY_${n}`) && screen().includes("complete"));
      await wait(`cache idle ${n}`, async () => (await control("snapshot")).sideIdle);
    }
    await wait("Side cache hit", () => /Side.*cache hit/.test(screen())); shot("cache-hit");
    const cacheLine = screen().split("\n").find(line => /Side.*cache hit/.test(line));
    await back(); assert.equal((await control("snapshot")).mainDraft, "OPENING_DRAFT");
    await open(); await wait("cache hit survives reopen", () => /Side.*cache hit/.test(screen()));
    await back(); await control("main-new");
    await wait("fresh Main", () => events().filter(event => event.event === "main-ready").length === 2);
    unlinkSync(join(root, "open-release"));
    send("\x1b/"); await wait("native-context confirmation", () => screen().includes("effective context unavailable"));
    send("\r"); await wait("accepted Side assembly paused", () => events().filter(event => event.event === "opening-paused").length === 2);
    send("ACCEPTED_OPEN_DRAFT\r"); await wait("accepted opening submission rejected", () => screen().includes("Side is opening"));
    assert.equal((await control("snapshot")).mainDraft, "ACCEPTED_OPEN_DRAFT");
    assert.equal(events().filter(event => event.event === "request").length, calls + 2);
    writeFileSync(join(root, "open-release"), "release");
    await wait("accepted Side mounted", async () => (await control("snapshot")).sideMode === "tui" && screen().includes("Alt+/ Main"));
    await back(); assert.equal((await control("snapshot")).mainDraft, "ACCEPTED_OPEN_DRAFT");
    const confirmationPackets = [];
    for (const sample of [
      { name: "accept-submit", confirm: "\r", submit: "\r", accepted: true },
      { name: "accept-follow-up", confirm: "\r", submit: "\x1b\r", accepted: true },
      { name: "accept-repeated-enter", confirm: "\r\r\r", submit: "\r\r", accepted: true },
      { name: "cancel-repeated-enter", confirm: "\x03\r\r", submit: "\r\x1b\r", accepted: false },
      { name: "no-follow-up", confirm: "\x1b[B\r", submit: "\x1b\r", accepted: false },
    ]) {
      const starts = events().filter(event => event.event === "main-ready").length;
      await control("main-new");
      await wait(`fresh Main ${sample.name}`, () => events().filter(event => event.event === "main-ready").length === starts + 1);
      await control("main-draft", { text: "" });
      if (existsSync(join(root, "open-release"))) unlinkSync(join(root, "open-release"));
      const before = events().filter(event => event.event === "request").length;
      const paused = events().filter(event => event.event === "opening-paused").length;
      const draft = `PACKET_DRAFT_${sample.name}`;
      send("\x1b/"); await wait(`confirmation ${sample.name}`, () => screen().includes("effective context unavailable"));
      // One PTY write: accepting/cancelling the dialog and submitting the following text
      // must be safe before any Promise continuation gets a chance to run.
      send(sample.confirm + draft + sample.submit);
      if (sample.accepted) await wait(`assembly paused ${sample.name}`, () => events().filter(event => event.event === "opening-paused").length === paused + 1);
      await wait(`packet draft ${sample.name}`, async () => (await control("snapshot")).mainDraft === draft);
      await delay(150);
      assert.equal(events().filter(event => event.event === "request").length, before, sample.name);
      const file = events().filter(event => event.event === "bound" && event.role === "main").at(-1).file;
      // A fresh native session need not have a JSONL file before its first message.
      assert.ok(!existsSync(file) || !readFileSync(file, "utf8").includes(draft), sample.name);
      shot(`confirmation-${sample.name}`);
      if (sample.accepted) {
        writeFileSync(join(root, "open-release"), "release");
        await wait(`Side mounted ${sample.name}`, async () => (await control("snapshot")).sideMode === "tui" && screen().includes("Alt+/ Main"));
        await back(); assert.equal((await control("snapshot")).mainDraft, draft);
      } else {
        assert.ok(!screen().includes("effective context unavailable"));
      }
      confirmationPackets.push({ name: sample.name, mainRequestDelta: 0, mainSessionContainsDraft: false, draft });
    }
    const pasteDrafts = [];
    for (const sample of [
      { name: "accept", confirm: "\r", accepted: true },
      { name: "cancel", confirm: "\x03", accepted: false },
      { name: "no", confirm: "\x1b[B\r", accepted: false },
    ]) {
      const starts = events().filter(event => event.event === "main-ready").length;
      await control("main-new");
      await wait(`paste Main ${sample.name}`, () => events().filter(event => event.event === "main-ready").length === starts + 1);
      await control("main-draft", { text: "" });
      if (existsSync(join(root, "open-release"))) unlinkSync(join(root, "open-release"));
      const before = events().filter(event => event.event === "request").length;
      const paused = events().filter(event => event.event === "opening-paused").length;
      const draft = "PASTE_BEGIN\n" + "正文🙂 line\n".repeat(150) + "PASTE_END";
      // Exercise the real editor paste map, rather than assigning an expanded string.
      send(`\x1b[200~${draft}\x1b[201~`);
      await wait(`expanded paste ${sample.name}`, async () => (await control("snapshot")).mainDraft === draft);
      await wait(`collapsed paste ${sample.name}`, () => /\[paste #\d+/.test(screen()));
      shot(`paste-before-${sample.name}`);
      send("\x1b/"); await wait(`paste confirmation ${sample.name}`, () => screen().includes("effective context unavailable"));
      send(sample.confirm);
      if (sample.accepted) {
        await wait(`paste assembly ${sample.name}`, () => events().filter(event => event.event === "opening-paused").length === paused + 1);
        writeFileSync(join(root, "open-release"), "release");
        await wait(`paste Side ${sample.name}`, async () => (await control("snapshot")).sideMode === "tui" && screen().includes("Alt+/ Main"));
        await back();
      } else {
        await wait(`paste confirmation closed ${sample.name}`, () => !screen().includes("effective context unavailable"));
      }
      assert.equal((await control("snapshot")).mainDraft, draft, sample.name);
      assert.equal(events().filter(event => event.event === "request").length, before, sample.name);
      shot(`paste-after-${sample.name}`);
      pasteDrafts.push({ name: sample.name, characters: draft.length, draftPreserved: true, mainRequestDelta: 0 });
    }
    result = { passed: true, openingDraftPreserved: true, mainCallsDuringOpening: 0, cacheLine, cacheSurvivesReopen: true, nativeAcceptanceStillWorks: true, confirmationPackets, pasteDrafts };
    await control("main-quit");
  } else {
    await open(); shot("side-empty");
    assert.ok(!screen().includes("MAIN_INHERITED_SECRET"), screen());
    const first = await control("snapshot");
    await assertNoChildProcess("first-open");
    const bindings = events().filter(event => event.event === "bound");
    assert.equal(bindings.find(event => event.role === "main").pid, child.pid);
    assert.equal(bindings.find(event => event.role === "side").pid, child.pid);
    if (process.env.PI_S2_KITTY_KEYS) {
      const textKeys = "\x1b[76;2:1u\x1b[76;2:2u\x1b[76;2:3u\x1b[84;2:1u\x1b[84;2:2u\x1b[84;2:3u";
      await back(); send("\x1b[?7u"); await delay(100); clear(); send(textKeys); await delay(150);
      const mainText = (await control("snapshot")).mainDraft; assert.equal(mainText, "LLTT"); shot("main-text-repeat");
      await control("main-draft", { text: "MAIN_DRAFT" }); await open("\x1b[47;3:1u");
      send("\x1b[?7u"); await delay(100); send(textKeys); await delay(150);
      const sideText = (await control("snapshot")).sideDraft; assert.equal(sideText, mainText); shot("side-text-repeat");
      writeFileSync(join(root, "text-repeat-proof.json"), JSON.stringify({ mainText, sideText })); clear(); await delay(50);
      // Release/repeat must not invoke either consumer or shared control handlers.
      send("\x1b[99;5:2u\x1b[99;5:3u\x1b[100;5:2u\x1b[100;5:3u\x1b[47;3:2u\x1b[47;3:3u\x1b[122;5:2u\x1b[122;5:3u\x1b[103;5:2u\x1b[103;5:3u");
      await delay(150); assert.equal((await control("snapshot")).sideMode, "tui"); assert.ok(!screen().includes("within 4 seconds")); assert.ok(!screen().includes("Suspend is disabled")); assert.ok(!existsSync(join(root, "editor.pid")));
      send("\x1b[120;1:1u\x1b[120;1:2u\x1b[120;1:3u"); await delay(100); assert.equal((await control("snapshot")).sideDraft, "xx");
      clear(); send("abc\x01\x1b[100;5:1u\x1b[100;5:2u\x1b[100;5:3u"); await delay(100); assert.equal((await control("snapshot")).sideDraft, "c");
      send("\x1b[100;5:2u\x1b[100;5:2u"); await delay(100); assert.equal((await control("snapshot")).sideDraft, ""); assert.ok(!screen().includes("within 4 seconds"));
      send("HOLD_KITTY_C\r"); await wait("Kitty busy Side", async () => !(await control("snapshot")).sideIdle);
      send("\x1b[99;5:1u"); await wait("Kitty Ctrl+C abort", async () => (await control("snapshot")).sideIdle);
      send("\x1b[99;5:2u\x1b[99;5:3u"); await delay(150); assert.equal((await control("snapshot")).sideMode, "tui"); shot("kitty-ctrl-c-stays");
      await back("\x1b[99;5:1u"); await open(); assert.equal((await control("snapshot")).sideFile, first.sideFile);
      send("\x1b[100;5:1u"); await wait("Kitty Ctrl+D arms", () => screen().includes("within 4 seconds"));
      send("\x1b[100;5:2u\x1b[100;5:3u\x1b[120;1:3u\x1b[27;1:2u\x1b[27;1:3u"); await delay(200);
      assert.ok(existsSync(first.sideFile)); assert.ok(screen().includes("within 4 seconds"), "release must not invoke Side onInput and cancel confirmation"); shot("kitty-single-press-survives");
      send("\x1b[100;5:1u"); await wait("second independent Kitty Ctrl+D destroys", () => !existsSync(first.sideFile));
      result = { passed: true, kittyKeys: true, state: await control("snapshot") }; await control("main-quit");
    } else if (process.env.PI_S2_KEY_MATRIX) {
      send("BUSY_DRAFT"); await back("\x03"); await open(); assert.equal((await control("snapshot")).sideDraft, "BUSY_DRAFT");
      clear(); send("HOLD_KEYS\r"); await wait("Side busy for keys", async () => !(await control("snapshot")).sideIdle);
      send("abc\x01\x04"); await delay(100); assert.equal((await control("snapshot")).sideDraft, "bc"); assert.equal((await control("snapshot")).sideIdle, false);
      send("\x1a"); await delay(100); assert.equal((await control("snapshot")).sideIdle, false);
      send("\x03"); await wait("busy Ctrl+C abort preserves draft", async () => (await control("snapshot")).sideIdle); assert.equal((await control("snapshot")).sideDraft, "bc");
      clear(); send("HOLD_DESTROY\r"); await wait("Side busy before destroy", async () => !(await control("snapshot")).sideIdle);
      send("\x04"); await wait("busy destruction armed", () => screen().includes("within 4 seconds")); send("\x1b"); await delay(100);
      assert.equal((await control("snapshot")).sideIdle, false, "Escape cancels confirmation without aborting the run");
      send("\x04\x04"); await wait("busy Side destroyed", () => !existsSync(first.sideFile));
      assert.equal((await control("snapshot")).mainDraft, "MAIN_DRAFT");
      result = { passed: true, busyKeys: true }; await control("main-quit");
    } else if (process.env.PI_S2_VIEW_EXIT) {
      if (process.env.PI_S2_EDITOR_HOLD) { send("draft\x07"); await wait("external editor owns terminal", () => existsSync(join(root, "editor.pid"))); assert.equal(finalTerminalState().bracketedPaste, false); }
      const start = Date.now();
      if (process.env.PI_S2_VIEW_EXIT === "quit") await control("main-quit"); else child.kill(process.env.PI_S2_VIEW_EXIT);
      await child.exited;
      assert.equal(events().filter(event => event.event === "side-cleanup-end").length, 1);
      if (process.env.PI_S2_EDITOR_HOLD) assert.throws(() => process.kill(Number(readFileSync(join(root, "editor.pid"), "utf8")), 0));
      result = { passed: true, exit: process.env.PI_S2_VIEW_EXIT, elapsed: Date.now() - start };
    } else {
      send("/copy\r"); await wait("copy guarded", () => screen().includes("No Side answer"));
      assert.ok(![...raw.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].length);
      clear(); send("HOLD_FIRST\r"); await wait("first Side busy", async () => !(await control("snapshot")).sideIdle);
      send("\x03"); await wait("first Side aborted", async () => (await control("snapshot")).sideIdle);
      clear(); send("/copy\r"); await delay(150); assert.ok(![...raw.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].length);
      for (const prefix of ["/", "/mo", "/unrecognized"]) {
        clear(); send(prefix); await delay(150); shot("completion-" + prefix.replaceAll("/", ""));
        const menu = screen().split("\n").slice(-18).join("\n");
        if (prefix === "/mo") assert.ok(menu.includes("model"), menu);
        assert.ok(!menu.includes("/subagents") && !menu.includes("/new") && !menu.includes("/reload"), menu);
        send("\x1b"); await delay(60);
      }
      for (let n = 0; n < 10; n++) {
        clear(); send(`SIDE_DRAFT_${n}`); await delay(60); await back();
        const main = await control("snapshot"); assert.equal(main.editorSame, true); assert.equal(main.mainDraft, "MAIN_DRAFT"); assert.equal(main.starts, 1); assert.equal(main.listeners.stdin, 1);
        await open(); const side = await control("snapshot"); assert.equal(side.sideDraft, `SIDE_DRAFT_${n}`); assert.equal(side.sideFile, first.sideFile); assert.equal(side.listeners.stdin, 1);
      }
      await assertNoChildProcess("ten-round-trips");
      await back(); clear(); await open("/side\r"); assert.equal((await control("snapshot")).sideFile, first.sideFile);
      await back(); await control("main-draft", { text: "MAIN_DRAFT" }); await open();
      clear(); send("TOOL_SIDE\r"); await wait("Side response", () => screen().includes("SIDE_REPLY") && screen().includes('TOOL_SIDE"}] complete')); await wait("Side idle", async () => (await control("snapshot")).sideIdle); await delay(200); shot("side-answer");
      send("/copy\r"); await wait("Side copy", () => /\x1b\]52;c;/.test(raw));
      const copied = [...raw.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map(match => Buffer.from(match[1], "base64").toString());
      assert.ok(copied.at(-1).includes("SIDE_REPLY") && !copied.at(-1).includes("MAIN_INHERITED_SECRET"));
      writeFileSync(join(root, "clipboard.json"), JSON.stringify(copied));
      assert.ok(!screen().includes("MAIN_INHERITED_SECRET"));
      const diskBeforeDefault = readFileSync(join(agent, "settings.json"), "utf8"), mainSettingsBeforeDefault = await control("main-settings");
      send("/model\r"); await delay(500); shot("side-model"); assert.ok(!screen().includes("faux-forbidden"), screen()); assert.ok(screen().includes("faux-small"), screen()); send("\x1b"); await delay(100);
      send("/model side-fixture/faux-forbidden\r"); await delay(200); assert.equal((await control("snapshot")).sideModel, "faux-view"); send("\x1b"); await delay(100);
      clear(); send("/model\r"); await delay(250); send("faux-small"); await delay(150); send("\x13");
      await wait("Side Ctrl+S selects model", async () => (await control("snapshot")).sideModel === "faux-small");
      await wait("Side selector closes", () => screen().includes("Alt+/ Main") && !screen().includes("Enter select")); shot("side-default-saved");
      assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), diskBeforeDefault);
      assert.deepEqual(await control("main-settings"), mainSettingsBeforeDefault);
      writeFileSync(join(root, "default-proof.json"), JSON.stringify({ mainSettingsBeforeDefault, mainSettingsAfterDefault: await control("main-settings"), diskUnchanged: true }, null, 2));
      await back(); assert.equal((await control("snapshot")).mainModel, "faux-view");
      clear(); send("/model\r"); await delay(500); shot("main-model-restored"); send("\x1b"); await delay(100); await control("main-draft", { text: "MAIN_DRAFT" }); await open();
      const thinkingBefore = await control("snapshot");
      send("\x1b[Z");
      await wait("Side effort changed", async () => (await control("snapshot")).sideThinking !== thinkingBefore.sideThinking);
      assert.equal((await control("snapshot")).mainThinking, thinkingBefore.mainThinking);
      assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), diskBeforeDefault);
      clear(); send("/compact\r"); await wait("Side compact", () => readText(first.sideFile).includes('"type":"compaction"')); await wait("Side compact idle", async () => (await control("snapshot")).sideIdle); await delay(300); shot("side-compacted");
      assert.ok(!screen().includes("COMPACTION_PRIVATE_MAIN_SECRET"), screen()); assert.ok(!screen().includes("MAIN_INHERITED_SECRET"));
      send("\x0f"); await delay(200); assert.ok(!screen().includes("COMPACTION_PRIVATE_MAIN_SECRET")); send("\x0f");
      await back(); await open(); assert.ok(!screen().includes("COMPACTION_PRIVATE_MAIN_SECRET")); shot("side-compacted-reopened");
      for (const command of ["subagents", "new", "resume", "fork", "clone", "tree", "import", "reload", "settings", "login", "logout", "install", "uninstall", "update", "packages", "plugins"]) {
        clear(); send(`/${command}\r`); await delay(80);
        assert.equal((await control("snapshot")).sideDraft, `/${command}`);
      }
      clear(); send("abc\x01\x04"); await delay(150); assert.equal((await control("snapshot")).sideDraft, "bc");
      clear(); send("\x1a"); await delay(100); assert.equal((await control("snapshot")).sideMode, "tui");
      send("\x1b"); await delay(100); assert.equal((await control("snapshot")).sideMode, "tui");
      send("HOLD_SIDE\r"); await wait("busy Side", async () => !(await control("snapshot")).sideIdle);
      send("\x03\x03"); await wait("Side aborted", async () => (await control("snapshot")).sideIdle); assert.equal((await control("snapshot")).sideMode, "tui");
      send("\x03"); await wait("idle Ctrl+C returns", async () => (await control("snapshot")).sideMode === "print"); await open();
      for (const input of ["/exit\r", "/quit\r", "/side\r"]) { await back(input); await open(); }
      await control("side-shutdown"); await wait("Side shutdown returns", async () => (await control("snapshot")).sideMode === "print"); await open();
      clear(); send("EDITOR_DRAFT\x07"); await wait("external editor draft", async () => (await control("snapshot")).sideDraft?.includes("EXTERNAL_EDITED_DRAFT"));
      assert.equal(finalTerminalState().bracketedPaste, true); assert.equal((await control("snapshot")).listeners.raw, true); shot("external-editor-restored");
      // Submission opens pending immediately. Dismiss it before opening Side;
      // the request continues and its later notice waits for Main to return.
      await back(); clear(); send("/btw BTW_SDK_HANDOFF\r");
      await wait("BTW pending", () => events().some(event => event.event === "btw-started"));
      await wait("BTW pending panel", () => screen().includes("pending") && screen().includes("BTW_SDK_HANDOFF"));
      send("\x1b"); await wait("BTW pending panel dismissed", () => !screen().includes("Waiting for BTW answer"));
      await control("main-draft", { text: "MAIN_DRAFT" }); await open();
      writeFileSync(join(root, "btw-release"), "release");
      await wait("BTW complete behind Side", () => events().some(event => event.event === "btw-resolved"));
      await delay(500); assert.ok(!screen().includes("BTW_SDK_ANSWER")); assert.ok(screen().includes("Alt+/ Main"));
      await back(); await wait("BTW notice after return", () => screen().includes("BTW answered"));
      assert.equal((await control("snapshot")).mainDraft, "MAIN_DRAFT");
      clear(); send("/btw\r"); await wait("BTW browser", () => screen().includes("BTW_SDK_ANSWER"));
      const callsBeforeBrowser = events().filter(event => event.event === "request").length;
      send("BROWSER_INPUT_MUST_NOT_REACH_MAIN"); await delay(200);
      assert.ok(!screen().includes("BROWSER_INPUT_MUST_NOT_REACH_MAIN"));
      send("\x1b"); await wait("BTW browser closes", () => !screen().includes("BTW_SDK_ANSWER"));
      assert.equal(events().filter(event => event.event === "request").length, callsBeforeBrowser);
      assert.ok(!readFileSync(join(root, "main.jsonl"), "utf8").includes("BTW_SDK_HANDOFF"));
      await control("main-draft", { text: "MAIN_DRAFT" }); await open(); await assertNoChildProcess("btw-and-side");
      clear(); await control("background", { text: "MAIN_BACKGROUND_FINISHED" });
      await wait("Main completion toast", () => screen().includes("Main conversation finished")); shot("main-finished-toast"); assert.ok(!screen().includes("MAIN_REPLY"));
      await delay(5200); assert.ok(!screen().includes("Main conversation finished"));
      send("\x04"); await wait("destroy armed", () => screen().includes("within 4 seconds")); send("\x1b"); await delay(100); assert.ok(!screen().includes("within 4 seconds"));
      send("\x04x"); await delay(100); assert.ok(!screen().includes("within 4 seconds")); clear();
      send("\x04"); await delay(4200); assert.ok(!screen().includes("within 4 seconds")); send("\x04"); await delay(100); assert.equal((await control("snapshot")).sideMode, "tui"); send("\x04");
      await wait("Side destroyed", () => !existsSync(first.sideFile)); await delay(200); shot("main-after-destroy");
      assert.equal((await control("snapshot")).mainDraft, "MAIN_DRAFT");
      await assertNoChildProcess("destroyed");
      await open(); const replacement = await control("snapshot"); assert.notEqual(replacement.sideFile, first.sideFile);
      await control("main-reload"); await wait("Main reload", () => events().filter(event => event.event === "main-ready").length === 2); assert.ok(!existsSync(replacement.sideFile));
      send("AFTER_RELOAD\r"); await wait("Main ready after reload", () => screen().includes("MAIN_REPLY") && screen().includes("AFTER_RELOAD")); await wait("Main idle after reload", async () => (await control("snapshot")).mainIdle);
      await open(); const afterReload = await control("snapshot"); await control("main-new"); await wait("Main new", () => events().filter(event => event.event === "main-ready").length === 3); assert.ok(!existsSync(afterReload.sideFile));
      send("/side\r"); await wait("new Main asks for context", () => screen().includes("effective context unavailable")); send("\x1b"); await delay(150);
      clear(); send("/model\r"); await delay(300); send("faux-small"); await delay(150); send("\x13");
      await wait("Main Ctrl+S still selects", async () => (await control("snapshot")).mainModel === "faux-small");
      await wait("Main default persisted", () => readText(join(agent, "settings.json")).includes('"faux-small"')); shot("main-default-saved");
      result = { passed: true, toggles: 10, effortIsolated: true, btwWithSide: true, sideDefaultIsolated: true, mainDefaultWorks: true, first, final: await control("snapshot") };
      await control("main-quit");
    }
  }
  await Promise.race([child.exited, delay(8000)]); assert.equal(child.exitCode, 0);
  const protocols = finalTerminalState(); assert.equal(protocols.bracketedPaste, false); assert.equal(protocols.cursorVisible, true);
  result = { ...result, protocols, processSamples, providerCalls: events().filter(event => event.event === "request").length, realProviderCalls: 0, pid: child.pid, root }; writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  writeFileSync(join(root, "terminal.raw"), raw); shot("final");
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, delay(5000)]); }
  if (child.exitCode === null) child.kill("SIGKILL");
  writeFileSync(join(root, "stderr.log"), await stderr); child.terminal.close();
}
