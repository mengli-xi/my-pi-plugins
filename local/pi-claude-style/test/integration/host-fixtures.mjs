import { piBin, installedPiVersion } from "../../../../scripts/pi-checks.mjs";
// Real Pi 1.5 TUI fixtures for pi-claude-style, driven by a faux provider.
//
//   PI_BIN=/path/to/pi bun test/integration/host-fixtures.mjs [--update] [--only name,...]
//
// Each scenario starts a fresh Pi process in a pseudo-terminal with a
// temporary agent directory, renders it through a headless xterm and compares
// normalized screens with the snapshots in ./host-fixtures/. No real model is
// contacted: the fixture extension answers every turn from a fixed script.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import xterm from "@xterm/headless";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const snapshotDir = join(here, "host-fixtures");
const args = process.argv.slice(2);
const binary = piBin();
const update = args.includes("--update");
const onlyFlag = args.indexOf("--only");
const only = onlyFlag >= 0 ? new Set((args[onlyFlag + 1] ?? "").split(",").filter(Boolean)) : undefined;
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.equal(version, installedPiVersion(), `expected the installed SDK version, got ${version}`);

const extensions = [
  join(packageRoot, "dist/index.ts"),
  join(here, "host-fixtures-extension.mts"),
];
for (const path of extensions) assert.ok(existsSync(path), `missing ${path}; run npm run build first`);

const COLS = 120;
const ROWS = 40;
// Scenarios run under a short temporary root so Pi's footer never truncates
// the cwd; a requested artifact directory receives a copy at the end.
const runRoot = mkdtempSync(join(tmpdir(), "cchf-"));
// Pi looks up `fd` and `rg` on PATH and, offline, prints a startup warning into
// the transcript when one is missing. Whether this machine happens to have them
// changed the chat height and therefore every snapshot below the startup block,
// so the fixture pins both to no-op stubs. No scenario runs Pi's search tools.
const toolBin = join(runRoot, "bin");
mkdirSync(toolBin, { recursive: true });
for (const tool of ["fd", "rg"]) writeFileSync(join(toolBin, tool), `#!/bin/sh\necho "${tool} fixture"\n`, { mode: 0o755 });
const fixturePath = process.env.PATH ? `${toolBin}:${process.env.PATH}` : toolBin;
const artifactRoot = process.env.CC_HOST_FIXTURE_ARTIFACTS ? resolve(process.env.CC_HOST_FIXTURE_ARTIFACTS) : runRoot;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function pngFixture() {
  const chunk = (kind, data) => {
    const payload = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

/** Terminal-identity variables that change Pi's capability detection. */
const HOST_TERMINAL_ENV = [
  "TMUX", "TMUX_PANE", "STY", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERMINAL_EMULATOR", "COLORTERM",
  "KITTY_WINDOW_ID", "KITTY_PID", "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE", "WARP_SESSION_ID",
  "WARP_TERMINAL_SESSION_UUID", "ITERM_SESSION_ID", "WT_SESSION", "HERDR_SESSION", "LC_TERMINAL",
];

class PiTerminal {
  constructor(root, { cwd, sessionArgs, extraEnv = {}, prompt, answerColors = false, cols = COLS, rows = ROWS, presentation = "main" }) {
    this.root = root;
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
    this.raw = "";
    const env = { ...process.env };
    for (const key of HOST_TERMINAL_ENV) delete env[key];
    Object.assign(env, {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "home/.config"),
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TERM: "xterm-256color",
      CC_HOST_FIXTURE_ROOT: root,
      // A fixed faux-provider pace keeps the run-average t/s above CC's
      // 500 ms observation window; at the provider's default speed every
      // scripted answer streamed faster and the done row lost its `t/s` column
      // depending on machine load.
      CC_HOST_FIXTURE_TPS: "6",
      PATH: fixturePath,
      ...extraEnv,
    });
    let presentationPath = extensions[0];
    if (presentation !== "main") {
      presentationPath = join(root, "presentation.ts");
      writeFileSync(presentationPath, `import { createClaudeStyleChildExtension } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/child.ts")).href)};
export default createClaudeStyleChildExtension({ target: ${JSON.stringify(presentation)}, taskName: "spacing fixture", returnLabel: "Alt+/ Main", readOnlyStatusline: true });`);
    }
    this.child = Bun.spawn({
      cmd: [
        binary, "--offline", ...sessionArgs, "--approve", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-context-files", "--no-themes", "--tui-mode", "fullscreen",
        "--provider", "fixture", "--model", "fixture-model", "--api-key", "offline",
        ...(extraEnv.CC_HOST_FIXTURE_RETRY_MISMATCH ? [extensions[1], presentationPath] : [presentationPath, extensions[1]]).flatMap((path) => ["--extension", path]),
        ...(prompt === undefined ? [] : [prompt]),
      ],
      cwd,
      env,
      stdin: "ignore",
      stderr: "pipe",
      terminal: {
        cols,
        rows,
        data: (_pty, data) => {
          const text = Buffer.from(data).toString();
          this.raw += text;
          this.term.write(data);
          // Like a real terminal, report its colours; Pi keeps theme backgrounds
          // (selection colours included) off while they are unknown.
          if (answerColors && text.includes("\x1b]10;?")) this.child.terminal.write("\x1b]10;rgb:dcdc/dcdc/dcdc\x07");
          if (answerColors && text.includes("\x1b]11;?")) this.child.terminal.write("\x1b]11;rgb:1e1e/1e1e/1e1e\x07");
        },
      },
    });
    this.stderr = new Response(this.child.stderr).text();
  }

  events() {
    const path = join(this.root, "events.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
  }

  /** Rows of selected text: cells drawn inverse (Pi) or on a selection background (CC's colours). */
  highlighted(rowFilter = () => true) {
    const buffer = this.term.buffer.active;
    const rows = [];
    for (let row = 0; row < this.term.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line || !rowFilter(line.translateToString(true))) continue;
      let text = "";
      for (let column = 0; column < this.term.cols - 2; column++) {
        const cell = line.getCell(column);
        if (cell && (cell.isInverse() || cell.getBgColorMode() !== 0)) text += cell.getChars() || " ";
      }
      if (text.trim()) rows.push({ row, text: text.trim() });
    }
    return rows;
  }

  screen() {
    const buffer = this.term.buffer.active;
    return Array.from({ length: this.term.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
  }

  send(data) { this.child.terminal.write(data); }

  async wait(label, condition, timeout = 30_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (condition()) return;
      if (this.child.exitCode !== null) throw new Error(`Pi exited (${this.child.exitCode}) before ${label}\n${this.screen()}`);
      await delay(25);
    }
    throw new Error(`timeout: ${label}\n${this.screen()}`);
  }

  async waitEvents(label, predicate, timeout) {
    await this.wait(label, () => predicate(this.events()), timeout);
  }

  /** Wait until the frame stops changing, so a capture is not mid-render. */
  async settle(quietMs = 300, timeout = 10_000) {
    const until = Date.now() + timeout;
    let last = this.screen();
    let stableSince = Date.now();
    while (Date.now() < until) {
      await delay(50);
      const current = this.screen();
      if (current !== last) { last = current; stableSince = Date.now(); continue; }
      if (Date.now() - stableSince >= quietMs) return current;
    }
    return last;
  }

  async exit() {
    this.send("\x04");
    const exited = await Promise.race([this.child.exited.then(() => true), delay(10_000).then(() => false)]);
    if (!exited) {
      this.child.kill("SIGKILL");
      await this.child.exited;
      throw new Error(`Pi did not exit on Ctrl+D\n${this.screen()}`);
    }
    return { code: this.child.exitCode, stderr: await this.stderr };
  }

  async dispose() {
    if (this.child.exitCode === null) {
      this.child.kill("SIGKILL");
      await this.child.exited;
    }
    this.child.terminal?.close();
    this.term.dispose();
    writeFileSync(join(this.root, "terminal.raw"), this.raw);
  }
}

/**
 * Remove what legitimately differs between runs: paths, clocks, durations and
 * token counters. Only a line that held one of those is squeezed (rules and
 * runs of spaces stretch with the numbers on it); every other line keeps its
 * exact width, so a box or panel that changes size still fails.
 */
function normalize(screen, root) {
  // macOS resolves $TMPDIR to /private/var/... while mkdtemp keeps the /var
  // spelling; Pi prints the resolved path, so both spellings have to match or
  // the footer path row survives into the transcript region.
  const variants = [root, root.startsWith("/private/") ? root.slice("/private".length) : `/private${root}`,
    root.replace(/^\/var\//u, "/private/var/"), root.replace(/^\/private\/var\//u, "/var/")];
  const sorted = [...new Set(variants)].sort((a, b) => b.length - a.length);
  return screen
    .split("\n")
    .map((line) => {
      let text = line.trimEnd().replace(`v${version}`, "v<VERSION>");
      for (const path of sorted) text = text.split(path).join("<ROOT>");
      const volatile = text
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<uuid>")
        .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.-]+Z?/gu, "<iso>")
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, "<time>")
        .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/gu, "<d>")
        .replace(/\b\d+(?:\.\d+)?t\/s\b/gu, "<tps>")
        .replace(/([↑↓RW])\d+(?:\.\d+)?k?\b/gu, "$1<n>")
        .replace(/\bCH:?\d+(?:\.\d+)?%/gu, "CH<n>%")
        .replace(/\b\d+(?:\.\d+)?%\/\d+(?:\.\d+)?k\b/gu, "<n>%/<n>k")
        .replace(/\$\d+\.\d+/gu, "$<cost>")
        // The compaction row reports the context size Pi measured; it follows
        // Pi's own system prompt and tokenizer, not CC's presentation.
        .replace(/(compacted from )\d+( tokens)/gu, "$1<n>$2")
        // The /session panel's file row carries the temp session path; a
        // fragment may be left over when the row wrapped before its uuid.
        // Consume a UUID already normalized above too, not an empty prefix.
        .replace(/(<ROOT>\/sessions\/<iso>)_(?:<uuid>|[0-9a-f-]*)/gu, "$1_<uuid>")
        .replace(/^(\s*)[0-9a-f-]+\.jsonl\b/gu, "$1<uuid>.jsonl")
        .replace(/^(\s*)\.jsonl\b/gu, "$1<uuid>.jsonl");
      if (volatile === line.trimEnd()) return volatile;
      return volatile.replace(/─{4,}/gu, "────").replace(/(\S) {3,}(?=\S)/gu, "$1   ");
    })
    .join("\n")
    // Where that row wraps depends on the temp root length, so it is joined
    // into one canonical line, and the panel's "1-12/22" range (which shrinks
    // by one when the row does not wrap) keeps only its visible anchor.
    // The panel's right border is kept so the row still reads as panel content;
    // this one row is not part of the width or wrapping assertions.
    .replace(/(<ROOT>\/sessions\/<iso>_<uuid>)([^\n]*)\n\s*(?:<uuid>)?\.jsonl([^\n]*)/gu,
      (_match, path, before, after) => `${path}.jsonl${before.includes("█") || after.includes("█") ? " █" : ""}`)
    .replace(/(<ROOT>\/sessions\/<iso>_<uuid>\.jsonl) +█/gu, "$1 █")
    .replace(/(── Session info ─+\s+\d+-\d+\/)\d+/gu, "$1<n>")
    .replace(/\n+$/u, "\n");
}

/**
 * What a snapshot covers: from the transcript's first user box (or the sticky
 * question header) down, without Pi's startup banner above it or the cwd and
 * statusline footer below. Those belong to Pi and to every scenario alike.
 */
function snapshotRegion(text, endAtEditor = false) {
  const lines = text.replace(/\n+$/u, "").split("\n");
  const first = lines.findIndex((line) => line.startsWith("╭ user") || line.startsWith("▲ "));
  const start = Math.max(0, first);
  if (endAtEditor) {
    // A clipped cwd may no longer contain the full root for normalize() to replace.
    // Keep the exact transcript/editor frame rather than filtering footer text.
    const editor = lines.findIndex((line, index) => index > start && line === "❯");
    assert.ok(first >= 0 && editor > start, "the user and editor frame boundaries are visible");
    assert.match(lines[editor - 1] ?? "", /^─{4,}$/u, "the editor top rule is visible");
    assert.match(lines[editor + 1] ?? "", /^─{4,}$/u, "the editor bottom rule is visible");
    return `${lines.slice(start, editor + 2).join("\n")}\n`;
  }
  let end = lines.length;
  // The statusline footer is the last block on screen: the path/model row, the
  // accounting row, and — when a Todo/Goal/Processes row is contributed — one
  // more row under it. Cut before the path row instead of classifying every
  // footer row by its text, so a contributed row of any wording cannot leak in.
  const accountingRow = (line) => /\bCH[:<]/u.test(line) || /^\[[\d.]+k?\/(?:<n>|\d)/u.test(line);
  const accounting = lines.findLastIndex((line, index) => index >= start && accountingRow(line));
  if (accounting > start && accounting >= lines.length - 2) {
    end = accounting - 1;
  } else {
    // No statusline answered (a panel, or a command that never produced a
    // frame): fall back to Pi's native cwd/provider footer shapes.
    const nativeFooter = (line) =>
      line.startsWith("<ROOT>") || line.includes("(fixture) fixture-model") ||
      /\bfixture-model\(fixture\)/u.test(line);
    while (end > start && nativeFooter(lines[end - 1])) end--;
  }
  while (end > start && lines[end - 1].trim() === "") end--;
  return `${lines.slice(start, end).join("\n")}\n`;
}

const failures = [];
function compare(name, actual) {
  const path = join(snapshotDir, `${name}.txt`);
  if (update) {
    const created = !existsSync(path);
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(path, actual);
    console.log(`${created ? "created" : "updated"} ${name}`);
    return;
  }
  if (!existsSync(path)) {
    failures.push(`${name}: no snapshot; run with --update to create it`);
    return;
  }
  const expected = readFileSync(path, "utf8");
  if (expected === actual) return;
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const first = expectedLines.findIndex((line, index) => line !== actualLines[index]);
  failures.push(`${name}: first difference at line ${first + 1}\n- ${expectedLines[first] ?? "<eof>"}\n+ ${actualLines[first] ?? "<eof>"}`);
}

function transcriptRegion(screen) {
  // Everything above the editor's top rule: the editor, footer and startup
  // banner are not what live/hydrate parity is about.
  const lines = screen.split("\n");
  const prompt = lines.findIndex((line) => line.startsWith("❯"));
  const end = prompt > 0 ? prompt - 1 : lines.length;
  const start = lines.findIndex((line) => line.startsWith("╭ user"));
  return lines.slice(Math.max(0, start), end).join("\n").replace(/\n+$/u, "");
}

async function scenarioRoot(name, settings = {}) {
  const base = join(runRoot, name);
  // /session includes its file path in the measured report. Keep the UUID on
  // a continuation line even with check-host's short TMPDIR, so that path
  // length does not change the viewport or scrollbar being snapshotted.
  const root = name === "session" && base.length < 64
    ? join(base, "p".repeat(63 - base.length)) : base;
  rmSync(root, { recursive: true, force: true });
  for (const dir of ["agent", "home/.config", "work", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
  const cwd = join(root, "work");
  writeFileSync(join(cwd, "a.txt"), "alpha file\n");
  writeFileSync(join(cwd, "b.txt"), "bravo file\n");
  writeFileSync(join(cwd, "c.txt"), "charlie file\n");
  writeFileSync(join(cwd, "fixture.png"), pngFixture());
  for (const name of ["fixture-2.png", "fixture-3.png"]) writeFileSync(join(cwd, name), pngFixture());
  // The second provider only needs a credential so /model lists it as available.
  writeFileSync(join(root, "agent/auth.json"), JSON.stringify({ "fixture-b": { type: "api_key", key: "offline" } }), { mode: 0o600 });
  // The daily profile turns Pi's inline tool images off; CC draws one row instead.
  writeFileSync(join(root, "agent/settings.json"), JSON.stringify({
    terminal: { showImages: settings.showImages ?? false },
    fullscreenCopyOnSelect: false,
    // The profile, not CC presentation, owns the standard active tool set.
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    ...(settings.pi ?? {}),
  }));
  // Exercise the one-time legacy Pinned import in an isolated profile.
  if (settings.pinned) writeFileSync(join(root, "agent/pi-pinned-layout.json"), JSON.stringify(settings.pinned));
  return { root, cwd };
}

function internalsDetails(pi) {
  const sessionFile = pi.events().find(event => event.event === "ready")?.sessionFile;
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return entries.filter(entry => entry.type === "custom_message" && entry.customType === "internals").at(-1)?.details;
}

async function clickText(pi, token, offset = 2) {
  const lines = pi.screen().split("\n");
  const row = lines.findIndex((line) => line.includes(token));
  assert.ok(row >= 0, `click target ${token} is not on screen\n${pi.screen()}`);
  const column = lines[row].indexOf(token) + offset + 1;
  pi.send(`\x1b[<0;${column};${row + 1}M`);
  await delay(30);
  pi.send(`\x1b[<0;${column};${row + 1}m`);
  // Two clicks on one word within 500 ms are a selection double-click in Pi.
  await delay(560);
}

async function run(name, options, body) {
  if (only && !only.has(name)) return;
  const { root, cwd } = await scenarioRoot(name, options.settings);
  const pi = new PiTerminal(root, {
    cwd,
    sessionArgs: ["--session-dir", join(root, "sessions")],
    prompt: options.prompt,
    extraEnv: options.env,
    cols: options.cols,
    rows: options.rows,
    answerColors: options.answerColors,
    presentation: options.presentation,
  });
  const capture = async (label, text) => {
    const screen = text ?? await pi.settle();
    writeFileSync(join(root, `${label}.txt`), screen);
    compare(`${name}.${label}`, snapshotRegion(normalize(screen, root), name === "user-fold" && label === "live"));
    return screen;
  };
  let sessionFile;
  try {
    await pi.waitEvents("ready", (events) => events.some((event) => event.event === "ready"));
    sessionFile = pi.events().find((event) => event.event === "ready")?.sessionFile;
    await body({ pi, root, capture });
    const exit = await pi.exit();
    assert.equal(exit.code, 0, `${name}: Pi exit code`);
    assert.equal(exit.stderr.trim(), "", `${name}: stderr`);
  } finally {
    await pi.dispose();
  }
  if (!options.hydrate) return;
  // Hydrate: a fresh process restores the same session from disk.
  assert.ok(sessionFile && existsSync(sessionFile), `${name}: session file ${sessionFile}`);
  const live = readFileSync(join(root, `${options.hydrate}.txt`), "utf8");
  rmSync(join(root, "events.jsonl"), { force: true });
  const resumed = new PiTerminal(root, { cwd, sessionArgs: ["--session", sessionFile], extraEnv: options.env });
  try {
    await resumed.waitEvents("resumed ready", (events) => events.some((event) => event.event === "ready"));
    await resumed.wait("restored transcript", () => resumed.screen().includes("╭ user"));
    const screen = await resumed.settle(500);
    writeFileSync(join(root, "hydrate.txt"), screen);
    compare(`${name}.hydrate`, snapshotRegion(normalize(options.hydrateExtract?.(screen) ?? screen, root), name === "user-fold"));
    const liveRegion = normalize(transcriptRegion(live), root);
    const hydrateRegion = normalize(transcriptRegion(screen), root);
    writeFileSync(join(root, "parity.json"), JSON.stringify({ liveRegion, hydrateRegion }, null, 2));
    if (options.parity) assert.equal(hydrateRegion, liveRegion, `${name}: live and hydrated transcripts differ`);
    const exit = await resumed.exit();
    assert.equal(exit.code, 0, `${name}: resumed Pi exit code`);
    assert.equal(exit.stderr.trim(), "", `${name}: resumed stderr`);
  } finally {
    await resumed.dispose();
  }
}

const results = [];
async function scenario(name, options, body) {
  try {
    await run(name, options, body);
    if (!only || only.has(name)) results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error?.stack ?? error) });
  }
}

// Parity is not asserted: a restored session has no Activity thinking rows yet
// (recorded in the batch-0 report as existing behaviour).
await scenario("grouped", { prompt: "FIXTURE_GROUPED survey the inputs", hydrate: "live" }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  const live = await capture("live");
  assert.ok(live.includes("const bodyFence = 42;") && live.includes("cat c.txt"), "body and thinking code are visible");
  assert.ok(!live.includes("```"), "assistant body and inline thinking hide fence marker rows");
  pi.send("\x14");
  await pi.wait("thinking hidden status", () => pi.screen().includes("Thinking blocks: hidden"));
  await capture("ctrl-t-hidden");
  pi.send("\x14");
  await pi.wait("thinking visible status", () => pi.screen().includes("Thinking blocks: visible"));
  await capture("ctrl-t-visible");
  await clickText(pi, "Read 3 files");
  await pi.wait("Activity panel", () => pi.screen().includes("Activity transcript"));
  await capture("activity-panel");
  pi.send("\r");
  await pi.wait("expanded Activity thinking", () => pi.screen().includes("const thinkingFence = 1;"));
  const panel = await capture("activity-thinking");
  assert.ok(!panel.includes("```"), "the Activity panel hides fence marker rows");
  pi.send("\x1b");
  await delay(200);
});

await scenario("nested", { prompt: "FIXTURE_NESTED run nested tools", hydrate: "live", parity: true }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  const starts = pi.events().filter((event) => event.event === "tool-start");
  assert.deepEqual(starts.map((event) => [event.name, event.parent ?? null]), [
    ["fixture_codemode", null],
    ["read", "nested-parent"],
    ["read", "nested-parent"],
    ["bash", "nested-parent"],
  ]);
  await capture("live");
  await clickText(pi, "Read 2 files");
  await pi.wait("nested panel", () => pi.screen().includes("Activity transcript") || pi.screen().includes("Esc close"));
  await capture("panel");
  pi.send("\x1b");
  await delay(200);
});

const longUserPrompt = [
  "FIXTURE_USER please follow every step below.",
  ...Array.from({ length: 14 }, (_, index) => `step ${index + 1}: keep line ${index + 1} in the request`),
  "```sh",
  "echo user-fence",
  "```",
  "last line of the request",
].join("\n");
await scenario("user-fold", { prompt: longUserPrompt, hydrate: "live", parity: true }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  await capture("live");
  await clickText(pi, "FIXTURE_USER");
  await pi.wait("user message panel", () => pi.screen().includes("Esc"));
  // The editor replacement panel need not keep a transcript user box above it.
  // Capture its exact frame, not Pi's startup banner or the native footer.
  const panel = (await pi.settle()).split("\n");
  const start = panel.findIndex(line => line.startsWith("── ❯ user "));
  const end = panel.findIndex((line, index) => index > start && line.includes("Enter/Esc close"));
  assert.ok(start >= 0 && end > start, "the complete user panel frame is visible");
  await capture("panel", panel.slice(start, end + 1).join("\n"));
  pi.send("\x1b");
  await delay(200);
});

await scenario("user-fence", { prompt: "FIXTURE_USER short request\n```sh\necho user-fence\n```" }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  const live = await capture("live");
  assert.ok(live.includes("```sh"), "user messages keep Pi's fence markers");
  assert.ok(live.includes("echo user-fence") && !live.includes("click to view"),
    "a message that would hide fewer than three lines is drawn whole");
});

const KITTY_IMAGE = /\x1b_G[^\x1b]*(?:a=T|f=100)/u;
await scenario("image-rows", { prompt: "FIXTURE_IMAGE_ROWS inspect three pictures", hydrate: "live", parity: true }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  const live = await capture("live");
  const rows = live.split("\n");
  const first = rows.findIndex((row) => row.includes("View Image"));
  assert.ok(first >= 0, live);
  assert.ok(rows[first - 1].includes("Read 3 files, ran 1 shell command"), "first image remains adjacent to its group summary");
  assert.ok(rows.slice(first, first + 3).every((row) => row.includes("View Image (70 B)")), "three image rows have no intervening blank lines");
  assert.equal(rows[first + 3], "", "spacing after the images stays native");
  for (let index = 0; index < 3; index++) {
    const screenRows = pi.screen().split("\n");
    const imageRows = screenRows.flatMap((row, i) => row.includes("View Image") ? [i] : []);
    const y = imageRows[index] + 1;
    pi.send(`\x1b[<0;8;${y}M`);
    await delay(30);
    pi.send(`\x1b[<0;8;${y}m`);
    const path = index === 0 ? "fixture.png" : `fixture-${index + 1}.png`;
    await pi.wait(`image row ${index + 1} panel`, () => pi.screen().includes(`Image · ${path}`));
    pi.send("\x1b");
    await delay(560);
  }
});

await scenario("image", { prompt: "FIXTURE_IMAGE inspect the picture", hydrate: "live", parity: true, env: { KITTY_WINDOW_ID: "1" } }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  const live = await capture("live");
  assert.ok(!KITTY_IMAGE.test(pi.raw), "no inline Kitty image reached the transcript");
  assert.ok(live.includes("View Image (70 B)"), "the image read offers the compact entry");
  assert.ok(live.includes("View 2 Images"), "a non-read tool's images get the same entry");
  await clickText(pi, "View Image");
  await pi.wait("image panel", () => pi.screen().includes("Image"));
  await capture("panel");
  pi.send("\x1b");
  await delay(200);
  await clickText(pi, "View 2 Images");
  await pi.wait("screenshot panel", () => pi.screen().includes("2 Images 1/2"));
  const shots = await capture("panel-shots");
  assert.ok(!shots.includes("copy path"), "a pathless image offers no path actions");
  pi.send("\x1b");
  await delay(200);
});

// With Pi's images on, Pi draws them and CC adds nothing; doctor says why.
await scenario("image-native", { prompt: "FIXTURE_IMAGE inspect the picture", settings: { showImages: true }, env: { KITTY_WINDOW_ID: "1" } }, async ({ pi }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  const live = await pi.settle();
  assert.ok(KITTY_IMAGE.test(pi.raw), "Pi drew the images inline");
  assert.ok(!live.includes("View Image") && !live.includes("Images ("), "CC adds no entry while Pi draws the images");
  pi.send("/cc-style doctor\r");
  await pi.wait("doctor", () => pi.screen().includes("terminal.showImages is on"));
  pi.send("\x1b");
  await delay(200);
});

// AGENTS.md: a fresh process must show no missing or failing internals after
// a run has exercised the live probes.
await scenario("internals", { prompt: "FIXTURE_GROUPED survey the inputs" }, async ({ pi, root }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  pi.send("/internals\r");
  await pi.wait("internals report", () => pi.screen().includes("▸ internals"));
  const screen = await pi.settle();
  writeFileSync(join(root, "internals.txt"), screen);
  assert.ok(!screen.includes("缺失") && !screen.includes("调用失败"), screen);
  await pi.wait("complete internals entry", () => typeof internalsDetails(pi) === "string");
  const details = internalsDetails(pi);
  writeFileSync(join(root, "internals-full.txt"), details);
  assert.ok(!details.includes("缺失") && !details.includes("调用失败"), details);
});

// Known custom messages are compact and open their details; an unknown type
// and Pi's own notices stay native and complete.
await scenario("custom-messages", { prompt: "FIXTURE_MESSAGES say hello" }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  pi.send("/fixture-messages\r");
  await pi.wait("messages", () => pi.screen().includes("second line stays") && pi.screen().includes("FIXTURE_NOTICE"));
  const live = await capture("live");
  assert.ok(live.includes("▸ fork-update") && !live.includes("[fork-update]"), "a known type is compact");
  assert.ok(live.includes("[fixture-unknown]") && live.includes("FIXTURE_UNKNOWN first line"), "an unknown type keeps Pi's box and its content");
  assert.ok(!live.includes("⚠ FIXTURE_NOTICE"), "notices are Pi's own");
  await clickText(pi, "fork-update");
  await pi.wait("details panel", () => pi.screen().includes("FIXTURE_KNOWN_DETAILS"));
  await capture("details");
  pi.send("\x1b");
  await delay(200);
  pi.send("/fixture-oauth\r");
  await pi.wait("OAuth status", () => pi.screen().includes("FIXTURE_OAUTH authenticated"));
  assert.ok(pi.screen().includes("▸ mcp-oauth-status") && !pi.screen().includes("[mcp-oauth-status]"));
  await clickText(pi, "mcp-oauth-status");
  await pi.wait("OAuth details", () => pi.screen().includes('"nextAction"') && pi.screen().includes("fixture-oauth-server"));
  assert.ok(pi.screen().includes('"authenticated"') && pi.screen().includes('"connect"'));
  pi.send("\x1b");
  await delay(200);
});

function compactionRow(screen) {
  const row = screen.split("\n").find(line => line.includes("[compaction] compacted from"));
  assert.ok(row, `missing compaction row\n${screen}`);
  return row.trimEnd();
}
for (const presentation of ["main", "side-chat", "subagent"]) {
  await scenario(`compaction-${presentation}`, {
    prompt: "Prepare the first compaction fixture turn.", presentation, hydrate: "live", hydrateExtract: compactionRow,
    // The compaction summary is one long answer; keep the fast default pace so
    // the /compact wait stays short. Its snapshot holds only the summary row.
    env: { CC_HOST_FIXTURE_COMPACTION: "1", CC_HOST_FIXTURE_TPS: "4000" },
    settings: { pi: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } } },
  }, async ({ pi, capture }) => {
    await pi.waitEvents("first turn settled", events => events.some(event => event.event === "settled"));
    pi.send("Prepare the second compaction fixture turn.\r");
    await pi.waitEvents("second turn settled", events => events.filter(event => event.event === "settled").length === 2);
    pi.send("/compact\r");
    await pi.wait("compact summary row", () => pi.screen().includes("[compaction] compacted from"));
    const file = pi.events().find(event => event.event === "ready").sessionFile;
    const entry = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "compaction").at(-1);
    assert.ok(entry?.summary.includes("COMPACTION_START"));
    assert.ok(pi.screen().includes(`compacted from ${entry.tokensBefore} tokens`));
    assert.ok(!pi.screen().includes("COMPACTION_START"), "summary stays out of inline transcript");
    await capture("live", compactionRow(await pi.settle()));
    await clickText(pi, "[compaction]");
    await pi.wait("compaction panel", () => pi.screen().includes("Compaction summary") && pi.screen().includes("COMPACTION_START"));
    // Snapshot the retained content, not unrelated startup/footer layout.
    const panel = (await pi.settle()).split("\n");
    const start = panel.findIndex(line => line.includes("COMPACTION_START"));
    await capture("panel", panel.slice(start, start + 7).join("\n"));
    pi.send("G");
    await pi.wait("summary scroll end", () => pi.screen().includes("COMPACTION_END"));
    pi.send("\x1b");
    await pi.wait("summary panel closed", () => !pi.screen().includes("Compaction summary") && pi.screen().includes("[compaction]"));
  });
}

await scenario("session", { prompt: "FIXTURE_SESSION say hello" }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  pi.send("/session\r");
  await pi.wait("session panel", () => pi.screen().includes("Session"));
  await capture("panel");
  pi.send("\x1b");
  await delay(200);
});

await scenario("model", { prompt: "FIXTURE_MODEL say hello" }, async ({ pi, capture }) => {
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  pi.send("/model\r");
  await pi.wait("model selector", () => pi.screen().includes("fixture-model-large"));
  await pi.wait("catalog refresh settled", () => pi.screen().includes("Model catalogs refreshed."), 10_000);
  await capture("selector");
  pi.send("\t");
  await pi.wait("next provider tab", () => pi.screen().includes("fixture-b-model"));
  await capture("selector-tab");
  pi.send("\x1b");
  await delay(200);
});

// A selection belongs to the content: scrolled with the wheel after release
// (or mid-drag), the highlight moves with the text it covers. Daily Pinned
// config, so the sticky question header is up while the answer scrolls.
await scenario("selection-scroll", {
    prompt: "FIXTURE_SCROLL write a long answer",
    // CC paints the selection with the theme's selectedBg, which Pi only
    // resolves once the terminal has reported its colours.
    // This 80-line answer streams in one turn; the slow snapshot pace would
    // stretch it past the settle timeout.
    env: { COLORTERM: "truecolor", CC_HOST_FIXTURE_TPS: "4000" },
    answerColors: true,
    settings: { pinned: { enabled: true, floatAutocomplete: true, popupGap: 2, stickyUserMessage: true } },
  }, async ({ pi, root }) => {
    await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
    await pi.settle();
    assert.match(pi.screen(), /▲ FIXTURE_SCROLL.*click to jump/u, "CC sticky question remains visible");
    const isContent = (line) => /scroll line \d\d/u.test(line);
    const rows = pi.screen().split("\n");
    const first = rows.findIndex(isContent);
    assert.ok(first >= 0, pi.screen());
    const top = first + 4, bottom = first + 8;
    const mouse = (code, column, row, release = false) => pi.send(`\x1b[<${code};${column + 1};${row + 1}${release ? "m" : "M"}`);
    // Drag across three content rows and release; then scroll up.
    mouse(0, 2, top); await delay(30);
    mouse(32, 20, top + 2); await delay(30);
    mouse(32, 30, bottom); await delay(150);
    mouse(0, 30, bottom, true); await delay(40);
    await delay(260);
    const before = pi.highlighted(isContent).filter((item) => /alpha|scroll line/u.test(item.text));
    writeFileSync(join(root, "selected.txt"), `${pi.screen()}\n${JSON.stringify(before, null, 1)}`);
    assert.ok(before.length >= 3, `the drag selected text\n${pi.screen()}`);
    for (let index = 0; index < 2; index++) { mouse(64, 40, bottom + 4); await delay(80); }
    await pi.settle();
    const after = pi.highlighted(isContent).filter((item) => /alpha|scroll line/u.test(item.text));
    writeFileSync(join(root, "scrolled.txt"), `${pi.screen()}\n${JSON.stringify(after, null, 1)}`);
    assert.notEqual(after[0]?.row, before[0]?.row, "the wheel scrolled the transcript");
    assert.deepEqual(after.map((item) => item.text), before.map((item) => item.text),
      "after release and wheel the highlight still covers the same text");
    // Mid-drag: press, drag, wheel, keep dragging. The anchor stays on its text.
    pi.send("\x1b"); await delay(100);
    const again = pi.screen().split("\n");
    const anchorRow = again.findIndex(isContent) + 2;
    const anchorText = again[anchorRow].trim();
    mouse(0, 0, anchorRow); await delay(30);
    mouse(32, 30, anchorRow + 1); await delay(30);
    mouse(64, 40, anchorRow + 4); await delay(120);
    mouse(32, 30, anchorRow + 2); await delay(30);
    mouse(0, 30, anchorRow + 2, true); await delay(300);
    const dragged = pi.highlighted(isContent).filter((item) => /alpha|scroll line/u.test(item.text));
    writeFileSync(join(root, "mid-drag.txt"), `${pi.screen()}\n${JSON.stringify({ anchorText, dragged }, null, 1)}`);
    assert.ok(dragged.length > 0, pi.screen());
    assert.ok(anchorText.startsWith(dragged[0].text.slice(0, 20)), `mid-drag: the anchor stays on "${anchorText}"\n${JSON.stringify(dragged)}`);
  });

// Cross the sticky row in both directions, including a held drag. Copy goes
// through Pi's public API into the fixture clipboard, never the system one.
await scenario("selection-sticky-boundary", {
  prompt: "FIXTURE_SCROLL cross the sticky row",
  env: { COLORTERM: "truecolor", CC_HOST_FIXTURE_COPY_SELECTION: "1", CC_HOST_FIXTURE_TPS: "4000" },
  answerColors: true,
  settings: { pi: { fullscreenWheelScrollLines: 1 } },
}, async ({ pi, root }) => {
  await pi.waitEvents("settled", events => events.some(event => event.event === "settled"));
  await pi.settle();
  const content = line => /scroll line \d\d/u.test(line);
  const mouse = (code, col, row, release = false) => pi.send(`\x1b[<${code};${col + 1};${row + 1}${release ? "m" : "M"}`);
  const headerClean = () => {
    assert.match(pi.screen(), /▲ FIXTURE_SCROLL/u);
    assert.deepEqual(pi.highlighted(line => line.startsWith("▲ ")), [], "sticky row has no selection background");
  };
  const selected = () => pi.highlighted(content).filter(row => content(row.text)).map(row => row.text);
  const copy = async () => {
    const count = pi.events().filter(event => event.event === "selection-copy").length;
    pi.send("\x1by");
    await pi.waitEvents("native selection copy", events => events.filter(event => event.event === "selection-copy").length > count);
    const text = pi.events().filter(event => event.event === "selection-copy").at(-1).text;
    await pi.wait("copy feedback", () => pi.screen().includes("Copied!"));
    await pi.wait("copy flash cleared", () => !pi.screen().includes("Copied!"));
    return text;
  };
  const visibleCopy = lines => lines.filter(text => pi.screen().split("\n").filter(content).some(line => line.trim().includes(text)));
  // Leave room to scroll downward before making a selection near the top.
  for (let i = 0; i < 16; i++) { mouse(64, 40, 12); await delay(35); }
  await pi.settle(); headerClean();
  const start = pi.screen().split("\n").findIndex(content) + 2, end = start + 4;
  const expectedCopy = pi.screen().split("\n").slice(start, end + 1)
    .map((line, index) => (index === end - start ? line.slice(0, 31) : line.slice(0, pi.term.cols - 2)).trimEnd()).join("\n");
  mouse(0, 0, start); await delay(40); mouse(32, 30, end); await delay(80); mouse(0, 30, end, true);
  await delay(150);
  const originalHighlight = selected();
  assert.equal(originalHighlight.length, 3);
  const originalCopyText = await copy();
  assert.equal(originalCopyText, expectedCopy, "native copy preserves the selected characters and blank lines exactly");
  const originalCopy = originalCopyText.split("\n").map(line => line.trim()).filter(Boolean);
  assert.deepEqual(originalCopy, originalHighlight, "fully visible highlight equals native copy");
  const crossing = start + 1;
  for (let i = 0; i < crossing; i++) {
    mouse(65, 40, 12); await delay(80); headerClean();
    assert.deepEqual(selected(), visibleCopy(originalCopy), "downward scrolling preserves the visible part of copied text");
  }
  writeFileSync(join(root, "crossed-down.txt"), pi.screen());
  assert.ok(selected().length < originalCopy.length, "the selection actually crossed the sticky row");
  assert.equal(await copy(), originalCopyText, "crossing under sticky does not change copied content");
  for (let i = 0; i < crossing; i++) {
    mouse(64, 40, 12); await delay(80); headerClean();
    assert.deepEqual(selected(), visibleCopy(originalCopy), "upward scrolling restores the same highlight");
  }
  assert.deepEqual(selected(), originalCopy);
  // Recreate the range, then scroll while the button is still down.
  mouse(0, 0, start); await delay(40); mouse(32, 30, end); await delay(80);
  for (let i = 0; i < crossing; i++) { mouse(65, 40, 12); await delay(80); headerClean(); }
  mouse(32, 30, end); await delay(80); headerClean();
  for (let i = 0; i < crossing; i++) { mouse(64, 40, 12); await delay(80); headerClean(); }
  mouse(32, 30, end); await delay(80); mouse(0, 30, end, true); await delay(100);
  assert.equal(await copy(), originalCopyText, "mid-drag scrolling preserves the original anchor and final range");
  assert.deepEqual(selected(), originalCopy);
  headerClean();
  writeFileSync(join(root, "crossed-drag.txt"), pi.screen());
});

// The panel's bottom edge is the allocated editor bottom, including a short
// window that squeezes the dock. Mouse gestures must stay inside the panel.
for (const [cols, rows] of [[80, 24], [120, 40], [80, 20]]) {
  await scenario(`geometry-${cols}x${rows}`, { cols, rows, answerColors: true, env: { COLORTERM: "truecolor", ...(rows === 20 ? { CC_HOST_FIXTURE_SQUEEZE: "1" } : {}) } }, async ({ pi, root }) => {
    pi.send("DRAFT_STAYS"); await pi.settle();
    const before = pi.screen().split("\n");
    const editor = before.findIndex(line => line.includes("DRAFT_STAYS"));
    assert.ok(editor >= 0, pi.screen());
    const editorBottom = editor + 1;
    if (rows === 20) assert.ok(before.filter(line => line.includes("DOCK_")).length < 26,
      "the native dock is actually squeezed, not just in a short window");
    pi.send("\x1bg");
    await pi.wait("geometry panel", () => pi.screen().includes("GEOMETRY_PANEL"));
    await pi.settle();
    const panel = pi.screen().split("\n");
    const hint = panel.findIndex(line => line.includes("Enter/Esc close"));
    assert.equal(hint, editorBottom, "panel bottom rule occupies the editor bottom rule");
    writeFileSync(join(root, "panel.txt"), pi.screen());
    const bodyRow = panel.findIndex(line => line.includes("panel body"));
    assert.ok(bodyRow > 0, pi.screen());
    const mouse = (code, col, row, release = false) => pi.send(`\x1b[<${code};${col + 1};${row + 1}${release ? "m" : "M"}`);
    mouse(0, 2, bodyRow); await delay(40);
    mouse(32, 20, bodyRow + 1); await delay(60);
    mouse(0, 20, bodyRow + 1, true);
    // Gestures are processed by Pi's own frame loop; wait for the effect
    // instead of assuming a fixed render latency, which a loaded machine
    // (or a smaller window) can exceed.
    await pi.wait("panel drag highlight", () => pi.highlighted(line => line.includes("panel body")).length > 0);
    await pi.settle();
    const text = pi.screen().split("\n")[bodyRow];
    // A notch can land while the panel is still finishing the drag; scroll
    // until the body actually moves.
    for (let notch = 0; notch < 3 && pi.screen().split("\n")[bodyRow] === text; notch++) {
      mouse(65, 20, bodyRow);
      await delay(300);
    }
    await pi.wait("wheel scrolls panel body", () => pi.screen().split("\n")[bodyRow] !== text);
    // The footer is outside the panel. Neither half of the gesture reaches it.
    mouse(0, 2, rows - 1); await delay(40); mouse(0, 2, rows - 1, true);
    await pi.waitEvents("outside close", events => events.some(event => event.event === "geometry-closed"));
    assert.equal(pi.events().find(event => event.event === "geometry-closed").draft, "DRAFT_STAYS");
    assert.ok(!pi.screen().includes("GEOMETRY_PANEL"), "outside click closes exactly one panel");
    pi.send("\x05\x15");
  });
}

// Real retry events from stock Pi, with the default 2s/4s backoff and a
// deterministic successful third request. Captures are asserted while live:
// spinner/shimmer/countdown frames intentionally have no golden snapshot.
for (const presentation of ["main", "side-chat", "subagent"]) {
  await scenario(`retry-${presentation}`, {
    prompt: "FIXTURE_RETRY recover twice", presentation,
    settings: { pi: { retry: { enabled: true, maxRetries: 10 } } },
  }, async ({ pi, root }) => {
    await pi.wait("first CC retry", () => pi.screen().includes("重试 1/10"));
    const first = pi.screen();
    writeFileSync(join(root, "retry-1.txt"), first);
    assert.match(first, /[✢✳✶✻✽·] .*… · 网络异常 · 重试 1\/10 · [12]s 后（Esc 取消）/u);
    assert.ok(!first.includes("Retrying ("), first);
    await pi.wait("second CC retry", () => pi.screen().includes("重试 2/10"));
    const second = pi.screen();
    writeFileSync(join(root, "retry-2.txt"), second);
    assert.match(second, /… · 上游不可用 · 重试 2\/10 · 4s 后（Esc 取消）/u);
    await pi.wait("second retry countdown", () => pi.screen().includes("重试 2/10 · 3s 后"));
    writeFileSync(join(root, "retry-countdown.txt"), pi.screen());
    await pi.wait("normal working restored", () => pi.screen().includes("Run fixture_wait"));
    const working = pi.screen();
    writeFileSync(join(root, "retry-request.txt"), working);
    assert.ok(!working.includes("重试") && !working.includes("Retrying ("), working);
    await pi.waitEvents("retry settled", events => events.some(event => event.event === "settled"));
    await pi.wait("retry success", () => pi.screen().includes("RETRY_RECOVERED"));
    const success = await pi.settle();
    writeFileSync(join(root, "retry-success.txt"), success);
    assert.ok(!success.includes("重试") && !success.includes("Retrying ("), success);
    assert.equal(pi.events().filter(event => event.event === "retry-response").length, 4);
  });
}

await scenario("retry-escape", {
  prompt: "FIXTURE_RETRY cancel the wait", settings: { pi: { retry: { enabled: true, maxRetries: 10 } } },
}, async ({ pi, root }) => {
  await pi.wait("CC retry before Escape", () => pi.screen().includes("重试 1/10"));
  pi.send("\x1b");
  await pi.waitEvents("cancelled retry settled", events => events.some(event => event.event === "settled"));
  await delay(2_200);
  const screen = await pi.settle();
  writeFileSync(join(root, "retry-cancelled.txt"), screen);
  assert.ok(!screen.includes("重试") && !screen.includes("Retrying ("), screen);
  assert.equal(pi.events().filter(event => event.event === "retry-response").length, 1, "Esc prevented the next request");
});

for (const seam of ["events", "indicator"]) await scenario(`retry-fallback-${seam}`, {
  prompt: "FIXTURE_RETRY keep native", env: { CC_HOST_FIXTURE_RETRY_MISMATCH: seam },
  settings: { pi: { retry: { enabled: true, maxRetries: 10 } } },
}, async ({ pi, root }) => {
  await pi.wait("native retry fallback", () => pi.screen().includes("Retrying (1/10)"));
  const screen = pi.screen();
  writeFileSync(join(root, "retry-native.txt"), screen);
  assert.ok(!screen.includes("重试 1/10"), screen);
  pi.send("\x1b");
  await pi.waitEvents("native retry cancelled", events => events.some(event => event.event === "settled"));
  assert.equal(pi.events().filter(event => event.event === "retry-response").length, 1);
  pi.send("/internals\r");
  await pi.wait("fallback internals", () => pi.screen().includes("▸ internals"));
  writeFileSync(join(root, "retry-native-internals.txt"), await pi.settle());
  await pi.wait("complete fallback internals entry", () => typeof internalsDetails(pi) === "string");
  const details = internalsDetails(pi);
  writeFileSync(join(root, "internals-full.txt"), details);
  assert.ok(details.includes(seam === "events" ? "working.retryEvents" : "working.retryIndicator"), details);
  // The event seam is also the history adapter's compaction lifecycle gate.
  // A deliberately foreign handleEvent disables both features independently.
  if (seam === "events") assert.ok(details.includes("history.renderEntries"), details);
  assert.ok(details.includes(`缺失 (${seam === "events" ? 2 : 1})`), details);
});

// Losing either restoration seam preserves the previously supported current
// view retry row; only background / reentry projection is disabled.
for (const seam of ["session", "view"]) await scenario(`retry-restoration-fallback-${seam}`, {
  prompt: "FIXTURE_RETRY retain current view", env: { CC_HOST_FIXTURE_RETRY_MISMATCH: seam },
  settings: { pi: { retry: { enabled: true, maxRetries: 10 } } },
}, async ({ pi, root }) => {
  await pi.wait("current-view retry fallback", () => pi.screen().includes("网络异常 · 重试 1/10"));
  writeFileSync(join(root, "retry-current-view.txt"), pi.screen());
  assert.ok(!pi.screen().includes("Retrying ("));
  pi.send("\x1b");
  await pi.waitEvents("current-view retry cancelled", events => events.some(event => event.event === "settled"));
  assert.equal(pi.events().filter(event => event.event === "retry-response").length, 1);
  pi.send("/internals\r");
  await pi.wait("restoration fallback diagnostics", () => typeof internalsDetails(pi) === "string");
  const details = internalsDetails(pi);
  writeFileSync(join(root, "internals-full.txt"), details);
  assert.ok(details.includes(seam === "session" ? "working.retrySession" : "working.retryView"), details);
  assert.ok(details.includes("缺失 (1)"), details);
});

// Working and above-editor widgets form one continuous block. Main uses the
// real Todo consumer; Side/Subagent use their production child factories and
// a compact widget because they intentionally do not own Main's Todo state.
for (const presentation of ["main", "side-chat", "subagent"]) {
  await scenario(presentation === "main" ? "todo-working" : `todo-working-${presentation}`, {
    prompt: "FIXTURE_TODO track the work", presentation,
    settings: { pi: { outputPad: 1, editorPaddingX: 0 } },
    env: presentation === "main" ? {} : { CC_HOST_FIXTURE_CHILD_SPACING: "1" },
  }, async ({ pi, root }) => {
    await pi.wait("tool running", () => pi.events().filter(event => event.event === "wait-tick").length >= 2);
    await pi.wait("todo list", () => pi.screen().includes("Write the fixture"));
    if (presentation === "main") pi.send("\x1bt");
    await pi.wait("folded todo", () => pi.screen().includes("1/3"));
    await delay(250);
    const screen = pi.screen();
    writeFileSync(join(root, "folded.txt"), screen);
    const lines = screen.split("\n");
    const todo = lines.findIndex(line => line.includes("1/3") && line.includes("Write the fixture"));
    const metric = lines.findLastIndex((line, index) => index < todo && /↑.*↓/u.test(line));
    assert.ok(metric >= 0 && todo > metric, `working metrics precede the folded widget\n${screen}`);
    assert.ok(lines.slice(metric + 1, todo).every(line => line.trim().length > 0),
      `no blank line between Working and the folded Todo/widget\n${screen}`);
    await pi.waitEvents("settled", events => events.some(event => event.event === "settled"));
  });
}

// Ctrl+T while a tool runs must toggle in place: the transcript's tool and
// assistant components keep their identity (no chat rebuild) and the tool
// keeps reporting progress. The screen itself is only snapshotted at the end.
await scenario("live-toggle", { prompt: "FIXTURE_LIVE wait for the slow tool" }, async ({ pi, capture }) => {
  const ticks = () => pi.events().filter((event) => event.event === "wait-tick");
  await pi.wait("third tick", () => ticks().length >= 3);
  const before = ticks().at(-1);
  assert.ok(before.tools.length > 0, "the running tool component is mounted");
  assert.ok(before.assistants.length > 0, "the assistant component is mounted");
  // The live frame carries a rotating spinner verb; assert it instead of snapshotting.
  assert.ok(pi.screen().includes("Run fixture_wait"), pi.screen());
  pi.send("\x14");
  await pi.wait("toggle while running", () => pi.screen().includes("Thinking blocks: hidden"));
  const toggledAt = ticks().length;
  await pi.wait("ticks after first toggle", () => ticks().length >= toggledAt + 2);
  pi.send("\x14");
  await pi.wait("second toggle while running", () => pi.screen().includes("Thinking blocks: visible"));
  const secondAt = ticks().length;
  await pi.wait("ticks after second toggle", () => ticks().length >= secondAt + 2);
  await pi.waitEvents("settled", (events) => events.some((event) => event.event === "settled"));
  for (const tick of ticks()) {
    assert.deepEqual(tick.tools, before.tools, `tick ${tick.tick}: tool components were rebuilt by Ctrl+T`);
    assert.deepEqual(tick.assistants, before.assistants, `tick ${tick.tick}: assistant components were rebuilt by Ctrl+T`);
  }
  assert.equal(ticks().length, 16, "the tool kept reporting progress through both toggles");
  await capture("settled");
});

writeFileSync(join(runRoot, "result.json"), JSON.stringify({ results, failures }, null, 2));
if (artifactRoot !== runRoot) {
  mkdirSync(artifactRoot, { recursive: true });
  cpSync(runRoot, artifactRoot, { recursive: true });
  rmSync(runRoot, { recursive: true, force: true });
}
for (const result of results) console.log(`${result.passed ? "ok  " : "FAIL"} ${result.name}${result.passed ? "" : `\n${result.error}`}`);
for (const failure of failures) console.log(`SNAPSHOT ${failure}`);
console.log(`artifacts: ${artifactRoot}`);
if (results.some((result) => !result.passed) || failures.length > 0) process.exitCode = 1;
