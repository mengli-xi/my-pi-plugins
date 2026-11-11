import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireThemeWatchContract } from "../src/theme-watch-contract.ts";

const capability = "pi.theme-watch.file-version.v1";
const execute = promisify(execFile);
const cases = [
  { label: "null contracts", main: null, sdk: null },
  { label: "unknown Main without SDK", main: "unknown", sdk: undefined },
  { label: "unknown SDK without Main", main: undefined, sdk: "unknown" },
  { label: "missing Main", main: undefined, sdk: capability },
  { label: "missing SDK", main: capability, sdk: undefined },
  { label: "unknown Main", main: "pi.theme-watch.file-version.v2", sdk: capability },
  { label: "unknown SDK", main: capability, sdk: "pi.theme-watch.file-version.v2" },
  { label: "mismatched contracts", main: "pi.theme-watch.file-version.v2", sdk: "pi.theme-watch.file-version.v3" },
  { label: "matching but unknown contracts", main: "unknown", sdk: "unknown" },
];

for (const { label, main, sdk } of cases) test(`theme-watch contract rejects ${label}`, () => {
  assert.throws(() => requireThemeWatchContract({ themeWatchCapability: main }, { THEME_WATCH_CAPABILITY: sdk }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Main UI: .*canonical SDK:/u);
    assert.match(error.message, /host-patches\/pi\/v1\.5\.0/u);
    assert.match(error.message, /restart Pi; patching only the CLI is not sufficient/u);
    return true;
  });
});

test("theme-watch contract accepts the exact public capability on both surfaces", () => {
  assert.equal(requireThemeWatchContract({ themeWatchCapability: capability }, { THEME_WATCH_CAPABILITY: capability }), "patched");
});

for (const surface of ["Main UI", "canonical SDK"]) test(`theme-watch contract preserves ${surface} getter failure context and cause`, () => {
  const cause = new Error("capability getter failed");
  const main = surface === "Main UI" ? { get themeWatchCapability() { throw cause; } } : { themeWatchCapability: capability };
  const sdk = surface === "canonical SDK" ? { get THEME_WATCH_CAPABILITY() { throw cause; } } : { THEME_WATCH_CAPABILITY: capability };
  assert.throws(() => requireThemeWatchContract(main, sdk), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`Cannot read ${surface}`));
    assert.equal(error.cause, cause);
    return true;
  });
});

// Build a complete valid realm, changing only the marker under test.
function markerRealm(marker: unknown): string {
  return `
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const aiView = require(fileURLToPath(new URL("./core/extensions/pi-ai-extension-view.js", import.meta.resolve("@earendil-works/pi-coding-agent"))));
const current = Object.fromEntries(["pi-coding-agent", "pi-agent-core", "pi-tui", "pi-ai", "pi-ai/compat", "pi-ai/models", "pi-ai/oauth", "pi-ai/providers/all"].map(name => ["@earendil-works/" + name,
  name === "pi-coding-agent" ? Object.freeze({ ...codingAgent, THEME_WATCH_CAPABILITY: ${JSON.stringify(marker) ?? "undefined"} }) : name === "pi-ai" || name === "pi-ai/compat" ? aiView : require(fileURLToPath(import.meta.resolve("@earendil-works/" + name)))]));
const publicModules = Object.freeze({ ...current,
  ...Object.fromEntries(Object.entries(current).map(([name, module]) => [name.replace("@earendil-works/", "@mariozechner/"), module])),
  ...Object.fromEntries(["typebox", "typebox/compile", "typebox/value"].flatMap(name => [[name, require(fileURLToPath(import.meta.resolve(name)))], [name.replace("typebox", "@sinclair/typebox"), require(fileURLToPath(import.meta.resolve(name)))]])),
});
Object.defineProperty(globalThis, Symbol.for("pi.session-runtime.session-assembly-realm.v1"), {
  value: Object.freeze({ version: 1, sdkVersion: codingAgent.VERSION, publicModules }),
});
`;
}

test("managed handoff rejects incompatible markers before drain/stop and releases its lease", async () => {
  // This focused guard test deliberately supplies marker fixtures over the real public
  // SDK functions. It does not claim that a stock SDK implements the theme-watch patch.
  for (const { main, sdk } of cases) {
    await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
import * as codingAgent from "@earendil-works/pi-coding-agent";
${markerRealm(sdk)}
const { TerminalOwner } = await import(${JSON.stringify(new URL("../src/terminal-owner.ts", import.meta.url).href)});
let drains = 0, stops = 0;
const terminal = { write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => { drains++; } };
const ui = { themeWatchCapability: ${JSON.stringify(main) ?? "undefined"}, theme: { name: "named" },
  getTheme: () => ({}), onTerminalInput: () => () => {}, getAllThemes: () => [], setTheme: () => ({ success: true }) };
const owner = new TerminalOwner({ terminal, stop() { stops++; }, start() {}, requestRender() {} }, ui, () => "named");
try {
  await assert.rejects(owner.acquire(), /Child terminal handoff requires theme-watch capability/);
  assert.equal(drains, 0); assert.equal(stops, 0); assert.equal(owner.isMainForeground, true);
  const shared = globalThis[Symbol.for("pi.session-runtime.terminal-owner.v1")];
  assert.equal(shared.owner, undefined); assert.equal(shared.hasManagedView, undefined);
} finally { owner.dispose(); }
`]);
  }
});

test("managed handoff accepts exact marker fixtures and retains named-theme rejection", async () => {
  await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
import * as codingAgent from "@earendil-works/pi-coding-agent";
${markerRealm(capability)}
const { TerminalOwner } = await import(${JSON.stringify(new URL("../src/terminal-owner.ts", import.meta.url).href)});
let drains = 0, stops = 0, restores = 0, setting = "light/dark";
const terminal = { write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => { drains++; } };
const ui = { themeWatchCapability: ${JSON.stringify(capability)}, theme: { name: "named" },
  getTheme: () => ({}), onTerminalInput: () => () => {}, getAllThemes: () => [], setTheme: () => { restores++; return { success: true }; }, notify: () => { throw new Error("patched must not warn"); } };
const owner = new TerminalOwner({ terminal, stop() { stops++; }, start() {}, requestRender() {} }, ui, () => setting);
try {
  await assert.rejects(owner.acquire(), /single named Main theme/);
  assert.equal(drains, 0); assert.equal(stops, 0); assert.equal(owner.isMainForeground, true);
  setting = "named";
  await owner.acquire();
  assert.equal(drains, 1); assert.equal(stops, 1); assert.equal(owner.isMainForeground, false);
  owner.restore(); assert.equal(owner.isMainForeground, true); assert.equal(restores, 1);
} finally { owner.dispose(); }
`]);
});

test("theme-watch contract accepts only both absent as stock", () => {
  assert.equal(requireThemeWatchContract({}, {}), "stock");
});

test("stock handoff warns once across Main bindings and skips same-theme restore", async () => {
  await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
import * as codingAgent from "@earendil-works/pi-coding-agent";
${markerRealm(undefined)}
const { TerminalOwner } = await import(${JSON.stringify(new URL("../src/terminal-owner.ts", import.meta.url).href)});
let notices = [], drains = 0, stops = 0, starts = 0, themes = [];
const terminal = { write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => { drains++; } };
const ui = { theme: { name: "named" }, getTheme: () => ({}), onTerminalInput: () => () => {},
  getAllThemes: () => { throw new Error("stock must not install repaint bridge"); },
  notify: (...args) => notices.push(args), setTheme: name => { themes.push(name); ui.theme.name = name; return { success: true }; } };
for (let binding = 0; binding < 2; binding++) {
  const owner = new TerminalOwner({ terminal, stop() { stops++; }, start() { starts++; }, requestRender() {} }, ui, () => "named");
  try {
    for (let entry = 0; entry < 2; entry++) {
      await owner.acquire(); assert.equal(owner.isMainForeground, false);
      owner.restore(); assert.equal(owner.isMainForeground, true);
    }
    assert.equal(themes.length, binding, "same named palette never calls stock setTheme");
    await owner.acquire(); ui.theme.name = "other"; owner.restore();
    assert.equal(themes.at(-1), "named", "a genuinely different theme still restores");
  } finally { owner.dispose(); }
}
assert.equal(drains, 6); assert.equal(stops, 6); assert.equal(starts, 6);
assert.equal(notices.length, 1);
assert.match(notices[0][0], /主题不随文件热更新/);
assert.ok(notices[0][0].includes("host-patches/pi/v1.5.0/README.md"));
assert.equal(notices[0][1], "warning");
assert.equal(globalThis[Symbol.for("pi.session-runtime.terminal-owner.v1")].hasManagedView, undefined);
`]);
});
