import assert from "node:assert/strict";
import test from "node:test";
import {
  UserMessageComponent,
  initTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type EditorComponent,
} from "@earendil-works/pi-tui";
import {
  decorateSkillMentions,
  SkillPresentation,
  USER_MESSAGE_TRANSFORMS_KEY,
} from "../presentation.ts";
import type { SkillRef } from "../skills.ts";

initTheme("dark");

const ansiTheme = {
  fg: (token: "accent" | "text", text: string) => `\x1b[${token === "accent" ? 33 : 37}m${text}\x1b[39m`,
  bg: (_token: "selectedBg", text: string) => `\x1b[44m${text}\x1b[49m`,
};

const deploy: SkillRef = {
  name: "deploy",
  path: "/skills/deploy/SKILL.md",
  scope: "project",
};

test("known bare mentions render as equal-width selected-background chips", () => {
  const raw = "Use $deploy now";
  const decorated = decorateSkillMentions(raw, new Set(["deploy"]), ansiTheme);
  assert.equal(stripTerminalSequences(decorated), "Use ✦deploy now");
  assert.equal(visibleWidth(decorated), visibleWidth(raw));
  assert.match(decorated, /\x1b\[44m/);
  assert.equal(
    decorateSkillMentions(decorated, new Set(["deploy"]), ansiTheme),
    decorated,
    "the visual replacement is idempotent",
  );
});

test("a leading native skill command renders as an equal-width command chip", () => {
  const raw = "/skill:deploy production";
  const decorated = decorateSkillMentions(raw, new Set(["deploy"]), ansiTheme);
  assert.equal(stripTerminalSequences(decorated), "✦skill:deploy production");
  assert.equal(visibleWidth(decorated), visibleWidth(raw));
  assert.match(decorated, /\x1b\[44m/);
});

test("unknown, bracketed, and definite shell-variable syntax stays plain", () => {
  const raw = "$unknown $[deploy] $PATH /skill:deploy";
  assert.equal(
    decorateSkillMentions(raw, new Set(["deploy", "PATH"]), ansiTheme),
    raw,
  );
});

test("ANSI and OSC controls survive the width-preserving replacement", () => {
  const raw = "\x1b]133;A\x07Use \x1b[37m$deploy\x1b[0m\x1b]133;C\x07";
  const decorated = decorateSkillMentions(raw, new Set(["deploy"]), ansiTheme);
  assert.ok(decorated.includes("\x1b]133;A\x07"));
  assert.ok(decorated.includes("\x1b]133;C\x07"));
  assert.equal(stripTerminalSequences(decorated), "Use ✦deploy");
  assert.equal(visibleWidth(decorated), visibleWidth(raw));
});

test("presentation preserves the original editor identity and autocomplete fields", () => {
  const inner = {
    autocompleteState: { open: true },
    autocompleteList: { render: () => ["menu"] },
    children: [{ render: () => ["child"], invalidate() {} }],
    render: () => ["Use $deploy"],
    invalidate() {},
    handleInput() {},
    getText: () => "Use $deploy",
    setText() {},
  } as unknown as EditorComponent & {
    autocompleteState: unknown;
    autocompleteList: unknown;
    children: unknown[];
  };
  let factory = (() => inner) as NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
  const context = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: ansiTheme,
      getEditorComponent: () => factory,
      setEditorComponent: (next: typeof factory) => { factory = next; },
    },
  } as unknown as ExtensionContext;
  const presentation = new SkillPresentation();
  presentation.activate(context, [deploy]);
  try {
    const built = factory(undefined as never, undefined as never, undefined as never) as typeof inner;
    assert.equal(built, inner, "the decorator must return the editor it was given");
    assert.deepEqual(built.autocompleteState, { open: true });
    assert.ok(built.autocompleteList);
    assert.equal(built.children.length, 1);
    assert.equal(stripTerminalSequences(built.render(80)[0]!), "Use ✦deploy");

    const transcript = new UserMessageComponent("Use $deploy", undefined, 1).render(80).join("\n");
    assert.match(stripTerminalSequences(transcript), /Use ✦deploy/);
  } finally {
    presentation.deactivate();
  }
});

test("a missing, read-only, or accessor render seam leaves the native prototype alone", () => {
  const prototype = UserMessageComponent.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "render")!;
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  const previous = scope[USER_MESSAGE_TRANSFORMS_KEY];
  let getterCalls = 0;
  const variants: PropertyDescriptor[] = [
    { ...original, writable: false },
    { configurable: true, writable: true, value: undefined },
    { configurable: true, get() { getterCalls++; return original.value; } },
  ];
  try {
    for (const descriptor of variants) {
      const registry = { version: 1, transforms: new Map() };
      scope[USER_MESSAGE_TRANSFORMS_KEY] = registry;
      Object.defineProperty(prototype, "render", descriptor);
      const installed = Object.getOwnPropertyDescriptor(prototype, "render");
      const presentation = new SkillPresentation();
      try {
        assert.doesNotThrow(() => presentation.activate({
          mode: "tui", hasUI: true,
          ui: { theme: ansiTheme, getEditorComponent: () => undefined, setEditorComponent() {} },
        } as unknown as ExtensionContext, [deploy]));
        assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "render"), installed);
        assert.equal("hostOwner" in registry, false);
      } finally {
        presentation.deactivate();
        Object.defineProperty(prototype, "render", original);
      }
    }
    assert.equal(getterCalls, 0, "checking a foreign accessor must not execute it");
  } finally {
    Object.defineProperty(prototype, "render", original);
    if (previous === undefined) delete scope[USER_MESSAGE_TRANSFORMS_KEY];
    else scope[USER_MESSAGE_TRANSFORMS_KEY] = previous;
  }
});

test("an existing compact-message host keeps prototype ownership while receiving the skill transform", () => {
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  const previous = scope[USER_MESSAGE_TRANSFORMS_KEY];
  const hostOwner = Symbol("compact-message-host");
  const registry = { version: 1, hostOwner, transforms: new Map<symbol, (lines: string[]) => string[]>() };
  scope[USER_MESSAGE_TRANSFORMS_KEY] = registry;
  const original = UserMessageComponent.prototype.render;
  const presentation = new SkillPresentation();
  try {
    presentation.activate({
      mode: "tui", hasUI: true,
      ui: { theme: ansiTheme, getEditorComponent: () => undefined, setEditorComponent() {} },
    } as unknown as ExtensionContext, [deploy]);
    assert.equal(UserMessageComponent.prototype.render, original);
    assert.equal(registry.hostOwner, hostOwner);
    assert.equal(registry.transforms.size, 1);
    const transform = [...registry.transforms.values()][0]!;
    assert.equal(stripTerminalSequences(transform(["Use $deploy"])[0]!), "Use ✦deploy");
    presentation.deactivate();
    assert.equal(registry.transforms.size, 0);
    assert.equal(registry.hostOwner, hostOwner);
    assert.equal(UserMessageComponent.prototype.render, original);
  } finally {
    presentation.deactivate();
    if (previous === undefined) delete scope[USER_MESSAGE_TRANSFORMS_KEY];
    else scope[USER_MESSAGE_TRANSFORMS_KEY] = previous;
  }
});
