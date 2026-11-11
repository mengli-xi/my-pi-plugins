// PI_BIN=/path/to/stock/pi bun test/integration/main-statusline.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { installedPiVersion, piBin } from "../../../../scripts/pi-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const binary = piBin();
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), installedPiVersion());
const artifacts = process.env.CC_MAIN_STATUSLINE_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "cc-main-statusline-"));
mkdirSync(artifacts, { recursive: true });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const marker = "\x1b]777;cc-main-session-start\x07";
const endMarker = "\x1b]777;cc-main-session-end\x07";
const commit = "\x1b[?2026l";
const results = [];

for (const scenario of ["failure", "timeout", "success-then-failure", "success"]) {
  const root = join(artifacts, scenario);
  for (const child of ["home/.config", "agent", "cwd/.pi"]) mkdirSync(join(root, child), { recursive: true });
  const mode = join(root, "mode");
  const calls = join(root, "calls");
  const script = join(root, "statusline.sh");
  writeFileSync(mode, scenario === "timeout" || scenario === "failure" ? scenario : "success-1");
  // Drain the payload and read mode with shell builtins. The deadline
  // starts at spawn, not at the first script statement: the old 300ms budget
  // could expire during shell/cat startup and kill an invocation before it
  // reached `calls`. Use the same 5s budget as the other host scenarios;
  // `sleep 30` still guarantees a real timeout followed by the existing retry.
  writeFileSync(script, `#!/bin/sh
while IFS= read -r line; do :; done
IFS= read -r mode <'${mode}' || :
printf '%s %s\\n' "$mode" "$$" >>'${calls}'
case "$mode" in
  timeout) sleep 30 ;;
  failure) exit 1 ;;
  empty) exit 0 ;;
  success-*) printf 'REAL_COMMAND %s [[pi:slot:model]] [[pi:slot:effort]]\\n[[pi:slot:cache-quality]]\\nthird\\n' "\${mode#success-}" ;;
esac
`);
  writeFileSync(join(root, "agent/settings.json"), JSON.stringify({ quietStartup: true,
    statusLine: { type: "command", command: `sh '${script}'`, debounceMs: 10, timeoutMs: 5000 },
  }));
  const term = new xterm.Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  const chunks = [];
  let raw = "", processHandle;
  const screen = () => Array.from({ length: term.rows }, (_, row) =>
    term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
  const events = () => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const commandCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
  const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/.config"),
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color",
    CC_MAIN_STATUSLINE_ROOT: root };
  for (const key of ["TMUX", "TMUX_PANE", "STY", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM",
    "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE", "ITERM_SESSION_ID", "WT_SESSION"]) delete env[key];
  const wait = async (label, predicate, timeout = 30000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (predicate()) return;
      assert.equal(processHandle.exitCode, null, `Pi exited before ${label}\n${screen()}`);
      await delay(25);
    }
    assert.fail(`timeout: ${label}\n${screen()}`);
  };
  const send = async (command) => {
    processHandle.terminal.write(command);
    await delay(50);
    processHandle.terminal.write("\r");
  };
  let stderr;
  try {
    processHandle = Bun.spawn({ cmd: [binary, "--offline", "--no-session", "--approve", "--no-extensions",
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--tui-mode", "fullscreen",
      "--provider", "fallback-fixture", "--model", "fallback-model", "--thinking", "off", "--api-key", "offline",
      "--extension", join(here, "main-statusline-fixture.mjs"), "--extension", join(packageRoot, "dist/index.ts")],
      cwd: join(root, "cwd"), env, stdin: "ignore", stderr: "pipe",
      terminal: { cols: 120, rows: 32, data: (_pty, bytes) => {
        const data = Buffer.from(bytes).toString(); raw += data; chunks.push({ at: Date.now(), data }); term.write(bytes);
      } },
    });
    stderr = new Response(processHandle.stderr).text();
    await wait("synchronous fallback", () => events().some((event) => event.event === "footer"));
    const firstFooter = events().find((event) => event.event === "footer");
    assert.match(firstFooter.lines[0], /fallback-model\(fallback-fixture\).*off/);
    assert.equal(firstFooter.lines.length, 2, "normal fallback has only two rows");
    assert.ok(!firstFooter.lines.join("\n").includes("REAL_COMMAND"), "first setter precedes any command output");
    await wait("first command invocation", () => commandCalls().length > 0);
    await wait("CP/MEM contributions", () => screen().includes("CP:0") && screen().includes("MEM:3"));
    if (scenario === "timeout") {
      await wait("retry invocation after the first timeout", () => commandCalls().length >= 2);
      await delay(800);
      assert.ok(!screen().includes("REAL_COMMAND"));
    } else if (scenario !== "failure") {
      await wait("real command output", () => screen().includes("REAL_COMMAND 1"));
    }
    await send("/fixture-contribute");
    await wait("live CP update", () => screen().includes("CP:1") && screen().includes("MEM:3"));
    writeFileSync(join(root, "contributed.txt"), screen());
    if (scenario === "failure") {
      // Use the real CC Todo semantic consumer/presenter and actual PTY mouse
      // dispatch, while no statusline command has ever succeeded.
      await send("/fixture-todo-active");
      await wait("active Todo count", () => screen().includes("todo 1/2"));
      writeFileSync(join(root, "todo-active.txt"), screen());
      await send("/fixture-todo-complete");
      await wait("completed Todo count", () => screen().includes("✓ todo 2/2") && !screen().includes("Second fallback task"));
      writeFileSync(join(root, "todo-complete.txt"), screen());
      const lines = screen().split("\n");
      const row = lines.findIndex((line) => line.includes("✓ todo 2/2"));
      const column = lines[row].indexOf("✓ todo 2/2") + 3;
      processHandle.terminal.write(`\x1b[<0;${column};${row + 1}M`);
      await delay(30);
      processHandle.terminal.write(`\x1b[<0;${column};${row + 1}m`);
      await wait("completed list reopened by footer click", () => screen().includes("Second fallback task"));
      writeFileSync(join(root, "todo-opened.txt"), screen());
      await send("/fixture-todo-clear");
      await wait("Todo withdrawn", () => !screen().includes("todo 2/2") && !screen().includes("Second fallback task"));
      writeFileSync(join(root, "todo-cleared.txt"), screen());
      assert.ok(commandCalls().every((line) => line.startsWith("failure ")));
      assert.ok(!screen().includes("REAL_COMMAND"));
    }
    if (scenario === "success-then-failure") {
      for (const next of ["failure", "empty", "timeout"]) {
        writeFileSync(mode, next);
        await send("/fixture-refresh");
        await wait(`${next} invocation`, () => commandCalls().some((line) => line.startsWith(`${next} `)));
        await delay(next === "timeout" ? 5500 : 500);
        assert.ok(screen().includes("REAL_COMMAND 1"), `${next}: retain last successful command output`);
        assert.ok(screen().includes("CP:1"));
        writeFileSync(join(root, `${next}.txt`), screen());
      }
    }
    if (scenario === "success") {
      // A startup retry may have been spawned before this explicit refresh.
      // Identify the requested output by its mode, not a sampled invocation
      // count (which could jump from 1 straight to 3 while a frame is pending).
      writeFileSync(mode, "success-2");
      await send("/fixture-refresh");
      await wait("new successful invocation", () => commandCalls().some(line => line.startsWith("success-2 ")));
      await wait("updated successful command output", () => screen().includes("REAL_COMMAND 2"));
    }
    // Exercise diagnostics in this same fresh Main without making a request.
    await send("/internals");
    await wait("internals", () => screen().includes("▸ internals"));
    writeFileSync(join(root, "internals.txt"), screen());
    assert.ok(!/缺失|调用失败/.test(screen()), screen());
    await send("/fixture-diagnostics");
    await wait("full internals", () => existsSync(join(root, "internals-full.txt")));
    const details = readFileSync(join(root, "internals-full.txt"), "utf8");
    assert.ok(!/缺失|调用失败/.test(details), details);
    await send("/fixture-end");
    await wait("intentional teardown boundary", () => events().some((event) => event.event === "end"));
    processHandle.terminal.write("\x04");
    assert.ok(await Promise.race([processHandle.exited.then(() => true), delay(15000).then(() => false)]), "Pi exits cleanly");
    assert.equal(processHandle.exitCode, 0);
    assert.equal(await stderr, "");
  } finally {
    if (processHandle?.exitCode === null) {
      // Let the production shutdown drain its command group on assertion failure.
      processHandle.terminal.write("\x1b\x04");
      if (!await Promise.race([processHandle.exited.then(() => true), delay(15000).then(() => false)])) {
        processHandle.kill("SIGKILL"); await processHandle.exited;
      }
    }
    processHandle?.terminal?.close();
    writeFileSync(join(root, "terminal.raw"), raw);
    writeFileSync(join(root, "chunks.json"), JSON.stringify(chunks));
    term.dispose();
  }
  // Replay every committed synchronized-output frame, including cold startup.
  // The stream marker gives an exact post-session_start boundary, independent
  // of PTY delivery timestamps. Pre-boundary native frames remain a known limit.
  const replay = new xterm.Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  const frames = [];
  let cursor = 0;
  for (let end = raw.indexOf(commit); end >= 0; end = raw.indexOf(commit, cursor)) {
    end += commit.length;
    await new Promise((done) => replay.write(raw.slice(cursor, end), done));
    const text = Array.from({ length: replay.rows }, (_, row) =>
      replay.buffer.active.getLine(replay.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
    frames.push({ postSessionStart: raw.indexOf(marker) >= 0 && end > raw.indexOf(marker)
      && (raw.indexOf(endMarker) < 0 || end < raw.indexOf(endMarker)),
      native: text.includes("thinking off"), text });
    cursor = end;
  }
  replay.dispose();
  writeFileSync(join(root, "frames.json"), JSON.stringify(frames, null, 2));
  const post = frames.filter((frame) => frame.postSessionStart);
  assert.ok(post.length > 0, "observe committed frames after session_start");
  assert.equal(post.filter((frame) => frame.native).length, 0, "no native footer after session_start");
  assert.ok(post.every((frame) => frame.text.includes("fallback-model(fallback-fixture)")),
    "every active-session frame retains CC content");
  const result = { scenario, postSessionStartFrames: post.length, postSessionStartNative: 0,
    coldStartupNative: frames.filter((frame) => !frame.postSessionStart && frame.native).length, commandCalls: commandCalls() };
  results.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(join(artifacts, "result.json"), JSON.stringify({ realProviderCalls: 0, results }, null, 2));
console.log(`artifacts: ${artifacts}`);
