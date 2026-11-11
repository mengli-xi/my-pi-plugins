import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAiModels from "@earendil-works/pi-ai/models";
import * as piAiOauth from "@earendil-works/pi-ai/oauth";
import * as piAiProviders from "@earendil-works/pi-ai/providers/all";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import type * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piTui from "@earendil-works/pi-tui";
import type {
  SettingsManager, SessionManager, AgentSessionRuntime, AgentSession,
  InlineExtension, CreateAgentSessionFromServicesOptions,
} from "@earendil-works/pi-coding-agent";

type PublicModules = Readonly<{
  "@earendil-works/pi-coding-agent": typeof piCodingAgent;
  "@earendil-works/pi-ai": typeof piAiCompat & { Type: typeof typebox.Type; StringEnum: typeof piAi.StringEnum };
  "@earendil-works/pi-tui": typeof piTui;
} & Record<string, object>>;
interface AssemblyRealm { readonly version: 1; readonly sdkVersion: string; readonly publicModules: PublicModules }
const realmKey = Symbol.for("pi.session-runtime.session-assembly-realm.v1");

/** Pi 1.5's native root is core-only; reuse the exact loader view, never synthesize SDK exports.
 * Extension/bundled hosts already inject it under the public root. Only native Node needs
 * the pinned SDK-relative view (not package discovery or a second SDK installation).
 */
function extensionAi(): PublicModules["@earendil-works/pi-ai"] {
  if ("Type" in piAi && "openAIResponsesApi" in piAi) return piAi as PublicModules["@earendil-works/pi-ai"];
  const view = new URL("./core/extensions/pi-ai-extension-view.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  return createRequire(import.meta.url)(fileURLToPath(view));
}

/** One immutable SDK realm across native and Jiti library copies; never creates SDK services. */
export function getSessionAssemblyPublicModules(): PublicModules {
  const global = globalThis as typeof globalThis & { [realmKey]?: AssemblyRealm };
  if (!Object.hasOwn(global, realmKey)) {
    // Keep in lockstep with Pi 1.5 loader.getAliases(), including legacy spellings.
    const ai = extensionAi();
    const current = {
      "@earendil-works/pi-coding-agent": piCodingAgent,
      "@earendil-works/pi-agent-core": piAgentCore,
      "@earendil-works/pi-tui": piTui,
      "@earendil-works/pi-ai/providers/all": piAiProviders,
      "@earendil-works/pi-ai/compat": ai,
      "@earendil-works/pi-ai/models": piAiModels,
      "@earendil-works/pi-ai/oauth": piAiOauth,
      "@earendil-works/pi-ai": ai,
    };
    const publicModules = Object.freeze({ ...current,
      ...Object.fromEntries(Object.entries(current).map(([name, module]) => [name.replace("@earendil-works/", "@mariozechner/"), module])),
      typebox, "typebox/compile": typeboxCompile, "typebox/value": typeboxValue,
      "@sinclair/typebox": typebox, "@sinclair/typebox/compile": typeboxCompile, "@sinclair/typebox/value": typeboxValue,
    });
    Object.defineProperty(global, realmKey, { value: Object.freeze({ version: 1, sdkVersion: piCodingAgent.VERSION, publicModules }) });
  }
  const descriptor = Object.getOwnPropertyDescriptor(global, realmKey)!;
  const realm = descriptor.value as AssemblyRealm | undefined;
  const modules = realm?.publicModules;
  const required = {
    "@earendil-works/pi-coding-agent": ["createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime", "SettingsManager", "AgentSession", "InteractiveMode", "CustomEditor"],
    "@earendil-works/pi-ai": ["getCurrentSystemPrompt", "openAIResponsesApi", "StringEnum"],
    "@earendil-works/pi-agent-core": ["Agent"],
    "@earendil-works/pi-ai/models": ["createModels"],
    "@earendil-works/pi-ai/oauth": [],
    "@earendil-works/pi-ai/providers/all": ["getBuiltinModels"],
    "typebox/compile": ["Compile"],
    "typebox/value": ["Check"],
    "@earendil-works/pi-tui": ["ProcessTerminal", "matchesKey", "isKeyRelease", "isKeyRepeat", "getKeybindings", "setKeybindings"],
  };
  if (!realm || realm.version !== 1 || typeof realm.sdkVersion !== "string" || !realm.sdkVersion ||
      realm.sdkVersion !== piCodingAgent.VERSION || modules?.["@earendil-works/pi-coding-agent"]?.VERSION !== realm.sdkVersion ||
      descriptor.configurable || descriptor.writable || !Object.isFrozen(realm) || !modules || !Object.isFrozen(modules) ||
      modules["@earendil-works/pi-ai/compat"] !== modules["@earendil-works/pi-ai"] ||
      !modules.typebox || Object.entries(modules).some(([name, module]) =>
        name.startsWith("@earendil-works/") && modules[name.replace("@earendil-works/", "@mariozechner/")] !== module ||
        name.startsWith("typebox") && modules[name.replace("typebox", "@sinclair/typebox")] !== module) ||
      Object.entries(required).some(([name, exports]) => (!modules[name as keyof PublicModules] || exports.some(key => typeof (modules[name as keyof PublicModules] as unknown as Record<string, unknown> | undefined)?.[key] !== "function")))) {
    throw new Error("Incompatible session-assembly SDK realm registry or Pi SDK version");
  }
  return modules;
}

type Settings = ReturnType<SettingsManager["getSettings"]>;
type ExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

export interface ChildSessionAssemblyOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionManager: SessionManager;
  readonly parentSettings: Readonly<Settings>;
  readonly projectTrusted: boolean;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: CreateAgentSessionFromServicesOptions["thinkingLevel"];
  readonly modelScope: readonly string[];
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly extensions: readonly InlineExtension[];
  readonly approvedBuiltinExtensions?: readonly ("codemode" | "tool-search" | "mcp")[];
  readonly shutdown: NonNullable<ExtensionBindings["shutdownHandler"]>;
  readonly onError?: ExtensionBindings["onError"];
}

/** Child defaults scale down for small windows; never inherit invalid Main budgets. */
export function childCompactionSettings(model: { contextWindow: number }) {
  const window = model.contextWindow;
  if (!Number.isSafeInteger(window) || window < 1024) throw new Error("Child model context window must be at least 1024 tokens");
  return { enabled: true, reserveTokens: Math.min(16_384, Math.floor(window / 8)), keepRecentTokens: Math.min(20_000, Math.floor(window / 16)) };
}

/** One owner, one loader, one model runtime, one native writer. No ambient extensions. */
export async function assembleChildSession(options: ChildSessionAssemblyOptions): Promise<AgentSessionRuntime> {
  const { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, SettingsManager } = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
  // Freeze at the assembly boundary; neither caller mutations nor child writes can reach Main.
  const frozenSettings = structuredClone(options.parentSettings);
  if (options.approvedBuiltinExtensions !== undefined && !Array.isArray(options.approvedBuiltinExtensions)) throw new Error("approvedBuiltinExtensions must be an explicit array");
  const approvedBuiltins = [...(options.approvedBuiltinExtensions ?? [])];
  const allowedBuiltins = ["codemode", "tool-search", "mcp"] as const;
  if (approvedBuiltins.some(name => !allowedBuiltins.includes(name))) throw new Error("Unknown approved built-in extension");
  if (new Set(approvedBuiltins).size !== approvedBuiltins.length) throw new Error("Duplicate approved built-in extension");
  const extensions = options.extensions.map(extension => typeof extension === "function" ? extension : { ...extension });
  const builtinNames = new Set<string>();
  for (const extension of extensions) {
    if (typeof extension === "function" || extension.builtin !== true) continue;
    if (!approvedBuiltins.includes(extension.name as typeof approvedBuiltins[number])) throw new Error(`Unapproved built-in extension factory: ${extension.name}`);
    if (builtinNames.has(extension.name)) throw new Error(`Duplicate built-in extension factory: ${extension.name}`);
    if (typeof extension.factory !== "function") throw new Error(`Invalid built-in extension factory: ${extension.name}`);
    builtinNames.add(extension.name);
  }
  for (const name of approvedBuiltins) {
    if (!builtinNames.has(name)) throw new Error(`Missing built-in extension factory: ${name}`);
  }
  // Pi 1.5 InlineExtension builtins need explicit tokens under noExtensions; never authorize from settings or sourceInfo.
  const additionalExtensionPaths = approvedBuiltins.map(name => `builtin:${name}`);
  const disabledBuiltinExtensions = [...allowedBuiltins, "llama.cpp"].filter(name => !builtinNames.has(name));
  return createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory(structuredClone(frozenSettings), { projectTrusted: options.projectTrusted });
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions, additionalExtensionPaths,
        systemPrompt: options.systemPrompt,
        extensionFactories: extensions,
      },
    });
    const errors = services.diagnostics.filter(item => item.type === "error");
    if (errors.length) throw new Error(errors.map(item => item.message).join("; "));
    const model = services.modelRuntime.getModel(options.provider, options.model);
    if (!model) throw new Error(`model-unavailable: ${options.provider}/${options.model}`);
    const compaction = childCompactionSettings(model);
    // getCompactionSettings resolves per-model overrides before ordinary settings.
    settingsManager.applyOverrides({ compaction: { ...compaction, modelOverrides: {
      [`${model.provider}/${model.id}`]: { reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens },
    } } });
    const scopedModels = options.modelScope.map(id => {
      const slash = id.indexOf("/");
      return services.modelRuntime.getModel(id.slice(0, slash), id.slice(slash + 1));
    }).filter((item): item is NonNullable<typeof item> => item !== undefined).map(model => ({ model }));
    const result = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, model, thinkingLevel: options.thinkingLevel,
      scopedModels, tools: [...options.tools],
    });
    try {
      await result.session.bindExtensions({ mode: "rpc", shutdownHandler: options.shutdown, onError: options.onError });
      return { ...result, services, diagnostics: services.diagnostics };
    } catch (error) {
      result.session.dispose();
      throw error;
    }
  }, { cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager });
}
