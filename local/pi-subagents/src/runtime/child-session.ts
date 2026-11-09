import { revalidateSdkProviderProofV1, sdkProviderBindingFenceV1 } from "pi-session-runtime/sdk-provider";
import { getOrCreateChildCapabilityRegistryV1 } from "../capabilities/registry.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { estimateTokens, type AgentSessionRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { assembleChildSession, getSessionAssemblyPublicModules } from "pi-session-runtime/session-assembly";
import { ManagedInteractive } from "pi-session-runtime/managed-interactive";
import { assertFrozenToolDefinitionV1, frozenToolFenceV1, type ApprovedBuiltinNameV1 } from "../capabilities/builtin.js";
import { assertCapabilityFingerprintV1 } from "../capabilities/fingerprint.js";
import type { ChildCapabilityRegistrySnapshotV1 } from "../capabilities/registry.js";
import type { FrozenProfileV1 } from "../persistence/types.js";
import { createChildTools, type ChildHostPort } from "./child-tools.js";
import { childExecutionFactories, childPresentationFactories } from "./factory-catalog.js";
import { cancelChildProcessAdmission } from "../child/lifecycle.js";

/** Native view lifecycle is independent of optional transcript presentation factories. */
export function childViewExtension(view: Pick<ManagedInteractive, "prepare" | "extension">): import("@earendil-works/pi-coding-agent").ExtensionFactory {
  let prepared = false;
  return pi => {
    pi.registerMessageRenderer("subagent-task-resume", (message, _options, theme) =>
      new Text(theme.fg("muted", String(message.content)), 0, 0));
    view.prepare = async () => {
      if (prepared) return;
      view.extension(pi);
      prepared = true;
    };
  };
}

export class ChildSession {
  readonly identity: ChildHostPort["identity"];
  readonly runtime: AgentSessionRuntime;
  readonly #tools: ReturnType<typeof createChildTools>;
  readonly currentTaskId: () => string;
  readonly view: ManagedInteractive;
  #disposal?: Promise<void>;
  #run?: Promise<void>;
  #abortTaskId?: string;
  #disposed = false;
  #compacting = false;
  #unsubscribe?: () => void;
  readonly #getCancelProcesses: () => (() => Promise<void>) | undefined;
  readonly #disposeRuntime: () => Promise<void>;
  readonly #checkProviders: () => void;
  #externalDisposal?: Promise<void>;
  private constructor(host: ChildHostPort, runtime: AgentSessionRuntime, tools: ReturnType<typeof createChildTools>, view: ManagedInteractive, getCancelProcesses: () => (() => Promise<void>) | undefined, cleanup: () => void, checkProviders: () => void) {
    this.identity = host.identity; this.currentTaskId = host.taskId; this.runtime = runtime; this.#tools = tools;
    this.view = view; this.#getCancelProcesses = getCancelProcesses; this.#checkProviders = checkProviders;
    const disposeRuntime = runtime.dispose.bind(runtime);
    this.#disposeRuntime = async () => { try { await disposeRuntime(); } finally { cleanup(); } };
    // This is the public SDK runtime owned by this ChildSession, not a Pi
    // prototype/private seam. External disposal must enter the same Host
    // authority/cancellation boundary before the transport owner disappears.
    runtime.dispose = () => {
      if (this.#disposed) return this.#disposal ?? this.#disposeRuntime();
      if (!this.#externalDisposal) this.#externalDisposal = host.executionDisposed().catch(error => { this.#externalDisposal = undefined; throw error; });
      return this.#externalDisposal;
    };
    // This public SDK instance belongs to this execution owner. Reserve its
    // admission before native reload can emit the first session_shutdown.
    const reload = runtime.session.reload.bind(runtime.session);
    runtime.session.reload = async options => {
      let nativeStarted = false;
      try {
        await host.reloadWhenQuiescent(() => this.busy ? "the native session is busy or compacting" : this.conversation.reloadRefusalReason(), async () => { nativeStarted = true; await reload(options); });
      } catch (error) {
        // Preserve the native rejection for headless callers; an attached view
        // also gets the recovery instructions for an unavailable execution.
        const message = error instanceof Error ? error.message : String(error);
        try { runtime.session.extensionRunner.getUIContext().notify(nativeStarted ? `${message}. Child SDK reload failed; use close_agent then resume_agent before sending input.` : message, "warning"); } catch {}
        throw error;
      }
    };
    this.#unsubscribe = runtime.session.subscribe(event => {
      if (event.type === "agent_start" && (this.#disposed || this.#abortTaskId === this.currentTaskId())) void this.session.abort().catch(host.report);
      if (event.type === "compaction_start") this.#compacting = true;
      else if (event.type === "compaction_end") { this.#compacting = false; if (!this.#disposed) host.inputReady?.(); }
    });
  }
  get session() { return this.runtime.session; }
  // SDK reload replaces the factories while retaining this execution owner.
  // Resolve its current delivery port rather than retaining a disposed one.
  get conversation() { return this.#tools.conversation; }
  get busy(): boolean { return !this.session.isIdle || this.#compacting || this.#run !== undefined; }
  static async create(input: { host: ChildHostPort; profile: FrozenProfileV1; registry: ChildCapabilityRegistrySnapshotV1; agentDir: string;
    settings: ReturnType<ExtensionAPI["getSettings"]>; newExecution?: boolean; sessionFile: string; systemPromptFile: string; skillPath: string; taskTimeoutMs: number; maxDepth?: 1 | 2; parentEvents?: ExtensionAPI["events"] }): Promise<ChildSession> {
    assertCapabilityFingerprintV1(input.profile.capabilities);
    const providerChecks = input.profile.capabilities.entries.filter(entry => entry.sdk_provider).map(entry => {
      const proof = entry.sdk_provider!;
      const binding = sdkProviderBindingFenceV1(input.registry, () => getOrCreateChildCapabilityRegistryV1().snapshot(input.registry.session_id), entry.owner, proof);
      return () => { binding(); revalidateSdkProviderProofV1(proof, input.agentDir, "pi-subagents", input.profile.model_scope); };
    });
    const checkProviders = () => { for (const check of providerChecks) check(); };
    checkProviders();
    const tools = createChildTools(input);
    let cancelProcesses: (() => Promise<void>) | undefined;
    const disposers = new Set<() => void>();
    const cleanup = () => { for (const dispose of disposers) dispose(); disposers.clear(); };
    const extensions = await childExecutionFactories({ ...input, onExecutionDispose: dispose => disposers.add(dispose), sessionId: input.host.identity.sessionId, getBridge: tools.getBridge, onTaskCancel: cancel => { cancelProcesses = cancel; } });
    const view = new ManagedInteractive(input.host.report, input.host.interrupt);
    const taskName = input.host.tools.identity().taskPath.split("/").at(-1)!;
    // CC's light run recorder belongs to execution, even before the first UI. Its renderer stays detached.
    const presentations = await childPresentationFactories(input.profile, view.lifecycle, taskName);
    const presentation = childViewExtension(view);
    const prompt = await readFile(input.systemPromptFile);
    if (prompt.byteLength !== input.profile.system_prompt_bytes || createHash("sha256").update(prompt).digest("hex") !== input.profile.system_prompt_sha256) throw new Error("capability-drift: system prompt changed");
    const manager = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"].SessionManager.open(input.sessionFile, dirname(input.sessionFile));
    if (manager.getSessionId() !== input.host.identity.sessionId || manager.getHeader()?.cwd !== input.profile.cwd) throw new Error("Child native session identity changed");
    const canSpawn = input.host.identity.depth < Math.min(input.profile.delegation_max_depth, input.maxDepth ?? 1);
    const active = input.profile.capabilities.active_tools.filter(name => !["close_agent", "resume_agent"].includes(name) && (canSpawn || name !== "spawn_agent"));
    const effectivePrompt = canSpawn ? prompt.toString("utf8") : prompt.toString("utf8").replaceAll("spawn_agent", "delegation");
    let observedTools: () => ReturnType<ExtensionAPI["getAllTools"]> = () => [];
    const approvedBuiltinExtensions = extensions.flatMap(extension => typeof extension !== "function" && extension.builtin === true ? [extension.name as ApprovedBuiltinNameV1] : []);
    const runtime = await assembleChildSession({ cwd: input.profile.cwd, agentDir: input.agentDir, parentSettings: input.settings,
      projectTrusted: input.profile.project_trusted, sessionManager: manager, provider: input.profile.provider, model: input.profile.model,
      thinkingLevel: input.profile.reasoning_effort, modelScope: input.profile.model_scope, tools: [...active], systemPrompt: effectivePrompt,
      approvedBuiltinExtensions,
      extensions: [frozenToolFenceV1(input.profile, active), ...presentations, tools.extension, ...extensions, presentation, pi => { pi.on("session_start", () => { observedTools = () => pi.getAllTools(); }); }],
      shutdown: view.requestReturn, onError: input.host.report }).catch(error => { cleanup(); throw error; });
    try {
      const registered = new Map(observedTools().map(tool => [tool.name, tool]));
      for (const expected of input.profile.capabilities.tool_definitions) {
        if (["close_agent", "resume_agent"].includes(expected.name) || expected.name === "spawn_agent" && !canSpawn) continue;
        assertFrozenToolDefinitionV1(expected, registered.get(expected.name));
      }
      if (input.newExecution) await tools.conversation.activateNewExecution();
      runtime.session.setActiveToolsByName([...active]);
      return new ChildSession(input.host, runtime, tools, view, () => cancelProcesses, cleanup, checkProviders);
    } catch (error) { try { await runtime.dispose(); } finally { cleanup(); } throw error; }
  }
  async preflight(systemPromptBytes: number): Promise<void> {
    this.#checkProviders();
    const window = this.session.model!.contextWindow;
    const estimate = this.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0) + Math.ceil(systemPromptBytes / 3);
    const reserve = this.runtime.services.settingsManager.getCompactionSettings(this.session.model).reserveTokens;
    if (estimate >= window - reserve) {
      if (estimate >= window - Math.max(256, Math.floor(reserve / 2))) throw new Error("effective-context-unavailable: inherited context exceeds child compaction input window; use fork_turns=none");
      await this.session.compact();
    }
  }
  deliver(message: string): Promise<void> {
    this.#checkProviders();
    if (this.#disposed || this.busy) return Promise.reject(new Error("Child is unavailable or already executing"));
    const run = this.session.prompt(message, { expandPromptTemplates: false, source: "extension" }).then(() => undefined);
    this.#run = run;
    return run.finally(() => { if (this.#run === run) this.#run = undefined; });
  }
  resumeFromCompletions(): Promise<void> {
    this.#checkProviders();
    if (this.#disposed || this.busy) return Promise.reject(new Error("Child is unavailable or already executing"));
    return this.conversation.resumeTask();
  }
  async cancelTaskMail(taskId: string, generation: number): Promise<void> {
    if (generation !== this.identity.generation || taskId !== this.currentTaskId()) return;
    await this.#getCancelProcesses()?.();
    await this.conversation.cancelTaskMail(taskId, generation);
  }
  cancelProcessAdmission(taskId: string, generation: number): void {
    const current = this.currentTaskId();
    if (generation !== this.identity.generation || current && taskId !== current) return;
    cancelChildProcessAdmission(this.#tools.getBridge(this.identity.sessionId), taskId, generation);
  }
  async drain(): Promise<void> { await this.#run; await this.session.waitForIdle(); }
  async interrupt(taskId: string, generation: number): Promise<void> {
    if (generation !== this.identity.generation || taskId !== this.currentTaskId() || this.#disposed) return;
    this.#abortTaskId = taskId;
    this.cancelProcessAdmission(taskId, generation);
    try { await this.session.abort(); await this.#run?.catch(() => undefined); await this.session.waitForIdle(); }
    finally { this.session.clearQueue(); if (this.#abortTaskId === taskId) this.#abortTaskId = undefined; }
  }
  dispose(_reason: "delete" | "quit"): Promise<void> {
    this.cancelProcessAdmission(this.currentTaskId(), this.identity.generation);
    this.#disposed = true;
    return this.#disposal ??= (async () => {
      await this.view.close();
      // abort waits for all SDK-started turns too, including mailbox/Processes continuations.
      // Keep the session subscribed until the last tool result and settled boundary are durable.
      await this.session.abort();
      await this.#run?.catch(() => undefined);
      await this.session.waitForIdle();
      this.#unsubscribe?.(); this.#unsubscribe = undefined;
      await this.#disposeRuntime();
    })();
  }
}
