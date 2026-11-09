import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  MODEL_CAPACITY_READY_CHANNEL,
  MODEL_CAPACITY_REQUEST_CHANNEL,
  MODEL_CAPACITY_SNAPSHOT_CHANNEL,
  MODEL_CAPACITY_WATCH_CHANNEL,
} from "./integration-contracts.ts";
import {
  isCapacityProviderId,
  readModelCapacityRefreshReceipt,
  readModelCapacitySnapshot,
  type CapacityProviderId,
  type ModelCapacitySnapshotV2,
} from "./model-capacity.ts";

export type ModelCapacityListener = (snapshot: ModelCapacitySnapshotV2 | undefined) => void;

const CONFIRMED_REFRESH_TIMEOUT_MS = 35_000;

interface CapacityWatch {
  watcherId: string;
  sessionId?: string;
  providers?: CapacityProviderId[];
}

export interface ModelCapacitySource {
  current(): ModelCapacitySnapshotV2 | undefined;
  request(sessionId?: string): void;
  refresh(provider: CapacityProviderId, sessionId?: string): Promise<ModelCapacitySnapshotV2>;
  watch(
    watcherId: string,
    action: "acquire" | "release",
    sessionId?: string,
    providers?: CapacityProviderId[],
  ): void;
  subscribe(listener: ModelCapacityListener): () => void;
}

/** One runtime-local subscriber shared by every CC Style capacity presenter. */
export class ModelCapacityClient implements ModelCapacitySource {
  private readonly events: ExtensionAPI["events"];
  private readonly listeners = new Set<ModelCapacityListener>();
  private readonly pendingRefreshes = new Set<{ reject(error: Error): void }>();
  private readonly watches = new Map<string, CapacityWatch>();
  private readonly retiredOwners = new Set<string>();
  private readonly unsubscribers: Array<() => void>;
  private snapshot: ModelCapacitySnapshotV2 | undefined;
  private sessionId: string | undefined;
  private ownerId: string | undefined;
  private readyOwnerId: string | undefined;
  private generation = 0;
  private disposed = false;

  constructor(events: ExtensionAPI["events"]) {
    this.events = events;
    this.unsubscribers = [
      events.on(MODEL_CAPACITY_SNAPSHOT_CHANNEL, (raw: unknown) => { this.accept(raw); }),
      events.on(MODEL_CAPACITY_READY_CHANNEL, (raw: unknown) => this.handleReady(raw)),
    ];
  }

  bindSession(sessionId: string | undefined): void {
    if (this.disposed || this.sessionId === sessionId) return;
    this.generation++;
    this.rejectPending(new Error("capacity session changed"));
    const previous = [...this.watches.values()];
    this.watches.clear();
    this.sessionId = sessionId;
    this.snapshot = undefined;
    for (const watch of previous) this.emitWatch(watch, "release");
    this.notify();
  }

  current(): ModelCapacitySnapshotV2 | undefined { return this.snapshot; }

  request(sessionId = this.sessionId): void {
    this.requestSnapshot(sessionId);
  }

  refresh(provider: CapacityProviderId, sessionId = this.sessionId): Promise<ModelCapacitySnapshotV2> {
    if (this.disposed) return Promise.reject(new Error("capacity client is disposed"));
    if (!isCapacityProviderId(provider)) return Promise.reject(new Error("invalid capacity provider"));
    const generation = this.generation;
    const ownerId = this.ownerId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const pending = { reject: (error: Error) => finish(() => reject(error)) };
      const timer = setTimeout(
        () => pending.reject(new Error("capacity refresh timed out")),
        CONFIRMED_REFRESH_TIMEOUT_MS,
      );
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingRefreshes.delete(pending);
        complete();
      };
      this.pendingRefreshes.add(pending);
      this.events.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
        version: 2,
        ...(sessionId ? { sessionId } : {}),
        refreshProviders: [provider],
        reply: (raw: unknown, rawRefresh: unknown) => {
          if (settled) return;
          if (generation !== this.generation) {
            pending.reject(new Error("capacity owner or session changed"));
            return;
          }
          const snapshot = readModelCapacitySnapshot(raw);
          const refresh = readModelCapacityRefreshReceipt(rawRefresh);
          const receipt = refresh?.providers.find((entry) => entry.provider === provider);
          if (!snapshot || !refresh || !receipt) {
            pending.reject(new Error("capacity owner does not support confirmed refresh"));
            return;
          }
          if (sessionId && snapshot.sessionId && snapshot.sessionId !== sessionId) {
            pending.reject(new Error("capacity refresh belongs to another session"));
            return;
          }
          if (this.retiredOwners.has(snapshot.ownerId)
            || ownerId && snapshot.ownerId !== ownerId
            || this.ownerId && snapshot.ownerId !== this.ownerId) {
            pending.reject(new Error("capacity refresh belongs to another owner"));
            return;
          }
          if (!this.accept(snapshot)) {
            pending.reject(new Error("stale capacity refresh reply"));
            return;
          }
          const refreshedProvider = snapshot.providers.find((entry) => entry.provider === provider);
          if (!receipt.refreshed) {
            pending.reject(new Error(receipt.error || `capacity refresh failed (${receipt.state})`));
            return;
          }
          if (receipt.state !== "ready" || receipt.observedAt === undefined
            || refreshedProvider?.state !== "ready" || refreshedProvider.observedAt !== receipt.observedAt) {
            pending.reject(new Error("capacity owner returned an inconsistent refresh receipt"));
            return;
          }
          finish(() => resolve(snapshot));
        },
      });
    });
  }

  watch(
    watcherId: string,
    action: "acquire" | "release",
    sessionId = this.sessionId,
    providers?: CapacityProviderId[],
  ): void {
    if (this.disposed || !watcherId || providers && (!providers.length || !providers.every(isCapacityProviderId))) return;
    const watch: CapacityWatch = {
      watcherId,
      ...(sessionId ? { sessionId } : {}),
      ...(providers ? { providers: [...new Set(providers)] } : {}),
    };
    const key = JSON.stringify([sessionId ?? "", watcherId]);
    if (action === "acquire") this.watches.set(key, watch);
    else this.watches.delete(key);
    this.emitWatch(watch, action);
  }

  subscribe(listener: ModelCapacityListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.rejectPending(new Error("capacity client is disposed"));
    for (const watch of this.watches.values()) this.emitWatch(watch, "release");
    this.watches.clear();
    this.listeners.clear();
    this.snapshot = undefined;
  }

  private emitWatch(watch: CapacityWatch, action: "acquire" | "release"): void {
    this.events.emit(MODEL_CAPACITY_WATCH_CHANNEL, {
      version: 2, ...watch, ...(watch.providers ? { providers: [...watch.providers] } : {}), action,
    });
  }

  private handleReady(raw: unknown): void {
    if (this.disposed || typeof raw !== "object" || raw === null) return;
    const ready = raw as { version?: unknown; ownerId?: unknown };
    if (ready.version !== 1 || typeof ready.ownerId !== "string" || !ready.ownerId
      || ready.ownerId === this.readyOwnerId || this.retiredOwners.has(ready.ownerId)) return;
    // Corroborate readiness with the existing synchronous snapshot port before replaying any watches.
    if (!this.requestSnapshot(this.sessionId, ready.ownerId)) return;
    this.readyOwnerId = ready.ownerId;
    for (const watch of this.watches.values()) this.emitWatch(watch, "acquire");
  }

  private requestSnapshot(sessionId: string | undefined, expectedOwnerId?: string): boolean {
    if (this.disposed) return false;
    const generation = this.generation;
    let synchronous = true;
    let accepted = false;
    this.events.emit(MODEL_CAPACITY_REQUEST_CHANNEL, {
      version: 2,
      ...(sessionId ? { sessionId } : {}),
      reply: (raw: unknown) => {
        if (!synchronous || accepted || generation !== this.generation) return;
        const snapshot = readModelCapacitySnapshot(raw);
        if (!snapshot || expectedOwnerId !== undefined && snapshot.ownerId !== expectedOwnerId
          || sessionId && snapshot.sessionId && snapshot.sessionId !== sessionId) return;
        accepted = this.accept(snapshot);
      },
    });
    synchronous = false;
    return accepted;
  }

  private rejectPending(error: Error): void {
    for (const pending of [...this.pendingRefreshes]) pending.reject(error);
    this.pendingRefreshes.clear();
  }

  private accept(raw: unknown): boolean {
    if (this.disposed) return false;
    const snapshot = readModelCapacitySnapshot(raw);
    if (!snapshot || this.retiredOwners.has(snapshot.ownerId)) return false;
    if (this.sessionId && snapshot.sessionId && snapshot.sessionId !== this.sessionId) return false;
    if (this.ownerId && this.ownerId !== snapshot.ownerId) {
      this.retiredOwners.add(this.ownerId);
      this.generation++;
      this.rejectPending(new Error("capacity owner changed"));
      this.snapshot = undefined;
    }
    this.ownerId = snapshot.ownerId;
    if (this.snapshot && snapshot.revision < this.snapshot.revision) return false;
    this.snapshot = snapshot;
    this.notify();
    return true;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }
}
