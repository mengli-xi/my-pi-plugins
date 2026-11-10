import assert from "node:assert/strict";
import xterm from "@xterm/headless";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTW_ANSWERED_TOAST } from "../btw.ts";
import { testPiExecutable } from "./pi-executable.ts";

/**
 * The `/btw` browser under the real Pi interactive loop, at both widths.
 *
 * The layout follows the width the panel is actually given, so the suite drives
 * a real PTY resize rather than a synthetic render: a wide terminal must show
 * the question list beside the answer, a narrow one must become a list that
 * opens into the answer, and going back must keep the same question selected.
 */
const { Terminal } = xterm;
const piExecutable = testPiExecutable();
const packageDir = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const fauxProviderPath = join(packageDir, "test", "btw-faux-provider.ts");
const agentDir = mkdtempSync(join(tmpdir(), "pi-side-btw-browser-"));
const sessionDir = join(agentDir, "sessions");
const home = join(agentDir, "home");
const markerDir = join(agentDir, "markers");
const mainReadyFile = join(agentDir, "main-ready");
const WIDE_COLUMNS = 120;
const NARROW_COLUMNS = 80;
const ROWS = 36;
const PANEL_PROBE = "BROWSER_KEY_PROBE";
const UNREAD_MARK = "\u25cf";
const CHINESE_QUESTION =
  "BTW_QUESTION_THREE 这个仓库里的 Side Chat 扩展在把终端交给子进程之后，"
  + "究竟是怎么保证主会话的编辑器草稿不会被覆盖的？请把关键的几步顺序讲清楚。";
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

const terminal = new Terminal({ cols: WIDE_COLUMNS, rows: ROWS, allowProposedApi: true, scrollback: 1_000 });
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
  terminal: { cols: WIDE_COLUMNS, rows: ROWS, data: (_pty, data) => terminal.write(data) },
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
function lineWith(text: string): string | undefined {
  return screenLines().find((line) => line.includes(text));
}
function occurrences(text: string): number {
  return screenLines().filter((line) => line.includes(text)).length;
}
/** The list rows currently carrying the unread mark. */
function unreadRows(): string[] {
  return screenLines().filter((line) => line.includes(UNREAD_MARK));
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
function release(name: string): void {
  writeFileSync(join(markerDir, `${name}.release`), "release\n");
}
async function resize(columns: number): Promise<void> {
  child.terminal?.resize(columns, ROWS);
  terminal.resize(columns, ROWS);
  await Bun.sleep(1_200);
}
/** Type one command and confirm Pi executed it; see the other BTW suites. */
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

  // Three answers: a plain one, a Markdown one, and a long one behind a long
  // Chinese question. Each marker means the provider finished that question, so
  // the next one is not refused as a duplicate.
  // Keep the first answer unread by submitting at list-only width, then dismiss.
  await resize(NARROW_COLUMNS);
  await submit("first question", "/btw BTW_QUESTION_ONE", () => marker("answer-one", "answered"));
  await waitFor("first answer list", () => screen().includes("Enter open"));
  assert.equal(screen().includes("BTW_PLAIN_ANSWER_ONE"), false, "a narrow submission keeps list semantics");
  input("\x1b");
  await waitFor("first panel closed", () => !screen().includes("BTW > Answers"));
  await resize(WIDE_COLUMNS);
  await submit("second question", "/btw BTW_QUESTION_TWO", () => marker("answer-two", "answered"));
  await waitFor("second answer panel", () => screen().includes("BTW_MD_HEADING"));
  input("\x1b");
  await waitFor("second panel closed", () => !screen().includes("BTW > Answers"));
  await submit("third question", `/btw ${CHINESE_QUESTION}`, () => marker("answer-three", "answered"));
  await waitFor("third answer panel", () => screen().includes("BTW_LONG_LINE_00"));
  assert.equal(screen().includes(BTW_ANSWERED_TOAST), false, "completion updates the panel, not a toast");
  input("\x1b");
  await waitFor("third panel closed", () => !screen().includes("BTW > Answers"));

  // One question left running, so an answer can land while the browser is open.
  input("/btw BTW_QUESTION_FOUR HOLD:live keep this open\r");
  await waitFor("held request started", () => marker("live", "started"));

  // Wide: submission opens pending; selecting an older answer keeps its reader.
  await waitFor("pending browser", () => screen().includes("BTW > Answers") && screen().includes("pending"));
  input("\x1b[B");
  await waitFor("newest completed answer selected", () => screen().includes("BTW_LONG_LINE_00"));
  assert.equal(screen().includes("BTW_QUESTION_THREE"), true, "the Chinese question is listed");
  assert.match(lineWith("BTW_QUESTION_ONE") ?? "", /BTW_QUESTION_ONE\s*│/u,
    "a question row has the column rule to its right");
  assert.match(lineWith("BTW_LONG_LINE_00") ?? "", /│\s*BTW_LONG_LINE_00/u,
    "the answer is drawn in the column beside the questions");
  for (const line of screenLines()) {
    assert.equal(line.length <= WIDE_COLUMNS, true, `line past the terminal width: ${line}`);
  }

  // Down moves the selection and the answer column follows it.
  input("\x1b[B");
  await waitFor("second answer selected", () => screen().includes("BTW_MD_HEADING"));
  assert.equal(screen().includes("## BTW_MD_HEADING"), false,
    "the answer goes through the shared Markdown renderer");
  assert.equal(screen().includes("BTW_MD_ITEM_ONE"), true);
  assert.equal(screen().includes("BTW_LONG_LINE_00"), false);
  input("\x1b[A");
  await waitFor("third answer selected again", () => screen().includes("BTW_LONG_LINE_00"));

  // Tab hands the keys to the answer, which then scrolls on its own.
  input("\t");
  await Bun.sleep(400);
  input("\x1b[6~");
  await waitFor("answer scrolled", () => !screen().includes("BTW_LONG_LINE_00"));
  assert.equal(screen().includes("BTW_QUESTION_THREE"), true, "the question list stays put");
  input("\x1b[5~");
  await waitFor("answer scrolled back", () => screen().includes("BTW_LONG_LINE_00"));

  // An answer that lands now joins the list unread, and says so there instead of
  // behind the browser. The earlier answer's toast has to be gone first, or its
  // last second would be read as this answer's.
  assert.match(lineWith("→") ?? "", /BTW_QUESTION_THREE/u);
  await waitFor("the earlier completion notice expired",
    () => !screen().includes(BTW_ANSWERED_TOAST));
  release("live");
  await waitFor("held answer delivered", () => screen().includes("BTW_QUESTION_FOUR"));
  await Bun.sleep(1_500);
  assert.equal(screen().includes(BTW_ANSWERED_TOAST), false,
    "an answer that lands behind the browser must not post a notice under it");
  assert.equal(occurrences("BTW > Answers"), 1, "no second panel is stacked on the browser");
  assert.match(lineWith("BTW_QUESTION_FOUR") ?? "", /●\s*BTW_QUESTION_FOUR/u,
    "the new answer joins the list unread");
  // The pending row became final; selection and reading position must not move.
  assert.match(lineWith("→") ?? "", /BTW_QUESTION_THREE/u, "the selection did not move");
  assert.equal(screen().includes("BTW_LONG_LINE_00"), true, "nor did the answer being read");
  assert.equal(lineWith("BTW_QUESTION_THREE")?.includes(UNREAD_MARK), false,
    "the answer on screen is a read one");
  const unreadWhenDelivered = unreadRows();

  // Selecting it draws the answer, which is what clears the mark.
  input("\x1b[D");
  await Bun.sleep(400);
  input("\x1b[A");
  await waitFor("the new answer is selected", () => screen().includes("BTW_HELD_ANSWER_LIVE"));
  assert.match(lineWith("BTW_QUESTION_FOUR") ?? "", /→\s+BTW_QUESTION_FOUR/u);
  assert.equal(lineWith("BTW_QUESTION_FOUR")?.includes(UNREAD_MARK), false,
    "drawing the answer cleared its unread mark");
  console.log(JSON.stringify({
    completionNoticeVisibleOverBrowser: screen().includes(BTW_ANSWERED_TOAST),
    unreadWhenDelivered: unreadWhenDelivered.map((line) => line.trim().slice(0, 40)),
    unreadAfterSelecting: unreadRows().map((line) => line.trim().slice(0, 40)),
  }));

  // Put the reader back where the rest of the suite expects it: the long answer,
  // with the keys on the answer column.
  input("\x1b[B");
  await waitFor("the long answer selected again", () => screen().includes("BTW_LONG_LINE_00"));
  input("\t");
  await Bun.sleep(400);

  // Narrow: the answer had the keys, so the same browser lands on the answer as
  // its own page rather than dropping the reader back to the list.
  await resize(NARROW_COLUMNS);
  await waitFor("narrow answer page", () => screen().includes("Esc back"));
  assert.equal(screen().includes("BTW_LONG_LINE_00"), true, "still reading the same answer");
  assert.equal(screen().includes("BTW_QUESTION_ONE"), false, "the answer page is not the list");
  for (const line of screenLines()) {
    assert.equal(line.length <= NARROW_COLUMNS, true, `line past the narrow width: ${line}`);
  }

  input("\x1b");
  await waitFor("narrow list page", () => screen().includes("Enter open"));
  assert.equal(screen().includes("BTW > Answers"), true, "Esc left the answer, not the browser");
  assert.equal(screen().includes("BTW_QUESTION_ONE"), true, "every question is listed");
  assert.equal(screen().includes("BTW_LONG_LINE_00"), false, "the list page shows no answer");
  assert.match(lineWith("→") ?? "", /BTW_QUESTION_THREE/u);

  input("\r");
  await waitFor("narrow answer page again", () => screen().includes("BTW_LONG_LINE_00"));
  assert.equal(screen().includes("Esc back"), true);
  input("\x1b");
  await waitFor("back on the narrow list", () => screen().includes("BTW_QUESTION_ONE"));

  // Back to a wide terminal: two columns again, same question selected.
  await resize(WIDE_COLUMNS);
  await waitFor("wide layout again", () => screen().includes("BTW_LONG_LINE_00"));
  assert.match(lineWith("BTW_QUESTION_ONE") ?? "", /BTW_QUESTION_ONE\s*│/u);
  assert.match(lineWith("→") ?? "", /BTW_QUESTION_THREE/u,
    "the resize kept the question that was selected");
  assert.equal(screen().includes("Tab/→ answer"), true, "the list has the keys again");

  // The browser owns the keyboard until Esc, then Main's editor has it back.
  input(PANEL_PROBE);
  await Bun.sleep(1_000);
  assert.equal(screen().includes("BTW > Answers"), true);
  assert.equal(screen().includes(PANEL_PROBE), false, "the browser consumed the typed text");
  input("\x1b");
  await waitFor("browser closed", () => !screen().includes("BTW > Answers"));
  input("EDITOR_AFTER_BROWSER");
  await waitFor("Main editor accepts input again", () => screen().includes("EDITOR_AFTER_BROWSER"));
  input("\x15");

  // Reopening the browser in the same runtime keeps what was already read: only
  // the one question never shown still carries a mark.
  await submit("reopen the browser", "/btw", () => screen().includes("BTW > Answers"));
  await waitFor("the list is back", () => screen().includes("BTW_QUESTION_FOUR"));
  assert.equal(unreadRows().length, 1, `unexpected unread rows: ${JSON.stringify(unreadRows())}`);
  assert.match(unreadRows()[0]!, /BTW_QUESTION_ONE/u,
    "only the answer that was never drawn is still unread");

  // Narrow: selecting an unread question shows none of its answer, so the mark
  // stays until Enter opens it.
  await resize(NARROW_COLUMNS);
  await waitFor("narrow list page", () => screen().includes("Enter open"));
  input("G");
  await waitFor("the oldest question selected",
    () => /→\s*●\s*BTW_QUESTION_ONE/u.test(screen()));
  await Bun.sleep(600);
  assert.equal(unreadRows().length, 1, "selecting in the narrow list is not reading it");
  const unreadWhenSelected = unreadRows();

  input("\r");
  await waitFor("the narrow answer page", () => screen().includes("BTW_PLAIN_ANSWER_ONE"));
  input("\x1b");
  await waitFor("back on the narrow list", () => screen().includes("Enter open"));
  assert.equal(unreadRows().length, 0, "the answer page cleared the last unread mark");
  console.log(JSON.stringify({
    unreadWhenSelectedNarrow: unreadWhenSelected.map((line) => line.trim().slice(0, 40)),
    unreadAfterNarrowEnter: unreadRows(),
  }));

  input("\x1b");
  await waitFor("browser closed again", () => !screen().includes("BTW > Answers"));
  input("EDITOR_AFTER_REOPEN");
  await waitFor("Main editor still owns the keyboard",
    () => screen().includes("EDITOR_AFTER_REOPEN"));
  input("\x15");
  await resize(WIDE_COLUMNS);

  const persisted = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(sessionDir, name), "utf8"))
    .join("\n");
  for (const marked of [
    "BTW_QUESTION_ONE",
    "BTW_QUESTION_TWO",
    "BTW_QUESTION_THREE",
    "BTW_QUESTION_FOUR",
    "BTW_LONG_LINE_00",
    "BTW_MD_HEADING",
    PANEL_PROBE,
  ]) {
    assert.equal(persisted.includes(marked), false, `BTW ${marked} must not enter a Main transcript`);
  }

  console.log(JSON.stringify({ childPid: child.pid }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child.terminal?.close();
  terminal.dispose();
  rmSync(agentDir, { recursive: true, force: true });
}
