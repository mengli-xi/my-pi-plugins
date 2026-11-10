import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, type AgentSessionRuntime, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { assembleChildSession } from "pi-session-runtime/session-assembly";
import { buildNativeChildSnapshot, writeNativeChildSnapshot, type EffectiveContextSelection } from "pi-session-runtime/native-child-context";
import { createSidePolicy } from "./sdk-policy.ts";
import { SIDE_BOUNDARY_PROMPT, SIDE_BOUNDARY_TYPE } from "./session-snapshot.ts";
import { DestroyConfirmation } from "./destroy-confirmation.ts";

export const SIDE_BOUNDARY = SIDE_BOUNDARY_TYPE;
export type SideDisposeCause = "destroy" | "main-shutdown" | "runtime-shutdown" | "startup-failed";

/** Failed construction can still own a seed or an assembled runtime. The
 * caller retains this retry handle until durable cancellation and disposal finish. */
export class SideStartupCleanupError extends AggregateError {
  readonly directory: string;
  readonly retryCleanup: () => Promise<void>;
  constructor(startupError: unknown, cleanupError: unknown, directory: string, retryCleanup: () => Promise<void>) {
    super([startupError, cleanupError], `Side startup cleanup failed; preserved ${directory}`);
    this.directory = directory;
    this.retryCleanup = retryCleanup;
  }
}

export interface SideRuntimeOptions {
  cwd: string;
  agentDir: string;
  parentSettings: ReturnType<ExtensionAPI["getSettings"]>;
  projectTrusted: boolean;
  selection: EffectiveContextSelection;
  provider: string;
  model: string;
  thinkingLevel: Parameters<typeof assembleChildSession>[0]["thinkingLevel"];
  modelScope: readonly string[];
  tools: readonly string[];
  systemPrompt: string;
  /** Resolved only after the private session identity exists. Factories own their own scopes. */
  factories(sessionId: string): Promise<readonly ExtensionFactory[]>;
  cacheLineageId?: string;
  onError?: Parameters<typeof assembleChildSession>[0]["onError"];
  /** Durable source cancellation must finish before policy/runtime retirement. */
  beforeDispose?(cause: SideDisposeCause): Promise<void>;
  beforeExecution?(): void;
}

/** The SDK owner is UI-free. S2 may attach a view but may never replace this session. */
export class SideRuntime {
  readonly runtime: AgentSessionRuntime;
  readonly directory: string;
  readonly inheritedEntryIds: ReadonlySet<string>;
  readonly boundaryId: string;
  readonly destroyConfirmation = new DestroyConfirmation();
  private readonly policy: ReturnType<typeof createSidePolicy>;
  private closed = false;
  private disposal?: Promise<void>;
  private run?: Promise<void>;
  private readonly beforeDispose?: SideRuntimeOptions["beforeDispose"];
  private readonly beforeExecution?: SideRuntimeOptions["beforeExecution"];
  private constructor(runtime: AgentSessionRuntime, directory: string, inheritedEntryIds: string[], boundaryId: string, policy: ReturnType<typeof createSidePolicy>, beforeDispose?: SideRuntimeOptions["beforeDispose"], beforeExecution?: SideRuntimeOptions["beforeExecution"]) {
    this.policy = policy;
    this.beforeDispose = beforeDispose; this.beforeExecution = beforeExecution;
    this.runtime = runtime; this.directory = directory; this.inheritedEntryIds = new Set(inheritedEntryIds); this.boundaryId = boundaryId;
  }
  get session() { return this.runtime.session; }
  get busy(): boolean { return this.run !== undefined || !this.session.isIdle; }
  static async create(options: SideRuntimeOptions): Promise<SideRuntime> {
    const directory = join(options.agentDir, "pi-side-chat", "runtime", randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let runtime: AgentSessionRuntime | undefined;
    let owner: SideRuntime | undefined;
    let policy: ReturnType<typeof createSidePolicy> | undefined;
    try {
      const seed = buildNativeChildSnapshot({ selection: options.selection, cwd: options.cwd,
        boundary: { customType: SIDE_BOUNDARY, content: SIDE_BOUNDARY_PROMPT, details: { version: 1 } },
        model: { provider: options.provider, modelId: options.model, thinkingLevel: options.thinkingLevel ?? "off" } });
      const path = join(directory, "side-session.jsonl");
      await writeNativeChildSnapshot(path, seed);
      policy = createSidePolicy({ prefix: options.selection.exactRequestPrefix ? options.selection.messages : undefined,
        boundaryType: SIDE_BOUNDARY, modelScope: options.modelScope, thinkingLevel: options.thinkingLevel ?? "off", cacheLineageId: options.cacheLineageId });
      const extensions = [...await options.factories(seed.header.id), policy.extension];
      runtime = await assembleChildSession({ ...options, sessionManager: SessionManager.open(path, directory), extensions,
        shutdown: () => { void owner?.destroy("runtime-shutdown").catch(error => {
          const report = { extensionPath: "pi-side-chat", event: "runtime-shutdown", error: String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) };
          if (options.onError) options.onError(report); else console.error(`[pi-side-chat] ${report.error}`);
        }); }, onError: options.onError });
      runtime.session.setActiveToolsByName([...options.tools]);
      policy.bind(runtime);
      owner = new SideRuntime(runtime, directory, seed.inheritedEntryIds, seed.boundaryId, policy, options.beforeDispose, options.beforeExecution);
      return owner;
    } catch (error) {
      let cleanup: Promise<void> | undefined;
      const retryCleanup = (): Promise<void> => {
        if (cleanup) return cleanup;
        const operation = (async () => {
          await options.beforeDispose?.("startup-failed");
          policy?.retire();
          await policy?.dispose();
          await runtime?.dispose();
          await rm(directory, { recursive: true, force: true });
        })();
        cleanup = operation;
        void operation.catch(() => { if (cleanup === operation) cleanup = undefined; });
        return operation;
      };
      try { await retryCleanup(); }
      catch (cleanupError) { throw new SideStartupCleanupError(error, cleanupError, directory, retryCleanup); }
      throw error;
    }
  }
  prompt(text: string): Promise<void> {
    if (this.closed || this.busy) return Promise.reject(new Error("Side is unavailable or busy"));
    try { this.beforeExecution?.(); } catch (error) { return Promise.reject(error); }
    const run = this.policy.ensureCapacity(text).then(() => {
      this.beforeExecution?.();
      if (this.closed) throw new Error("Side is destroyed");
      return this.session.prompt(text, { expandPromptTemplates: false, source: "extension" });
    }).then(() => undefined);
    this.run = run;
    return run.finally(() => { if (this.run === run) this.run = undefined; });
  }
  async interrupt(): Promise<void> { this.policy.cancelPreflight(); await this.session.abort(); await this.run?.catch(() => undefined); }
  /** Empty-editor Ctrl+D only. S2 owns key routing and cancels on edit/Escape. */
  async pressEmptyDelete(): Promise<"armed" | "destroyed"> {
    if (this.destroyConfirmation.press() === "armed") return "armed";
    await this.destroy(); return "destroyed";
  }
  destroy(cause: SideDisposeCause = "destroy"): Promise<void> {
    this.closed = true;
    this.destroyConfirmation.cancel();
    if (this.disposal) return this.disposal;
    const operation = (async () => {
      await this.beforeDispose?.(cause);
      this.policy.retire();
      await this.interrupt();
      await this.policy.dispose();
      await this.runtime.dispose();
      await rm(this.directory, { recursive: true, force: true });
    })();
    this.disposal = operation;
    return operation.catch(error => { if (this.disposal === operation) this.disposal = undefined; throw error; });
  }
}
