import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, unlinkSync, renameSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import xterm from "@xterm/headless";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.argv[2];
if (!binary) throw new Error("Usage: bun test/real/sdk-child-view.mjs /path/to/pi-next");
const root = process.env.PI_SDK_VIEW_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "pi-sdk-view-"));
mkdirSync(root, { recursive: true });
const agent = join(root, "agent"); mkdirSync(agent, { recursive: true });
const home = join(root, "home"); mkdirSync(join(home, ".config"), { recursive: true });

mkdirSync(join(agent, "pi-subagents"), { recursive: true, mode: 0o700 });
writeFileSync(join(agent, "pi-subagents/config.json"), JSON.stringify({ schemaVersion: 2, execution:{maxDepth:process.env.PI_SDK_VIEW_CD==="D"?2:1} }));
const themeFile = join(agent, "themes", "b3-theme.json"); mkdirSync(dirname(themeFile), { recursive: true });
const theme = JSON.parse(readFileSync(join(pkg, "../pi-claude-style/themes/cc-style-soft.json"), "utf8")); theme.name = "b3-theme";
writeFileSync(themeFile, JSON.stringify(theme));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"], quietStartup: true, theme: process.env.PI_SDK_UNSUPPORTED_THEME === "pair" ? "light/dark" : "b3-theme", tuiMode: "fullscreen", retry: { enabled: false },
  statusLine: { type: "command", command: "cat >/dev/null; printf '[[pi:slot:model]] [[pi:slot:effort]]\\n'", debounceMs: 10 } }));
writeFileSync(join(root, "fixture.txt"), "Shared native CC fullscreen tool rendering\n");
writeFileSync(join(root, "main.jsonl"), JSON.stringify({ type: "session", version: 3, id: "b3-main", timestamp: new Date().toISOString(), cwd: root }) + "\n");
const term = new xterm.Terminal({ cols: 112, rows: 38, allowProposedApi: true, scrollback: 2000 });
let raw = "", serial = 0;
const child = Bun.spawn({ cmd: [binary, "--offline", "--session", join(root, "main.jsonl"), "--tui-mode", "fullscreen", "--no-extensions",
  "-e", join(pkg, "../pi-claude-style/dist/index.ts"), "-e", join(pkg, "test/fixtures/test-commands.ts"),
  "-e", join(pkg, "test/fixtures/sdk-view-main.mjs"), "--provider", "fixture", "--model", "faux-view", "--thinking", "off", "--approve"],
  cwd: root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PI_CODING_AGENT_DIR: agent, PI_NEXT_AGENT_DIR: agent, PI_OFFLINE: "1",
    PI_SDK_VIEW_ROOT: root, PI_SUBAGENTS_TEST_MESSAGE: "TOOL_FIRST", PI_SUBAGENTS_TEST_TASK_NAME: "view_child", TERM: "xterm-256color" },
  stdin: "ignore", stderr: "pipe", terminal: { cols: 112, rows: 38, data(_pty, data) { raw += Buffer.from(data).toString(); term.write(data); } } });
const stderr = new Response(child.stderr).text();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = () => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const screen = () => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
const send = text => child.terminal.write(text);
const runSeparators = path => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse)
  .filter(entry => entry.type === "custom" && entry.customType === "pi-claude-transcript:run-separator").map(entry => entry.data.snapshot);
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
const handledOutbox = outbox => outbox.state === "handled" && outbox.wakeState === "settled"
  && outbox.handlingProof?.session_id === outbox.recipientSession && outbox.completions.length > 0
  && outbox.completions.every(id => outbox.handlingProof.cards.some(card => card.completion_id === id && card.assistant_entry_id));
const settledOutbox = outbox => handledOutbox(outbox) || (outbox.state === "delivered" && outbox.wakeState === "settled"
  && outbox.turnSettlement === "settled" && outbox.settlementKind === "producer-fallback" && outbox.settlementProof);
// History installs no provider context; observe its terminal lease and frame instead of the disposed execution.
async function open(history = false) { const start = performance.now(); await control("open"); await wait("child ready", async () => (history ? !(await control("main-foreground")) : (await control("snapshot")).childMode === "tui") && screen().includes("Alt+/ Main")); const elapsed = performance.now() - start; await delay(100); return elapsed; }
async function back(key = "\x1b/", history = false) { send(key); await wait("Main restored", async () => history ? (await control("main-foreground")) && !screen().includes("Alt+/ Main") : ["print", "disposed"].includes((await control("snapshot")).childMode)); await delay(100); }
let result;
try {
  await wait("Main ready", () => events().some(event => event.event === "main-ready"));
  await delay(200);
  if (process.env.PI_SDK_UNSUPPORTED_THEME === "anonymous") await control("anonymous-theme");
  const baseline = await control("snapshot");
  send("TOOL_MAIN\r"); await wait("Main native tool response", () => screen().includes("VIEW_REPLY") && screen().includes("TOOL_MAIN"));
  send("/subagents-test-spawn\r");
  await wait("initial child settled", async () => (await control("snapshot")).agents?.[0]?.tasks[0]?.phase === "settled");
  const nativeChild = (await control("snapshot")).agents[0].native;
  const initialRun = runSeparators(nativeChild);
  assert.equal(initialRun.length, 1, "first headless run records its actual summary before any view is opened");
  assert.equal(initialRun[0].status, "done"); assert.ok(initialRun[0].endedAt <= Date.now());
  shot("main-before");
  if (!process.env.PI_SDK_VIEW_EXIT && !process.env.PI_SDK_VIEW_DRIFT && !process.env.PI_SDK_UNSUPPORTED_THEME) {
    await wait("Main completion turn settled before editor checks", async () => (await control("snapshot")).mainIdle);
    for (const prefix of ["", "/root/v", "/root/unknown"]) {
      send(`\x05\x15/subagents ${prefix}`); await delay(150);
      const completion = screen().split("\n").slice(-10).join("\n");
      if (prefix !== "/root/unknown") assert.ok(completion.includes("/root/view_child"), completion);
      else assert.ok(!completion.includes("/root/view_child"), completion);
      send("\x1b"); await delay(80); send("\x05\x15");
    }
    send("/subagents\r"); await wait("Tree", () => screen().includes("Enter opens Subagent Pi"));
    send("\r"); await wait("Tree Enter opens child", () => screen().includes("Alt+/ Main"));
    await back();
    assert.ok(!screen().includes("Enter opens Subagent Pi"));
  }
  send("\x05\x15/subagents /root/view_child\r");
  if (process.env.PI_SDK_UNSUPPORTED_THEME) {
    await wait("unsupported theme fails closed", () => screen().includes("single named Main theme"));
    const state = await control("snapshot");
    assert.deepEqual(state.theme, baseline.theme); assert.equal(state.editorSame, true); assert.equal(state.listeners.stdin, 1);
    assert.notEqual(state.childMode, "tui"); shot("unsupported-theme-rejected");
    result = { passed: true, state, root, pid: child.pid };
    send("\x05\x15/quit\r"); await Promise.race([child.exited, delay(8000)]); assert.equal(child.exitCode, 0);
  } else if (process.env.PI_SDK_VIEW_DRIFT) {
    await wait("unknown listener delta fails closed", () => screen().includes("Unsupported InteractiveMode.init process listeners"));
    const state = await control("snapshot");
    assert.equal(state.childMode, "print"); assert.equal(state.editorSame, true); assert.equal(state.starts, 1);
    assert.equal(state.listeners.stdin, 1); assert.equal(state.listeners.uncaught, baseline.listeners.uncaught);
    assert.equal(state.mainHandlersPreserved, true); assert.equal(state.driftPreserved, true);
    shot("unknown-listener-rejected"); result = { passed: true, state, root, pid: child.pid };
    send("\x05\x15/quit\r"); await Promise.race([child.exited, delay(8000)]); assert.equal(child.exitCode, 0);
  } else {
  await wait("slash command enters", () => screen().includes("Alt+/ Main")); await delay(100); shot("child-native");
  assert.deepEqual(runSeparators(nativeChild), initialRun, "opening history must not invent or rewrite run times");
  await wait("first background run divider visible", () => screen().includes("done at"));
  if (process.env.PI_SDK_VIEW_EXIT) {
    const mode = process.env.PI_SDK_VIEW_EXIT, start = Date.now();
    if (mode === "quit") await control("main-quit");
    else child.kill(mode);
    await Promise.race([child.exited, delay(8000)]);
    assert.notEqual(child.exitCode, null);
    await delay(50); // Let the PTY deliver its final bytes before checking the terminal's last modes.
    const cleanup = events().filter(event => event.event === "child-cleanup-end");
    assert.equal(cleanup.length, 1);
    assert.equal(events().filter(event => event.event === "main-shutdown").length, 1);
    assert.ok(Date.now() - start >= 1450);
    const terminalState = finalTerminalState();
    assert.deepEqual(terminalState, { bracketedPaste: false, cursorVisible: true });
    result = { passed: true, mode, elapsedMs: Date.now() - start, exitCode: child.exitCode, cleanup, terminalState, pid: child.pid, root };
  } else {
  if (process.env.PI_SDK_VIEW_CD === "mouse") {
    await back();await wait("Main idle",async()=> (await control("snapshot")).mainIdle);
    await control("mouse-spawn",{names:Array.from({length:19},(_,i)=>"worker"+i)});
    await wait("19 fixture tasks settled",async()=> (await control("snapshot")).agents.length===20&&(await control("snapshot")).agents.every(a=>a.tasks.every(t=>t.phase==="settled")));
    await wait("19 fixture Main idle",async()=> (await control("snapshot")).mainIdle);
    await control("mouse-spawn",{names:["worker"]});
    await wait("worker settled last",async()=> (await control("snapshot")).agents.length===21&&(await control("snapshot")).agents.every(a=>a.tasks.every(t=>t.phase==="settled")));
    await wait("worker Main idle",async()=> (await control("snapshot")).mainIdle);
    const before=await control("mouse-unread-proof");
    send("\x05\x15/subagents\r");await wait("list",()=>screen().includes("Done (21)"));
    for(let i=0;i<13;i++){send("\x1b[B");await delay(30);}
    await delay(150);shot("mouse-scrolled-list");
    const lines=screen().split("\n"),row=lines.findIndex(line=>/^\s*(?:→ )?worker16\s+\[/.test(line));assert.ok(row>=0,screen());
    const clicked=lines[row].match(/worker\d+/)[0];
    send(`\x1b[<0;4;${row+1}M\x1b[<0;4;${row+1}m`);await wait("clicked Agent native view",()=>screen().includes("Alt+/ Main"));shot("mouse-opened-view");await delay(100);
    await wait("clicked Agent read receipt",async()=>!(await control("mouse-unread-proof")).find(agent=>agent.name===clicked).unread);
    const after=await control("mouse-unread-proof");
    const bound=events().filter(event=>event.event==="bound"&&event.role==="child"&&event.mode==="tui").at(-1);
    assert.equal(bound.session,before.find(agent=>agent.name===clicked).session);
    await back();
    const cleared=before.filter(a=>a.unread>0&&!after.find(b=>b.id===a.id).unread).map(a=>a.name);
    result={passed:true,batch:"mouse-regression",pid:child.pid,clicked,cleared,before,after,root};
    assert.equal(clicked,"worker16");assert.deepEqual(cleared,["worker16"]);assert.equal(after.find(agent=>agent.name==="worker").unread,before.find(agent=>agent.name==="worker").unread);
    send("\x05\x15/quit\r");await Promise.race([child.exited,delay(8000)]);assert.equal(child.exitCode,0);
  } else if (process.env.PI_SDK_VIEW_CD === "C") {
    send("HOLD_C_VIEW\r");
    await wait("C running Task", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "running");
    const before = (await control("snapshot")).agents[0];
    send("C_STEER\r");
    await wait("C durable steer", async () => (await control("snapshot")).agents[0].mailbox.some(mail => mail.body === "C_STEER"));
    assert.equal((await control("snapshot")).agents[0].tasks.length, before.tasks.length);
    await wait("accepted pending UI", () => screen().includes("已接纳"));
    assert.ok(!screen().includes("Follow-up waiting")); shot("c-steer-pending");
    send("C_FIFO\x1b\r");
    await wait("C Alt+Enter new Task", async () => (await control("snapshot")).agents[0].tasks.length === before.tasks.length + 1);
    writeFileSync(join(root, "release"), "ready");
    await wait("C FIFO settled", async () => (await control("snapshot")).agents[0].tasks.every(task => task.phase === "settled"));
    unlinkSync(join(root, "release"));
    await back();
    await wait("Main deliveries idle", async () => (await control("snapshot")).mainIdle);
    await control("close"); const closed = (await control("snapshot")).agents[0];
    await open(); await control("child-draft", { text: "C_CLOSED_DRAFT" }); send("\r");
    await wait("C closed rejection", () => screen().includes("Agent 已关闭，先恢复再发送"));
    assert.equal((await control("snapshot")).childDraft, "C_CLOSED_DRAFT");
    const requests = events().filter(event => event.event === "request").length;
    send("\x1b\r"); await delay(200);
    assert.equal(events().filter(event => event.event === "request").length, requests);
    assert.equal((await control("snapshot")).agents[0].tasks.length, closed.tasks.length);
    shot("c-closed-draft");
    await control("child-draft", { text: "/resume-agent" }); send("\r");
    await wait("C explicit resume", async () => (await control("snapshot")).agents[0].lifecycle === "open" && (await control("snapshot")).childDraft === "C_CLOSED_DRAFT");
    assert.equal(events().filter(event => event.event === "request").length, requests);
    assert.equal((await control("snapshot")).agents[0].tasks.length, closed.tasks.length);
    shot("c-resumed-idle-draft");
    send("\r");
    await wait("C resumed input completes", async () => (await control("snapshot")).agents[0].tasks.at(-1).message === "C_CLOSED_DRAFT" && (await control("snapshot")).agents[0].tasks.at(-1).phase === "settled");
    assert.equal((await control("snapshot")).childDraft, "");
    await back(); await wait("C Main idle", async () => (await control("snapshot")).mainIdle);
    const final = await control("snapshot"); assert.equal(final.listeners.stdin, 1); assert.equal(final.editorSame, true);
    send("\x05\x15/quit\r"); await Promise.race([child.exited, delay(8000)]); assert.equal(child.exitCode, 0);
    result = { passed: true, batch: "C", root, final, requests: events().filter(event => event.event === "request").length };
  } else {
  if (process.env.PI_SDK_VIEW_CD === "D") {
    await back(); await wait("D Main idle", async()=> (await control("snapshot")).mainIdle);
    const list=async()=>{send("\x05\x15/subagents\r");await wait("D list",()=>screen().includes("Running")&&screen().includes("Done"));await delay(150);};
    const exitList=async()=>{send("\x1b");await delay(150);};
    await list();assert.ok(screen().includes("open 1/32"));shot("d-wide-done");
    child.terminal.resize(52,24);term.resize(52,24);await delay(150);shot("d-narrow-done");
    assert.ok(screen().includes("worker")||screen().includes("view_child"));
    child.terminal.resize(112,38);term.resize(112,38);await delay(150);
    send("\t");await delay(100);assert.ok(screen().includes("No matching"));send("\x1b[D");await delay(100);assert.ok(screen().includes("view_child"));
    // Actual SGR mouse enters a rendered list row once.
    const lines=screen().split("\n"),row=lines.findIndex(line=>line.includes("view_child")&&line.includes("[completed"));assert.ok(row>=0,screen());
    send(`\x1b[<0;4;${row+1}M\x1b[<0;4;${row+1}m`);await wait("D mouse open",()=>screen().includes("Alt+/ Main"));await back();
    await list();send("c");await wait("D idle C closed",async()=> (await control("snapshot")).agents[0].lifecycle==="closed");send("\x1b[D");await wait("D closed row",()=>screen().includes("closed")&&screen().includes("R resume"));shot("d-closed-row");
    await exitList();await control("append-unread");await wait("D nested completion",async()=>{const state=await control("snapshot");return state.agents.length===2&&state.agents.every(agent=>agent.tasks.every(task=>task.phase==="settled"))&&state.agents[0].unread>=2;});await wait("D nested Main idle",async()=> (await control("snapshot")).mainIdle);await control("close");await list();const unread=(await control("snapshot")).agents[0].unread;
    send("r");await wait("D R open idle",async()=> (await control("snapshot")).agents[0].lifecycle==="open");assert.equal((await control("snapshot")).agents[0].unread,unread);
    await exitList();await open();await wait("D exact card visible",()=>screen().includes("Agent")&&screen().includes("completed"));await back();
    assert.equal((await control("snapshot")).agents[0].unread,1,"enter marks own completions, keeping received descendant card unread");
    await open();await delay(150);const cardLines=screen().split("\n"),cardRow=cardLines.findIndex(line=>line.includes("Agent")&&line.includes("unread_leaf"));assert.ok(cardRow>=0,screen());
    shot("d-completion-before-click");writeFileSync(join(root,"d-click.json"),JSON.stringify({row:cardRow,column:7,line:cardLines[cardRow],at:Date.now()}));
    send(`\x1b[<0;8;${cardRow+1}M\x1b[<0;8;${cardRow+1}m`);await wait("D clicked completion body",()=>screen().includes("Summary")&&screen().includes("Result"));send("\x1b");await delay(150);await back();
    assert.equal((await control("snapshot")).agents[0].unread,0,"clicked descendant completion marks exact card read");
    await open();send("HOLD_D_BUSY\r");await wait("D busy",async()=> (await control("snapshot")).agents[0].tasks.at(-1).phase==="running");await back();
    await list();send("c");await wait("D force confirmation",()=>screen().includes("Force close Subagent"));shot("d-force-default-cancel");send("\r");await delay(200);assert.equal((await control("snapshot")).agents[0].lifecycle,"open");
    await wait("D list after cancel",()=>screen().includes("Running"));send("x");await wait("D X stops current",async()=> (await control("snapshot")).agents[0].tasks.at(-1).outcome==="interrupted");
    await exitList();await open();send("HOLD_D_FORCE\r");await wait("D force task",async()=> (await control("snapshot")).agents[0].tasks.at(-1).phase==="running");await back();
    await list();send("c");await wait("D force yes",()=>screen().includes("Force close Subagent"));send("\x1b[B\r");await wait("D force closed",async()=> (await control("snapshot")).agents[0].lifecycle==="closed");await exitList();
    await list();send("d");await wait("D delete confirmation",()=>screen().includes("Delete Subagent"));send("\x1b");await delay(150);assert.equal((await control("snapshot")).agents.length,2);await exitList();
    const final=await control("snapshot");assert.equal(final.listeners.stdin,1);assert.equal(final.editorSame,true);shot("d-main-final");
    send("\x05\x15/quit\r");await Promise.race([child.exited,delay(8000)]);assert.equal(child.exitCode,0);result={passed:true,batch:"D",root,final};
  } else {
  // Real SGR mouse reports operate the shared CC tool transcript and Pinned overlay.
  const lines = screen().split("\n"), mouseRow = lines.findIndex(line => line.includes("Read 1 file"));
  assert.ok(mouseRow >= 0, screen());
  const mouseColumn = lines[mouseRow].indexOf("Read 1 file") + 3;
  send(`\x1b[<0;${mouseColumn};${mouseRow + 1}M\x1b[<0;${mouseColumn};${mouseRow + 1}m`);
  await wait("native CC tool panel", () => screen().includes("Tool transcript") && screen().includes("Shared native CC fullscreen tool rendering")); shot("child-mouse-panel");
  send("\x1b[<0;112;38M\x1b[<0;112;38m"); await delay(150);
  child.terminal.resize(96, 32); term.resize(96, 32); await delay(150); shot("child-resized");
  assert.ok(screen().includes("Alt+/ Main"));
  child.terminal.resize(112, 38); term.resize(112, 38); await delay(150);
  send("FOREGROUND_RECORDING\r");
  await wait("foreground recorded once", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "settled" && runSeparators(nativeChild).length === 2);
  assert.equal(runSeparators(nativeChild)[1].turnCount, 1);
  await wait("foreground final body painted", () => screen().includes('text":"FOREGROUND_RECORDING"}] complete'));
  await delay(100);
  shot("child-foreground-recorded");
  send("HOLD_BACKGROUND_RECORDING\r");
  await wait("third run active", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "running");
  await back(); writeFileSync(join(root, "release"), "ready");
  await wait("detached run recorded", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "settled" && runSeparators(nativeChild).length === 3);
  unlinkSync(join(root, "release"));
  const backgroundRuns = structuredClone(runSeparators(nativeChild)), reopenedAt = Date.now();
  assert.ok(backgroundRuns[2].endedAt <= reopenedAt);
  await open(); assert.deepEqual(runSeparators(nativeChild), backgroundRuns);
  await wait("detached run divider visible", () => screen().includes('text":"HOLD_BACKGROUND_RECORDING"}] complete') && screen().includes("done at"));
  await delay(100);
  shot("child-background-recorded");
  await back();
  const warmBaseline = await control("snapshot");
  await control("main-draft", { text: "MAIN_DRAFT_" });
  const metrics = [];
  for (let i = 0; i < 10; i++) {
    metrics.push(await open());
    const before = await control("snapshot");
    assert.deepEqual(before.theme, baseline.theme);
    assert.equal(before.listeners.stdin, 1); assert.equal(before.listeners.raw, true);
    for (const key of ["sigterm", "sighup", "uncaught", "inputErrors", "outputErrors"]) assert.equal(before.listeners[key], warmBaseline.listeners[key], key);
    if (i === 0) send("CHILD_DRAFT_");
    else assert.equal(before.childDraft, "CHILD_DRAFT_");
    await back(); const after = await control("snapshot");
    assert.equal(after.mainDraft, "MAIN_DRAFT_"); assert.equal(after.editorSame, true); assert.equal(after.starts, 1);
    assert.deepEqual(after.theme, baseline.theme);
  }
  const afterCycles = await control("snapshot");
  assert.equal(afterCycles.presentationProviders, baseline.presentationProviders);
  // Atomic theme-file replacement must repaint Main without keyboard input after handoff.
  const priorOutput = raw.length;
  writeFileSync(themeFile + ".new", JSON.stringify({ ...theme, colors: { ...theme.colors, accent: 196 } })); renameSync(themeFile + ".new", themeFile);
  await wait("Main theme file hot update", async () => (await control("snapshot")).theme.accent === "\x1b[38;5;196m");
  writeFileSync(join(root, "theme-update-proof.json"), JSON.stringify({ at: Date.now(), priorOutput, outputAtThemeRead: raw.length }));
  await wait("theme watcher repaints Main", () => raw.length > priorOutput && raw.slice(priorOutput).includes("38;5;196"));
  shot("main-theme-updated");
  writeFileSync(themeFile + ".new", JSON.stringify(theme)); renameSync(themeFile + ".new", themeFile);
  await wait("Main original theme restored", async () => (await control("snapshot")).theme.accent === baseline.theme.accent);
  await open();
  const childThemeOutput = raw.length;
  writeFileSync(themeFile, JSON.stringify({ ...theme, colors: { ...theme.colors, accent: 197 } }));
  await wait("child-time edit refreshes Main's own named cache", async () => {
    const state = await control("snapshot");
    return state.theme.namedAccent === "\x1b[38;5;197m" && state.theme.accent === "\x1b[38;5;197m";
  });
  await wait("child repaints the edited theme", () => raw.slice(childThemeOutput).includes("38;5;197"));
  const mainThemeOutput = raw.length;
  await back();
  assert.equal((await control("snapshot")).theme.accent, "\x1b[38;5;197m", "Main return must not restore a stale cached palette");
  await wait("Main repaints the child-time theme edit", () => raw.slice(mainThemeOutput).includes("38;5;197"));
  shot("main-theme-after-child-edit");
  writeFileSync(themeFile, JSON.stringify(theme));
  await wait("original theme restored after child-time edit", async () => (await control("snapshot")).theme.accent === baseline.theme.accent);
  send("X"); await delay(80); assert.equal((await control("snapshot")).mainDraft, "MAIN_DRAFT_X"); shot("main-restored");
  await open(); send("\x15"); await delay(50);
  assert.deepEqual(await control("internals", { label: "child" }), { cc: [] });
  for (const command of ["new", "resume", "fork", "clone", "tree", "import", "reload", "settings", "login", "logout", "install", "uninstall", "update", "packages", "plugins", "trust", "share", "export", "side", "unknown"]) {
    send(`\x15/${command}\r`); await delay(80);
    const state = await control("snapshot"); assert.equal(state.childMode, "tui"); assert.equal(state.childDraft, `/${command}`);
  }
  for (const command of ["model", "model fixture/other", "thinking", "thinking high", "help"]) { send(`\x15/${command}\r`); await delay(100); assert.equal((await control("snapshot")).childMode, "tui"); }
  for (const key of ["\x10", "\x1b[80;6u", "\x0c", "\x1b[Z", "\x13", "\x07"]) { send(key); await delay(50); }
  const frozen = await control("snapshot"); assert.equal(frozen.model, "faux-view"); assert.equal(frozen.thinking, "off");
  send("\x15/"); await delay(150); shot("child-completions");
  assert.ok(!screen().split("\n").slice(-12).join("\n").includes("reload") && !screen().split("\n").slice(-12).join("\n").includes("settings"), screen()); send("\x1b"); await delay(80); send("\x15"); await delay(50);
  // Context-only Tree keys remain ordinary repeated text in both native editors.
  const textKeys = "\x1b[76;2:1u\x1b[76;2:2u\x1b[76;2:3u\x1b[84;2:1u\x1b[84;2:2u\x1b[84;2:3u";
  await back(); const savedMainDraft = (await control("snapshot")).mainDraft;
  send("\x1b[?7u"); await delay(100); send("\x05\x15" + textKeys); await delay(150);
  const mainText = (await control("snapshot")).mainDraft; assert.equal(mainText, "LLTT"); shot("main-text-repeat");
  await control("main-draft", { text: savedMainDraft }); await open();
  send("\x1b[?7u"); await delay(100); send(textKeys); await delay(150);
  const childText = (await control("snapshot")).childDraft; assert.equal(childText, mainText); shot("child-text-repeat");
  writeFileSync(join(root, "text-repeat-proof.json"), JSON.stringify({ mainText, childText })); send("\x05\x15"); await delay(50);
  // Kitty flags 7 report press/repeat/release; only presses may run managed control policy.
  send("\x1b[?7u"); await delay(100);
  send("\x1b[99;5:2u\x1b[99;5:3u\x1b[100;5:2u\x1b[100;5:3u"); await delay(120);
  assert.equal((await control("snapshot")).childMode, "tui");
  send("abc\x01\x1b[100;5:1u\x1b[100;5:2u\x1b[100;5:3u"); await delay(100); assert.equal((await control("snapshot")).childDraft, "c");
  send("\x1b[100;5:2u\x1b[100;5:2u"); await delay(100); assert.equal((await control("snapshot")).childDraft, ""); assert.equal((await control("snapshot")).childMode, "tui");
  await back("\x1b[100;5:1u"); await open();
  send("HOLD_KITTY_C\r"); await wait("Kitty task running", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "running");
  send("\x1b[99;5:1u"); await wait("Kitty task interrupted", async () => (await control("snapshot")).agents[0].tasks.at(-1).outcome === "interrupted");
  send("\x1b[99;5:2u\x1b[99;5:3u"); await delay(150); assert.equal((await control("snapshot")).childMode, "tui"); shot("kitty-ctrl-c-stays");
  await back("\x1b[99;5:1u"); await open();
  send("HOLD_KITTY_D\r"); await wait("Kitty Ctrl+D task running", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "running");
  send("\x1b[100;5:2u\x1b[100;5:3u"); await delay(150); assert.equal((await control("snapshot")).childMode, "tui");
  await back("\x1b[100;5:1u"); assert.equal((await control("snapshot")).agents[0].tasks.at(-1).phase, "running");
  await open(); send("\x1b[99;5:1u"); await wait("Kitty Ctrl+D task aborted", async () => (await control("snapshot")).agents[0].tasks.at(-1).outcome === "interrupted");
  send("\x1b[99;5:3u"); await delay(100); assert.equal((await control("snapshot")).childMode, "tui");
  send("abc"); await delay(50); send("\x1b[H"); await delay(50); send("\x04"); await delay(80); assert.equal((await control("snapshot")).childDraft, "bc");
  send("\x1a"); await delay(80); assert.equal((await control("snapshot")).childMode, "tui");
  send("\x05\x15"); await back("\x04");
  await open(); send("\x15"); await back("\x03");
  for (const command of ["subagent", "exit", "quit"]) { await open(); send("\x15"); await back(`/${command}\r`); }
  await open(); await control("child-shutdown"); await wait("ctx.shutdown returns", async () => (await control("snapshot")).childMode === "print");
  await open();
  for (const command of ["session", "hotkeys", "changelog", "copy"]) {
    const requests = events().filter(event => event.event === "request").length;
    send(`\x05\x15/${command}\r`); await delay(250); shot(`command-${command}`);
    send("\x1b"); await delay(100);
    assert.equal(events().filter(event => event.event === "request").length, requests);
    assert.equal((await control("snapshot")).childMode, "tui");
  }
  send("\x05\x15/compact Preserve the fixture facts\r");
  await wait("native compact", async () => readFileSync((await control("snapshot")).agents[0].native, "utf8").split("\n").some(line => line && JSON.parse(line).type === "compaction"));
  const admissionCount = (await control("snapshot")).agents[0].tasks.length;
  const rejected = "e\u0301"; // Host rejects non-NFC messages; no failure injection is needed.
  send(`\x1b[200~${rejected}\x1b[201~\r`); await delay(180);
  const rejection = await control("snapshot"); assert.equal(rejection.childDraft, rejected); assert.equal(rejection.agents[0].tasks.length, admissionCount);
  send("\x05\x15\x1b[200~PASTE_LINE_ONE\nPASTE_LINE_TWO\x1b[201~\r");
  await wait("multiline paste admitted", async () => (await control("snapshot")).agents[0].tasks.at(-1).message === "PASTE_LINE_ONE\nPASTE_LINE_TWO");
  await wait("multiline paste completes", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "settled");
  assert.equal((await control("snapshot")).childDraft, ""); shot("child-paste");
  await back();
  // Keep the slow-Main scenario separate from the previous Task's completion owner turn.
  await wait("previous completion turn settled before Main stream", async () => (await control("delivery")).outboxes.every(settledOutbox) && (await control("snapshot")).mainIdle);
  await control("background", { text: "SLOW_MAIN_BACKGROUND" });
  await wait("Main streaming started", () => events().some(event => event.event === "request" && event.text.includes("SLOW_MAIN_BACKGROUND")));
  await open(); await delay(2500); assert.ok(!screen().includes("SLOW_MAIN_BACKGROUND")); shot("child-while-main-streams");
  await back(); await wait("Main stream restored", () => screen().includes("SLOW_MAIN_BACKGROUND") && screen().includes("VIEW_REPLY")); shot("main-background-restored");
  await open();
  const mailboxTasks = (await control("snapshot")).agents[0].tasks.length;
  send("\x15HOLD_MAILBOX\r");
  await wait("mailbox task running", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "running");
  send("STEER_WHILE_RUNNING\r");
  await wait("running input durable", async () => JSON.stringify((await control("snapshot")).agents[0].mailbox).includes("STEER_WHILE_RUNNING"));
  assert.equal((await control("snapshot")).agents[0].tasks.length, mailboxTasks + 1);
  writeFileSync(join(root, "release"), "ready");
  await wait("mailbox task settles", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "settled");
  assert.equal((await control("snapshot")).agents[0].tasks.at(-1).outcome, "completed");
  unlinkSync(join(root, "release"));
  assert.ok(readFileSync((await control("snapshot")).agents[0].native, "utf8").includes("STEER_WHILE_RUNNING"));
  await back();
  await open(); send("\x15HOLD_FOLLOWUP\r");
  await wait("followup running", async () => (await control("snapshot")).agents[0].tasks.some(task => task.phase === "running"));
  send("\x03\x03"); await wait("interrupted", async () => (await control("snapshot")).agents[0].tasks.at(-1).outcome === "interrupted");
  assert.equal((await control("snapshot")).childMode, "tui"); shot("child-interrupted");
  const rawStart = raw.length; await control("title"); await delay(80); assert.ok(!raw.slice(rawStart).includes("MAIN_BACKGROUND_TITLE"));
  await back(); assert.ok(raw.slice(rawStart).includes("MAIN_BACKGROUND_TITLE"));
  assert.equal((await control("close")).lifecycle, "closed");
  await wait("Main completion owner turn settled before history checks", async () => (await control("delivery")).outboxes.every(settledOutbox) && (await control("snapshot")).mainIdle);
  const historical = await control("snapshot"), originalFile = readFileSync(historical.agents[0].native, "utf8");
  const requestsBeforeHistory = events().filter(event => event.event === "request").length;
  writeFileSync(join(root, "model-unavailable"), "history must remain readable");
  await open(true); assert.equal(readFileSync(historical.agents[0].native, "utf8"), originalFile); shot("history-readonly");
  assert.equal(events().filter(event => event.event === "request").length, requestsBeforeHistory, "unavailable-model history never requests a provider");
  send("/model\r"); await wait("history frozen model", () => screen().includes("Frozen model: fixture/faux-view"));
  unlinkSync(join(root, "model-unavailable"));
  send("/compact\r"); await wait("history compact notice", () => screen().includes("Agent 已关闭，先恢复再发送"), 5000); assert.equal(readFileSync(historical.agents[0].native, "utf8"), originalFile);
  assert.equal(events().filter(event => event.event === "request").length, requestsBeforeHistory, "history commands never request a provider");
  await back("\x1b/", true); await control("resume"); await open(true);
  send("\x15RESTORE_FOLLOWUP\r");
  await wait("historical followup", async () => { const tasks = (await control("snapshot")).agents[0].tasks; return tasks.length === historical.agents[0].tasks.length + 1 && tasks.at(-1).message === "RESTORE_FOLLOWUP" && tasks.at(-1).outcome === "completed"; });
  await wait("restored native view", () => screen().includes("RESTORE_FOLLOWUP") && screen().includes("VIEW_REPLY"));
  shot("history-restored");
  // Native /reload rejects a streaming Main. Completion delivery can start that Main response
  // after the child Task settles, so wait for the actual owner-turn receipt, not just Task phase.
  await wait("Main ready for native reload", async () => (await control("delivery")).outboxes.every(settledOutbox) && (await control("snapshot")).mainIdle);
  const beforeReload = events().filter(event => event.event === "main-ready").length;
  await control("main-reload");
  await wait("Main reload reclaims child", () => events().filter(event => event.event === "main-ready").length > beforeReload);
  await wait("reload Main active", async () => ["print", "disposed"].includes((await control("snapshot")).childMode));
  await control("resume"); await open();
  send("HOLD_HEADLESS_ABORT\r");
  await wait("headless abort task running", async () => (await control("snapshot")).agents[0].tasks.at(-1).phase === "running");
  await back(); assert.equal((await control("snapshot")).childMode, "print");
  await control("child-abort");
  await wait("headless ctx.abort interrupts", async () => (await control("snapshot")).agents[0].tasks.at(-1).outcome === "interrupted");
  const headlessAbort = (await control("snapshot")).agents[0].tasks.at(-1);
  // Settlement deliberately removes transient interrupt fields. The committed receipt remains.
  const headlessAbortReceipt = (await control("interrupt-receipts")).find(receipt => JSON.parse(receipt.result_json).task_id === headlessAbort.id);
  assert.equal(headlessAbortReceipt?.state, "committed");
  assert.equal(JSON.parse(headlessAbortReceipt.result_json).state, "interrupt_requested");
  assert.equal((await control("snapshot")).childMode, "print");
  await open();
  await wait("original completion delivery", async () => (await control("delivery")).outboxes.every(outbox => outbox.state === "delivered" || handledOutbox(outbox)));
  const delivery = await control("delivery");
  const cards = readFileSync(join(root, "main.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(entry => entry.customType === "subagent-completion-v1").map(entry => entry.details.completion_id);
  assert.deepEqual([...cards].sort(), [...delivery.completions].sort()); assert.equal(new Set(cards).size, cards.length);
  const beforeNew = events().filter(event => event.event === "main-ready").length;
  await control("main-new");
  await wait("Main session switch reclaims child", () => events().filter(event => event.event === "main-ready").length > beforeNew);
  assert.equal((await control("snapshot")).childMode, "disposed");
  send("\x05\x15/internals\r"); await wait("native internals command", async () => !!(await control("internals-report")));
  const internalsReport = await control("internals-report");
  assert.ok(!internalsReport.details.includes("缺失 (") && !internalsReport.details.includes("调用失败 ("));
  writeFileSync(join(root, "native-internals-report.txt"), internalsReport.details); shot("main-internals");
  assert.deepEqual(await control("internals", { label: "main-final" }), { cc: [] });
  result = { passed: true, pid: child.pid, baseline, warmBaseline, afterCycles, final: await control("snapshot"), delivery, cards, backgroundRuns, headlessAbort, headlessAbortReceipt, enterMs: metrics, root };
  send("\x15/quit\r"); await Promise.race([child.exited, delay(8000)]); assert.equal(child.exitCode, 0);
  await delay(50);
  result.terminalState = finalTerminalState(); assert.deepEqual(result.terminalState, { bracketedPaste: false, cursorVisible: true });
  }
  }
  }
  }
} catch (error) { writeFileSync(join(root, "terminal-before-cleanup.raw"), raw); shot("failure"); result = { passed: false, error: String(error), stack: error.stack, events: events().slice(-25), root }; process.exitCode = 1; }
finally {
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, delay(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  child.terminal?.close(); term.dispose(); writeFileSync(join(root, "terminal.raw"), raw); writeFileSync(join(root, "stderr.txt"), await stderr);
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: result?.passed, error: result?.error, mode: result?.mode, elapsedMs: result?.elapsedMs, root }));
}
