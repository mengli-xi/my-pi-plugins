import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import * as piTui from "@earendil-works/pi-tui";
import type {
  SettingsManager, SessionManager, AgentSessionRuntime, AgentSession,
  ExtensionFactory, CreateAgentSessionFromServicesOptions,
} from "@earendil-works/pi-coding-agent";

type PublicModules = Readonly<{
  "@earendil-works/pi-coding-agent": typeof piCodingAgent;
  "@earendil-works/pi-ai": typeof piAi;
  "@earendil-works/pi-tui": typeof piTui;
}>;
interface AssemblyRealm { readonly version: 1; readonly sdkVersion: string; readonly publicModules: PublicModules }
const realmKey = Symbol.for("pi.session-runtime.session-assembly-realm.v1");

/** One immutable SDK realm across native and Jiti library copies; never creates SDK services. */
export function getSessionAssemblyPublicModules(): PublicModules {
  const global = globalThis as typeof globalThis & { [realmKey]?: AssemblyRealm };
  if (!Object.hasOwn(global, realmKey)) {
    const publicModules = Object.freeze({
      "@earendil-works/pi-coding-agent": piCodingAgent,
      "@earendil-works/pi-ai": piAi,
      "@earendil-works/pi-tui": piTui,
    });
    Object.defineProperty(global, realmKey, { value: Object.freeze({ version: 1, sdkVersion: piCodingAgent.VERSION, publicModules }) });
  }
  const descriptor = Object.getOwnPropertyDescriptor(global, realmKey)!;
  const realm = descriptor.value as AssemblyRealm | undefined;
  const modules = realm?.publicModules;
  const required = {
    "@earendil-works/pi-coding-agent": ["createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime", "SettingsManager", "AgentSession", "InteractiveMode", "CustomEditor"],
    "@earendil-works/pi-ai": ["getCurrentSystemPrompt"],
    "@earendil-works/pi-tui": ["ProcessTerminal", "matchesKey", "isKeyRelease", "isKeyRepeat", "getKeybindings", "setKeybindings"],
  };
  if (!realm || realm.version !== 1 || typeof realm.sdkVersion !== "string" || !realm.sdkVersion ||
      realm.sdkVersion !== piCodingAgent.VERSION || modules?.["@earendil-works/pi-coding-agent"]?.VERSION !== realm.sdkVersion ||
      descriptor.configurable || descriptor.writable || !Object.isFrozen(realm) || !modules || !Object.isFrozen(modules) ||
      Object.entries(required).some(([name, exports]) => exports.some(key => typeof (modules[name as keyof PublicModules] as unknown as Record<string, unknown> | undefined)?.[key] !== "function"))) {
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
  readonly extensions: readonly ExtensionFactory[];
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
  const extensions = [...options.extensions];
  return createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory(structuredClone(frozenSettings), { projectTrusted: options.projectTrusted });
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
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
