import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { auditInternals, flushInternalsHealth, resetInternals, setHealthPath } from "../src/internals.ts";

for (const code of ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "EACCES"]) {
  test(`optional layout import ${code} does not misdiagnose the native frame`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cc-optional-layout-"));
    resetInternals();
    setHealthPath(join(root, "health.json"));
    t.after(async () => { await flushInternalsHealth(); resetInternals(); rmSync(root, { recursive: true, force: true }); });
    const url = new URL(`../src/host/fullscreen/bridge.ts?layout-error=${code}`, import.meta.url).href;
    const unavailable = `data:text/javascript,${encodeURIComponent(`
      export const createRequire = () => ({ resolve() {
        throw Object.assign(new Error("optional layout fixture"), { code: ${JSON.stringify(code)} });
      } });
    `)}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL === url && specifier === "node:module") return { url: unavailable, shortCircuit: true };
        return next(specifier, context);
      },
    });
    t.after(() => hook.deregister());
    const bridge = await import(url) as typeof import("../src/host/fullscreen/bridge.ts");
    const tui = new TuiAltScreen({ columns: 80, rows: 24 } as Terminal);
    const editor = { render: () => ["draft"], invalidate() {}, getText: () => "draft", setText() {}, handleInput() {} };
    tui.setLayoutRoot(editor);
    Object.assign(tui, { currentLayout: renderLayoutFrame(editor, 80, 24, () => {}) });
    const support = bridge.installFullscreenBridge();
    t.after(() => support.release());
    assert.ok(bridge.snapshotFullscreenEditorSlot(tui), "a real native frame supplies geometry without the private file");
    await new Promise(resolve => setImmediate(resolve));
    const geometry = auditInternals().find(row => row.id === "fullscreen.editorGeometry");
    assert.equal(geometry?.state, code === "EACCES" ? "broken" : "ok", JSON.stringify(geometry));
  });
}
