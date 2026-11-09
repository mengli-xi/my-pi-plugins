// Real stock-host, offline CC history benchmark. Copies fixtures into a private
// temporary HOME; only numeric metrics leave that directory, never text/raw PTY.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [binary, extension, fixtures, out] = process.argv.slice(2);
if (!out) throw new Error("usage: bun scripts/measure-history.mjs <pi> <extension> <fixture-dir> <results.json>");
const delay = ms => new Promise(done => setTimeout(done, ms));
const work = mkdtempSync(join(tmpdir(), "cc-history-perf-"));
const results = [];
const sourceHash = createHash("sha256");
function hashTree(path, prefix = "") {
  for (const name of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + name.name;
    if (name.isDirectory()) hashTree(join(path, name.name), relative + "/");
    else if (name.isFile()) sourceHash.update(relative).update(readFileSync(join(path, name.name)));
  }
}
hashTree(dirname(resolve(extension)));
const buildHash = sourceHash.digest("hex");
let child;
const stop = async () => { if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } child?.terminal?.close(); child = undefined; };
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => { void stop().finally(() => { rmSync(work, { recursive: true, force: true }); process.exit(name === "SIGINT" ? 130 : 143); }); });
try {
  for (const file of readdirSync(fixtures).filter(name => name.endsWith(".jsonl"))) {
    const home = join(work, file.slice(-42, -6));
    const agent = join(home, "agent");
    for (const dir of [home, agent, join(agent, "sessions"), join(home, "work")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const session = join(agent, "sessions", file);
    copyFileSync(join(fixtures, file), session);
    chmodSync(session, 0o600);
    // Only the copied header's cwd changes; replay must never discover project
    // files from the user's original working directory.
    const copied = readFileSync(session, "utf8"), newline = copied.indexOf("\n");
    const header = JSON.parse(copied.slice(0, newline));
    header.cwd = join(home, "work");
    writeFileSync(session, JSON.stringify(header) + copied.slice(newline));
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ terminal: { showImages: false }, checkForUpdates: false, quietStartup: true }));
    const metrics = join(home, "metrics.jsonl");
    const events = () => existsSync(metrics) ? readFileSync(metrics, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const send = text => child.terminal.write(text);
    const terminal = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    child = Bun.spawn({ cmd: [binary, "--offline", "--session", session, "--approve", "--no-extensions", "--no-skills", "--no-context-files", "--no-themes", "--no-prompt-templates", "--tui-mode", "fullscreen", "--provider", "history-fixture", "--model", "offline", "--api-key", "offline", "--extension", resolve(extension), "--extension", join(root, "scripts/measure-history-extension.mjs")],
      cwd: join(home, "work"), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color", CC_HISTORY_METRICS: metrics, CC_HISTORY_STARTED: String(Date.now()) },
      stdin: "ignore", stdout: "ignore", stderr: "pipe", terminal: { cols: 120, rows: 40, data(_pty, data) { terminal.write(data); } } });
    const stderr = new Response(child.stderr).text();
    const wait = async (label, count = 1) => {
      const until = Date.now() + 60_000;
      while (events().filter(row => row.label === label).length < count) {
        if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}: ${(await stderr).slice(0, 500)}`);
        if (Date.now() > until) {
          const screen = Array.from({ length: 40 }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n");
          // Diagnostic is local to the private fixture copy and is deleted by
          // finally. Never publish it in the numeric report.
          writeFileSync(join(home, "diagnostic.txt"), screen);
          const known = [...screen.matchAll(/(?:Extension issues|Failed to[^\n]*|Error:[^\n]*|trust|Trust|Select a model|No models|Press Enter|session.*locked)/gu)].map(match => match[0]);
          throw new Error(`timeout ${label}: ${JSON.stringify(known)}`);
        }
        await delay(40);
      }
      return events().filter(row => row.label === label).at(-1);
    };
    await wait("opened");
    send("\x1b1"); await wait("before-scroll");
    for (let i = 0; i < 35; i++) { send("\x1b[<64;50;12M"); await delay(70); }
    send("\x1b2"); await wait("scroll");
    for (let i = 0; i < 35; i++) { send("a"); await delay(70); }
    send("\x1b3"); await wait("typing");
    let batches = 0;
    while (true) {
      send("\x1b4");
      const row = await wait("loading", ++batches);
      if (!row.hidden) break;
      if (batches > 300) throw new Error("backward load did not converge");
    }
    send("\x1b5"); await wait("loaded");
    for (let i = 0; i < 35; i++) { send("\x1b[<64;50;12M"); await delay(70); }
    send("\x1b6"); await wait("loaded-scroll"); await wait("typing-ready");
    for (let i = 0; i < 35; i++) { send("a"); await delay(70); }
    send("\x1b7"); await wait("loaded-typing");
    results.push({ fixture: file.match(/_([^_]+)\.jsonl$/u)[1], buildHash, batches, samples: events().filter(row => row.label !== "loading") });
    console.log(`${results.at(-1).fixture}: first ${results.at(-1).samples[0].firstFrameMs}ms, ${batches} load requests`);
    await stop();
    terminal.dispose();
    writeFileSync(out, JSON.stringify(results, null, 2));
  }
} finally { await stop(); rmSync(work, { recursive: true, force: true }); }
