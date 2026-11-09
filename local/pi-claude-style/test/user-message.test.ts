import assert from "node:assert/strict";
import test from "node:test";
import { click as clickAt } from "./native-mouse.ts";
import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_USER_MESSAGES } from "../src/config.ts";
import { installCompactUserMessages } from "../src/user-message.ts";
import { installPresentationOwner, disposePresentationOwner, presentationPrototype } from "../src/presentation-owner.ts";
import type { UserMessagesConfig } from "../src/types.ts";

initTheme("dark");

const WIDTH = 60;

interface Handler {
  (event: unknown, ctx: unknown): void;
}

/** Enough of `pi` for the patch to install, plus a way to deliver session_start. */
function stubPi() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as never;
  const start = () =>
    handlers.get("session_start")?.({}, { hasUI: true, ui: { theme: undefined } });
  return { pi, start };
}

function withPatch(
  config: Partial<UserMessagesConfig>,
  run: (render: (text: string) => string[], click: (text: string) => boolean) => void,
): void {
  const opened: Array<{ heading: string; body: string }> = [];
  const openText = (heading: string, body: string) => {
    opened.push({ heading, body });
    return true;
  };
  const { pi, start } = stubPi();
  const restore = installCompactUserMessages(
    pi,
    { ...DEFAULT_USER_MESSAGES, ...config },
    openText,
  );
  start();
  try {
    const make = (text: string) => new UserMessageComponent(text, undefined, 1);
    run(
      (text) => make(text).render(WIDTH),
      (text) => {
        const component = make(text);
        component.render(WIDTH); // A click only means something after a draw.
        return clickAt(component);
      },
    );
    (run as unknown as { opened?: unknown }).opened = opened;
  } finally {
    restore();
  }
}

/** Body rows are everything between the box's top and bottom edges. */
function body(lines: string[]): string[] {
  return lines.slice(1, -1);
}

test("a message within the cap is drawn whole, with no hint and no click", () => {
  withPatch({ maxLines: 3 }, (render, click) => {
    const lines = render("one\ntwo");
    assert.equal(body(lines).length, 2);
    assert.ok(!lines.join("\n").includes("click to view"));
    assert.equal(click("one\ntwo"), false, "nothing is hidden, so the click is not ours");
  });
});

test("a longer message keeps its first lines and says how many it held back", () => {
  withPatch({ maxLines: 3 }, (render) => {
    const rows = body(render("one\ntwo\nthree\nfour\nfive\nsix"));
    assert.equal(rows.length, 4, "three lines of message plus the hint");
    assert.ok(rows[0]?.includes("one"));
    assert.ok(rows[2]?.includes("three"));
    assert.ok(!rows.join("\n").includes("four"), "the rest is not drawn");
    assert.ok(rows[3]?.includes("+3 lines · click to view"));
  });
});

test("a message folds only when it can hide at least three lines", () => {
  withPatch({ maxLines: 3 }, (render, click) => {
    const twoOver = "note\n\n```sh\necho one\n```";
    assert.equal(body(render(twoOver)).length, 5, "hiding two lines is not worth a hint");
    assert.equal(click(twoOver), false);
    const threeOver = "note\n\n```sh\necho one\necho two\n```";
    const rows = body(render(threeOver));
    assert.equal(rows.length, 4);
    assert.ok(rows[3]?.includes("+3 lines · click to view"));
    assert.equal(click(threeOver), true);
  });
});

test("the fold keeps the box rectangular", () => {
  withPatch({ maxLines: 3 }, (render) => {
    for (const line of render("one\ntwo\nthree\nfour\nfive\nsix")) {
      assert.equal(visibleWidth(line), WIDTH);
    }
  });
});

test("clicking a folded message opens the popup with the text that was typed", () => {
  const opened: Array<{ heading: string; body: string }> = [];
  const openText = (heading: string, text: string) => {
    opened.push({ heading, body: text });
    return true;
  };
  const { pi, start } = stubPi();
  const restore = installCompactUserMessages(
    pi,
    {
      ...DEFAULT_USER_MESSAGES,
      maxLines: 3,
      title: "user",
    },
    openText,
  );
  start();
  try {
    const source = "one\ntwo\nthree\nfour\nfive\nsix";
    const component = new UserMessageComponent(source, undefined, 1);
    component.render(WIDTH);
    assert.equal(clickAt(component), true, "a folded message takes the click");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.heading, "user");
    // The source, not the wrapped and framed lines the transcript drew.
    assert.equal(opened[0]?.body, source);
  } finally {
    restore();
  }
});

test("a folded clipboard-image message keeps its marker in the popup", () => {
  const opened: string[] = [];
  const { pi, start } = stubPi();
  const restore = installCompactUserMessages(
    pi,
    { ...DEFAULT_USER_MESSAGES, maxLines: 1 },
    (_heading, text) => {
      opened.push(text);
      return true;
    },
  );
  start();
  try {
    const path = "/tmp/pi-clipboard-123e4567-e89b-12d3-a456-426614174000.png";
    const component = new UserMessageComponent(`${path}\nmore\nthree\nfour`, undefined, 1);
    component.render(WIDTH);
    assert.equal(clickAt(component), true);
    assert.deepEqual(opened, ["[Image #1]\nmore\nthree\nfour"]);
  } finally {
    restore();
  }
});

test("maxLines 0 turns folding off", () => {
  withPatch({ maxLines: 0 }, (render, click) => {
    const rows = body(render("one\ntwo\nthree\nfour\nfive"));
    assert.equal(rows.length, 5);
    assert.ok(!rows.join("\n").includes("click to view"));
    assert.equal(click("one\ntwo\nthree\nfour\nfive"), false);
  });
});

test("uninstalling takes the click handler with it", () => {
  const { pi, start } = stubPi();
  const restore = installCompactUserMessages(pi, { ...DEFAULT_USER_MESSAGES, maxLines: 3 });
  start();
  assert.equal(Object.hasOwn(UserMessageComponent.prototype, "handleMouse"), true);
  restore();
  assert.equal(Object.hasOwn(UserMessageComponent.prototype, "handleMouse"), false);
});

test("an existing transform host keeps its renderer and applies transforms only once", () => {
  const registryKey = Symbol.for("ui-pack.user-message-render-transforms.v1");
  const scope = globalThis as Record<PropertyKey, unknown>;
  const previousRegistry = scope[registryKey];
  const prototype = UserMessageComponent.prototype;
  const original = prototype.render;
  const mouse = prototype.handleMouse;
  let transforms = 0;
  const transform = (lines: string[]) => { transforms++; return lines; };
  const hostOwner = Symbol("native fallback host");
  const registry = { version: 1, transforms: new Map([[Symbol(), transform]]), hostOwner };
  scope[registryKey] = registry;
  const fallback = prototype.render = function(width) { return transform(original.call(this, width)); };
  const { pi } = stubPi();
  const restore = installCompactUserMessages(pi, DEFAULT_USER_MESSAGES);
  try {
    assert.equal(prototype.render, fallback, "a failed lease must not install a second host");
    assert.equal(prototype.handleMouse, mouse);
    new UserMessageComponent("single transform", undefined, 1).render(WIDTH);
    assert.equal(transforms, 1);
    restore();
    assert.equal(prototype.render, fallback);
    assert.equal(registry.hostOwner, hostOwner);
  } finally {
    prototype.render = original;
    if (previousRegistry === undefined) delete scope[registryKey]; else scope[registryKey] = previousRegistry;
  }
});

test("late teardown cannot remove a replacement compact renderer or its host lease", () => {
  const { pi } = stubPi();
  const first = installCompactUserMessages(pi, DEFAULT_USER_MESSAGES);
  first();
  const second = installCompactUserMessages(pi, DEFAULT_USER_MESSAGES);
  const render = UserMessageComponent.prototype.render;
  const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("ui-pack.user-message-render-transforms.v1")] as { hostOwner?: symbol };
  const hostOwner = registry.hostOwner;
  try {
    first();
    assert.equal(UserMessageComponent.prototype.render, render);
    assert.equal(registry.hostOwner, hostOwner);
  } finally { second(); }
  assert.equal(registry.hostOwner, undefined);
});

test("Main retirement retains the child transform lease until child teardown", () => {
  const key = Symbol.for("ui-pack.user-message-render-transforms.v1");
  const scope = globalThis as Record<PropertyKey, unknown>;
  const previous = scope[key];
  let transforms = 0;
  const registry = { version: 1, transforms: new Map([[Symbol(), (lines: string[]) => { transforms++; return lines; }]]), hostOwner: undefined as symbol | undefined };
  scope[key] = registry;
  const main = stubPi().pi, child = stubPi().pi;
  installPresentationOwner(main);
  installPresentationOwner(child);
  const releaseMain = installCompactUserMessages(main, DEFAULT_USER_MESSAGES);
  const releaseChild = installCompactUserMessages(child, DEFAULT_USER_MESSAGES);
  const childPrototype = presentationPrototype(child, UserMessageComponent.prototype, "component");
  const renderChild = () => childPrototype.render.call(new UserMessageComponent("child", undefined, 1), WIDTH);
  try {
    renderChild();
    assert.equal(transforms, 1);
    releaseMain(); disposePresentationOwner(main);
    assert.equal(typeof registry.hostOwner, "symbol");
    renderChild();
    assert.equal(transforms, 2, "child still applies exactly one transform after Main retires");
    releaseMain();
    renderChild();
    assert.equal(transforms, 3, "late Main teardown must not disturb child");
    releaseChild(); disposePresentationOwner(child);
    assert.equal(registry.hostOwner, undefined);
  } finally {
    releaseMain(); releaseChild(); disposePresentationOwner(main); disposePresentationOwner(child);
    if (previous === undefined) delete scope[key]; else scope[key] = previous;
  }
});

test("the compact renderer hosts versioned external user-message transforms", () => {
  const registryKey = Symbol.for("ui-pack.user-message-render-transforms.v1");
  const transformId = Symbol("test.user-message-transform");
  const registry = {
    version: 1 as const,
    transforms: new Map([
      [transformId, (lines: string[]) => lines.map((line) => line.replace("hook target", "HOOK TARGET"))],
    ]),
    hostOwner: undefined as symbol | undefined,
  };
  (globalThis as Record<PropertyKey, unknown>)[registryKey] = registry;
  const { pi, start } = stubPi();
  const restore = installCompactUserMessages(pi, { ...DEFAULT_USER_MESSAGES, maxLines: 3 });
  start();
  try {
    const rendered = new UserMessageComponent("hook target", undefined, 1).render(WIDTH).join("\n");
    assert.match(rendered, /HOOK TARGET/);
    assert.equal(typeof registry.hostOwner, "symbol");
  } finally {
    restore();
    delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
  }
  assert.equal(registry.hostOwner, undefined, "the renderer releases only its host lease");
});
