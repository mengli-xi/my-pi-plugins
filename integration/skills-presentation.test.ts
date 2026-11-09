import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import skills from "../local/pi-skills/index.ts";
import { SKILL_BINDING_ENTRY_TYPE } from "../local/pi-skills/invocations.ts";
import { installCustomEntryPresentationProviders } from "../local/pi-claude-style/src/custom-entry-presentations.ts";
import { CONTENTS, RULE, skillsFixture, text } from "./fixtures/skills.ts";

// Print sessions do not initialize the global theme as InteractiveMode does.
test.before(() => initTheme("dark", false));

const KEY = Symbol.for("pi.claude-style.custom-entry-presentations.v1");
const registry = () => (globalThis as Record<symbol, unknown>)[KEY] as {
  providers: Map<string, { owner: symbol; render(input: unknown): Component | undefined }>;
} | undefined;
const click = (component: Component) => component.handleMouse?.({
  type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0,
  width: 100, height: 40, shift: false, alt: false, ctrl: false,
})?.handled === true;
const options = { expanded: false, keyHint: () => "", keyText: () => "" };
const renderedText = (component: Component) => stripVTControlCharacters(component.render(100).join("\n"));

for (const order of ["skills-first", "cc-first"] as const) {
  test(`real Skills and built CC preserve user semantics (${order})`, async () => {
    const f = skillsFixture();
    // Resolve the same built entry Pi loads, never a mocked presentation extension.
    const { default: cc } = await import(new URL("../local/pi-claude-style/dist/index.ts", import.meta.url).href) as { default: ExtensionFactory };
    const runtime = await f.start(order === "skills-first" ? [skills, cc] : [cc, skills]);
    try {
      const provider = registry()?.providers.get(SKILL_BINDING_ENTRY_TYPE);
      assert.ok(provider && typeof provider.owner === "symbol", "CC owns a real versioned presentation provider");
      await runtime.session.prompt("Use $deploy now.");
      assert.equal(f.requests.length, 1, "loading CC and Skills never adds a business request");
      const request = f.requests.at(-1)!.messages;
      const index = request.findIndex(message => message.role === "user" && text(message) === "Use $deploy now.");
      assert.ok(index >= 0);
      assert.equal(request[index + 1]?.role, "user");
      assert.ok(text(request[index + 1]).includes(RULE));
      const entry = runtime.session.sessionManager.getBranch().find(entry => entry.type === "custom" && entry.customType === SKILL_BINDING_ENTRY_TYPE);
      assert.ok(entry && entry.type === "custom");
      const runner = runtime.session.extensionRunner;
      const renderer = runner.getEntryRenderer(SKILL_BINDING_ENTRY_TYPE);
      assert.ok(renderer, "Skills retains the native entry renderer while CC only supplies presentation");
      const row = renderer(entry, options, runner.createContext().ui.theme);
      assert.ok(row);
      assert.match(renderedText(row), /Loaded skill deploy/);
      assert.equal(registry()?.providers.get(SKILL_BINDING_ENTRY_TYPE), provider);
      assert.deepEqual(f.errors, []);
    } finally {
      await runtime.dispose();
      f.cleanup();
    }
    assert.equal(registry()?.providers.has(SKILL_BINDING_ENTRY_TYPE), false, "retired CC releases only its presentation lease");
  });
}

test("real presentation factories adopt late CC, retire by owner, and never replace Skills render", async () => {
  const f = skillsFixture();
  const runtime = await f.start([skills]);
  const opened: Array<{ owner: string; body: string }> = [];
  let first: ReturnType<typeof installCustomEntryPresentationProviders> | undefined;
  let replacement: ReturnType<typeof installCustomEntryPresentationProviders> | undefined;
  try {
    await runtime.session.prompt("Use $deploy now.");
    const runner = runtime.session.extensionRunner;
    const entry = runtime.session.sessionManager.getBranch().find(entry => entry.type === "custom" && entry.customType === SKILL_BINDING_ENTRY_TYPE);
    assert.ok(entry && entry.type === "custom");
    const renderer = runner.getEntryRenderer(SKILL_BINDING_ENTRY_TYPE);
    assert.ok(renderer);
    const row = renderer(entry, options, runner.createContext().ui.theme);
    assert.ok(row);
    const render = row.render;
    assert.match(renderedText(row), /Loaded skill deploy/);
    assert.equal(click(row), false, "missing CC leaves a semantic fallback without an overlay");
    // Compose the production CC provider factory with the actual Skills SDK row.
    // The test opener records a click; it never touches a terminal or clipboard.
    first = installCustomEntryPresentationProviders((_heading, body) => { opened.push({ owner: "first", body }); return true; });
    const firstProvider = registry()!.providers.get(SKILL_BINDING_ENTRY_TYPE);
    assert.equal(click(row), true, "the existing fallback row discovers a late real CC provider");
    assert.deepEqual(opened, [{ owner: "first", body: CONTENTS }]);
    replacement = installCustomEntryPresentationProviders((_heading, body) => { opened.push({ owner: "replacement", body }); return true; });
    const replacementProvider = registry()!.providers.get(SKILL_BINDING_ENTRY_TYPE);
    assert.notEqual(replacementProvider?.owner, firstProvider?.owner);
    await first.dispose();
    assert.equal(registry()!.providers.get(SKILL_BINDING_ENTRY_TYPE), replacementProvider, "stale teardown cannot erase the newer owner");
    assert.equal(click(row), true);
    assert.deepEqual(opened.at(-1), { owner: "replacement", body: CONTENTS });
    assert.equal(row.render, render, "providers delegate; they never overwrite the consumer render method");
    await replacement.dispose();
    assert.equal(click(row), false);
    assert.match(renderedText(row), /Loaded skill deploy/);
    assert.equal(row.render, render);
    assert.equal(opened.length, 2, "retired providers cannot retain click delivery");
    assert.equal(f.requests.length, 1, "presentation and retirement never start provider requests");
    assert.deepEqual(f.errors, []);
  } finally {
    await replacement?.dispose();
    await first?.dispose();
    await runtime.dispose();
    f.cleanup();
  }
});
