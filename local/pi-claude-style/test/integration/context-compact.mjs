// bun test/integration/context-compact.mjs /path/to/stock/pi
// Copies the repository statusline asset into an isolated profile; never edits it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const here = dirname(fileURLToPath(import.meta.url)), pkg = resolve(here, "../..");
const binary = process.argv[2] ?? process.env.PI_BINARY;
assert.ok(binary, "pass a stock Pi binary");
assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), "1.5.0");
const artifacts = process.env.CC_CONTEXT_COMPACT_ARTIFACTS ?? mkdtempSync(join(tmpdir(), "cc-context-compact-"));
const statusline = process.env.CC_CONTEXT_STATUSLINE ?? fileURLToPath(new URL("../../../../assets/statusline.mjs", import.meta.url));
const patch = process.env.CC_CONTEXT_STATUSLINE_PATCH;
const readLines = (path) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];

for (const custom of [false, true]) {
  const markedEstimate = process.env.CC_CONTEXT_STATUSLINE === undefined || Boolean(custom && patch);
  const root = join(artifacts, custom ? "custom" : "native");
  for (const dir of ["home/.config", "agent/pi-session-compact", "cwd"]) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(statusline, join(root, "statusline.mjs"));
  // The native run proves unchanged legacy commands consume the new value.
  // The custom run also validates the separately delivered opt-in marker patch.
  if (custom && patch) execFileSync("patch", ["--batch", "--forward", "statusline.mjs", patch], { cwd: root });
  writeFileSync(join(root, "command.cjs"), `const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
fs.appendFileSync(${JSON.stringify(join(root, "payloads.jsonl"))}, input+'\\n');
const result=require('node:child_process').spawnSync(${JSON.stringify(join(root, "statusline.mjs"))},[],{input,encoding:'utf8'});
process.stdout.write(result.stdout??'');process.exitCode=result.status??1;});`);
  writeFileSync(join(root, "agent/settings.json"), JSON.stringify({ quietStartup: true, cacheWarming: "off",
    compaction: { enabled: false, reserveTokens: 20_000, keepRecentTokens: 50 },
    statusLine: { type: "command", command: `node '${join(root, "command.cjs")}'`, debounceMs: 10, timeoutMs: 5000 } }));
  writeFileSync(join(root, "agent/pi-session-compact/config.json"), JSON.stringify({ calibration: false,
    smallModel: { provider: "context-fixture", id: "small", effort: "off" }, outputTokens: 8192, summaryTokens: 12000 }));
  const term = new xterm.Terminal({ cols: 150, rows: 36, allowProposedApi: true });
  let raw = "", proc;
  const screen = () => Array.from({ length: term.rows }, (_, row) => term.buffer.active
    .getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? "").join("\n");
  const payloads = () => readLines(join(root, "payloads.jsonl"));
  const events = () => readLines(join(root, "events.jsonl"));
  const wait = async (label, predicate, timeout = 45000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (predicate()) return;
      assert.equal(proc.exitCode, null, `exited: ${label}\n${screen()}`);
      await delay(25);
    }
    assert.fail(`timeout: ${label}\n${screen()}`);
  };
  const send = async (text) => { proc.terminal.write(text); await delay(40); proc.terminal.write("\r"); };
  const snapshot = (name) => writeFileSync(join(root, `${name}.txt`), screen());
  const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/.config"),
    PI_CODING_AGENT_DIR: join(root, "agent"), MY_PI_STATUSLINE_CACHE_DIR: join(root, "statusline-cache"), PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", CC_CONTEXT_COMPACT_ROOT: root };
  for (const key of ["TMUX", "TMUX_PANE", "STY", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM",
    "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE", "ITERM_SESSION_ID", "WT_SESSION"]) delete env[key];
  try {
    proc = Bun.spawn({ cmd: [binary, "--offline", "--approve", "--no-extensions", "--no-skills", "--no-context-files",
      "--no-prompt-templates", "--no-themes", "--tui-mode", "fullscreen", "--session", join(root, "session.jsonl"),
      "--provider", "context-fixture", "--model", "main", "--thinking", "off", "--api-key", "offline",
      "--extension", join(here, "context-compact-fixture.mjs"), "--extension", join(pkg, "dist/index.ts"),
      ...(custom ? ["--extension", resolve(pkg, "../pi-session-compact/index.ts")] : [])],
      cwd: join(root, "cwd"), env, stdin: "ignore", stderr: "pipe",
      terminal: { cols: 150, rows: 36, data: (_pty, bytes) => { raw += Buffer.from(bytes).toString(); term.write(bytes); } } });
    const stderr = new Response(proc.stderr).text();
    await wait("first frame", () => payloads().length > 0);
    await send("BEFORE_COMPACT");
    await wait("business idle", () => events().some((e) => e.event === "idle"));
    await wait("old usage visible", () => screen().includes("[220k/1M] 22%") && screen().includes("CH:"));
    snapshot("before");
    const beforeRequests = events().filter((e) => e.event === "request").length;
    await send("/compact");
    await wait("compaction committed", () => events().some((e) => e.event === "compact"));
    await wait("estimate payload", () => payloads().at(-1)?.context_window.usage_source === "estimate");
    const estimate = payloads().at(-1);
    assert.equal(estimate.context_window.cache, null);
    assert.ok(estimate.context_window.current_usage.input_tokens < 10000);
    await wait("fresh estimate visible", () => !screen().includes("[220k/1M]")
      && screen().includes(markedEstimate ? "~0%" : "0%") && !screen().includes("CH:"));
    snapshot("compacted");
    const compactEvent = events().find((e) => e.event === "compact");
    assert.equal(Boolean(compactEvent.fromHook), custom, "exercise the intended compaction path");
    assert.ok(events().filter((e) => e.event === "request").length > beforeRequests);
    assert.ok(events().some((e) => e.event === "request" && e.kind === (custom ? "custom" : "native")));
    await send("/reload");
    const previous = payloads().length;
    await wait("reload estimate", () => payloads().length > previous && payloads().at(-1).context_window.usage_source === "estimate");
    await wait("reload frame", () => screen().includes(markedEstimate ? "~0%" : "0%"));
    snapshot("reloaded");
    await send("/fixture-before");
    await wait("old branch frame", () => screen().includes("[220k/1M] 22%") && screen().includes("CH:"));
    snapshot("tree-before");
    await send("/fixture-after");
    await wait("compacted branch frame", () => !screen().includes("[220k/1M]")
      && screen().includes(markedEstimate ? "~0%" : "0%") && !screen().includes("CH:"));
    snapshot("tree-after");
    await send("AFTER_COMPACT");
    await wait("real usage resumes", () => screen().includes("[50k/1M] 5%") && screen().includes("CH:") && !screen().includes("~0%"));
    assert.equal(payloads().at(-1).context_window.usage_source, "usage");
    snapshot("reply");
    await send("/internals");
    await wait("internals panel", () => screen().includes("▸ internals"));
    assert.doesNotMatch(screen(), /缺失|调用失败/);
    await send("/fixture-diagnostics");
    await wait("full internals", () => existsSync(join(root, "internals.txt")));
    assert.doesNotMatch(readFileSync(join(root, "internals.txt"), "utf8"), /缺失|调用失败|missing internals/);
    proc.terminal.write("\x04");
    await wait("clean exit", () => proc.exitCode !== null, 15000);
    assert.equal(proc.exitCode, 0);
    assert.equal(await stderr, "");
    results.push({ custom, markedEstimate, estimatedTokens: estimate.context_window.current_usage.input_tokens,
      beforeTokens: 220000, afterReplyTokens: 50000, requests: events().filter((e) => e.event === "request"), realRequests: 0 });
  } finally {
    if (proc?.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; }
    proc?.terminal?.close(); term.dispose();
    writeFileSync(join(root, "terminal.raw"), raw);
  }
}
writeFileSync(join(artifacts, "result.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ artifacts, results }, null, 2));
