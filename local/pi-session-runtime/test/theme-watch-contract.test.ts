import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireThemeWatchContract } from "../src/theme-watch-contract.ts";

const capability = "pi.theme-watch.file-version.v1";
const execute = promisify(execFile);
const cases = [
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
  requireThemeWatchContract({ themeWatchCapability: capability }, { THEME_WATCH_CAPABILITY: capability });
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

test("managed handoff rejects incompatible markers before drain/stop and releases its lease", async () => {
  // This focused guard test deliberately supplies marker fixtures over the real public
  // SDK functions. It does not claim that a stock SDK implements the theme-watch patch.
  for (const { main, sdk } of cases) {
    await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import * as tui from "@earendil-works/pi-tui";
const publicModules = Object.freeze({
  "@earendil-works/pi-coding-agent": Object.freeze({ ...codingAgent, THEME_WATCH_CAPABILITY: ${JSON.stringify(sdk) ?? "undefined"} }),
  "@earendil-works/pi-ai": ai, "@earendil-works/pi-tui": tui,
});
Object.defineProperty(globalThis, Symbol.for("pi.session-runtime.session-assembly-realm.v1"), {
  value: Object.freeze({ version: 1, sdkVersion: codingAgent.VERSION, publicModules }),
});
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
import * as ai from "@earendil-works/pi-ai";
import * as tui from "@earendil-works/pi-tui";
const publicModules = Object.freeze({
  "@earendil-works/pi-coding-agent": Object.freeze({ ...codingAgent, THEME_WATCH_CAPABILITY: ${JSON.stringify(capability)} }),
  "@earendil-works/pi-ai": ai, "@earendil-works/pi-tui": tui,
});
Object.defineProperty(globalThis, Symbol.for("pi.session-runtime.session-assembly-realm.v1"), {
  value: Object.freeze({ version: 1, sdkVersion: codingAgent.VERSION, publicModules }),
});
const { TerminalOwner } = await import(${JSON.stringify(new URL("../src/terminal-owner.ts", import.meta.url).href)});
let drains = 0, stops = 0, setting = "light/dark";
const terminal = { write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => { drains++; } };
const ui = { themeWatchCapability: ${JSON.stringify(capability)}, theme: { name: "named" },
  getTheme: () => ({}), onTerminalInput: () => () => {}, getAllThemes: () => [], setTheme: () => ({ success: true }) };
const owner = new TerminalOwner({ terminal, stop() { stops++; }, start() {}, requestRender() {} }, ui, () => setting);
try {
  await assert.rejects(owner.acquire(), /single named Main theme/);
  assert.equal(drains, 0); assert.equal(stops, 0); assert.equal(owner.isMainForeground, true);
  setting = "named";
  await owner.acquire();
  assert.equal(drains, 1); assert.equal(stops, 1); assert.equal(owner.isMainForeground, false);
  owner.restore(); assert.equal(owner.isMainForeground, true);
} finally { owner.dispose(); }
`]);
});
