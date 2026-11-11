import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import xterm from "@xterm/headless";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../../local/pi-subagents");
const binary = process.argv[2] ?? process.env.PI_PATCHED_CLI;
if (!binary) throw new Error("Usage: bun test/real/sdk-statusline.mjs /path/to/pi-next");
const root = process.env.PI_SDK_STATUSLINE_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "pi-sdk-statusline-"));
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
const events = () => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
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
async function open(cycle) { const start = performance.now(); await control("observe-view", { token: String(cycle) }); await control("open"); await wait("child ready", async () => events().some(event => event.event === "view-boundary" && event.token === String(cycle) && event.kind === "ready") && (await control("snapshot")).childMode === "tui" && screen().includes("Alt+/ Main")); const elapsed = performance.now() - start; await delay(100); return elapsed; }
async function back(key = "\x1b/") { send(key); await wait("Main restored", async () => ["print", "disposed"].includes((await control("snapshot")).childMode)); await delay(100); }
// A failed command must not expose Pi's native footer after CC readiness. Only an actual
// initialization deadline may reveal the pre-presentation fallback before CC mounts.
const plain = value => value.replace(/\x1b\[[0-9;]*m/g, "");
const footer = (state, role) => state.footerHosts?.filter(host => host.role === role).at(-1);
const footerText = (state, role) => plain(footer(state, role)?.rows?.join("\n") ?? "");
const mainSegments = text => text.match(/(?:CP|MEM|CH):\S+/g);
const proofs = [];
async function checkCommittedFrames() {
  const replay = new xterm.Terminal({ cols: 112, rows: 38, allowProposedApi: true });
  const frames = [], boundaries = new Map();
  for (const match of raw.matchAll(/\x1b\]777;fixture-view;(\d+);(deadline|mounted|ready)\x07/g)) {
    const cycle = Number(match[1]), boundary = boundaries.get(cycle) ?? {};
    boundary[match[2]] ??= match.index + match[0].length;
    boundaries.set(cycle, boundary);
  }
  let epoch = 0, active = false, offset = 0, chunkEnd = 0, chunkIndex = 0;
  try {
    // Replay every committed synchronized-output frame, including frames that
    // arrived before open() observed a ready child or any CC footer text.
    const parts = raw.split("\x1b[?2026l");
    for (const part of parts.slice(0, -1)) {
      offset += part.length + "\x1b[?2026l".length;
      while (chunkEnd < offset && chunkIndex < chunks.length) chunkEnd += chunks[chunkIndex++].data.length;
      for (const match of part.matchAll(/\x1b\[\?1049([hl])/g)) {
        active = match[1] === "h";
        if (active) epoch++;
      }
      await new Promise(resolve => replay.write(part + "\x1b[?2026l", resolve));
      if (!active || epoch % 2 !== 0) continue;
      const rows = Array.from({ length: replay.rows }, (_, row) => replay.buffer.active.getLine(replay.buffer.active.viewportY + row)?.translateToString(true) ?? "");
      const cycle = epoch / 2 - 1, boundary = boundaries.get(cycle);
      const fallback = boundary?.deadline !== undefined && offset >= boundary.deadline && offset < Math.min(boundary.mounted ?? Infinity, boundary.ready ?? Infinity);
      frames.push({ cycle, at: chunks[chunkIndex - 1].at, offset, fallback, boundary, footer: rows.slice(-3).join("\n") });
    }
    writeFileSync(join(root, "committed-frames.json"), JSON.stringify(frames, null, 2));
    assert.equal(new Set(frames.map(frame => frame.cycle)).size, 10);
    for (let cycle = 0; cycle < 10; cycle++) {
      const boundary = boundaries.get(cycle);
      assert.ok(boundary?.mounted !== undefined && boundary.ready !== undefined, `missing CC mount/readiness boundary for cycle ${cycle}`);
      assert.ok(frames.some(frame => frame.cycle === cycle && frame.offset >= boundary.ready && !frame.fallback), `missing ready frame for cycle ${cycle}`);
    }
    for (const frame of frames) {
      if (frame.fallback) continue; // Runtime contract permits native output only in this observed deadline interval.
      assert.ok(!frame.footer.includes("thinking off"), `native footer in committed child frame: ${JSON.stringify(frame)}`);
      assert.ok(frame.footer.includes("faux-view(fixture) off"), `CC missing in committed child frame: ${JSON.stringify(frame)}`);
    }
    return frames.length;
  } finally { replay.dispose(); }
}
let result;
try {
  await wait("Main ready", () => events().some(event => event.event === "main-ready"));
  await wait("Main CC command", async () => footerText(await control("snapshot"), "main").includes("CC_COMMAND"));
  send("TOOL_MAIN\r"); await wait("Main tool reply", () => screen().includes("VIEW_REPLY"));
  send("/subagents-test-spawn\r");
  await wait("child settled", async () => (await control("snapshot")).agents?.[0]?.tasks[0]?.phase === "settled");
  // Task settlement can precede its mailbox owner turn. Freeze the baseline
  // only after that durable delivery settles, not during the pre-wake idle gap.
  await wait("Main completion owner turn settled", async () => (await control("delivery")).outboxes.every(outbox => outbox.state === "delivered" && outbox.turnSettlement === "settled") && (await control("snapshot")).mainIdle);
  await wait("Main cache segment", async () => footerText(await control("snapshot"), "main").includes("CH:"));
  const baseline = await control("snapshot");
  const mainFooter = footerText(baseline, "main");
  for (const token of ["CP:2", "MEM:3", "CH:"]) assert.ok(mainFooter.includes(token), mainFooter);
  shot("main-before");
  for (let i = 0; i < 10; i++) {
    unlinkSync(gate);
    const previous = await control("snapshot");
    await open(i);
    const entered = await control("snapshot"), childFooter = footer(entered, "child");
    assert.ok(childFooter?.sets > 0 && childFooter.mounts > 0, "CC must set the public slot before any command succeeds");
    assert.ok(footerText(entered, "child").includes("faux-view(fixture) off"), JSON.stringify(childFooter));
    assert.equal(childFooter.clickConsumed, false, "Subagent footer is read-only");
    assert.ok(!footerText(entered, "child").includes("CP:2") && !footerText(entered, "child").includes("MEM:3"));
    assert.equal(childFooter.clears, 0);
    await wait("synchronous CC frame visible", () => screen().split("\n").slice(-3).join("\n").includes("faux-view(fixture) off"));
    assert.ok(!screen().split("\n").slice(-3).join("\n").includes("thinking off"), screen());
    shot(`child-${i}-first`);
    if (i === 0) {
      await delay(1200); // First command and its first retry have both failed.
      assert.ok(footerText(await control("snapshot"), "child").includes("faux-view(fixture) off"));
    }
    writeFileSync(gate, "ready");
    if (i === 0) {
      await wait("command replaces initial frame", async () => footerText(await control("snapshot"), "child").includes("CC_COMMAND"));
      await wait("one CC footer visible", () => screen().split("CC_COMMAND").length === 2);
      assert.ok(footerText(await control("snapshot"), "child").includes("CH:"));
      shot("child-command");
    }
    await back();
    const restored = await control("snapshot");
    assert.deepEqual(mainSegments(footerText(restored, "main")), mainSegments(mainFooter), "Main segments survive handoff unchanged");
    assert.equal(footer(restored, "main").clears, 0);
    assert.equal(restored.editorSame, true); assert.equal(restored.starts, 1);
    assert.equal(restored.listeners.stdin, 1);
    assert.equal(restored.presentationProviders, baseline.presentationProviders);
    for (const key of ["sigterm", "sighup", "uncaught", "inputErrors", "outputErrors"]) assert.equal(restored.listeners[key], baseline.listeners[key], key);
    await wait("one Main footer visible", () => screen().split("CC_COMMAND").length === 2 && screen().includes("CP:2") && screen().includes("MEM:3"));
    const detached = footer(restored, "child");
    await delay(100);
    assert.equal(footer(await control("snapshot"), "child").sets, detached.sets, "detached refreshes cannot mount into Main");
    proofs.push({ cycle: i, childFooter, restoredMain: footer(restored, "main"), previousHosts: previous.footerHosts.length });
  }
  shot("main-restored");
  send("/internals\r");
  await wait("live internals report", async () => !!(await control("internals-report")));
  const internals = (await control("internals-report")).details;
  assert.ok(!internals.includes("缺失 (") && !internals.includes("调用失败 ("), internals);
  writeFileSync(join(root, "internals.txt"), internals);
  send("\x1b"); await delay(100);
  send("/quit\r"); await Promise.race([child.exited, delay(8000)]); assert.equal(child.exitCode, 0);
  const committedFrames = await checkCommittedFrames();
  result = { passed: true, root, cycles: proofs.length, committedFrames, proofs };
} catch (error) { shot("failure"); result = { passed: false, root, error: String(error), stack: error.stack }; process.exitCode = 1; }
finally {
  if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  child.terminal?.close(); term.dispose();
  writeFileSync(join(root, "terminal.raw"), raw); writeFileSync(join(root, "stderr.txt"), await stderr);
  writeFileSync(join(root, "chunks.json"), JSON.stringify(chunks));
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result?.passed, error: result?.error, cycles: result?.cycles, root }));
}
