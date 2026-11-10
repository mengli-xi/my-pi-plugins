import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { installSearch, type SearchConfig } from "../extensions/index.ts";

const config: SearchConfig = { enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides: {} };
function fixture() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-search-command-"));
  let command: any;
  const tools = new Map<string, any>(), handlers = new Map<string, any>();
  let active = ["read"], customCalls = 0;
  const notices: string[] = [];
  const pi = {
    events: { emit() {} }, registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(_name: string, definition: any) { command = definition; },
    sendMessage(message: any, options: any) { assert.equal(options.triggerTurn, false); notices.push(message.content); },
    getActiveTools() { return active; }, setActiveTools(next: string[]) { active = next; },
    on(event: string, handler: any) { handlers.set(event, handler); },
  };
  const ctx: any = { mode: "rpc", hasUI: true, model: { provider: "fixture", id: "one" },
    modelRegistry: { getProviderAuthStatus() { return { configured: false }; } },
    ui: { notify(text: string) { notices.push(text); }, custom() { customCalls++; throw new Error("RPC must not use custom UI"); } },
  };
  installSearch(pi as never, { child: false, config, agentDir });
  return { agentDir, ctx, tools, handlers, notices, command: () => command, active: () => active, customCalls: () => customCalls,
    restore() { rmSync(agentDir, { recursive: true, force: true }); } };
}

test("/search parser and completions share canonical grammar; invalid/RPC entries never open custom UI", async () => {
  const f = fixture();
  try {
    const command = f.command();
    assert.deepEqual(command.getArgumentCompletions("").map((item: any) => item.value), ["on", "off", "providers", "config"]);
    assert.deepEqual(command.getArgumentCompletions("pro"), [{ value: "providers", label: "providers" }]);
    assert.equal(command.getArgumentCompletions("unknown"), null);
    assert.equal(command.getArgumentCompletions("on extra"), null);
    for (const args of ["unknown", "on extra"]) {
      await command.handler(args, f.ctx);
      assert.match(f.notices.at(-1)!, /Usage: \/search \[on\|off\|providers\|config\]/);
      assert.deepEqual(f.active(), ["read"]);
    }
    for (const args of ["", "providers", "config"]) await command.handler(args, f.ctx);
    f.ctx.mode = undefined; f.ctx.hasUI = false;
    await command.handler("", f.ctx); await command.handler("providers", f.ctx);
    assert.equal(f.customCalls(), 0);
    await command.handler("off", f.ctx);
    assert.equal(JSON.parse(readFileSync(join(f.agentDir, "search-config.json"), "utf8")).enabled, false);
    await command.handler(" ON ", f.ctx);
    assert.deepEqual(f.active(), ["read", "web_search", "web_fetch"]);
  } finally { f.restore(); }
});

test("failed config reload guards execution and /search on cannot overwrite a damaged source", async () => {
  const f = fixture();
  try {
    await f.command().handler("on", f.ctx);
    const active = [...f.active()];
    const path = join(f.agentDir, "search-config.json"); writeFileSync(path, "{broken");
    await assert.rejects(f.handlers.get("model_select")({}, f.ctx), /Cannot load search config/);
    assert.equal((await f.tools.get("web_search").execute("call", { query: "fixture" }, undefined, undefined, f.ctx)).details.error, "disabled");
    assert.equal((await f.tools.get("web_fetch").execute("call", { url: "https://fixture.invalid" }, undefined, undefined, f.ctx)).details.error, "disabled");
    const notices = f.notices.length;
    await assert.rejects(f.command().handler("on", f.ctx), /Cannot load search config/);
    for (const name of ["web_search", "web_fetch"]) {
      assert.equal((await f.tools.get(name).execute("call", { query: "fixture", url: "https://fixture.invalid" }, undefined, undefined, f.ctx)).details.error, "disabled", "failed /search on cannot reopen the in-memory guard");
    }
    assert.equal(f.notices.length, notices, "failed save must not report success");
    assert.equal(readFileSync(path, "utf8"), "{broken");
    assert.deepEqual(f.active(), active, "the guard remains closed even when active tools still include both names");
  } finally { f.restore(); }
});

test("/search on does not publish an enabled candidate when atomic save fails with IO", async () => {
  const f = fixture();
  try {
    await f.command().handler("off", f.ctx);
    const path = join(f.agentDir, "search-config.json"), before = readFileSync(path, "utf8");
    const cause = Object.assign(new Error("fixture EIO"), { code: "EIO" });
    const rename = test.mock.method(fs, "renameSync", () => { throw cause; });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.command().handler("on", f.ctx), error => (error as Error).cause === cause);
    } finally { rename.mock.restore(); syncBuiltinESMExports(); }
    for (const name of ["web_search", "web_fetch"]) {
      assert.equal((await f.tools.get(name).execute("call", { query: "fixture", url: "https://fixture.invalid" }, undefined, undefined, f.ctx)).details.error, "disabled");
    }
    assert.deepEqual(f.active(), ["read"]);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(f.notices, ["Search disabled"]);
  } finally { f.restore(); }
});

test("settings callbacks do not publish candidate switches when persistence fails", async () => {
  initTheme("dark");
  const f = fixture();
  try {
    await f.command().handler("on", f.ctx);
    const active = [...f.active()];
    const path = join(f.agentDir, "search-config.json"); writeFileSync(path, "{broken");
    await assert.rejects(f.handlers.get("model_select")({}, f.ctx), /Cannot load search config/);
    f.ctx.mode = "tui"; f.ctx.hasUI = true;
    let panel: any;
    f.ctx.ui.custom = async (build: any) => {
      panel = build({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => {});
    };
    await f.command().handler("", f.ctx);
    for (const setting of ["enabled", "search", "fetch"]) {
      assert.throws(() => panel.handleInput(" "), /Cannot load search config/);
      for (const name of ["web_search", "web_fetch"]) {
        assert.equal((await f.tools.get(name).execute("call", { query: "fixture", url: "https://fixture.invalid" }, undefined, undefined, f.ctx)).details.error, "disabled", `failed ${setting} callback must leave the in-memory guard closed`);
      }
      panel.handleInput("\u001b[B");
    }
    assert.deepEqual(f.active(), active);
    assert.equal(readFileSync(path, "utf8"), "{broken");
  } finally { f.restore(); }
});
