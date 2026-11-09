import { requirePatchedHost } from "./patched-host.ts";
requirePatchedHost();

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as physicalSdk from "@earendil-works/pi-coding-agent";
import * as physicalAi from "@earendil-works/pi-ai";
import * as physicalTui from "@earendil-works/pi-tui";
import type { AgentSessionRuntime, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { assembleChildSession, getSessionAssemblyPublicModules } from "../src/session-assembly.ts";
import { loadApprovedFactoryModule } from "../src/factory-loader.ts";
import { ManagedInteractive } from "../src/managed-interactive.ts";
import { TerminalOwner } from "../src/terminal-owner.ts";

const execute = promisify(execFile);
const assemblyPath = fileURLToPath(new URL("../src/session-assembly.ts", import.meta.url));
const factoryLoaderPath = fileURLToPath(new URL("../src/factory-loader.ts", import.meta.url));
const order = process.env.PI_SESSION_RUNTIME_REALM_TEST_ORDER;

async function sameProcessRealmMatrix(first: "native" | "jiti") {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-realm-"));
  const runtimes: AgentSessionRuntime[] = [];
  try {
    // Copy the actual installed SDK, not a mock class or version string. Its existing
    // dependencies are reused; the test installs nothing and sends no provider request.
    const sdkRoot = fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const peers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"];
    const nativeDependencies = dirname(dirname(sdkRoot)), foreignDependencies = join(dir, "node_modules");
    await mkdir(join(foreignDependencies, "@earendil-works"), { recursive: true });
    for (const name of await readdir(nativeDependencies)) {
      if (name === "@earendil-works") {
        for (const child of await readdir(join(nativeDependencies, name))) {
          if (!peers.includes(`${name}/${child}`)) await symlink(join(nativeDependencies, name, child), join(foreignDependencies, name, child), "dir");
        }
      } else await symlink(join(nativeDependencies, name), join(foreignDependencies, name), "dir");
    }
    for (const name of peers) {
      const source = fileURLToPath(new URL("../", import.meta.resolve(name)));
      await cp(source, join(foreignDependencies, name), { recursive: true, filter: path => !path.endsWith(".map") &&
        ![join(source, "dist", "bundle"), join(source, "docs"), join(source, "examples")].includes(path) });
    }
    const foreignSdk = await import(pathToFileURL(join(foreignDependencies, peers[0]!, "dist", "index.js")).href) as typeof physicalSdk;
    const foreignAi = await import(pathToFileURL(join(foreignDependencies, peers[1]!, "dist", "index.js")).href) as typeof physicalAi;
    const foreignTui = await import(pathToFileURL(join(foreignDependencies, peers[2]!, "dist", "index.js")).href) as typeof physicalTui;
    assert.notEqual(foreignSdk.AgentSession, physicalSdk.AgentSession);
    assert.notEqual(foreignSdk.InteractiveMode, physicalSdk.InteractiveMode);
    assert.notEqual(foreignAi.getCurrentSystemPrompt, physicalAi.getCurrentSystemPrompt);
    assert.notEqual(foreignTui.getKeybindings, physicalTui.getKeybindings);
    const physicalModules = { "@earendil-works/pi-coding-agent": foreignSdk, "@earendil-works/pi-ai": foreignAi, "@earendil-works/pi-tui": foreignTui };
    const foreignAssembly = await loadApprovedFactoryModule({ path: assemblyPath,
      exports: ["assembleChildSession", "getSessionAssemblyPublicModules"], publicModules: physicalModules,
    }) as unknown as Pick<typeof import("../src/session-assembly.ts"), "assembleChildSession" | "getSessionAssemblyPublicModules">;
    const foreignLoader = await loadApprovedFactoryModule({ path: factoryLoaderPath,
      exports: ["loadApprovedFactoryModule"], publicModules: physicalModules,
    }) as unknown as Pick<typeof import("../src/factory-loader.ts"), "loadApprovedFactoryModule">;
    assert.notEqual(foreignAssembly.assembleChildSession, assembleChildSession);
    assert.notEqual(foreignLoader.loadApprovedFactoryModule, loadApprovedFactoryModule);

    // Both claiming orders run in separate processes; within each process the two
    // actual assembly/loader instances alternate against ONE unchanged factory path.
    const modules = first === "native" ? getSessionAssemblyPublicModules() : foreignAssembly.getSessionAssemblyPublicModules();
    assert.equal(getSessionAssemblyPublicModules(), modules);
    assert.equal(foreignAssembly.getSessionAssemblyPublicModules(), modules);
    assert.ok(Object.isFrozen(modules));
    assert.deepEqual(Object.keys(modules).sort(), ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);
    const sdk = modules["@earendil-works/pi-coding-agent"];
    assert.equal(sdk.AgentSession, first === "native" ? physicalSdk.AgentSession : foreignSdk.AgentSession);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("pi.session-runtime.session-assembly-realm.v1"))!;
    assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
    assert.ok(Object.isFrozen(descriptor.value));

    const path = join(dir, "factory.ts");
    await writeFile(path, `
import * as sdk from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as ai from "@earendil-works/pi-ai";
export function createFactory(observe) {
  return pi => pi.on("session_start", (_event, ctx) => observe(ctx.sessionManager instanceof sdk.SessionManager));
}
export function inspect(session) {
  return {
    sessionMatches: session instanceof sdk.AgentSession,
    runnerMatches: session.extensionRunner instanceof sdk.ExtensionRunner,
    AgentSession: sdk.AgentSession, InteractiveMode: sdk.InteractiveMode,
    CustomEditor: sdk.CustomEditor, ProcessTerminal: tui.ProcessTerminal,
    getKeybindings: tui.getKeybindings, getCurrentSystemPrompt: ai.getCurrentSystemPrompt,
  };
}
`);
    const native = { assembleChildSession, getSessionAssemblyPublicModules, loadApprovedFactoryModule };
    const jiti = { ...foreignAssembly, ...foreignLoader };
    const owners = first === "native" ? [native, jiti, native, jiti] : [jiti, native, jiti, native];
    let firstFactory: unknown;
    for (const owner of owners) {
      const approved = await owner.loadApprovedFactoryModule({ path, exports: ["createFactory", "inspect"], publicModules: owner.getSessionAssemblyPublicModules() });
      firstFactory ??= approved.createFactory;
      assert.equal(approved.createFactory, firstFactory, "shared CJS cache is safe because every owner supplies the identical canonical realm");
      const observed: boolean[] = [];
      const factory = (approved.createFactory as (observe: (same: boolean) => void) => ExtensionFactory)(same => observed.push(same));
      const faux = fauxProvider({ provider: "realm-faux", api: "realm-faux", models: [{ id: "local", contextWindow: 32768, maxTokens: 256 }] });
      const runtime = await owner.assembleChildSession({
        cwd: dir, agentDir: dir, sessionManager: sdk.SessionManager.inMemory(dir),
        parentSettings: { packages: [], retry: { enabled: false } }, projectTrusted: false,
        provider: "realm-faux", model: "local", thinkingLevel: "off", modelScope: ["realm-faux/local"],
        tools: [], systemPrompt: "Same-process SDK realm fixture; no provider request.",
        extensions: [pi => pi.registerProvider(faux.provider), factory], shutdown: () => {},
      });
      runtimes.push(runtime);
      const identity = (approved.inspect as (session: unknown) => Record<string, unknown>)(runtime.session);
      assert.equal(runtime.session.constructor, sdk.AgentSession);
      assert.equal(identity.sessionMatches, true); assert.equal(identity.runnerMatches, true);
      assert.equal(identity.AgentSession, sdk.AgentSession); assert.equal(identity.InteractiveMode, sdk.InteractiveMode);
      assert.equal(identity.CustomEditor, sdk.CustomEditor);
      assert.equal(identity.ProcessTerminal, modules["@earendil-works/pi-tui"].ProcessTerminal);
      assert.equal(identity.getKeybindings, modules["@earendil-works/pi-tui"].getKeybindings);
      assert.equal(identity.getCurrentSystemPrompt, modules["@earendil-works/pi-ai"].getCurrentSystemPrompt);
      assert.ok(observed.length > 0 && observed.every(Boolean));

      let acquired = 0, restored = 0, constructed = false;
      const terminalOwner = { acquire: async () => { acquired++; }, restore: () => { restored++; }, themeName: "dark", isMainForeground: false };
      const stoppedBeforeInit = new Error("identity checked before native terminal init");
      const view = new ManagedInteractive(error => { throw error; }, async () => {});
      view.configureMode = mode => {
        constructed = true;
        assert.equal(mode.constructor, identity.InteractiveMode);
        assert.ok(mode instanceof sdk.InteractiveMode);
        mode.stop = () => {};
        throw stoppedBeforeInit;
      };
      await assert.rejects(view.open(runtime, terminalOwner as never, {} as never), error => error === stoppedBeforeInit);
      assert.equal(constructed, true); assert.equal(acquired, 1); assert.equal(restored, 1);
      assert.equal(view.attached, false); assert.equal(runtime.session.messages.length, 0);
    }
    const otherSdk = sdk.AgentSession === physicalSdk.AgentSession ? foreignSdk : physicalSdk;
    const otherModules = { "@earendil-works/pi-coding-agent": otherSdk,
      "@earendil-works/pi-ai": modules["@earendil-works/pi-ai"] === physicalAi ? foreignAi : physicalAi,
      "@earendil-works/pi-tui": modules["@earendil-works/pi-tui"] === physicalTui ? foreignTui : physicalTui };
    for (const loader of [loadApprovedFactoryModule, foreignLoader.loadApprovedFactoryModule]) {
      for (const name of peers) await assert.rejects(loader({ path, exports: ["inspect"], publicModules: { ...modules, [name]: otherModules[name as keyof typeof otherModules] } }), /Approved factory SDK realm changed/);
    }
    // Main key state lives in the canonical TUI even when an owner's own physical
    // import belongs to the other copy. Alternate actual native/Jiti owner classes.
    const alternateOwner = await foreignLoader.loadApprovedFactoryModule({
      path: fileURLToPath(new URL("../src/terminal-owner.ts", import.meta.url)), exports: ["TerminalOwner"], publicModules: physicalModules,
    }) as unknown as { TerminalOwner: typeof TerminalOwner };
    assert.notEqual(alternateOwner.TerminalOwner, TerminalOwner);
    const canonicalTui = modules["@earendil-works/pi-tui"];
    const otherTui = canonicalTui.getKeybindings === physicalTui.getKeybindings ? foreignTui : physicalTui;
    const mainKeys = canonicalTui.getKeybindings(), otherKeys = otherTui.getKeybindings();
    assert.notEqual(mainKeys, otherKeys, "the two real TUI modules have distinct state cells");
    const terminal = { write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, drainInput: async () => {} };
    const mainTui = { terminal, stop() {}, start() {}, requestRender() {} };
    const ui = { themeWatchCapability: "pi.theme-watch.file-version.v1", theme: { name: "named" }, getTheme: () => ({}), onTerminalInput: () => () => {},
      setTheme: () => ({ success: true }), getAllThemes: () => [] };
    const nativeOwner = new TerminalOwner(mainTui as never, ui as never, () => "named");
    const jitiOwner = new alternateOwner.TerminalOwner(mainTui as never, ui as never, () => "named");
    try {
      const ownerOrder = first === "native" ? [nativeOwner, jitiOwner, nativeOwner, jitiOwner] : [jitiOwner, nativeOwner, jitiOwner, nativeOwner];
      for (const owner of ownerOrder) {
        await owner.acquire();
        const childKeys = new canonicalTui.KeybindingsManager({});
        canonicalTui.setKeybindings(childKeys);
        assert.equal(canonicalTui.getKeybindings(), childKeys);
        assert.equal(otherTui.getKeybindings(), otherKeys, "child changes only its canonical TUI state cell");
        owner.restore();
        assert.equal(canonicalTui.getKeybindings(), mainKeys, "each physical owner must restore the exact canonical Main keybindings identity");
        assert.equal(otherTui.getKeybindings(), otherKeys, "restore must not write the unrelated physical TUI state cell");
      }
    } finally { nativeOwner.dispose(); jitiOwner.dispose(); canonicalTui.setKeybindings(mainKeys); otherTui.setKeybindings(otherKeys); }

    // No fallback accepts a session from a genuinely different, noncanonical SDK.
    const otherServices = await otherSdk.createAgentSessionServices({ cwd: dir, agentDir: dir,
      settingsManager: otherSdk.SettingsManager.inMemory({ packages: [] }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
        extensionFactories: [pi => pi.registerProvider(fauxProvider({ provider: "foreign-faux", api: "foreign-faux", models: [{ id: "local" }] }).provider)] },
    });
    const other = await otherSdk.createAgentSessionFromServices({ services: otherServices, sessionManager: otherSdk.SessionManager.inMemory(dir),
      model: otherServices.modelRuntime.getModel("foreign-faux", "local")!, tools: [] });
    try {
      let handoff = false;
      const view = new ManagedInteractive(error => { throw error; }, async () => {});
      await assert.rejects(view.open({ session: other.session } as AgentSessionRuntime, { acquire: async () => { handoff = true; } } as never, {} as never), /same session-assembly SDK realm/);
      assert.equal(handoff, false);
    } finally { other.session.dispose(); }
  } finally { for (const runtime of runtimes.reverse()) await runtime.dispose(); await rm(dir, { recursive: true, force: true }); }
}

if (order === "native" || order === "jiti") {
  test(`same factory path and alternating physical assemblies: ${order} first`, () => sameProcessRealmMatrix(order));
} else {
  for (const first of ["native", "jiti"] as const) test(`canonical SDK realm survives same-path dual-loader assembly: ${first} first`, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-realm-agent-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PI_SESSION_RUNTIME_REALM_TEST_ORDER: first, PI_CODING_AGENT_DIR: agentDir };
      delete env.NODE_TEST_CONTEXT;
      const { stdout } = await execute(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], { env });
      assert.match(stdout, /pass 1/u); assert.match(stdout, /fail 0/u);
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  test("idle TerminalOwner bindings do not initialize the SDK realm", async () => {
    await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
const { TerminalOwner } = await import(${JSON.stringify(new URL("../src/terminal-owner.ts", import.meta.url).href)});
const key = Symbol.for("pi.session-runtime.session-assembly-realm.v1");
assert.equal(Object.hasOwn(globalThis, key), false);
const owner = new TerminalOwner({ terminal: { write() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} } },
  { onTerminalInput: () => () => {} }, () => "named");
owner.dispose();
assert.equal(Object.hasOwn(globalThis, key), false);
`]);
  });

  test("invalid, mutable or mixed-version process realm registries fail closed", async () => {
    for (const expression of ["{ version: 2 }", "{ version: 1, sdkVersion: '1.5.0', publicModules: {} }",
      "Object.freeze({ version: 1, sdkVersion: '0.0.0', publicModules: Object.freeze({}) })"]) {
      await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
Object.defineProperty(globalThis, Symbol.for("pi.session-runtime.session-assembly-realm.v1"), { value: ${expression} });
const assembly = await import(${JSON.stringify(pathToFileURL(assemblyPath).href)});
assert.throws(() => assembly.getSessionAssemblyPublicModules(), /Incompatible session-assembly SDK realm/);
`]);
    }
    for (const expression of ["null", "Object.freeze({ version: 2, paths: new Map() })", "Object.freeze({ version: 1, paths: {} })"]) {
      await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
Object.defineProperty(globalThis, Symbol.for("pi.session-runtime.factory-loader-realms.v1"), { value: ${expression} });
const assembly = await import(${JSON.stringify(pathToFileURL(assemblyPath).href)});
const loader = await import(${JSON.stringify(pathToFileURL(factoryLoaderPath).href)});
await assert.rejects(loader.loadApprovedFactoryModule({ path: ${JSON.stringify(assemblyPath)}, exports: ["getSessionAssemblyPublicModules"], publicModules: assembly.getSessionAssemblyPublicModules() }), /Incompatible approved factory realm registry/);
`]);
    }
    await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
import assert from "node:assert/strict";
const assembly = await import(${JSON.stringify(pathToFileURL(assemblyPath).href)});
const modules = assembly.getSessionAssemblyPublicModules();
const loader = await import(${JSON.stringify(pathToFileURL(factoryLoaderPath).href)});
const other = await loader.loadApprovedFactoryModule({ path: ${JSON.stringify(assemblyPath)}, exports: ["getSessionAssemblyPublicModules"],
  publicModules: { ...modules, "@earendil-works/pi-coding-agent": { ...modules["@earendil-works/pi-coding-agent"], VERSION: "incompatible-test-version" } } });
assert.throws(() => other.getSessionAssemblyPublicModules(), /Incompatible session-assembly SDK realm/);
`]);
  });
}
