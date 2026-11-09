import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { onLeftClick } from "../src/clickable.ts";
import { FoldedResultComponent } from "../src/native-output.ts";
import { LoadedSkillPresentationComponent, CtxStatusPresentationComponent, SubagentCompletionPresentationComponent, ProcessEventPresentationComponent } from "../src/custom-entry-presentations.ts";
import { TodoSnapshot, TodoWidget } from "../src/todo-state.ts";
import { DEFAULT_USER_MESSAGES } from "../src/config.ts";
import { installCompactUserMessages } from "../src/user-message.ts";
import { applyStatusLineUi } from "../src/statusline/ui.ts";

const event = (type: TuiMouseEvent["type"] = "click", button: TuiMouseEvent["button"] = "left"): TuiMouseEvent => ({
  type, button, x: 5, y: 0, screenX: 35, screenY: 12, width: 70, height: 3,
  shift: false, ctrl: false, alt: false, wheelDelta: type === "wheel" ? 1 : undefined,
});

test("content action leaves gesture classification, capture and wheel to Pi", () => {
  const seen: number[][] = [];
  const activate = (row: number, col: number) => { seen.push([row, col]); return true; };
  for (const type of ["press", "drag", "release", "move", "wheel"] as const) {
    assert.equal(onLeftClick(event(type), activate), undefined);
  }
  assert.equal(onLeftClick(event("click", "right"), activate), undefined);
  assert.deepEqual(seen, []);
  assert.deepEqual(onLeftClick(event(), activate), { handled: true });
  assert.deepEqual(seen, [[0, 5]]);
  assert.equal(onLeftClick(event(), () => false), undefined);
  assert.equal(onLeftClick(event(), () => { throw new Error("retired context"); }), undefined);
});

test("standalone rows run one action for a completed left click and ignore other gestures", () => {
  let opens = 0;
  const open = () => { opens++; return true; };
  const theme = { fg: (_: string, s: string) => s } as never;
  const todos = new TodoSnapshot();
  todos.replace([{ id: 1, subject: "mouse action", status: "pending" }]);
  const rows: Component[] = [
    new LoadedSkillPresentationComponent({ skills: [{ name: "mouse", contents: "skill body" }], theme } as never, open),
    new CtxStatusPresentationComponent({ presentation: { heading: "ctx", body: "body" } } as never, open),
    new SubagentCompletionPresentationComponent({ completion: { taskPath: "task", outcome: "completed", summary: "ok", result: "body" } } as never, open),
    new ProcessEventPresentationComponent({ data: { text: "finished", process: { name: "worker" } } } as never, open),
    new FoldedResultComponent(new Text("body"), { maxLines: 2, heading: "Process", body: "body", getTheme: () => undefined, openText: open }),
    new TodoWidget(todos, open),
  ];
  for (const row of rows) {
    const before = opens;
    for (const type of ["press", "drag", "release", "wheel"] as const) assert.equal(row.handleMouse?.(event(type)), undefined);
    assert.equal(opens, before);
    assert.equal(row.handleMouse?.(event())?.handled, true);
    assert.equal(opens, before + 1);
  }
});

test("folded user message handles native click once and restores its original mouse method", () => {
  initTheme("dark");
  let opens = 0;
  const before = UserMessageComponent.prototype.handleMouse;
  const hadOwn = Object.hasOwn(UserMessageComponent.prototype, "handleMouse");
  const dispose = installCompactUserMessages({ on() {} } as never, { ...DEFAULT_USER_MESSAGES, maxLines: 1 }, () => { opens++; return true; });
  try {
    const user = new UserMessageComponent("first\nsecond\nthird\nfourth");
    const parent = new Container(); parent.addChild(user); parent.render(70);
    for (const type of ["press", "drag", "release", "wheel"] as const) assert.equal(parent.handleMouse(event(type)), undefined);
    assert.equal(opens, 0);
    assert.equal(parent.handleMouse(event())?.handled, true);
    assert.equal(opens, 1);
    const short = new UserMessageComponent("fits"); short.render(70);
    assert.equal(short.handleMouse(event()), undefined);
  } finally { dispose(); }
  assert.equal(UserMessageComponent.prototype.handleMouse, before);
  assert.equal(Object.hasOwn(UserMessageComponent.prototype, "handleMouse"), hadOwn);
});

test("footer and widget native clicks preserve contributed-row and padded-column routing", () => {
  for (const placement of ["footer", "widget"] as const) {
    let component: Component | undefined;
    const seen: number[][] = [];
    const ui = { setWidget(_key: string, factory: unknown) { if (typeof factory === "function") component = factory({ mode: "fullscreen" }); },
      setFooter(factory: unknown) { if (typeof factory === "function") component = factory({ mode: "fullscreen" }); } };
    applyStatusLineUi({ ui }, { placement, padding: 2 } as never, ["command", "todo"], {
      commandRowCount: 1, onClickInline: (row, col) => { seen.push([row, col]); return true; }, onClickRow: (row) => { seen.push([row]); return true; },
    });
    component!.render(70);
    assert.equal(component!.handleMouse?.(event("wheel")), undefined);
    assert.equal(component!.handleMouse?.(event())?.handled, true);
    assert.deepEqual(seen, [[0, 3]]);
    assert.equal(component!.handleMouse?.({ ...event(), y: 1 })?.handled, true);
    assert.deepEqual(seen, [[0, 3], [0]]);
  }
});
