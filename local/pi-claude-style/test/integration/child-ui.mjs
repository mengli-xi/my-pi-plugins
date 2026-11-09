import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const binary = process.argv[2] ?? process.env.PI_BINARY;
if (!binary) throw new Error("usage: npm run test:child-ui -- /path/to/pi-next-binary");
const artifactRoot = process.env.CC_CHILD_UI_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "cc-child-ui-"));
async function runScenario(scenario) {
const root = join(artifactRoot, scenario);
const nativeUser = scenario === "native-user";
mkdirSync(root, { recursive: true });
const home = join(root, "home"); mkdirSync(home, { recursive: true });
const agentDir = join(root, "agent"); mkdirSync(agentDir, { recursive: true });
// Seed the persisted input before either production factory reads it. The
// fixture needs no ConfigService instance shared with Main or the child bundle.
const ccConfigDir = join(agentDir, "extensions/pi-claude-style"); mkdirSync(ccConfigDir, { recursive: true });
writeFileSync(join(ccConfigDir, "config.json"), JSON.stringify({ schemaVersion: 6, revision: 0, overrides: {
  transcript: {
    assistantMessages: { collapsedThinking: "activity", hideCodeFenceMarkers: true,
      ...(nativeUser ? { typewriter: { enabled: false } } : {}) },
    ...(nativeUser ? { userMessages: { style: "native" } } : {}),
  },
} }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], statusLine: {
  type: "command", command: "cat >/dev/null; printf '[[pi:slot:model]] [[pi:slot:effort]]\\n'", debounceMs: 10,
} }));
const term = new xterm.Terminal({ cols: 112, rows: 38, allowProposedApi: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let raw = "";
const child = Bun.spawn({ cmd: [binary, "--mode", "rpc", "--offline", "--no-session", "--approve", "--no-extensions", "-e", join(dirname(fileURLToPath(import.meta.url)), "child-ui-fixture.mjs")],
  cwd: root,
  env: { ...process.env, HOME: home, PI_CHILD_RUNTIME_TARGET: "invalid-test-env", CC_CHILD_UI_SCENARIO: scenario, CC_CHILD_UI_ROOT: root, PI_CODING_AGENT_DIR: agentDir, PI_NEXT_AGENT_DIR: agentDir, PI_OFFLINE: "1", TERM: "xterm-256color" },
  stdin: "ignore", stderr: "pipe", terminal: { cols: 112, rows: 38, data: (_pty, data) => {
    raw += Buffer.from(data).toString(); term.write(data);
  } } });
const stderr = new Response(child.stderr).text();
const events = () => existsSync(join(root, "events.jsonl"))
  ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const screen = () => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
const send = (data) => child.terminal.write(data);
const mouseClicks = [];
let lastMouseAt = 0;
async function wait(label, condition, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (condition()) return;
    if (child.exitCode !== null) throw new Error(`process exited ${child.exitCode}: ${label}\n${JSON.stringify(events().at(-1))}`);
    await delay(25);
  }
  throw new Error(`timeout: ${label}\n${screen()}`);
}
function capture(name) { writeFileSync(join(root, `${name}.txt`), screen()); }
async function clickText(token, label) {
  // Separate single-click actions: Pi treats the same word within 500 ms as
  // a selection double-click, which intentionally does not activate its row.
  await delay(Math.max(0, 550 - (Date.now() - lastMouseAt)));
  await wait(`${label} visible target`, () => screen().includes(token));
  // Wait for the emitted frame to settle, then take fresh screen coordinates.
  await delay(100);
  const lines = screen().split("\n"); const row = lines.findIndex((line) => line.includes(token));
  assert.ok(row >= 0, `${label} disappeared`);
  const column = lines[row].indexOf(token) + 3;
  send(`\x1b[<0;${column};${row + 1}M`); await delay(25);
  send(`\x1b[<0;${column};${row + 1}m`);
  lastMouseAt = Date.now();
  return { label, token, row: row + 1, column };
}
async function switchTo(role) {
  const count = events().filter((event) => event.event === "attached" && event.role === role).length;
  send("\x1b/");
  await wait(`attach ${role}`, () => events().filter((event) => event.event === "attached" && event.role === role).length > count);
  await delay(100);
}
async function panel(role) {
  const count = events().filter((event) => event.event === "panel-closed" && event.role === role).length;
  send("\x15/fixture-panel\r");
  await wait(`${role} overlay`, () => screen().includes("FIXTURE_PANEL"));
  // Stay outside both the centered panel and any top-row sticky overlay.
  send("\x1b[<0;112;38M\x1b[<0;112;38m");
  await wait(`${role} outside click`, () => events().filter((event) => event.event === "panel-closed" && event.role === role).length > count);
  send("/fixture-pan"); await wait(`${role} completion`, () => screen().includes("fixture-panel")); await delay(100);
  const inspections = events().filter((event) => event.event === "inspection" && event.role === role).length;
  send("\x1bi");
  await wait(`${role} frame`, () => events().filter((event) => event.event === "inspection" && event.role === role).length > inspections);
  const inspected = events().filter((event) => event.event === "inspection" && event.role === role).at(-1);
  assert.equal(inspected.text, "/fixture-pan"); assert.equal(inspected.floating, true);
  send("\x1b"); await delay(50); send("\x15"); await delay(50);
}
async function fences(role) {
  await wait(`${role} live Thinking code`, () => screen().includes("const thinkingFence = 1;"));
  await delay(100);
  assert.ok(!screen().includes("```"), `${role}: hidden Thinking fences leaked`);
  capture(`${role}-thinking-fence`);
}
async function lazy(role, replace = true) {
  const requests = events().filter((event) => event.event === "lazy-request" && event.role === role).length;
  send("/fixture-lazy\r");
  await wait(`${role} lazy request`, () => events().filter((event) => event.event === "lazy-request" && event.role === role).length > requests);
  const token = events().filter((event) => event.event === "lazy-request" && event.role === role).at(-1).token;
  await wait(`${role} lazy render`, () => screen().includes(`LAZY_SUMMARY_${token}`));
  const click = async () => {
    const count = events().filter((event) => event.event === "lazy-click" && event.role === role).length;
    send("\x1bl");
    await wait(`${role} lazy click`, () => events().filter((event) => event.event === "lazy-click" && event.role === role).length > count);
    assert.equal(events().filter((event) => event.event === "lazy-click" && event.role === role).at(-1).clicked, true);
    await wait(`${role} own lazy body`, () => screen().includes(`LAZY_BODY_${token}`));
    assert.ok(!screen().includes(`LAZY_BODY_${role === "main" ? "CHILD" : "MAIN"}`));
    capture(`${role}-lazy-body`); send("\x1b"); await delay(100);
  };
  await click();
  if (replace) {
    send("\x1br"); await delay(50);
    // No redraw between provider replacement and click: current() must create
    // its replacement CC component inside the delegate's click owner scope.
    await click();
    send("\x1br"); await delay(50);
  }
}
async function cold(role) {
  const count = events().filter((event) => event.event === "cold-first-render" && event.role === role).length;
  send("/fixture-cold\r");
  await wait(`${role} idle custom first render`, () => events().filter((event) => event.event === "cold-first-render" && event.role === role).length > count);
  const event = events().filter((event) => event.event === "cold-first-render" && event.role === role).at(-1);
  assert.equal(event.extensionMessageStarts, 0, "exercise the real idle path without extension message_start");
  const first = event.first.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(first.includes("▸ fork-update") && first.includes(`COLD_BODY_${role.toUpperCase()}`), first);
  const clicks = events().filter((event) => event.event === "command-details-click" && event.role === role).length;
  send("\x1bd");
  await wait(`${role} command details click`, () => events().filter((event) => event.event === "command-details-click" && event.role === role).length > clicks);
  assert.equal(events().filter((event) => event.event === "command-details-click" && event.role === role).at(-1).clicked, true);
  await wait(`${role} command details`, () => screen().includes(`COMMAND_DETAILS_${role.toUpperCase()}`));
  capture(`${role}-command-details`); send("\x1b"); await delay(80);
}
async function frozen(role) {
  const count = events().filter((event) => event.event === "frozen-custom" && event.role === role).length;
  send("/fixture-frozen\r");
  await wait(`${role} frozen custom`, () => events().filter((event) => event.event === "frozen-custom" && event.role === role).length > count);
  const event = events().filter((event) => event.event === "frozen-custom" && event.role === role).at(-1);
  assert.equal(event.unchanged, true, "CC must not change third-party methods");
  assert.equal(event.invalidated, true);
  assert.deepEqual(event.first, ["", event.token]);
  assert.deepEqual(event.afterInvalidate, event.first);
  assert.equal(event.entryInvalidated, true);
  assert.deepEqual(event.entryRows.filter(Boolean), [event.entryToken]);
  assert.deepEqual(event.entryAfter, event.entryRows);
  assert.deepEqual(event.unownedRows, ["UNOWNED_NATIVE_FALLBACK"]);
  assert.equal(event.unownedClick, false);
  await wait(`${role} frozen row visible`, () => screen().includes(event.token));
  capture(`${role}-frozen-custom`);
}
async function profile(role, history = false) {
  const eventName = history ? "profile-entry-history" : "profile-entry";
  for (const name of ["skills", "skills-legacy", "skills-read", "processes", ...(history ? [] : ["legacy", "completion"])]) {
    const before = events().filter((event) => event.event === eventName && event.role === role).length;
    send((history ? `/fixture-history-entry-${name}` : name === "legacy" ? "/fixture-process-message" : name === "completion" ? "/fixture-completion-message" : `/fixture-entry-${name}`) + "\r");
    await wait(`${role} ${name} ${history ? "restore" : "append"}`, () => events().filter((event) => event.event === eventName && event.role === role).length > before);
    const entry = events().filter((event) => event.event === eventName && event.role === role).at(-1);
    const token = entry.token;
    if (history) assert.ok(entry.rows.join("\n").includes(token), JSON.stringify(entry));
    else await wait(`${role} ${name} real render`, () => screen().includes(token));
    const click = async () => {
      let mouse;
      if (history) {
        const count = events().filter((event) => event.event === "profile-click" && event.role === role).length;
        send("\x1be");
        await wait(`${role} ${name} click`, () => events().filter((event) => event.event === "profile-click" && event.role === role).length > count);
        assert.equal(events().filter((event) => event.event === "profile-click" && event.role === role).at(-1).clicked, true);
      } else mouse = await clickText(token, `${role} ${name} SGR click`);
      await wait(`${role} ${name} own body`, () => screen().includes(`ENTRY_BODY_${token}`));
      if (mouse) mouseClicks.push({ ...mouse, role, body: `ENTRY_BODY_${token}`, opened: true });
      capture(`${role}-profile-${name}`); send("\x1b"); await delay(80);
    };
    await click();
    send("\x1br"); await delay(30); await click(); send("\x1br"); await delay(30);
  }
  if (history) return;
  send("/fixture-mailbox\r");
  await wait(`${role} mailbox`, () => screen().includes(`MAILBOX_${role.toUpperCase()}`));
  const hidden = events().filter((event) => event.event === "hidden-entry" && event.role === role).length;
  send("/fixture-hidden-entry\r");
  await wait(`${role} hidden metadata`, () => events().filter((event) => event.event === "hidden-entry" && event.role === role).length > hidden);
  assert.equal(events().filter((event) => event.event === "hidden-entry" && event.role === role).at(-1).unchanged, true);
  const tools = events().filter((event) => event.event === "process-tool-render" && event.role === role).length;
  send("/fixture-process-tool\r");
  await wait(`${role} real Process tool renderer`, () => events().filter((event) => event.event === "process-tool-render" && event.role === role).length > tools);
  const rows = events().filter((event) => event.event === "process-tool-render" && event.role === role).at(-1).rows.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const nativeRows = events().filter((event) => event.event === "process-tool-render" && event.role === role).at(-1).nativeRows.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(nativeRows.includes("Process list") && nativeRows.includes("Process operation completed"), nativeRows);
  assert.ok(rows.includes("Listing processes"), rows);
  send("/fixture-clear-tool\r"); await delay(60);
  send("/fixture-notices\r");
  await wait(`${role} notices`, () => ["INFO", "WARNING", "ERROR"].every((level) => screen().includes(`NOTICE_${level}_${role.toUpperCase()}`)));
  capture(`${role}-notices`);
  const transforms = events().filter((event) => event.event === "transform-render" && event.role === role).length;
  send("/fixture-transform\r");
  await wait(`${role} native user transform`, () => events().filter((event) => event.event === "transform-render" && event.role === role).length > transforms);
  const transformed = events().filter((event) => event.event === "transform-render" && event.role === role).at(-1).rows.join("\n");
  assert.ok(transformed.includes("[Image #1]") && !transformed.includes("pi-clipboard-"), transformed);
  capture(`${role}-markdown-transform`); send("/fixture-clear-transform\r"); await delay(60);
  await nativeComponents(role);
}
async function nativeComponents(role) {
  const before = events().filter((event) => event.event === "native-summaries" && event.role === role).length;
  send("/fixture-summaries\r");
  await wait(`${role} native expanded summaries`, () => events().filter((event) => event.event === "native-summaries" && event.role === role).length > before);
  const event = events().filter((event) => event.event === "native-summaries" && event.role === role).at(-1);
  for (const name of ["compaction", "branch", "skill"]) {
    assert.ok(event.native[name].join("\n").includes("```"), `${name} native fallback must retain fences`);
    // CC hides fences only in assistant prose and its own thinking/Activity views.
    for (const rows of Object.values(event.rows[name])) {
      const text = rows.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      assert.ok(text.includes(`const nativeFence = "${role}-${name}";`), text);
      assert.ok(text.includes("```"), text);
    }
  }
  await wait(`${role} native summary visible`, () => screen().includes("nativeFence")); capture(`${role}-native-summaries`);
  send("/fixture-clear-summaries\r"); await delay(80);
  const contracts = events().filter((event) => event.event === "mouse-contract" && event.role === role).length;
  send("/fixture-mouse-contract\r");
  await wait(`${role} native mouse forwarding`, () => events().filter((event) => event.event === "mouse-contract" && event.role === role).length > contracts);
  for (const record of events().filter((event) => event.event === "mouse-contract" && event.role === role).at(-1).records) {
    if (record.type) assert.equal(record.unhandled, true, JSON.stringify(record));
    else {
      assert.equal(record.forwarded, true, JSON.stringify(record)); assert.equal(record.frozen, true);
      assert.deepEqual(record.clicks, [], "a native handleMouse must never fall through to legacy handleClick");
      assert.deepEqual(record.events, record.result ? ["click"] : ["click", "press", "drag", "release", "wheel", "move", "click"]);
    }
  }
  await componentContract(role);
}
async function componentContract(role) {
  const count = events().filter((event) => event.event === "component-contract" && event.role === role).length;
  send("/fixture-component-contract\r");
  await wait(`${role} Component member parity`, () => events().filter((event) => event.event === "component-contract" && event.role === role).length > count);
  assert.ok(events().filter((event) => event.event === "component-contract" && event.role === role).at(-1).records.every((record) => record.equivalent));
  const accessors = events().filter((event) => event.event === "accessor-contract" && event.role === role).length;
  send("/fixture-accessor-contract\r");
  await wait(`${role} accessor descriptor parity`, () => events().filter((event) => event.event === "accessor-contract" && event.role === role).length > accessors);
  const rows = events().filter((event) => event.event === "accessor-rows" && event.role === role).length;
  send("/fixture-accessor-rows\r");
  await wait(`${role} accessor renderer append`, () => events().filter((event) => event.event === "accessor-rows" && event.role === role).length > rows);
  const tokens = events().filter((event) => event.event === "accessor-rows" && event.role === role).at(-1).tokens;
  await wait(`${role} real CC fullscreen accessor frame`, () => tokens.every((token) => screen().includes(token)));
  await delay(100); capture(`${role}-accessor-frame`);
  const frames = events().filter((event) => event.event === "accessor-frame" && event.role === role).length;
  send("/fixture-accessor-verify\r");
  await wait(`${role} restored accessor sources`, () => events().filter((event) => event.event === "accessor-frame" && event.role === role).length > frames);
  for (const kind of ["entry", "message"]) {
    const before = events().filter((event) => event.event === "focus-case" && event.role === role).length;
    send(`/fixture-focus-${kind}\r`);
    await wait(`${role} ${kind} focus fixture`, () => events().filter((event) => event.event === "focus-case" && event.role === role).length > before);
    const token = events().filter((event) => event.event === "focus-case" && event.role === role).at(-1).token;
    await clickText(`FOCUS_NATIVE_${token}`, `${role} ${kind} native focus`); send("q");
    await wait(`${role} ${kind} native keyboard`, () => screen().includes(`FOCUS_NATIVE_${token} focused=true input=q`));
    await clickText(`FOCUS_CC_${token}`, `${role} ${kind} CC focus`); send("r");
    await wait(`${role} ${kind} CC keyboard`, () => screen().includes(`FOCUS_CC_${token} focused=true input=r`));
    await wait(`${role} ${kind} native blur`, () => screen().includes(`FOCUS_NATIVE_${token} focused=false input=q`));
    await clickText("❯", `${role} ${kind} editor focus`);
    const states = events().filter((event) => event.event === "focus-state" && event.role === role).length;
    send("\x1bv");
    await wait(`${role} ${kind} focus state`, () => events().filter((event) => event.event === "focus-state" && event.role === role).length > states);
    const state = events().filter((event) => event.event === "focus-state" && event.role === role).at(-1);
    assert.deepEqual(state.native, { focused: false, text: "q" }); assert.deepEqual(state.cc, { focused: false, text: "r" });
    capture(`${role}-${kind}-focus`); send("/fixture-clear-focus\r"); await delay(80);
    const delegated = events().filter((event) => event.event === "delegate-row" && event.role === role).length;
    send(`/fixture-delegate-${kind}\r`);
    await wait(`${role} ${kind} delegate row`, () => events().filter((event) => event.event === "delegate-row" && event.role === role).length > delegated);
    const item = events().filter((event) => event.event === "delegate-row" && event.role === role).at(-1);
    await clickText(item.token, `${role} ${kind} delegate SGR`);
    await wait(`${role} ${kind} delegate body`, () => screen().includes(`DELEGATE_BODY_${item.token}`));
    assert.equal(events().filter((event) => event.event === "delegate-row-click" && event.role === role).at(-1).focusWasFacade, false);
    capture(`${role}-${kind}-delegate`); send("\x1b"); await delay(80);
  }
}
async function nativePanels(role) {
  const count = events().filter((event) => event.event === "session-report-request" && event.role === role).length;
  send("\x1bs");
  await wait(`${role} session submit`, () => events().filter((event) => event.event === "session-report-request" && event.role === role).length > count);
  const id = events().filter((event) => event.event === "session-report-request" && event.role === role).at(-1).sessionId;
  await wait(`${role} native session info`, () => screen().includes("Session info") && screen().includes(id));
  capture(`${role}-session-info`); send("\x1b"); await delay(80);
  if (role === "main") {
    send("\x1bm"); await wait("Main model selector", () => screen().includes("Enter select") && screen().includes("fixture-faux"));
    capture("main-model-selector"); send("\x1b"); await delay(80);
  }
}
async function image(role) {
  send(`IMAGE_${role.toUpperCase()}\r`);
  await wait(`${role} image read response`, () => new RegExp(`${role.toUpperCase()} CC_RESPONSE.*IMAGE_${role.toUpperCase()}`).test(screen()));
  await wait(`${role} CC image action`, () => screen().includes("View Image"));
  capture(`${role}-image-read`);
  await clickText("View Image", `${role} image preview`);
  await wait(`${role} real image preview`, () => screen().includes("▣ Image"));
  capture(`${role}-image-preview`); send("\x1b"); await delay(80);
}
let result;
try {
  await wait("ready", () => events().some((event) => event.event === "ready"));
  send("MAIN_FIRST\r");
  await fences("main");
  await wait("Main CC response", () => screen().includes("MAIN CC_RESPONSE") && screen().includes("complete."));
  assert.equal(screen().includes("╭ user"), !nativeUser);
  assert.ok(screen().includes("Read 1 file") && screen().includes("● MAIN CC_RESPONSE"));
  await lazy("main"); await cold("main"); await frozen("main");
  await profile("main"); await nativePanels("main"); await image("main");
  send("\x1bz"); await wait("Main native reload", () => events().some((event) => event.event === "main-reloaded"));
  await delay(100); await profile("main", true);
  await panel("main"); capture("main-cc");
  send("MAIN_DRAFT_"); await delay(100);
  await switchTo("child");
  send("CHILD_FIRST\r");
  await fences("child");
  await wait("child CC response", () => screen().includes("CHILD CC_RESPONSE") && screen().includes("complete."));
  assert.equal(screen().includes("╭ user"), !nativeUser);
  assert.ok(screen().includes("Read 1 file") && screen().includes("● CHILD CC_RESPONSE"));
  await lazy("child"); await cold("child"); await frozen("child");
  await profile("child"); await nativePanels("child"); await image("child");
  assert.ok(screen().includes("fixture-child") && screen().includes("Alt+/ Main") && screen().includes("❯"));
  capture("child-cc"); await panel("child");
  send("/fixture-background\r");
  await wait("Main streaming in child foreground", () => events().some((event) => event.event === "main-background-stream"));
  await delay(400); capture("child-with-main-stream");
  assert.ok(!screen().includes("BACKGROUND_MAIN"));
  send("CHILD_DRAFT_"); await delay(50);
  await switchTo("main");
  assert.equal(events().filter((event) => event.event === "attached" && event.role === "main").at(-1).draft, "MAIN_DRAFT_");
  await wait("Main live CC thinking", () => screen().includes("MAIN thinking"));
  assert.ok(!screen().includes("CHILD thinking"));
  capture("main-background-live");
  await wait("Main background CC render", () => events().some((event) => event.event === "background-complete")
    && /MAIN CC_RESPONSE.*BACKGROUND_MAIN/.test(screen()));
  capture("main-after-background");
  for (let index = 0; index < 10; index++) {
    send("X"); await delay(50); await switchTo("child");
    assert.equal(events().filter((event) => event.event === "attached" && event.role === "child").at(-1).draft, "CHILD_DRAFT_");
    await switchTo("main");
    assert.equal(events().filter((event) => event.event === "attached" && event.role === "main").at(-1).draft, "MAIN_DRAFT_" + "X".repeat(index + 1));
  }
  send("\x15"); await panel("main");
  await switchTo("child"); send("\x15"); await panel("child"); await switchTo("main");
  send("\x1bi"); await delay(100);
  assert.ok(events().filter((event) => event.event === "view-detached").every((event) => event.geometryReleased));
  assert.ok(events().filter((event) => event.event === "inspection" && event.role === "main").every((event) => event.patchesPreserved));
  assert.ok(events().filter((event) => event.event === "attached" && event.role === "child").length >= 12);
  send("/fixture-package-notice\r");
  await wait("Main package update notification", () => screen().includes("Package Updates Available") && screen().includes("fixture-package-update"));
  capture("main-package-update");
  send("AFTER_CHILD_RELEASE\r");
  await wait("Main still renders after child release", () => /MAIN CC_RESPONSE.*AFTER_CHILD_RELEASE/.test(screen()));
  capture("main-restored"); await nativePanels("main"); send("/fixture-release-main\r");
  await wait("Main released before child", () => events().some((event) => event.event === "main-released"));
  assert.equal(events().find((event) => event.event === "main-released").childProviderAlive, true);
  await lazy("child"); await cold("child"); await frozen("child");
  await profile("child"); await nativePanels("child");
  capture("child-after-main-release"); send("/fixture-finish\r");
  await Promise.race([child.exited, delay(10000)]); assert.equal(child.exitCode, 0);
  assert.equal(events().find((event) => event.event === "finished").providersReleased, true);
  // Six live MC clicks retired with its production renderer fixture; every
  // remaining Skills/Processes/Subagents/delegate click is still required.
  assert.equal(mouseClicks.length, 36, "all live profile renderer cases must use physical mouse clicks");
  // Native user style intentionally leaves UserMessageComponent unpatched.
  assert.ok(events().filter((event) => event.event === "host-identities").every((event) =>
    event.owners.length > 0 && event.owners.every((owner) => owner.assistant && (nativeUser || owner.user))),
    "Main and child must patch the actual SDK host component identities");
  assert.equal(events().filter((event) => event.event === "native-summaries").length, 3);
  assert.equal(events().filter((event) => event.event === "mouse-contract").length, 3);
  assert.equal(events().filter((event) => event.event === "component-contract").length, 3);
  assert.equal(events().filter((event) => event.event === "focus-state").length, 6);
  assert.equal(events().filter((event) => event.event === "accessor-contract").length, 3);
  assert.equal(events().filter((event) => event.event === "accessor-frame").length, 3);
  result = { passed: true, root, profileMouseClicks: mouseClicks.length, childConstructions: events().filter((event) => event.event === "attached" && event.role === "child").length };
} catch (error) { capture("failure"); result = { passed: false, root, error: String(error) }; process.exitCode = 1; }
finally {
  if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  child.terminal?.close(); term.dispose();
  writeFileSync(join(root, "terminal.raw"), raw);
  writeFileSync(join(root, "mouse-clicks.json"), JSON.stringify(mouseClicks, null, 2));
  writeFileSync(join(root, "stderr.txt"), await stderr);
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
return result;
}
const results = [];
for (const scenario of ["styled-user", "native-user"]) results.push(await runScenario(scenario));
writeFileSync(join(artifactRoot, "result.json"), JSON.stringify({ passed: results.every((result) => result.passed), results }, null, 2));
