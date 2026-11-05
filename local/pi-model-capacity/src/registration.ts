import { MODEL_CAPACITY_READY_CHANNEL, MODEL_CAPACITY_REGISTER_CHANNEL } from "./contracts.ts";
import type { CapacityAdapter } from "./adapters/shared.ts";

export interface CapacityEventBus {
  emit(channel: string, payload: unknown): void;
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

export interface CapacityAdapterRegistration {
  readonly accepted: boolean;
  readonly error: string | undefined;
  dispose(): void;
}

/** Subscribe before requesting admission: supports either extension load order and owner replacement. */
export function registerCapacityAdapter(
  bus: CapacityEventBus,
  adapter: CapacityAdapter,
  onError?: (error: string) => void,
): CapacityAdapterRegistration {
  let release: (() => void) | undefined;
  let error: string | undefined;
  let ownerId: string | undefined;
  let disposed = false;
  const request = (): void => {
    if (disposed) return;
    release?.();
    release = undefined;
    error = undefined;
    bus.emit(MODEL_CAPACITY_REGISTER_CHANNEL, {
      version: 1,
      adapter,
      reply(value: unknown) {
        if (typeof value !== "object" || value === null) return;
        const reply = value as { version?: unknown; ownerId?: unknown; accepted?: unknown; release?: unknown; error?: unknown };
        if (reply.version !== 1 || typeof reply.ownerId !== "string" || !reply.ownerId || typeof reply.accepted !== "boolean") return;
        ownerId = reply.ownerId;
        if (reply.accepted && typeof reply.release === "function") {
          if (disposed) reply.release();
          else release = reply.release as () => void;
        } else if (!reply.accepted && typeof reply.error === "string") {
          error = reply.error;
          onError?.(error);
        }
      },
    });
  };
  const unsubscribe = bus.on(MODEL_CAPACITY_READY_CHANNEL, (payload) => {
    if (typeof payload !== "object" || payload === null) return;
    const ready = payload as { version?: unknown; ownerId?: unknown };
    if (ready.version === 1 && typeof ready.ownerId === "string" && ready.ownerId && ready.ownerId !== ownerId) request();
  });
  request();
  return {
    get accepted() { return release !== undefined && !disposed; },
    get error() { return error; },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      release?.();
      release = undefined;
    },
  };
}
