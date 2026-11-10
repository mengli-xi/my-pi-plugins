import assert from "node:assert/strict";
import xterm from "@xterm/headless";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTW_ANSWERED_TOAST } from "../btw.ts";
import { testPiExecutable } from "./pi-executable.ts";

/**
 * BTW command dispatch under the real Pi interactive loop. Pi awaits an
 * extension command handler before it reads the next input, so this suite drives
 * every command through the PTY editor: a `/btw cancel` typed while the model
 * request is still pending must reach the controller instead of queuing behind
 * the answer.
 */
const { Terminal } = xterm;
const piExecutable = testPiExecutable();
const packageDir = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const fauxProviderPath = join(packageDir, "test", "btw-faux-provider.ts");
const agentDir = mkdtempSync(join(tmpdir(), "pi-side-btw-"));
const sessionDir = join(agentDir, "sessions");
const home = join(agentDir, "home");
const markerDir = join(agentDir, "markers");
const mainReadyFile = join(agentDir, "main-ready");
const PANEL_PROBE = "BROWSER_FOCUS_PROBE";
mkdirSync(sessionDir, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(markerDir, { recursive: true });
mkdirSync(join(agentDir, "tmp"), { recursive: true });
mkdirSync(join(agentDir, "run"), { recursive: true, mode: 0o700 });
writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
  quietStartup: true,
  defaultProvider: "side-faux",
  defaultModel: "side-faux-1",
  defaultThinkingLevel: "off",
  packages: [packageDir],
}, null, 2)}\n`, { mode: 0o600 });

const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 1_000 });
const child = Bun.spawn({
  cmd: [
    piExecutable,
    "--session-dir", sessionDir,
    "--tui-mode", "fullscreen",
    "--approve",
    "--offline",
    "--provider", "side-faux",
    "--model", "side-faux-1",
    "-e", fauxProviderPath,
  ],
  cwd: agentDir,
  env: {
    PATH: process.env.PATH,
    // Preserve the test runner's offline guard, not the caller's Pi profile.
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    HOME: home,
    TMPDIR: join(agentDir, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(agentDir, "run"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_BTW_TEST_MARKERS: markerDir,
    PI_SIDECHAT_TEST_READY_FILE: mainReadyFile,
    TERM: "xterm-256color",
  },
  terminal: { cols: 100, rows: 30, data: (_pty, data) => terminal.write(data) },
  onExit: (_child, code, signal, error) => {
    if (code && code !== 0) console.error(error ?? `Pi exited ${code} ${signal ?? ""}`);
  },
});
if (!child.terminal) throw new Error("PTY unavailable");

function screenLines(): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }
  return lines;
}
function screen(): string { return screenLines().join("\n"); }
function occurrences(text: string): number {
  return screenLines().filter((line) => line.includes(text)).length;
}
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null) throw new Error(`Pi exited before ${label} (${child.exitCode})\n${screen()}`);
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}\n${screen()}`);
}
function input(text: string): void { child.terminal?.write(text); }
function marker(name: string, event: string): boolean {
  return existsSync(join(markerDir, `${name}.${event}`));
}
function markerAt(name: string, event: string): number {
  const raw = JSON.parse(readFileSync(join(markerDir, `${name}.${event}`), "utf8")) as { monotonicMs: number };
  return raw.monotonicMs;
}
function release(name: string): void {
  writeFileSync(join(markerDir, `${name}.release`), "release\n");
}
/**
 * Type one command and confirm Pi executed it. A first Enter can be consumed by
 * the slash-command autocomplete instead of submitting, so the line is re-sent
 * until `executed` holds; Pi ignores the extra empty submits.
 */
async function submit(label: string, text: string, executed: () => boolean, timeoutMs = 30_000): Promise<void> {
  input(`${text}\r`);
  const deadline = Date.now() + timeoutMs;
  let nextRetry = Date.now() + 600;
  while (Date.now() < deadline) {
    if (executed()) return;
    if (child.exitCode !== null) throw new Error(`Pi exited before ${label} (${child.exitCode})\n${screen()}`);
    if (Date.now() >= nextRetry) {
      input("\r");
      nextRetry = Date.now() + 600;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out submitting ${label}\n${screen()}`);
}

try {
  await waitFor("Main editor", () => /side-faux|side-faux-1|What would you like/u.test(screen()));
  await waitFor("Main extension ready", () => existsSync(mainReadyFile));

  // A long question the faux provider holds open until the test releases it.
  input("/btw HOLD:cancelrun write everything you know\r");
  await waitFor("held BTW request started", () => marker("cancelrun", "started"));
  await waitFor("BTW status row", () => screen().includes("BTW…"));
  await waitFor("pending panel", () => screen().includes("pending") && screen().includes("BTW > Answers"));
  input("\x1b");
  await waitFor("pending panel closed", () => !screen().includes("BTW > Answers"));

  // The dispatcher is free while the request runs: the next command is executed
  // instead of queuing, and the duplicate guard still answers visibly.
  await submit("duplicate BTW", "/btw DUPLICATE_QUESTION",
    () => screen().includes("A BTW question is already running"));
  assert.equal(marker("cancelrun", "resolved"), false,
    "the duplicate must be reported while the first completion is still pending");

  await submit("/btw cancel", "/btw cancel", () => marker("cancelrun", "abort"));
  assert.equal(marker("cancelrun", "resolved"), false,
    "the AbortSignal must fire before the held completion resolves");
  await waitFor("BTW status cleared", () => !screen().includes("BTW…"));

  release("cancelrun");
  await waitFor("held completion resolved", () => marker("cancelrun", "resolved"));
  assert.equal(markerAt("cancelrun", "abort") < markerAt("cancelrun", "resolved"), true);
  await Bun.sleep(1_500);
  assert.equal(screen().includes("BTW_HELD_ANSWER_CANCELRUN"), false,
    "a cancelled request must not deliver its answer");
  assert.equal(screen().includes(BTW_ANSWERED_TOAST), false,
    "a cancelled request must not report success");
  assert.equal(screen().includes("BTW > Answers"), false,
    "a cancelled request must not reopen the dismissed panel");

  const usageBefore = occurrences("Usage: /btw <question>");
  await submit("empty /btw history", "/btw",
    () => occurrences("Usage: /btw <question>") > usageBefore);

  // Submission opens the browser; completion updates it without another panel.
  await submit("second BTW", "/btw BTW_SECOND_QUESTION",
    () => screen().includes("BTW > Answers"));
  await waitFor("answer in the browser", () => screen().includes("BTW_SECOND_ANSWER"));
  assert.equal(occurrences("BTW > Answers"), 1, "one live panel, not one per completion");
  assert.equal(occurrences(BTW_ANSWERED_TOAST), 0, "no completion notice behind the panel");
  input(PANEL_PROBE);
  await Bun.sleep(1_000);
  assert.equal(screen().includes("BTW > Answers"), true,
    "typing must not fall through to Main and dismiss the browser");
  assert.equal(screen().includes(PANEL_PROBE), false, "the browser consumed the typed text");
  input("\x1b");
  await waitFor("browser closed", () => !screen().includes("BTW > Answers"));
  assert.equal(screen().includes("BTW_SECOND_ANSWER"), false);

  // Closing before completion leaves Main in front when the full answer arrives.
  input("/btw HOLD:dismissed keep Main in front\r");
  await waitFor("dismissed request started", () => marker("dismissed", "started"));
  await waitFor("dismissible pending panel", () => screen().includes("pending"));
  input("\x1b");
  await waitFor("dismissed panel closed", () => !screen().includes("BTW > Answers"));
  release("dismissed");
  await waitFor("dismissed completion notice", () => screen().includes(BTW_ANSWERED_TOAST));
  assert.equal(occurrences(BTW_ANSWERED_TOAST), 1, "one notice after dismissal");
  assert.equal(screen().includes("BTW_HELD_ANSWER_DISMISSED"), false, "the notice carries no answer text");
  assert.equal(screen().includes("BTW > Answers"), false, "completion must not steal focus back");

  // Manual browsing still works after dismissal.
  await submit("open the BTW browser", "/btw", () => screen().includes("BTW > Answers"));
  await waitFor("dismissed answer in browser", () => screen().includes("BTW_HELD_ANSWER_DISMISSED"));
  input("\x1b");
  await waitFor("manual browser closed", () => !screen().includes("BTW > Answers"));

  const failureNoticeBefore = occurrences(BTW_ANSWERED_TOAST);
  await submit("failing BTW", "/btw FAIL_THIS_REQUEST please",
    () => marker("failure", "started"));
  await waitFor("failing request pending panel", () => screen().includes("pending") && screen().includes("BTW > Answers"));
  release("failure");
  await waitFor("provider failure", () => screen().includes("BTW_PROVIDER_FAILURE"));
  assert.equal(occurrences(BTW_ANSWERED_TOAST) <= failureNoticeBefore, true,
    "a failed request must not report success");
  await waitFor("failure reveals Main", () => !screen().includes("BTW > Answers"));

  // Session replacement aborts the request and drops its late result.
  input("/btw HOLD:stalerun keep this open across /new\r");
  await waitFor("stale BTW request started", () => marker("stalerun", "started"));
  await waitFor("stale pending panel", () => screen().includes("pending"));
  input("\x1b");
  await waitFor("stale panel dismissed", () => !screen().includes("BTW > Answers"));
  await submit("/new", "/new", () => screen().includes("New session started"));
  await waitFor("session replacement aborts BTW", () => marker("stalerun", "abort"));
  assert.equal(marker("stalerun", "resolved"), false);
  release("stalerun");
  await waitFor("stale completion resolved", () => marker("stalerun", "resolved"));
  await Bun.sleep(1_500);
  assert.equal(screen().includes("BTW_HELD_ANSWER_STALERUN"), false,
    "a replaced session must not deliver the old answer");
  assert.equal(screen().includes(BTW_ANSWERED_TOAST), false,
    "a replaced session must not report success");

  const usageAfterNew = occurrences("Usage: /btw <question>");
  await submit("history after /new", "/btw",
    () => occurrences("Usage: /btw <question>") > usageAfterNew);

  const persisted = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => Bun.file(join(sessionDir, name)).text());
  const transcript = (await Promise.all(persisted)).join("\n");
  for (const marked of [
    "HOLD:cancelrun",
    "HOLD:stalerun",
    "BTW_SECOND_QUESTION",
    "BTW_SECOND_ANSWER",
    "BTW_HELD_ANSWER_",
  ]) {
    assert.equal(transcript.includes(marked), false, `BTW ${marked} must not enter a Main transcript`);
  }

  console.log(JSON.stringify({
    cancelAbortMs: markerAt("cancelrun", "abort") - markerAt("cancelrun", "started"),
    cancelResolveMs: markerAt("cancelrun", "resolved") - markerAt("cancelrun", "started"),
    childPid: child.pid,
  }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child.terminal?.close();
  terminal.dispose();
  rmSync(agentDir, { recursive: true, force: true });
}
