import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register from "../index.ts";

test("usage paints loading before refresh and mounts the information shell", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "capacity-panel-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const handlers = new Map<string, Function>();
  let usage: any;
  register({
    events: { on: () => () => {}, emit() {} },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerCommand(name: string, command: unknown) { if (name === "usage") usage = command; },
  } as never);
  let component: any;
  let initial = "";
  let close: (() => void) | undefined;
  let options: any;
  let authCalls = 0;
  const tones: string[] = [];
  const theme = { fg(tone: string, text: string) { tones.push(tone); return text; }, bold: (text: string) => text };
  const ctx = {
    mode: "tui", hasUI: true,
    sessionManager: { getSessionId: () => "panel-session" },
    modelRegistry: { getProviderAuthStatus: () => { authCalls++; return { configured: false }; }, getAvailable: () => [] },
    ui: {
      theme,
      notify() { assert.fail("usage belongs in a panel"); },
      custom(factory: Function, customOptions: unknown) {
        options = customOptions;
        return new Promise<void>((resolve) => {
          close = resolve;
          component = factory({ mode: "fullscreen", terminal: { rows: 40, columns: 80 }, children: [], requestRender() {} }, theme, {}, resolve);
          initial = component.render(80).join("\n");
          assert.equal(authCalls, 0, "no auth/network work before the first loading frame");
        });
      },
    },
  };
  const pending = usage.handler("", ctx);
  assert.match(initial, /Model capacity > Usage/);
  assert.match(initial, /Refreshing model capacity/);
  assert.equal(options.overlay, true);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /openai-codex: unavailable/);
  assert.match(rendered, /xai: unavailable/);
  assert.ok(tones.includes("accent") && tones.includes("muted"));
  component.handleInput("\x1b");
  await pending;
  component.dispose?.();
  close?.();
  handlers.get("session_shutdown")?.();
});
