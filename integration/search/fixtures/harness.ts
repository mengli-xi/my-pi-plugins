import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  SessionManager, SettingsManager, type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { captureEntrypointDescriptorV1, getOrCreateChildCapabilityRegistryV1 } from "pi-runtime-contracts/child-capabilities-v1";
import { sdkProviderApprovalV1 } from "pi-session-runtime/sdk-provider";
import { createSearchFixtureProvider, type ProviderControl } from "./provider/index.ts";
import { BACKEND_CONTROLS, type BackendControl } from "./backend.ts";

export const searchPath = fileURLToPath(new URL("../../../fork/pi-native-search/extensions/index.ts", import.meta.url));
export const ccPath = fileURLToPath(new URL("../../../local/pi-claude-style/dist/index.ts", import.meta.url));
const subagentsPath = fileURLToPath(new URL("../../../local/pi-subagents/dist/index.js", import.meta.url));
const backendPath = fileURLToPath(new URL("./backend.ts", import.meta.url));

export function memoryHttp() {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("https://html.duckduckgo.com/html/?q=")) return new Response('<a class="result__a" href="https://result.fixture.invalid">OFFLINE_DDG</a><a class="result__snippet">offline snippet</a>');
    assert.equal(url, "https://page.fixture.invalid/allowed", "all HTTP must be an explicit in-memory fixture; forbidden fetch must never execute");
    return new Response("<h1>OFFLINE_PAGE</h1><script>hidden</script><p>offline body</p>", { headers: { "Content-Type": "text/html" } });
  };
  return { requests, restore() { globalThis.fetch = original; } };
}

export async function until(predicate: () => boolean, label: string, diagnostics: () => unknown) {
  const deadline = Date.now() + 30000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(diagnostics())}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Production Native Search/CC/SA load through their physical entrypoints. Only
 * provider responses, backend service and HTTP are test-owned actors. */
export async function searchFixture(options: { subagents?: boolean; cc?: "before" | "after"; backendFirst?: boolean; label?: string; native?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "search-integration-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const controlKey = `search-integration-provider:${randomUUID()}`;
  const control: ProviderControl = { requests: [] };
  (globalThis as any)[Symbol.for(controlKey)] = control;
  const backend: BackendControl = { label: options.label ?? "MAIN_BACKEND", available: true, calls: [] };
  const controls: Map<string, BackendControl> = (globalThis as any)[BACKEND_CONTROLS] ??= new Map();
  controls.set(agentDir, backend);
  mkdirSync(join(agentDir, "pi-subagents"), { mode: 0o700 });
  mkdirSync(join(agentDir, "pi-subagents", "roles"), { recursive: true });
  writeFileSync(join(agentDir, "pi-subagents", "config.json"), JSON.stringify({ schemaVersion: 2, execution: { maxDepth: 1 } }));
  writeFileSync(join(agentDir, "pi-subagents", "roles", "search-only.md"), "---\nname: search-only\ndescription: Search without fetching pages\ntools: [web_search]\n---\nUse web_search only.\n");
  const providerPath = fileURLToPath(new URL("./provider/index.ts", import.meta.url));
  const descriptor = captureEntrypointDescriptorV1(providerPath);
  const manifest = { version: 1 as const, owner_id: `search-integration-provider-${randomUUID()}`, main_entrypoint: descriptor, targets: { "pi-subagents": {
    child_entrypoint: descriptor, activation: "required-only" as const, commands: [], tools: [], hooks: [], requires: [],
    providers: [{ provider_id: "search-faux", service_tiers: [], service_tier_application: "none" as const }],
    sdk_provider_factory: { provider_id: "search-faux", package_manifest: captureEntrypointDescriptorV1(fileURLToPath(new URL("./provider/package.json", import.meta.url))), module: descriptor,
      export: "createSearchFixtureProvider", config: { controlKey }, artifacts: [] },
  } } };
  writeFileSync(join(agentDir, "sdk-provider-grants.json"), JSON.stringify({ version: 1, grants: [sdkProviderApprovalV1(manifest, "pi-subagents")] }));
  let context!: ExtensionContext;
  const errors: string[] = [];
  let generation = 0;
  const provider: ExtensionFactory = pi => {
    createSearchFixtureProvider({ config: { controlKey } })(pi);
    const registry = getOrCreateChildCapabilityRegistryV1();
    const registration = registry.register({ version: 1, manifest });
    let binding: { release(): void } | undefined;
    pi.on("session_start", (_event, ctx) => {
      context = ctx;
      binding = registry.bind({ version: 1, registrationToken: registration.registrationToken,
        session_id: ctx.sessionManager.getSessionId(), runtime_generation: ++generation, mode: "rpc" });
    });
    pi.on("session_shutdown", () => { binding?.release(); registration.release(); });
  };
  const paths = options.native === false ? [backendPath] : options.backendFirst ? [backendPath, searchPath] : [searchPath, backendPath];
  if (options.cc === "before") paths.unshift(ccPath);
  if (options.cc === "after") paths.push(ccPath);
  if (options.subagents) paths.push(subagentsPath);
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"], additionalExtensionPaths: paths, extensionFactories: [provider] },
    });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: services.modelRuntime.getModel("search-faux", "offline"), thinkingLevel: "off",
      tools: [...(options.native === false ? [] : ["web_search", "web_fetch"]), ...(options.subagents ? ["spawn_agent", "list_agents", "close_agent", "send_input"] : [])] });
    await result.session.bindExtensions({ mode: "rpc", onError: event => errors.push(String(event.error)) });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: root, agentDir, sessionManager: SessionManager.create(root, join(root, "sessions")) });
  return { root, agentDir, runtime, control, backend, errors, get context() { return context; },
    async close() {
      try {
        await runtime.dispose();
        if (options.subagents) {
          const { getProcessServiceCellV1 } = await import("../../../local/pi-subagents/src/host/service-cell.ts");
          const cell = getProcessServiceCellV1();
          await cell.service?.close(); cell.service = undefined; cell.promise = undefined;
        }
      } finally {
        controls.delete(agentDir); delete (globalThis as any)[Symbol.for(controlKey)];
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
