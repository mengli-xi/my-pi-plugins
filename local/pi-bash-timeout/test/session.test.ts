import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile, appendFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_CAPABILITY_REGISTRY_V1, createChildCapabilityRegistryV1, type ChildCapabilityRegistrationHandleV1 } from "pi-runtime-contracts/child-capabilities-v1";

const mainPath = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const registry = createChildCapabilityRegistryV1();
const outstanding = new Map<string, ChildCapabilityRegistrationHandleV1>();
let maximumOutstanding = 0;
// Count real registry handles in this isolated test process. Snapshots expose
// only the current bound candidate, so they cannot reveal retired registrations.
Object.defineProperty(globalThis, CHILD_CAPABILITY_REGISTRY_V1, { configurable: true, value: Object.freeze({
  ...registry,
  operationVersion: 2,
  register(input: Parameters<typeof registry.register>[0]) {
    const handle = registry.register(input);
    outstanding.set(handle.registrationToken, handle);
    maximumOutstanding = Math.max(maximumOutstanding, outstanding.size);
    return Object.freeze({ registrationToken: handle.registrationToken, release() {
      handle.release();
      outstanding.delete(handle.registrationToken);
    } });
  },
}) });
after(() => {
  for (const handle of outstanding.values()) handle.release();
  delete (globalThis as Record<symbol, unknown>)[CHILD_CAPABILITY_REGISTRY_V1];
});

async function runtimeFixture(root: string, defaultTools?: string[], tools?: string[], entrypoint: () => string | undefined = () => mainPath) {
  const faux = fauxProvider({ provider: "bash-session-faux", api: "bash-session-faux", models: [{ id: "faux", name: "Faux", contextWindow: 128000, maxTokens: 128, reasoning: false }] });
  const errors: string[] = [], shutdowns: string[] = [];
  let toolsInfo: ReturnType<ExtensionAPI["getAllTools"]> = [];
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const path = entrypoint();
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], defaultTools, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
        additionalExtensionPaths: path ? [path] : [],
        extensionFactories: [pi => {
          pi.registerProvider(faux.provider);
          pi.on("session_shutdown", event => { shutdowns.push(event.reason); });
          pi.on("session_start", () => { toolsInfo = pi.getAllTools(); });
        }],
      },
    });
    assert.deepEqual(services.diagnostics.filter(item => item.type === "error"), []);
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools, model: faux.getModel(), thinkingLevel: "off" });
    await result.session.bindExtensions({ mode: "rpc", onError: event => { errors.push(String(event.error)); } });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: SessionManager.inMemory(root) });
  return { runtime, faux, errors, shutdowns, tools: () => toolsInfo };
}

for (const selection of [
  { name: "empty defaultTools", defaultTools: [], expected: [] },
  { name: "defaultTools excludes bash", defaultTools: ["read"], expected: ["read"] },
  { name: "defaultTools modifier removes bash", defaultTools: ["-bash"], expected: ["read", "edit", "write"] },
  { name: "default selection includes bash", expected: ["read", "bash", "edit", "write"] },
  { name: "defaultTools includes bash", defaultTools: ["read", "bash"], expected: ["read", "bash"] },
  { name: "explicit tools exclude bash", defaultTools: ["read", "bash"], tools: ["read"], expected: ["read"] },
  { name: "explicit tools select bash", defaultTools: [], tools: ["bash"], expected: ["bash"] },
]) test(`fresh session preserves ${selection.name}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "bash-loadout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const installed of [false, true]) {
    const fixture = await runtimeFixture(root, selection.defaultTools, selection.tools, () => installed ? mainPath : undefined);
    try {
      assert.deepEqual(fixture.runtime.session.getActiveToolNames(), selection.expected);
      assert.deepEqual(fixture.errors, []);
      if (installed && selection.expected.includes("bash")) assert.equal(fixture.tools().find(tool => tool.name === "bash")?.sourceInfo.path, await realpath(mainPath));
      assert.equal(fixture.faux.state.callCount, 0);
    } finally { await fixture.runtime.dispose(); }
    assert.equal(outstanding.size, 0);
  }
});

test("real new/resume/fork/reload/quit factory cycles retire registrations across package path and hash changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "bash-factory-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let path = mainPath;
  maximumOutstanding = 0;
  const fixture = await runtimeFixture(root, undefined, undefined, () => path);
  const { runtime } = fixture;
  const check = () => {
    assert.equal(outstanding.size, 1);
    assert.equal(maximumOutstanding, 1);
    assert.deepEqual(fixture.errors, []);
    const snapshot = registry.snapshot(runtime.session.sessionManager.getSessionId());
    assert.deepEqual(snapshot.conflicts, []);
    assert.deepEqual(snapshot.registrations.map(item => item.owner_id), ["pi-bash-timeout"]);
    const targets = snapshot.registrations[0]!.manifest.targets;
    assert.deepEqual(targets["pi-side-chat"], targets["pi-subagents"]);
    assert.equal(targets["pi-side-chat"]!.activation, "required-only");
    assert.deepEqual(targets["pi-side-chat"]!.tools, ["bash"]);
    assert.equal(fixture.faux.state.callCount, 0);
  };
  try {
    check();
    await runtime.newSession(); check();
    const resumed = join(root, "resume.jsonl");
    await writeFile(resumed, JSON.stringify({ type: "session", version: 3, id: "bash-resumed", timestamp: new Date().toISOString(), cwd: root }) + "\n");
    await runtime.switchSession(resumed); check();
    const entry = runtime.session.sessionManager.appendMessage({ role: "user", content: "Fork fixture", timestamp: Date.now() });
    await runtime.fork(entry); check();
    await runtime.session.reload(); check();

    const copied = join(root, "copied-package");
    await cp(fileURLToPath(new URL("../extensions", import.meta.url)), join(copied, "extensions"), { recursive: true });
    await cp(fileURLToPath(new URL("../package.json", import.meta.url)), join(copied, "package.json"));
    await mkdir(join(copied, "node_modules"));
    await symlink(fileURLToPath(new URL("../../pi-runtime-contracts", import.meta.url)), join(copied, "node_modules/pi-runtime-contracts"), "dir");
    path = join(copied, "extensions/index.ts");
    await runtime.newSession(); check();
    const descriptor = () => registry.snapshot(runtime.session.sessionManager.getSessionId()).registrations[0]!.manifest;
    assert.equal(descriptor().main_entrypoint.canonical_path, await realpath(path));
    const oldHash = descriptor().targets["pi-subagents"]!.child_entrypoint.sha256;
    await appendFile(join(copied, "extensions/child.ts"), "\n// Changed descriptor hash for lifecycle regression.\n");
    await runtime.session.reload(); check();
    assert.notEqual(descriptor().targets["pi-subagents"]!.child_entrypoint.sha256, oldHash);
  } finally { await runtime.dispose(); }
  assert.equal(outstanding.size, 0);
  assert.deepEqual(fixture.shutdowns, ["new", "resume", "fork", "reload", "new", "reload", "quit"]);
  assert.equal(fixture.faux.state.callCount, 0);
});
