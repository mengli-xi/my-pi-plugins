import type {
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { snapshotExtensionContext, type ExtensionContextSnapshot } from "./extension-context.ts";
import { LifecycleManager } from "./lifecycle.ts";

export type RuntimePhase =
  | "created"
  | "eager-installing"
  | "ready"
  | "session-bound"
  | "active"
  | "shutting-down"
  | "disposed";

export type RuntimeModuleState = "idle" | "loading" | "ready" | "disposed";
export type RuntimeLoadingMode = "balanced" | "eager" | "minimal";

/** The deliberately small observability surface used by cold-module loading. */
export interface RuntimeLoadObservability {
  increment(name: string, delta?: number): void;
  measureAsync<T>(name: string, action: () => Promise<T>, detail?: string): Promise<T>;
}

/** One cancellable, deduplicated module installation owned by a runtime scope. */
export class RuntimeModule<T> {
  readonly name: string;
  private readonly scope: RuntimeScope;
  private currentState: RuntimeModuleState = "idle";
  private currentValue: T | undefined;
  private currentError: unknown;
  private pending: Promise<T | undefined> | undefined;

  constructor(name: string, scope: RuntimeScope) {
    this.name = name;
    this.scope = scope;
  }

  get state(): RuntimeModuleState { return this.currentState; }
  get value(): T | undefined { return this.currentValue; }
  get error(): unknown { return this.currentError; }

  load(
    loader: () => Promise<T>,
    accept: (value: T) => void | Promise<void>,
    generation = this.scope.generation,
  ): Promise<T | undefined> {
    if (this.currentState === "ready") return Promise.resolve(this.currentValue);
    if (this.currentState === "disposed" || this.scope.isDisposed) return Promise.resolve(undefined);
    if (this.pending) return this.pending;
    this.currentState = "loading";
    this.currentError = undefined;
    this.pending = Promise.resolve().then(loader).then(async (value) => {
      if (!this.scope.accepts(generation)) {
        if (!this.scope.isDisposed) this.currentState = "idle";
        return undefined;
      }
      await accept(value);
      if (!this.scope.accepts(generation)) {
        if (!this.scope.isDisposed) this.currentState = "idle";
        return undefined;
      }
      this.currentValue = value;
      this.currentState = "ready";
      return value;
    }).catch((error) => {
      if (this.currentState !== "disposed") {
        this.currentError = error;
        // Keep the last error observable, but let the next request retry.
        this.currentState = "idle";
      }
      throw error;
    }).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  dispose(): void {
    this.currentState = "disposed";
    this.currentValue = undefined;
    this.currentError = undefined;
  }
}

/**
 * Import one cold module on first use without allowing a late continuation to
 * install into a replaced session/runtime. Requests made while the import is
 * in flight share the same promise. The metrics distinguish actual import
 * cost from user-visible wait and make cache/dedup behaviour auditable.
 */
export async function loadRuntimeModuleOnFirstUse<T>(
  scope: RuntimeScope,
  name: string,
  loader: () => Promise<T>,
  observability?: RuntimeLoadObservability,
): Promise<T | undefined> {
  const module = scope.module<T>(name);
  const before = module.state;
  observability?.increment(`cc-style.loading.${name}.request`);
  if (before === "ready") observability?.increment(`cc-style.loading.${name}.cache-hit`);
  if (before === "loading") observability?.increment(`cc-style.loading.${name}.deduplicated`);
  try {
    const load = () => observability
      ? observability.measureAsync(`cc-style.loading.${name}.import`, loader)
      : loader();
    const wait = () => module.load(load, () => {});
    const value = observability
      ? await observability.measureAsync(`cc-style.loading.${name}.wait`, wait, before)
      : await wait();
    if (value === undefined) observability?.increment(`cc-style.loading.${name}.discarded`);
    return value;
  } catch (error) {
    observability?.increment(`cc-style.loading.${name}.failed`);
    throw error;
  }
}

/** Invocation-local owner for lifecycle, session generation and future lazy work. */
export class RuntimeScope {
  readonly lifecycle = new LifecycleManager();
  private currentPhase: RuntimePhase = "created";
  private currentGeneration = 0;
  private context: ExtensionContextSnapshot | undefined;
  private readonly modules = new Map<string, RuntimeModule<unknown>>();

  get phase(): RuntimePhase { return this.currentPhase; }
  get generation(): number { return this.currentGeneration; }
  get contextSnapshot(): ExtensionContextSnapshot | undefined { return this.context; }
  get isDisposed(): boolean { return this.currentPhase === "disposed" || this.currentPhase === "shutting-down"; }

  beginEagerInstall(): void {
    if (this.currentPhase === "created") this.currentPhase = "eager-installing";
  }

  markReady(): void {
    if (this.currentPhase === "created" || this.currentPhase === "eager-installing") {
      this.currentPhase = "ready";
    }
  }

  bindSession(ctx: ExtensionContext): number {
    const snapshot = snapshotExtensionContext(ctx);
    if (!snapshot || this.isDisposed) return this.currentGeneration;
    this.context = snapshot;
    this.currentGeneration++;
    this.currentPhase = "session-bound";
    return this.currentGeneration;
  }

  markActive(ctx?: ExtensionContext): void {
    if (ctx) this.observeContext(ctx);
    if (!this.isDisposed) this.currentPhase = "active";
  }

  observeContext(ctx: ExtensionContext): boolean {
    const snapshot = snapshotExtensionContext(ctx);
    if (!snapshot || this.isDisposed) return false;
    this.context = snapshot;
    return true;
  }

  accepts(generation: number): boolean {
    return !this.isDisposed && generation === this.currentGeneration;
  }

  module<T>(name: string): RuntimeModule<T> {
    const existing = this.modules.get(name);
    if (existing) return existing as RuntimeModule<T>;
    const created = new RuntimeModule<T>(name, this);
    this.modules.set(name, created as RuntimeModule<unknown>);
    return created;
  }

  moduleStates(): Record<string, RuntimeModuleState> {
    return Object.fromEntries([...this.modules].map(([name, module]) => [name, module.state]));
  }

  moduleDiagnostics(): Record<string, { state: RuntimeModuleState; error?: string }> {
    return Object.fromEntries([...this.modules].map(([name, module]) => {
      const error = module.error;
      return [name, {
        state: module.state,
        ...(error === undefined ? {} : {
          error: error instanceof Error ? error.message : String(error),
        }),
      }];
    }));
  }

  async dispose(_reason?: SessionShutdownEvent["reason"]): Promise<void> {
    if (this.currentPhase === "disposed" || this.currentPhase === "shutting-down") return;
    this.currentPhase = "shutting-down";
    this.currentGeneration++;
    this.context = undefined;
    for (const module of this.modules.values()) module.dispose();
    await this.lifecycle.teardownAll();
    this.currentPhase = "disposed";
  }
}

export function createRuntimeScope(): RuntimeScope {
  return new RuntimeScope();
}

/**
 * Tier-0 installation is guarded in every loading mode. Modes only change the
 * schedule of cold modules; they must never weaken lifecycle correctness.
 */
export async function installRuntimeModule<T>(
  scope: RuntimeScope,
  mode: RuntimeLoadingMode,
  name: string,
  loader: () => Promise<T>,
  accept: (value: T) => void | Promise<void>,
): Promise<T | undefined> {
  void mode;
  return scope.module<T>(name).load(loader, accept);
}
