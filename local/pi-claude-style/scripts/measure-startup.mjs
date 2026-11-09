#!/usr/bin/env node
// Startup time and peak memory of the UI extensions, measured the way the
// claude-style round-2 design did it (design-claude-style-r2.md, 测量基线):
//
//   bun scripts/measure-startup.mjs /path/to/pi [--source ~/.pi-next/agent]
//     [--samples 5] [--warmup 1] [--profiles full,noui] [--out <dir>]
//
// Each profile is built from an allowlist of the source agent directory:
// settings.json (packages filtered, pi-scheduler always removed so no daemon
// starts), the files the loaded packages read at startup (keybindings, prompt
// files, statusline script, package configs) and the extensions, themes,
// agents, model-prompts and skills directories. Credentials, model catalogs,
// sessions and caches are never copied, nor is any file only its owner may
// read. A symlink that leaves the source directory is dropped; an active theme
// lost that way comes from this package's themes/. The installed npm/git
// packages are too large to copy and are linked back. HOME is a temporary
// directory as well. settings.json must resolve inside the source and be
// readable by group or others; otherwise the run fails before reading it.
//
// Each sample runs `pi --offline --no-session` with PI_TIMING=1
// PI_STARTUP_BENCHMARK=1 in a Bun pseudo-terminal (a TTY is required, and it
// never sends input or EOF), wrapped in `/usr/bin/time -l`.
// Profiles are interleaved per round so machine load drifts evenly across
// them; the first --warmup runs per profile fill Pi's compile caches and are
// discarded. Only processes this script started are signalled. Everything is
// written to one temporary directory that is removed at exit; --out keeps the
// raw outputs, results.json and summary.md.
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const binary = argv.find((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
if (!binary || !existsSync(binary)) {
  console.error("usage: bun scripts/measure-startup.mjs /path/to/pi [--source dir] [--samples n] [--profiles a,b] [--out dir]");
  process.exit(2);
}
const source = resolve(option("--source", join(homedir(), ".pi-next/agent")));
const sourceReal = realpathSync(source);
const samples = Number.parseInt(option("--samples", "5"), 10);
const warmup = Number.parseInt(option("--warmup", "1"), 10);
const PROFILES = {
  full: [],
  noui: ["pi-claude-style"],
};
const wanted = option("--profiles", Object.keys(PROFILES).join(",")).split(",").filter(Boolean);
for (const name of wanted) if (!PROFILES[name]) throw new Error(`unknown profile ${name}`);

const work = mkdtempSync(join(tmpdir(), "pi-startup-"));
chmodSync(work, 0o700);
const cleanup = () => rmSync(work, { recursive: true, force: true });
let activeSample;
let interrupted;
for (const signalName of ["SIGINT", "SIGTERM"]) process.on(signalName, () => {
  interrupted ??= signalName;
  // The sample's finally awaits this same promise and reports any failure.
  // Never unlink a profile while an owned sample can still be using it.
  if (activeSample) void stopSample(activeSample).catch(() => {});
});
const out = option("--out") ? resolve(option("--out")) : undefined;
const raw = out ?? join(work, "raw");
const home = join(work, "home");

// What the loaded packages read at startup. Everything else stays behind.
const COPY_FILES = [
  /^keybindings\.json$/u, /^statusline\.sh$/u, /^(?:AGENTS|APPEND_SYSTEM|goal-append)\.md$/u,
  /^pi-[\w.-]+\.jsonc?$/u, /^mcp-(?:cache|onboarding)\.json$/u,
  /^fork-update(?:s\.json|-seen)$/u,
];
const COPY_DIRS = ["extensions", "themes", "agents", "model-prompts", "skills"];
const LINK_DIRS = ["npm", "git"];

/** Files only their owner may read (models.json, models-store.json, …) never leave the source. */
const shareable = (path) => (statSync(path).mode & 0o044) !== 0;
const inside = (path) => path === sourceReal || path.startsWith(`${sourceReal}/`);

function copyEntry(from, to) {
  if (/^(?:auth|models|models-store)\.json$/u.test(from.split("/").at(-1))) return;
  let real;
  try { real = realpathSync(from); } catch { return; }
  if (!inside(real)) return;
  const stat = statSync(real);
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(real)) copyEntry(join(real, name), join(to, name));
  } else if (stat.isFile() && shareable(real)) {
    copyFileSync(real, to);
  }
}

function packageName(entry) {
  const value = typeof entry === "string" ? entry : entry?.source;
  return typeof value === "string" ? value.replace(/\/+$/u, "").split("/").at(-1) : undefined;
}

function makeProfile(name) {
  // Settings carry more than package paths, so apply the same trust boundary
  // before reading any bytes, rather than silently copying an owner-only file.
  const settingsPath = realpathSync(join(source, "settings.json"));
  if (!inside(settingsPath)) throw new Error("settings.json must resolve inside --source; external symlinks are not allowed");
  if (!statSync(settingsPath).isFile() || !shareable(settingsPath)) {
    throw new Error("settings.json must be a regular file readable by group or others; owner-only settings are not copied");
  }
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const dir = join(work, `agent-${name}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    if (COPY_FILES.some((pattern) => pattern.test(entry)) || COPY_DIRS.includes(entry)) copyEntry(from, join(dir, entry));
    else if (LINK_DIRS.includes(entry)) symlinkSync(from, join(dir, entry));
  }
  const removed = new Set(["pi-scheduler", "pi-pinned-layout", ...PROFILES[name]]);
  settings.packages = (settings.packages ?? []).filter((entry) => !removed.has(packageName(entry)));
  if (typeof settings.statusLine?.command === "string") {
    settings.statusLine.command = settings.statusLine.command.split(`${source}/`).join(`${dir}/`);
  }
  const theme = typeof settings.theme === "string" ? `${settings.theme}.json` : undefined;
  if (theme && !existsSync(join(dir, "themes", theme)) && existsSync(join(packageRoot, "themes", theme))) {
    mkdirSync(join(dir, "themes"), { recursive: true });
    copyFileSync(join(packageRoot, "themes", theme), join(dir, "themes", theme));
  }
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  return dir;
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const strip = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/\r/gu, "");

function processTable() {
  let output = "";
  try { output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }); } catch { return []; }
  return output.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : undefined;
  }).filter(Boolean);
}

function descendants(pid, rows = processTable()) {
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of rows) if (row.ppid === parent) { found.push(row); queue.push(row.pid); }
  }
  return found;
}

function commandOf(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** Signal a process only while it is still the one this script saw. */
function signal(row, name) {
  if (commandOf(row.pid) !== row.command) return false;
  try { process.kill(row.pid, name); return true; } catch { return false; }
}

async function until(condition, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(100);
  }
  return condition();
}

function parse(text) {
  const plain = strip(text);
  const totals = [...plain.matchAll(/TOTAL:\s*(\d+)ms/gu)].map((match) => Number(match[1]));
  const extension = (pkg) => {
    const pattern = new RegExp(`/${pkg}/dist/index\\.js (module import|factory): (\\d+)ms`, "gu");
    const parts = [...plain.matchAll(pattern)];
    return parts.length === 0 ? undefined : parts.reduce((sum, match) => sum + Number(match[2]), 0);
  };
  const bytes = (label) => {
    const match = plain.match(new RegExp(`(\\d+)\\s+${label}`, "u"));
    return match ? Number(match[1]) / 1024 / 1024 : undefined;
  };
  return {
    mainTotalMs: totals[0],
    extensionsTotalMs: totals[1],
    ccMs: extension("pi-claude-style"),
    pinnedMs: extension("pi-pinned-layout"),
    maxRssMiB: bytes("maximum resident set size"),
    peakFootprintMiB: bytes("peak memory footprint"),
  };
}

async function sample(profile, dir, index) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: dir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_TIMING: "1",
    PI_STARTUP_BENCHMARK: "1",
  };
  let output = "";
  // A Bun pseudo-terminal: Pi needs a TTY, and nothing is ever typed into it.
  const child = Bun.spawn({
    cmd: ["/usr/bin/time", "-l", binary, "--offline", "--no-session"],
    cwd: dir,
    env,
    terminal: { cols: 120, rows: 40, data: (_terminal, data) => { output += Buffer.from(data).toString(); } },
  });
  const current = activeSample = { child, dir, seen: new Map(), finished: false, timeKilled: false, stopping: undefined };
  void child.exited.then(() => { current.finished = true; });
  try {
    await until(() => {
      observeSample(current);
      return interrupted || current.finished || (strip(output).match(/TOTAL:/gu) ?? []).length >= 2;
    }, 90_000);
    if (!interrupted) await delay(500);
  } finally {
    await stopSample(current);
    // Process exit can precede the final PTY data callback. Wait for the two
    // memory fields before closing; absence is reported below, never success.
    if (!current.timeKilled) await until(() => {
      const metrics = parse(output);
      return Number.isFinite(metrics.maxRssMiB) && Number.isFinite(metrics.peakFootprintMiB);
    }, 1_000);
    child.terminal?.close();
    if (activeSample === current) activeSample = undefined;
  }
  if (interrupted) return undefined;
  const rawPath = join(raw, `${profile}-${index}.out`);
  writeFileSync(rawPath, output);
  const metrics = parse(output);
  const missing = ["mainTotalMs", "extensionsTotalMs", "maxRssMiB", "peakFootprintMiB"]
    .filter(key => !Number.isFinite(metrics[key]));
  if (current.timeKilled || missing.length) {
    const reason = [current.timeKilled ? "/usr/bin/time had to be killed" : "",
      missing.length ? `missing ${missing.join(", ")}` : ""].filter(Boolean).join("; ");
    throw new Error(`incomplete startup sample ${profile}-${index}: ${reason}; ${out ? `raw output: ${rawPath}` : "use --out to retain raw output"}`);
  }
  return { profile, index, load: loadavg().map((value) => Number(value.toFixed(2))), ...metrics };
}

function observeSample(current) {
  if (current.finished) return;
  // Children can start late or outlive their parent; remember every one seen.
  for (const row of descendants(current.child.pid)) current.seen.set(row.pid, row);
}

function stopSample(current) {
  return current.stopping ??= (async () => {
    observeSample(current);
    const lock = join(current.dir, "scheduler/daemon.lock");
    if (existsSync(lock)) {
      // A daemon is ours only when this isolated profile's lock and its live
      // command line agree. Never signal a lock PID belonging to another profile.
      const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
      const command = Number.isInteger(pid) && pid > 1 ? commandOf(pid) : undefined;
      if (command?.includes(current.dir)) current.seen.set(pid, { pid, command });
      else if (command) console.error(`left pid ${pid} alone: its command does not name ${current.dir}`);
    }
    // Stop the measured program and its known children first. /usr/bin/time
    // can then reap its child and report RSS before we close the pseudo-terminal.
    for (const row of current.seen.values()) signal(row, "SIGTERM");
    const stopped = () => {
      observeSample(current);
      return current.finished && [...current.seen.values()].every(row => commandOf(row.pid) !== row.command);
    };
    if (!await until(stopped, 5_000)) {
      for (const row of current.seen.values()) signal(row, "SIGKILL");
      // Let time reap the killed program and finish its resource report.
      // Only a separate wrapper timeout permits killing our owned time handle.
      if (!await until(() => current.finished, 5_000)) {
        current.timeKilled = true;
        current.child.kill("SIGKILL");
      }
      if (!await until(stopped, 5_000)) throw new Error(`sample cleanup did not finish; profile retained at ${work}`);
    }
    await current.child.exited;
  })();
}

const median = (values) => {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function main() {
  if (out) mkdirSync(out, { recursive: true });
  mkdirSync(raw, { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  const dirs = Object.fromEntries(wanted.map((name) => [name, makeProfile(name)]));
  if (interrupted) return;
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  for (let round = 1; round <= warmup; round++) {
    for (const name of wanted) {
      if (interrupted) return;
      await sample(name, dirs[name], `warmup${round}`);
    }
  }
  const results = [];
  for (let round = 1; round <= samples; round++) {
    for (const name of wanted) {
      if (interrupted) return;
      const result = await sample(name, dirs[name], round);
      if (!result) return;
      results.push(result);
      console.error(`${name} #${round}: main ${result.mainTotalMs} ms, extensions ${result.extensionsTotalMs} ms, max RSS ${result.maxRssMiB?.toFixed(0)} MiB, load ${result.load[0]}`);
    }
  }

  const fmt = (value, digits = 0) => (typeof value === "number" ? value.toFixed(digits) : "—");
  const rows = wanted.map((name) => {
    const own = results.filter((result) => result.profile === name);
    const series = (key) => own.map((result) => fmt(result[key])).join(" / ");
    return {
      name,
      line: `| ${name} | ${series("mainTotalMs")} | ${fmt(median(own.map((r) => r.mainTotalMs)))} | ${series("extensionsTotalMs")} | ${fmt(median(own.map((r) => r.extensionsTotalMs)))} | ${fmt(median(own.map((r) => r.ccMs)))} | ${fmt(median(own.map((r) => r.pinnedMs)))} | ${series("maxRssMiB")} | ${fmt(median(own.map((r) => r.maxRssMiB)))} | ${fmt(median(own.map((r) => r.peakFootprintMiB)))} |`,
    };
  });
  const table = [
    `pi ${version} · ${samples} samples per profile after ${warmup} warm-up · source ${source}`,
    "",
    "| profile | main TOTAL (ms) | median | extensions (ms) | median | CC import+factory median (ms) | Pinned import+factory median (ms) | max RSS (MiB) | median | peak footprint median (MiB) |",
    "|---|---|---:|---|---:|---:|---:|---|---:|---:|",
    ...rows.map((row) => row.line),
  ].join("\n");
  writeFileSync(join(raw, "results.json"), JSON.stringify({ version, source, samples, results }, null, 2));
  writeFileSync(join(raw, "summary.md"), `${table}\n`);
  console.log(table);
  if (out) console.log(`\nraw output: ${out}`);
}

try {
  await main();
} finally {
  // Covers setup errors and signal-driven stops as well as normal completion.
  // If cleanup cannot prove exit, retain the profile and report that failure.
  if (activeSample) await stopSample(activeSample);
  cleanup();
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
}
