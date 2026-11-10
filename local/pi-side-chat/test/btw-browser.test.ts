import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  InformationPanel,
  type InformationPanelController,
  type InformationPanelMouseEvent,
} from "pi-li-uikit/information-panel";
import { stripAnsi } from "pi-li-uikit/text-panel";
import { btwAnswerKey, type BtwAnswer, type BtwEntry, type BtwReadState } from "../btw.ts";
import {
  BTW_BROWSER_LIST_MAX_WIDTH,
  BTW_BROWSER_LIST_MIN_WIDTH,
  BTW_BROWSER_SEPARATOR_WIDTH,
  BTW_BROWSER_WIDE_MIN_WIDTH,
  BtwBrowser,
  btwAnswerColumnWidth,
  btwBrowserLayout,
  btwListColumnWidth,
  showBtwBrowser,
  wrapPlainText,
} from "../btw-browser.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const usage = {
  input: 10,
  output: 3,
  cacheRead: 90,
  cacheWrite: 0,
  totalTokens: 103,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 1_000;

function answer(question: string, text: string): BtwAnswer {
  clock += 1_000;
  return {
    question,
    answer: text,
    model: "test/model",
    usage: structuredClone(usage),
    exactPrefix: true,
    createdAt: clock,
  };
}

/** Oldest first, the order `BtwController` keeps its history in. */
function history(...answers: BtwAnswer[]): BtwAnswer[] {
  return answers;
}

/** What `BtwController` owns in production, reduced to the Set behind it. */
function readState(): BtwReadState & { readKeys: Set<string> } {
  const readKeys = new Set<string>();
  return {
    readKeys,
    isRead: (entry: BtwAnswer) => readKeys.has(btwAnswerKey(entry)),
    markRead: (entry: BtwAnswer) => { readKeys.add(btwAnswerKey(entry)); },
  };
}

function browser(entries: BtwEntry[], read: BtwReadState = readState()): BtwBrowser {
  return new BtwBrowser({ theme, history: () => entries, read });
}

/** Only `bodyPointAt` matters to the browser; the shell owns the rest. */
function mouseController(bodyRows: number): InformationPanelController {
  return {
    bodyRows,
    scrollOffset: 0,
    maxScrollOffset: 0,
    scrollTo: () => {},
    reveal: () => {},
    close: () => {},
    requestRender: () => {},
    bodyPointAt: (row, column) =>
      (row >= 0 && row < bodyRows ? { row, column } : undefined),
  };
}

function wheel(row: number, column: number, direction: -1 | 1): InformationPanelMouseEvent {
  return { kind: "wheel", button: 0, row, col: column, shift: false, alt: false, ctrl: false, wheel: direction };
}

function press(row: number, column: number): InformationPanelMouseEvent {
  return { kind: "press", button: 0, row, col: column, shift: false, alt: false, ctrl: false, wheel: 0 };
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const ESCAPE = "\x1b";
const ENTER = "\r";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

const LONG_ANSWER = Array.from({ length: 80 }, (_line, index) => `answer line ${index}`).join("\n");
const CHINESE_QUESTION =
  "这个仓库里的 Side Chat 扩展在把终端交给子进程之后，"
  + "究竟是怎么保证主会话的编辑器草稿不被覆盖的？请把关键的几步顺序讲清楚。";

test("the wide layout starts at a fixed panel width and splits the columns from it", () => {
  assert.equal(BTW_BROWSER_WIDE_MIN_WIDTH, 96);
  assert.equal(btwBrowserLayout(BTW_BROWSER_WIDE_MIN_WIDTH - 1), "narrow");
  assert.equal(btwBrowserLayout(BTW_BROWSER_WIDE_MIN_WIDTH), "wide");

  for (const width of [96, 100, 120, 160, 240]) {
    const list = btwListColumnWidth(width);
    assert.ok(list >= BTW_BROWSER_LIST_MIN_WIDTH, `${width}: ${list} below the minimum`);
    assert.ok(list <= BTW_BROWSER_LIST_MAX_WIDTH, `${width}: ${list} above the maximum`);
    assert.equal(btwAnswerColumnWidth(width), width - list - BTW_BROWSER_SEPARATOR_WIDTH);
  }
});

test("the wide layout draws the question list beside the selected answer", () => {
  const view = browser(history(
    answer("first question", "first answer"),
    answer("second question", "second answer"),
  ));
  const lines = view.renderBody(120, 8);
  const listWidth = btwListColumnWidth(120);

  assert.equal(lines.length, 8, "the body fills the row budget it was given");
  for (const line of lines) {
    assert.equal(line.slice(listWidth, listWidth + BTW_BROWSER_SEPARATOR_WIDTH), " │ ");
    assert.ok(visibleWidth(line) <= 120, `line wider than the panel: ${line}`);
  }
  // Newest first, and the newest is what the answer column shows.
  assert.equal(lines[0]!.startsWith("→   second question"), true,
    "the selected answer is on screen, so its row carries no unread mark");
  assert.equal(lines[1]!.startsWith("  ● first question"), true,
    "the answer never shown is still unread");
  assert.equal(lines[0]!.includes("Model: test/model"), true);
  assert.equal(lines.join("\n").includes("second answer"), true);
  assert.equal(lines.join("\n").includes("first answer"), false);
});

test("the wide layout moves the selection with the arrows and the answer follows", () => {
  const view = browser(history(
    answer("first question", "first answer"),
    answer("second question", "second answer"),
  ));
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "second question");

  assert.equal(view.handleKey(DOWN), true);
  const lines = view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "first question");
  assert.equal(lines[1]!.startsWith("→   first question"), true);
  assert.equal(lines.join("\n").includes("first answer"), true);

  assert.equal(view.handleKey(UP), true);
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "second question");
});

test("Tab and the side arrows move the keys between the two columns", () => {
  const view = browser(history(
    answer("first question", "first answer"),
    answer("second question", LONG_ANSWER),
  ));
  view.renderBody(120, 8);
  assert.equal(view.currentFocus(), "list");

  assert.equal(view.handleKey(TAB), true);
  assert.equal(view.currentFocus(), "detail");
  // With the answer focused, the same arrow scrolls instead of selecting.
  assert.equal(view.handleKey(DOWN), true);
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "second question");
  assert.equal(view.answerOffset(), 1);

  assert.equal(view.handleKey(PAGE_DOWN), true);
  view.renderBody(120, 8);
  assert.equal(view.answerOffset(), 9, "a page is the answer viewport height");

  assert.equal(view.handleKey(LEFT), true);
  assert.equal(view.currentFocus(), "list");
  assert.equal(view.handleKey(RIGHT), true);
  assert.equal(view.currentFocus(), "detail");
  assert.equal(view.handleKey(TAB), true);
  assert.equal(view.currentFocus(), "list");
});

test("each answer keeps its own reading position across selection changes", () => {
  const view = browser(history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
  ));
  view.renderBody(120, 8);
  view.handleKey(TAB);
  view.handleKey(PAGE_DOWN);
  view.renderBody(120, 8);
  assert.equal(view.answerOffset(), 8);

  view.handleKey(TAB);
  view.handleKey(DOWN);
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "first question");
  assert.equal(view.answerOffset(), 0, "a different answer starts at its own top");

  view.handleKey(UP);
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "second question");
  assert.equal(view.answerOffset(), 8, "the answer already read comes back where it was");
});

test("the narrow layout is a list, Enter opens the answer, and Esc walks back out", () => {
  const view = browser(history(
    answer("first question", "first answer"),
    answer("second question", "second answer"),
  ));
  const list = view.renderBody(80, 8);
  assert.equal(view.currentLayout(), "narrow");
  assert.equal(view.currentPage(), "list");
  assert.equal(list[0]!.startsWith("→ ● second question"), true,
    "selecting in the narrow list shows no answer, so the row stays unread");
  assert.equal(list.join("\n").includes("second answer"), false, "the list page shows no answer");

  assert.equal(view.handleKey(ENTER), true);
  const detail = view.renderBody(80, 8);
  assert.equal(view.currentPage(), "detail");
  assert.equal(detail.join("\n").includes("second answer"), true);
  assert.equal(detail.join("\n").includes("second question"), true, "the detail page keeps the question");

  assert.equal(view.handleKey(ESCAPE), true, "Esc goes back to the list instead of closing");
  view.renderBody(80, 8);
  assert.equal(view.currentPage(), "list");
  assert.equal(view.handleKey(ESCAPE), false, "a second Esc belongs to the panel, which closes");
});

test("a resize keeps the selection and lands on the matching narrow page", () => {
  const view = browser(history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
  ));
  view.renderBody(120, 8);
  view.handleKey(DOWN);
  view.handleKey(TAB);
  view.handleKey(PAGE_DOWN);
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "first question");
  assert.equal(view.answerOffset(), 8);

  view.renderBody(80, 8);
  assert.equal(view.currentLayout(), "narrow");
  assert.equal(view.currentPage(), "detail", "reading the answer stays reading the answer");
  assert.equal(view.selectedQuestion(), "first question");
  assert.ok(view.answerOffset() > 0, "the reading position survives the reflow");
  assert.ok(view.answerOffset() <= 8 + 40, "and stays inside the reflowed answer");

  view.renderBody(120, 8);
  assert.equal(view.currentLayout(), "wide");
  assert.equal(view.currentFocus(), "detail");
  assert.equal(view.selectedQuestion(), "first question");

  // A resize taken from the narrow list comes back with the list focused.
  view.renderBody(80, 8);
  view.handleKey(ESCAPE);
  view.renderBody(80, 8);
  view.renderBody(120, 8);
  assert.equal(view.currentFocus(), "list");
  assert.equal(view.selectedQuestion(), "first question");
});

test("a long Chinese question never draws past the column it was given", () => {
  const view = browser(history(answer(CHINESE_QUESTION, "answer")));
  for (const width of [120, 96, 80, 60, 40]) {
    for (const line of view.renderBody(width, 8)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} > ${width}`);
    }
  }
  // The truncated list title is not the whole question: the detail page has it.
  const narrow = browser(history(answer(CHINESE_QUESTION, "answer")));
  narrow.renderBody(80, 12);
  narrow.handleKey(ENTER);
  const detail = narrow.renderBody(80, 12).join("");
  assert.equal(detail.includes("究竟是怎么保证主会话的编辑器草稿"), true);
  for (const line of narrow.renderBody(80, 12)) assert.ok(visibleWidth(line) <= 80);
});

test("plain wrapping breaks on spaces and, where there are none, between characters", () => {
  assert.deepEqual(wrapPlainText("alpha beta gamma", 11), ["alpha beta", "gamma"]);
  const wrapped = wrapPlainText("一二三四五六", 6);
  assert.deepEqual(wrapped, ["一二三", "四五六"]);
  for (const line of wrapped) assert.ok(visibleWidth(line) <= 6);
});

test("the answer is drawn through the shared panel Markdown renderer", () => {
  const view = browser(history(answer("q", "## Heading\n\n- first item\n- second item\n\n> quoted")));
  const body = view.renderBody(120, 12).join("\n");
  assert.equal(body.includes("Heading"), true);
  assert.equal(body.includes("## Heading"), false, "a heading is rendered, not shown as source");
  assert.equal(body.includes("│ quoted"), true, "a quote gets the renderer's own rule");
  assert.equal(body.includes("> quoted"), false);
});

test("the wide layout marks the answer it draws read, and only that one", () => {
  const read = readState();
  const entries = history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
  );
  const view = browser(entries, read);
  const lines = view.renderBody(120, 8);
  assert.deepEqual([...read.readKeys], [btwAnswerKey(entries[1]!)],
    "opening the browser reads the selected answer, and nothing else");
  assert.equal(lines[0]!.startsWith("→   second question"), true);
  assert.equal(lines[1]!.startsWith("  ● first question"), true);

  view.handleKey(DOWN);
  const moved = view.renderBody(120, 8);
  assert.equal(read.isRead(entries[0]!), true, "selecting it drew it, so it is read");
  assert.equal(moved[1]!.startsWith("→   first question"), true, "the mark goes in the same frame");
  assert.equal(moved[0]!.startsWith("    second question"), true,
    "and an unselected answer already read keeps both columns empty");
});

test("the narrow list marks nothing read until Enter draws the answer", () => {
  const read = readState();
  const entries = history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
  );
  const view = browser(entries, read);
  const list = view.renderBody(80, 8);
  assert.deepEqual([...read.readKeys], [], "the narrow list page shows no answer at all");
  assert.equal(list[0]!.startsWith("→ ● second question"), true);

  view.handleKey(ENTER);
  view.renderBody(80, 8);
  assert.equal(read.isRead(entries[1]!), true, "the answer page is the answer, drawn");

  view.handleKey(ESCAPE);
  const back = view.renderBody(80, 8);
  assert.equal(back[0]!.startsWith("→   second question"), true);
  assert.equal(back[1]!.startsWith("  ● first question"), true, "the other answer is still unread");
});

test("a resize marks read what the layout it lands in actually draws", () => {
  const read = readState();
  const entries = history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
    answer("third question", LONG_ANSWER),
  );
  const view = browser(entries, read);
  view.renderBody(80, 8);
  assert.deepEqual([...read.readKeys], [], "a narrow list read nothing");

  // Narrow list to wide: the answer column now shows the selected answer, which
  // is the user seeing it.
  const wide = view.renderBody(120, 8);
  assert.equal(read.isRead(entries[2]!), true);
  assert.equal(wide[0]!.startsWith("→   third question"), true);

  // Wide back to a narrow list page: nothing else was ever drawn, so nothing
  // else may be cleared.
  const narrow = view.renderBody(80, 8);
  assert.equal(view.currentPage(), "list");
  assert.equal(read.isRead(entries[1]!), false);
  assert.equal(read.isRead(entries[0]!), false);
  assert.equal(narrow[1]!.startsWith("  ● second question"), true);
  assert.equal(narrow[2]!.startsWith("  ● first question"), true);
});

test("read state belongs to the owner, so a browser opened again keeps it", () => {
  const read = readState();
  const entries = history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
  );
  const first = browser(entries, read);
  first.renderBody(80, 8);
  first.handleKey(DOWN);
  first.handleKey(ENTER);
  first.renderBody(80, 8);

  const reopened = browser(entries, read);
  const lines = reopened.renderBody(80, 8);
  assert.equal(lines[0]!.startsWith("→ ● second question"), true,
    "the answer this session never drew is still unread");
  assert.equal(lines[1]!.startsWith("    first question"), true,
    "the one already read stays read across a close and reopen");
});

test("the unread column is part of the question column, not past it", () => {
  const read = readState();
  const entries = history(
    answer(CHINESE_QUESTION, "answer one"),
    answer(`${CHINESE_QUESTION} 2`, "answer two"),
  );
  const view = browser(entries, read);
  for (const width of [120, 96, 80, 60, 40]) {
    const lines = view.renderBody(width, 8);
    assert.equal(lines.some((line) => line.includes("●")), true, `width ${width}: no unread mark`);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} > ${width}`);
    }
  }
});

test("an answer that lands while the browser is open leaves the selection alone", () => {
  const entries = history(
    answer("first question", LONG_ANSWER),
    answer("second question", "second answer"),
  );
  const view = new BtwBrowser({ theme, history: () => entries, read: readState() });
  view.renderBody(120, 8);
  view.handleKey(DOWN);
  view.renderBody(120, 8);
  view.handleKey(TAB);
  view.handleKey(PAGE_DOWN);
  const reading = view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "first question");
  assert.equal(view.answerOffset(), 8);

  entries.push(answer("third question", "third answer"));
  const lines = view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "first question", "a new answer must not steal the selection");
  assert.equal(view.answerOffset(), 8, "nor move the answer being read");
  assert.equal(view.currentFocus(), "detail", "nor take the keys back");
  assert.equal(lines[0]!.startsWith("  ● third question"), true,
    "but it does join the list, newest first, and unread");
  assert.equal(lines[2]!.startsWith("→   first question"), true);
  assert.deepEqual(lines.map((line) => line.split(" │ ")[1]), reading.map((line) => line.split(" │ ")[1]),
    "the answer column is drawn exactly where it already was");
});

test("pending becomes the final answer in place without changing wide focus or selection", () => {
  const read = readState();
  const completed = answer("pending question", LONG_ANSWER);
  const entries: BtwEntry[] = [{ state: "pending", question: completed.question, createdAt: completed.createdAt }];
  const view = browser(entries, read);
  const waiting = view.renderBody(120, 8);
  assert.match(waiting.join("\n"), /pending · Waiting for BTW answer/u);
  assert.equal(read.readKeys.size, 0, "pending is not an answer the user has read");
  view.handleKey(TAB);
  entries[0] = completed;
  const final = view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), completed.question);
  assert.equal(view.currentFocus(), "detail");
  assert.equal(view.answerOffset(), 0);
  assert.equal(final.join("\n").includes("pending ·"), false, "the pending render cache is invalidated");
  assert.equal(final.join("\n").includes("answer line 0"), true);
  assert.equal(read.isRead(completed), true);
});

test("narrow pending stays a list row until Enter, then updates on the same detail page", () => {
  const read = readState();
  const completed = answer("pending question", "final answer");
  const entries: BtwEntry[] = [{ state: "pending", question: completed.question, createdAt: completed.createdAt }];
  const view = browser(entries, read);
  assert.match(view.renderBody(60, 10).join("\n"), /pending · pending question/u);
  assert.equal(view.currentPage(), "list");
  view.handleKey(ENTER);
  assert.match(view.renderBody(60, 10).join("\n"), /Waiting for BTW answer/u);
  assert.equal(read.readKeys.size, 0);
  entries[0] = completed;
  assert.match(view.renderBody(60, 10).join("\n"), /final answer/u);
  assert.equal(view.currentPage(), "detail");
  assert.equal(read.isRead(completed), true);
  assert.equal(view.handleKey(ESCAPE), true);
  assert.equal(view.currentPage(), "list", "Esc still goes back rather than closing");
});

test("the mounted panel requests a render on completion and releases its subscription on shutdown", async () => {
  const completed = answer("pending question", "updated answer");
  const entries: BtwEntry[] = [{ state: "pending", question: completed.question, createdAt: completed.createdAt }];
  const lifetime = new AbortController();
  let listener: (() => void) | undefined;
  let renders = 0;
  let unsubscribed = false;
  let component!: { render(width: number): string[] };
  const task = showBtwBrowser({ ui: {
    custom: (factory: (...args: any[]) => unknown) => new Promise<void>(resolve => {
      component = factory({ terminal: { rows: 30, columns: 120 }, children: [], requestRender: () => { renders++; } },
        theme, {}, resolve) as typeof component;
    }),
  } } as never, () => entries, readState(), {
    signal: lifetime.signal,
    subscribe: (callback) => {
      listener = callback;
      return () => { listener = undefined; unsubscribed = true; };
    },
  });
  assert.match(component.render(120).join("\n"), /Waiting for BTW answer/u);
  entries[0] = completed;
  listener!();
  assert.equal(renders, 1, "the completion schedules a real host render");
  assert.match(component.render(120).join("\n"), /updated answer/u);
  lifetime.abort();
  await task;
  assert.equal(unsubscribed, true);
  assert.equal(listener, undefined);
});

test("an empty history draws one line and answers no navigation keys", () => {
  const view = browser([]);
  const lines = view.renderBody(120, 8);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.includes("No BTW answers"), true);
  assert.equal(view.handleKey(DOWN), false);
  assert.equal(view.handleKey(ESCAPE), false);
});

test("clicking the question column selects that row without moving the answer", () => {
  const entries = history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
    answer("third question", LONG_ANSWER),
  );
  const view = new BtwBrowser({ theme, history: () => entries, read: readState() });
  view.renderBody(120, 8);
  view.handleKey(TAB);
  view.handleKey(DOWN);
  view.renderBody(120, 8);
  assert.equal(view.answerOffset(), 1);

  assert.equal(view.handleMouse(press(2, 4), mouseController(8)), true);
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "first question");
  assert.equal(view.currentFocus(), "list");
  assert.equal(view.answerOffset(), 0);

  // A click below the last question stays inside the browser instead of falling
  // through, and changes nothing.
  assert.equal(view.handleMouse(press(6, 4), mouseController(8)), true);
  view.renderBody(120, 8);
  assert.equal(view.selectedQuestion(), "first question");
});

test("the wheel scrolls whichever column it is over", () => {
  const view = browser(history(answer("only question", LONG_ANSWER)));
  view.renderBody(120, 8);
  const answerColumn = btwListColumnWidth(120) + 10;

  assert.equal(view.handleMouse(wheel(3, answerColumn, 1), mouseController(8)), true);
  view.renderBody(120, 8);
  assert.equal(view.answerOffset(), 3);

  assert.equal(view.handleMouse(wheel(3, answerColumn, -1), mouseController(8)), true);
  view.renderBody(120, 8);
  assert.equal(view.answerOffset(), 0);

  // Over the question column the wheel moves the list, not the answer.
  assert.equal(view.handleMouse(wheel(3, 2, 1), mouseController(8)), true);
  view.renderBody(120, 8);
  assert.equal(view.answerOffset(), 0);

  // A report outside the body is not the browser's to consume.
  assert.equal(view.handleMouse(wheel(20, answerColumn, 1), mouseController(8)), false);
});

test("the narrow detail page scrolls with the wheel and pages with the keys", () => {
  const view = browser(history(answer("only question", LONG_ANSWER)));
  view.renderBody(80, 8);
  view.handleKey(ENTER);
  view.renderBody(80, 8);

  assert.equal(view.handleMouse(wheel(3, 40, 1), mouseController(8)), true);
  view.renderBody(80, 8);
  assert.equal(view.answerOffset(), 3);

  assert.equal(view.handleKey(PAGE_UP), true);
  view.renderBody(80, 8);
  assert.equal(view.answerOffset(), 0);
});

test("the footer names the keys of the layout and region actually on screen", () => {
  const view = browser(history(answer("only question", LONG_ANSWER)));
  view.renderBody(120, 8);
  assert.match(view.footerHints()[0]!, /Tab\/→ answer/u);
  view.handleKey(TAB);
  view.renderBody(120, 8);
  assert.match(view.footerHints()[0]!, /Tab\/← questions/u);

  view.renderBody(80, 8);
  assert.match(view.footerHints()[0]!, /Enter close · Esc back/u);
  // The answer page closes on Enter, so even its narrowest hint names both keys.
  assert.equal(view.footerHints().at(-1), "Enter close · Esc back");
  view.handleKey(ESCAPE);
  view.renderBody(80, 8);
  assert.match(view.footerHints()[0]!, /Enter open/u);
});

/** The browser inside the real shared shell, not just its own state machine. */
function panelFor(entries: BtwAnswer[], rows: number) {
  let closed = 0;
  const view = new BtwBrowser({ theme, history: () => entries, read: readState() });
  const panel = new InformationPanel({
    tui: {
      terminal: { rows, columns: 200, write: () => {} },
      requestRender: () => {},
    } as unknown as TUI,
    theme,
    getView: () => view.view(),
    onInput: (data) => view.handleKey(data),
    onMouse: (event, controller) => view.handleMouse(event, controller),
    onClose: () => { closed++; },
  });
  return { panel, view, get closed() { return closed; } };
}

test("the browser fills the shared information frame and closes from the wide layout", () => {
  const host = panelFor(history(
    answer("first question", LONG_ANSWER),
    answer("second question", LONG_ANSWER),
  ), 30);
  host.panel.setAvailableHeight(14);
  const lines = host.panel.render(120).map(stripAnsi);

  assert.equal(lines.length, 14, "the frame keeps the tallest allowed height");
  assert.match(lines[0]!, /^── BTW > Answers ─+$/u);
  assert.match(lines.at(-1)!, /Esc close ──$/u);
  assert.equal(lines[2]!.startsWith("→   second question"), true);

  // The shared reader has nothing to scroll: the browser owns both viewports.
  host.panel.handleInput("\x1b[B");
  assert.equal(host.panel.render(120).map(stripAnsi)[2]!.startsWith("    second question"), true);
  host.panel.handleInput("\x1b");
  assert.equal(host.closed, 1);
});

test("the narrow browser closes only from its list page", () => {
  const host = panelFor(history(answer("only question", LONG_ANSWER)), 30);
  host.panel.setAvailableHeight(14);
  const list = host.panel.render(80).map(stripAnsi);
  assert.match(list[0]!, /^── BTW > Answers ─+$/u);

  host.panel.handleInput("\r");
  const detail = host.panel.render(80).map(stripAnsi);
  assert.match(detail[0]!, /^── BTW > Answers > only question ─+$/u);
  assert.equal(host.closed, 0);

  host.panel.handleInput("\x1b");
  assert.match(host.panel.render(80).map(stripAnsi)[0]!, /^── BTW > Answers ─+$/u);
  assert.equal(host.closed, 0, "the first Esc only leaves the answer");

  host.panel.handleInput("\x1b");
  assert.equal(host.closed, 1);
});
