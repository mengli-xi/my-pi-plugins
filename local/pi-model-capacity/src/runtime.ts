import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MODEL_CAPACITY_REQUEST_CHANNEL,
  MODEL_CAPACITY_SNAPSHOT_CHANNEL,
  MODEL_CAPACITY_WATCH_CHANNEL,
  MODEL_CAPACITY_REGISTER_CHANNEL,
  MODEL_CAPACITY_READY_CHANNEL,
  isCapacityProviderId,
  readProviderSnapshot,
  readCapacityRequest,
  readCapacityWatch,
  type CapacityProviderId,
  type ModelCapacityRefreshReceiptV2,
  type ModelCapacitySnapshotV2,
  type ProviderCapacitySnapshot,
} from "./contracts.ts";
import { capacityContext, isRecord, sanitizeError, type CapacityAdapter, type CapacityAuthContext, type ResolvedCapacityAuth } from "./adapters/shared.ts";

export interface EventBusLike {
  emit(channel: string, payload: unknown): void;
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

interface RuntimeClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

interface RuntimeOptions {
  bus: EventBusLike;
  adapters: readonly CapacityAdapter[];
  fetch?: typeof globalThis.fetch;
  clock?: RuntimeClock;
}

interface ProviderState {
  adapter: CapacityAdapter;
  fingerprint?: string;
  generation: number;
  resolving: number;
  authController?: AbortController;
  snapshot: ProviderCapacitySnapshot;
  inFlight?: { fingerprint: string; promise: Promise<boolean>; controller: AbortController };
  confirmedInFlight?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_CLOCK: RuntimeClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class ModelCapacityRuntime {
  private readonly bus: EventBusLike;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: RuntimeClock;
  private readonly providers = new Map<CapacityProviderId, ProviderState>();
  // undefined is a live all-provider watch, including adapters registered later.
  private readonly watchers = new Map<string, ReadonlySet<CapacityProviderId> | undefined>();
  private readonly unsubscribers: Array<() => void> = [];
  private context: CapacityAuthContext | undefined;
  private registry: ExtensionContext["modelRegistry"] | undefined;
  private sessionId: string | undefined;
  private readonly ownerId = randomUUID();
  private revision = 0;
  private disposed = false;

  constructor(options: RuntimeOptions) {
    this.bus = options.bus;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? DEFAULT_CLOCK;
    let ownerPresent = false;
    this.bus.emit(MODEL_CAPACITY_REQUEST_CHANNEL, { version: 2, reply: () => { ownerPresent = true; } });
    if (ownerPresent) throw new Error("A model capacity owner is already active on this event bus");
    for (const adapter of options.adapters) this.addAdapter(adapter);
    this.unsubscribers.push(
      this.bus.on(MODEL_CAPACITY_REQUEST_CHANNEL, (payload) => this.handleRequest(payload)),
      this.bus.on(MODEL_CAPACITY_WATCH_CHANNEL, (payload) => this.handleWatch(payload)),
      this.bus.on(MODEL_CAPACITY_REGISTER_CHANNEL, (payload) => this.handleRegistration(payload)),
    );
    this.bus.emit(MODEL_CAPACITY_READY_CHANNEL, { version: 1, ownerId: this.ownerId });
  }

  bindContext(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.disposed) return;
    if (this.context && this.sessionId === sessionId && this.registry === ctx.modelRegistry) return;
    if (this.sessionId !== undefined && this.sessionId !== sessionId) {
      this.watchers.clear();
      for (const [provider, state] of this.providers) {
        this.stopProvider(provider);
        state.fingerprint = undefined;
        state.snapshot = { provider, state: "unavailable" };
      }
    }
    this.context = capacityContext(ctx);
    this.registry = ctx.modelRegistry;
    this.sessionId = sessionId;
    for (const provider of this.providers.keys()) {
      if (this.isWatched(provider)) {
        void this.refreshProvider(provider, () => this.isWatched(provider));
        this.schedule(provider);
      }
    }
    this.publish();
  }

  snapshot(): ModelCapacitySnapshotV2 {
    return freezeSnapshot({
      version: 2,
      ownerId: this.ownerId,
      revision: this.revision,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      providers: [...this.providers.values()].map((state) => materializeProvider(state.snapshot, this.clock.now())),
    });
  }

  providerSnapshot(provider: CapacityProviderId): ProviderCapacitySnapshot {
    return materializeProvider(this.providers.get(provider)?.snapshot ?? { provider, state: "unavailable" }, this.clock.now());
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled([...this.providers.keys()].map((provider) => this.refreshProvider(provider)));
  }

  /** A pre-click flight cannot satisfy a confirmed refresh. */
  async refreshProviderAfterCurrent(provider: CapacityProviderId): Promise<boolean> {
    const state = this.providers.get(provider);
    if (!state) return false;
    if (state.confirmedInFlight) return state.confirmedInFlight;
    const generation = state.generation;
    const promise = (async () => {
      const prior = state.inFlight?.promise;
      if (prior) await prior;
      if (this.disposed || this.providers.get(provider) !== state || state.generation !== generation) return false;
      return this.refreshProvider(provider);
    })();
    state.confirmedInFlight = promise;
    try { return await promise; }
    finally { if (state.confirmedInFlight === promise) state.confirmedInFlight = undefined; }
  }

  async refreshProvider(provider: CapacityProviderId, shouldContinue: () => boolean = () => true): Promise<boolean> {
    const state = this.providers.get(provider);
    const ctx = this.context;
    if (this.disposed || !state || !ctx || !shouldContinue()) return false;
    const adapter = state.adapter;
    const resolving = ++state.resolving;
    state.authController?.abort();
    const authController = new AbortController();
    state.authController = authController;
    const current = (): boolean => !authController.signal.aborted && !this.disposed && this.providers.get(provider) === state
      && state.resolving === resolving && this.context === ctx && shouldContinue();
    let auth: ResolvedCapacityAuth | undefined;
    try {
      auth = await adapter.resolveAuth(ctx, authController.signal);
      if (auth !== undefined && !validAuth(auth)) throw new Error(`Invalid capacity auth: ${provider}`);
    } catch (error) {
      if (!current()) return false;
      this.stopProvider(provider);
      state.fingerprint = undefined;
      state.snapshot = { provider, state: "error", error: sanitizeError(error) };
      this.schedule(provider);
      this.publish();
      return false;
    } finally {
      if (state.authController === authController) state.authController = undefined;
    }
    if (!current()) return false;
    if (!auth) {
      this.stopProvider(provider);
      state.fingerprint = undefined;
      state.snapshot = { provider, state: "unavailable" };
      this.schedule(provider);
      this.publish();
      return false;
    }
    if (state.inFlight?.fingerprint === auth.fingerprint) return state.inFlight.promise;
    const credentialChanged = state.fingerprint !== undefined && state.fingerprint !== auth.fingerprint;
    if (state.inFlight) state.inFlight.controller.abort();
    state.fingerprint = auth.fingerprint;
    const generation = ++state.generation;
    const previous = credentialChanged ? undefined : successfulData(state.snapshot);
    state.snapshot = { provider, state: "refreshing", ...(previous ?? {}) };
    this.publish();
    const controller = new AbortController();
    const promise = this.fetchProvider(state, auth, ctx, controller.signal, generation);
    state.inFlight = { fingerprint: auth.fingerprint, promise, controller };
    try { return await promise; }
    finally { if (state.inFlight?.promise === promise) state.inFlight = undefined; }
  }

  dispose(): void {
    if (this.disposed) return;
    for (const provider of this.providers.keys()) this.stopProvider(provider);
    this.watchers.clear();
    this.providers.clear();
    this.publish();
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.context = undefined;
    this.registry = undefined;
  }

  watcherCount(): number { return this.watchers.size; }

  private addAdapter(adapter: CapacityAdapter): () => void {
    if (!validAdapter(adapter)) throw new Error("Invalid capacity adapter");
    if (this.providers.has(adapter.provider)) throw new Error(`Capacity provider already registered: ${adapter.provider}`);
    // Capture immutable registration fields; callers cannot change a provider's identity or cadence after admission.
    const registered = Object.freeze({
      provider: adapter.provider, intervalMs: adapter.intervalMs, staleMs: adapter.staleMs,
      resolveAuth: adapter.resolveAuth.bind(adapter), fetch: adapter.fetch.bind(adapter),
    });
    const state: ProviderState = {
      adapter: registered, generation: 0, resolving: 0,
      snapshot: { provider: registered.provider, state: "unavailable" },
    };
    this.providers.set(registered.provider, state);
    if (this.isWatched(registered.provider)) {
      void this.refreshProvider(registered.provider, () => this.isWatched(registered.provider));
      this.schedule(registered.provider);
    }
    this.publish();
    return () => {
      if (this.providers.get(registered.provider) !== state) return;
      this.stopProvider(registered.provider);
      this.providers.delete(registered.provider);
      this.publish();
    };
  }

  private handleRegistration(payload: unknown): void {
    if (this.disposed || typeof payload !== "object" || payload === null) return;
    const request = payload as { version?: unknown; adapter?: unknown; reply?: unknown };
    if (request.version !== 1 || typeof request.reply !== "function") return;
    let result;
    try {
      const release = this.addAdapter(request.adapter as CapacityAdapter);
      result = { version: 1, ownerId: this.ownerId, accepted: true, release };
    } catch (error) {
      result = { version: 1, ownerId: this.ownerId, accepted: false, error: sanitizeError(error) };
    }
    request.reply(result);
  }

  private async fetchProvider(
    state: ProviderState, auth: ResolvedCapacityAuth, ctx: CapacityAuthContext, signal: AbortSignal, generation: number,
  ): Promise<boolean> {
    const adapter = state.adapter;
    const current = (): boolean => !signal.aborted && !this.disposed && this.providers.get(adapter.provider) === state
      && state.generation === generation && state.fingerprint === auth.fingerprint;
    try {
      const data = await adapter.fetch(auth, { ctx, fetch: this.fetcher, now: () => this.clock.now(), signal });
      if (!current()) return false;
      const observedAt = "observedAt" in data ? data.observedAt : this.clock.now();
      const snapshot = {
        ...data, provider: adapter.provider, state: "ready" as const, observedAt,
        staleAfter: observedAt === undefined ? undefined : observedAt + adapter.staleMs,
      };
      if (!readProviderSnapshot(snapshot)) throw new Error(`Invalid capacity data: ${adapter.provider}`);
      // Copy adapter-owned data before caching; later mutation cannot bypass validation or revision.
      state.snapshot = materializeProvider(snapshot, this.clock.now());
      this.publish();
      return true;
    } catch (error) {
      if (!current()) return false;
      const previous = successfulData(state.snapshot);
      state.snapshot = previous
        ? { provider: adapter.provider, state: "stale", ...previous, error: sanitizeError(error) }
        : { provider: adapter.provider, state: "error", error: sanitizeError(error) };
      this.publish();
      return false;
    }
  }

  private handleRequest(payload: unknown): void {
    const request = readCapacityRequest(payload);
    if (!request || !this.matchesSession(request.sessionId)) return;
    if (!request.refreshProviders) { request.reply(this.snapshot()); return; }
    const providers = [...new Set(request.refreshProviders)];
    const states = providers.map((provider) => this.providers.get(provider));
    const context = this.context;
    void Promise.allSettled(providers.map((provider) => this.refreshProviderAfterCurrent(provider))).then((outcomes) => {
      if (this.disposed || this.context !== context || !this.matchesSession(request.sessionId)) return;
      const refresh: ModelCapacityRefreshReceiptV2 = {
        version: 2, completedAt: this.clock.now(),
        providers: providers.map((provider, index) => {
          const snapshot = this.providerSnapshot(provider);
          const outcome = outcomes[index];
          return {
            provider,
            refreshed: this.providers.get(provider) === states[index] && outcome?.status === "fulfilled"
              && outcome.value === true && snapshot.state === "ready",
            state: snapshot.state,
            ...(snapshot.observedAt === undefined ? {} : { observedAt: snapshot.observedAt }),
            ...(snapshot.error ? { error: snapshot.error } : {}),
          };
        }),
      };
      request.reply(this.snapshot(), refresh);
    });
  }

  private handleWatch(payload: unknown): void {
    const watch = readCapacityWatch(payload);
    if (!watch || !this.matchesSession(watch.sessionId) || this.disposed) return;
    const watcherKey = JSON.stringify([watch.sessionId ?? "", watch.watcherId]);
    const previous = new Set([...this.providers.keys()].filter((provider) => this.isWatched(provider)));
    if (watch.action === "release") this.watchers.delete(watcherKey);
    else this.watchers.set(watcherKey, watch.providers ? new Set(watch.providers) : undefined);
    for (const provider of this.providers.keys()) {
      if (this.isWatched(provider)) {
        if (watch.action === "acquire" && (!watch.providers || watch.providers.includes(provider))) {
          void this.refreshProvider(provider, () => this.isWatched(provider));
        }
        this.schedule(provider);
      } else if (previous.has(provider)) this.stopProvider(provider);
    }
    this.publish();
  }

  private matchesSession(requested: string | undefined): boolean {
    return requested === undefined || this.sessionId === undefined || requested === this.sessionId;
  }

  private isWatched(provider: CapacityProviderId): boolean {
    for (const providers of this.watchers.values()) if (providers === undefined || providers.has(provider)) return true;
    return false;
  }

  private schedule(provider: CapacityProviderId): void {
    const state = this.providers.get(provider);
    if (!state || state.timer || !this.isWatched(provider) || this.disposed) return;
    state.timer = this.clock.setTimeout(() => {
      state.timer = undefined;
      if (!this.isWatched(provider) || this.disposed || this.providers.get(provider) !== state) return;
      void this.refreshProvider(provider).finally(() => {
        if (this.providers.get(provider) === state) this.schedule(provider);
      });
    }, state.adapter.intervalMs);
  }

  private stopProvider(provider: CapacityProviderId): void {
    const state = this.providers.get(provider);
    if (!state) return;
    state.generation++;
    state.resolving++;
    state.authController?.abort();
    state.authController = undefined;
    if (state.timer) this.clock.clearTimeout(state.timer);
    state.timer = undefined;
    state.inFlight?.controller.abort();
    state.inFlight = undefined;
    state.confirmedInFlight = undefined;
    if (state.snapshot.state === "refreshing") {
      const previous = successfulData(state.snapshot);
      state.snapshot = previous ? { provider, state: "stale", ...previous } : { provider, state: "unavailable" };
    }
  }

  private publish(): void {
    if (this.disposed) return;
    this.revision++;
    this.bus.emit(MODEL_CAPACITY_SNAPSHOT_CHANNEL, this.snapshot());
  }
}

function validAuth(value: unknown): value is ResolvedCapacityAuth {
  return isRecord(value) && typeof value.apiKey === "string"
    && typeof value.fingerprint === "string" && value.fingerprint.length > 0
    && (value.baseUrl === undefined || typeof value.baseUrl === "string")
    && isRecord(value.headers) && Object.values(value.headers).every((header) => typeof header === "string");
}

function validAdapter(value: CapacityAdapter): boolean {
  return !!value && isCapacityProviderId(value.provider) && Number.isFinite(value.intervalMs) && value.intervalMs > 0
    && Number.isFinite(value.staleMs) && value.staleMs > 0
    && typeof value.resolveAuth === "function" && typeof value.fetch === "function";
}

function successfulData(snapshot: ProviderCapacitySnapshot): Omit<ProviderCapacitySnapshot, "provider" | "state" | "error"> | undefined {
  if (snapshot.state !== "ready" && snapshot.state !== "stale" && snapshot.state !== "refreshing") return undefined;
  if (snapshot.observedAt === undefined) return undefined;
  const { provider: _provider, state: _state, error: _error, ...data } = snapshot;
  return data;
}

function materializeProvider(snapshot: ProviderCapacitySnapshot, now: number): ProviderCapacitySnapshot {
  const clone: ProviderCapacitySnapshot = {
    provider: snapshot.provider,
    state: snapshot.state,
    ...(snapshot.observedAt === undefined ? {} : { observedAt: snapshot.observedAt }),
    ...(snapshot.staleAfter === undefined ? {} : { staleAfter: snapshot.staleAfter }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
    ...(snapshot.windows ? { windows: snapshot.windows.map((window) => ({
      kind: window.kind, usedPercent: window.usedPercent, remainingPercent: window.remainingPercent,
      ...(window.windowSeconds === undefined ? {} : { windowSeconds: window.windowSeconds }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      ...(window.label === undefined ? {} : { label: window.label }),
    })) } : {}),
    ...(snapshot.gateway ? { gateway: {
      active: snapshot.gateway.active, queued: snapshot.gateway.queued, backgroundActive: snapshot.gateway.backgroundActive,
      ...(snapshot.gateway.maxActive === undefined ? {} : { maxActive: snapshot.gateway.maxActive }),
    } } : {}),
    ...(snapshot.models ? { models: Object.fromEntries(Object.entries(snapshot.models).map(([id, model]) => [id, {
      ...(model.observedAt === undefined ? {} : { observedAt: model.observedAt }),
      ...(model.loadPercent === undefined ? {} : { loadPercent: model.loadPercent }),
      ...(model.queueSize === undefined ? {} : { queueSize: model.queueSize }),
      ...(model.outputQpm === undefined ? {} : { outputQpm: model.outputQpm }),
      ...(model.totalQpm === undefined ? {} : { totalQpm: model.totalQpm }),
      ...(model.quota ? { quota: {
        remaining: model.quota.remaining, limit: model.quota.limit,
        ...(model.quota.used === undefined ? {} : { used: model.quota.used }),
        ...(model.quota.resetsAt === undefined ? {} : { resetsAt: model.quota.resetsAt }),
        ...(model.quota.observedAt === undefined ? {} : { observedAt: model.quota.observedAt }),
      } } : {}),
    }])) } : {}),
    ...(snapshot.balances ? { balances: snapshot.balances.map((balance) => ({
      currency: balance.currency, remaining: balance.remaining,
      ...(balance.granted === undefined ? {} : { granted: balance.granted }),
      ...(balance.toppedUp === undefined ? {} : { toppedUp: balance.toppedUp }),
    })) } : {}),
  };
  if (clone.state === "ready" && clone.staleAfter !== undefined && now > clone.staleAfter) clone.state = "stale";
  return clone;
}

function freezeSnapshot(snapshot: ModelCapacitySnapshotV2): ModelCapacitySnapshotV2 {
  for (const provider of snapshot.providers) {
    if (provider.windows) { for (const window of provider.windows) Object.freeze(window); Object.freeze(provider.windows); }
    if (provider.gateway) Object.freeze(provider.gateway);
    if (provider.models) {
      for (const model of Object.values(provider.models)) { if (model.quota) Object.freeze(model.quota); Object.freeze(model); }
      Object.freeze(provider.models);
    }
    if (provider.balances) { for (const balance of provider.balances) Object.freeze(balance); Object.freeze(provider.balances); }
    Object.freeze(provider);
  }
  Object.freeze(snapshot.providers);
  return Object.freeze(snapshot);
}
