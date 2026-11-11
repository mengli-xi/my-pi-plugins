import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionFactory, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import piFast from "../local/pi-fast/index.ts";
import { fastFixture } from "../local/pi-fast/test/fixture.ts";

for (const order of ["fast-first", "cc-first", "without-fast"] as const) {
  test(`real pi-fast and built CC statusline (${order})`, { timeout: 15000 }, async () => {
    initTheme("dark", false);
    const f = fastFixture();
    let runtime: Awaited<ReturnType<typeof f.start>> | undefined;
    let footer: Component | undefined;
    try {
      const { default: cc } = await import(new URL("../local/pi-claude-style/dist/index.ts", import.meta.url).href) as { default: ExtensionFactory };
      runtime = await f.start(order === "fast-first" ? [piFast, cc] : order === "cc-first" ? [cc, piFast] : [cc]);
      const ui: ExtensionUIContext = { ...runtime.session.extensionRunner!.getUIContext(),
        setFooter(factory) {
          footer = factory?.({ requestRender() {}, terminal: { rows: 40, columns: 160 } } as TUI, undefined as never, undefined as never);
        },
      };
      await runtime.session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => f.errors.push(error) });
      const render = () => footer?.render(160).join("\n") ?? "";
      assert.equal(f.requests.length, 0, "loading and UI binding never issue business requests");
      assert.doesNotMatch(render(), /\[\[pi:slot:/);
      if (order === "without-fast") {
        assert.doesNotMatch(render(), /⚡/);
        await runtime.session.prompt("CC still works without pi-fast.");
        assert.equal(f.requests.length, 1);
        assert.equal("service_tier" in f.requests[0], false);
      } else {
        assert.match(render(), /\x1b\[90m⚡/);
        await runtime.session.prompt("/fast on");
        assert.match(render(), /\x1b\[33m⚡/, "slot changes immediately without waiting for the shell command");
        assert.equal(f.requests.length, 0);
        await runtime.session.prompt("Enabled main request.");
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].service_tier, "priority");
        await runtime.session.prompt("/fast off");
        assert.match(render(), /\x1b\[90m⚡/);
        await runtime.session.prompt("Disabled main request.");
        assert.equal(f.requests.length, 2);
        assert.equal("service_tier" in f.requests[1], false);
      }
      assert.deepEqual(f.errors, []);
    } finally {
      await runtime?.dispose();
      f.cleanup();
    }
  });
}
