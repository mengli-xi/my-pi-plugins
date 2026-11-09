import assert from "node:assert/strict";
import test from "node:test";
import { click, sendInput } from "./native-mouse.ts";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { clickable } from "../src/clickable.ts";
import { DEFAULT_OVERLAY } from "../src/config.ts";
import { RuntimeOverlayOpeners } from "../src/openers.ts";
import { TextOverlay } from "pi-li-uikit/text-panel";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

function row(lines: string[]): Component & { invalidated: number } {
  const component = {
    invalidated: 0,
    render: () => lines,
    invalidate() {
      component.invalidated++;
    },
  };
  return component;
}

test("a clickable row draws and invalidates exactly like the row it wraps", () => {
  const inner = row(["Read 3 files"]);
  const wrapped = clickable(inner, () => true);
  assert.deepEqual(wrapped.render(80), ["Read 3 files"]);
  wrapped.invalidate?.();
  assert.equal(inner.invalidated, 1);
});

test("a click is passed the row-local position and its answer is returned", () => {
  const seen: Array<{ row: number; col: number }> = [];
  const wrapped = clickable(row(["a"]), (line, col) => {
    seen.push({ row: line, col });
    return true;
  });

  assert.equal(click(wrapped, 2, 9), true);
  assert.deepEqual(seen, [{ row: 2, col: 9 }]);
});

test("fullscreen left-click runs the action with component-local coordinates", () => {
  const seen: Array<{ row: number; col: number }> = [];
  const wrapped = clickable(row(["a"]), (line, col) => {
    seen.push({ row: line, col });
    return true;
  });
  const result = wrapped.handleMouse?.({
    type: "click",
    button: "left",
    x: 7,
    y: 2,
    screenX: 17,
    screenY: 12,
    width: 80,
    height: 3,
    shift: false,
    alt: false,
    ctrl: false,
  } satisfies TuiMouseEvent);
  assert.equal(result?.handled, true);
  assert.deepEqual(seen, [{ row: 2, col: 7 }]);
});

test("fullscreen preserves a child mouse handler before its own action", () => {
  let opened = 0;
  const child = row(["link"]);
  child.handleMouse = () => ({ handled: true });
  const wrapped = clickable(child, () => {
    opened++;
    return true;
  });
  const result = wrapped.handleMouse?.({
    type: "click",
    button: "left",
    x: 1,
    y: 0,
    screenX: 1,
    screenY: 0,
    width: 20,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(result?.handled, true);
  assert.equal(opened, 0);
});

test("a row whose action throws reports the click as unused", () => {
  const wrapped = clickable(row(["a"]), () => {
    throw new Error("no session");
  });
  assert.equal(click(wrapped), false);
});

test("rows are inert until a session registers the openers", () => {
  const openers = new RuntimeOverlayOpeners();
  assert.equal(openers.openGroupFor("call-1"), false);
  assert.equal(openers.openTextFor("Thinking", "reasoned"), false);
  assert.equal(openers.openImagesFor([{ data: "eA==", mimeType: "image/png", sizeBytes: 1 }]), false);

  const opened: string[] = [];
  openers.set({
    group: (toolCallId) => {
      opened.push(toolCallId);
      return true;
    },
    text: (heading, body) => {
      opened.push(`${heading}:${body}`);
      return true;
    },
    images: (images) => {
      opened.push(`images:${images.length}`);
      return true;
    },
  });
  assert.equal(openers.openGroupFor("call-1"), true);
  assert.equal(openers.openTextFor("Thinking", "reasoned"), true);
  assert.equal(openers.openImagesFor([{ data: "eA==", mimeType: "image/png", sizeBytes: 1 }]), true);
  assert.deepEqual(opened, ["call-1", "Thinking:reasoned", "images:1"]);

  // Shutdown must leave stale rows unable to open anything.
  openers.clear();
  assert.equal(openers.openGroupFor("call-1"), false);
  assert.equal(openers.openImagesFor([{ data: "eA==", mimeType: "image/png", sizeBytes: 1 }]), false);
});

test("an image opener receives the captured payload and is cleared with the runtime", () => {
  const openers = new RuntimeOverlayOpeners();
  let received = 0;
  openers.set({
    images: (images) => {
      received = images.length;
      return true;
    },
  });
  const image = { data: "eA==", mimeType: "image/png", sizeBytes: 1 };
  assert.equal(openers.openImagesFor([image]), true);
  assert.equal(received, 1);
  assert.equal(openers.openImagesFor([]), false);
  openers.clear();
  assert.equal(openers.openImagesFor([image]), false);
});

test("an opener that declines leaves the click unused", () => {
  const openers = new RuntimeOverlayOpeners();
  openers.set({ group: () => false });
  assert.equal(openers.openGroupFor("pruned-call"), false);
});

test("empty prose never opens a popup", () => {
  const openers = new RuntimeOverlayOpeners();
  let calls = 0;
  openers.set({
    text: () => {
      calls++;
      return true;
    },
  });
  assert.equal(openers.openTextFor("Thinking", "   \n  "), false);
  assert.equal(calls, 0);
});

const strip = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function textOverlay(body: string, rows = 24) {
  const tui = {
    terminal: { rows, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  return new TextOverlay({
    tui,
    theme: plainTheme,
    heading: "Thinking",
    body,
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 },
    onClose: () => {},
  });
}

test("the text popup is open: title in the accent rule, body after one blank row", () => {
  const view = textOverlay("first paragraph\n\nsecond paragraph");
  const rendered = view.render(60).map(strip);

  assert.match(rendered[0]!, /^── ✻ Thinking ─+ 3 lines$/, "title is woven into the top rule");
  assert.equal(rendered[1]!.trim(), "", "one blank row separates the rule and body");
  assert.match(rendered.at(-1)!, /^─+ g\/G top\/bottom · y copy · Enter\/Esc close ──$/);
  assert.ok(rendered.every((line) => !/[│╭╮╰╯]/u.test(line)), "the panel has no side borders");

  assert.ok(rendered.some((line) => line.includes("first paragraph")));
  assert.ok(rendered.some((line) => line.includes("second paragraph")));
  // A blank line between paragraphs survives rather than being reflowed away.
  const first = rendered.findIndex((line) => line.includes("first paragraph"));
  const second = rendered.findIndex((line) => line.includes("second paragraph"));
  assert.equal(second - first, 2);
});

test("the open panel reserves three body rows and caps itself at 70%", () => {
  const short = textOverlay("one line", 40).render(60);
  assert.equal(short.length, 7, "three body rows plus the four-row open frame");
  assert.match(short.map(strip).at(-1)!, /g\/G top\/bottom · y copy · Enter\/Esc close ──$/);

  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const tall = textOverlay(long, 40).render(60);
  assert.equal(tall.length, 28, "the complete panel stays within 70% of the terminal");
  assert.match(tall.map(strip).at(-1)!, /Esc close/);

  // In between, it is as tall as its content and frame require.
  const middling = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(textOverlay(middling, 40).render(60).length, 16);
});

test("the text popup scrolls and has no sections to jump between", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const view = textOverlay(long);
  const first = view.render(60).map(strip);
  assert.ok(first.some((line) => line.includes("line 0")));

  sendInput(view, "\x1b[<65;10;5M"); // wheel down
  const scrolled = view.render(60).map(strip);
  assert.ok(!scrolled.some((line) => line.includes("line 0")));

  // Position rides the title row, keeping the footer short enough to survive a
  // narrow card; with no sections there is no call counter and no fold hint.
  assert.match(scrolled[0]!, /\d+-\d+\/200/);
  const footer = scrolled.find((line) => line.includes("Esc close"))!;
  assert.ok(!footer.includes("call "));
  assert.ok(!footer.includes("fold"));

  sendInput(view, "\x1b[H"); // home
  assert.ok(view.render(60).map(strip).some((line) => line.includes("line 0")));
});

test("enter dismisses a panel that has nothing to fold", () => {
  let closed = 0;
  const tui = {
    terminal: { rows: 24, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const view = new TextOverlay({
    tui,
    theme: plainTheme,
    heading: "Thinking",
    body: "short",
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 },
    onClose: () => closed++,
  });
  view.render(60);
  sendInput(view, "\r");
  assert.equal(closed, 1);
});

initTheme("dark");

test("the popup renders the run as markdown, not as its source", () => {
  const view = textOverlay(
    "## Plan\n\n- read the **config**\n- then decide\n\n`inline code`",
  );
  const rendered = view.render(60).map(strip);
  const body = rendered.join("\n");

  assert.ok(!body.includes("## Plan"), "no raw heading marker");
  assert.ok(body.includes("Plan"), "the heading text survives");
  assert.ok(!body.includes("**config**"), "no raw emphasis markers");
  assert.ok(body.includes("config"));
  assert.ok(!body.includes("`inline code`"), "no raw backticks");
  assert.ok(body.includes("inline code"));
  // List items keep a marker of some kind, just not the source one.
  assert.match(body, /[-•·] read the config|read the config/);
});

test("prose still renders when markdown cannot be styled", () => {
  // The renderer is optional: a plain body must survive a theme-less runtime.
  const view = textOverlay("just a sentence");
  assert.ok(
    view.render(60).map(strip).some((line) => line.includes("just a sentence")),
  );
});

test("clicking the screen around the panel dismisses it, clicking it does not", () => {
  let closed = 0;
  const tui = {
    terminal: { rows: 24, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const view = new TextOverlay({
    tui,
    theme: plainTheme,
    heading: "Thinking",
    body: "one line",
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "center", marginX: 0 },
    onClose: () => closed++,
  });
  const height = view.render(60).length; // 7 rows, centred in 24
  const top = Math.floor((24 - height) / 2);
  const left = Math.floor((100 - 60) / 2);
  const press = (row: number, col: number) => `\x1b[<0;${col + 1};${row + 1}M`;

  sendInput(view, press(top + 1, left + 2)); // on the panel
  assert.equal(closed, 0);

  sendInput(view, press(top - 1, left + 2)); // above it
  assert.equal(closed, 1);

  sendInput(view, press(top + 1, left - 1)); // beside it
  assert.equal(closed, 1, "close is idempotent after the view has retired");

  sendInput(view, press(top + height, left + 2)); // below it
  assert.equal(closed, 1);
});

test("a scrollbar rides the open panel's right edge once there is more text", () => {
  const short = textOverlay("one line").render(60).map(strip);
  assert.ok(!short.some((line) => line.includes("█")), "nothing to scroll");

  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const view = textOverlay(long);
  const top = view.render(60).map(strip);
  const thumbRows = (lines: string[]) =>
    lines.flatMap((line, index) => (line.includes("█") ? [index] : []));

  const atTop = thumbRows(top);
  assert.ok(atTop.length > 0, "a thumb is drawn");
  assert.equal(atTop[0], 2, "which starts at the first body row");
  assert.ok(top.every((line) => !line.includes("│")), "the empty track does not recreate a right border");
  // The bar keeps the panel's width: it occupies the reserved last column.
  for (const line of top) assert.equal(visibleWidth(line), visibleWidth(top[0]!));

  sendInput(view, "G");
  const atEnd = thumbRows(view.render(60).map(strip));
  assert.ok(atEnd[0]! > atTop[0]!, "and moves down as the body does");
  // The blank separator and footer rule follow the body.
  assert.equal(atEnd.at(-1), view.render(60).length - 3, "reaching the last body row");
});

test("vi motions move the body the same way the arrows do", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const view = textOverlay(long);
  const firstLine = () =>
    view.render(60).map(strip).find((line) => /line \d+/.test(line))!
      .match(/line (\d+)/)![1];

  assert.equal(firstLine(), "0");
  sendInput(view, "j");
  assert.equal(firstLine(), "1");
  sendInput(view, "k");
  assert.equal(firstLine(), "0");

  sendInput(view, "\x04"); // ctrl+d, half page
  const afterHalf = Number(firstLine());
  assert.ok(afterHalf > 0);
  sendInput(view, "\x06"); // ctrl+f, full page
  assert.ok(Number(firstLine()) > afterHalf);
  sendInput(view, "\x02"); // ctrl+b
  assert.equal(Number(firstLine()), afterHalf);
  sendInput(view, "\x15"); // ctrl+u
  assert.equal(firstLine(), "0");

  sendInput(view, "G");
  assert.ok(Number(firstLine()) > 100, "G goes to the end");
  sendInput(view, "g");
  assert.equal(firstLine(), "0", "g comes back to the top");
});

test("the title rule uses the theme accent instead of a border tone", () => {
  const used: string[] = [];
  const spyTheme = {
    fg: (color: string, text: string) => {
      used.push(color);
      return text;
    },
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  } as unknown as Theme;
  const tui = {
    terminal: { rows: 24, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;

  new TextOverlay({
    tui,
    theme: spyTheme,
    heading: "Thinking",
    body: "one line",
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "center", marginX: 0 },
    onClose: () => {},
  }).render(60);

  assert.ok(used.includes("accent"));
  assert.ok(!used.includes("border"));
});

test("y copies the run's source and says so in the footer", () => {
  const body = "## Plan\n\n- read the **config**";
  const view = textOverlay(body);
  view.render(60);
  sendInput(view, "y");

  const footer = view.render(60).map(strip)
    .find((line) => line.includes("Copied"))!;
  assert.match(footer, /Copied 30 chars to clipboard/, footer);
  assert.ok(!footer.includes("y copy"), "the hint gives way to the outcome");

  // Any other key puts the hint back, so the notice cannot go stale.
  sendInput(view, "j");
  assert.match(
    view.render(60).map(strip).find((line) => line.includes("Esc close"))!,
    /y copy/,
  );
});

test("copying is offered but declined when there is nothing to take", () => {
  const view = textOverlay("");
  view.render(60);
  sendInput(view, "c");
  assert.match(
    view.render(60).map(strip).find((line) => line.includes("Esc close"))!,
    /Nothing to copy/,
  );
});

test("an accidental heading in reasoning is not underlined or recoloured", () => {
  // A paragraph followed by `---` is a setext heading to any Markdown parser,
  // and pi draws a level-1 heading bright, bold and underlined — so reasoning
  // that merely quoted a divider came out shouting.
  const used: string[] = [];
  const spyTheme = {
    fg: (color: string, text: string) => {
      used.push(color);
      return text;
    },
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => {
      used.push("underline");
      return text;
    },
  } as unknown as Theme;
  const tui = {
    terminal: { rows: 24, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;

  const rendered = new TextOverlay({
    tui,
    theme: spyTheme,
    heading: "Thinking",
    body: "Pane-local hook state wins.\n---\n\nand the rest of the thought",
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "center", marginX: 0 },
    onClose: () => {},
  }).render(60).map(strip);

  assert.ok(rendered.some((line) => line.includes("Pane-local hook state wins")));
  assert.ok(!used.includes("underline"), "nothing is underlined");
  // The default body uses Pi's normal conversation text; Markdown parsing does not
  // introduce a brighter document-heading colour.
  assert.ok(used.includes("text"), used.join(","));
});

/** A drag: press, a move, then release — the reports a terminal actually sends. */
function drag(
  view: TextOverlay,
  from: { row: number; col: number },
  to: { row: number; col: number },
): void {
  sendInput(view, `\x1b[<0;${from.col + 1};${from.row + 1}M`);
  sendInput(view, `\x1b[<32;${to.col + 1};${to.row + 1}M`);
  sendInput(view, `\x1b[<0;${to.col + 1};${to.row + 1}m`);
}

test("dragging across the body selects it and copies on release", () => {
  const view = textOverlay("alpha bravo charlie\nsecond line here");
  const rendered = view.render(60).map(strip);
  const first = rendered.findIndex((line) => line.includes("alpha"));
  // textOverlay() anchors to the top, so screen row 0 is the card's first line;
  // it is still centred horizontally.
  const left = Math.floor((100 - 60) / 2);
  const top = 0;

  // Body column 0 is two columns in, after the open frame's inset.
  drag(
    view,
    { row: top + first, col: left + 2 },
    { row: top + first, col: left + 2 + 5 },
  );

  const after = view.render(60).map(strip);
  const footer = after.find((line) => line.includes("Copied"))!;
  assert.match(footer, /Copied 5 chars to clipboard/, footer);

  // The selection stays up after the copy, drawn reversed.
  const raw = view.render(60)[first]!;
  assert.ok(raw.includes("\x1b[7m"), "selection is highlighted");
  assert.ok(raw.includes("\x1b[27m"), "and the highlight ends");
});

test("a selection spans rows and survives scrolling under it", () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const view = textOverlay(long);
  view.render(60);
  const left = Math.floor((100 - 60) / 2);
  const top = 2; // first body row of a top-anchored open panel

  sendInput(view, `\x1b[<0;${left + 3};${top + 1}M`); // press on row 0
  sendInput(view, `\x1b[<32;${left + 8};${top + 3}M`); // drag two rows down
  const highlighted = view.render(60).filter((line) => line.includes("\x1b[7m"));
  assert.equal(highlighted.length, 3, "three rows are covered");

  // Scrolling keeps the selection anchored to the text, not to the screen.
  sendInput(view, `\x1b[<65;10;5M`); // wheel down
  const scrolled = view.render(60).filter((line) => line.includes("\x1b[7m"));
  assert.ok(scrolled.length < 3, "part of it has scrolled off");
});

test("a click that selects nothing is still a click, not a copy", () => {
  const view = textOverlay("alpha bravo");
  const rendered = view.render(60).map(strip);
  const left = Math.floor((100 - 60) / 2);
  const row = rendered.findIndex((line) => line.includes("alpha"));

  drag(view, { row, col: left + 4 }, { row, col: left + 4 });
  const footer = view.render(60).map(strip).find((line) => line.includes("Esc close"))!;
  assert.match(footer, /y copy/, "no copy happened");
  assert.ok(!view.render(60).some((line) => line.includes("\x1b[7m")));
});

test("the popup draws a component's lines when one is supplied", () => {
  const tui = {
    terminal: { rows: 24, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const widths: number[] = [];
  const view = new TextOverlay({
    tui,
    theme: plainTheme,
    heading: "Process · output",
    body: "the raw text, still there to copy",
    format: "plain",
    renderBody: (width) => {
      widths.push(width);
      return ["drawn by the tool", "second row"];
    },
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 },
    onClose: () => {},
  });

  const rendered = view.render(60).map(strip);
  assert.ok(widths[0]! > 0 && widths[0]! < 60, "rendered at the card's inner width");
  assert.ok(
    rendered.some((line) => line.includes("drawn by the tool")),
    "the component's own lines are what the card shows",
  );
  assert.ok(
    !rendered.some((line) => line.includes("the raw text")),
    "the text it stands in for is not drawn as well",
  );
});

test("a component that cannot draw leaves the text in its place", () => {
  const tui = {
    terminal: { rows: 24, columns: 100, write: () => {} },
    requestRender: () => {},
  } as unknown as TUI;
  const view = new TextOverlay({
    tui,
    theme: plainTheme,
    heading: "Process · output",
    body: "fallback text",
    format: "plain",
    renderBody: () => {
      throw new Error("the tool moved on");
    },
    overlay: DEFAULT_OVERLAY,
    placement: { anchor: "top", marginX: 0 },
    onClose: () => {},
  });

  assert.ok(view.render(60).map(strip).some((line) => line.includes("fallback text")));
});
